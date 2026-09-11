// Stream B: predict upcoming Treasury procurements from expiring contracts.
//
// USASpending.gov's award-search API is public and keyless. We pull Treasury
// contract awards in the target NAICS whose period of performance
// (the "End Date" field) falls within a forward window — an expiring relevant
// contract is a likely upcoming recompete, often before it hits any forecast.
// Field names + shape verified live 2026-07-22.

import { readFileSync } from "node:fs";
import { fingerprint } from "../core/fingerprint.js";
import { config, paths } from "../config.js";
import type { Opportunity } from "../core/types.js";

const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const MAX_PAGES = 20; // safety cap (2000 awards) for the weekly job

interface Codes {
  naics: { direct: string[]; adjacent: string[] };
}
const codes: Codes = JSON.parse(readFileSync(paths.codes, "utf8"));
// Predictor focuses on CORE (direct) NAICS only. The adjacent codes (e.g. 541519
// "other computer related", 541611 consulting) pull in hardware refreshes,
// license renewals, and generic consulting that are not real
// displacement targets. The human-curated forecast stream keeps the wider net.
const NAICS = [...new Set(codes.naics.direct)];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function fetchExpiringTreasuryContracts(
  windowMonths: number = config.popWindowMonths,
  now: Date = new Date(),
  minUsd: number = config.predictMinUsd
): Promise<Opportunity[]> {
  const todayStart = Date.parse(iso(now) + "T00:00:00Z");
  const horizon = new Date(now);
  horizon.setMonth(horizon.getMonth() + windowMonths);
  const horizonT = horizon.getTime();
  const actionStart = new Date(now);
  actionStart.setFullYear(actionStart.getFullYear() - 5); // active contracts have recent action dates

  const out: Opportunity[] = [];
  let done = false;

  for (let page = 1; page <= MAX_PAGES && !done; page++) {
    const body = {
      filters: {
        award_type_codes: ["A", "B", "C", "D"], // contracts
        agencies: [{ type: "awarding", tier: "toptier", name: "Department of the Treasury" }],
        naics_codes: NAICS,
        award_amounts: [{ lower_bound: minUsd }],
        time_period: [{ start_date: iso(actionStart), end_date: iso(now) }],
      },
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Start Date",
        "End Date",
        "Awarding Sub Agency",
        "NAICS",
        "Description",
      ],
      page,
      limit: 100,
      sort: "End Date",
      order: "desc", // furthest-future first; page down and stop at the first expired
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`USASpending HTTP ${res.status} ${res.statusText}`);
    const json: any = await res.json();
    const rows: any[] = json?.results ?? [];

    for (const r of rows) {
      const endT = Date.parse(r["End Date"]);
      if (!Number.isFinite(endT)) continue;
      if (endT > horizonT) continue; // ends beyond the window — keep paging down toward it
      if (endT < todayStart) {
        done = true; // sorted descending — everything past here is already expired
        break;
      }
      out.push(normalize(r));
    }
    if (!json?.page_metadata?.hasNext) break;
  }

  return out;
}

function normalize(r: any): Opportunity {
  const gid = r?.generated_internal_id ?? r?.internal_id ?? r?.["Award ID"];
  const naicsCode: string | undefined = r?.NAICS?.code;
  const naicsDesc = r?.NAICS ? `${r.NAICS.code}-${r.NAICS.description}` : undefined;
  const desc = String(r?.["Description"] ?? "");
  const title = desc ? desc.slice(0, 100) : `${r?.["Recipient Name"] ?? "Contract"} — ${r?.["Award ID"] ?? gid}`;

  return {
    source: "usaspending-predict",
    id: String(gid),
    fingerprint: fingerprint(["usaspending-predict", gid]),
    title,
    description: desc,
    agency: "Treasury",
    bureau: r?.["Awarding Sub Agency"],
    oppType: "Predicted",
    naics: naicsCode,
    naicsDesc,
    estValue: formatUsd(r?.["Award Amount"]),
    popStart: r?.["Start Date"],
    popEnd: r?.["End Date"],
    incumbent: r?.["Recipient Name"],
    url: `https://www.usaspending.gov/award/${encodeURIComponent(String(gid))}`,
    fitTag: "other",
    matchedTerms: [],
    watchedValue: r?.["End Date"], // watch the expiration date (extensions shift it)
  };
}

function formatUsd(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return "$" + Math.round(n).toLocaleString("en-US");
}
