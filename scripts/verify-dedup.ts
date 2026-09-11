// Integration check: run the diff against LIVE Treasury data twice using a temp
// state file. Run 1 is the baseline (N new); run 2, after persisting + reloading
// state, must report 0 new and 0 changed. Run: npm run verify:dedup
import { fetchTreasuryForecast } from "../src/sources/treasuryForecast.js";
import { classify, includeInDigest } from "../src/core/filter.js";
import { diffAndUpdate } from "../src/core/dedup.js";
import { loadSeen, saveSeen } from "../src/core/state.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const tmp = join(tmpdir(), `cc-seen-${Date.now()}.json`);
const opps = (await fetchTreasuryForecast()).map(classify).filter(includeInDigest);
console.log(`Relevant opportunities: ${opps.length}`);

// Run 1 — should be a baseline where everything is new.
let seen = loadSeen(tmp);
const r1 = diffAndUpdate(opps, seen);
saveSeen(tmp, seen);
console.log(`Run 1: baseline=${r1.isBaseline} new=${r1.newOpps.length} changed=${r1.changedOpps.length}`);

// Run 2 — reload the persisted state, same data: must be stable.
seen = loadSeen(tmp);
const r2 = diffAndUpdate(opps, seen);
console.log(`Run 2: baseline=${r2.isBaseline} new=${r2.newOpps.length} changed=${r2.changedOpps.length}`);

rmSync(tmp, { force: true });
const pass = !r2.isBaseline && r2.newOpps.length === 0 && r2.changedOpps.length === 0;
console.log(pass ? "PASS: second run is stable (no re-alerts)" : "FAIL: second run was not stable");
process.exit(pass ? 0 : 1);
