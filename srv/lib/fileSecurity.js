'use strict';
/**
 * srv/lib/fileSecurity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 1 of the Phase 2 ingestion pipeline.
 * Responsibilities:
 *   - MIME type & extension whitelist enforcement
 *   - File-size guard
 *   - Anti-malware scan (ClamAV / SAP Malware Scanning Service stub)
 *   - Metadata extraction and payload normalisation for the AI layer
 *
 * Production wiring (Phase 2):
 *   Replace _runMalwareScan() body with a real call to either:
 *     a) SAP BTP Malware Scanning Service  (service plan: clamav)
 *        POST {MALWARE_SCAN_URL}/v1/scan  + multipart file body
 *     b) Self-hosted ClamAV REST bridge    (clamav-rest / clamav-mirror)
 *   Replace _fetchFileBuffer() with the actual BTP Object Store / SAP DMS
 *   presigned-URL fetch.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const cds  = require('@sap/cds');
const LOG  = cds.log('fileSecurity');

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpeg', '.jpg']);
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_SIZE_BYTES     = 10 * 1024 * 1024; // 10 MB limit

const EXTENSION_MIME_MAP = {
    '.pdf'  : 'application/pdf',
    '.png'  : 'image/png',
    '.jpeg' : 'image/jpeg',
    '.jpg'  : 'image/jpeg'
};

async function processDocument(documentRecord) {
    // 1. We now expect DocumentType to be the extension (e.g., 'PDF') from the frontend
    const { ID: documentId, Vendor_ID: vendorId, URL: url, DocumentType: docType } = documentRecord;

    LOG.info(`[FileSecurity] Processing document: ${documentId} | type: ${docType} | url: ${url}`);

    // Standardize extension extraction
    const ext = path.extname(url ?? '').toLowerCase() || `.${docType.toLowerCase()}`;
    
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw _securityError(`Extension '${ext}' is not permitted.`, 'FILE_TYPE_REJECTED', 415);
    }

    const mimeType = EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';

    // 2. Decode the real file from the React frontend Base64 payload
    const fileBuffer = await _fetchFileBuffer(documentRecord);

    if (fileBuffer.byteLength > MAX_SIZE_BYTES) {
        throw _securityError(`File exceeds maximum size.`, 'FILE_TOO_LARGE', 413);
    }

    // Stubbed malware scan
    const scanResult = await _runMalwareScan(fileBuffer, documentId);
    if (!scanResult.clean) {
        throw _securityError(`Failed malware scan.`, 'MALWARE_DETECTED', 422);
    }

    const normalised = {
        documentId,
        vendorId,
        documentType: docType, // Now dynamically 'PDF', 'PNG', etc.
        url,
        metadata: {
            extension: ext,
            mimeType,
            sizeBytes: fileBuffer.byteLength,
            sizeKB: parseFloat((fileBuffer.byteLength / 1024).toFixed(2)),
            filename: path.basename(url)
        },
        fileBuffer // The REAL document buffer!
    };

    LOG.info(`[FileSecurity] ✓ Cleared — ${documentId}`);
    return normalised;
}

async function _fetchFileBuffer(documentRecord) {
    if (documentRecord.Content) {
        // Strip the "data:application/pdf;base64," prefix sent by the browser
        const base64Data = documentRecord.Content.replace(/^data:.*?;base64,/, '');
        return Buffer.from(base64Data, 'base64');
    }
    
    // Fallback if no content was sent
    LOG.warn('[FileSecurity] No Content found in payload, falling back to dummy buffer.');
    return Buffer.alloc(1024);
}

async function _runMalwareScan(fileBuffer, documentId) {
    await new Promise(r => setTimeout(r, 90));
    return { clean: true, threat: null, scanEngine: 'ClamAV-STUB' };
}

function _securityError(message, code, httpStatus) {
    const err = new Error(message);
    err.code = code; err.httpStatus = httpStatus; err.isSecurityError = true;
    return err;
}

module.exports = { processDocument };

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _runMalwareScan
//  SAP BTP Malware Scanning Service (service plan: clamav) integration.
//
//  Phase 2 production replacement:
//    const form = new FormData();
//    form.append('file', Blob.from(fileBuffer), { type: 'application/octet-stream' });
//    const res  = await fetch(`${process.env.MALWARE_SCAN_URL}/v1/scan`, {
//        method  : 'POST',
//        headers : { 'Authorization': `Bearer ${process.env.MALWARE_SCAN_TOKEN}` },
//        body    : form
//    });
//    const json = await res.json();
//    return { clean: json.status === 'CLEAN', threat: json.threatName ?? null };
// ─────────────────────────────────────────────────────────────────────────────
async function _runMalwareScan(fileBuffer, documentId) {
    LOG.info(`[FileSecurity] Running malware scan on document: ${documentId} (${(fileBuffer.byteLength / 1024).toFixed(1)} KB)`);

    // ── STUB ─────────────────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 90));  // simulate ClamAV scan time

    // To test the threat path, set env FORCE_MALWARE_HIT=true
    if (process.env.FORCE_MALWARE_HIT === 'true') {
        LOG.warn(`[FileSecurity][STUB] Simulating malware hit on document: ${documentId}`);
        return { clean: false, threat: 'STUB.Eicar-Test-Signature', scanEngine: 'ClamAV-STUB' };
    }

    LOG.info(`[FileSecurity] ✓ Scan clean — document: ${documentId}`);
    return { clean: true, threat: null, scanEngine: 'ClamAV-STUB', scannedAt: new Date().toISOString() };
    // ── END STUB ─────────────────────────────────────────────────────────────
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIVATE: _securityError
//  Factory for typed, structured security errors. The `code` is used by the
//  orchestrator to decide whether to notify the vendor (e.g. MALWARE_DETECTED
//  must NOT notify to avoid revealing detection logic).
// ─────────────────────────────────────────────────────────────────────────────
function _securityError(message, code, httpStatus) {
    const err = new Error(message);
    err.code       = code;
    err.httpStatus = httpStatus;
    err.isSecurityError = true;
    return err;
}

module.exports = { processDocument };
