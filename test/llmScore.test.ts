import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  llmScoreShortlist,
  mergeAssessments,
  effectiveScore,
  renderItems,
  type MessageCreator,
} from "../src/core/llmScore.js";
import { config } from "../src/config.js";
import type { Opportunity } from "../src/core/types.js";

function opp(id: string, score: number, p: Partial<Opportunity> = {}): Opportunity {
  return {
    source: "treasury-forecast",
    id,
    fingerprint: `fp-${id}`,
    title: `Opportunity ${id}`,
    agency: "Treasury",
    bureau: "IRS",
    oppType: "New",
    url: "",
    fitTag: "direct-fit",
    matchedTerms: [],
    score,
    scoreReasons: ["direct fit"],
    ...p,
  };
}

// A fake client standing in for the SDK — no network, no API key.
function fakeClient(response: unknown, onBody?: (b: any) => void): MessageCreator {
  return {
    messages: {
      create: async (body: Record<string, unknown>) => {
        onBody?.(body);
        return response;
      },
    },
  };
}

function jsonResponse(assessments: unknown[], extra: Record<string, unknown> = {}) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ assessments }) }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900 },
    ...extra,
  };
}

const originalEnable = config.enableLlm;
const originalKey = config.llm.apiKey;
const originalMax = config.llm.maxItems;

beforeEach(() => {
  config.enableLlm = true;
  config.llm.apiKey = "test-key";
  config.llm.maxItems = 40;
});
afterEach(() => {
  config.enableLlm = originalEnable;
  config.llm.apiKey = originalKey;
  config.llm.maxItems = originalMax;
});

describe("llmScoreShortlist — inactive by default", () => {
  it("does nothing and calls no API when the pass is disabled", async () => {
    config.enableLlm = false;
    let called = false;
    const items = [opp("a", 90)];
    const r = await llmScoreShortlist(items, fakeClient(jsonResponse([]), () => (called = true)));
    expect(called).toBe(false);
    expect(r.attempted).toBe(0);
    expect(r.note).toMatch(/disabled/);
    expect(items[0]!.llmScore).toBeUndefined();
  });

  it("skips cleanly when no API key is configured", async () => {
    config.llm.apiKey = "";
    const r = await llmScoreShortlist([opp("a", 90)]); // no injected client → would need a key
    expect(r.attempted).toBe(0);
    expect(r.note).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("llmScoreShortlist — happy path", () => {
  it("attaches score, rationale, and action to the matching opportunity", async () => {
    const items = [opp("a", 90), opp("b", 80)];
    const r = await llmScoreShortlist(
      items,
      fakeClient(
        jsonResponse([
          { id: "fp-a", score: 88, rationale: "Direct payment-transparency work.", action: "Respond to the RFI." },
          { id: "fp-b", score: 12, rationale: "Generic help-desk staffing.", action: "Skip" },
        ])
      )
    );
    expect(r.scored).toBe(2);
    expect(items[0]!.llmScore).toBe(88);
    expect(items[0]!.llmAction).toBe("Respond to the RFI.");
    expect(items[1]!.llmScore).toBe(12);
    expect(items[1]!.llmRationale).toMatch(/help-desk/);
    expect(r.usage?.cacheReadTokens).toBe(900);
  });

  it("caps the shortlist at maxItems, strongest deterministic score first", async () => {
    config.llm.maxItems = 2;
    let sentBody: any;
    const items = [opp("low", 10), opp("high", 99), opp("mid", 50)];
    await llmScoreShortlist(items, fakeClient(jsonResponse([]), (b) => (sentBody = b)));
    const prompt = sentBody.messages[0].content as string;
    expect(prompt).toContain("fp-high");
    expect(prompt).toContain("fp-mid");
    expect(prompt).not.toContain("fp-low"); // beyond the cap
  });

  it("sends the configured model and caches the capability profile", async () => {
    let sentBody: any;
    await llmScoreShortlist([opp("a", 90)], fakeClient(jsonResponse([]), (b) => (sentBody = b)));
    expect(sentBody.model).toBe("claude-opus-5");
    expect(sentBody.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sentBody.output_config.format.type).toBe("json_schema");
  });
});

describe("llmScoreShortlist — degrades safely", () => {
  it("survives a thrown API error and leaves deterministic scores intact", async () => {
    const items = [opp("a", 90)];
    const boom: MessageCreator = {
      messages: { create: async () => { throw new Error("connection reset"); } },
    };
    const r = await llmScoreShortlist(items, boom);
    expect(r.scored).toBe(0);
    expect(r.note).toMatch(/connection reset/);
    expect(items[0]!.llmScore).toBeUndefined();
    expect(items[0]!.score).toBe(90); // untouched
  });

  it("handles a safety refusal without throwing", async () => {
    const r = await llmScoreShortlist([opp("a", 90)], fakeClient({ stop_reason: "refusal", content: [] }));
    expect(r.scored).toBe(0);
    expect(r.note).toMatch(/refus/i);
  });

  it("handles a truncated response", async () => {
    const r = await llmScoreShortlist([opp("a", 90)], fakeClient({ stop_reason: "max_tokens", content: [] }));
    expect(r.scored).toBe(0);
    expect(r.note).toMatch(/truncated/);
  });

  it("handles malformed JSON", async () => {
    const items = [opp("a", 90)];
    const r = await llmScoreShortlist(
      items,
      fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "{not json" }] })
    );
    expect(r.scored).toBe(0);
    expect(items[0]!.llmScore).toBeUndefined();
  });
});

describe("mergeAssessments", () => {
  it("ignores hallucinated refs and clamps out-of-range scores", () => {
    const items = [opp("a", 90), opp("b", 80)];
    const applied = mergeAssessments(
      items,
      JSON.stringify({
        assessments: [
          { id: "fp-a", score: 250, rationale: "x", action: "y" },
          { id: "fp-ghost", score: 70, rationale: "x", action: "y" },
          { id: "fp-b", score: -40, rationale: "x", action: "y" },
        ],
      })
    );
    expect(applied).toBe(2); // ghost dropped
    expect(items[0]!.llmScore).toBe(100);
    expect(items[1]!.llmScore).toBe(0);
  });

  it("leaves an item alone when its score is not a number", () => {
    const items = [opp("a", 90)];
    mergeAssessments(items, JSON.stringify({ assessments: [{ id: "fp-a", score: "high" }] }));
    expect(items[0]!.llmScore).toBeUndefined();
  });
});

describe("effectiveScore", () => {
  it("prefers the LLM score, falling back to deterministic", () => {
    expect(effectiveScore(opp("a", 90, { llmScore: 30 }))).toBe(30);
    expect(effectiveScore(opp("b", 90))).toBe(90);
    expect(effectiveScore(opp("c", 0, { llmScore: 0 }))).toBe(0);
  });
});

describe("renderItems", () => {
  it("includes the join key and the requirement text, truncating long descriptions", () => {
    const text = renderItems([opp("a", 90, { description: "x".repeat(900), naics: "541512" })]);
    expect(text).toContain("ref: fp-a");
    expect(text).toContain("naics: 541512");
    expect(text.length).toBeLessThan(900); // description capped
  });
});
