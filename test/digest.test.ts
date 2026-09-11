import { describe, it, expect } from "vitest";
import { buildDigest } from "../src/core/digest.js";
import type { Opportunity, OppChange } from "../src/core/types.js";

function opp(id: string, score: number, p: Partial<Opportunity> = {}): Opportunity {
  return {
    source: "treasury-forecast",
    id,
    fingerprint: `fp-${id}`,
    title: `Opportunity ${id}`,
    agency: "Treasury",
    bureau: "IRS",
    oppType: "New",
    url: "https://example.gov/" + id,
    fitTag: "direct-fit",
    matchedTerms: [],
    score,
    scoreReasons: ["direct fit", "core code 541512"],
    ...p,
  };
}

describe("buildDigest (non-baseline)", () => {
  it("leads with priorities, sorted best-first, and states the priority count in the subject", () => {
    const mail = buildDigest({
      newOpps: [opp("a", 40), opp("b", 88), opp("c", 72)],
      changedOpps: [],
      isBaseline: false,
      totalTracked: 3,
    });
    expect(mail.subject).toMatch(/2 priority of 3 new, 0 changed/);
    // "b" (88) before "c" (72) in the priorities block; "a" (40) is tail.
    expect(mail.text.indexOf("Opportunity b")).toBeLessThan(mail.text.indexOf("Opportunity c"));
    expect(mail.text).toMatch(/PRIORITIES/);
    expect(mail.text).toMatch(/ALSO NEW/);
  });

  it("caps the rendered priorities at 20 and reports the overflow", () => {
    const many = Array.from({ length: 30 }, (_, i) => opp(`p${i}`, 90 - i)); // all >= 61, 25 are >= 70
    const priorityCount = many.filter((o) => (o.score ?? 0) >= 70).length;
    const mail = buildDigest({ newOpps: many, changedOpps: [], isBaseline: false, totalTracked: 30 });
    // Only 20 full priority entries rendered (count "signals:" lines as a proxy).
    const signalLines = mail.text.split("\n").filter((l) => l.trim().startsWith("signals:"));
    expect(signalLines.length).toBe(20);
    expect(mail.text).toMatch(new RegExp(`${priorityCount - 20} more above threshold`));
  });

  it("ranks on the LLM's judgment when present, demoting a high deterministic score", () => {
    const mail = buildDigest({
      newOpps: [
        // Deterministic loves it, the LLM says it isn't this vendor's work.
        opp("overrated", 95, { llmScore: 20, llmRationale: "Generic help-desk staffing.", llmAction: "Skip" }),
        // Deterministic is lukewarm, the LLM says it's a real fit.
        opp("gem", 72, { llmScore: 91, llmRationale: "Direct payment transparency.", llmAction: "Send a capability statement." }),
      ],
      changedOpps: [],
      isBaseline: false,
      totalTracked: 2,
    });
    expect(mail.text.indexOf("Opportunity gem")).toBeLessThan(mail.text.indexOf("Opportunity overrated"));
    // The LLM's assessment and action reach the reader.
    expect(mail.text).toMatch(/assessment: Direct payment transparency\./);
    expect(mail.text).toMatch(/next: Send a capability statement\./);
    // Only the LLM-approved one clears the priority bar.
    expect(mail.subject).toMatch(/1 priority of 2 new/);
  });

  it("renders changed items with their field transitions", () => {
    const changed: OppChange[] = [
      { opp: opp("x", 75), changes: [{ field: "estimated value", from: "> $1M", to: "> $5M" }] },
    ];
    const mail = buildDigest({ newOpps: [], changedOpps: changed, isBaseline: false, totalTracked: 1 });
    expect(mail.text).toMatch(/CHANGED \(1\)/);
    expect(mail.text).toMatch(/estimated value: "> \$1M" -> "> \$5M"/);
    expect(mail.html).toMatch(/Changed \(1\)/);
  });
});

describe("buildDigest (baseline)", () => {
  it("summarizes counts and lists the top opportunities by score", () => {
    const mail = buildDigest({
      newOpps: [opp("a", 30, { fitTag: "adjacent" }), opp("b", 91), opp("c", 60)],
      changedOpps: [],
      isBaseline: true,
      totalTracked: 3,
    });
    expect(mail.subject).toMatch(/baseline: tracking 3 federal opportunities/);
    expect(mail.text).toMatch(/Direct fit: 2/);
    expect(mail.text).toMatch(/Adjacent: 1/);
    // highest score first in the "top opportunities" block
    expect(mail.text.indexOf("Opportunity b")).toBeLessThan(mail.text.indexOf("Opportunity c"));
  });
});
