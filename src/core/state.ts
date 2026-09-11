// Persistent dedup state. This file (data/seen.json) is committed back to the
// repo by the GitHub Action after each run, so the bot remembers across the
// otherwise-stateless CI runs what it has already alerted on.

import { readFileSync, writeFileSync } from "node:fs";
import type { OppType } from "./types.js";

export interface SeenEntry {
  firstSeen: string; // ISO — first time we observed this opportunity
  lastSeenRun: string; // ISO — most recent run that saw it (drives pruning)
  watchedValue?: string; // value bucket at last run (change detection)
  awardQuarter?: string;
  oppType?: OppType;
  fitTag?: string;
}
export type SeenMap = Record<string, SeenEntry>;

export function loadSeen(path: string): SeenMap {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SeenMap;
  } catch {
    return {};
  }
}

export function saveSeen(path: string, map: SeenMap): void {
  // Sort keys so git diffs on seen.json stay small and reviewable.
  const ordered: SeenMap = {};
  for (const k of Object.keys(map).sort()) ordered[k] = map[k]!;
  writeFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
}

// Drop entries not seen for a while, so an opportunity that disappears from the
// forecast and later returns is treated as genuinely new again.
export function pruneSeen(map: SeenMap, olderThanDays: number, now = new Date()): number {
  const cutoff = now.getTime() - olderThanDays * 86_400_000;
  let removed = 0;
  for (const [k, v] of Object.entries(map)) {
    const t = Date.parse(v.lastSeenRun);
    if (Number.isFinite(t) && t < cutoff) {
      delete map[k];
      removed++;
    }
  }
  return removed;
}
