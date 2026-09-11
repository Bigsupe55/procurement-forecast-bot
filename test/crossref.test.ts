import { describe, it, expect } from "vitest";
import { crossReference } from "../src/core/crossref.js";
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
    fitTag: "direct-fit",
    matchedTerms: [],
    ...p,
  };
}

describe("crossReference", () => {
  it("confirms a predicted item that matches a forecast item", () => {
    const forecast = [
      opp({ id: "f1", naics: "541512", title: "Enterprise financial management system modernization support" }),
    ];
    const predicted = [
      opp({
        id: "p1",
        source: "usaspending-predict",
        oppType: "Predicted",
        naics: "541512",
        title: "Enterprise financial management system modernization services",
      }),
    ];
    const r = crossReference(forecast, predicted);
    expect(r.predicted[0]?.crossRef).toBe("confirmed");
    expect(r.forecast[0]?.crossRef).toBe("confirmed");
  });

  it("flags an unmatched predicted item as predicted-not-forecasted", () => {
    const forecast = [opp({ id: "f1", naics: "541512", title: "Snow plow telemetry dashboard" })];
    const predicted = [
      opp({
        id: "p1",
        source: "usaspending-predict",
        oppType: "Predicted",
        naics: "541511",
        title: "Completely different cybersecurity operations center",
      }),
    ];
    const r = crossReference(forecast, predicted);
    expect(r.predicted[0]?.crossRef).toBe("predicted-not-forecasted");
    expect(r.forecast[0]?.crossRef).toBe("forecast-only");
  });
});
