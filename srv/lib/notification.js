'use strict';
/**
 * srv/lib/notification.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 3 (conditional) of the Phase 2 ingestion pipeline.
 * Triggered only when the AgenticAI engine detects missing or low-confidence
 * fields that require vendor action before processing can continue.
 *
 * Responsibilities:
 *   - Map missing field names to human-readable document requests
 *   - Build a dynamic, personalised email body from the AgentExtractionLog
 *   - Dispatch via SAP BTP Destination Service + SAP Cloud SDK Mail Client
 *
 * Production wiring (Phase 2):
 *   npm install @sap-cloud-sdk/connectivity @sap-cloud-sdk/mail-client
 *   Replace _dispatchViaDestination() body with the real SDK calls shown
 *   in the inline comments below.
 *
 * Required environment variables:
 *   EMAIL_DESTINATION_NAME  — Name of the BTP Destination (type: MAIL)
 *                             configured in the BTP subaccount cockpit
 *   NOTIFICATION_FROM_EMAIL — Sender address (e.g. noreply@procurement.corp)
 *   VENDOR_PORTAL_URL       — Re-upload URL shown in the email body
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('notification');
const nodemailer = require('nodemailer'); // <-- ADD THIS LINE

// ── Field → required-document mapping ─────────────────────────────────────────
// Drives the bullet list in the vendor email so the language is precise and
// actionable rather than just listing a field name.
const FIELD_DOCUMENT_MAP = {
    CompanyName               : 'Certified Business Registration Certificate showing legal entity name',
    TaxID                     : 'Tax Registration Certificate (EIN, VAT number, or equivalent)',
    Industry                  : 'Business Classification Letter or SIC/NAICS confirmation',
    Country                   : 'Certificate of Incorporation showing Country of Registration',
    'BankAccount.AccountNumber': 'Official Bank Statement (last 3 months) or Voided Cheque',
    'BankAccount.RoutingNumber': 'Bank Confirmation Letter or Wire Transfer Instruction Sheet',
    'BankAccount.SwiftCode'    : 'Bank Confirmation Letter showing SWIFT / BIC code'
};

const DOCUMENT_FORMAT_REQUIREMENTS = [
    'High resolution (minimum 300 DPI for scanned documents)',
    'Not password-protected or encrypted',
    'Clearly legible — no redactions over required fields',
    'Accepted formats: PDF, PNG, or JPEG',
    'Issued within the last 12 months (where applicable)'
];

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: sendExtractionFailureNotification
//  Called by vendor-service.js when the AI gate triggers emailRequired = true.
//  Returns a result object indicating whether the email was dispatched and the
//  message ID for audit logging purposes.
// ─────────────────────────────────────────────────────────────────────────────
async function sendExtractionFailureNotification(vendorRecord, extractionLog) {
    const { ID: vendorId, CompanyName: companyName } = vendorRecord ?? {};

    // Parse missing fields from comma-separated string stored in the log
    const missingFields = (extractionLog?.MissingFields ?? '')
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);

    if (missingFields.length === 0) {
        LOG.info(`[Notification] No missing fields on log for Vendor: ${vendorId} — suppressing email.`);
        return { sent: false, reason: 'NO_MISSING_FIELDS' };
    }

    LOG.info(`[Notification] Building failure notification for Vendor: ${vendorId} (${companyName})`, {
        missingFields
    });

    const emailPayload = _buildEmailPayload(vendorRecord, missingFields);

    const dispatchResult = await _dispatchViaDestination(emailPayload);

    LOG.info(`[Notification] Dispatch result for Vendor: ${vendorId}`, dispatchResult);

    return dispatchResult;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _buildEmailPayload
//  Constructs the full email object. Each missing field is translated into a
//  specific document request so the vendor knows exactly what to upload.
// ─────────────────────────────────────────────────────────────────────────────
function _buildEmailPayload(vendor, missingFields) {
    const { ID: vendorId, CompanyName: companyName } = vendor;
    const portalUrl  = process.env.VENDOR_PORTAL_URL ?? 'https://vendor-portal.cfapps.sap.hana.ondemand.com';
    const fromEmail  = process.env.NOTIFICATION_FROM_EMAIL ?? 'noreply-vendor@procurement.internal';

    // ── HARDCODED RECIPIENT ──────────────────────────────────────────────────
    // TODO: In a future iteration, this should be changed to forward the email
    //       to the person who originally sent/uploaded the document.
    //       For now, all missing-data notifications go to a single hardcoded
    //       recipient configured via NOTIFICATION_HARDCODED_TO in .env.
    // ─────────────────────────────────────────────────────────────────────────
    const toEmail = process.env.NOTIFICATION_HARDCODED_TO || 'CHANGE_ME@example.com';

    // Build numbered required-documents list
    const documentRequestLines = missingFields.map((field, idx) => {
        const docDescription = FIELD_DOCUMENT_MAP[field]
            ?? `Supporting documentation for field: ${field}`;
        return `   ${idx + 1}. ${_toReadableFieldName(field)}\n      Required: ${docDescription}`;
    }).join('\n\n');

    // Build document format requirements list
    const formatRequirementLines = DOCUMENT_FORMAT_REQUIREMENTS
        .map(r => `   • ${r}`)
        .join('\n');

    const emailBody = `Dear ${companyName ?? 'Valued Vendor'},

Thank you for initiating your vendor registration. Our automated document processing
system has reviewed the files you submitted and was unable to extract the following
required information with sufficient confidence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MISSING OR UNREADABLE INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${documentRequestLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCUMENT REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All submitted documents must meet the following standards:

${formatRequirementLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEXT STEPS

Please re-upload the required documents at the link below. Your registration
reference ID is: ${vendorId}

   ${portalUrl}/vendors/${vendorId}/documents

Once we receive your updated documents, our system will automatically re-process
your registration. If all information can be extracted successfully, your application
will proceed to the next review stage without further delay.

If you believe you have already provided these documents or need assistance, please
contact our Vendor Onboarding Support team and quote your reference ID: ${vendorId}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is an automated message from the Vendor Onboarding System.
Please do not reply directly to this email.

Best regards,
Vendor Onboarding Team
Procurement Operations`;

    return {
        to          : toEmail,
        from        : fromEmail,
        subject     : `[Action Required – Ref: ${vendorId}] Vendor Registration: Missing Documents`,
        body        : emailBody,
        vendorId,
        missingFields,
        triggeredAt : new Date().toISOString()
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _dispatchViaDestination
//  Routes the email through a named BTP Destination (type: MAIL).
//
//  Production replacement:
//    import { getDestination }              from '@sap-cloud-sdk/connectivity';
//    import { sendMail, buildSendMailRequest } from '@sap-cloud-sdk/mail-client';
//
//    const destination = await getDestination({ destinationName });
//    if (!destination) throw new Error(`Destination '${destinationName}' not found.`);
//
//    const mailRequest = buildSendMailRequest(destination, {
//        from    : { address: payload.from },
//        to      : [{ address: payload.to }],
//        subject : payload.subject,
//        text    : payload.body
//    });
//    const [result] = await sendMail(destination, [mailRequest]);
//    return { sent: true, messageId: result.messageId, destination: destinationName };
// ─────────────────────────────────────────────────────────────────────────────
async function _dispatchViaDestination(payload) {
    LOG.info(`[Notification] Dispatching REAL email to: ${payload.to}`);

    try {
        // Create a transporter using your real email credentials
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: '', // <-- Put your real sender email here
                pass: ''         // <-- Put your Google App Password here
            }
        });

        // Send the email
        const info = await transporter.sendMail({
            from: '"VendorFlow AI" <noreply@vendorflow.com>',
            to: payload.to, 
            subject: payload.subject,
            text: payload.body
        });

        LOG.info(`[Notification] ✓ REAL Email Sent! Message ID: ${info.messageId}`);

        return {
            sent: true,
            messageId: info.messageId,
            to: payload.to,
            sentAt: new Date().toISOString()
        };
    } catch (error) {
        LOG.error(`[Notification] ✗ Failed to send real email: ${error.message}`);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _toReadableFieldName
//  Converts internal field paths to human-readable labels for the email body.
// ─────────────────────────────────────────────────────────────────────────────
function _toReadableFieldName(fieldPath) {
    const labels = {
        CompanyName                : 'Company Legal Name',
        TaxID                      : 'Tax Identification Number (TaxID)',
        Industry                   : 'Industry / Business Sector',
        Country                    : 'Country of Registration',
        'BankAccount.AccountNumber': 'Bank Account Number',
        'BankAccount.RoutingNumber': 'Bank Routing Number (ABA)',
        'BankAccount.SwiftCode'    : 'SWIFT / BIC Code'
    };
    return labels[fieldPath] ?? fieldPath;
}

module.exports = { sendExtractionFailureNotification };
