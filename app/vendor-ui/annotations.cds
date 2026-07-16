// ─────────────────────────────────────────────────────────────────────────────
//  app/vendor-ui/annotations.cds
//  Fiori Elements OData V4 UI Annotations — Phase 4
//
//  Generates:
//    • List Report   — Vendor dashboard with RL recommendation column
//    • Object Page   — Full vendor detail with AI Routing Recommendation facet
//    • Header Facets — Status badge, Risk Score indicator, RL advisory preview
//    • Actions       — submitFinalDecision (primary), submitForApproval
//
//  Prerequisite: add to srv/service.cds before deploying Phase 4:
//    action submitFinalDecision(
//        vendorId     : UUID,
//        trueAction   : String,
//        reviewerName : String,
//        department   : String,
//        comments     : String
//    ) returns Vendors;
// ─────────────────────────────────────────────────────────────────────────────
using VendorOnboardingService as service from '../../srv/service';

// ─────────────────────────────────────────────────────────────────────────────
//  PROJECTION EXTENSION
//  Adds a computed StatusCriticality integer so Fiori Elements can render
//  the Status badge with the correct semantic colour without a JS handler.
//
//  Criticality colour mapping (SAP Fiori UX standard):
//    0 = Neutral  (grey)   → Draft
//    1 = Negative (red)    → Auto-Rejected
//    2 = Critical (orange) → Pending, Compliance-Review, Finance-Review
//    3 = Positive (green)  → Auto-Approved
// ─────────────────────────────────────────────────────────────────────────────
extend projection service.Vendors with {
    case Status
        when 'Auto-Approved'     then 3
        when 'Auto-Rejected'     then 1
        when 'Pending'           then 2
        when 'Compliance-Review' then 2
        when 'Finance-Review'    then 2
        else                          0
    end as StatusCriticality : Integer
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN VENDOR ANNOTATIONS
// ─────────────────────────────────────────────────────────────────────────────
annotate service.Vendors with @(

    // ── List Report: table columns ─────────────────────────────────────────
    UI.LineItem : [
        {
            $Type             : 'UI.DataField',
            Value             : CompanyName,
            Label             : 'Company Name',
            ![@UI.Importance] : #High
        },
        {
            $Type             : 'UI.DataField',
            Value             : Country,
            Label             : 'Country',
            ![@UI.Importance] : #Medium
        },
        {
            $Type             : 'UI.DataField',
            Value             : Industry,
            Label             : 'Industry',
            ![@UI.Importance] : #Medium
        },
        {
            // Status with semantic colour via StatusCriticality
            $Type             : 'UI.DataField',
            Value             : Status,
            Criticality       : StatusCriticality,
            Label             : 'Status',
            ![@UI.Importance] : #High
        },
        {
            // Composite risk score (0–100): rendered as a progress indicator
            $Type             : 'UI.DataFieldForAnnotation',
            Target            : '@UI.DataPoint#RiskScore',
            Label             : 'Risk Score',
            ![@UI.Importance] : #High
        },
        {
            // RL Agent routing recommendation (advisory — shadow mode)
            $Type             : 'UI.DataField',
            Value             : RLBatch.PredictedAction,
            Label             : '⚡ RL Recommendation',
            ![@UI.Importance] : #High
        },
        {
            $Type             : 'UI.DataField',
            Value             : createdAt,
            Label             : 'Submitted',
            ![@UI.Importance] : #Low
        }
    ],

    // ── List Report: filter bar fields ─────────────────────────────────────
    UI.SelectionFields : [
        Status,
        Country,
        Industry,
        RiskScore
    ],

    // ── Object Page: header title binding ──────────────────────────────────
    UI.HeaderInfo : {
        TypeName       : 'Vendor',
        TypeNamePlural : 'Vendors',
        Title          : { $Type : 'UI.DataField', Value : CompanyName },
        Description    : { $Type : 'UI.DataField', Value : TaxID       },
        ImageUrl       : 'sap-icon://supplier'
    },

    // ── Object Page: header KPI blocks ────────────────────────────────────
    UI.HeaderFacets : [
        {
            // Status badge with semantic criticality colour
            $Type  : 'UI.ReferenceFacet',
            ID     : 'StatusKPI',
            Target : '@UI.DataPoint#Status'
        },
        {
            // Risk score radial / progress indicator
            $Type  : 'UI.ReferenceFacet',
            ID     : 'RiskScoreKPI',
            Target : '@UI.DataPoint#RiskScore'
        },
        {
            // RL advisory snapshot — most important advisory data point
            $Type  : 'UI.ReferenceFacet',
            ID     : 'RLAdvisoryHeader',
            Label  : 'RL Advisory',
            Target : '@UI.FieldGroup#RLAdvisoryHeader'
        }
    ],

    // ── DataPoint: Status ──────────────────────────────────────────────────
    UI.DataPoint #Status : {
        Value                      : Status,
        Title                      : 'Workflow Status',
        Criticality                : StatusCriticality,
        CriticalityRepresentation  : #WithIcon
    },

    // ── DataPoint: RiskScore ───────────────────────────────────────────────
    // CriticalityCalculation: lower score = better (risk minimisation).
    //   ≤ 25 → Positive (green) | 26–60 → Warning (orange) | > 60 → Negative (red)
    UI.DataPoint #RiskScore : {
        Value         : RiskScore,
        Title         : 'Risk Score',
        Visualization : #Number,
        CriticalityCalculation : {
            ImprovementDirection   : #Minimize,
            ToleranceRangeLowValue : 25,
            DeviationRangeLowValue : 60
        }
    },

    // ── FieldGroup: RL Advisory (shown in header facet — compact) ─────────
    UI.FieldGroup #RLAdvisoryHeader : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            {
                $Type             : 'UI.DataField',
                Value             : RLBatch.PredictedAction,
                Label             : 'Recommended Action',
                ![@UI.Importance] : #High
            },
            {
                $Type  : 'UI.DataField',
                Value  : RLBatch.Reward,
                Label  : 'Last Reward'
            }
        ]
    },

    // ── Object Page: primary action buttons (Object Page toolbar) ─────────
    // Determining: true → button renders prominently in the header toolbar.
    UI.Identification : [
        {
            $Type       : 'UI.DataFieldForAction',
            Action      : 'VendorOnboardingService.submitFinalDecision',
            Label       : 'Submit Final Decision',
            Determining : true,
            ![@UI.Importance] : #High
        },
        {
            $Type       : 'UI.DataFieldForAction',
            Action      : 'VendorOnboardingService.submitForApproval',
            Label       : 'Submit for Approval',
            Determining : true,
            ![@UI.Importance] : #Medium
        },
        {
            $Type       : 'UI.DataFieldForAction',
            Action      : 'VendorOnboardingService.triggerRLRouting',
            Label       : 'Refresh RL Prediction',
            Determining : false,
            ![@UI.Importance] : #Low
        }
    ],

    // ── Object Page: body tab sections ────────────────────────────────────
    UI.Facets : [

        // Tab 1 — General vendor information
        {
            $Type  : 'UI.CollectionFacet',
            ID     : 'GeneralInfo',
            Label  : 'Vendor Details',
            Facets : [
                {
                    $Type  : 'UI.ReferenceFacet',
                    ID     : 'VendorIdentity',
                    Label  : 'Identity',
                    Target : '@UI.FieldGroup#VendorIdentity'
                },
                {
                    $Type  : 'UI.ReferenceFacet',
                    ID     : 'VendorClassification',
                    Label  : 'Classification',
                    Target : '@UI.FieldGroup#VendorClassification'
                }
            ]
        },

        // Tab 2 — AI Routing Recommendation & Audit (Phase 3 RL shadow mode)
        // Placed second (after General Info) for maximum reviewer visibility.
        {
            $Type  : 'UI.CollectionFacet',
            ID     : 'AIAudit',
            Label  : '⚡ AI Routing Recommendation & Audit',
            Facets : [
                {
                    $Type  : 'UI.ReferenceFacet',
                    ID     : 'RLRecommendation',
                    Label  : 'RL Agent Advisory (Shadow Mode)',
                    Target : '@UI.FieldGroup#RLRecommendation'
                },
                {
                    $Type  : 'UI.ReferenceFacet',
                    ID     : 'ExtractionQuality',
                    Label  : 'LLM Extraction Quality',
                    Target : '@UI.FieldGroup#ExtractionQuality'
                }
            ]
        },

        // Tab 3 — Uploaded documents with AI confidence scores
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'Documents',
            Label  : 'Uploaded Documents',
            Target : 'Documents/@UI.LineItem'
        },

        // Tab 4 — Bank accounts (KYC-verified flag from Phase 2 enrichment)
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'BankAccounts',
            Label  : 'Bank Accounts',
            Target : 'BankAccounts/@UI.LineItem'
        },

        // Tab 5 — Approval history audit trail
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'ApprovalHistory',
            Label  : 'Approval History',
            Target : 'ApprovalReviews/@UI.LineItem'
        }
    ],

    // ── FieldGroup: Vendor Identity ────────────────────────────────────────
    UI.FieldGroup #VendorIdentity : {
        $Type : 'UI.FieldGroupType',
        Label : 'Identity',
        Data  : [
            { $Type : 'UI.DataField', Value : CompanyName, Label : 'Legal Name'   },
            { $Type : 'UI.DataField', Value : TaxID,       Label : 'Tax ID / EIN' },
            { $Type : 'UI.DataField', Value : createdAt,   Label : 'Submitted'    },
            { $Type : 'UI.DataField', Value : createdBy,   Label : 'Submitted By' }
        ]
    },

    // ── FieldGroup: Vendor Classification ─────────────────────────────────
    UI.FieldGroup #VendorClassification : {
        $Type : 'UI.FieldGroupType',
        Label : 'Classification',
        Data  : [
            { $Type : 'UI.DataField', Value : Industry,  Label : 'Industry'     },
            { $Type : 'UI.DataField', Value : Country,   Label : 'Country'      },
            {
                $Type       : 'UI.DataField',
                Value       : RiskScore,
                Label       : 'Composite Risk Score',
                Criticality : StatusCriticality
            }
        ]
    },

    // ── FieldGroup: RL Recommendation (full detail) ────────────────────────
    // This is the core Phase 3 advisory display. All fields read from
    // the RLTrainingBatch composition via navigation path RLBatch/*.
    UI.FieldGroup #RLRecommendation : {
        $Type : 'UI.FieldGroupType',
        Label : 'RL Agent Advisory (Shadow Mode — Read Only)',
        Data  : [
            {
                $Type             : 'UI.DataField',
                Value             : RLBatch.PredictedAction,
                Label             : '⚡ Recommended Routing Action',
                ![@UI.Importance] : #High
            },
            {
                $Type : 'UI.DataField',
                Value : RLBatch.TrueAction,
                Label : 'Human Final Decision'
            },
            {
                $Type : 'UI.DataField',
                Value : RLBatch.Reward,
                Label : 'Shadow Reward Signal (+1 / −1 / 0)'
            },
            {
                // StateVector surfaced for data-science / ops review
                $Type : 'UI.DataField',
                Value : RLBatch.StateVector,
                Label : 'Feature StateVector (JSON)'
            }
        ]
    },

    // ── FieldGroup: LLM Extraction Quality ────────────────────────────────
    // Sourced from the AgentExtractionLog composition via ExtractionLog/*.
    UI.FieldGroup #ExtractionQuality : {
        $Type : 'UI.FieldGroupType',
        Label : 'LLM Extraction Audit',
        Data  : [
            {
                $Type : 'UI.DataField',
                Value : ExtractionLog.MissingFields,
                Label : 'Missing / Low-Confidence Fields'
            },
            {
                $Type : 'UI.DataField',
                Value : ExtractionLog.EmailTriggered,
                Label : 'Follow-up Email Sent to Vendor'
            },
            {
                $Type : 'UI.DataField',
                Value : ExtractionLog.createdAt,
                Label : 'Extraction Timestamp'
            }
        ]
    }
);


