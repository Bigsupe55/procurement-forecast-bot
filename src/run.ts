// Orchestrator: fetch both streams, cross-reference, filter, diff against
// remembered state, and email a digest of what is new or changed.
//
// Run:  npm start          (sends email; needs SMTP env)
//       npm run dry        (prints the digest instead of sending)

import { config, paths } from "./config.js";
import { fetchTreasuryForecast } from "./sources/treasuryForecast.js";
import { fetchAcquisitionGatewayForecast } from "./sources/acquisitionGatewayForecast.js";
import { fetchDhsForecast } from "./sources/dhsForecast.js";
import { fetchExpiringTreasuryContracts } from "./sources/usaspendingPredictor.js";
import { classify, includeInDigest } from "./core/filter.js";
import { crossReference } from "./core/crossref.js";
import { scoreAndRank, WORTH_ACTING_ON } from "./core/score.js";
import { llmScoreShortlist } from "./core/llmScore.js";
import { loadSeen, saveSeen, pruneSeen } from "./core/state.js";
import { diffAndUpdate } from "./core/dedup.js";
import { buildDigest, type PursuitItem } from "./core/digest.js";
import { buildSnapshot, writeSnapshot } from "./core/snapshot.js";
import { loadPursuit, dropSkipped, activePursuits } from "./core/pursuit.js";
import { sendOrPrint } from "./core/email.js";
import type { Opportunity } from "./core/types.js";

