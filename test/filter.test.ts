import { describe, it, expect } from "vitest";
import { classify, includeInDigest } from "../src/core/filter.js";
import type { Opportunity } from "../src/core/types.js";

function opp(partial: Partial<Opportunity>): Opportunity {
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
    ...partial,
  };
}

describe("classify", () => {
  it("tags a core NAICS as direct-fit", () => {
    const r = classify(opp({ title: "Systems design work", naics: "541512" }));
    expect(r.fitTag).toBe("direct-fit");
    expect(r.matchedTerms).toContain("naics:541512");
  });

  it("tags a direct keyword as direct-fit even without a code", () => {
    const r = classify(opp({ title: "Procure-to-pay platform", naics: "999999" }));
    expect(r.fitTag).toBe("direct-fit");
  });

  it("tags broader IT as adjacent", () => {
    const r = classify(opp({ title: "Cloud migration services", naics: "541519" }));
    expect(r.fitTag).toBe("adjacent");
  });

  it("demotes an adjacent match to other when an exclude term is present", () => {
    const r = classify(opp({ title: "Landscaping crew workflow automation" }));
    expect(r.fitTag).toBe("other");
  });

  it("keeps direct-fit even if an exclude term also appears", () => {
    const r = classify(opp({ title: "Payment processing platform for landscaping vendors" }));
    expect(r.fitTag).toBe("direct-fit");
  });

  it("treats canceled opportunities as other regardless of match", () => {
    const r = classify(opp({ title: "ERP system", naics: "541512", phase: "Canceled" }));
    expect(r.fitTag).toBe("other");
  });

  it("includeInDigest keeps direct-fit and drops other", () => {
    expect(includeInDigest(opp({ fitTag: "direct-fit" }))).toBe(true);
    expect(includeInDigest(opp({ fitTag: "other" }))).toBe(false);
  });
});
