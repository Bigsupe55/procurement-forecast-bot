// Live sample of the governmentwide Acquisition Gateway source.
// Run: npm run sample:gateway
import { fetchAcquisitionGatewayForecast } from "../src/sources/acquisitionGatewayForecast.js";
import { classify } from "../src/core/filter.js";

const opps = (await fetchAcquisitionGatewayForecast()).map(classify);
console.log(`Fetched ${opps.length} governmentwide (non-Treasury) forecast opportunities.\n`);

const byAgency: Record<string, number> = {};
for (const o of opps) byAgency[o.agency] = (byAgency[o.agency] ?? 0) + 1;
console.log("By agency (top 15):");
Object.entries(byAgency)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([a, n]) => console.log(`  ${String(n).padStart(4)}  ${a}`));

const byFit: Record<string, number> = { "direct-fit": 0, adjacent: 0, other: 0 };
for (const o of opps) byFit[o.fitTag] = (byFit[o.fitTag] ?? 0) + 1;
console.log("\nFit breakdown:", byFit);

console.log("\nSample direct-fit opportunities:");
for (const o of opps.filter((x) => x.fitTag === "direct-fit").slice(0, 8)) {
  console.log(
    `- [${o.oppType}] ${o.title}\n    ${o.agency}${o.bureau ? ` (${o.bureau})` : ""} | NAICS ${o.naics} | ${o.estValue ?? "?"} | award ${o.awardQuarter ?? "?"} | solicitation ${o.solicitationDate ?? "?"}\n    matched: ${o.matchedTerms.join(", ")}`
  );
}
