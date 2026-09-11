// Stream A3: DHS Acquisition Planning Forecast System (APFS).
//
// DHS publishes its entire pre-solicitation forecast through one public, no-auth
// JSON endpoint (found by intercepting the forecast site's data load):
//   GET https://apfs-cloud.dhs.gov/api/forecast
// Verified 2026-07-29: works cold from plain Node (no cookies/auth/referer),
// returns a single ~2MB array of ~780 records — the whole forecast, no paging.
//
// DHS is absent from the GSA Acquisition Gateway (Stream A2), so this is the only
// way to cover it. The forecast is facilities-heavy (Coast Guard shore, CBP
// construction), but carries a real IT/financial-systems subset (CISA, USCIS,
// TSA, HQ) that classify() keeps and the rest it drops. No PSC field.

import { fingerprint } from "../core/fingerprint.js";
import { config } from "../config.js";
import type { Opportunity, OppType } from "../core/types.js";

const ENDPOINT = "https://apfs-cloud.dhs.gov/api/forecast";
const RECORD_URL = (id: string | number) => `https://apfs-cloud.dhs.gov/record/${id}/public-print/`;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// One ~2MB response; generous timeout for a cold, occasionally-slow origin.
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchDhsForecast(): Promise<Opportunity[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        headers: { Accept: "application/json", "User-Agent": config.userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        throw new Error(`DHS APFS HTTP ${res.status} ${res.statusText}`);
      }
      const json: any = await res.json();
      const arr: any[] = Array.isArray(json) ? json : json?.data ?? json?.results ?? [];
      if (!Array.isArray(arr)) throw new Error("DHS APFS: unexpected shape (not an array)");
      return arr.filter((r) => r && r.id != null).map(normalizeDhsRecord);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function normalizeDhsRecord(r: any): Opportunity {
  const id = String(r.id);
  const naicsStr: string | undefined = typeof r.naics === "string" ? r.naics : r.naics?.code;
  const status = String(r.contract_status ?? "").toUpperCase();
  const sbp = clean(r.small_business_program);

  return {
    source: "dhs-apfs",
    id,
    fingerprint: fingerprint(["dhs-apfs", id]),
    title: clean(r.requirements_title) ?? "(untitled)",
    description: stripHtml(r.requirement),
    agency: "DHS",
    bureau: clean(r.organization),
    oppType: statusToType(status),
    naics: codePrefix(naicsStr),
    naicsDesc: naicsStr,
    // APFS carries no PSC.
    estValue: displayDollar(r.dollar_range),
    setAside: sbp && !/^(none|tbd)$/i.test(sbp) ? sbp : "None",
    placeState: clean(r.place_of_performance_state),
    awardQuarter: normalizeQuarter(r.award_quarter, r.fiscal_year),
    solicitationDate: clean(r.estimated_solicitation_release_date),
    popStart: clean(r.estimated_period_of_performance_start),
    popEnd: clean(r.estimated_period_of_performance_end),
    incumbent: clean(r.contractor),
    bureauPoc: pocName(r.requirements_contact_first_name, r.requirements_contact_last_name, r.requirements_contact_email),
    programOfficePoc: pocName(r.sbs_coordinator_first_name, r.sbs_coordinator_last_name, r.sbs_coordinator_email),
    contractVehicle: clean(r.contract_vehicle),
    // "NLR" = No Longer Required — a dead lead. Flag inactive so classify() drops
    // it and the scorer floors it to 0.
    active: status !== "NLR",
    url: RECORD_URL(id),
    fitTag: "other",
    matchedTerms: [],
    watchedValue: displayDollar(r.dollar_range),
  };
}

// ---- field helpers ----

function statusToType(status: string): OppType {
  if (status === "REC" || /recompete|follow|recurring|renew/i.test(status)) return "Recompete";
  return "New";
}

// "236220 - Commercial and Institutional Building Construction" -> "236220".
function codePrefix(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/\d{6}/);
  return m ? m[0] : undefined;
}

// dollar_range is an object { display_name: "$5M to $10M", display_order } or,
// defensively, a plain string.
function displayDollar(d: any): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") return clean(d);
  return clean(d.display_name);
}

// APFS gives "Q4 2026" (quarter-first) — rewrite to the canonical "FY 2026 Q4"
// the rest of the pipeline (dedup change-detection, scorer timing) expects.
function normalizeQuarter(q?: string, fy?: number | string): string | undefined {
  const s = clean(q);
  if (!s) return fy ? `FY ${fy}` : undefined;
  const qy = s.match(/Q\s*([1-4])\s*(\d{4})/i); // "Q4 2026"
  if (qy) return `FY ${qy[2]} Q${qy[1]}`;
  const yq = s.match(/(\d{4})\s*Q\s*([1-4])/i); // "2026 Q4" (defensive)
  if (yq) return `FY ${yq[1]} Q${yq[2]}`;
  return fy ? `FY ${fy}` : undefined;
}

function pocName(first?: string, last?: string, email?: string): string | undefined {
  const name = [clean(first), clean(last)].filter(Boolean).join(" ");
  const e = clean(email);
  if (name && e) return `${name} <${e}>`;
  return name || e || undefined;
}

function stripHtml(s?: string): string | undefined {
  const t = String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return t || undefined;
}

function clean(s?: string): string | undefined {
  const t = String(s ?? "").trim();
  if (!t || /^(not provided|tbd|n\/a|to be determined|null)$/i.test(t)) return undefined;
  return t;
}
