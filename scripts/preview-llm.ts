// Preview the LLM relevance pass WITHOUT calling the API: `npm run preview:llm`
//
// Builds the real shortlist from live forecast data and prints the exact request that
// would be sent — model, effort, cached system prompt, and the rendered item list — so
// the prompt and the capability profile can be reviewed before spending a token.
//
// This never contacts the Anthropic API. To actually run the pass, set ENABLE_LLM=1
// and ANTHROPIC_API_KEY and use `npm run dry` / `npm start`.

import { readFileSync } from "node:fs";
import { config, paths } from "../src/config.js";
import { fetchTreasuryForecast } from "../src/sources/treasuryForecast.js";
import { fetchDhsForecast } from "../src/sources/dhsForecast.js";
import { fetchExpiringTreasuryContracts } from "../src/sources/usaspendingPredictor.js";
import { classify, includeInDigest } from "../src/core/filter.js";
import { crossReference } from "../src/core/crossref.js";
import { scoreAndRank } from "../src/core/score.js";
import { renderItems } from "../src/core/llmScore.js";
import type { Opportunity } from "../src/core/types.js";

const SHOW_FULL = process.env.SHOW_FULL === "1";

const forecast = (await fetchTreasuryForecast()).map(classify);
const dhs = config.enableDhs ? (await fetchDhsForecast()).map(classify) : [];
const predicted = (await fetchExpiringTreasuryContracts()).map(classify);

const xref = crossReference(forecast.filter(includeInDigest), predicted.filter(includeInDigest));
const universe: Opportunity[] = [
  ...xref.forecast,
  ...dhs.filter(includeInDigest),
  ...xref.predicted.filter((p) => p.crossRef === "predicted-not-forecasted"),
];

const ranked = scoreAndRank(universe);
const shortlist = ranked.slice(0, config.llm.maxItems);

const profile = readFileSync(paths.profile, "utf8");
const items = renderItems(shortlist);

// Rough only: real counts need the token-counting API, which is a live call.
const est = (s: string) => Math.round(s.length / 4);

console.log("=".repeat(70));
console.log("LLM PASS PREVIEW — no API call is made by this script");
console.log("=".repeat(70));
console.log(`enabled:     ${config.enableLlm} (ENABLE_LLM)`);
console.log(`api key set: ${config.llm.apiKey ? "yes" : "no"}`);
console.log(`model:       ${config.llm.model}`);
console.log(`effort:      ${config.llm.effort}`);
console.log(`shortlist:   ${shortlist.length} of ${ranked.length} relevant (cap ${config.llm.maxItems})`);
console.log("");
console.log(`~${est(profile)} tokens  cached system prompt (profile + instructions)`);
console.log(`~${est(items)} tokens  item list (billed every run)`);
console.log("(rough estimate at ~4 chars/token; exact counts require a live API call)");

console.log("\n--- SHORTLIST THAT WOULD BE SENT ---");
for (const [i, o] of shortlist.entries()) {
  const who = o.bureau && o.bureau !== o.agency ? `${o.agency}/${o.bureau}` : o.agency;
  console.log(`${String(i + 1).padStart(3)}. [${String(o.score).padStart(3)}] ${o.title.slice(0, 68)}`);
  console.log(`      ${who} | ${o.naics ?? "?"} | ${o.estValue ?? "?"}`);
}

console.log("\n--- CAPABILITY PROFILE (cached system prompt) ---");
console.log(SHOW_FULL ? profile : profile.split("\n").slice(0, 24).join("\n") + "\n... (SHOW_FULL=1 for all)");

console.log("\n--- RENDERED ITEMS (user message) ---");
console.log(SHOW_FULL ? items : items.slice(0, 1200) + "\n... (SHOW_FULL=1 for all)");

console.log("\n" + "=".repeat(70));
console.log("Review config/profile.md before enabling — every claim in it shapes every score.");
console.log("To activate: set ENABLE_LLM=1 and ANTHROPIC_API_KEY, then `npm run dry`.");
