// Deterministic priority scoring. classify() decides IF an opportunity is
// relevant (direct/adjacent/other); score() decides HOW MUCH it is worth acting
// on THIS week, so the digest can rank a large "relevant" set down to the few
// leads that deserve attention. No AI — every point is traceable to a rule, and
// each opportunity carries the short reasons behind its score.
//
// Score is 0-100, a weighted sum of signals aligned to the bot's thesis
// (engage EARLY, on real money, where there is an incumbent to displace).
//
// The federal IT/financial-systems forecast is dominated by direct-fit items, so
// fit alone cannot rank — nearly everything is a "direct fit". The weights below
// therefore keep fit/code as a GATE (modest points) and let the real
// discriminators (dollar size, warmth/incumbent, timing) drive the spread:
//
//   dollar size      up to 25   bigger prize — the top discriminator for BD time
//   fit tier         up to 20   direct-fit vs adjacent (the gate)
//   recompete/xref   up to 15   confirmed by both streams, or recompete w/ incumbent
//   code precision   up to 12   exact NAICS/PSC match (higher-confidence than keywords)
//   timing           up to 12   imminent & future award window (or near expiration)
//   phase            up to  8   early acquisition phase (still shapeable)
//   keyword density  up to  8   how many distinct direct terms fired
//   set-aside        up to  3   small-business-friendly (mild, and surfaced)
//   exclude penalty  up to -20  physical/field-service terms that slipped through
//
// A dead opportunity (canceled/closed/already-awarded) scores 0 so it can never
// surface, catching the ones classify()'s exact "canceled" check misses
// (e.g. the Gateway's "Cancelled" / "Awarded").

import { readFileSync } from "node:fs";
import { paths } from "../config.js";
import type { Opportunity } from "./types.js";

interface Codes {
  naics: { direct: string[]; adjacent: string[] };
  psc: { direct: string[]; adjacent: string[] };
}
interface Keywords {
  direct: string[];
  adjacent: string[];
  exclude: string[];
}

const codes: Codes = JSON.parse(readFileSync(paths.codes, "utf8"));
const keywords: Keywords = JSON.parse(readFileSync(paths.keywords, "utf8"));

const directNaics = new Set(codes.naics.direct);
const adjacentNaics = new Set(codes.naics.adjacent);
const directPsc = new Set(codes.psc.direct);
const adjacentPsc = new Set(codes.psc.adjacent);

// Score at/above which an item is a "priority" — genuinely worth acting on:
// reaching it needs the direct-fit + core-code gate (32) PLUS real money and/or
// warmth (big dollars, an imminent window, a recompete/incumbent to displace).
// A modest direct fit with far-off timing and no incumbent lands below it.
export const WORTH_ACTING_ON = 70;

export interface Scored extends Opportunity {
  score: number;
  scoreReasons: string[];
}

