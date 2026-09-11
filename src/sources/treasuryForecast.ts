// Stream A: Treasury OSDBU published Forecast of Contract Opportunities.
//
// The forecast site (osdbu.forecast.treasury.gov) is a public Salesforce site.
// Its "Download Opportunity Data" button calls one guest Apex method, getData,
// which returns EVERY opportunity grouped by bureau. Verified 2026-07-22: works
// cold from plain Node (no cookies/browser), 7 bureaus, 404 records, and the
// NAICS/PSC codes resolve from the embedded __r relationship objects.

import { fingerprint } from "../core/fingerprint.js";
import { config } from "../config.js";
import type { Opportunity, OppType } from "../core/types.js";

const BASE = "https://osdbu.forecast.treasury.gov";
const ENDPOINT =
  "/webruntime/api/apex/execute?language=en-US&asGuest=true&htmlEncode=false";

// The Apex descriptor the site uses. Empty filter arrays = return everything.
const GETDATA_BODY = {
  namespace: "",
  classname: "@udd/01pSJ000000H5BV",
  method: "getData",
  isContinuation: false,
  params: {
    fiscalYearFilter: [],
    bureauFilter: [],
    NAICSFilter: [],
    PSCFilter: [],
    setAsideFilter: [],
    periodOfPerformanceFilter: [],
    totalContractValueFilter: [],
    vendorNameFilter: [],
    placeOfPerformanceFilter: [],
    opportunityTypeFilter: [],
  },
  cacheable: false,
};

// Each bureau container holds up to five arrays of records, one per opp type.
const GROUP_TO_TYPE: Record<string, OppType> = {
  newOppData: "New",
  recompeteOppData: "Recompete",
  micropurchaseAwardData: "Micropurchase",
  simplifiedAcquisitionAwardData: "SAT",
  above250kData: "Above250k",
};

// Codes arrive as "541519-Other Computer Related Services" / "DA01-...": take the prefix.
function codePrefix(s?: string): string | undefined {
  if (!s) return undefined;
  const idx = s.indexOf("-");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

export async function fetchTreasuryForecast(): Promise<Opportunity[]> {
  const res = await fetch(BASE + ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify(GETDATA_BODY),
  });
  if (!res.ok) {
    throw new Error(`Treasury getData HTTP ${res.status} ${res.statusText}`);
  }
  const json: any = await res.json();
  const rv = json?.returnValue;
  if (!Array.isArray(rv)) {
    throw new Error("Treasury getData: unexpected shape (returnValue is not an array)");
  }

  // A single opportunity is listed under multiple bands (e.g. both "Recompete"
  // and "Above $250K"). Dedup by record Id, keeping the first occurrence — group
  // order below means New/Recompete wins over the dollar-threshold bands, which
  // is the more meaningful primary type.
  const byId = new Map<string, Opportunity>();
  for (const container of rv) {
    const bureau: string = container?.Name ?? "Unknown Bureau";
    for (const [group, oppType] of Object.entries(GROUP_TO_TYPE)) {
      const arr = container?.[group];
      if (!Array.isArray(arr)) continue;
      for (const r of arr) {
        if (r?.Id && byId.has(r.Id)) continue;
        const opp = normalize(r, bureau, oppType);
        byId.set(opp.id, opp);
      }
    }
  }
  return [...byId.values()];
}

function normalize(r: any, bureau: string, oppType: OppType): Opportunity {
  const naicsDesc: string | undefined = r?.sbfNAICSCode__r?.SBF_NAICS_Description__c;
  const pscDesc: string | undefined = r?.sbfPSCCode__r?.sbfPSCCodeandDefinition__c;
  const setAside =
    r?.sbfSmallBusinessSetaside__c === "Yes"
      ? r?.sbfTypeofSBSA__c || "Set-aside"
      : "None";

  return {
    source: "treasury-forecast",
    id: r?.Id,
    fingerprint: fingerprint(["treasury-forecast", r?.Id]),
    title: r?.Name ?? "(untitled)",
    description: r?.Description__c,
    agency: "Treasury",
    bureau,
    oppType,
    naics: codePrefix(naicsDesc),
    naicsDesc,
    psc: codePrefix(pscDesc),
    pscDesc,
    estValue: r?.sbfEstimatedTotalContractValue__c,
    setAside,
    placeState: r?.sbfPlaceofPerformanceState__c,
    awardQuarter: r?.sbfFiscalYear_QtrforAward__c,
    popStart: r?.sbfProjectedPeriodofPerformanceStart__c,
    popEnd: r?.sbfProjectedPeriodofPerformanceEnd__c,
    // NOTE: sbfIncumbentVendorName__c is an unresolved Salesforce id in getData,
    // so we surface the named POCs instead (more actionable for outreach).
    bureauPoc: r?.sbfBureauPointofContact__c,
    programOfficePoc: r?.sbfProgramOfficePointofContact__c,
    contractVehicle: r?.sbfProjectedContractVehicle__c,
    active: r?.Active__c === true,
    phase: r?.sbfAcquisitionPhase__c,
    url: BASE + "/",
    fitTag: "other",
    matchedTerms: [],
    watchedValue: r?.sbfEstimatedTotalContractValue__c,
  };
}
