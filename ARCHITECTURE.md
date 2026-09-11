# Architecture and maintainer notes

This is the maintainer doc. For "how do I run it," see [README.md](README.md). This
file covers what it is, why it is built the way it is, how it was verified, how to
operate and troubleshoot it, and how to extend it.

The most valuable part is **section 4**, the reverse-engineered data sources. Three of
the four endpoints are undocumented and were found by reading network traffic off the
agencies' own front ends. Section 10 records the sources that were investigated and
**rejected**, so nobody repeats that research.

---
## 1. What it does and why

The bot finds **planned** U.S. federal procurement, before any RFP is published, that fits a specific small vendor, and emails a weekly ranked digest so you can engage early: capability statement, RFI, or contacting the bureau's small-business specialist while requirements are still being shaped.

**Why forecasts, not published bids:** the first design scraped already-published solicitations. That is backwards. By the time an RFP is public, the requirement is frozen and often wired to an incumbent. Forecasts and expiring-contract signals are months earlier.

**Scope:** federal, all agencies reachable via a public cold API — Treasury (dedicated adapter), ~8 agencies via the GSA Acquisition Gateway, and DHS (dedicated adapter). Alert-only, no automated outreach. Each item carries a 0-100 priority score so the digest leads with the few worth acting on.

---

## 2. Deployment shape

- **Runs on GitHub Actions cron**, weekly, plus manual `workflow_dispatch`. Free tier.
- **State lives in the repo.** The job commits `data/seen.json` back to the default
  branch after each run, so dedup survives between runs with no database. The tradeoff
  is that **you must pull before local work**, because the bot pushes commits of its
  own. This bites regularly.
- **Secrets** (SMTP host/port/user/pass, recipient) come from repo secrets. The
  optional LLM pass needs `ANTHROPIC_API_KEY`, which is not required otherwise.
- **Baselining.** The first run records a baseline silently rather than emailing
  hundreds of items. When a new source is added later, you either reset the baseline or
  let its items flow as one larger-than-usual capped digest. See section 6.

**Representative scale, from one live run.** These drift as agencies update their data,
and they are the reason the scoring layer exists at all:

- Stream A (Treasury): 404 raw, 202 distinct, **151 relevant**.
- Stream A2 (Gateway): **7,171 fetched, 1,257 relevant**, across ~8 participating agencies.
- Stream A3 (DHS APFS): **783 fetched, 246 relevant**, across the IT shops (USCIS, CISA, TSA, Coast Guard C5I, ICE, CBP/OIT).
- Stream B (predictor): **303** expiring contracts (>= $250K) in the 18-month window.
- **1,955 relevant scored; 385 at/above the priority threshold (70); top score 91.**

Roughly 2,000 items clear a NAICS/keyword filter. Fewer than 400 are worth a human
minute. That gap is the whole problem this repo solves.

---
## 3. Architecture

Four data streams, combined and de-duplicated, scored, then emailed.

```
Stream A  (Treasury forecast)      ─┐
Stream A2 (governmentwide Gateway) ─┤
Stream A3 (DHS APFS forecast)      ─┼─► classify ─► crossReference ─► score ─► dedup vs seen.json ─► digest ─► email
Stream B  (expiring contracts)     ─┘
```

Node + TypeScript, run with `tsx` (no build step). Native `fetch` for every API (no HTTP library). `nodemailer` for email. `vitest` for tests. Stream A is required (fatal on error); A2, A3, and B are best-effort (caught, noted in the email) so one source's outage never breaks the run.

### File map

| Path | Role |
| --- | --- |
| `src/run.ts` | Orchestrator. Stream A required (fatal); A2/A3/B best-effort (caught). |
| `src/sources/treasuryForecast.ts` | Stream A adapter (Treasury forecast). |
| `src/sources/acquisitionGatewayForecast.ts` | Stream A2 adapter (governmentwide forecast, all non-Treasury agencies). |
| `src/sources/dhsForecast.ts` | Stream A3 adapter (DHS APFS forecast). |
| `src/sources/usaspendingPredictor.ts` | Stream B adapter (expiring-contract predictor). |
| `src/core/filter.ts` | NAICS/PSC + keyword tagging (direct-fit / adjacent / other). |
| `src/core/crossref.ts` | Joins predicted to forecast (confirmed vs predicted-not-forecasted). |
| `src/core/score.ts` | Deterministic 0-100 priority score + reasons (see section 5). |
| `src/core/llmScore.ts` | Optional LLM judgment pass over the shortlist. OFF unless `ENABLE_LLM=1` (section 10). |
| `config/profile.md` | Capability profile the LLM judges against. **Ships as a fictional sample**: replace it with your own (section 10). |
| `src/core/eligibility.ts` | Can-we-bid rules. Reads SAM/certification facts from `config/company.json` (section 11). |
| `src/core/pursuit.ts` | Triage state plus the two functions that close the digest loop: `dropSkipped`, `activePursuits`. |
| `src/core/snapshot.ts` | Writes `data/snapshot.json` for the dashboard. Derived, gitignored. |
| `scripts/dashboard.ts` | Local-only dashboard server, 127.0.0.1 by design. |
| `dashboard/` | The page itself, styled from a verified mirror of the brand tokens. |
| `src/core/dedup.ts` | New + changed detection against state. |
| `src/core/state.ts` | Load/save/prune `data/seen.json`. |
| `src/core/digest.ts` | Renders the email (baseline-aware, HTML + text). |
| `src/core/email.ts` | SMTP send, or print when `DRY_RUN=1`. |
| `src/core/fingerprint.ts` | Stable dedup hash (ported from TLaaS indexer). |
| `src/config.ts` | Env + tunables; loads `.env` locally. |
| `config/codes.json`, `config/keywords.json` | The relevance targeting. Edit these to retarget. |
| `data/seen.json` | Committed dedup state. Do NOT gitignore it. |
| `.github/workflows/monitor.yml` | The cron + run + commit-state workflow. |
| `scripts/*.ts` | Verification/sample utilities (see section 6). |
| `test/*.test.ts` | Unit tests. |