export function score(opp: Opportunity, now: Date = new Date()): Scored {
  const reasons: string[] = [];
  const text = `${opp.title} ${opp.description ?? ""}`.toLowerCase();

  // --- Dead short-circuit: never surface an award that already happened or was
  // pulled. Covers the phases classify()'s exact-match check lets through.
  if (isDeadPhase(opp)) {
    return { ...opp, score: 0, scoreReasons: [`inactive (${opp.phase || "closed/awarded"})`] };
  }

  let s = 0;

  // 1. Fit tier — the gate. Modest points: in this domain almost everything is a
  // direct fit, so fit qualifies an item but does not rank it.
  if (opp.fitTag === "direct-fit") {
    s += 20;
    reasons.push("direct fit");
  } else if (opp.fitTag === "adjacent") {
    s += 8;
    reasons.push("adjacent fit");
  }

  // 2. Code precision — an exact NAICS/PSC match is higher-confidence than a
  // substring keyword hit, so it earns more than the keyword density below.
  const naicsDirect = opp.naics ? directNaics.has(opp.naics) : false;
  const naicsAdj = opp.naics ? adjacentNaics.has(opp.naics) : false;
  const pscDirect = opp.psc ? directPsc.has(opp.psc) : false;
  const pscAdj = opp.psc ? adjacentPsc.has(opp.psc) : false;
  if (naicsDirect || pscDirect) {
    s += 12;
    reasons.push(`core code ${naicsDirect ? opp.naics : opp.psc}`);
  } else if (naicsAdj || pscAdj) {
    s += 5;
    reasons.push(`adjacent code ${naicsAdj ? opp.naics : opp.psc}`);
  }

  // 3. Keyword density — reward multiple distinct direct terms.
  const directKw = keywords.direct.filter((k) => text.includes(k.toLowerCase()));
  const adjacentKw = keywords.adjacent.filter((k) => text.includes(k.toLowerCase()));
  const kwPoints = Math.min(6, 2 * directKw.length) + (adjacentKw.length > 0 ? 1 : 0);
  s += Math.min(8, kwPoints);
  if (directKw.length > 0) {
    reasons.push(directKw.length === 1 ? `matches "${directKw[0]}"` : `${directKw.length} core terms`);
  }

  // 4. Dollar size — the top discriminator for where to spend limited BD time.
  // Parse a representative ceiling from whatever format the source used (exact
  // number, "> $2M to <= $5M" band, "$1M - $1.9M" band).
  const ceil = parseDollarsCeiling(opp.estValue);
  s += dollarScore(ceil);
  if (ceil !== undefined && ceil >= 1_000_000) reasons.push(shortDollars(ceil));

  // 5. Phase + award timing — the "engage early" thesis.
  const { pts: phasePts, reason: phaseReason } = phaseScore(opp);
  s += phasePts;
  if (phaseReason) reasons.push(phaseReason);
  const { pts: timePts, reason: timeReason } = timingScore(opp, now);
  s += timePts;
  if (timeReason) reasons.push(timeReason);

  // 6. Recompete / cross-reference — a warmer lead than a brand-new requirement.
  s += crossRefScore(opp, reasons);

  // 7. Set-aside, small-business-friendly. Mild, and surfaced so a human can
  // judge fit against the certifications actually held.
  if (opp.setAside && !/^(none|n\/a)$/i.test(opp.setAside)) {
    s += 3;
    reasons.push(`set-aside: ${opp.setAside}`);
  }

  // 8. Exclude penalty — physical/field-service terms that rode in on a direct
  // code (classify only demotes *adjacent* matches on an exclude hit).
  const excludeKw = keywords.exclude.filter((k) => text.includes(k.toLowerCase()));
  if (excludeKw.length > 0) {
    s -= Math.min(20, 7 * excludeKw.length);
    reasons.push(`caution: "${excludeKw[0]}"`);
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(s)));
  return { ...opp, score: finalScore, scoreReasons: reasons.slice(0, 4) };
}

