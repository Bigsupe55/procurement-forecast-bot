// Quick live sample of Stream A, for verification: `npm run sample:treasury`.
import { fetchTreasuryForecast } from "../src/sources/treasuryForecast.js";
import { classify } from "../src/core/filter.js";

const opps = (await fetchTreasuryForecast()).map(classify);

console.log(`Fetched ${opps.length} Treasury forecast opportunities.\n`);

const byBureau: Record<string, number> = {};
for (const o of opps) byBureau[o.bureau ?? "?"] = (byBureau[o.bureau ?? "?"] ?? 0) + 1;
console.table(byBureau);

const byFit: Record<string, number> = { "direct-fit": 0, adjacent: 0, other: 0 };
for (const o of opps) byFit[o.fitTag] = (byFit[o.fitTag] ?? 0) + 1;
console.log("\nFit breakdown:", byFit);

console.log("\nSample direct-fit opportunities:");
for (const o of opps.filter((x) => x.fitTag === "direct-fit").slice(0, 8)) {
  console.log(
    `- [${o.oppType}] ${o.title}\n    ${o.bureau} | NAICS ${o.naics} | PSC ${o.psc} | ${o.estValue} | award ${o.awardQuarter}\n    matched: ${o.matchedTerms.join(", ")}`
  );
}
