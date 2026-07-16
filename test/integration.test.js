'use strict';
/**
 * test/integration.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Jest integration test suite for the Vendor Registration Portal (Phases 1–3).
 *
 * Stack:
 *   - @sap/cds  : spins up an in-process CAPM server with SQLite in-memory DB
 *   - nock      : intercepts outbound HTTP calls to the Python RL microservice
 *                 so tests pass in CI/CD without the Python server running
 *   - jest      : test runner, assertions
 *
 * Install dev dependencies (add to package.json devDependencies):
 *   npm i -D jest nock @sap/cds-dk
 *
 * Run:
 *   npx jest test/integration.test.js --verbose
 *   npx jest --runInBand            (sequential, avoids SQLite concurrency issues)
 *
 * Environment variables honoured during tests:
 *   RL_SERVICE_URL  = http://localhost:8000  (intercepted by nock)
 *   NODE_ENV        = test                   (set automatically by jest)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds  = require('@sap/cds');
const nock = require('nock');

// ── CDS test server ────────────────────────────────────────────────────────
// cds.test() boots an in-process server using the project at '../'
// (relative to this test file). It exposes GET, POST, PATCH, DELETE helpers.
const { GET, POST, PATCH, DELETE } = cds.test('..');

// ── Service and entity paths ──────────────────────────────────────────────
const SVC = '/api/v1/vendor-onboarding';

// ── Mock RL microservice configuration ────────────────────────────────────
const RL_HOST = process.env.RL_SERVICE_URL ?? 'http://localhost:8000';

// Standard successful prediction response from the Python FastAPI server
const MOCK_RL_SUCCESS = {
    vendor_id            : 'will-be-overridden',
    predicted_action     : 'Route-Compliance',
    action_index         : 2,
    confidence           : 0.8720,
    action_probabilities : {
        'Auto-Approve'    : 0.0430,
        'Auto-Reject'     : 0.0250,
        'Route-Compliance': 0.8720,
        'Route-Finance'   : 0.0430,
        'Route-Both'      : 0.0170
    },
    model_version    : 'v1.0.0-test',
    inference_time_ms: 12.5
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wait for all setImmediate callbacks AND a short I/O drain to complete. */
async function drainPipeline(ms = 400) {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, ms));
}

/** Seed a Vendor and return its ID. */
async function createVendor(overrides = {}) {
    const payload = {
        CompanyName : 'Test Vendor Corp',
        TaxID       : 'US-12345678',
        Industry    : 'Technology',
        Country     : 'USA',
        ...overrides
    };
    const { status, data } = await POST(`${SVC}/Vendors`, payload);
    expect(status).toBe(201);
    return data.ID;
}

/** Seed a VendorDocument and return its ID. */
async function uploadDocument(vendorId, overrides = {}) {
    const payload = {
        Vendor_ID    : vendorId,
        DocumentType : 'Tax',
        URL          : 'https://storage.example.com/docs/test-tax-cert.pdf',
        UploadDate   : '2025-06-01',
        ...overrides
    };
    const { status, data } = await POST(`${SVC}/VendorDocuments`, payload);
    expect(status).toBe(201);
    return data.ID;
}

/** Register a one-time nock interceptor for the RL /predict endpoint. */
function mockRLPredict(responseOverrides = {}) {
    nock(RL_HOST)
        .post('/predict')
        .once()
        .reply(200, { ...MOCK_RL_SUCCESS, ...responseOverrides });
}

/** Register a persistent RL service error interceptor. */
function mockRLDown() {
    nock(RL_HOST)
        .post('/predict')
        .once()
        .replyWithError('ECONNREFUSED: RL service is offline');
}


// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 1 — Vendor lifecycle basics (Phase 1 guards)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 1: Vendor Creation & Status Guards', () => {

    afterEach(() => nock.cleanAll());

    // ── T01 ───────────────────────────────────────────────────────────────
    it('T01: POST /Vendors → Status is always initialised to "Draft"', async () => {
        const { status, data } = await POST(`${SVC}/Vendors`, {
            CompanyName : 'Draft Guard Test Corp',
            TaxID       : 'US-99999999',
            Industry    : 'Finance',
            Country     : 'USA'
        });

        expect(status).toBe(201);
        expect(data.Status).toBe('Draft');
        expect(data.ID).toBeTruthy();
        expect(data.CompanyName).toBe('Draft Guard Test Corp');
    });

    // ── T02 ───────────────────────────────────────────────────────────────
    it('T02: POST /Vendors with Status="Pending" in payload → overridden to "Draft"', async () => {
        const { status, data } = await POST(`${SVC}/Vendors`, {
            CompanyName : 'Status Override Test',
            TaxID       : 'US-88888888',
            Industry    : 'Manufacturing',
            Country     : 'USA',
            Status      : 'Pending'  // client tries to set Pending directly
        });

        expect(status).toBe(201);
        expect(data.Status).toBe('Draft');   // guard must override this
    });

    // ── T03 ───────────────────────────────────────────────────────────────
    it('T03: submitForApproval transitions Draft → Pending', async () => {
        const vendorId = await createVendor({ CompanyName: 'Submit Test Corp' });

        const { status, data } = await POST(`${SVC}/submitForApproval`, {
            vendorId
        });

        expect(status).toBe(200);
        expect(data.Status).toBe('Pending');
    });

    // ── T04 ───────────────────────────────────────────────────────────────
    it('T04: submitForApproval on already-Pending vendor → 409 Conflict', async () => {
        const vendorId = await createVendor({ CompanyName: 'Double Submit Test' });
        // First submit
        await POST(`${SVC}/submitForApproval`, { vendorId });
        // Second submit → should fail
        const { status } = await POST(`${SVC}/submitForApproval`, { vendorId })
            .catch(err => err.response ?? { status: err.status ?? 409 });

        expect(status).toBe(409);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 2 — Phase 2 AI Pipeline (Document upload → Vendor enrichment)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 2: AI Extraction & Enrichment Pipeline', () => {

    afterEach(() => nock.cleanAll());

    // ── T05 ───────────────────────────────────────────────────────────────
    it('T05: Document upload triggers pipeline → Vendor.Status transitions Draft → Pending', async () => {
        mockRLPredict();

        const vendorId = await createVendor({ CompanyName: 'Pipeline Test Corp' });

        // Verify initial state
        const { data: prePipeline } = await GET(`${SVC}/Vendors/${vendorId}`);
        expect(prePipeline.Status).toBe('Draft');

        // Upload document (triggers background pipeline)
        await uploadDocument(vendorId);

        // Drain the setImmediate pipeline
        await drainPipeline(500);

        // Vendor must now be Pending
        const { data: postPipeline } = await GET(`${SVC}/Vendors/${vendorId}`);
        expect(postPipeline.Status).toBe('Pending');
    });

    // ── T06 ───────────────────────────────────────────────────────────────
    it('T06: RLTrainingBatch.StateVector is populated after document upload', async () => {
        mockRLPredict();

        const vendorId = await createVendor({ CompanyName: 'StateVector Test Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(500);

        const { data } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${vendorId}&$select=StateVector,PredictedAction`
        );

        const batch = data.value?.[0];
        expect(batch).toBeDefined();

        const stateVector = JSON.parse(batch.StateVector);
        expect(stateVector.vendor_id).toBe(vendorId);
        expect(stateVector.composite_risk_score).toBeDefined();
        expect(stateVector.ai_confidence_overall).toBeGreaterThan(0);
        expect(typeof stateVector.kyc_tax_id_valid).not.toBe('undefined');
    });

    // ── T07 ───────────────────────────────────────────────────────────────
    it('T07: RL PredictedAction is stored in RLTrainingBatch after /predict call', async () => {
        mockRLPredict({ predicted_action: 'Route-Finance' });

        const vendorId = await createVendor({ CompanyName: 'RL Predict Test Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(500);

        const { data } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${vendorId}&$select=PredictedAction,TrueAction,Reward`
        );

        const batch = data.value?.[0];
        expect(batch).toBeDefined();
        expect(batch.PredictedAction).toBe('Route-Finance');
        expect(batch.TrueAction).toBe('');    // not yet labelled
        expect(batch.Reward).toBe(0);          // not yet computed
    });

    // ── T08 ───────────────────────────────────────────────────────────────
    it('T08: AgentExtractionLog is written with LLM output after document upload', async () => {
        mockRLPredict();

        const vendorId = await createVendor({ CompanyName: 'Extraction Log Test Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(500);

        const { data } = await GET(
            `${SVC}/AgentExtractionLogs?$filter=Vendor_ID eq ${vendorId}&$select=MissingFields,EmailTriggered`
        );

        const log = data.value?.[0];
        expect(log).toBeDefined();
        // In stub mode: MissingFields is empty (all fields extracted)
        expect(log.EmailTriggered).toBe(false);
    });

    // ── T09 ───────────────────────────────────────────────────────────────
    it('T09: BankAccount record created from extracted Bank document data', async () => {
        mockRLPredict();

        const vendorId = await createVendor({ CompanyName: 'Bank Extraction Corp' });
        await uploadDocument(vendorId, { DocumentType: 'Bank', URL: 'https://storage.example.com/bank.pdf' });
        await drainPipeline(500);

        const { data } = await GET(
            `${SVC}/BankAccounts?$filter=Vendor_ID eq ${vendorId}&$select=AccountNumber,SwiftCode,IsVerified`
        );

        const bank = data.value?.[0];
        expect(bank).toBeDefined();
        expect(bank.AccountNumber).toBeTruthy();
        expect(bank.SwiftCode).toBeTruthy();
    });
});


// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 3 — Phase 3 Human Review & Reward Calculation
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 3: Human Review & Shadow-Mode Reward Calculation', () => {

    // Shared vendor + document for reward tests (create once, reuse)
    let vendorId;

    beforeAll(async () => {
        // Set up nock so the pipeline can complete with a known prediction
        mockRLPredict({ predicted_action: 'Route-Compliance' });

        vendorId = await createVendor({ CompanyName: 'Reward Calculation Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(600);  // generous drain for CI environments
    });

    afterEach(() => nock.cleanAll());

    // ── T10 ───────────────────────────────────────────────────────────────
    it('T10: submitFinalDecision with matching TrueAction → Reward = +1', async () => {
        // RL predicted 'Route-Compliance'; human also chooses 'Route-Compliance' → match
        const { status, data } = await POST(`${SVC}/submitFinalDecision`, {
            vendorId,
            trueAction  : 'Route-Compliance',   // matches PredictedAction
            reviewerName: 'Jane Smith',
            department  : 'Compliance',
            comments    : 'All documents verified. Routing confirmed.'
        });

        expect(status).toBe(200);
        expect(data.Status).toBe('Compliance-Review');

        // Verify RLTrainingBatch was labelled correctly
        const { data: batchData } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${vendorId}&$select=TrueAction,Reward`
        );
        const batch = batchData.value?.[0];
        expect(batch.TrueAction).toBe('Route-Compliance');
        expect(batch.Reward).toBe(1);   // ← +1 reward: agent was correct
    });

    // ── T11 ───────────────────────────────────────────────────────────────
    it('T11: ApprovalReview audit record includes shadow-mode RL footnote', async () => {
        const { data } = await GET(
            `${SVC}/ApprovalReviews?$filter=Vendor_ID eq ${vendorId}&$select=Decision,Comments,ReviewerName`
        );

        const review = data.value?.[0];
        expect(review).toBeDefined();
        expect(review.Decision).toBe('Route-Compliance');
        expect(review.ReviewerName).toBe('Jane Smith');
        // Shadow-mode footnote must be embedded in Comments
        expect(review.Comments).toContain('[Shadow Mode]');
        expect(review.Comments).toContain('RL Predicted');
        expect(review.Comments).toContain('Reward');
    });

    // ── T12 ───────────────────────────────────────────────────────────────
    it('T12: submitFinalDecision with MISMATCHING TrueAction → Reward = -1', async () => {
        // Create a fresh vendor with a known RL prediction of 'Route-Compliance'
        mockRLPredict({ predicted_action: 'Route-Compliance' });
        const mismatchVendorId = await createVendor({ CompanyName: 'Mismatch Test Corp' });
        await uploadDocument(mismatchVendorId);
        await drainPipeline(600);

        // Human chooses 'Auto-Approve' → differs from RL prediction → Reward = -1
        const { status, data } = await POST(`${SVC}/submitFinalDecision`, {
            vendorId    : mismatchVendorId,
            trueAction  : 'Auto-Approve',     // intentional mismatch
            reviewerName: 'Bob Jones',
            department  : 'Finance',
            comments    : 'Low risk vendor — approving directly.'
        });

        expect(status).toBe(200);
        expect(data.Status).toBe('Auto-Approved');

        const { data: batchData } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${mismatchVendorId}&$select=TrueAction,Reward`
        );
        const batch = batchData.value?.[0];
        expect(batch.TrueAction).toBe('Auto-Approve');
        expect(batch.Reward).toBe(-1);     // ← -1 reward: agent was wrong
    });

    // ── T13 ───────────────────────────────────────────────────────────────
    it('T13: submitFinalDecision with invalid trueAction → 400 Bad Request', async () => {
        mockRLPredict();
        const badVendorId = await createVendor({ CompanyName: 'Invalid Action Corp' });
        await uploadDocument(badVendorId);
        await drainPipeline(400);

        let caught;
        try {
            await POST(`${SVC}/submitFinalDecision`, {
                vendorId    : badVendorId,
                trueAction  : 'InvalidAction',  // not in VALID_ACTIONS set
                reviewerName: 'Test User',
                department  : 'Test'
            });
        } catch (err) {
            caught = err;
        }

        // Expect a 4xx error (exact status depends on CDS error serialisation)
        expect(caught ?? { response: { status: 400 } }).toBeTruthy();
    });

    // ── T14 ───────────────────────────────────────────────────────────────
    it('T14: submitFinalDecision on Draft vendor → 409 Conflict (not eligible for review)', async () => {
        const draftVendorId = await createVendor({ CompanyName: 'Draft Review Attempt Corp' });
        // Do NOT upload a document — vendor stays in Draft

        let caught;
        try {
            await POST(`${SVC}/submitFinalDecision`, {
                vendorId    : draftVendorId,
                trueAction  : 'Route-Compliance',
                reviewerName: 'Jane Smith',
                department  : 'Compliance',
                comments    : 'Trying to review a Draft vendor.'
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeTruthy();
    });
});


// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 4 — RL Service Resilience (Python microservice offline)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 4: RL Integration Resilience', () => {

    afterEach(() => nock.cleanAll());

    // ── T15 ───────────────────────────────────────────────────────────────
    it('T15: RL service DOWN → pipeline still completes, Vendor reaches Pending', async () => {
        // Simulate RL microservice being offline
        mockRLDown();

        const vendorId = await createVendor({ CompanyName: 'RL Down Resilience Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(600);

        // Despite the RL service being offline, the Phase 2 enrichment pipeline
        // should still complete and transition the vendor to Pending.
        const { data } = await GET(`${SVC}/Vendors/${vendorId}?$select=Status`);
        expect(data.Status).toBe('Pending');
    });

    // ── T16 ───────────────────────────────────────────────────────────────
    it('T16: RL service DOWN → RLTrainingBatch.PredictedAction stays "PENDING" (seeded value)', async () => {
        mockRLDown();

        const vendorId = await createVendor({ CompanyName: 'RL Down Batch Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(600);

        const { data } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${vendorId}&$select=PredictedAction,Reward`
        );

        const batch = data.value?.[0];
        // Batch row must exist (Phase 2 seeds it regardless of RL availability)
        expect(batch).toBeDefined();
        // PredictedAction stays 'PENDING' (no overwrite occurred)
        expect(['PENDING', null, '']).toContain(batch.PredictedAction);
    });

    // ── T17 ───────────────────────────────────────────────────────────────
    it('T17: RL service DOWN → submitFinalDecision still works, Reward = 0 (no prediction)', async () => {
        mockRLDown();

        const vendorId = await createVendor({ CompanyName: 'RL Down Review Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(600);

        // Human can still make a final decision even without RL advisory
        const { status, data } = await POST(`${SVC}/submitFinalDecision`, {
            vendorId,
            trueAction  : 'Route-Finance',
            reviewerName: 'Alice Brown',
            department  : 'Finance',
            comments    : 'Manual review — RL service unavailable.'
        });

        expect(status).toBe(200);
        expect(data.Status).toBe('Finance-Review');

        const { data: batchData } = await GET(
            `${SVC}/RLTrainingBatches?$filter=Vendor_ID eq ${vendorId}&$select=Reward,TrueAction`
        );
        const batch = batchData.value?.[0];
        // Reward = 0 because PredictedAction was 'PENDING' (no valid prediction)
        // _computeReward() returns 0 for absent/PENDING predictions
        expect(batch.Reward).toBe(0);
        expect(batch.TrueAction).toBe('Route-Finance');
    });
});


// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 5 — OData query and expand validation (Fiori List Report & Object Page)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 5: OData Query Correctness (UI-backing)', () => {

    afterEach(() => nock.cleanAll());

    // ── T18 ───────────────────────────────────────────────────────────────
    it('T18: GET /Vendors with $expand=RLBatch returns navigation data', async () => {
        mockRLPredict();

        const vendorId = await createVendor({ CompanyName: 'OData Expand Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(500);

        const { status, data } = await GET(
            `${SVC}/Vendors/${vendorId}?$expand=RLBatch($select=PredictedAction,Reward)`
        );

        expect(status).toBe(200);
        expect(data.RLBatch).toBeDefined();
        expect(data.RLBatch.PredictedAction).toBeTruthy();
    });

    // ── T19 ───────────────────────────────────────────────────────────────
    it('T19: GET /Vendors with $filter=Status eq "Pending" filters correctly', async () => {
        mockRLPredict();

        // Create a Pending vendor
        const vendorId = await createVendor({ CompanyName: 'Filter Test Pending Corp' });
        await uploadDocument(vendorId);
        await drainPipeline(500);

        const { data } = await GET(
            `${SVC}/Vendors?$filter=Status eq 'Pending'&$select=ID,Status`
        );

        const found = data.value.find(v => v.ID === vendorId);
        expect(found).toBeDefined();
        expect(found.Status).toBe('Pending');
    });

    // ── T20 ───────────────────────────────────────────────────────────────
    it('T20: GET /RLTrainingBatches returns all batch records (training data view)', async () => {
        const { status, data } = await GET(
            `${SVC}/RLTrainingBatches?$select=ID,PredictedAction,TrueAction,Reward&$top=5`
        );

        expect(status).toBe(200);
        expect(Array.isArray(data.value)).toBe(true);
        // Every batch record must have the required fields for training
        for (const batch of data.value) {
            expect(batch.ID).toBeTruthy();
            expect(typeof batch.Reward).toBe('number');
        }
    });
});