// Score a whole batch and return it sorted best-first (stable on ties by title).
export function scoreAndRank(opps: Opportunity[], now: Date = new Date()): Scored[] {
  return opps
    .map((o) => score(o, now))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// ---- signal helpers ----

function isDeadPhase(opp: Opportunity): boolean {
  if (opp.active === false) return true;
  const p = (opp.phase ?? "").toLowerCase();
  return /cancel|closed|awarded/.test(p);
}

// Pull the largest dollar figure out of any of the three source formats.
// Handles suffixes (K/M/B) and comma-grouped exact amounts; returns undefined
// for "To Be Determined" / missing.
export function parseDollarsCeiling(s?: string): number | undefined {
  if (!s) return undefined;
  const t = s.replace(/,/g, "");
  const re = /\$\s*(\d+(?:\.\d+)?)\s*([kmb])?/gi;
  let m: RegExpExecArray | null;
  let max: number | undefined;
  while ((m = re.exec(t))) {
    let v = parseFloat(m[1]!);
    const suf = (m[2] ?? "").toLowerCase();
    if (suf === "k") v *= 1e3;
    else if (suf === "m") v *= 1e6;
    else if (suf === "b") v *= 1e9;
    if (max === undefined || v > max) max = v;
  }
  return max;
}

function dollarScore(ceil?: number): number {
  if (ceil === undefined) return 5; // unknown — don't punish to zero
  if (ceil >= 50_000_000) return 25;
  if (ceil >= 20_000_000) return 22;
  if (ceil >= 10_000_000) return 19;
  if (ceil >= 5_000_000) return 16;
  if (ceil >= 2_000_000) return 13;
  if (ceil >= 1_000_000) return 10;
  if (ceil >= 500_000) return 7;
  if (ceil >= 250_000) return 4;
  return 1;
}

function shortDollars(n: number): string {
  if (n >= 1e9) return `~$${trim(n / 1e9)}B`;
  if (n >= 1e6) return `~$${trim(n / 1e6)}M`;
  return `~$${Math.round(n / 1e3)}K`;
}
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

// Acquisition phase: early = time to shape the requirement; late = frozen.
function phaseScore(opp: Opportunity): { pts: number; reason?: string } {
  const p = (opp.phase ?? "").toLowerCase();
  if (!p) return { pts: 4 };
  if (/market research|planning|ipt|pre-?solicit/.test(p)) return { pts: 8, reason: "early phase" };
  if (/draft/.test(p)) return { pts: 4, reason: "solicitation drafting" };
  if (/solicit|evaluation|selection/.test(p)) return { pts: 0, reason: "late phase (RFP near)" };
  return { pts: 4 };
}

// Award-window proximity (forecast) or expiration proximity (predictor).
function timingScore(opp: Opportunity, now: Date): { pts: number; reason?: string } {
  if (opp.source === "usaspending-predict" && opp.popEnd) {
    const months = monthsBetween(now, new Date(opp.popEnd));
    if (months === undefined) return { pts: 4 };
    if (months <= 6) return { pts: 12, reason: "expires <6mo" };
    if (months <= 12) return { pts: 9, reason: "expires <12mo" };
    if (months <= 18) return { pts: 6, reason: "expires <18mo" };
    return { pts: 4 };
  }
  const q = parseFyQuarter(opp.awardQuarter);
  if (!q) return { pts: 4 };
  const months = monthsBetween(now, q);
  if (months === undefined) return { pts: 4 };
  if (months < 0) return { pts: 3, reason: "award window slipping" }; // past-due but still listed
  if (months <= 9) return { pts: 12, reason: "award imminent" };
  if (months <= 18) return { pts: 8 };
  return { pts: 4 };
}

function crossRefScore(opp: Opportunity, reasons: string[]): number {
  let pts = 0;
  if (opp.crossRef === "confirmed") {
    pts = 15;
    reasons.push("confirmed by both streams");
  } else if (opp.crossRef === "predicted-not-forecasted") {
    pts = 10;
    reasons.push("earliest signal (not yet forecasted)");
  } else if (opp.oppType === "Recompete") {
    pts = 8;
    reasons.push("recompete");
  } else if (opp.oppType === "Predicted") {
    pts = 5;
  } else {
    pts = 2;
  }
  if (opp.incumbent) {
    pts = Math.min(15, pts + 3);
    if (!reasons.some((r) => /incumbent/i.test(r))) reasons.push(`incumbent: ${opp.incumbent}`);
  }
  return pts;
}

// ---- date helpers ----

// Federal fiscal-year quarter -> an approximate mid-quarter calendar date.
// FY starts Oct 1 of the prior calendar year: Q1 Oct-Dec (FY-1), Q2 Jan-Mar,
// Q3 Apr-Jun, Q4 Jul-Sep. "FY 2025 Q4" -> ~Aug 15 2025.
export function parseFyQuarter(s?: string): Date | undefined {
  if (!s) return undefined;
  const m = s.match(/FY\s*(\d{4}).*?Q([1-4])/i);
  if (!m) return undefined;
  const fy = Number(m[1]);
  const q = Number(m[2]);
  const map: Record<number, { y: number; mo: number }> = {
    1: { y: fy - 1, mo: 10 }, // Nov
    2: { y: fy, mo: 1 }, // Feb
    3: { y: fy, mo: 4 }, // May
    4: { y: fy, mo: 7 }, // Aug
  };
  const { y, mo } = map[q]!;
  return new Date(Date.UTC(y, mo, 15));
}

function monthsBetween(from: Date, to: Date): number | undefined {
  const t = to.getTime();
  if (!Number.isFinite(t)) return undefined;
  return (t - from.getTime()) / (30.44 * 86_400_000);
}
