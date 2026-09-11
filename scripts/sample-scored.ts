// Live end-to-end sample of the SCORER, for verification and tuning:
//   npm run sample:scored              (Treasury + predictor; fast)
//   ENABLE_GATEWAY=1 npm run sample:scored   (adds the ~11min governmentwide pull)
//
// Fetches the relevant streams, classifies, cross-references, and prints the
// ranked digest universe with each item's score and the reasons behind it, plus
// a score-band histogram — the same math the weekly email uses, without touching
// state or sending anything.

import { config } from "../src/config.js";
import { fetchTreasuryForecast } from "../src/sources/treasuryForecast.js";
import { fetchAcquisitionGatewayForecast } from "../src/sources/acquisitionGatewayForecast.js";
import { fetchExpiringTreasuryContracts } from "../src/sources/usaspendingPredictor.js";
import { classify, includeInDigest } from "../src/core/filter.js";
import { crossReference } from "../src/core/crossref.js";
import { scoreAndRank, WORTH_ACTING_ON } from "../src/core/score.js";
import { buildDigest } from "../src/core/digest.js";
import type { Opportunity } from "../src/core/types.js";

// Gateway defaults OFF here so the sample is fast; opt in with ENABLE_GATEWAY=1.
const includeGateway = process.env.ENABLE_GATEWAY === "1";

const forecast = (await fetchTreasuryForecast()).map(classify);
console.log(`Stream A (Treasury): ${forecast.length} distinct`);

let gateway: Opportunity[] = [];
if (includeGateway) {
  gateway = (await fetchAcquisitionGatewayForecast()).map(classify);
  console.log(`Stream A2 (Gateway): ${gateway.length} governmentwide`);
} else {
  console.log("Stream A2 (Gateway): skipped (set ENABLE_GATEWAY=1 to include)");
}

const predicted = (await fetchExpiringTreasuryContracts()).map(classify);
console.log(`Stream B (predictor): ${predicted.length} expiring in window`);

const forecastWorthy = forecast.filter(includeInDigest);
const gatewayWorthy = gateway.filter(includeInDigest);
const predictedWorthy = predicted.filter(includeInDigest);
const xref = crossReference(forecastWorthy, predictedWorthy);

const universe: Opportunity[] = [
  ...xref.forecast,
  ...gatewayWorthy,
  ...xref.predicted.filter((p) => p.crossRef === "predicted-not-forecasted"),
];

const ranked = scoreAndRank(universe);
console.log(`\nDigest universe: ${ranked.length} relevant opportunities scored.\n`);

// Score-band histogram.
const bands: Record<string, number> = { "80-100": 0, [`${WORTH_ACTING_ON}-79`]: 0, "40-54": 0, "1-39": 0, "0 (dead)": 0 };
for (const o of ranked) {
  const s = o.score ?? 0;
  if (s >= 80) bands["80-100"]!++;
  else if (s >= WORTH_ACTING_ON) bands[`${WORTH_ACTING_ON}-79`]!++;
  else if (s >= 40) bands["40-54"]!++;
  else if (s >= 1) bands["1-39"]!++;
  else bands["0 (dead)"]!++;
}
console.log("Score bands:", bands);
const priority = ranked.filter((o) => (o.score ?? 0) >= WORTH_ACTING_ON);
console.log(`Priority (>= ${WORTH_ACTING_ON}): ${priority.length}\n`);

console.log(`Top ${Math.min(15, ranked.length)} by score:`);
for (const o of ranked.slice(0, 15)) {
  const who = o.bureau && o.bureau !== o.agency ? `${o.agency}/${o.bureau}` : o.agency;
  console.log(`  [${String(o.score).padStart(3)}] [${o.oppType}] ${o.title.slice(0, 78)}`);
  console.log(`        ${who} | NAICS ${o.naics ?? "?"} | ${o.estValue ?? "?"} | ${o.awardQuarter ?? o.popEnd ?? "?"}`);
  console.log(`        why: ${(o.scoreReasons ?? []).join(" · ")}`);
}

console.log(`\nBottom 5 (lowest non-zero) — sanity check the tail:`);
for (const o of ranked.filter((x) => (x.score ?? 0) > 0).slice(-5)) {
  console.log(`  [${String(o.score).padStart(3)}] ${o.title.slice(0, 70)} — why: ${(o.scoreReasons ?? []).join(" · ")}`);
}

// SHOW_DIGEST=1 renders the actual email text from this live data (treating the
// universe as "new"), to eyeball the priority / also-new / overflow layout.
if (process.env.SHOW_DIGEST === "1") {
  const mail = buildDigest({
    newOpps: ranked,
    changedOpps: [],
    isBaseline: false,
    totalTracked: ranked.length,
  });
  console.log("\n\n========== DIGEST PREVIEW (text) ==========\n");
  console.log(`SUBJECT: ${mail.subject}\n`);
  console.log(mail.text);
}
