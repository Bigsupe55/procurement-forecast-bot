// Optional LLM relevance pass — the judgment layer on top of deterministic scoring.
//
// STATUS: fully plumbed, DELIBERATELY INACTIVE. It runs only when ENABLE_LLM=1 and
// ANTHROPIC_API_KEY are both set. With either missing, `llmScoreShortlist` returns
// immediately and the pipeline behaves exactly as it does without this file.
//
// Why it exists: `classify()` decides IF an item is relevant and `score()` decides how
// much it LOOKS worth acting on, but neither can read a requirement and judge whether
// it is really this vendor's work. A NAICS match is what got an item onto the list; this
// pass asks a model to say whether it is genuinely us, and what to do about it.
//
// Design:
//   - Deterministic score prefilters to `config.llm.maxItems` (default 40) — a hard
//     cost ceiling, and the digest only renders 20 anyway.
//   - One batched call, so the model can rank items comparatively rather than scoring
//     each in isolation.
//   - The capability profile (config/profile.md) is a cached system prompt: it is the
//     stable prefix on every call, so repeat runs pay ~0.1x on that span.
//   - Structured outputs (`output_config.format`) guarantee parseable JSON back.
//   - BEST-EFFORT ALWAYS: any failure (no key, network, refusal, truncation, bad JSON,
//     unknown ids) leaves items untouched with their deterministic scores. This pass
//     must never be able to break the weekly run.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { config, paths } from "../config.js";
import type { Opportunity } from "./types.js";

// Shape the model must return. Structured outputs reject numeric/length constraints,
// so bounds are enforced client-side in `mergeAssessments`.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    assessments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The opportunity's ref, copied exactly." },
          score: {
            type: "integer",
            description: "0-100 fit against the capability profile. Be harsh: most federal IT work is NOT a fit.",
          },
          rationale: {
            type: "string",
            description: "One sentence, under 25 words, on why it does or does not fit. Name the specific reason.",
          },
          action: {
            type: "string",
            description:
              "One concrete next step (e.g. 'RFI response to the named CISA POC before the Q2 solicitation'), or 'Skip' if not worth pursuing.",
          },
        },
        required: ["id", "score", "rationale", "action"],
        additionalProperties: false,
      },
    },
  },
  required: ["assessments"],
  additionalProperties: false,
} as const;

const INSTRUCTIONS = `You are screening U.S. federal procurement opportunities for a very small, early-stage government software vendor. The capability profile above is the ONLY description of the company you should judge against: do not infer anything about it from your own knowledge.

Every item below already passed a keyword/NAICS filter, so surface-level relevance tells you nothing. Your job is to separate the few that are genuinely this company's work from the many that merely look like it.

Scoring guidance:
- 80-100: squarely the company's work AND a plausible entry path for a tiny, uncertified vendor.
- 50-79: real adjacency or a credible subcontract/teaming angle, but not a clean fit.
- 20-49: same technology neighbourhood, not the company's actual capability.
- 0-19: not this company's work, or structurally out of reach (needs an existing ATO/FedRAMP, prime-only at a scale this company cannot deliver).

Be skeptical and be willing to score most items low — a list where everything scores 70+ is useless. Judge the requirement itself, not how enthusiastically it is worded. If an item's description is too thin to judge, say so in the rationale and score it in the middle rather than guessing high.

Return one assessment per item, copying each 'ref' exactly into 'id'.`;

