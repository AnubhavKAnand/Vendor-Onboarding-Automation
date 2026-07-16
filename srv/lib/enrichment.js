'use strict';
/**
 * srv/lib/enrichment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 4 of the Phase 2 ingestion pipeline.
 * Executes two external verification checks in parallel via Promise.allSettled:
 *
 *   KYC Check         — Corporate registry verification of TaxID ↔ CompanyName
 *   Sanctions Screen  — Multi-list AML screening (OFAC SDN, UN, EU Consolidated)
 *
 * Both calls are non-blocking relative to each other; a failure in either is
 * handled gracefully (logged, partial data forwarded) so it does not kill the
 * pipeline. The StateVector records which checks succeeded so the RL agent
 * can weight its confidence accordingly.
 *
 * Production wiring (Phase 2):
 *   KYC providers    : Companies House API (UK), Bundesanzeiger (DE),
 *                      SEC EDGAR (US), or a commercial hub like Dun & Bradstreet
 *   Sanctions APIs   : OFAC SDN REST API, ComplyAdvantage, Refinitiv World-Check
 *
 * Required environment variables:
 *   KYC_REGISTRY_URL         — Base URL of KYC registry REST API
 *   KYC_API_KEY              — API key for KYC provider
 *   SANCTIONS_SCREENING_URL  — Base URL of AML / sanctions screening API
 *   SANCTIONS_API_TOKEN      — Bearer token for sanctions provider
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cds = require('@sap/cds');
const LOG = cds.log('enrichment');

// ── Risk contribution weights ─────────────────────────────────────────────────
// These feed into _computeCompositeRisk() in vendor-service.js.
// Adjust as your compliance policy evolves.
const RISK_WEIGHTS = Object.freeze({
    SANCTIONS_HIT        : 80.0,
    SANCTIONS_NEAR_MATCH : 40.0,
    KYC_MISMATCH         : 30.0,
    HIGH_RISK_COUNTRY    : 20.0,
    UNVERIFIED_TAX       : 15.0,
    INCOMPLETE_BANK      : 10.0
});

// FATF high-risk and grey-listed jurisdictions (illustrative — keep updated with
// FATF public statements: https://www.fatf-gafi.org/en/topics/high-risk-jurisdictions.html)
const HIGH_RISK_COUNTRIES = new Set([
    'PRK',  // North Korea
    'IRN',  // Iran
    'MMR',  // Myanmar
    'SYR',  // Syria
    'YEM',  // Yemen
    'SDN',  // Sudan
    'LBY',  // Libya
    'SOM',  // Somalia
    'HTI',  // Haiti (grey-listed)
    'PAK'   // Pakistan (grey-listed — verify current FATF status)
]);

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: runParallelEnrichment
//  Fires KYC + Sanctions checks concurrently. Uses Promise.allSettled so that
//  one provider outage does not block the other result from being captured.
//  Returns a unified enrichment result object.
// ─────────────────────────────────────────────────────────────────────────────
async function runParallelEnrichment(extractedData, vendorId) {
    const { TaxID, CompanyName, Country } = extractedData;

    LOG.info(`[Enrichment] Launching parallel checks — Vendor: ${vendorId}`, {
        taxId   : TaxID,
        company : CompanyName,
        country : Country
    });

    const [kycSettled, sanctionsSettled] = await Promise.allSettled([
        runKYCCheck(TaxID, CompanyName, vendorId),
        runSanctionsScreening(CompanyName, Country, vendorId)
    ]);

    // Resolve KYC result — degrade gracefully on failure
    const kyc = kycSettled.status === 'fulfilled'
        ? kycSettled.value
        : {
            Tax_ID_Valid     : null,   // null = indeterminate (not false)
            registryProvider : 'UNAVAILABLE',
            error            : kycSettled.reason?.message ?? 'Unknown error',
            verifiedAt       : new Date().toISOString()
        };

    // Resolve sanctions result — degrade gracefully on failure
    const sanctions = sanctionsSettled.status === 'fulfilled'
        ? sanctionsSettled.value
        : {
            Sanction_Match          : null,  // null = indeterminate
            Risk_Score_Contribution : RISK_WEIGHTS.INCOMPLETE_BANK,
            isHighRiskCountry       : HIGH_RISK_COUNTRIES.has((Country ?? '').toUpperCase()),
            screensChecked          : [],
            screeningProvider       : 'UNAVAILABLE',
            error                   : sanctionsSettled.reason?.message ?? 'Unknown error',
            screenedAt              : new Date().toISOString()
        };

    if (kycSettled.status === 'rejected') {
        LOG.error('[Enrichment] KYC check threw (non-fatal):', kycSettled.reason?.message);
    }
    if (sanctionsSettled.status === 'rejected') {
        LOG.error('[Enrichment] Sanctions screen threw (non-fatal):', sanctionsSettled.reason?.message);
    }

    LOG.info(`[Enrichment] ✓ Checks complete — Vendor: ${vendorId}`, {
        kycValid       : kyc.Tax_ID_Valid,
        sanctionMatch  : sanctions.Sanction_Match,
        riskContrib    : sanctions.Risk_Score_Contribution,
        highRiskCountry: sanctions.isHighRiskCountry
    });

    return { kyc, sanctions, RISK_WEIGHTS };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: runKYCCheck
//  Verifies that the extracted TaxID corresponds to the CompanyName in an
//  official government/corporate registry. Returns Tax_ID_Valid (Boolean).
//
//  Production replacement body:
//    const res = await fetch(`${process.env.KYC_REGISTRY_URL}/verify`, {
//        method  : 'POST',
//        headers : {
//            'Content-Type' : 'application/json',
//            'x-api-key'    : process.env.KYC_API_KEY
//        },
//        body : JSON.stringify({ taxId, companyName, country: 'USA' })
//    });
//    if (!res.ok) throw new Error(`KYC API HTTP ${res.status}: ${await res.text()}`);
//    const json = await res.json();
//    return {
//        Tax_ID_Valid     : json.verified === true,
//        registryProvider : json.registry,          // e.g. 'IRS_EIN', 'Companies_House'
//        registryRef      : json.registryReference,
//        verifiedAt       : json.timestamp
//    };
// ─────────────────────────────────────────────────────────────────────────────
async function runKYCCheck(taxId, companyName, vendorId) {
    LOG.info(`[KYC] Verifying TaxID '${taxId}' ↔ '${companyName}' — Vendor: ${vendorId}`);

    // ── STUB ─────────────────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 120)); // simulate registry API latency

    // Simple structural validation as a proxy for real registry lookup:
    //   - TaxID must be at least 8 chars after stripping prefix and separators
    //   - CompanyName must be non-trivial (> 3 chars)
    const normalisedTaxId  = (taxId  ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const normalisedName   = (companyName ?? '').trim();
    const Tax_ID_Valid     = normalisedTaxId.length >= 8 && normalisedName.length > 3;

    // To simulate a KYC mismatch, set env FORCE_KYC_FAIL=true
    const forced = process.env.FORCE_KYC_FAIL === 'true' ? false : Tax_ID_Valid;

    const result = {
        Tax_ID_Valid     : forced,
        registryProvider : 'STUB_REGISTRY_API',
        normalisedTaxId,
        verifiedAt       : new Date().toISOString()
    };

    LOG.info(`[KYC][STUB] Result → Tax_ID_Valid: ${result.Tax_ID_Valid} (normalised: ${normalisedTaxId})`);
    return result;
    // ── END STUB ─────────────────────────────────────────────────────────────
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: runSanctionsScreening
//  Checks the company name and country against multiple AML / sanctions lists.
//  Returns Sanction_Match (Boolean) and a Risk_Score_Contribution (Decimal)
//  that feeds into the composite risk score assembled in vendor-service.js.
//
//  Production replacement body:
//    const res = await fetch(`${process.env.SANCTIONS_SCREENING_URL}/screen`, {
//        method  : 'POST',
//        headers : {
//            'Authorization' : `Bearer ${process.env.SANCTIONS_API_TOKEN}`,
//            'Content-Type'  : 'application/json'
//        },
//        body : JSON.stringify({
//            name    : companyName,
//            country : country,
//            lists   : ['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_CONSOLIDATED']
//        })
//    });
//    if (!res.ok) throw new Error(`Sanctions API HTTP ${res.status}: ${await res.text()}`);
//    const json = await res.json();
//    return {
//        Sanction_Match          : json.matched,
//        Risk_Score_Contribution : json.riskScore,
//        matchedList             : json.matchedList ?? null,
//        matchedEntityName       : json.matchedName ?? null,
//        isHighRiskCountry       : json.isHighRiskJurisdiction,
//        screensChecked          : json.listsChecked,
//        screeningProvider       : 'YOUR_PROVIDER',
//        screenedAt              : json.timestamp
//    };
// ─────────────────────────────────────────────────────────────────────────────
async function runSanctionsScreening(companyName, country, vendorId) {
    LOG.info(`[Sanctions] Screening '${companyName}' (${country}) — Vendor: ${vendorId}`);

    // ── STUB ─────────────────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 150)); // simulate multi-list screening latency

    const countryCode     = (country ?? '').toUpperCase().trim();
    const isHighRiskCountry = HIGH_RISK_COUNTRIES.has(countryCode);

    // No real name-matching in stub — always returns clean for testing.
    // Set env FORCE_SANCTIONS_HIT=true to exercise the block path.
    const Sanction_Match  = process.env.FORCE_SANCTIONS_HIT === 'true';

    let Risk_Score_Contribution = 0;
    if (Sanction_Match)     Risk_Score_Contribution += RISK_WEIGHTS.SANCTIONS_HIT;
    if (isHighRiskCountry)  Risk_Score_Contribution += RISK_WEIGHTS.HIGH_RISK_COUNTRY;

    const result = {
        Sanction_Match,
        Risk_Score_Contribution : parseFloat(Risk_Score_Contribution.toFixed(2)),
        matchedList             : Sanction_Match ? 'STUB_OFAC_SDN' : null,
        matchedEntityName       : Sanction_Match ? companyName : null,
        isHighRiskCountry,
        screensChecked          : ['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_CONSOLIDATED'],
        screeningProvider       : 'STUB_SANCTIONS_API',
        screenedAt              : new Date().toISOString()
    };

    LOG.info('[Sanctions][STUB] Result →', {
        match       : result.Sanction_Match,
        riskContrib : result.Risk_Score_Contribution,
        highRisk    : result.isHighRiskCountry
    });

    return result;
    // ── END STUB ─────────────────────────────────────────────────────────────
}

module.exports = {
    runParallelEnrichment,
    runKYCCheck,
    runSanctionsScreening,
    RISK_WEIGHTS,
    HIGH_RISK_COUNTRIES
};
