// Triage decisions: what you have decided to chase, keep an eye on, or drop.
//
// This is the file that makes the dashboard a loop rather than a viewer. The
// dashboard writes it; the weekly digest reads it, so an item you skip once
// stops arriving in the email. That means it has to be COMMITTED: CI needs it.
//
// Keyed by fingerprint, the same stable hash dedup uses, so a decision survives
// a source renaming or re-listing an opportunity.
//
// `title` is stored purely so the committed JSON reads like a record of what you
// decided rather than an opaque map of hashes. Nothing depends on its value.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const PURSUIT_STATES = ["pursue", "watch", "skip"] as const;
export type PursuitState = (typeof PURSUIT_STATES)[number];

export function isPursuitState(v: unknown): v is PursuitState {
  return typeof v === "string" && (PURSUIT_STATES as readonly string[]).includes(v);
}

export interface PursuitEntry {
  state: PursuitState;
  note?: string;
  updatedAt: string;
  title?: string; // breadcrumb for humans reading the diff
}

export type PursuitStore = Record<string, PursuitEntry>;

export function loadPursuit(path: string): PursuitStore {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PursuitStore;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Drop anything malformed rather than trusting the file wholesale: a
    // hand-edit should not be able to crash the weekly run.
    const clean: PursuitStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && isPursuitState((v as PursuitEntry).state)) clean[k] = v as PursuitEntry;
    }
    return clean;
  } catch {
    return {};
  }
}

export function savePursuit(path: string, store: PursuitStore): void {
  mkdirSync(dirname(path), { recursive: true });
  // Sorted keys and 2-space indent: this file is committed, so its diffs should
  // be readable and stable rather than reordering on every write.
  const sorted: PursuitStore = {};
  for (const k of Object.keys(store).sort()) {
    const entry = store[k];
    if (entry) sorted[k] = entry;
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * Apply one decision. Passing state `null` clears the entry, which is how the
 * dashboard's "undo" works: an item with no entry is simply untriaged.
 */
export function setPursuit(
  store: PursuitStore,
  fingerprint: string,
  change: { state: PursuitState | null; note?: string; title?: string; now?: Date }
): PursuitStore {
  if (change.state === null) {
    const { [fingerprint]: _removed, ...rest } = store;
    return rest;
  }
  const previous = store[fingerprint];
  return {
    ...store,
    [fingerprint]: {
      state: change.state,
      // An omitted note preserves whatever was there; an empty string clears it.
      note: change.note === undefined ? previous?.note : change.note || undefined,
      title: change.title ?? previous?.title,
      updatedAt: (change.now ?? new Date()).toISOString(),
    },
  };
}

/**
 * Drop items you have skipped. This is the half of the loop that makes the
 * email quieter: skipped items are still recorded as seen upstream, so they
 * never re-alert, but they stop being rendered.
 */
export function dropSkipped<T>(
  items: T[],
  store: PursuitStore,
  key: (item: T) => string
): { kept: T[]; suppressed: number } {
  const kept = items.filter((item) => store[key(item)]?.state !== "skip");
  return { kept, suppressed: items.length - kept.length };
}

/**
 * The other half: everything marked pursue or watch, so the digest can lead
 * with what you already committed to rather than with whatever is new.
 */
export function activePursuits<T>(
  items: T[],
  store: PursuitStore,
  key: (item: T) => string
): Array<{ item: T; state: PursuitState; note?: string }> {
  return items.flatMap((item) => {
    const entry = store[key(item)];
    if (!entry || entry.state === "skip") return [];
    return [{ item, state: entry.state, note: entry.note }];
  });
}

export function countByState(store: PursuitStore): Record<PursuitState, number> {
  const out: Record<PursuitState, number> = { pursue: 0, watch: 0, skip: 0 };
  for (const entry of Object.values(store)) out[entry.state]++;
  return out;
}
