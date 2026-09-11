// Compares the current fetch against remembered state: what is brand new, and
// what already-seen opportunity had a meaningful field shift (value, timing, or
// type). Updates the seen map in place; the caller persists it.

import type { Opportunity, OppChange } from "./types.js";
import type { SeenMap } from "./state.js";

export interface DedupResult {
  newOpps: Opportunity[];
  changedOpps: OppChange[];
  isBaseline: boolean; // true when seen state was empty (first ever run)
}

export function diffAndUpdate(
  opps: Opportunity[],
  seen: SeenMap,
  nowIso: string = new Date().toISOString()
): DedupResult {
  const isBaseline = Object.keys(seen).length === 0;
  const newOpps: Opportunity[] = [];
  const changedOpps: OppChange[] = [];

  for (const o of opps) {
    const prev = seen[o.fingerprint];
    if (!prev) {
      newOpps.push(o);
      seen[o.fingerprint] = {
        firstSeen: nowIso,
        lastSeenRun: nowIso,
        watchedValue: o.watchedValue,
        awardQuarter: o.awardQuarter,
        oppType: o.oppType,
        fitTag: o.fitTag,
      };
      continue;
    }

    const changes: OppChange["changes"] = [];
    if (norm(prev.watchedValue) !== norm(o.watchedValue))
      changes.push({ field: "estimated value", from: prev.watchedValue ?? "-", to: o.watchedValue ?? "-" });
    if (norm(prev.awardQuarter) !== norm(o.awardQuarter))
      changes.push({ field: "award timing", from: prev.awardQuarter ?? "-", to: o.awardQuarter ?? "-" });
    if (norm(prev.oppType) !== norm(o.oppType))
      changes.push({ field: "opportunity type", from: prev.oppType ?? "-", to: o.oppType });

    if (changes.length > 0) changedOpps.push({ opp: o, changes });

    prev.lastSeenRun = nowIso;
    prev.watchedValue = o.watchedValue;
    prev.awardQuarter = o.awardQuarter;
    prev.oppType = o.oppType;
    prev.fitTag = o.fitTag;
  }

  return { newOpps, changedOpps, isBaseline };
}

function norm(s?: string): string {
  return (s ?? "").trim().toLowerCase();
}
