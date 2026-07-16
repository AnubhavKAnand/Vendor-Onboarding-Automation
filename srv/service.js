'use strict';
/**
 * srv/vendor-service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * VendorOnboardingService — Unified Service Implementation (Phase 1 + Phase 2)
 *
 * This file supersedes srv/service.js from Phase 1. It preserves all Phase 1
 * handlers (status guards, submitForApproval, triggerRLRouting) and adds the
 * full Phase 2 Agentic AI extraction + enrichment pipeline.
 *
 * CAPM wiring: rename this file to service.js, OR add to package.json:
 *   "cds": { "requires": { "VendorOnboardingService": { "impl": "srv/vendor-service.js" } } }
 *
 * Pipeline (after('CREATE', VendorDocuments)):
 *   [1] fileSecurity    → validate extension, MIME, size; anti-malware scan
 *   [2] agenticAI       → LLM extraction → structured JSON + confidence scores
 *   [3] confidence gate → if emailRequired: persist log → notify vendor → halt
 *   [4] enrichment      → KYC + Sanctions in parallel (Promise.allSettled)
 *   [5] assembly        → compile flat StateVector JSON from all signals
 *   [6] persistence     → cds.tx: AgentExtractionLog, RLTrainingBatch,
 *                         BankAccount, Vendor.RiskScore + Status → 'Pending'
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('VendorOnboardingService');

// Phase 2 microservice modules
const { processDocument }                    = require('./lib/fileSecurity');
const { extractVendorData }                  = require('./lib/agenticAI');
const { sendExtractionFailureNotification }  = require('./lib/notification');
const { runParallelEnrichment, RISK_WEIGHTS } = require('./lib/enrichment');
const { registerHumanReviewHandlers }        = require('./human-review');
const { fetchRLPrediction }                  = require('./rl-integration');
module.exports = cds.service.impl(async function (srv) {

    const {
        Vendors,
        VendorDocuments,
        BankAccounts,
        AgentExtractionLogs,
        RLTrainingBatches
    } = srv.entities;


    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — BEFORE CREATE: Vendors
    //  Forces Status = 'Draft' regardless of client payload.
    // ══════════════════════════════════════════════════════════════════════════
    srv.before('CREATE', Vendors, (req) => {
        // req.data.Status = 'Draft';
        // LOG.info('[Vendor] New record initialised — Status forced → Draft');
    });

    // Register external action handlers (e.g. submitFinalDecision)
    registerHumanReviewHandlers(srv);


    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — BEFORE UPDATE: Vendors  (status-transition guard)
    // ══════════════════════════════════════════════════════════════════════════
    srv.before('UPDATE', Vendors, async (req) => {
        // if (!req.data.Status) return;

        // const current = await SELECT.one('Status').from(Vendors).where({ ID: req.data.ID });
        // if (!current) return req.error(404, `Vendor '${req.data.ID}' not found.`);

        // const TERMINAL = ['Auto-Approved', 'Auto-Rejected'];
        // if (TERMINAL.includes(current.Status) && req.data.Status === 'Draft') {
        //     return req.error(409,
        //         `Vendor is in terminal status '${current.Status}'. ` +
        //         `Use an explicit unlock action before resetting to Draft.`
        //     );
        // }

        // LOG.info(`[Vendor] Status transition allowed: ${current.Status} → ${req.data.Status}`);
    });


    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 2 — AFTER CREATE: VendorDocuments
    //  Primary Phase 2 pipeline entry point. Executes asynchronously via
    //  setImmediate so the OData CREATE response is returned to the Fiori
    //  client immediately without waiting for the LLM + enrichment round-trips.
    //
    //  For production guaranteed delivery, replace setImmediate with SAP
    //  Event Mesh / BTP Integration Suite CloudEvent publishing.
    // ══════════════════════════════════════════════════════════════════════════
    srv.after('CREATE', VendorDocuments, async (data) => {
        const docs = Array.isArray(data) ? data : [data];
        setImmediate(async () => {
            for (const doc of docs) {
                await _runExtractionPipeline(doc).catch(err =>
                    LOG.error(
                        `[Pipeline] Unhandled top-level error — document: ${doc.ID}:`,
                        err.message, err.stack
                    )
                );
            }
        });
    });


    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — ACTION: submitForApproval
    // ══════════════════════════════════════════════════════════════════════════
    srv.on('submitForApproval', async (req) => {
        const { vendorId } = req.data;
        LOG.info(`[Action:submitForApproval] Vendor: ${vendorId}`);

        const vendor = await SELECT.one.from(Vendors).where({ ID: vendorId });
        if (!vendor) return req.error(404, `Vendor '${vendorId}' not found.`);

        const SUBMITTABLE = ['Draft', 'Auto-Rejected'];
        if (!SUBMITTABLE.includes(vendor.Status)) {
            return req.error(409,
                `Vendor is in status '${vendor.Status}'. ` +
                `Only 'Draft' or 'Auto-Rejected' vendors can be submitted.`
            );
        }

        await UPDATE(Vendors).set({ Status: 'Pending' }).where({ ID: vendorId });
        LOG.info(`[Action:submitForApproval] Vendor ${vendorId} → Status: Pending`);

        return SELECT.one.from(Vendors).where({ ID: vendorId });
    });


    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — ACTION: triggerRLRouting  (stub — fully wired in Phase 3)
    // ══════════════════════════════════════════════════════════════════════════
    srv.on('triggerRLRouting', async (req) => {
        const { vendorId } = req.data;
        LOG.info(`[Action:triggerRLRouting] Manual RL refresh for Vendor: ${vendorId}`);

        // Fetch the existing StateVector from the database
        const batch = await SELECT.one.from(RLTrainingBatches).where({ Vendor_ID: vendorId });
        if (!batch || !batch.StateVector) {
            return req.error(404, "No StateVector found for this vendor. Cannot route.");
        }

        // Call Python service
        const stateVector = JSON.parse(batch.StateVector);
        const prediction = await fetchRLPrediction(vendorId, stateVector);

        if (!prediction) {
            return req.error(503, "RL microservice is currently unreachable.");
        }

        return `Prediction refreshed: ${prediction.predictedAction} (${(prediction.confidence * 100).toFixed(1)}% confidence)`;
    });


    // ══════════════════════════════════════════════════════════════════════════
    //  PRIVATE — _runExtractionPipeline
    //  Full Phase 2 orchestration for a single VendorDocument record.
    //  Each numbered step maps to a pipeline stage.
    // ══════════════════════════════════════════════════════════════════════════
    async function _runExtractionPipeline(document) {
        const { ID: documentId, Vendor_ID: vendorId } = document;
        const t0 = Date.now();

        LOG.info(`[Pipeline] ══ START ══ document: ${documentId} | vendor: ${vendorId}`);

        // ──────────────────────────────────────────────────────────────────────
        //  STEP 1 — File Security & Preprocessing
        // ──────────────────────────────────────────────────────────────────────
        let securedPayload;
        try {
            securedPayload = await processDocument(document);
            LOG.info(`[Pipeline:1/5] ✓ File security cleared — document: ${documentId}`);
        } catch (fsErr) {
            LOG.error(`[Pipeline:1/5] ✗ File security rejected document: ${documentId}`, {
                code    : fsErr.code,
                message : fsErr.message
            });
            // Security rejections are never forwarded to the vendor (avoids detection disclosure).
            // Persist a diagnostic log entry for the ops team.
            await _persistExtractionLog(vendorId, {
                RawLLMOutput   : JSON.stringify({ stage: 'fileSecurity', code: fsErr.code, error: fsErr.message }),
                MissingFields  : `FILE_REJECTED:${fsErr.code}`,
                EmailTriggered : false
            });
            return; // HALT — no notification sent
        }

        // ──────────────────────────────────────────────────────────────────────
        //  STEP 2 — Agentic AI Extraction
        // ──────────────────────────────────────────────────────────────────────
        let aiResult;
        try {
            aiResult = await extractVendorData(securedPayload);
            LOG.info(`[Pipeline:2/5] ✓ AI extraction complete — confidence: ${aiResult.overallConfidence.toFixed(4)}`);
        } catch (aiErr) {
            LOG.error(`[Pipeline:2/5] ✗ AI extraction failed — document: ${documentId}:`, aiErr.message);
            await _persistExtractionLog(vendorId, {
                RawLLMOutput   : JSON.stringify({ stage: 'agenticAI', error: aiErr.message }),
                MissingFields  : 'EXTRACTION_ERROR',
                EmailTriggered : false
            });
            await _setVendorStatus(vendorId, 'Draft');
            return; // HALT — internal error, do not notify vendor yet
        }

        // ──────────────────────────────────────────────────────────────────────
        //  STEP 3 — Confidence Gate & Vendor Notification
        //  If the extraction is incomplete or confidence is below threshold,
        //  the pipeline halts here and the vendor is emailed to re-upload.
        // ──────────────────────────────────────────────────────────────────────
        if (aiResult.emailRequired) {
            LOG.warn(`[Pipeline:3/5] Confidence gate FAILED — confidence: ${aiResult.overallConfidence.toFixed(4)}`, {
                missingFields   : aiResult.missingFields,
                criticalMissing : aiResult.criticalMissing
            });

            // Persist partial log immediately (email flag starts as false)
            await _persistExtractionLog(vendorId, {
                RawLLMOutput   : aiResult.rawLLMOutput,
                MissingFields  : aiResult.missingFields.join(', '),
                EmailTriggered : false
            });

            // Fetch full Vendor record for the notification template
            const vendor = await SELECT.one.from(Vendors).where({ ID: vendorId });

            // Dispatch notification — failure is non-fatal (log + continue to status update)
            const notifResult = await sendExtractionFailureNotification(vendor, {
                MissingFields : aiResult.missingFields.join(', ')
            }).catch(nErr => {
                LOG.error('[Pipeline:3/5] Notification dispatch failed (non-fatal):', nErr.message);
                return { sent: false };
            });

            // Update the EmailTriggered flag if the email was sent successfully
            if (notifResult.sent) {
                await _setExtractionLogField(vendorId, 'EmailTriggered', true);
                LOG.info(`[Pipeline:3/5] ✓ Vendor notification sent — messageId: ${notifResult.messageId}`);
            }

            // 🚀 CHANGE 'Draft' to 'Action-Required'
            await _setVendorStatus(vendorId, 'Action-Required');

            LOG.info(`[Pipeline:3/5] HALTED — vendor: ${vendorId} pending re-upload`);
            return; // ← PIPELINE HALT
        }

        LOG.info(`[Pipeline:3/5] ✓ Confidence gate passed — proceeding to enrichment`);

        // ──────────────────────────────────────────────────────────────────────
        //  STEP 4 — Parallel External Enrichment (KYC + Sanctions)
        // ──────────────────────────────────────────────────────────────────────
        let enrichmentResult;
        try {
            enrichmentResult = await runParallelEnrichment(aiResult.extracted, vendorId);
            LOG.info(`[Pipeline:4/5] ✓ Enrichment complete — Vendor: ${vendorId}`, {
                kycValid      : enrichmentResult.kyc.Tax_ID_Valid,
                sanctionMatch : enrichmentResult.sanctions.Sanction_Match,
                riskContrib   : enrichmentResult.sanctions.Risk_Score_Contribution
            });
        } catch (enrichErr) {
            // Enrichment is non-fatal: degrade gracefully with null signals
            LOG.error(`[Pipeline:4/5] Enrichment threw (non-fatal) — Vendor: ${vendorId}:`, enrichErr.message);
            enrichmentResult = {
                kyc       : { Tax_ID_Valid: null, error: enrichErr.message },
                sanctions : { Sanction_Match: null, Risk_Score_Contribution: 0, isHighRiskCountry: false }
            };
        }

        // ──────────────────────────────────────────────────────────────────────
        //  STEP 5 — StateVector Assembly
        // ──────────────────────────────────────────────────────────────────────
        const stateVector = _assembleStateVector(aiResult, enrichmentResult, vendorId, documentId);
        LOG.info(`[Pipeline:5/5] StateVector assembled — ${Object.keys(stateVector).length} features`, {
            compositeRiskScore : stateVector.composite_risk_score
        });
        // ──────────────────────────────────────────────────────────────────────
        //  STEP 6 — Atomic HANA Persistence (single cds.tx)
        // ──────────────────────────────────────────────────────────────────────
        await _persistAllResults(vendorId, aiResult, enrichmentResult, stateVector);

        // ── NEW CODE: Trigger the RL Shadow Mode Prediction ──
        await fetchRLPrediction(vendorId, stateVector);

        const elapsed = Date.now() - t0;
        LOG.info(`[Pipeline] ══ COMPLETE ══ vendor: ${vendorId} → Status: Pending | elapsed: ${elapsed}ms`);
    }


    // ══════════════════════════════════════════════════════════════════════════
    //  PRIVATE — _assembleStateVector
    //  Produces the flat, serialisable JSON object that the Phase 3 RL agent
    //  will receive as its observation input. Every feature must be a JSON
    //  primitive (string | number | boolean | null) — no nested objects.
    //  The naming convention uses snake_case to match Python ML conventions.
    // ══════════════════════════════════════════════════════════════════════════
    function _assembleStateVector(aiResult, enrichmentResult, vendorId, documentId) {
        const { extracted, overallConfidence, missingFields } = aiResult;
        const { kyc, sanctions } = enrichmentResult;

        const compositeRisk = _computeCompositeRisk(overallConfidence, kyc, sanctions);

        return {
            // ── Identity ────────────────────────────────────────────────────
            vendor_id               : vendorId,
            document_id             : documentId,
            assembled_at            : new Date().toISOString(),

            // ── LLM-extracted vendor attributes ────────────────────────────
            company_name            : extracted.CompanyName         ?? null,
            tax_id                  : extracted.TaxID               ?? null,
            industry                : extracted.Industry            ?? null,
            country                 : extracted.Country             ?? null,

            // ── Extracted bank attributes ───────────────────────────────────
            bank_account_number     : extracted.BankAccount?.AccountNumber  ?? null,
            bank_routing_number     : extracted.BankAccount?.RoutingNumber  ?? null,
            bank_swift_code         : extracted.BankAccount?.SwiftCode      ?? null,
            bank_account_name       : extracted.BankAccount?.AccountName    ?? null,

            // ── AI confidence signals ────────────────────────────────────────
            ai_confidence_overall   : parseFloat(overallConfidence.toFixed(4)),
            ai_confidence_tax_id    : parseFloat((extracted.confidence?.perField?.TaxID         ?? 0).toFixed(4)),
            ai_confidence_account   : parseFloat((extracted.confidence?.perField?.AccountNumber ?? 0).toFixed(4)),
            ai_missing_fields       : missingFields.join(','),  // CSV for flat vector compatibility
            ai_missing_count        : missingFields.length,

            // ── KYC enrichment signals ───────────────────────────────────────
            kyc_tax_id_valid        : kyc.Tax_ID_Valid       ?? null,  // null = indeterminate
            kyc_provider_available  : kyc.error == null,

            // ── Sanctions enrichment signals ─────────────────────────────────
            sanctions_match         : sanctions.Sanction_Match            ?? null,
            sanctions_risk_contrib  : sanctions.Risk_Score_Contribution   ?? 0,
            is_high_risk_country    : sanctions.isHighRiskCountry         ?? false,
            sanctions_lists_checked : (sanctions.screensChecked ?? []).length,

            // ── Derived composite risk score ─────────────────────────────────
            // Primary numeric input the RL policy network uses to classify routing.
            composite_risk_score    : compositeRisk
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PRIVATE — _computeCompositeRisk
    //  Assembles a weighted risk score (0.00–100.00) from the pipeline signals.
    //  Adjust weights to reflect your organisation's compliance policy.
    // ──────────────────────────────────────────────────────────────────────────
    function _computeCompositeRisk(aiConfidence, kyc, sanctions) {
        let score = 0;

        // Sanctions contribution (raw score from enrichment.js RISK_WEIGHTS)
        score += sanctions.Risk_Score_Contribution ?? 0;

        // KYC contribution
        if (kyc.Tax_ID_Valid === false) score += RISK_WEIGHTS.KYC_MISMATCH;

        // AI confidence contribution: low confidence adds proportional risk
        // Formula: if confidence = 0.80, contribution = (1 - 0.80) * 20 = 4.0 points
        if (aiConfidence < 1.0) {
            score += parseFloat(((1 - aiConfidence) * 20).toFixed(2));
        }

        // Hard cap at 100.00
        return parseFloat(Math.min(score, 100.00).toFixed(2));
    }


    // ══════════════════════════════════════════════════════════════════════════
    //  PRIVATE — _persistAllResults
    //  All six database writes for the success path are executed inside a
    //  single cds.tx() so they commit atomically. On any failure the entire
    //  set is rolled back; the pipeline will be retried on the next upload.
    //
    //  Write order:
    //    1. AgentExtractionLog  — raw LLM output + confidence signals
    //    2. RLTrainingBatch     — fully assembled StateVector JSON
    //    3. BankAccount         — extracted + KYC-verified bank record
    //    4. Vendor              — updated RiskScore + Status → 'Pending'
    // ══════════════════════════════════════════════════════════════════════════
    async function _persistAllResults(vendorId, aiResult, enrichmentResult, stateVector) {
        await cds.tx(async (tx) => {

            // ── 1. AgentExtractionLog ──────────────────────────────────────
            const logData = {
                RawLLMOutput   : aiResult.rawLLMOutput,
                MissingFields  : aiResult.missingFields.join(', '),
                EmailTriggered : false    // success path — no email was needed
            };
            const existingLog = await tx.run(
                SELECT.one.from(AgentExtractionLogs).where({ Vendor_ID: vendorId })
            );
            if (existingLog) {
                await tx.run(UPDATE(AgentExtractionLogs).set(logData).where({ Vendor_ID: vendorId }));
            } else {
                await tx.run(INSERT.into(AgentExtractionLogs).entries({ Vendor_ID: vendorId, ...logData }));
            }
            LOG.info(`[Persist:1/4] AgentExtractionLog written — Vendor: ${vendorId}`);

            // ── 2. RLTrainingBatch — StateVector ───────────────────────────
            const batchData = {
                StateVector     : JSON.stringify(stateVector),
                PredictedAction : 'PENDING',   // Phase 3 RL microservice overwrites this
                TrueAction      : '',           // Human reviewer sets this for reward calculation
                Reward          : 0
            };
            const existingBatch = await tx.run(
                SELECT.one.from(RLTrainingBatches).where({ Vendor_ID: vendorId })
            );
            if (existingBatch) {
                await tx.run(UPDATE(RLTrainingBatches).set(batchData).where({ Vendor_ID: vendorId }));
            } else {
                await tx.run(INSERT.into(RLTrainingBatches).entries({ Vendor_ID: vendorId, ...batchData }));
            }
            LOG.info(`[Persist:2/4] RLTrainingBatch.StateVector written — Vendor: ${vendorId}`, {
                features: Object.keys(stateVector).length
            });

            // ── 3. BankAccount (upsert from extracted + KYC result) ────────
            const bankExtracted = aiResult.extracted?.BankAccount;
            if (bankExtracted?.AccountNumber) {
                const bankData = {
                    AccountName   : bankExtracted.AccountName   ?? '',
                    AccountNumber : bankExtracted.AccountNumber,
                    RoutingNumber : bankExtracted.RoutingNumber ?? '',
                    SwiftCode     : bankExtracted.SwiftCode     ?? '',
                    // Mark as KYC-verified only if the check explicitly returned true
                    IsVerified    : enrichmentResult.kyc.Tax_ID_Valid === true
                };
                const existingBank = await tx.run(
                    SELECT.one.from(BankAccounts).where({ Vendor_ID: vendorId })
                );
                if (existingBank) {
                    await tx.run(UPDATE(BankAccounts).set(bankData).where({ Vendor_ID: vendorId }));
                } else {
                    await tx.run(INSERT.into(BankAccounts).entries({ Vendor_ID: vendorId, ...bankData }));
                }
                LOG.info(`[Persist:3/4] BankAccount written — Vendor: ${vendorId}`, {
                    verified: bankData.IsVerified
                });
            } else {
                LOG.warn(`[Persist:3/4] BankAccount skipped — no AccountNumber extracted for Vendor: ${vendorId}`);
            }

            // ── 4. Vendor — RiskScore + Status → Pending ──────────────────
            await tx.run(
                UPDATE(Vendors)
                    .set({
                        Status    : 'Pending',
                        RiskScore : stateVector.composite_risk_score
                    })
                    .where({ ID: vendorId })
            );
            LOG.info(`[Persist:4/4] Vendor updated — ${vendorId} → Status: Pending | RiskScore: ${stateVector.composite_risk_score}`);
        });
    }


    // ══════════════════════════════════════════════════════════════════════════
    //  PRIVATE — _persistExtractionLog  (failure / error path)
    //  Lightweight upsert used when the pipeline halts before reaching the
    //  full _persistAllResults() commit.
    // ══════════════════════════════════════════════════════════════════════════
    async function _persistExtractionLog(vendorId, fields) {
        try {
            await cds.tx(async (tx) => {
                const existing = await tx.run(
                    SELECT.one.from(AgentExtractionLogs).where({ Vendor_ID: vendorId })
                );
                if (existing) {
                    await tx.run(UPDATE(AgentExtractionLogs).set(fields).where({ Vendor_ID: vendorId }));
                } else {
                    await tx.run(
                        INSERT.into(AgentExtractionLogs).entries({ Vendor_ID: vendorId, ...fields })
                    );
                }
            });
        } catch (err) {
            // Swallow to avoid masking the original pipeline error
            LOG.error(`[_persistExtractionLog] Failed to write error log for Vendor: ${vendorId}:`, err.message);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PRIVATE — _setExtractionLogField
    //  Patches a single field on an existing AgentExtractionLog row.
    //  Used to flip EmailTriggered without overwriting RawLLMOutput.
    // ──────────────────────────────────────────────────────────────────────────
    async function _setExtractionLogField(vendorId, field, value) {
        try {
            await cds.tx(async (tx) => {
                await tx.run(
                    UPDATE(AgentExtractionLogs)
                        .set({ [field]: value })
                        .where({ Vendor_ID: vendorId })
                );
            });
        } catch (err) {
            LOG.error(`[_setExtractionLogField] Failed to update '${field}' for Vendor: ${vendorId}:`, err.message);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PRIVATE — _setVendorStatus
    //  Single-field Vendor status update wrapped in its own transaction.
    // ──────────────────────────────────────────────────────────────────────────
    async function _setVendorStatus(vendorId, status) {
        try {
            await cds.tx(async (tx) => {
                await tx.run(UPDATE(Vendors).set({ Status: status }).where({ ID: vendorId }));
            });
            LOG.info(`[_setVendorStatus] Vendor: ${vendorId} → Status: ${status}`);
        } catch (err) {
            LOG.error(`[_setVendorStatus] Failed to set Status='${status}' for Vendor: ${vendorId}:`, err.message);
        }
    }
});
