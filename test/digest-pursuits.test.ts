import { describe, it, expect } from "vitest";
import { buildDigest, type PursuitItem } from "../src/core/digest.js";
import type { Opportunity } from "../src/core/types.js";

function opp(id: string, score: number, over: Partial<Opportunity> = {}): Opportunity {
  return {
    source: "treasury-forecast",
    id,
    fingerprint: `fp-${id}`,
    title: id,
    agency: "Treasury",
    bureau: "IRS",
    oppType: "New",
    url: "https://example.gov/x",
    fitTag: "direct-fit",
    matchedTerms: [],
    score,
    scoreReasons: [],
    ...over,
  };
}

const base = { newOpps: [opp("new-item", 88)], changedOpps: [], isBaseline: false, totalTracked: 10 };

describe("digest pursuits section", () => {
  it("renders nothing extra when there are no pursuits", () => {
    const mail = buildDigest(base);
    expect(mail.text).not.toContain("YOUR PURSUITS");
    expect(mail.html).not.toContain("Your pursuits");
  });

  it("leads with the standing worklist when items are marked", () => {
    const pursuits: PursuitItem[] = [{ opp: opp("chasing", 71), state: "pursue", note: "call the PoC" }];
    const mail = buildDigest({ ...base, pursuits });
    expect(mail.text).toContain("YOUR PURSUITS (1)");
    expect(mail.text).toContain("[PURSUE]");
    expect(mail.text).toContain("call the PoC");
    // It must come before the priorities block, which is the whole point.
    expect(mail.text.indexOf("YOUR PURSUITS")).toBeLessThan(mail.text.indexOf("PRIORITIES"));
  });

  it("orders pursue ahead of watch regardless of score", () => {
    const pursuits: PursuitItem[] = [
      { opp: opp("watched", 99), state: "watch" },
      { opp: opp("chased", 40), state: "pursue" },
    ];
    const mail = buildDigest({ ...base, pursuits });
    expect(mail.text.indexOf("chased")).toBeLessThan(mail.text.indexOf("watched"));
  });

  it("escapes pursued titles in the HTML body", () => {
    const pursuits: PursuitItem[] = [{ opp: opp("<script>x</script>", 71), state: "pursue" }];
    const mail = buildDigest({ ...base, pursuits });
    expect(mail.html).not.toContain("<script>x</script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("renders a note only when one exists", () => {
    const mail = buildDigest({ ...base, pursuits: [{ opp: opp("bare", 71), state: "watch" }] });
    expect(mail.text).toContain("[WATCH]");
    expect(mail.text).not.toContain("note:");
  });
});
