import { describe, it, expect } from "vitest";
import { assessEligibility, summarizeEligibility, type CompanyStatus } from "../src/core/eligibility.js";

const NOTHING: CompanyStatus = { samRegistered: false, certifications: [] };
const REGISTERED: CompanyStatus = { samRegistered: true, certifications: [] };

describe("assessEligibility", () => {
  it("treats the live 'None' value as full and open", () => {
    // 1,359 of 1,943 live items say exactly this, so it is the hot path.
    expect(assessEligibility("None", NOTHING).level).toBe("open");
  });

  it("blocks each certification set-aside the company does not hold", () => {
    for (const raw of ["8(a)", "8(a)/SDB", "HUBZone", "SDVOSB", "WOSB"]) {
      const e = assessEligibility(raw, NOTHING);
      expect(e.level, `${raw} should be cert-blocked`).toBe("blocked-cert");
      expect(e.primeReachable).toBe(false);
    }
  });

  it("checks certifications BEFORE the small-business pattern", () => {
    // "8(a) Small Business Set-Aside" contains "small business"; reading it as a
    // plain SB set-aside would wrongly mark it reachable.
    const e = assessEligibility("8(a) Small Business Set-Aside", REGISTERED);
    expect(e.level).toBe("blocked-cert");
    expect(e.requiredCertification).toBe("8(a)");
  });

  it("does not guess when the set-aside type is unstated", () => {
    // 45 live items say exactly "Set-aside" and nothing more.
    const e = assessEligibility("Set-aside", NOTHING);
    expect(e.level).toBe("unknown");
    expect(e.primeReachable).toBe(false);
  });

  it("reports an absent set-aside as unknown rather than open", () => {
    expect(assessEligibility(undefined, NOTHING).level).toBe("unknown");
    expect(assessEligibility("", NOTHING).level).toBe("unknown");
  });

  it("treats a small-business set-aside as reachable only once SAM-registered", () => {
    expect(assessEligibility("SB", NOTHING).primeReachable).toBe(false);
    expect(assessEligibility("SB", REGISTERED).primeReachable).toBe(true);
    expect(assessEligibility("SB", REGISTERED).level).toBe("sb-set-aside");
  });

  it("unblocks a certification once it is actually held", () => {
    const holder: CompanyStatus = { samRegistered: true, certifications: ["8(a)"] };
    const e = assessEligibility("8(a)", holder);
    expect(e.level).toBe("open");
    expect(e.primeReachable).toBe(true);
  });

  it("mentions the SAM gate in the detail until registration exists", () => {
    expect(assessEligibility("None", NOTHING).detail).toMatch(/SAM\.gov/);
    expect(assessEligibility("None", REGISTERED).detail).not.toMatch(/SAM\.gov/);
  });

  it("never reports anything as prime-reachable while unregistered", () => {
    for (const raw of ["None", "SB", "8(a)", "Set-aside", undefined, "Full and Open"]) {
      expect(assessEligibility(raw, NOTHING).primeReachable, `${raw}`).toBe(false);
    }
  });
});

describe("summarizeEligibility", () => {
  it("counts every level across a set", () => {
    const s = summarizeEligibility(["None", "None", "SB", "8(a)", "Set-aside", undefined], NOTHING);
    expect(s).toEqual({ open: 2, "sb-set-aside": 1, "blocked-cert": 1, unknown: 2 });
  });
});
