import { describe, it, expect } from "vitest";
import { normalizeDhsRecord } from "../src/sources/dhsForecast.js";

// A real record shape captured from the live DHS APFS forecast API (CBP).
const cbp = {
  id: 73831,
  apfs_number: "F2026073831",
  requirements_title: "NASOC San Angelo MU2 Hangar Renovation",
  requirement: "<p>Renovation of hangar MU2.</p>",
  organization: "CBP",
  naics: "236220 - Commercial and Institutional Building Construction",
  dollar_range: { display_name: "$5M to $10M", display_order: 7 },
  small_business_program: "SB",
  small_business_set_aside: null,
  award_quarter: "Q4 2026",
  fiscal_year: 2026,
  estimated_solicitation_release_date: "07/01/2026",
  estimated_period_of_performance_start: "09/01/2026",
  estimated_period_of_performance_end: "09/01/2029",
  contract_status: "NEW",
  contractor: null,
  contract_vehicle: "TBD",
  place_of_performance_state: "TX",
  requirements_contact_first_name: "Michael",
  requirements_contact_last_name: "Haskins",
  requirements_contact_email: "michael.l.haskins@cbp.dhs.gov",
};

describe("normalizeDhsRecord", () => {
  it("maps core fields from a real record", () => {
    const o = normalizeDhsRecord(cbp);
    expect(o.source).toBe("dhs-apfs");
    expect(o.id).toBe("73831");
    expect(o.agency).toBe("DHS");
    expect(o.bureau).toBe("CBP");
    expect(o.naics).toBe("236220");
    expect(o.estValue).toBe("$5M to $10M");
    expect(o.setAside).toBe("SB");
    expect(o.url).toBe("https://apfs-cloud.dhs.gov/record/73831/public-print/");
  });

  it("normalizes the quarter-first award_quarter to canonical FY form", () => {
    // "Q4 2026" -> "FY 2026 Q4" so the scorer's timing parser understands it.
    expect(normalizeDhsRecord(cbp).awardQuarter).toBe("FY 2026 Q4");
  });

  it("maps REC status to a Recompete", () => {
    expect(normalizeDhsRecord({ ...cbp, contract_status: "REC" }).oppType).toBe("Recompete");
    expect(normalizeDhsRecord({ ...cbp, contract_status: "NEW" }).oppType).toBe("New");
  });

  it("flags an NLR (No Longer Required) record inactive so it gets dropped", () => {
    expect(normalizeDhsRecord({ ...cbp, contract_status: "NLR" }).active).toBe(false);
    expect(normalizeDhsRecord(cbp).active).toBe(true);
  });

  it("strips HTML and treats 'None'/'TBD' set-aside as None", () => {
    const o = normalizeDhsRecord({ ...cbp, requirement: "<p>Hi &amp; bye</p>", small_business_program: "TBD" });
    expect(o.description).toBe("Hi & bye");
    expect(o.setAside).toBe("None");
  });

  it("builds a combined POC with name and email", () => {
    expect(normalizeDhsRecord(cbp).bureauPoc).toBe("Michael Haskins <michael.l.haskins@cbp.dhs.gov>");
  });

  it("carries the incumbent through when present", () => {
    expect(normalizeDhsRecord({ ...cbp, contractor: "Acme LLC" }).incumbent).toBe("Acme LLC");
    expect(normalizeDhsRecord(cbp).incumbent).toBeUndefined();
  });
});
