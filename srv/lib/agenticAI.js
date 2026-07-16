'use strict';
/**
 * srv/lib/agenticAI.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 2 of the Phase 2 ingestion pipeline.
 * Customized for Tech / Commercial / Subcontractor Onboarding Compliance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('agenticAI');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─────────────────────────────────────────────────────────────────────────────
//  SYSTEM PROMPT — Enterprise Compliance & Master Data
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `\
You are a high-precision enterprise vendor, commercial, and resource compliance AI operating inside a vendor onboarding system.

TASK: Analyze the provided document and extract structured compliance and master data based on strict enterprise onboarding policies. Return ONLY a single valid JSON object. No explanations. No markdown fences.

REQUIRED OUTPUT SCHEMA:
{
  "CompanyName": "string | null",
  "SupplierID": "string | null",
  "TaxID": "string | null",
  "Industry": "string | null",
  "Address": "string | null",
  "Country": "string (ISO 3166-1 alpha-3, e.g. USA, IND, GBR) | null",
  "ContactName": "string | null",
  "ContactEmail": "string | null",
  "PhoneNumber": "string | null",
  "BankAccount": {
    "AccountNumber": "string | null",
    "BankID_Routing": "string (Routing, IFSC, Sort Code, or SWIFT) | null"
  },
  "DocumentCategory": "string (MUST BE ONE OF: 'Vendor Master Form', 'Commercial Agreement', 'Security Assessment', 'Resource Document', or 'Unknown') | null",
  "ComplianceChecks": {
    "IsMSA": "boolean",
    "IsSOW": "boolean",
    "IsNDA": "boolean",
    "HasDataPrivacyClauses": "boolean",
    "HasRightToAudit": "boolean",
    "HasBCP_DR": "boolean",
    "HasCybersecurityControls": "boolean"
  },
  "ResourceDetails": {
    "ResourceName": "string | null",
    "HasCV": "boolean",
    "HasGovtID": "boolean",
    "HasBackgroundVerification": "boolean",
    "SignedCodeOfConduct": "boolean"
  }
}

CRITICAL RULES:
1. Base all extractions STRICTLY on the document text. Do not hallucinate or guess.
2. Set string fields to null if not found explicitly in the text.
3. Set boolean fields to true ONLY if the document explicitly constitutes that agreement (e.g. IsMSA=true) or explicitly contains that clause/evidence (e.g. HasBackgroundVerification=true).
4. DocumentCategory MUST be deduced from the content.
5. When in doubt, ALWAYS prefer null or false over a guessed value.
6. NEVER use the filename or metadata as a source for extraction.`;

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: extractVendorData
// ─────────────────────────────────────────────────────────────────────────────
async function extractVendorData(securedPayload) {
    const { documentId, vendorId, documentType, url, metadata, fileBuffer } = securedPayload;

    LOG.info(`[AgenticAI] Starting compliance extraction — document: ${documentId}`);

    const userMessage = await _buildUserPrompt(securedPayload);
    const rawLLMOutput = await _callAICore(userMessage, fileBuffer, metadata.mimeType);

    LOG.info(`\n\n[AgenticAI] 🟢 Extracted JSON Payload:\n${rawLLMOutput}\n\n`);

    const extracted = _parseAndValidate(rawLLMOutput, documentId);

    // Assess compliance completeness to trigger dynamic emails
    const { missingFields, criticalMissing } = _assessCompleteness(extracted);
    const overallConfidence = 1.0; 
    const emailRequired = missingFields.length > 0;

    LOG.info(`[AgenticAI] Compliance result — document: ${documentId}`, {
        missingCount    : missingFields.length,
        missingFields,
        criticalMissing,
        emailRequired
    });

    return {
        documentId, vendorId, extracted, rawLLMOutput,
        overallConfidence, missingFields, criticalMissing, emailRequired
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _assessCompleteness (THE MISSING-DOCUMENT EMAIL TRIGGER)
//  Evaluates the JSON against the enterprise compliance policy dynamically.
// ─────────────────────────────────────────────────────────────────────────────
function _assessCompleteness(extracted) {
    const missingFields = [];
    
    const docCat = extracted.DocumentCategory || '';
    const comp = extracted.ComplianceChecks || {};
    const res = extracted.ResourceDetails || {};
    const bank = extracted.BankAccount || {};

    // 1. Universal Identity Check
    if (!extracted.CompanyName || String(extracted.CompanyName).trim() === '') {
        missingFields.push('CompanyName');
    }

    // 2. Resource Document Checks (Subcontractors)
    if (docCat === 'Resource Document') {
        if (!res.ResourceName) missingFields.push('Resource_Name');
        if (!res.HasBackgroundVerification) missingFields.push('Background_Verification_Clearance');
        if (!res.HasGovtID) missingFields.push('Government_ID_Proof');
    } 
    // 3. Commercial Agreement Checks
    else if (docCat === 'Commercial Agreement') {
        if (!comp.IsMSA && !comp.IsSOW && !comp.IsNDA) {
            missingFields.push('Signed_MSA_SOW_or_NDA');
        }
        if (!comp.HasDataPrivacyClauses) missingFields.push('Data_Privacy_and_Security_Clauses');
    }
    // 4. Security Assessment Checks
    else if (docCat === 'Security Assessment') {
        if (!comp.HasBCP_DR) missingFields.push('BCP_DR_Capabilities');
        if (!comp.HasCybersecurityControls) missingFields.push('Cybersecurity_Controls_Checklist');
    }
    // 5. Standard Vendor Master Form Checks
    else {
        if (!extracted.TaxID) missingFields.push('TaxID_or_VAT_Number');
        if (!extracted.ContactEmail) missingFields.push('Primary_Contact_Email');
        if (!bank.AccountNumber) missingFields.push('BankAccount_Number');
    }

    // If ANY fields are missing based on the rules above, halt the pipeline and email them
    const criticalMissing = missingFields.length > 0;
    
    return { missingFields, criticalMissing };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: Prompting & Parsing Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function _buildUserPrompt(payload) {
    const { documentType, metadata } = payload;
    const preamble = `Document Type   : ${documentType}\nFile Format     : ${metadata.extension.toUpperCase().replace('.', '')}\n\n`;
    return { _isMultimodal : true, preamble, imageMimeType : metadata.mimeType };
}

async function _callAICore(userMessage, fileBuffer, mimeType) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('GEMINI_API_KEY is missing');

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
    });

    try {
        const prompt = [
            { text: SYSTEM_PROMPT + '\n\n' + userMessage.preamble + '\nExtract all compliance and master data fields. Return JSON only.' },
            { inlineData: { data: fileBuffer.toString("base64"), mimeType: mimeType } }
        ];
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (err) {
        LOG.error(`[AgenticAI] Gemini Error: ${err.message}`);
        throw err;
    }
}

function _parseAndValidate(rawContent, documentId) {
    let cleaned = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        const parsed = JSON.parse(cleaned);
        // Guarantee structure to avoid downstream null-guards
        parsed.confidence = { overall: 1.0, perField: {} };
        if (!parsed.ComplianceChecks) parsed.ComplianceChecks = {};
        if (!parsed.ResourceDetails) parsed.ResourceDetails = {};
        if (!parsed.BankAccount) parsed.BankAccount = {};
        return parsed;
    } catch (parseErr) {
        throw new Error(`LLM returned non-JSON content: ${parseErr.message}`);
    }
}

module.exports = { extractVendorData };