'use strict';
/**
 * srv/human-review.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CAPM service extension for the human reviewer decision workflow.
 * Implements the OData unbound action `submitFinalDecision` which is triggered
 * when a Compliance or Finance reviewer clicks the decision button on the
 * Fiori Object Page.
 *
 * Responsibility chain:
 *   1. Validate vendor eligibility and action argument
 *   2. Fetch the RL agent's PredictedAction from RLTrainingBatch
 *   3. Compute the reward signal:  R = +1 (match) | −1 (mismatch) | 0 (no prediction)
 *   4. Atomic cds.tx commit:
 *        a. RLTrainingBatch  ← TrueAction, Reward
 *        b. ApprovalReview   ← full audit record (includes shadow-mode footnote)
 *        c. Vendor           ← final Status derived from TrueAction
 *   5. Return refreshed Vendor entity for the OData response body
 *
 * Add to srv/service.cds (Phase 1 file) before deploying Phase 3:
 * ─────────────────────────────────────────────────────────────────────────────
 *   service VendorOnboardingService ... {
 *       ...existing entities...
 *
 *       action submitFinalDecision (
 *           vendorId     : UUID,
 *           trueAction   : String,
 *           reviewerName : String,
 *           department   : String,
 *           comments     : String
 *       ) returns Vendors;
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Wiring in vendor-service.js:
 *   const { registerHumanReviewHandlers } = require('./human-review');
 *   module.exports = cds.service.impl(async function(srv) {
 *       ...existing handlers...
 *       registerHumanReviewHandlers(srv);
 *   });
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('human-review');

// ── Routing decision → Vendor.Status mapping ──────────────────────────────────
// Defines the terminal or next-stage status applied after a human decision.
const ACTION_TO_STATUS = Object.freeze({
    'Auto-Approve'     : 'Auto-Approved',
    'Auto-Reject'      : 'Auto-Rejected',
    'Route-Compliance' : 'Compliance-Review',
    'Route-Finance'    : 'Finance-Review',
    'Route-Both'       : 'Compliance-Review'  // enters compliance lane first; finance follows
});

const VALID_ACTIONS   = new Set(Object.keys(ACTION_TO_STATUS));

// Vendor statuses that are eligible for a review decision.
const REVIEWABLE_STATUSES = new Set(['Draft', 'Pending', 'Compliance-Review', 'Finance-Review']);

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: registerHumanReviewHandlers
//  Registers all human-review action handlers on the CDS service instance.
//  Called once during service initialisation from vendor-service.js.
// ─────────────────────────────────────────────────────────────────────────────
function registerHumanReviewHandlers(srv) {
    const { Vendors, RLTrainingBatches, ApprovalReviews } = srv.entities;

    // ══════════════════════════════════════════════════════════════════════════
    //  OData Action: submitFinalDecision
    //  Triggered by the Fiori Object Page "Submit Decision" button.
    //  This is the ground-truth labelling event for the RL Shadow Mode loop.
    // ══════════════════════════════════════════════════════════════════════════
    srv.on('submitFinalDecision', async (req) => {
        const {
            vendorId,
            trueAction,
            reviewerName,
            department,
            comments
        } = req.data;

        LOG.info(`[HumanReview] submitFinalDecision received`, {
            vendorId,
            trueAction,
            reviewer   : reviewerName,
            department
        });

        // ── 1. Input validation ────────────────────────────────────────────
        if (!vendorId)   return req.error(400, 'vendorId is required.');
        if (!trueAction) return req.error(400, 'trueAction is required.');

        if (!VALID_ACTIONS.has(trueAction)) {
            return req.error(400,
                `'${trueAction}' is not a valid decision. ` +
                `Accepted values: ${[...VALID_ACTIONS].join(', ')}.`
            );
        }
        if (!reviewerName?.trim()) {
            return req.error(400, 'reviewerName is required for the audit record.');
        }

        // ── 2. Fetch Vendor record & eligibility check ─────────────────────
        const vendor = await SELECT.one.from(Vendors).where({ ID: vendorId });
        if (!vendor) {
            return req.error(404, `Vendor '${vendorId}' not found.`);
        }
        if (!REVIEWABLE_STATUSES.has(vendor.Status)) {
            return req.error(409,
                `Vendor '${vendorId}' is in status '${vendor.Status}' and ` +
                `is not eligible for a review decision. ` +
                `Eligible statuses: ${[...REVIEWABLE_STATUSES].join(', ')}.`
            );
        }

        // ── 3. Fetch the RL agent's shadow-mode prediction ─────────────────
        const rlBatch         = await SELECT.one.from(RLTrainingBatches).where({ Vendor_ID: vendorId });
        const predictedAction = _normalisePrediction(rlBatch?.PredictedAction);

        // ── 4. Compute reward signal ───────────────────────────────────────
        //  R(s, a_pred) = +1  if a_pred == a_true   (agent was correct)
        //               = -1  if a_pred != a_true   (agent was wrong)
        //               =  0  if no valid prediction exists (unlabelled episode)
        const reward = _computeReward(predictedAction, trueAction);

        LOG.info(`[HumanReview] Reward computed for Vendor: ${vendorId}`, {
            predicted  : predictedAction,
            true       : trueAction,
            reward,
            isMatch    : reward ===  1,
            isMismatch : reward === -1,
            isPending  : reward ===  0
        });

        // ── 5. Derive final Vendor status from TrueAction ──────────────────
        const newVendorStatus = ACTION_TO_STATUS[trueAction];

        // ── 6. Atomic HANA commit (Using native CAP context) ───────────────
        const tx = cds.tx(req); // 🚀 BIND to the HTTP request transaction!
        
        // 6a. Write ground-truth labels
        if (rlBatch) {
            await tx.run(
                UPDATE(RLTrainingBatches)
                    .set({ TrueAction: trueAction, Reward: reward })
                    .where({ Vendor_ID: vendorId })
            );
            LOG.info(`[HumanReview] RLTrainingBatch labelled — Vendor: ${vendorId} | Reward: ${reward}`);
        } else {
            LOG.warn(`[HumanReview] No RLTrainingBatch row for Vendor: ${vendorId} — inserting fallback.`);
            await tx.run(
                INSERT.into(RLTrainingBatches).entries({
                    Vendor_ID       : vendorId,
                    StateVector     : JSON.stringify({ vendor_id: vendorId, source: 'human-review-fallback' }),
                    PredictedAction : predictedAction ?? 'UNKNOWN',
                    TrueAction      : trueAction,
                    Reward          : reward
                })
            );
        }

        // 6b. Write ApprovalReview audit record
        const auditComment = _buildAuditComment(comments, predictedAction, trueAction, reward);
        await tx.run(
            INSERT.into(ApprovalReviews).entries({
                Vendor_ID    : vendorId,
                ReviewerName : reviewerName.trim(),
                Department   : department?.trim() ?? 'Unspecified',
                Decision     : trueAction,
                Comments     : auditComment,
                ReviewDate   : new Date().toISOString().split('T')[0]
            })
        );
        LOG.info(`[HumanReview] ApprovalReview audit record written — Vendor: ${vendorId}`);

        // 6c. Transition Vendor to final status
        await tx.run(
            UPDATE(Vendors)
                .set({ Status: newVendorStatus })
                .where({ ID: vendorId })
        );
            
        LOG.info(`[HumanReview] Vendor: ${vendorId} → Status: ${newVendorStatus}`);

        // ── 7. Log shadow-mode performance summary ─────────────────────────
        _logShadowMetrics(vendorId, predictedAction, trueAction, reward, newVendorStatus);

        // ── 8. Return refreshed Vendor for the OData response body ─────────
        return tx.run(SELECT.one.from(Vendors).where({ ID: vendorId }));
    });
}



// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _computeReward
//
//  Strict alignment reward function:
//
//    R(s, a_pred) = +1    if a_pred == a_true   (correct routing prediction)
//                = -1    if a_pred != a_true   (incorrect routing prediction)
//                =  0    if a_pred is absent   (no prediction → unlabelled)
//
//  The zero case is important: episodes where the RL agent had no prediction
//  (e.g. Python service was offline, or 'PENDING' was never overwritten) must
//  NOT contribute a negative reward. They are excluded from the training batch
//  query by the `WHERE REWARD != 0` clause in train.py:fetch_weekly_batches().
// ─────────────────────────────────────────────────────────────────────────────
function _computeReward(predictedAction, trueAction) {
    if (!predictedAction) return 0;   // no prediction available → abstain
    return predictedAction === trueAction ? 1 : -1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _normalisePrediction
//  Converts raw DB values ('PENDING', 'UNKNOWN', '', null) into null so the
//  reward function can cleanly distinguish "no prediction" from "wrong prediction".
// ─────────────────────────────────────────────────────────────────────────────
function _normalisePrediction(rawValue) {
    const NON_PREDICTIONS = new Set(['PENDING', 'UNKNOWN', '', null, undefined]);
    return NON_PREDICTIONS.has(rawValue) ? null : rawValue;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _buildAuditComment
//  Appends a structured shadow-mode footnote to the human reviewer's comment.
//  Stored in ApprovalReview.Comments for compliance audit trails.
// ─────────────────────────────────────────────────────────────────────────────
function _buildAuditComment(humanComment, predictedAction, trueAction, reward) {
    const separator  = '─'.repeat(60);
    const rewardTag  = reward ===  1 ? '+1 ✓ Match'
                     : reward === -1 ? '-1 ✗ Mismatch'
                     :                  '0  (No RL prediction)';

    const shadowBlock = [
        '',
        separator,
        '[Shadow Mode RL Performance Record]',
        `RL Predicted : ${predictedAction ?? 'N/A  (agent had no prediction)'}`,
        `Human Chose  : ${trueAction}`,
        `Reward Signal: ${rewardTag}`,
        `Recorded At  : ${new Date().toISOString()}`,
        separator
    ].join('\n');

    return humanComment
        ? `${humanComment.trim()}\n${shadowBlock}`
        : shadowBlock.trimStart();
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _logShadowMetrics
//  Emits a structured log entry after each decision so the operations team
//  can monitor live shadow-mode accuracy without querying HANA.
//  In Phase 4, replace with SAP Cloud Logging / Dynatrace custom metric emit.
// ─────────────────────────────────────────────────────────────────────────────
function _logShadowMetrics(vendorId, predictedAction, trueAction, reward, finalStatus) {
    const entry = {
        event          : 'shadow_mode_decision',
        vendorId,
        predicted      : predictedAction ?? 'NONE',
        true_          : trueAction,
        reward,
        match          : reward === 1,
        finalStatus,
        timestamp      : new Date().toISOString()
    };

    if (reward === 1) {
        LOG.info(`[ShadowMetrics] ✓ MATCH — ${entry.predicted} == ${entry.true_} | Vendor: ${vendorId}`);
    } else if (reward === -1) {
        LOG.warn(
            `[ShadowMetrics] ✗ MISMATCH — predicted '${entry.predicted}' ` +
            `but human chose '${entry.true_}' | Vendor: ${vendorId}`
        );
    } else {
        LOG.info(`[ShadowMetrics] ○ NO-PREDICTION episode — Vendor: ${vendorId}`);
    }

    // Structured JSON log for log-aggregation pipelines (SAP Cloud Logging, Splunk, etc.)
    LOG.info('[ShadowMetrics] Structured:', JSON.stringify(entry));
}

module.exports = { registerHumanReviewHandlers };
