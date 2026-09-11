// Live sample of Stream A3 (DHS APFS), for verification: `npm run sample:dhs`.
// Reports the fetch, the fit breakdown (how much of DHS is actually relevant),
// the top sub-orgs, and the top scored relevant items.
import { fetchDhsForecast } from "../src/sources/dhsForecast.js";
import { classify, includeInDigest } from "../src/core/filter.js";
import { scoreAndRank } from "../src/core/score.js";

const opps = (await fetchDhsForecast()).map(classify);
console.log(`Fetched ${opps.length} DHS APFS forecast opportunities.\n`);

const byFit: Record<string, number> = { "direct-fit": 0, adjacent: 0, other: 0 };
for (const o of opps) byFit[o.fitTag] = (byFit[o.fitTag] ?? 0) + 1;
console.log("Fit breakdown:", byFit);

const worthy = opps.filter(includeInDigest);
console.log(`Relevant (would enter digest): ${worthy.length}\n`);

const byOrg: Record<string, number> = {};
for (const o of worthy) byOrg[o.bureau ?? "?"] = (byOrg[o.bureau ?? "?"] ?? 0) + 1;
console.log("Relevant by DHS component:");
console.table(
  Object.fromEntries(Object.entries(byOrg).sort((a, b) => b[1] - a[1]).slice(0, 12))
);

const ranked = scoreAndRank(worthy);
console.log(`\nTop ${Math.min(10, ranked.length)} DHS opportunities by score:`);
for (const o of ranked.slice(0, 10)) {
  console.log(`  [${String(o.score).padStart(3)}] [${o.oppType}] ${o.title.slice(0, 70)}`);
  console.log(`        ${o.bureau} | NAICS ${o.naics ?? "?"} | ${o.estValue ?? "?"} | award ${o.awardQuarter ?? "?"}${o.incumbent ? ` | incumbent: ${o.incumbent}` : ""}`);
  console.log(`        why: ${(o.scoreReasons ?? []).join(" · ")}`);
}
