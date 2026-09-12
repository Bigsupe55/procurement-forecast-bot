# Procurement Forecast Bot

[![CI](https://github.com/Bigsupe55/procurement-forecast-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Bigsupe55/procurement-forecast-bot/actions/workflows/ci.yml)

Surfaces **planned** U.S. federal procurement, before any RFP is published, that fits a specific small vendor, so you can engage early: capability statement, RFI response, or a call to the bureau's small-business specialist while requirements are still being shaped.

Built for a small municipal govtech company whose product is nothing like most of the federal IT forecast, which is exactly the hard case: the NAICS codes match thousands of items and almost none of them are real. The interesting problem here is not fetching the data, it is throwing away 97% of it without discarding the 3% that matters.

> The capability profile that defines "fits" is a **fictional sample company** (`config/profile.md`), as are the readiness facts in `config/company.json`. Replace both with your own before trusting a score.

Scope: **federal** — every agency reachable through a public, no-auth API. Alert-only, no automated outreach.

## What it watches

Four sources, combined and de-duplicated:

1. **Treasury forecast** — Treasury's OSDBU Forecast of Contract Opportunities (`osdbu.forecast.treasury.gov`), published under the Small Business Act. Tagged **New** vs **Recompete**.
2. **Governmentwide forecast** — GSA's Acquisition Gateway Forecast Tool (`acquisitiongateway.gov/forecast`), covering ~8 participating agencies (Treasury excluded to avoid overlap). Public, no auth; thousands of opportunities with estimated value, award quarter, solicitation date, and named contacts.
3. **DHS forecast** — DHS's Acquisition Planning Forecast System (`apfs-cloud.dhs.gov`). DHS does not publish into the Gateway, so it gets its own adapter: ~780 planned procurements in one public request.
4. **Expiring-contract predictor** — Treasury contracts in your core NAICS whose period of performance ends within a forward window (default 18 months), from the public **USASpending.gov** API. An expiring contract is a likely upcoming recompete, often before it appears in any forecast. Cross-referenced against source 1 and flagged `confirmed` or `predicted, not yet forecasted` (the earliest signal).

All sources are filtered for fit by NAICS/PSC codes and keywords (`config/codes.json`, `config/keywords.json`), de-duplicated with change-detection (a shifted value, timeline, or type re-alerts you), **scored 0-100 for priority**, and emailed as a ranked digest.

## How it ranks

Relevance alone is not enough — most of the federal IT forecast technically fits, which is a firehose, not a lead list. Every relevant opportunity gets a deterministic **0-100 priority score** driven by the things that actually decide where your time goes: **dollar size**, **warmth** (an incumbent to displace, a recompete, or confirmation from two independent sources), **timing** (award imminent, or a contract about to expire), and **acquisition phase** (early enough to still shape the requirement). Canceled, closed, and already-awarded items floor to zero.

The email leads with the top items in full — each with a plain-English `signals:` line — and collapses the rest into a counted one-line list. Every point traces to a rule, and the scoring is unit-tested.

An optional **LLM judgment pass** sits on top of that, described below.

## The LLM pass, and why it ships off

Rules can tell that a $100M contract matches NAICS 541512. They cannot tell that it is
generic IT staffing rather than financial-transparency work. So an optional pass sends
the top items by deterministic score to Claude and asks whether each is *really* this
vendor's work, returning a fit score, a one-line assessment, and a suggested next step.

Four decisions in that pass are worth more than the pass itself:

**It is the last stage, not the first.** Roughly 2,000 items clear the keyword and NAICS
filter each run. Sending all of them to a model would cost real money to rank a list
that is 97% noise. The deterministic scorer does the cutting and the model only ever
sees a shortlist, which is also why the ranking stays reproducible when the pass is off.

**`LLM_MAX_ITEMS` is a cost ceiling, not a tuning knob.** It hard-caps items per run at
40. Agencies publish in bursts, and one Monday where DHS adds 250 opportunities must not
turn into a surprise bill. The cap is enforced before the request is built.

**The company profile is a cached system prompt, and it is the only thing the model
knows.** `config/profile.md` is the model's entire view of the vendor: what it sells, who
buys it, what it explicitly does *not* do, and the structural gaps that make a contract
unreachable regardless of fit. It is plain prose in a file, so changing what the model
believes is an edit, not a deploy. `npm run preview:llm` renders the exact request that
would be sent without calling the API.

**It ships switched off.** It runs only when `ENABLE_LLM=1` *and* `ANTHROPIC_API_KEY`
are both set; with either missing, nothing calls the API and the bot behaves exactly as
it does with the pass absent. That default is deliberate: a model judging against an
unreviewed profile is worse than no model, because it launders a bad premise into
confident-sounding output. Replace `config/profile.md` with your own before enabling it.
The one that ships describes a company that does not exist.

## Quick start

```bash
npm install
npm run dry        # fetch live data and PRINT the digest (no email sent)
```

The first real run records a **baseline** (no flood of email); after that you are alerted only on new or changed opportunities.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dry` | Full pipeline, prints the digest instead of sending (state not saved). |
| `npm start` | Full pipeline, sends the email (needs SMTP env). Used by CI. |
| `npm run sample:treasury` | Live sample of stream A with fit breakdown. |
| `npm run sample:predictor` | Live sample of stream B (expiring contracts). |
| `npm run sample:gateway` | Live sample of the governmentwide Gateway source. |
| `npm run sample:dhs` | Live sample of the DHS source (fit breakdown by component + top scored). |
| `npm run sample:scored` | Live scored + ranked universe with score bands and reasons. `SHOW_DIGEST=1` also prints the email. |
| `npm run preview:llm` | Shows the exact LLM request that *would* be sent, without calling the API. |
| `npm run probe:usaspending` | Raw USASpending API probe (schema check). |
| `npm run test:email` | Sends a sample digest via a throwaway Ethereal inbox, prints a preview URL. |
| `npm test` | Unit tests (filter, dedup, cross-reference, source parsers, scoring, digest). |
| `npm run typecheck` | `tsc --noEmit`. |

## Configuration (env / `.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | SMTP credentials (Gmail example in `.env.example`). |
| `ALERT_TO` | `SMTP_USER` | Digest recipient. |
| `ORG_NAME` | `Procurement` | Name shown in the digest subject and headings. |
| `CONTACT_EMAIL` | `unset` | Contact address sent in the User-Agent to agency endpoints. Set a real one. |
| `DRY_RUN` | — | `1` prints instead of sending. |
| `POP_WINDOW_MONTHS` | `18` | Forward window for the expiring-contract predictor. |
| `PREDICT_MIN_USD` | `250000` | Ignore expiring contracts below this amount. |
| `INCLUDE_ADJACENT` | `1` | Include adjacent-fit forecast items, not just direct-fit. |
| `ENABLE_GATEWAY` | `1` | Governmentwide Gateway source (all non-Treasury agencies); `0` disables. |
| `ENABLE_DHS` | `1` | DHS APFS forecast source; `0` disables. |
| `ENABLE_LLM` | `0` | LLM judgment pass. **Off by default** — needs `1` *and* an API key. |
| `ANTHROPIC_API_KEY` | — | Required only when `ENABLE_LLM=1`. |
| `LLM_MODEL` | `claude-opus-5` | Model for the judgment pass. |
| `LLM_MAX_ITEMS` | `40` | Hard cap on items sent per run (the cost ceiling). |

## Deploy (GitHub Actions, free)

The workflow `.github/workflows/monitor.yml` runs weekly (Mondays 12:00 UTC) and on demand, then commits the updated `data/seen.json` back to the repo so state survives between runs.

1. Push this repo to GitHub.
2. In the repo: **Settings → Secrets and variables → Actions**, add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_TO`.
   - For Gmail: turn on 2-Step Verification, create an **App Password**, and use that as `SMTP_PASS`.
3. **Actions** tab → run the workflow manually once to confirm it emails and commits state.

## How it was verified

- Stream A endpoint confirmed to return all 404 Treasury records from plain Node (no browser), matching the site's own per-bureau counts.
- Stream B confirmed against the live USASpending API (real expiring IT/systems contracts with incumbents).
- DHS confirmed live: 780 records in one cold request, 244 relevant across the DHS IT components.
- Scoring calibrated against live data (not fixtures) via `npm run sample:scored` — license renewals sink, large expiring enterprise systems with named incumbents rise.
- `npm test` covers filter tagging, dedup + change-detection, cross-referencing, both forecast parsers, the scoring rules, and digest rendering.
- `npm run test:email` proves the SMTP + HTML rendering path.

## Data sources and ethics

All data is public: the forecast is published specifically for vendor planning, and USASpending is open data. The bot identifies itself in its User-Agent and makes light, infrequent requests. Forecast data is **for planning only and is not a government commitment** — treat items as leads. v1 does not contact anyone; any engagement should go through official RFI / sources-sought / small-business-specialist channels.

## Extending

Next up: an LLM pass over the scored shortlist (rank + explain the top few), server-side NAICS filtering to speed up the Gateway pull, a dashboard, and a state/local track.

DoD, HHS, and GAO bid-protest tracking were each investigated and **rejected** — no usable public source (DoD has no forecast API, HHS is auth-gated, and GAO's open protest docket is robots-disallowed). See [ARCHITECTURE.md](ARCHITECTURE.md) section 10 for the full findings so nobody repeats that research.