// ─────────────────────────────────────────────────────────────────────────────
//  FIELD-LEVEL ANNOTATIONS: Vendors
// ─────────────────────────────────────────────────────────────────────────────
annotate service.Vendors with {

    ID @(
        UI.Hidden            : true,
        Core.Computed        : true
    );

    Status @(
        Common.Label                   : 'Workflow Status',
        Common.ValueListWithFixedValues: true,
        Common.ValueList : {
            CollectionPath : 'Vendors',
            Parameters     : [
                {
                    $Type              : 'Common.ValueListParameterOut',
                    LocalDataProperty  : Status,
                    ValueListProperty  : 'Status'
                }
            ]
        }
    );

    RiskScore @(
        Common.Label : 'Composite Risk Score (0–100)',
        Measures.Unit: '%'
    );

    CompanyName @(
        Common.Label    : 'Legal Company Name',
        Common.FieldControl : #Mandatory
    );

    TaxID @(
        Common.Label : 'Tax ID / EIN / VAT Number'
    );

    Country @(
        Common.Label                    : 'Country (ISO 3166-1 α-3)',
        Common.ValueListWithFixedValues : false
    );

    StatusCriticality @(
        UI.Hidden    : true,
        Core.Computed: true
    );
}


// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: VendorDocuments child table
//  Displayed on the "Uploaded Documents" tab of the Vendor Object Page.
//  AI_Confidence_Score rendered with a progress DataPoint.
// ─────────────────────────────────────────────────────────────────────────────
annotate service.VendorDocuments with @(

    UI.LineItem : [
        {
            $Type : 'UI.DataField',
            Value : DocumentType,
            Label : 'Type'
        },
        {
            $Type : 'UI.DataField',
            Value : URL,
            Label : 'Document URL'
        },
        {
            $Type : 'UI.DataField',
            Value : UploadDate,
            Label : 'Uploaded'
        },
        {
            // AI confidence rendered as a progress bar (0.0–1.0)
            $Type  : 'UI.DataFieldForAnnotation',
            Target : '@UI.DataPoint#AIConfidence',
            Label  : 'AI Confidence'
        }
    ],

    UI.DataPoint #AIConfidence : {
        Value         : AI_Confidence_Score,
        Title         : 'AI Extraction Confidence',
        Visualization : #Progress,
        TargetValue   : 1,    // 100% scale
        CriticalityCalculation : {
            ImprovementDirection   : #Maximize,
            ToleranceRangeLowValue : 0.85,
            DeviationRangeLowValue : 0.70
        }
    }
);

