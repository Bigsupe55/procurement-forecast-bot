// Deterministic relevance tagging. No AI in v1 — just NAICS/PSC code sets plus
// keyword matches against the title and description. Every opportunity comes out
// tagged direct-fit / adjacent / other, with the terms that matched (so the
// digest can show *why* something surfaced).

import { readFileSync } from "node:fs";
import { paths, config } from "../config.js";
import type { Opportunity, FitTag } from "../core/types.js";

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

export function classify(opp: Opportunity): Opportunity {
  const text = `${opp.title} ${opp.description ?? ""}`.toLowerCase();
  const matched: string[] = [];

  // Canceled or inactive forecast entries are noise for lead-gen.
  const dead = opp.active === false || (opp.phase ?? "").toLowerCase() === "canceled";

  const directKw = keywords.direct.filter((k) => text.includes(k.toLowerCase()));
  const adjacentKw = keywords.adjacent.filter((k) => text.includes(k.toLowerCase()));
  const excludeKw = keywords.exclude.filter((k) => text.includes(k.toLowerCase()));

  const naicsDirect = opp.naics ? directNaics.has(opp.naics) : false;
  const naicsAdj = opp.naics ? adjacentNaics.has(opp.naics) : false;
  const pscDirect = opp.psc ? directPsc.has(opp.psc) : false;
  const pscAdj = opp.psc ? adjacentPsc.has(opp.psc) : false;

  for (const k of [...directKw, ...adjacentKw]) matched.push(`kw:${k}`);
  if (naicsDirect || naicsAdj) matched.push(`naics:${opp.naics}`);
  if (pscDirect || pscAdj) matched.push(`psc:${opp.psc}`);

  let fitTag: FitTag = "other";
  if (!dead) {
    if (naicsDirect || pscDirect || directKw.length > 0) {
      fitTag = "direct-fit";
    } else if (naicsAdj || pscAdj || adjacentKw.length > 0) {
      fitTag = "adjacent";
      // A strong exclude signal (e.g. "landscaping") demotes a merely-adjacent
      // match back to noise, unless a direct code/keyword also fired.
      if (excludeKw.length > 0) fitTag = "other";
    }
  }

  return { ...opp, fitTag, matchedTerms: matched };
}

// Which fit tiers actually go in the email (direct always; adjacent by config).
export function includeInDigest(opp: Opportunity): boolean {
  if (opp.fitTag === "direct-fit") return true;
  if (opp.fitTag === "adjacent") return config.includeAdjacent;
  return false;
}