async function main(): Promise<void> {
  const nowIso = new Date().toISOString();
  console.log(`[${nowIso}] Forecast run (dryRun=${config.dryRun}, popWindow=${config.popWindowMonths}mo)`);

  // --- Stream A: Treasury published forecast (required) ---
  const forecast = (await fetchTreasuryForecast()).map(classify);
  console.log(`Stream A: ${forecast.length} distinct forecast opportunities`);

  const notes: string[] = [];

  // --- Stream A2: governmentwide forecast via Acquisition Gateway (best-effort) ---
  // Covers every agency EXCEPT Treasury (already covered by Stream A).
  let gateway: Opportunity[] = [];
  if (config.enableGateway) {
    try {
      gateway = (await fetchAcquisitionGatewayForecast()).map(classify);
      console.log(`Stream A2 (Acquisition Gateway): ${gateway.length} governmentwide forecast opportunities`);
    } catch (err) {
      const note = `gateway stream skipped: ${(err as Error).message}`;
      notes.push(note);
      console.warn(note);
    }
  }

  // --- Stream A3: DHS forecast via APFS (best-effort) ---
  // DHS is absent from the Gateway, so it needs its own adapter.
  let dhs: Opportunity[] = [];
  if (config.enableDhs) {
    try {
      dhs = (await fetchDhsForecast()).map(classify);
      console.log(`Stream A3 (DHS APFS): ${dhs.length} DHS forecast opportunities`);
    } catch (err) {
      const note = `dhs stream skipped: ${(err as Error).message}`;
      notes.push(note);
      console.warn(note);
    }
  }

  // --- Stream B: expiring-contract predictor (best-effort) ---
  let predicted: Opportunity[] = [];
  try {
    predicted = (await fetchExpiringTreasuryContracts()).map(classify);
    console.log(`Stream B: ${predicted.length} expiring Treasury contracts in window`);
  } catch (err) {
    const note = `predictor stream skipped: ${(err as Error).message}`;
    notes.push(note);
    console.warn(note);
  }

  // --- Keep only relevant items, then cross-reference the streams ---
  // The predictor is Treasury-only, so only the Treasury forecast is cross-
  // referenced against it; Gateway and DHS forecast items pass straight through.
  const forecastWorthy = forecast.filter(includeInDigest);
  const gatewayWorthy = gateway.filter(includeInDigest);
  const dhsWorthy = dhs.filter(includeInDigest);
  const predictedWorthy = predicted.filter(includeInDigest);
  const xref = crossReference(forecastWorthy, predictedWorthy);

  // Digest universe = relevant forecast items (Treasury + governmentwide + DHS)
  // plus predicted contracts NOT already in the Treasury forecast.
  const digestOpps: Opportunity[] = [
    ...xref.forecast,
    ...gatewayWorthy,
    ...dhsWorthy,
    ...xref.predicted.filter((p) => p.crossRef === "predicted-not-forecasted"),
  ];
  console.log(
    `Relevant: ${forecastWorthy.length} Treasury + ${gatewayWorthy.length} governmentwide + ` +
      `${dhsWorthy.length} DHS + ${predictedWorthy.length} predicted ` +
      `(${xref.predicted.filter((p) => p.crossRef === "predicted-not-forecasted").length} not yet forecasted)`
  );

  // --- Score + rank every relevant item (deterministic priority 0-100) so the
  // digest can lead with the few worth acting on and collapse the long tail. ---
  const scoredOpps = scoreAndRank(digestOpps);
  const priorityCount = scoredOpps.filter((o) => o.score >= WORTH_ACTING_ON).length;
  console.log(
    `Scored ${scoredOpps.length} relevant; ${priorityCount} at/above priority threshold (${WORTH_ACTING_ON}). ` +
      `Top score: ${scoredOpps[0]?.score ?? 0}`
  );

  // --- Snapshot for the local dashboard ---
  // Written here, before the early return below, so a week with nothing new
  // still leaves the dashboard with fresh data. Derived and gitignored.
  writeSnapshot(paths.snapshot, buildSnapshot(scoredOpps, { worthActingOn: WORTH_ACTING_ON, notes }));
  console.log(`Snapshot: ${scoredOpps.length} scored items -> ${paths.snapshot}`);

  // --- Diff against persistent state (scores ride along on new/changed items) ---
  const seen = loadSeen(paths.seen);
  const { newOpps: rawNew, changedOpps: rawChanged, isBaseline } = diffAndUpdate(scoredOpps, seen, nowIso);
  const pruned = pruneSeen(seen, config.pruneAfterDays);

  // --- Apply triage decisions made in the local dashboard ---
  // Skipped items are recorded as seen above (so they never re-alert) but are
  // dropped here so they stop reaching the email. Items marked pursue/watch
  // become a standing worklist rendered at the top of the digest.
  const pursuit = loadPursuit(paths.pursuit);
  const keptNew = dropSkipped(rawNew, pursuit, (o) => o.fingerprint);
  const keptChanged = dropSkipped(rawChanged, pursuit, (c) => c.opp.fingerprint);
  const newOpps = keptNew.kept;
  const changedOpps = keptChanged.kept;
  const suppressed = keptNew.suppressed + keptChanged.suppressed;

  const pursuits: PursuitItem[] = activePursuits(scoredOpps, pursuit, (o) => o.fingerprint).map(
    ({ item, state, note }) => ({ opp: item, state, note })
  );

  console.log(
    `New: ${newOpps.length}, Changed: ${changedOpps.length}, Baseline: ${isBaseline}, ` +
      `Pruned: ${pruned}, NowTracking: ${Object.keys(seen).length}` +
      (suppressed > 0 ? `, Suppressed by triage: ${suppressed}` : "") +
      (pursuits.length > 0 ? `, Active pursuits: ${pursuits.length}` : "")
  );

  // Persist state (skip in dry runs so previews stay idempotent).
  if (config.dryRun) console.log("(dry run: state not saved)");
  else saveSeen(paths.seen, seen);

  // --- Decide + send ---
  if (!isBaseline && newOpps.length === 0 && changedOpps.length === 0) {
    console.log("Nothing new or changed — no email.");
    return;
  }

  // --- Optional LLM judgment pass over the strongest of what we're about to send ---
  // Runs AFTER the diff so we only ever pay for items that actually reach the email,
  // and best-effort so a failure degrades to deterministic scoring rather than
  // losing the digest. Disabled by default (ENABLE_LLM=1 to turn on).
  const llm = await llmScoreShortlist([...newOpps, ...changedOpps.map((c) => c.opp)]);
  if (llm.attempted > 0) {
    const cost = llm.usage
      ? ` (in ${llm.usage.inputTokens}, out ${llm.usage.outputTokens}, cached ${llm.usage.cacheReadTokens})`
      : "";
    console.log(`LLM pass: ${llm.scored}/${llm.attempted} assessed${cost}`);
  } else if (llm.note) {
    console.log(`LLM pass: ${llm.note}`);
  }
  if (llm.note && llm.attempted > 0) notes.push(llm.note);
  const mail = buildDigest({
    newOpps,
    changedOpps,
    isBaseline,
    totalTracked: Object.keys(seen).length,
    streamBNote: notes.length ? notes.join("; ") : undefined,
    pursuits,
  });
  await sendOrPrint(mail);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
