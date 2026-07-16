// ─────────────────────────────────────────────────────────────────────────────
//  db/schema.cds
//  Vendor Registration & Approval Portal — Phase 1: Data Model
//  SAP CAP (Cloud Application Programming Model) — Node.js / HANA Cloud
// ─────────────────────────────────────────────────────────────────────────────
namespace vendorportal;

using { cuid, managed } from '@sap/cds/common';

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vendor lifecycle status.
 * Each value maps directly to a workflow state the RL routing agent
 * will learn to predict and transition between in Phase 3.
 */
type VendorStatus : String(20) enum {
    Draft            = 'Draft';
    ActionRequired   = 'Action-Required'; 
    Pending          = 'Pending';
    AutoApproved     = 'Auto-Approved';
    AutoRejected     = 'Auto-Rejected';
    ComplianceReview = 'Compliance-Review';
    FinanceReview    = 'Finance-Review';
}

/**
 * Classification of uploaded compliance / supporting documents.
 * The LLM extraction microservice (Phase 2) keys off this to select
 * the correct prompt template for field extraction.
 */
type DocumentType : String(20);

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: Vendor  (root aggregate)
//  All child entities are modelled as Compositions so their lifecycle
//  is fully owned and managed by the Vendor root.
// ─────────────────────────────────────────────────────────────────────────────
entity Vendor : cuid, managed {
    CompanyName       : String(200) not null;
    TaxID             : String(50);
    Industry          : String(100);
    Country           : String(3);            // ISO 3166-1 alpha-3  e.g. 'USA', 'DEU'
    RiskScore         : Decimal(5, 2);        // Range 0.00–100.00; set by RL agent (Phase 3)
    Status            : VendorStatus default 'Draft';

    // ── to-many compositions ─────────────────────────────────────────────────
    Documents         : Composition of many VendorDocument   on Documents.Vendor         = $self;
    BankAccounts      : Composition of many BankAccount       on BankAccounts.Vendor      = $self;
    ApprovalReviews   : Composition of many ApprovalReview    on ApprovalReviews.Vendor   = $self;

    // ── to-one compositions (one log / one batch record per vendor) ──────────
    ExtractionLog     : Composition of one  AgentExtractionLog on ExtractionLog.Vendor  = $self;
    RLBatch           : Composition of one  RLTrainingBatch    on RLBatch.Vendor         = $self;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: VendorDocument
//  Stores metadata for every uploaded compliance document.
//
//  Integration note (Phase 2):
//  After each INSERT, the CAPM after-handler emits a CloudEvent payload to
//  the Python LLM microservice which parses the document at `URL` and
//  returns extracted fields + an AI_Confidence_Score.
// ─────────────────────────────────────────────────────────────────────────────
entity VendorDocument : cuid, managed {
    Vendor              : Association to Vendor not null;
    DocumentType        : DocumentType;
    URL                 : String(500);          // Object-store, SharePoint, or BTP DMS URL
    Content             : LargeString;          // Base64 encoded file content
    UploadDate          : Date;
    AI_Confidence_Score : Decimal(5, 4);        // 0.0000–1.0000; populated by LLM (Phase 2)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: BankAccount
//  A vendor may register multiple accounts (multi-currency / multi-region).
//  IsVerified is flipped by the Finance team after IBAN / SWIFT validation.
// ─────────────────────────────────────────────────────────────────────────────
entity BankAccount : cuid, managed {
    Vendor        : Association to Vendor not null;
    AccountName   : String(200);
    AccountNumber : String(50);
    RoutingNumber : String(20);
    SwiftCode     : String(20);
    IsVerified    : Boolean default false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: ApprovalReview
//  Covers both Compliance and Finance review steps.
//  The `Department` field discriminates between the two:
//    'Compliance' | 'Finance' | 'Legal'
// ─────────────────────────────────────────────────────────────────────────────
entity ApprovalReview : cuid, managed {
    Vendor       : Association to Vendor not null;
    ReviewerName : String(200);
    Department   : String(100);
    Decision     : String(50);             // 'Approved' | 'Rejected' | 'Escalated'
    Comments     : LargeString;
    ReviewDate   : Date;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: AgentExtractionLog
//  Persists the raw output from the Agentic AI / LLM microservice after it
//  processes an uploaded VendorDocument.
//
//  MissingFields  — comma-separated list of fields the LLM could not extract;
//                   if non-empty, a follow-up email is sent to the vendor.
//  EmailTriggered — set to true once the notification has been dispatched.
// ─────────────────────────────────────────────────────────────────────────────
entity AgentExtractionLog : cuid, managed {
    Vendor         : Association to one Vendor not null;
    RawLLMOutput   : LargeString;          // Raw JSON response body from the LLM
    MissingFields  : String(500);          // e.g. 'TaxID, RoutingNumber'
    EmailTriggered : Boolean default false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTITY: RLTrainingBatch
//  Shadow-mode records for the Reinforcement Learning routing agent.
//
//  Workflow:
//    1. On vendor submission → StateVector is snapshotted and Reward = 0.
//    2. Phase 3 RL microservice fills in PredictedAction.
//    3. Human reviewer corrects TrueAction after the fact.
//    4. A nightly job computes Reward (+1 / -1) and ships batches for training.
// ─────────────────────────────────────────────────────────────────────────────
entity RLTrainingBatch : cuid, managed {
    Vendor          : Association to one Vendor not null;
    StateVector     : LargeString;         // JSON: { industry, country, riskScore, … }
    PredictedAction : String(100);         // Action chosen by RL policy (Phase 3)
    TrueAction      : String(100);         // Corrected by human; drives Reward signal
    Reward          : Integer default 0;   // +1 correct | -1 wrong | 0 pending
}
