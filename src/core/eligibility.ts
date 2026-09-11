// Can we actually bid this?
//
// Score answers "is this worth wanting". Eligibility answers the prior
// question: is it reachable at all. They are independent, and conflating them
// is how a beautifully-scored 8(a) set-aside wastes an afternoon.
//
// The facts live in config/company.json, NOT in this file. They are the same
// ones stated in prose in config/profile.md: the profile drives LLM scoring,
// this drives the deterministic dashboard badges, and they must agree.
//
// WHEN THE FACTS CHANGE, EDIT config/company.json AND NOTHING ELSE. Registering
// in SAM.gov flips `samRegistered` to true and every "needs SAM" badge in the
// dashboard clears on the next load.

import { readFileSync } from "node:fs";
import { paths } from "../config.js";

export interface CompanyStatus {
  /** Active SAM.gov registration with a UEI. Without it no federal award can be received. */
  samRegistered: boolean;
  /** Socioeconomic certifications actually HELD (not merely qualified for). */
  certifications: string[];
}

const loaded = JSON.parse(readFileSync(paths.company, "utf8")) as Partial<CompanyStatus>;

export const COMPANY_STATUS: CompanyStatus = {
  samRegistered: loaded.samRegistered === true,
  certifications: Array.isArray(loaded.certifications) ? loaded.certifications : [],
};

export type EligibilityLevel = "open" | "sb-set-aside" | "blocked-cert" | "unknown";

export interface Eligibility {
  level: EligibilityLevel;
  /** Short badge text. */
  label: string;
  /** One line explaining what stands between us and a bid. */
  detail: string;
  /** Could we prime this today, given current registration and certifications? */
  primeReachable: boolean;
  /** The certification this set-aside demands, when it demands one. */
  requiredCertification?: string;
}

// Certification-restricted set-asides. Checked BEFORE the generic small-business
// test, because "8(a) Small Business Set-Aside" contains the words "small
// business" and would otherwise be mistaken for one.
const CERT_PATTERNS: Array<{ cert: string; re: RegExp }> = [
  { cert: "8(a)", re: /8\s*\(?\s*a\s*\)?/i },
  { cert: "HUBZone", re: /hub\s*zone/i },
  { cert: "SDVOSB", re: /sdvosb|service[\s-]?disabled/i },
  { cert: "WOSB", re: /wosb|wo?men[\s-]?owned/i },
  { cert: "VOSB", re: /vosb|veteran[\s-]?owned/i },
  { cert: "Tribal/ANC/NHO", re: /tribal|alaska\s*native|native\s*hawaiian|\banc\b|\bnho\b/i },
];

const SB_PATTERN = /small\s*business|^\s*sb\s*$|\btsb\b/i;
const OPEN_PATTERN = /full\s*(and|&)\s*open|unrestricted|^\s*(none|n\/a|no)\s*$|no\s*set[\s-]?aside/i;

// 45 live items say exactly "Set-aside" and nothing more. That means a
// restriction exists but not which one, so it must NOT be read as a small
// business set-aside: guessing generously here is how you spend an afternoon
// on something reserved for a certification we do not hold.
const BARE_SET_ASIDE = /^\s*set[\s-]?asides?\s*$/i;

const SAM_CAVEAT = "No SAM.gov registration or UEI, so no federal award can be received yet.";

/**
 * Classify one opportunity's set-aside against what the company can actually
 * pursue. Unknown set-aside is reported as unknown rather than guessed: a wrong
 * "open" here is more expensive than an honest blank.
 */
export function assessEligibility(
  setAside: string | undefined,
  status: CompanyStatus = COMPANY_STATUS
): Eligibility {
  const raw = (setAside ?? "").trim();

  if (!raw) {
    return {
      level: "unknown",
      label: "Not stated",
      detail: status.samRegistered
        ? "The source did not state a set-aside. Confirm before investing time."
        : `The source did not state a set-aside. ${SAM_CAVEAT}`,
      primeReachable: false,
    };
  }

  for (const { cert, re } of CERT_PATTERNS) {
    if (!re.test(raw)) continue;
    const held = status.certifications.some((c) => c.toLowerCase() === cert.toLowerCase());
    if (held) {
      return {
        level: "open",
        label: `${cert} held`,
        detail: status.samRegistered
          ? `Reserved for ${cert}, which the company holds.`
          : `Reserved for ${cert}, which the company holds. ${SAM_CAVEAT}`,
        primeReachable: status.samRegistered,
        requiredCertification: cert,
      };
    }
    return {
      level: "blocked-cert",
      label: `${cert} required`,
      detail: `Reserved for ${cert}, which the company does not hold. Not primeable; a teaming or subcontract angle is the only route.`,
      primeReachable: false,
      requiredCertification: cert,
    };
  }

  if (OPEN_PATTERN.test(raw)) {
    return {
      level: "open",
      label: "Full and open",
      detail: status.samRegistered
        ? "No set-aside restriction."
        : `No set-aside restriction. ${SAM_CAVEAT}`,
      primeReachable: status.samRegistered,
    };
  }

  if (BARE_SET_ASIDE.test(raw)) {
    return {
      level: "unknown",
      label: "Set-aside, type unstated",
      detail: `The source says this is set aside but not for whom. Check the source before investing time; it may require a certification the company does not hold. ${
        status.samRegistered ? "" : SAM_CAVEAT
      }`.trim(),
      primeReachable: false,
    };
  }

  if (SB_PATTERN.test(raw)) {
    return {
      level: "sb-set-aside",
      label: "Small business",
      detail: status.samRegistered
        ? "Small-business set-aside. The company meets the SBA size standard for its NAICS codes and self-certifies."
        : `Small-business set-aside. The company meets the size standard, so this unlocks on registration. ${SAM_CAVEAT}`,
      primeReachable: status.samRegistered,
    };
  }

  return {
    level: "unknown",
    label: raw.length > 24 ? `${raw.slice(0, 24)}...` : raw,
    detail: status.samRegistered
      ? `Unrecognized set-aside "${raw}". Check the source before investing time.`
      : `Unrecognized set-aside "${raw}". ${SAM_CAVEAT}`,
    primeReachable: false,
  };
}

/** Count each eligibility level across a set, for the dashboard's summary row. */
export function summarizeEligibility(
  setAsides: Array<string | undefined>,
  status: CompanyStatus = COMPANY_STATUS
): Record<EligibilityLevel, number> {
  const out: Record<EligibilityLevel, number> = {
    open: 0,
    "sb-set-aside": 0,
    "blocked-cert": 0,
    unknown: 0,
  };
  for (const s of setAsides) out[assessEligibility(s, status).level]++;
  return out;
}
