// Governmentwide forecast source: GSA's Acquisition Gateway Forecast Tool.
//
// The public Forecast Tool (acquisitiongateway.gov/forecast) aggregates every
// agency's forecast. Its "Export CSV" button pages a public, no-auth JSON API:
//   GET ag-dashboard.acquisitiongateway.gov/api/v3.0/export/forecast?range=N&page=P
// Verified 2026-07-23: works cold from Node, ~9k+ records across all agencies.
//
// Treasury is EXCLUDED here because it already has its own richer adapter
// (treasuryForecast.ts); this covers every OTHER agency.

import { fingerprint } from "../core/fingerprint.js";
import { config } from "../config.js";
import type { Opportunity, OppType } from "../core/types.js";

const ENDPOINT = "https://ag-dashboard.acquisitiongateway.gov/api/v3.0/export/forecast";
const RANGE = 500; // records per page (larger ranges time the server out)
const MAX_PAGES = 60; // safety cap; we stop earlier via the empty-streak check
const EMPTY_STREAK_STOP = 3; // stop after this many consecutive pages with no new records
const EXCLUDE_AGENCY = /treasury/i; // covered by the dedicated Treasury adapter
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Pages legitimately take ~27s each in CI, so this bounds a genuine hang without
// tripping on merely-slow responses. A timeout aborts into the retry loop below.
const REQUEST_TIMEOUT_MS = 90_000;
// Hard ceiling on the whole governmentwide pull. This source is best-effort, so
// returning partial data beats stalling the job (missing rows resurface next run).
const TIME_BUDGET_MS = 20 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getPage(page: number): Promise<unknown> {
  const url = `${ENDPOINT}?range=${RANGE}&page=${page}`;
  const headers = {
    Accept: "application/json",
    "User-Agent": config.userAgent,
    Referer: "https://acquisitiongateway.gov/",
    Origin: "https://acquisitiongateway.gov",
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res.json();
      if (RETRYABLE.has(res.status) && attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`Acquisition Gateway HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// The records sit under a nested `listing` map; each carries a `.render` object
// with the real fields. Walk the response and collect every render node.
function collect(node: any, out: any[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (node.render && typeof node.render === "object" && (node.render.title || node.render.field_source_listing_id)) {
    out.push(node.render);
    return;
  }
  for (const v of Object.values(node)) collect(v, out, depth + 1);
}

export async function fetchAcquisitionGatewayForecast(): Promise<Opportunity[]> {
  const out: Opportunity[] = [];
  const seen = new Set<string>();
  let emptyStreak = 0;
  const startedAt = Date.now();

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      console.warn(
        `Acquisition Gateway: time budget reached after ${page - 1} pages; returning ${out.length} records so far.`
      );
      break;
    }
    const recs: any[] = [];
    collect(await getPage(page), recs);

    let added = 0;
    for (const r of recs) {
      const nid = r?.nid ? String(r.nid) : null;
      if (!nid || seen.has(nid)) continue;
      seen.add(nid);
      added++;
      if (EXCLUDE_AGENCY.test((r.field_result_id || "").trim())) continue;
      out.push(normalizeGatewayRender(r));
    }
    // The API serves occasional duplicate pages (e.g. page 2 mirrors page 1),
    // so a single zero-new page is not the end — only stop after several.
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= EMPTY_STREAK_STOP) break;
  }
  return out;
}

export function normalizeGatewayRender(r: any): Opportunity {
  const naics = firstNaics(r.field_naics_code);
  return {
    source: "acquisition-gateway",
    id: String(r.nid),
    fingerprint: fingerprint(["acquisition-gateway", r.nid]),
    title: (r.title || "(untitled)").trim(),
    description: stripHtml(r.body || r.body_1),
    agency: (r.field_result_id || "Unknown").trim(),
    bureau: r.field_organization || undefined,
    oppType: requirementToType(r.field_requirement_status),
    naics,
    naicsDesc: naics ? `${naics}` : undefined,
    estValue: clean(r.field_estimated_contract_v_max),
    setAside: clean(r.field_type_of_awardee) || "None",
    placeState: clean(r.field_place_of_performance_administrative_area),
    awardQuarter: fyQuarter(r.field_estimated_award_fy, r.field_estimated_award_fy_qtr),
    solicitationDate: clean(r.field_estimated_solicitation_dat),
    incumbent: clean(r.field_contractor_name) || undefined,
    bureauPoc: clean(r.field_point_of_contact_name),
    programOfficePoc: clean(r.field_advisor_info_name),
    contractVehicle: clean(r.field_acquisition_strategy),
    phase: clean(r.field_award_status),
    active: !/no/i.test(r.status || "yes"),
    url: clean(r.field_solicitation_link) || "https://acquisitiongateway.gov/forecast",
    fitTag: "other",
    matchedTerms: [],
    watchedValue: clean(r.field_estimated_contract_v_max),
  };
}

// ---- field helpers ----

function requirementToType(status?: string): OppType {
  const s = (status || "").toLowerCase();
  if (/follow|recompete|recurring|renew|option|existing/.test(s)) return "Recompete";
  return "New";
}

function firstNaics(v?: string): string | undefined {
  const m = String(v ?? "").match(/\d{6}/);
  return m ? m[0] : undefined;
}

function fyQuarter(fy?: string, qtr?: string): string | undefined {
  const y = clean(fy);
  if (!y) return undefined;
  const q = String(qtr ?? "").match(/([1-4])(st|nd|rd|th)/);
  return `FY ${y}${q ? ` Q${q[1]}` : ""}`;
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
  if (!t || /^(not provided|tbd|n\/a|to be determined)$/i.test(t)) return undefined;
  return t;
}