---

## 4. Data sources (the important tribal knowledge)

### Stream A: Treasury OSDBU forecast

`osdbu.forecast.treasury.gov` is a public Salesforce site. Its "Download Opportunity Data" button is a client-side handler that calls ONE guest Apex method, `getData`, which returns every opportunity grouped by bureau. This was found by intercepting the button's network call.

```
POST https://osdbu.forecast.treasury.gov/webruntime/api/apex/execute?language=en-US&asGuest=true&htmlEncode=false
Content-Type: application/json

{"namespace":"","classname":"@udd/01pSJ000000H5BV","method":"getData","isContinuation":false,
 "params":{ ...ten *Filter arrays, all empty = everything... },"cacheable":false}
```

Key facts:
- Works **cold from plain Node** — no cookies, no browser, no auth. Verified.
- `returnValue` is an **array of 7 bureau containers**. Each has up to 5 record arrays: `newOppData`, `recompeteOppData`, `micropurchaseAwardData`, `simplifiedAcquisitionAwardData`, `above250kData`.
- A single opportunity appears under multiple arrays (e.g. Recompete AND Above250k). We **dedup by record `Id`**, keeping the first occurrence so New/Recompete wins over the dollar bands.
- NAICS/PSC come as Salesforce id references, but the human codes are embedded in the `__r` sub-objects (`sbfNAICSCode__r.SBF_NAICS_Description__c` = `"541519-Other Computer Related Services"`). Parse the prefix before the dash.
- `sbfIncumbentVendorName__c` is an **unresolved id** in this payload, so we surface the named POCs (`sbfBureauPointofContact__c`, `sbfProgramOfficePointofContact__c`) instead — more actionable anyway.
- If the classname `@udd/01pSJ000000H5BV` ever changes (site redeploy), re-capture it: open the site, intercept the fetch to `/apex/execute` fired by the download button.

### Stream A2: Acquisition Gateway (governmentwide, all non-Treasury agencies)

GSA's public Forecast Tool (`acquisitiongateway.gov/forecast`) aggregates many agencies' forecasts. Its "Export CSV" button pages a public, no-auth JSON API (found by intercepting that button):

```
GET https://ag-dashboard.acquisitiongateway.gov/api/v3.0/export/forecast?range=500&page=N
```

Key facts and gotchas (verified 2026-07-23):
- Public, no auth. Works cold from Node with `Referer`/`Origin: https://acquisitiongateway.gov` headers.
- Records live under a nested `listing` map; each has a `.render` object with the real fields: `title`, `body` (HTML), `field_result_id` (agency), `field_organization` (sub-org), `field_naics_code`, `field_estimated_contract_v_max` (value band), `field_estimated_award_fy` + `_qtr`, `field_estimated_solicitation_dat`, `field_requirement_status` (New/Recompete), `field_point_of_contact_name`/`_email`, `field_contractor_name` (incumbent), `field_solicitation_link`. No PSC.
- `range` max is ~500 (1000+ returns HTTP 504). Paginate with `page`.
- **Pager quirk:** some pages duplicate the previous one (page 2 mirrored page 1, but page 3 was all-new). So we dedup by `nid` and stop only after `EMPTY_STREAK_STOP` (3) consecutive pages with no new records, not on the first.
- Server is slow and occasionally 504s; the adapter retries transient 5xx/429 with backoff. A full governmentwide pull is a few MB per page and can take a couple of minutes.
- **Treasury is excluded** (`EXCLUDE_AGENCY = /treasury/i`) since it has its own richer adapter (Stream A).
- Parser is unit-tested via the exported `normalizeGatewayRender` (`test/gateway.test.ts`).
- **Coverage is ~8 participating agencies, not all of government:** USDA, Interior (heavy), Veterans Affairs, GSA, Transportation, Labor, NSF, NRC. DoD / DHS / HHS run their own forecast systems and are NOT here (each would need its own adapter). Coverage grows on its own as more agencies adopt the Gateway.
- **Performance + hardening:** a full pull is ~25 real pages and took **~11.5 minutes** in CI. Guarded by a 90s per-request timeout (`REQUEST_TIMEOUT_MS`, which aborts into the retry loop) and a 20-minute overall ceiling (`TIME_BUDGET_MS`), after which it returns partial data instead of stalling the job. Anything missed simply resurfaces on the next run. The 90s value is deliberate: pages legitimately average ~27s, so a shorter timeout would cause false failures.
- Possible optimization: filter server-side by NAICS taxonomy id. The response's `filters.field_naics_code_target_id.options` maps NAICS code to `tid`, which could cut the pull from ~7,000 records to only the relevant ones.
- If it ever breaks: re-capture the endpoint by intercepting the site's "Export CSV" button, or check the bundle for `api/v3.0/export`.

### Stream A3: DHS APFS forecast (DHS-only; absent from the Gateway)

DHS runs its own forecast (the Acquisition Planning Forecast System) and does NOT publish into the GSA Gateway, so it needs a dedicated adapter. The forecast site loads all data from one public, no-auth JSON endpoint:

```
GET https://apfs-cloud.dhs.gov/api/forecast
```

