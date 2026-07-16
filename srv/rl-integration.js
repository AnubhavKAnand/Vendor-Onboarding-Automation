'use strict';
/**
 * srv/rl-integration.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CAPM utility that bridges the Node.js service layer and the Python FastAPI
 * RL inference microservice deployed on SAP BTP Cloud Foundry.
 *
 * Design principles:
 *   - NEVER blocks the vendor pipeline: if the Python service is unreachable,
 *     log the failure and return null so human review proceeds regardless.
 *   - Request timeout (default 5 s) prevents a slow RL service from stalling
 *     the CAPM event loop.
 *   - HANA persistence of PredictedAction is best-effort inside its own
 *     cds.tx() so a DB write failure does not mask the returned prediction.
 *
 * Required environment variables:
 *   RL_SERVICE_URL          — CF app URL of the Python microservice
 *                             e.g. https://vendor-rl-agent.cfapps.eu10.hana.ondemand.com
 *   RL_SERVICE_TIMEOUT_MS   — HTTP timeout in ms (default: 5000)
 *   RL_SERVICE_TOKEN        — Optional Bearer token for mTLS / API gateway auth
 *
 * Integration point in vendor-service.js (Phase 2 orchestrator):
 *   After _persistAllResults() sets Vendor.Status = 'Pending', call:
 *     const { fetchRLPrediction } = require('./rl-integration');
 *     await fetchRLPrediction(vendorId, stateVector);
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('rl-integration');

// ── Configuration ─────────────────────────────────────────────────────────────
const RL_SERVICE_URL        = process.env.RL_SERVICE_URL        ?? 'http://localhost:8000';
const RL_SERVICE_TIMEOUT_MS = parseInt(process.env.RL_SERVICE_TIMEOUT_MS ?? '5000', 10);
const RL_SERVICE_TOKEN      = process.env.RL_SERVICE_TOKEN      ?? '';

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: fetchRLPrediction
//  Posts the Phase 2 StateVector to the Python /predict endpoint, writes the
//  PredictedAction to RLTrainingBatch in HANA, and returns the prediction
//  object for logging / display in the Fiori reviewer dashboard.
//
//  Returns null (never throws) if the RL service is unavailable or returns
//  an error, so the CAPM pipeline degrades gracefully.
//
//  @param {string} vendorId       — Vendor UUID (primary key)
//  @param {Object} stateVector    — Phase 2 assembled StateVector JSON
//  @returns {Promise<{
//      predictedAction     : string,
//      actionIndex         : number,
//      confidence          : number,
//      actionProbabilities : Object,
//      modelVersion        : string,
//      inferenceTimeMs     : number
//  } | null>}
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRLPrediction(vendorId, stateVector) {
    if (!vendorId || !stateVector) {
        LOG.warn('[RLIntegration] fetchRLPrediction called with missing arguments — skipping.');
        return null;
    }

    LOG.info(`[RLIntegration] Requesting prediction for Vendor: ${vendorId}`);

    // ── HTTP call to Python FastAPI ───────────────────────────────────────────
    let rawPrediction = null;

    try {
        rawPrediction = await _callPredictEndpoint(vendorId, stateVector);
    } catch (err) {
        // All transport errors are already logged inside _callPredictEndpoint
        // Return null: human review queue is unaffected
        return null;
    }

    if (!rawPrediction?.predicted_action) {
        LOG.warn(
            `[RLIntegration] RL service returned a response but 'predicted_action' is absent ` +
            `for Vendor: ${vendorId}. Response: ${JSON.stringify(rawPrediction).substring(0, 200)}`
        );
        return null;
    }

    LOG.info(`[RLIntegration] ✓ Prediction for Vendor: ${vendorId}`, {
        predictedAction : rawPrediction.predicted_action,
        confidence      : rawPrediction.confidence,
        modelVersion    : rawPrediction.model_version,
        inferenceMs     : rawPrediction.inference_time_ms
    });

    // ── Persist PredictedAction to HANA (best-effort, own tx) ─────────────────
    await _persistPredictedAction(vendorId, rawPrediction);

    return {
        predictedAction     : rawPrediction.predicted_action,
        actionIndex         : rawPrediction.action_index,
        confidence          : rawPrediction.confidence,
        actionProbabilities : rawPrediction.action_probabilities,
        modelVersion        : rawPrediction.model_version,
        inferenceTimeMs     : rawPrediction.inference_time_ms
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _callPredictEndpoint
//  Issues the HTTP POST with an AbortController timeout.
//  Throws on any transport or HTTP error so the caller can return null.
// ─────────────────────────────────────────────────────────────────────────────
async function _callPredictEndpoint(vendorId, stateVector) {
    const endpoint   = `${RL_SERVICE_URL}/predict`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), RL_SERVICE_TIMEOUT_MS);

    const headers = { 'Content-Type': 'application/json' };
    if (RL_SERVICE_TOKEN) {
        headers['Authorization'] = `Bearer ${RL_SERVICE_TOKEN}`;
    }

    let response;
    try {
        response = await fetch(endpoint, {
            method  : 'POST',
            headers,
            body    : JSON.stringify({ vendor_id: vendorId, state_vector: stateVector }),
            signal  : controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            LOG.warn(
                `[RLIntegration] /predict timed out after ${RL_SERVICE_TIMEOUT_MS} ms ` +
                `for Vendor: ${vendorId} — skipping RL advisory.`
            );
        } else {
            LOG.warn(
                `[RLIntegration] /predict network error for Vendor: ${vendorId} — ` +
                `${err.message}. RL service may be down. Skipping advisory.`
            );
        }
        throw err; // propagate to caller for null-return
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '(unreadable body)');
        const msg  = `RL service HTTP ${response.status} for Vendor: ${vendorId}: ${body.substring(0, 300)}`;
        LOG.error(`[RLIntegration] ${msg}`);
        throw new Error(msg);
    }

    return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _persistPredictedAction
//  Writes the RL agent's PredictedAction into the RLTrainingBatch row.
//  Wrapped in its own cds.tx() so a write failure does not surface to the
//  caller — the prediction is still returned regardless.
//
//  Entity resolution via cds.db avoids a circular dependency on the service
//  instance and works correctly when called from setImmediate() contexts.
// ─────────────────────────────────────────────────────────────────────────────
async function _persistPredictedAction(vendorId, prediction) {
    try {
        await cds.tx(async (tx) => {

            // Resolve the entity from the compiled CDS model
            const RLTrainingBatches = cds.model?.definitions?.['vendorportal.RLTrainingBatch'];
            if (!RLTrainingBatches) {
                LOG.warn('[RLIntegration] CDS model not ready — skipping HANA write for PredictedAction.');
                return;
            }

            const existing = await tx.run(
                SELECT.one.from('vendorportal.RLTrainingBatch').where({ Vendor_ID: vendorId })
            );

            if (existing) {
                await tx.run(
                    UPDATE('vendorportal.RLTrainingBatch')
                        .set({ PredictedAction: prediction.predicted_action })
                        .where({ Vendor_ID: vendorId })
                );
                LOG.info(
                    `[RLIntegration] ✓ PredictedAction='${prediction.predicted_action}' ` +
                    `updated in RLTrainingBatch for Vendor: ${vendorId}`
                );
            } else {
                // Edge case: Phase 2 did not create the batch row (e.g. short-circuit halt)
                LOG.warn(
                    `[RLIntegration] No RLTrainingBatch row for Vendor: ${vendorId} — inserting stub.`
                );
                await tx.run(
                    INSERT.into('vendorportal.RLTrainingBatch').entries({
                        Vendor_ID       : vendorId,
                        StateVector     : JSON.stringify({ vendor_id: vendorId, source: 'rl-integration-stub' }),
                        PredictedAction : prediction.predicted_action,
                        TrueAction      : '',
                        Reward          : 0
                    })
                );
            }
        });

    } catch (dbErr) {
        // Non-fatal: the prediction is still returned to the orchestrator
        LOG.error(
            `[RLIntegration] Failed to persist PredictedAction to HANA for Vendor: ${vendorId} ` +
            `(non-fatal): ${dbErr.message}`
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: checkRLServiceHealth
//  Lightweight ping used by the Fiori dashboard and monitoring pipelines
//  to surface RL service status without a full prediction cycle.
//  Returns { online: boolean, version: string|null, latencyMs: number }.
// ─────────────────────────────────────────────────────────────────────────────
async function checkRLServiceHealth() {
    const endpoint   = `${RL_SERVICE_URL}/health`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 3000);
    const t0         = Date.now();

    try {
        const response = await fetch(endpoint, { signal: controller.signal });
        clearTimeout(timer);
        const latencyMs = Date.now() - t0;

        if (!response.ok) {
            return { online: false, version: null, latencyMs, httpStatus: response.status };
        }

        const body = await response.json();
        LOG.info(`[RLIntegration] RL service health: ${body.status} | v${body.model_version} | ${latencyMs}ms`);

        return {
            online      : body.status === 'healthy',
            version     : body.model_version ?? null,
            modelLoaded : body.model_loaded  ?? false,
            latencyMs
        };
    } catch (err) {
        clearTimeout(timer);
        LOG.warn(`[RLIntegration] RL service health check failed: ${err.message}`);
        return { online: false, version: null, latencyMs: Date.now() - t0 };
    }
}

module.exports = { fetchRLPrediction, checkRLServiceHealth };
