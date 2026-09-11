// Snapshot writer: dumps every scored opportunity from a run to disk so the
// local dashboard has something to read without refetching.
//
// Why this exists: a full pipeline run takes roughly 12 minutes, almost all of
// it the Acquisition Gateway pull. The dashboard must open instantly, so it
// reads the last run's snapshot rather than fetching anything itself. Refresh
// the data by running the bot (`npm run dry` is enough).
//
// The snapshot is DERIVED DATA and gitignored. Losing it costs one run, and
// keeping it out of git avoids committing a multi-megabyte file every week.
//
// Written BEFORE the "nothing new, no email" early return in run.ts, so a quiet
// week still refreshes the dashboard.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Scored } from "./score.js";

// Descriptions are the bulk of the payload and some sources ship several KB of
// boilerplate. The dashboard shows an excerpt and searches within it, so a cap
// keeps the file to a few MB without hurting either use.
const MAX_DESCRIPTION = 800;

export interface SnapshotMeta {
  generatedAt: string;
  worthActingOn: number; // the priority threshold in force when this was written
  totalScored: number;
  priorityCount: number;
  countsBySource: Record<string, number>;
  notes: string[]; // stream skips and other run warnings, surfaced in the UI
}

export interface Snapshot {
  meta: SnapshotMeta;
  opportunities: Scored[];
}

function truncate(text: string | undefined): string | undefined {
  if (!text) return text;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION)}...` : flat;
}

export function buildSnapshot(
  opps: Scored[],
  opts: { worthActingOn: number; notes?: string[]; now?: Date }
): Snapshot {
  const countsBySource: Record<string, number> = {};
  for (const o of opps) countsBySource[o.source] = (countsBySource[o.source] ?? 0) + 1;

  return {
    meta: {
      generatedAt: (opts.now ?? new Date()).toISOString(),
      worthActingOn: opts.worthActingOn,
      totalScored: opps.length,
      priorityCount: opps.filter((o) => o.score >= opts.worthActingOn).length,
      countsBySource,
      notes: opts.notes ?? [],
    },
    opportunities: opps.map((o) => ({ ...o, description: truncate(o.description) })),
  };
}

export function writeSnapshot(path: string, snapshot: Snapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot), "utf8");
}

/** Returns null when no snapshot exists yet, so the dashboard can say so plainly. */
export function readSnapshot(path: string): Snapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    if (!parsed?.meta || !Array.isArray(parsed.opportunities)) return null;
    return parsed;
  } catch {
    return null; // a half-written or corrupt snapshot should not take the UI down
  }
}
