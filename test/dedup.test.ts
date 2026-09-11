import { describe, it, expect } from "vitest";
import { diffAndUpdate } from "../src/core/dedup.js";
import type { Opportunity } from "../src/core/types.js";
import type { SeenMap } from "../src/core/state.js";

function opp(id: string, watchedValue?: string): Opportunity {
  return {
    source: "treasury-forecast",
    id,
    fingerprint: `fp-${id}`,
    title: id,
    agency: "Treasury",
    oppType: "New",
    url: "",
    fitTag: "direct-fit",
    matchedTerms: [],
    watchedValue,
  };
}

describe("diffAndUpdate", () => {
  it("first run is a baseline and everything is new", () => {
    const seen: SeenMap = {};
    const r = diffAndUpdate([opp("a"), opp("b")], seen, "2026-01-01T00:00:00Z");
    expect(r.isBaseline).toBe(true);
    expect(r.newOpps.length).toBe(2);
    expect(Object.keys(seen).length).toBe(2);
  });

  it("a second identical run reports nothing new or changed", () => {
    const seen: SeenMap = {};
    diffAndUpdate([opp("a", "v1")], seen, "2026-01-01T00:00:00Z");
    const r2 = diffAndUpdate([opp("a", "v1")], seen, "2026-01-08T00:00:00Z");
    expect(r2.isBaseline).toBe(false);
    expect(r2.newOpps.length).toBe(0);
    expect(r2.changedOpps.length).toBe(0);
  });

  it("detects a changed watched value", () => {
    const seen: SeenMap = {};
    diffAndUpdate([opp("a", "> $1M")], seen, "2026-01-01T00:00:00Z");
    const r2 = diffAndUpdate([opp("a", "> $5M")], seen, "2026-01-08T00:00:00Z");
    expect(r2.changedOpps.length).toBe(1);
    expect(r2.changedOpps[0]?.changes[0]?.field).toBe("estimated value");
  });
});
