import { describe, it, expect } from "vitest";
import { score, scoreAndRank, parseDollarsCeiling, parseFyQuarter, WORTH_ACTING_ON } from "../src/core/score.js";
import type { Opportunity } from "../src/core/types.js";

function opp(p: Partial<Opportunity>): Opportunity {
  return {
    source: "treasury-forecast",
    id: "x",
    fingerprint: "fp",
    title: "",
    agency: "Treasury",
    oppType: "New",
    url: "",
    fitTag: "other",
    matchedTerms: [],
    active: true,
    ...p,
  };
}

// A fixed "now" so timing-based points are deterministic across calendar time.
const NOW = new Date("2026-07-29T00:00:00Z");

describe("parseDollarsCeiling", () => {
  it("parses an exact comma-grouped amount (predictor format)", () => {
    expect(parseDollarsCeiling("$1,234,567")).toBe(1_234_567);
  });
  it("takes the ceiling of a Treasury band", () => {
    expect(parseDollarsCeiling("> $2M to < or = $5M")).toBe(5_000_000);
    expect(parseDollarsCeiling("> $10K to < or = $250K")).toBe(250_000);
    expect(parseDollarsCeiling(">  $100M")).toBe(100_000_000);
  });
  it("takes the ceiling of a Gateway band, incl. billions and 'Below'", () => {
    expect(parseDollarsCeiling("$1M - $1.9M")).toBe(1_900_000);
    expect(parseDollarsCeiling("$1B - $1.9B")).toBe(1_900_000_000);
    expect(parseDollarsCeiling("Below $150K")).toBe(150_000);
  });
  it("returns undefined for TBD / empty", () => {
    expect(parseDollarsCeiling("To Be Determined")).toBeUndefined();
    expect(parseDollarsCeiling(undefined)).toBeUndefined();
  });
});

describe("parseFyQuarter", () => {
  it("maps a fiscal quarter to an approximate calendar date", () => {
    // FY2025 Q4 = Jul-Sep 2025 -> ~Aug 2025
    expect(parseFyQuarter("FY 2025 Q4")?.getUTCFullYear()).toBe(2025);
    expect(parseFyQuarter("FY 2025 Q4")?.getUTCMonth()).toBe(7); // Aug (0-indexed)
    // FY2026 Q1 = Oct-Dec 2025 (prior calendar year)
    expect(parseFyQuarter("FY 2026 Q1")?.getUTCFullYear()).toBe(2025);
  });
  it("returns undefined for junk", () => {
    expect(parseFyQuarter("someday")).toBeUndefined();
    expect(parseFyQuarter(undefined)).toBeUndefined();
  });
});

describe("score", () => {
  it("floors a dead (awarded/cancelled) opportunity to 0 even if it's a direct fit", () => {
    const r = score(opp({ fitTag: "direct-fit", naics: "541512", phase: "Awarded" }), NOW);
    expect(r.score).toBe(0);
    // and it catches the British spelling classify()'s exact check misses
    expect(score(opp({ fitTag: "direct-fit", phase: "Cancelled" }), NOW).score).toBe(0);
  });

  it("scores a strong direct-fit recompete far above a bare adjacent item", () => {
    const strong = score(
      opp({
        fitTag: "direct-fit",
        naics: "541512",
        title: "Enterprise financial management system modernization",
        estValue: "> $5M to < or = $10M",
        phase: "Market Research",
        awardQuarter: "FY 2027 Q1",
        oppType: "Recompete",
        incumbent: "Acme Corp",
      }),
      NOW
    );
    const weak = score(opp({ fitTag: "adjacent", naics: "541519", title: "Cloud migration" }), NOW);
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeGreaterThanOrEqual(80); // big-dollar warm direct fit clears priority comfortably
    expect(weak.score).toBeLessThan(WORTH_ACTING_ON); // bare adjacent item is tail, not priority
  });

  it("gives a core code more weight than an adjacent code", () => {
    const core = score(opp({ fitTag: "direct-fit", naics: "541512" }), NOW).score;
    const adj = score(opp({ fitTag: "direct-fit", naics: "541519" }), NOW).score;
    expect(core).toBeGreaterThan(adj);
  });

  it("applies an exclude penalty to a direct fit carrying a physical-service term", () => {
    const clean = score(opp({ fitTag: "direct-fit", title: "payment processing platform" }), NOW).score;
    const dirty = score(
      opp({ fitTag: "direct-fit", title: "payment processing platform for the vehicle fleet fuel program" }),
      NOW
    ).score;
    expect(dirty).toBeLessThan(clean);
  });

  it("rewards a cross-referenced confirmation and surfaces the reason", () => {
    const confirmed = score(opp({ fitTag: "direct-fit", naics: "541512", crossRef: "confirmed" }), NOW);
    const only = score(opp({ fitTag: "direct-fit", naics: "541512", crossRef: "forecast-only" }), NOW);
    expect(confirmed.score).toBeGreaterThan(only.score);
    expect(confirmed.scoreReasons.join(" ")).toMatch(/confirmed/i);
  });

  it("uses expiration proximity for predictor items", () => {
    const soon = score(
      opp({ source: "usaspending-predict", oppType: "Predicted", fitTag: "direct-fit", naics: "541512", popEnd: "2026-10-01" }),
      NOW
    ).score;
    const later = score(
      opp({ source: "usaspending-predict", oppType: "Predicted", fitTag: "direct-fit", naics: "541512", popEnd: "2027-12-01" }),
      NOW
    ).score;
    expect(soon).toBeGreaterThan(later);
  });

  it("caps at 100 and floors at 0", () => {
    const maxed = score(
      opp({
        fitTag: "direct-fit",
        naics: "541512",
        psc: "DA01",
        title: "financial management system erp procure-to-pay payments modernization general ledger",
        estValue: "> $100M",
        phase: "Market Research",
        awardQuarter: "FY 2027 Q1",
        oppType: "Recompete",
        incumbent: "Acme",
        setAside: "SB",
      }),
      NOW
    );
    expect(maxed.score).toBeLessThanOrEqual(100);
    expect(maxed.score).toBeGreaterThan(0);
  });
});

describe("scoreAndRank", () => {
  it("returns items sorted best-first", () => {
    const ranked = scoreAndRank(
      [
        opp({ id: "weak", fitTag: "adjacent", naics: "541519", title: "cloud migration" }),
        opp({ id: "strong", fitTag: "direct-fit", naics: "541512", title: "financial system", estValue: "> $5M to < or = $10M", phase: "Market Research", oppType: "Recompete" }),
      ],
      NOW
    );
    expect(ranked[0]?.id).toBe("strong");
    expect(ranked[1]?.id).toBe("weak");
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });
});