export interface LlmPassResult {
  attempted: number; // items sent to the model
  scored: number; // items that came back with a usable assessment
  note?: string; // populated on skip or failure, surfaced in the digest
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

// Minimal surface of the SDK we depend on — lets tests inject a fake client
// without network access or an API key.
export interface MessageCreator {
  messages: {
    create(body: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Score the strongest slice of `opps` with the LLM, mutating those items in place
 * with llmScore / llmRationale / llmAction. Returns a summary; never throws.
 */
export async function llmScoreShortlist(
  opps: Opportunity[],
  client?: MessageCreator
): Promise<LlmPassResult> {
  if (!config.enableLlm) {
    return { attempted: 0, scored: 0, note: "llm pass disabled (set ENABLE_LLM=1 to enable)" };
  }
  if (!client && !config.llm.apiKey) {
    return { attempted: 0, scored: 0, note: "llm pass skipped: ANTHROPIC_API_KEY not set" };
  }
  if (opps.length === 0) return { attempted: 0, scored: 0 };

  // Strongest-first by deterministic score, capped. The cap is the cost ceiling.
  const shortlist = [...opps]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.max(0, config.llm.maxItems));
  if (shortlist.length === 0) return { attempted: 0, scored: 0 };

  try {
    const api = client ?? new Anthropic({ apiKey: config.llm.apiKey });
    const response: any = await api.messages.create({
      model: config.llm.model,
      max_tokens: 16000,
      // Cached prefix: the profile + instructions are identical every run, so
      // only the item list below is billed at full rate on repeat runs.
      system: [
        {
          type: "text",
          text: `${loadProfile()}\n\n---\n\n${INSTRUCTIONS}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        effort: config.llm.effort,
        format: { type: "json_schema", schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: "user", content: renderItems(shortlist) }],
    });

    // Opus 5 runs safety classifiers; a decline is a 200 with empty/partial content.
    if (response?.stop_reason === "refusal") {
      return { attempted: shortlist.length, scored: 0, note: "llm pass refused by safety classifier" };
    }
    if (response?.stop_reason === "max_tokens") {
      return { attempted: shortlist.length, scored: 0, note: "llm pass truncated (raise max_tokens or lower LLM_MAX_ITEMS)" };
    }

    const text = firstText(response);
    if (!text) return { attempted: shortlist.length, scored: 0, note: "llm pass returned no text" };

    const scored = mergeAssessments(shortlist, text);
    const u = response?.usage ?? {};
    return {
      attempted: shortlist.length,
      scored,
      usage: {
        inputTokens: Number(u.input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
      },
      note: scored === 0 ? "llm pass returned no usable assessments" : undefined,
    };
  } catch (err) {
    return { attempted: shortlist.length, scored: 0, note: `llm pass failed: ${(err as Error).message}` };
  }
}

// ---- helpers ----

function loadProfile(): string {
  try {
    return readFileSync(paths.profile, "utf8");
  } catch {
    return "(no capability profile found at config/profile.md)";
  }
}

// Compact, token-cheap rendering. `ref` is the join key back to the opportunity;
// fingerprint is stable and unique across sources, unlike the source-native id.
export function renderItems(opps: Opportunity[]): string {
  return opps
    .map((o) => {
      const who = o.bureau && o.bureau !== o.agency ? `${o.agency} / ${o.bureau}` : o.agency;
      const lines = [
        `ref: ${o.fingerprint}`,
        `title: ${o.title}`,
        `agency: ${who}`,
        `type: ${o.oppType}`,
        o.naics ? `naics: ${o.naicsDesc ?? o.naics}` : null,
        o.estValue ? `value: ${o.estValue}` : null,
        o.awardQuarter ? `award: ${o.awardQuarter}` : null,
        o.popEnd ? `expires: ${o.popEnd}` : null,
        o.setAside && o.setAside !== "None" ? `set-aside: ${o.setAside}` : null,
        o.incumbent ? `incumbent: ${o.incumbent}` : null,
        o.phase ? `phase: ${o.phase}` : null,
        // The description carries the actual requirement; cap it so one verbose
        // record cannot dominate the prompt.
        o.description ? `description: ${o.description.slice(0, 600)}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function firstText(response: any): string | undefined {
  const blocks: any[] = Array.isArray(response?.content) ? response.content : [];
  return blocks.find((b) => b?.type === "text" && typeof b.text === "string")?.text;
}

/**
 * Parse the model's JSON and attach results to the matching opportunities.
 * Tolerant by design: unknown ids are ignored, missing items simply keep their
 * deterministic score, and out-of-range scores are clamped.
 */
export function mergeAssessments(opps: Opportunity[], rawJson: string): number {
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return 0;
  }
  const assessments: any[] = Array.isArray(parsed?.assessments) ? parsed.assessments : [];
  const byRef = new Map(opps.map((o) => [o.fingerprint, o]));

  let applied = 0;
  for (const a of assessments) {
    const target = byRef.get(String(a?.id ?? ""));
    if (!target) continue; // hallucinated or duplicated ref
    const raw = Number(a?.score);
    if (!Number.isFinite(raw)) continue;
    target.llmScore = Math.max(0, Math.min(100, Math.round(raw)));
    const rationale = typeof a?.rationale === "string" ? a.rationale.trim() : "";
    const action = typeof a?.action === "string" ? a.action.trim() : "";
    if (rationale) target.llmRationale = rationale;
    if (action) target.llmAction = action;
    applied++;
  }
  return applied;
}

// Ranking key: LLM judgment wins when present, deterministic score otherwise.
// Kept here so the digest and any future consumer agree on precedence.
export function effectiveScore(o: Opportunity): number {
  return o.llmScore ?? o.score ?? 0;
}
