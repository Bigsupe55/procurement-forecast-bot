// Runtime configuration. Secrets come from environment (.env locally, repo
// secrets in CI). Tunables have sensible defaults so a cold run "just works".

import "dotenv/config"; // loads .env locally; no-ops in CI where none exists
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");

export const paths = {
  seen: resolve(ROOT, "data", "seen.json"),
  // `snapshot` is the last run's scored output: derived, megabytes, gitignored,
  // read only by the local dashboard. `pursuit` is your triage decisions and is
  // COMMITTED, because the digest reads it in CI so skipped items stop coming
  // back in the weekly email.
  snapshot: resolve(ROOT, "data", "snapshot.json"),
  pursuit: resolve(ROOT, "data", "pursuit.json"),
  dashboard: resolve(ROOT, "dashboard"),
  codes: resolve(ROOT, "config", "codes.json"),
  keywords: resolve(ROOT, "config", "keywords.json"),
  profile: resolve(ROOT, "config", "profile.md"),
  company: resolve(ROOT, "config", "company.json"),
};

export const config = {
  dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
  popWindowMonths: Number(process.env.POP_WINDOW_MONTHS ?? 18),
  includeAdjacent: process.env.INCLUDE_ADJACENT !== "0",
  // Governmentwide forecast source (GSA Acquisition Gateway); covers all
  // non-Treasury agencies. Set ENABLE_GATEWAY=0 to disable.
  enableGateway: process.env.ENABLE_GATEWAY !== "0",
  // DHS forecast (APFS); DHS is absent from the Gateway. Set ENABLE_DHS=0 to disable.
  enableDhs: process.env.ENABLE_DHS !== "0",
  // Optional LLM relevance pass over the top shortlist (core/llmScore.ts).
  // DEFAULT OFF and opt-in: it is fully plumbed but deliberately inactive until
  // ENABLE_LLM=1 *and* ANTHROPIC_API_KEY are both set. Nothing calls the API
  // otherwise, so the bot runs exactly as it does today.
  enableLlm: process.env.ENABLE_LLM === "1",
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.LLM_MODEL || "claude-opus-5",
    // Deterministic scoring prefilters to this many items before the LLM sees
    // them: a hard ceiling on cost, so a source-addition spike (the DHS launch
    // added 246 new items at once) can never produce a surprise bill.
    maxItems: Number(process.env.LLM_MAX_ITEMS ?? 40),
    effort: (process.env.LLM_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  },
  // Predictor floor: ignore expiring contracts below this award amount. Small
  // renewals are not real leads.
  predictMinUsd: Number(process.env.PREDICT_MIN_USD ?? 250_000),
  // Prune dedup entries not seen for this many days (keeps seen.json bounded).
  pruneAfterDays: 180,
  // Shown in the digest subject and headings. Set ORG_NAME to your own.
  orgName: process.env.ORG_NAME || "Procurement",
  // Sent to every agency endpoint this bot touches. Identifying yourself is the
  // polite half of "light, infrequent requests", so set CONTACT_EMAIL to a real
  // inbox before running this against anyone's servers.
  userAgent:
    `ProcurementForecastBot/0.1 (+contact: ${process.env.CONTACT_EMAIL || "unset"}; lead-gen research)`,
  email: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    to: process.env.ALERT_TO ?? process.env.SMTP_USER ?? "",
    from: process.env.ALERT_FROM || process.env.SMTP_USER || "",
  },
};
