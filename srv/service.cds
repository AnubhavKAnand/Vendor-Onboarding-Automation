// ─────────────────────────────────────────────────────────────────────────────
//  srv/service.cds
//  VendorOnboardingService — OData V4 Service Definition + Fiori Annotations
// ─────────────────────────────────────────────────────────────────────────────
using { vendorportal } from '../db/schema';

// ─────────────────────────────────────────────────────────────────────────────
//  SERVICE DEFINITION
//  Mounted at /api/v1/vendor-onboarding
//  All entities are exposed as full OData V4 entity sets.
// ─────────────────────────────────────────────────────────────────────────────
service VendorOnboardingService @(path: '/api/v1/vendor-onboarding') {

    // ── Primary Entity ───────────────────────────────────────────────────────
    // @odata.draft.enabled activates Fiori Elements draft choreography:
    // the runtime creates a shadow "_drafts" table; changes accumulate there
    // until the user explicitly activates (saves) or discards the draft.
    entity Vendors as projection on vendorportal.Vendor;

    // ── Supporting Entities ──────────────────────────────────────────────────
    entity VendorDocuments     as projection on vendorportal.VendorDocument;
    entity BankAccounts        as projection on vendorportal.BankAccount;
    entity ApprovalReviews     as projection on vendorportal.ApprovalReview;
    entity AgentExtractionLogs as projection on vendorportal.AgentExtractionLog;
    entity RLTrainingBatches   as projection on vendorportal.RLTrainingBatch;

    // ── OData Unbound Actions ────────────────────────────────────────────────
    // Implemented in srv/service.js; stubs in Phase 1.
    action submitForApproval (vendorId : UUID) returns Vendors;
    action triggerRLRouting  (vendorId : UUID) returns String;
    action submitFinalDecision (vendorId: UUID, trueAction: String, reviewerName: String, department: String, comments: String) returns Vendors;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: Vendors  (Fiori Elements – List Report + Object Page)
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.Vendors with @(

    // ── List Report: columns displayed in the responsive table ──────────────
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : CompanyName, Label : 'Company Name'  },
        { $Type : 'UI.DataField', Value : TaxID,       Label : 'Tax ID'        },
        { $Type : 'UI.DataField', Value : Industry,    Label : 'Industry'      },
        { $Type : 'UI.DataField', Value : Country,     Label : 'Country'       },
        { $Type : 'UI.DataField', Value : RiskScore,   Label : 'Risk Score'    },
        { $Type : 'UI.DataField', Value : Status,      Label : 'Status'        },
        { $Type : 'UI.DataField', Value : createdAt,   Label : 'Submitted On'  }
    ],

    // ── Object Page: field group rendered in the header area ────────────────
    UI.Identification : [
        { $Type : 'UI.DataField', Value : CompanyName },
        { $Type : 'UI.DataField', Value : TaxID       },
        { $Type : 'UI.DataField', Value : Industry    },
        { $Type : 'UI.DataField', Value : Country     },
        { $Type : 'UI.DataField', Value : RiskScore   },
        { $Type : 'UI.DataField', Value : Status      }
    ],

    // ── Object Page: header title and sub-title binding ─────────────────────
    UI.HeaderInfo : {
        TypeName       : 'Vendor',
        TypeNamePlural : 'Vendors',
        Title          : { $Type : 'UI.DataField', Value : CompanyName },
        Description    : { $Type : 'UI.DataField', Value : Status      }
    },

    // ── List Report: fields shown in the filter bar ─────────────────────────
    UI.SelectionFields : [ Status, Country, Industry ],

    // ── Object Page: tab sections ────────────────────────────────────────────
    UI.Facets : [
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'GeneralInfo',
            Label  : 'General Information',
            Target : '@UI.Identification'
        },
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'Documents',
            Label  : 'Uploaded Documents',
            Target : 'Documents/@UI.LineItem'
        },
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'BankAccounts',
            Label  : 'Bank Accounts',
            Target : 'BankAccounts/@UI.LineItem'
        },
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'ApprovalHistory',
            Label  : 'Approval History',
            Target : 'ApprovalReviews/@UI.LineItem'
        }
    ]
);

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: VendorDocuments  (child table shown on Vendor Object Page)
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.VendorDocuments with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : DocumentType,        Label : 'Document Type'  },
        { $Type : 'UI.DataField', Value : URL,                 Label : 'URL'            },
        { $Type : 'UI.DataField', Value : UploadDate,          Label : 'Upload Date'    },
        { $Type : 'UI.DataField', Value : AI_Confidence_Score, Label : 'AI Confidence' }
    ]
);

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: BankAccounts
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.BankAccounts with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : AccountName,   Label : 'Account Name'   },
        { $Type : 'UI.DataField', Value : AccountNumber, Label : 'Account No.'    },
        { $Type : 'UI.DataField', Value : RoutingNumber, Label : 'Routing No.'    },
        { $Type : 'UI.DataField', Value : SwiftCode,     Label : 'SWIFT / BIC'    },
        { $Type : 'UI.DataField', Value : IsVerified,    Label : 'Verified'       }
    ]
);

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: ApprovalReviews
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.ApprovalReviews with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : ReviewerName, Label : 'Reviewer'    },
        { $Type : 'UI.DataField', Value : Department,   Label : 'Department'  },
        { $Type : 'UI.DataField', Value : Decision,     Label : 'Decision'    },
        { $Type : 'UI.DataField', Value : Comments,     Label : 'Comments'    },
        { $Type : 'UI.DataField', Value : ReviewDate,   Label : 'Review Date' }
    ]
);

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: AgentExtractionLogs  (diagnostic view for AI ops team)
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.AgentExtractionLogs with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : MissingFields,  Label : 'Missing Fields'  },
        { $Type : 'UI.DataField', Value : EmailTriggered, Label : 'Email Sent'      },
        { $Type : 'UI.DataField', Value : createdAt,      Label : 'Extracted At'    }
    ]
);

// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: RLTrainingBatches  (data-science / RL ops review table)
// ─────────────────────────────────────────────────────────────────────────────
annotate VendorOnboardingService.RLTrainingBatches with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : PredictedAction, Label : 'Predicted'  },
        { $Type : 'UI.DataField', Value : TrueAction,      Label : 'Actual'     },
        { $Type : 'UI.DataField', Value : Reward,          Label : 'Reward'     },
        { $Type : 'UI.DataField', Value : createdAt,       Label : 'Batch Date' }
    ]
);
