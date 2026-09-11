// Static export: one self-contained HTML file you can send to someone.
//
//   npm run dashboard:export                 -> dashboard-export/forecast-triage-<date>.html
//   npm run dashboard:export -- --out x.html -> a path you choose
//
// WHY THIS EXISTS instead of sharing the running server: `POST /api/pursuit`
// has no authentication, which is only safe because the server binds
// 127.0.0.1. Tunnelling it (ngrok, Cloudflare, port forwarding) would put an
// unauthenticated write endpoint on the public internet, and those writes feed
// the weekly digest. So sharing means exporting, never exposing.
//
// The export inlines the tokens, the page script and the data into a single
// file, and sets window.__STATIC__, which puts app.js into read-only mode:
// no triage buttons, no note saving, no fetch. Filtering, searching and row
// expansion still work, because they are all client side anyway.
//
// The page is reused verbatim rather than reimplemented, so there is exactly
// one dashboard UI to maintain.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { ROOT, paths } from "../src/config.js";
import { readSnapshot } from "../src/core/snapshot.js";
import { assessEligibility, COMPANY_STATUS, summarizeEligibility } from "../src/core/eligibility.js";
import { loadPursuit, countByState } from "../src/core/pursuit.js";

function outPath(): string {
  const flag = process.argv.indexOf("--out");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.cwd(), process.argv[flag + 1]!);
  const day = new Date().toISOString().slice(0, 10);
  return join(ROOT, "dashboard-export", `forecast-triage-${day}.html`);
}

const snapshot = readSnapshot(paths.snapshot);
if (!snapshot) {
  console.error("No snapshot found. Run `npm run dry` first, then export.");
  process.exit(1);
}

const pursuit = loadPursuit(paths.pursuit);

// Same shape the server's /api/data returns, so app.js cannot tell the difference.
const payload = {
  ready: true,
  meta: snapshot.meta,
  companyStatus: COMPANY_STATUS,
  eligibilitySummary: summarizeEligibility(snapshot.opportunities.map((o) => o.setAside)),
  pursuitCounts: countByState(pursuit),
  opportunities: snapshot.opportunities.map((o) => ({
    fingerprint: o.fingerprint,
    title: o.title,
    description: o.description,
    agency: o.agency,
    bureau: o.bureau,
    source: o.source,
    oppType: o.oppType,
    naics: o.naics,
    naicsDesc: o.naicsDesc,
    estValue: o.estValue,
    setAside: o.setAside,
    awardQuarter: o.awardQuarter,
    solicitationDate: o.solicitationDate,
    popEnd: o.popEnd,
    incumbent: o.incumbent,
    bureauPoc: o.bureauPoc,
    placeState: o.placeState,
    phase: o.phase,
    url: o.url,
    fitTag: o.fitTag,
    crossRef: o.crossRef,
    score: o.score,
    scoreReasons: o.scoreReasons,
    eligibility: assessEligibility(o.setAside),
    pursuit: pursuit[o.fingerprint] ?? null,
  })),
};

const html = readFileSync(join(paths.dashboard, "index.html"), "utf8");
const css = readFileSync(join(paths.dashboard, "brand-tokens.css"), "utf8");
const js = readFileSync(join(paths.dashboard, "app.js"), "utf8");

// `</script>` inside JSON would close the tag early and break the page; the
// unicode escape is still valid JSON and renders identically.
const dataLiteral = JSON.stringify(payload).replace(/<\/script/gi, "<\\/script");

const out = html
  .replace('<link rel="stylesheet" href="/brand-tokens.css">', `<style>\n${css}\n</style>`)
  .replace(
    '<script src="/app.js"></script>',
    `<script>window.__STATIC__ = ${dataLiteral};</script>\n<script>\n${js}\n</script>`
  );

if (out.includes('href="/brand-tokens.css"') || out.includes('src="/app.js"')) {
  console.error("Export failed: could not inline the stylesheet or script. Did index.html change?");
  process.exit(1);
}

const target = outPath();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out, "utf8");

const mb = (Buffer.byteLength(out, "utf8") / 1048576).toFixed(2);
console.log(`\n  Wrote ${target}`);
console.log(`  ${payload.opportunities.length} opportunities, ${mb} MB, self-contained and read-only.`);
console.log(`  Data is from the run at ${snapshot.meta.generatedAt}.`);
console.log(`  Safe to email or drop in Drive: no server, no write path, no external requests.\n`);