Key facts and gotchas (verified 2026-07-29):
- Public, no auth, no referer/cookie needed. Works cold from plain Node.
- Returns a **single ~2MB JSON array of ~780 records — the entire forecast, no pagination.** One GET, done.
- Per-record public page: `https://apfs-cloud.dhs.gov/record/{id}/public-print/` (used as the item URL).
- Field shapes the parser handles (`normalizeDhsRecord`, unit-tested in `test/dhs.test.ts`):
  - `dollar_range` is an **object** `{display_name:"$5M to $10M", display_order}` — read `.display_name`.
  - `naics` is a **string** `"236220 - Commercial and Institutional Building Construction"` — take the 6-digit prefix. **No PSC field.**
  - `award_quarter` is **quarter-first `"Q4 2026"`** (NOT Treasury's `"FY 2025 Q4"`). The adapter rewrites it to the canonical `"FY 2026 Q4"` so the scorer's timing parser and dedup change-detection understand it. This is the easiest thing to get wrong.
  - `contract_status`: `NEW` → New, `REC` → Recompete, **`NLR` (No Longer Required) → flagged `active:false`** so classify() drops it and the scorer floors it.
  - `small_business_program` (`SB`, `8(a)`, `HUBZone`, `WOSB`, `SDVOSB`, `None`, `TBD`) → `setAside` (None/TBD treated as None).
  - Incumbent in `contractor` (present on ~1/3 of records); POCs in `requirements_contact_*` and `sbs_coordinator_*`.
- **Coverage/fit:** DHS APFS is facilities-heavy (Coast Guard shore, CBP construction — NAICS 236220/336611). Of ~780 records, **~244 are relevant** after classify, concentrated in the IT shops: USCIS, CISA, TSA, Coast Guard C5I, ICE, CBP/OIT. The rest (construction/ships) classify as "other" and drop.
- **Duplicate-looking records:** APFS sometimes lists several records with an identical title/org/value under distinct `id`s (e.g. three "Agile C5ISC …" at once). They have distinct APFS numbers and record pages, so we keep them (dedup is by `id`, consistent with the other sources). If they clutter the digest, a content-hash dedup for this source is the fix — but beware collapsing genuinely distinct task orders.
- Best-effort like the Gateway; disable with `ENABLE_DHS=0`. If it ever breaks, re-capture by watching the forecast site's data load, or check its bundle for `/api/forecast`.

### Stream B: USASpending expiring-contract predictor

```
POST https://api.usaspending.gov/api/v2/search/spending_by_award/
```
- Public, keyless. Filters: award types `A,B,C,D`; awarding toptier "Department of the Treasury"; `naics_codes` = **direct only**; `award_amounts` lower_bound (default $250K); `time_period` on action_date, last 5 years (bounds result size).
- We sort by `End Date` DESC and keep rows whose End Date falls in `[today, today + POP_WINDOW_MONTHS]`, stopping at the first expired row. An expiring contract is a likely upcoming recompete.
- Fields returned: `Award ID`, `Recipient Name` (the incumbent), `Award Amount`, `Start Date`, `End Date` (= PoP current end), `Awarding Sub Agency`, `NAICS` (object `{code, description}`), `Description`.
- Predictor uses **direct NAICS only** on purpose: adjacent codes (541519, 541611) pull in hardware refreshes, license renewals, and generic consulting that are not displacement targets.

---

## 5. Key decisions and rationale

| Decision | Why |
| --- | --- |
| Forecasts, not published bids | Catch requirements before they freeze. |
| Both streams (monitor + predict) | Published forecast is curated but incomplete; expiring contracts catch what is not yet forecasted. |
| Treasury only (v1) | Nail one agency fully before adding adapters. |
| Bid protests NOT built (2026-07-29) | The only early + filterable source (GAO's open docket) is robots-disallowed. See section 10. |
| Predictor floor $250K + direct NAICS | Focus on real recompetes, cut renewal/hardware noise (1648 → ~307). |
| Dedup by record Id (Stream A) | Same opp is listed under multiple bands. |
| Baseline-silent first run | First run tracks everything; sends a summary, not a 456-item email. Afterwards, only new/changed. |
| State committed to repo | GitHub Actions is stateless; committing `seen.json` is the simplest durable memory. |
| Weekly cron | Forecasts and contract end-dates move slowly. |
| Gateway added for non-Treasury agencies (Phase 2) | One public source covers ~8 agencies at once. Treasury keeps its richer dedicated adapter, and excluding it from the Gateway prevents double-counting the same opportunity from two sources. |
| Gateway is best-effort | A Gateway outage, timeout, or schema change must not break the Treasury + predictor run. |
| Reset `seen.json` when Phase 2 shipped | The Gateway added ~1,257 relevant items at once; re-baselining sent one short summary instead of a 1,712-item email. |
| DHS gets its own adapter (2026-07-29) | DHS is absent from the Gateway and publishes its whole forecast through one cold GET. Cheapest coverage win available. |
| DoD / HHS adapters NOT built | Neither has a usable public cold API (DoD: none exists; HHS: auth + MFA). See section 10. |
| Deterministic scoring first, LLM second (2026-07-29) | Rules are free, fast, fully unit-testable, and every point traces to something the digest can explain — so they do the bulk filtering. But rules cannot tell fit from resemblance, so an LLM pass sits on top of the shortlist rather than replacing them. Built the same day, deliberately left switched off. |
| LLM pass ships inactive | Plumb it now, activate later. It also means the capability profile it judges against gets reviewed before it can influence a single score. |
| Scoring weights favor discriminators over fit | The federal IT/financial-systems forecast is *almost entirely* direct-fit, so fit cannot rank. Dollars, warmth (incumbent/recompete/confirmed), and timing produce the actual spread. |
| Digest caps rendered priorities at 20 | Even a good threshold can leave hundreds above it in a dense week. A hard cap guarantees the email stays scannable; the overflow is counted and collapsed, never dropped. |

### Relevance scoring (`src/core/score.ts`)

`classify()` decides **if** an opportunity is relevant. `score()` decides **how much it is worth acting on this week**, so a large relevant set can be ranked down to a few leads.

Score is 0-100. Weight ceilings, highest first:

| Signal | Max | Rationale |
| --- | --- | --- |
| Dollar size | 25 | Top discriminator for where limited BD time goes. Parses all three source formats (exact `$1,234,567`, Treasury bands `"> $2M to < or = $5M"`, Gateway/DHS bands `"$1M - $1.9M"` / `"$5M to $10M"`). |
| Fit tier | 20 | direct-fit vs adjacent. A **gate**, deliberately not the ranker. |
| Recompete / cross-reference | 15 | Confirmed by both streams > predicted-not-forecasted > recompete > new. +3 if an incumbent is named (someone to displace). |
| Code precision | 12 | Exact NAICS/PSC match is higher-confidence than a substring keyword hit. |
| Timing | 12 | Award window imminent (<=9mo) or contract expiring (<6mo). Past-due-but-still-listed scores low but non-zero ("slipping"). |
| Acquisition phase | 8 | Early (market research / planning) = still shapeable. Late (solicitation / evaluation) = frozen, scores 0. |
| Keyword density | 8 | Multiple distinct direct terms. |
| Set-aside | 3 | Mild, and surfaced so a human can judge it against the certifications actually held. |
| Exclude penalty | -20 | Physical/field-service terms that rode in on a direct code. `classify()` only demotes *adjacent* matches on an exclude hit, so this catches the rest. |

**Dead items floor to 0** (`active:false`, or phase matching `cancel|closed|awarded`). This deliberately catches what `classify()`'s exact `=== "canceled"` check misses — the Gateway's `"Cancelled"` (double-L) and `"Awarded"`, and DHS's `NLR`.

`WORTH_ACTING_ON = 70` is the priority threshold; reaching it requires the direct-fit + core-code gate (32) **plus** real money and/or warmth. Each item carries up to 4 short `scoreReasons` strings, which the digest prints as `why:` so a ranking is never a black box.

**Tuning:** run `npm run sample:scored` (add `SHOW_DIGEST=1` to render the actual email) and check the score-band histogram and the top/bottom lists. On live data the tail correctly bottoms out at software license renewals (Infoblox, IntelliJ, Kofax) while $50M-$145M IRS enterprise systems with named incumbents top the list.

---

## 6. Operating it

### Runs automatically
Mondays 12:00 UTC via `.github/workflows/monitor.yml`. It checks out, `npm ci`, `npm start`, then commits `data/seen.json` if it changed.

### Run it manually
```bash
gh workflow run monitor.yml --repo <owner>/<repo>
```
Watch it:
```bash
gh run watch --repo <owner>/<repo>
```

### Local commands
| Command | Purpose |
| --- | --- |
| `npm run dry` | Full pipeline, prints digest, sends nothing, saves nothing. |
| `npm run sample:treasury` | Live Stream A sample + fit breakdown. |
| `npm run sample:predictor` | Live Stream B sample. |
| `npm run sample:gateway` | Live Stream A2 sample (governmentwide, broken down by agency + fit). |
| `npm run sample:dhs` | Live Stream A3 sample (DHS, fit breakdown + relevant-by-component + top scored). |
| `npm run sample:scored` | **Scoring/tuning workhorse.** Live scored+ranked universe, score-band histogram, top 15 with reasons, and the tail. `SHOW_DIGEST=1` also renders the email text; `ENABLE_GATEWAY=1` adds the slow governmentwide pull. |
| `npm run preview:llm` | Shows the exact LLM request (model, cached profile, rendered shortlist, rough token estimate) **without calling the API**. `SHOW_FULL=1` prints the untruncated prompt. |
| `npm run dashboard` | Local triage dashboard on `http://127.0.0.1:4317` (section 11). Reads the last run's snapshot; writes your decisions to `data/pursuit.json`. |
| `npm run dashboard:export` | One self-contained read-only HTML file you can send to someone. `-- --out path.html` to choose the destination. |
| `npm run verify:smtp` | Test ONLY the Gmail login (reads `.env`, sends nothing). |
| `npm run verify:dedup` | Twice-run dedup stability check on live data. |
| `npm run test:email` | Sends a sample digest to a throwaway Ethereal inbox, prints a preview URL. |
| `npm test` / `npm run typecheck` | Unit tests / types. |

`.env` (gitignored) holds local SMTP creds; `.env.example` is the template.

### Retargeting
Edit `config/codes.json` (NAICS/PSC direct vs adjacent) and `config/keywords.json` (direct/adjacent/exclude). Reloaded every run, no code change needed. Tune after reviewing the first few real digests.

### Tunable env vars
`POP_WINDOW_MONTHS` (18), `PREDICT_MIN_USD` (250000), `INCLUDE_ADJACENT` (1), `ENABLE_GATEWAY` (1), `ENABLE_DHS` (1), `DRY_RUN`.

LLM pass (all inert while `ENABLE_LLM` is unset): `ENABLE_LLM` (**0 — off**), `ANTHROPIC_API_KEY`, `LLM_MODEL` (`claude-opus-5`), `LLM_MAX_ITEMS` (40), `LLM_EFFORT` (`medium`).

Scoring tunables are code, not env: `WORTH_ACTING_ON` (70) in `src/core/score.ts` and `MAX_PRIORITIES_SHOWN` (20) in `src/core/digest.ts`. Both are one-line changes with unit tests covering them.

### Adding a source without flooding the inbox (what was done for DHS)

A new source introduces items the state file has never seen, so the first run after it goes live treats them all as new. Two options, both exercised now:

1. **Let it run.** `isBaseline` is false, so the digest renders normally: top 20 by score in full, the rest collapsed into a counted one-line list. One larger-than-usual email, then steady state.
2. **Reset `data/seen.json` to `{}` first.** Everything re-baselines silently and you get a short summary email. Cleaner inbox, but you lose the "what's genuinely new" signal for one cycle across *all* sources, not just the new one.

**The Gateway used option 2** (1,257 items at once). **DHS used option 1** — 246 new items rendered as `20 priority of 246 new, 5 changed`, with 226 collapsed. That was the deliberate test of whether ranking holds up under a flood, and it did. Prefer option 1 now that scoring exists; reserve option 2 for a source that would add >1,000 items.

Either way: `npm run dry` locally first to see the shape, then push, then `gh workflow run monitor.yml --repo <owner>/<repo>` and watch it.

---

## 7. How it was verified

- Stream A returns 404 records cold from Node, matching the site's own per-bureau counts (correctness proof).
- Stream B returns real expiring Treasury IT/systems contracts with incumbents.
- Stream A2 verified live and in CI: 7,171 governmentwide records fetched, 1,257 relevant, across ~8 agencies (runs `30100421762` and `30458612447` green).
- Stream A3 (DHS) verified live and in CI: 783 records fetched cold in one GET; 246 relevant across USCIS/CISA/TSA/USCG-C5I/ICE/CBP-OIT; top leads are $100M recompetes with named incumbents (USCIS EGIS III, ICE ITSS, Coast Guard C5ISC).
- **56 unit tests** (filter, dedup, cross-reference, Gateway parser, DHS parser, scorer, digest, LLM pass) + `npm run typecheck` clean.
- Scoring verified on live data, not just fixtures: first via `npm run sample:scored` over 452 Treasury+predictor items, then in CI against the **full 1,955-item universe including the 1,257 Gateway items it had never met**. The first weighting put 80% of items above threshold (useless); the rebalanced weights hold at ~20% (385 of 1,955) on the full set, so the threshold generalized rather than overfitting to Treasury.
- **End-to-end in production** (run `30458612447`, 11m33s green): all four streams, 1,955 scored, real Gmail send from the rewritten digest renderer, `seen.json` committed (1,958 entries).
- Email path proven via Ethereal, then real Gmail in CI ("Email sent" in the run logs).
- LLM pass verified **without any live API call**: 13 tests against an injected fake client (happy path, cap enforcement, cached-prompt shape, and one test per failure mode — thrown error, safety refusal, truncation, malformed JSON, hallucinated ids), plus `npm run preview:llm` rendering the exact payload.

**Not verified:** the LLM pass has never made a real API call. Its request shape is built against `@anthropic-ai/sdk` 0.115.0 typings (`OutputConfig`, `JSONOutputFormat`, and `claude-opus-5` are all typed) and typechecks, but the first live call is unproven — expect prompt iteration. Everything else in this list ran in production.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Run fails at "Run forecast monitor" with `535-5.7.8 Username and Password not accepted` | Gmail SMTP auth. The App Password must have **no spaces**, 2-Step Verification must be on, and `SMTP_USER` must be the account that owns the password. Test with `npm run verify:smtp` before touching CI, then `gh secret set SMTP_PASS`. |
| `gh workflow run` errors with "does not have workflow_dispatch trigger" | First-dispatch registration lag right after the initial push. Wait a moment and retry, or use the filename (`monitor.yml`) not the display name. |
| Run is green but no email arrives | Expected when nothing is new or changed since last run ("Nothing new or changed — no email"). |
| Stream A returns 0 / throws unexpected shape | Site redeployed and the Apex `classname` changed. Re-capture it (section 4). |
| Stream B returns 0 | Check the `award_amounts` floor and window; confirm USASpending field names (`End Date`, `NAICS.code`) via `npm run probe:usaspending`. |
| Gateway returns only ~481 records | The pager serves duplicate pages (page 2 mirrored page 1). Do not stop on the first zero-new page; that is what `EMPTY_STREAK_STOP` is for. |
| Gateway returns HTTP 504 | `range` is too large (must stay at 500) or the server is loaded. The adapter retries transient 5xx/429 with backoff. |
| Gateway pull runs long / partial | It legitimately takes ~11.5 min. `TIME_BUDGET_MS` (20 min) caps it and returns partial data; anything missed resurfaces next run. |
| DHS stream skipped (note in the email) | Best-effort by design. Check `apfs-cloud.dhs.gov/api/forecast` by hand; if the shape changed, fix `normalizeDhsRecord` and its unit tests. `ENABLE_DHS=0` disables it. |
| DHS items all score low / timing looks wrong | Almost certainly `award_quarter`. APFS emits `"Q4 2026"`, the pipeline expects `"FY 2026 Q4"`; `normalizeQuarter` does the rewrite. If it regresses, the scorer's timing points silently fall back to the neutral default. |
| Digest email feels like a flood again | Lower `MAX_PRIORITIES_SHOWN` (digest.ts) or raise `WORTH_ACTING_ON` (score.ts). Check `npm run sample:scored` first — the band histogram tells you which knob to turn. |
| Everything scores 0 | A dead-phase or `active:false` regression in a source adapter. `score()` floors dead items by design; confirm with a single `npm run sample:dhs` / `sample:treasury`. |
| `git pull` fails: "cannot pull with rebase: You have unstaged changes" | The bot pushed a `seen.json` commit while you were working — it does this after **every** run. Commit or stash first, then `git pull --rebase origin main`. Your commits never touch `seen.json`, so the rebase is always clean. Happened twice in one session; pull before starting local work. |
| Push rejected as non-fast-forward | Same cause. Rebase and push again; do not force. |
| LLM pass logs "disabled" every run | Expected — it ships off. Set `ENABLE_LLM=1` **and** `ANTHROPIC_API_KEY` to activate (section 10). |
| LLM pass note appears in the email | It ran and failed best-effort; items fell back to deterministic scores. The note names the cause (no key, network, refusal, truncation, bad JSON). |
| Read a failed run's logs | `gh run view --repo <owner>/<repo> --log-failed` |

---

## 9. Known limitations

- Forecast data is "for planning only and is not a government commitment." Treat items as leads, not guarantees.
- Cross-referencing is a heuristic (same NAICS + description token overlap >= 0.34). It can mislabel edge cases.
- Incumbent name is not resolved in Stream A (unresolved id); Stream B has the real incumbent (`Recipient Name`).
- The Gateway covers only the ~8 agencies that publish there. DHS is now covered by its own adapter, but **DoD and HHS remain absent**, so "governmentwide" is still aspirational, not literal (section 10 explains why they cannot be added).
- Neither the Gateway nor DHS forecast carries a PSC field, so NAICS + keywords do all the filtering for those sources.
- **Scoring is a heuristic, not a judgment.** It reads codes, dollars, dates, and keywords — it does not understand the requirement. A well-scored item can still be a poor fit, and the weights are calibrated against Treasury/DHS data as of 2026-07; they will drift as the mix of agencies changes. Re-check with `npm run sample:scored` after adding any source.
- Scoring cannot see what the source omits: the Gateway has no set-aside data (`type_of_awardee` is empty on every record), and Stream A has no resolvable incumbent, so those signals contribute nothing for those sources.
- The digest renders at most 20 priorities in full. In a dense week, genuinely strong items sit in the collapsed list — the count is shown, but they get one line, not detail.
- **Deterministic scoring cannot tell fit from resemblance, and the top of the list shows it.** The current deterministic top-40 is led by ICE "IT Support Services", *three duplicate copies* of a Coast Guard app-dev pipeline, a CISA engineering contract, and a Bureau of Engraving **manufacturing** system — all large-dollar NAICS 541512 matches, none of them financial-transparency work. This is the gap the LLM pass exists to close (section 10); until it is activated, expect to mentally discard several of the top items each week.
- **Duplicate source records waste shortlist slots.** DHS APFS lists some requirements several times under distinct ids (the C5ISC example above occupies 3 of the 40 LLM shortlist slots). Dedup is by id across all sources, deliberately — they are distinct records with distinct pages. A content-hash dedup for DHS would reclaim those slots but risks collapsing genuinely separate task orders; see section 4 → Stream A3.
- A full Gateway pull takes ~11.5 minutes, which makes the weekly run correspondingly long (still well inside Actions limits).
- GitHub Actions prints a Node 20 deprecation warning (the actions are forced onto Node 24). Harmless for now; bump `node-version` to `"24"` in the workflow when convenient.

---

## 10. Extending — what is done, what is dead, what is next

Adding a source is cheap by design: the pipeline (classify → crossref → score → dedup → digest) is source-agnostic, so an adapter only has to emit `Opportunity[]`. The expensive part is finding a public endpoint that works cold.

### Done
- **Gateway set** (2026-07-24): ~8 agencies from one adapter. Live.
- **DHS APFS** (2026-07-29): one cold GET, +246 relevant. Live.
- **Deterministic relevance scoring + ranked digest** (2026-07-29). Live.
- **LLM relevance pass** (2026-07-29): built and committed, **switched off and unpushed** — see below.

### Investigated and rejected — do not redo this research

These were each probed live from Node on 2026-07-29. A confident negative saves the next person days.

| Target | Verdict | Why |
| --- | --- | --- |
| **DoD forecast** | **No public API exists.** | `apfs-cloud.dla.mil` and `osbp.army.mil` do not resolve (APFS is a DHS product, not DoD — a common misattribution). `business.defense.gov` forecast pages 404 after a site reorg and were only a link directory anyway. Navy (`secnav.navy.mil` LRAE) returns a **CAPTCHA/JS challenge** to plain fetch. Air Force and NAVFAC are static HTML with no data file. DoD is genuinely **absent from the Gateway** (0 records across a 1,692-record sample; the department dropdown lists civilian agencies only). Coverage would require per-component HTML/PDF scraping — fragile, high-maintenance, not an API integration. If DoD ever becomes a hard requirement, the least-bad path is **SAM.gov's Opportunities API** (Sources Sought / Presolicitation notices — needs a registered key, and is published-notice data, not forecast). |
| **HHS forecast** | **Auth + MFA gated.** | `osdbu.hhs.gov` is an ApexLogic Angular SPA (same vendor as the Gateway). Its bundle exposes `/api/auth`, `/api/mfa/resend`, `/api/sbcxopportunity` and an `ExportSuppressed` flag; cold probes reach the Tomcat backend but never data. No public read path. HHS is also absent from the Gateway. Would require credentials — out of scope for an unattended bot. |
| **GAO bid-protest docket** | **Robots-disallowed.** | This is the frustrating one: GAO's protest search *is* reachable cold, needs no auth, and is exactly the right signal — it exposes **open/pending** protests (222 live at time of check) with a structured **Solicitation Number**, which is the only field that would let us filter protests down to relevant ones. But `gao.gov/robots.txt` explicitly disallows `/legal/bid-protests/search?*` and `*/search?processed=`, and the data only exists behind those query-string URLs. **We do not scrape a disallowed path.** |
| **GAO published decisions** (`/legal/bid-protests/recent`) | Allowed but low value. | Robots-permitted, but decisions land *months after award* — far too late to act on, which defeats the whole "engage early" thesis. No RSS/Atom feed exists. |
| **EPDS** (`epds.gao.gov`) | **Needs auth.** | Unlike PACER, EPDS gives no public record access; only case parties log in. The public docket *is* the gao.gov search above. |
| **COFC via CourtListener v4** | Cold and anonymous, but unfilterable. | `/api/rest/v4/search/` works without a key (`/dockets/` needs a free token) and is fresh. But it carries **no solicitation number and no NAICS**, so protests cannot be narrowed to relevant topics without reading complaint PDFs — it would alert on every protest governmentwide. Nature-of-suit code 140 flags protests but is inconsistently populated. |

**If protest tracking is wanted anyway:** the correct next step is to **email `protests@gao.gov` (or call 202-512-5436) and request permission or a sanctioned feed** for the docket path. That is a five-minute email that either unlocks the best available early signal or gives a definitive no. Do not build the scraper first.

### LLM relevance pass — BUILT, DELIBERATELY INACTIVE

Fully wired, but **switched off**: it runs only when `ENABLE_LLM=1` **and** `ANTHROPIC_API_KEY` are both set. With either missing the bot behaves exactly as it does today and makes no API call. Deliberate: plumb it now, activate later.

**Why it exists.** `classify()` decides *if* an item is relevant and `score()` decides how much it *looks* worth acting on, but neither can read a requirement and judge whether it is really your kind of work. The preview makes the gap concrete: the deterministic top-40 is led by ICE "IT Support Services", three copies of a Coast Guard app-dev pipeline, a CISA engineering contract, and a Bureau of Engraving *manufacturing* system — all big-dollar NAICS 541512 matches, none of them financial-transparency work.

| Piece | Where |
| --- | --- |
| The pass | `src/core/llmScore.ts` |
| Capability profile (the prompt's whole view of the company) | `config/profile.md` |
| Preview without calling the API | `npm run preview:llm` |
| Tests (mocked client, no network) | `test/llmScore.test.ts` |

**Design decisions:**
- **Runs after the diff**, so it only ever scores items that will actually appear in the email — never the full 1,950.
- **Top 40 by deterministic score** (`LLM_MAX_ITEMS`). A hard cost ceiling: the DHS launch added 246 new items in one run, and a cap means that kind of spike can't produce a surprise bill.
- **One batched call**, so the model ranks comparatively rather than scoring each item in isolation.
- **`config/profile.md` is a cached system prompt** (`cache_control: ephemeral`), so repeat runs pay ~0.1x on that span. Opus 5's cache minimum is 512 tokens; the cached prefix (profile + instructions) clears it at ~1,700. Keep the profile well clear of that floor when editing, or caching silently stops engaging.
- **Structured outputs** (`output_config.format`, JSON schema) guarantee parseable output — no regex scraping of prose.
- **Best-effort, always.** Missing key, network error, safety refusal, truncation, malformed JSON, hallucinated ids: every path leaves items on their deterministic scores and notes it in the email. This pass must never be able to break the weekly run, and there are unit tests for each failure mode.
- Ranking uses `effectiveScore()` — LLM judgment when present, deterministic otherwise. **This mixes two scales:** items below the shortlist cap keep their provisional deterministic rank, so a high unjudged item can outrank one the LLM judged a poor fit. That is intended — a real assessment should be able to demote something the rules over-rated.

**Before activating:**
1. **Replace `config/profile.md` and `config/company.json`.** Both ship with a fictional
   sample company, and the profile is the model's entire view of the vendor, so an
   inaccurate one quietly poisons every LLM score. Two facts matter more than the rest,
   because they decide reachability rather than appeal: **SAM.gov registration** (without
   an active registration and UEI no federal award can be received at all) and
   **socioeconomic certifications held**. Measured against one live run of 1,943 scored
   items, the shape of that is worth knowing before you tune anything: **103 items (5.3%)
   were reserved for a certification** (8(a), SDVOSB, WOSB, HUBZone), **1,359 carried no
   set-aside restriction at all**, and 136 were small-business set-asides reachable on
   size alone. So for an unregistered vendor the certification wall is a small slice
   while the SAM wall is total, and registering is the single change that converts
   roughly 1,500 otherwise-unreachable items into biddable ones. That is a business
   action, not a code change.
2. `gh secret set ANTHROPIC_API_KEY` and add it to `.github/workflows/monitor.yml`'s env block (not yet added — the workflow is untouched).
3. Run `npm run preview:llm` to see the exact payload, then `ENABLE_LLM=1 npm run dry` for a live pass before letting CI do it.

Estimated cost at 40 items/week on `claude-opus-5`: **~$0.11 per run, ~$0.45/month**.

**Not verified:** no live API call has ever been made from this code. Tests use an injected fake client; the preview script deliberately doesn't call out. The request shape is built against the SDK's typings (`OutputConfig`, `JSONOutputFormat`, `claude-opus-5` are all typed in `@anthropic-ai/sdk` 0.115.0) and typechecks, but the first real call is still unproven — expect to iterate on the prompt.

### Next candidates
- **Server-side NAICS filtering for the Gateway.** `filters.field_naics_code_target_id.options` maps NAICS → `tid`. Could cut the ~11.5 min pull to seconds. (Note: the export endpoint **ignores** the agency filter param, so agency filtering must stay client-side.)
- **Dashboard / Postgres.** Persist opportunities and surface them beside your own admin console instead of (or alongside) email.
- **State/local track — see below.**

### State/local adapter design (not built; design only)

The bot is 100% federal. If municipal leads ever become the priority, here is the
design so nobody re-derives it.

**Shape of the problem.** State/local procurement has no equivalent of a governmentwide
forecast. Most jurisdictions publish *open bids*, not 12-month-ahead plans, which
inverts the bot's core thesis (catch it before the RFP). Two partial substitutes for
"early":
1. **Contract-expiration mining**, the same trick as Stream B. Many jurisdictions
   publish an awarded-contract register with end dates; an expiring ERP or
   financial-systems contract is the local equivalent of a recompete signal, and is
   often the *only* forward-looking data available.
2. **Agenda and minutes monitoring.** City council, board of estimates, and select
   board agendas name upcoming awards and renewals weeks before solicitation. For most
   cities the weekly agenda is the single highest-signal document available.

**Targets, in build order:**
- **The relevant statewide portal.** Many states run one that includes local entities
  (Maryland's eMMA is a good example of the type). These are usually
  **Periscope/BidSync-style** platforms: check for a public JSON search endpoint behind
  the "Browse Public Solicitations" page before assuming a scrape.
- **Your specific target city.** Check the city's bid board and, more importantly, the
  agenda of whatever body approves contracts, which is typically published weekly and
  names awards, extensions, and amendments with dollar values and vendors. This is
  agenda parsing, not an API.
- **Generic fallback.** A lot of municipalities run **OpenGov Procurement (formerly
  ProcureNow), Bonfire, or BidNet**. Each has a predictable URL shape, so one adapter
  per *platform* covers many jurisdictions, which is far better leverage than one
  adapter per city. Prefer platform adapters over city adapters.

**What must change in the pipeline** (it is mostly ready):
- `OppSource` gains the new ids; `agency` becomes the jurisdiction, `bureau` the department.
- `config/codes.json` needs **NIGP commodity codes** alongside NAICS, because most local
  systems classify by NIGP, not NAICS. This is the single biggest change and should be
  done first, since `classify()` and `score()` both key off code sets.
- Scoring weights need re-tuning: local dollar values are 1-2 orders of magnitude
  smaller, so `dollarScore`'s bands would put every municipal item at the floor. Give
  the scorer a per-source dollar scale, or normalize to a percentile within the source.
- The digest should group by jurisdiction once local and federal items share an inbox,
  otherwise a $200K municipal lead is invisible next to a $145M IRS one, which is
  precisely the wrong outcome if municipal is the priority.

**Recommendation if this becomes real:** build a single agenda watcher for one target
city *first* and alone. It is the highest-signal, lowest-volume source available, and it
does not require solving the NIGP, scoring, and grouping problems that a full local
track implies.

---

## 11. The local triage dashboard

```bash
npm run dashboard
```

Then open `http://127.0.0.1:4317`. Built 2026-07-30.

**What it is for.** The weekly email is good at telling you what is new and bad at being a worklist: you cannot mark anything, and you re-read the same rejects every week. The dashboard turns the same data into a triage surface, and the decisions you make in it flow back into the email.

**LOCAL ONLY, DELIBERATELY.** The server binds `127.0.0.1`, never `0.0.0.0`. This data is which federal opportunities you track and how you rate them, which is competitive information about your own company. Do not change the bind address to reach it from another machine without deciding on authentication first.

**Why a server and not a plain HTML file.** Decisions have to land somewhere CI can read them. A `file://` page can only write to browser storage, which the weekly run cannot see and which disappears when site data is cleared. The server is about 150 lines of `node:http` with no dependencies.

**Data flow.**

| File | Role | In git? |
|---|---|---|
| `data/snapshot.json` | Last run's scored output, what the page reads | **No.** Derived, ~1.9MB. Regenerate with `npm run dry`. |
| `data/pursuit.json` | Your pursue/watch/skip decisions and notes | **Yes, and it must be.** The digest reads it in CI. |

The dashboard never fetches from federal sources itself. It opens instantly against the last run because a live pull takes about 12 minutes, nearly all of it the Gateway. Refresh the data by running the bot.

**The loop.** `run.ts` calls `dropSkipped()` to drop anything you skipped before the digest is built, and `activePursuits()` to collect what you marked pursue or watch into a standing "Your pursuits" section rendered at the top of the email. Skipped items are still recorded in `seen.json`, so they never re-alert; they just stop being shown. Both functions are pure and unit-tested in `test/pursuit.test.ts`.

**Eligibility (`src/core/eligibility.ts`).** Answers "can we bid this", which is independent of score. `config/company.json` is the single place the SAM and certification facts live.

> **When the company registers in SAM.gov, set `samRegistered: true` in `config/company.json` and nothing else.** Every "needs SAM" badge clears on the next load. Same for `certifications` when one is earned. Keep it consistent with `config/profile.md`, which drives LLM scoring from the same facts.

Measured against the 2026-07-30 run of 1,943 items: 1,359 full and open, 136 small business, 103 certification-blocked, 345 unknown or unstated. The certification wall is small; the SAM wall is total.

Two parsing traps worth keeping:
- Certification patterns are checked **before** the small-business pattern, because "8(a) Small Business Set-Aside" contains the words "small business" and would otherwise read as reachable.
- 45 live items say exactly `"Set-aside"` with no type. That is reported as unknown, not as a small-business set-aside. Guessing generously there is how you spend an afternoon on something reserved for a certification we do not hold.

**Styling.** Every color lives in `dashboard/brand-tokens.css`; no hex literal appears
in the dashboard's own HTML or JS, so re-theming the page is a single-file edit. The
component language is deliberately plain: metric cards, a data table, deterministic
agency monograms, and a score bar with a marker at the priority threshold.

**Sharing it: export, never expose.**

```bash
npm run dashboard:export
```

Writes `dashboard-export/forecast-triage-<date>.html`: a single self-contained file with the tokens, the page script and the data inlined. Gitignored, since it carries the same data as the snapshot.

> **Do not tunnel the dev server to share it.** `POST /api/pursuit` has no authentication, which is only safe because the server binds `127.0.0.1`. Putting ngrok or Cloudflare Tunnel in front of it would expose an unauthenticated write endpoint to the internet, and those writes feed the weekly digest. Exporting is the supported path.

The export sets `window.__STATIC__`, which puts `app.js` into read-only mode: no triage buttons, no note saving, no fetch. Filtering, searching and row expansion still work, because they were always client-side. The page is reused verbatim rather than reimplemented, so there is one UI to maintain; `export-dashboard.ts` fails loudly if `index.html` changes such that the stylesheet or script can no longer be inlined.

Two things to check before sending one:
- **The export is stamped with today's date but contains whatever run the snapshot holds.** Run `npm run dry` first if you want it current, or the filename will imply freshness the data does not have. The page header always states the true run time.
- **The page leads with the readiness gate banner** and per-item "can we bid" verdicts. That is candid internal assessment of your own company's gaps. Fine for an advisor; think twice before sending an export to a prime you are courting or an investor.

**Not built:** trends over time and source-health panels were considered and cut from v1. There is no auth, no multi-device sync, and no way to edit an opportunity, by design.

## 12. Getting oriented

1. Read section 1 (what and why) and section 4 (the reverse-engineered endpoints, which
   are the real tribal knowledge).
2. `npm install && npm test` for the unit tests. No network and no secrets needed.
3. `npm run sample:scored` for live data, scored and ranked, with no email sent.
4. **Point it at your own company before trusting any output.** `config/profile.md` and
   `config/company.json` both ship with a fictional sample company. Then retune targeting
   in `config/codes.json` / `config/keywords.json` and ranking in `src/core/score.ts`,
   re-checking with `npm run sample:scored`. Do not tune by editing the digest.