annotate service.VendorDocuments with {
    DocumentType @(
        Common.Label                    : 'Document Type',
        Common.ValueListWithFixedValues : true
    );
    AI_Confidence_Score @(
        Common.Label : 'LLM Confidence Score (0–1)'
    );
}


// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: BankAccounts child table
// ─────────────────────────────────────────────────────────────────────────────
annotate service.BankAccounts with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : AccountName,   Label : 'Account Name'    },
        { $Type : 'UI.DataField', Value : AccountNumber, Label : 'Account Number'  },
        { $Type : 'UI.DataField', Value : RoutingNumber, Label : 'Routing No.'     },
        { $Type : 'UI.DataField', Value : SwiftCode,     Label : 'SWIFT / BIC'     },
        {
            $Type       : 'UI.DataField',
            Value       : IsVerified,
            Label       : 'KYC Verified',
            Criticality : IsVerified  // 0 = red (false), 1 = ... needs int mapping
        }
    ]
);


// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: ApprovalReviews child table
//  Shadow-mode footnote in Comments column surfaces RL performance data.
// ─────────────────────────────────────────────────────────────────────────────
annotate service.ApprovalReviews with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : ReviewDate,   Label : 'Review Date'  },
        { $Type : 'UI.DataField', Value : ReviewerName, Label : 'Reviewer'     },
        { $Type : 'UI.DataField', Value : Department,   Label : 'Department'   },
        { $Type : 'UI.DataField', Value : Decision,     Label : 'Decision'     },
        { $Type : 'UI.DataField', Value : Comments,     Label : 'Comments (incl. RL audit)' }
    ]
);


// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: RLTrainingBatches (data-science / ops review table)
//  Accessible via the dedicated RL Training Data route in manifest.json.
// ─────────────────────────────────────────────────────────────────────────────
annotate service.RLTrainingBatches with @(

    UI.HeaderInfo : {
        TypeName       : 'RL Training Record',
        TypeNamePlural : 'RL Training Batches',
        Title          : { $Type : 'UI.DataField', Value : PredictedAction },
        Description    : { $Type : 'UI.DataField', Value : createdAt        }
    },

    UI.LineItem : [
        {
            $Type       : 'UI.DataField',
            Value       : Vendor.CompanyName,
            Label       : 'Vendor'
        },
        {
            $Type : 'UI.DataField',
            Value : PredictedAction,
            Label : 'RL Predicted'
        },
        {
            $Type : 'UI.DataField',
            Value : TrueAction,
            Label : 'Human Actual'
        },
        {
            $Type       : 'UI.DataField',
            Value       : Reward,
            Label       : 'Reward',
            Criticality : Reward      // +1 = green, 0 = neutral, -1 = red (int criticality)
        },
        {
            $Type : 'UI.DataField',
            Value : createdAt,
            Label : 'Batch Created'
        }
    ],

    UI.Facets : [
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'RLDecisionComparison',
            Label  : 'Decision Comparison',
            Target : '@UI.FieldGroup#RLDecisionComparison'
        },
        {
            $Type  : 'UI.ReferenceFacet',
            ID     : 'RLStateVector',
            Label  : 'Feature StateVector (JSON)',
            Target : '@UI.FieldGroup#RLStateVector'
        }
    ],

    UI.FieldGroup #RLDecisionComparison : {
        $Type : 'UI.FieldGroupType',
        Label : 'Decision Comparison',
        Data  : [
            { $Type : 'UI.DataField', Value : PredictedAction, Label : 'RL Predicted Action' },
            { $Type : 'UI.DataField', Value : TrueAction,      Label : 'Human True Action'   },
            { $Type : 'UI.DataField', Value : Reward,          Label : 'Reward Signal'        }
        ]
    },

    UI.FieldGroup #RLStateVector : {
        $Type : 'UI.FieldGroupType',
        Label : 'Input Feature Vector',
        Data  : [
            { $Type : 'UI.DataField', Value : StateVector, Label : 'StateVector JSON' }
        ]
    }
);


// ─────────────────────────────────────────────────────────────────────────────
//  ANNOTATIONS: AgentExtractionLogs (AI ops diagnostic table)
// ─────────────────────────────────────────────────────────────────────────────
annotate service.AgentExtractionLogs with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : MissingFields,  Label : 'Missing Fields'    },
        { $Type : 'UI.DataField', Value : EmailTriggered, Label : 'Follow-up Emailed' },
        { $Type : 'UI.DataField', Value : createdAt,      Label : 'Extracted At'       }
    ]
);
