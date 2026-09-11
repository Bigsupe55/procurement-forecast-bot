// Quick live sample of Stream B, for verification: `npm run sample:predictor`.
import { fetchExpiringTreasuryContracts } from "../src/sources/usaspendingPredictor.js";
import { classify } from "../src/core/filter.js";

const opps = (await fetchExpiringTreasuryContracts()).map(classify);
console.log(`Expiring Treasury contracts in window (>= floor): ${opps.length}\n`);

const byFit: Record<string, number> = {};
for (const o of opps) byFit[o.fitTag] = (byFit[o.fitTag] ?? 0) + 1;
console.log("Fit breakdown:", byFit);

const sorted = [...opps].sort((a, b) => Date.parse(a.popEnd ?? "") - Date.parse(b.popEnd ?? ""));
console.log("\nSoonest-expiring (top 12):");
for (const o of sorted.slice(0, 12)) {
  console.log(
    `- ends ${o.popEnd} | ${o.estValue} | NAICS ${o.naics} | ${o.fitTag}\n    ${o.title}\n    incumbent: ${o.incumbent}`
  );
}
