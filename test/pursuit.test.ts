import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPursuit,
  savePursuit,
  setPursuit,
  countByState,
  isPursuitState,
  dropSkipped,
  activePursuits,
  type PursuitStore,
} from "../src/core/pursuit.js";

const tmpFile = (name = "pursuit.json") => join(mkdtempSync(join(tmpdir(), "pursuit-")), name);

describe("setPursuit", () => {
  const now = new Date("2026-07-30T12:00:00Z");

  it("records a decision with a title breadcrumb", () => {
    const s = setPursuit({}, "fp1", { state: "pursue", title: "EGIS III", now });
    expect(s.fp1?.state).toBe("pursue");
    expect(s.fp1?.title).toBe("EGIS III");
    expect(s.fp1?.updatedAt).toBe(now.toISOString());
  });

  it("clears an entry when state is null, which is how undo works", () => {
    const s = setPursuit({ fp1: { state: "skip", updatedAt: "x" } }, "fp1", { state: null });
    expect(s.fp1).toBeUndefined();
  });

  it("preserves an existing note when the note is omitted", () => {
    const before = setPursuit({}, "fp1", { state: "watch", note: "call the PoC", now });
    const after = setPursuit(before, "fp1", { state: "pursue", now });
    expect(after.fp1?.note).toBe("call the PoC");
    expect(after.fp1?.state).toBe("pursue");
  });

  it("clears the note when passed an empty string", () => {
    const before = setPursuit({}, "fp1", { state: "watch", note: "old", now });
    const after = setPursuit(before, "fp1", { state: "watch", note: "", now });
    expect(after.fp1?.note).toBeUndefined();
  });
});

describe("loadPursuit", () => {
  it("returns an empty store when the file does not exist", () => {
    expect(loadPursuit(join(tmpdir(), "definitely-not-here-9f2a.json"))).toEqual({});
  });

  it("survives a corrupt file rather than taking the weekly run down", () => {
    const p = tmpFile();
    writeFileSync(p, "{not json");
    expect(loadPursuit(p)).toEqual({});
  });

  it("drops malformed entries but keeps valid ones", () => {
    const p = tmpFile();
    writeFileSync(
      p,
      JSON.stringify({
        good: { state: "pursue", updatedAt: "2026-07-30T00:00:00Z" },
        bogus: { state: "maybe", updatedAt: "2026-07-30T00:00:00Z" },
        empty: null,
      })
    );
    const store = loadPursuit(p);
    expect(Object.keys(store)).toEqual(["good"]);
  });
});

describe("savePursuit", () => {
  it("round-trips through disk", () => {
    const p = tmpFile();
    const store: PursuitStore = { fp1: { state: "watch", note: "n", updatedAt: "2026-07-30T00:00:00Z" } };
    savePursuit(p, store);
    expect(loadPursuit(p)).toEqual(store);
  });

  it("writes keys sorted so the committed diff stays stable", () => {
    const p = tmpFile();
    savePursuit(p, {
      zeta: { state: "skip", updatedAt: "t" },
      alpha: { state: "pursue", updatedAt: "t" },
    });
    const raw = readFileSync(p, "utf8");
    expect(raw.indexOf('"alpha"')).toBeLessThan(raw.indexOf('"zeta"'));
  });
});

describe("the digest feedback loop", () => {
  const store: PursuitStore = {
    a: { state: "skip", updatedAt: "t" },
    b: { state: "pursue", updatedAt: "t", note: "call them" },
    c: { state: "watch", updatedAt: "t" },
  };
  const items = [{ fingerprint: "a" }, { fingerprint: "b" }, { fingerprint: "c" }, { fingerprint: "d" }];
  const key = (i: { fingerprint: string }) => i.fingerprint;

  it("drops skipped items from the digest and reports how many", () => {
    const r = dropSkipped(items, store, key);
    expect(r.kept.map(key)).toEqual(["b", "c", "d"]);
    expect(r.suppressed).toBe(1);
  });

  it("keeps untriaged items, so nothing is silently lost", () => {
    expect(dropSkipped(items, store, key).kept.map(key)).toContain("d");
  });

  it("suppresses nothing when no decisions exist yet", () => {
    const r = dropSkipped(items, {}, key);
    expect(r.suppressed).toBe(0);
    expect(r.kept).toHaveLength(4);
  });

  it("collects pursue and watch items, with their notes, but never skipped ones", () => {
    const active = activePursuits(items, store, key);
    expect(active.map((a) => key(a.item))).toEqual(["b", "c"]);
    expect(active[0]?.note).toBe("call them");
    expect(active[1]?.note).toBeUndefined();
  });

  it("works on a nested shape, which is how changed items arrive", () => {
    const changed = [{ opp: { fingerprint: "a" } }, { opp: { fingerprint: "b" } }];
    const r = dropSkipped(changed, store, (c) => c.opp.fingerprint);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.opp.fingerprint).toBe("b");
  });
});

describe("countByState", () => {
  it("counts each state", () => {
    const counts = countByState({
      a: { state: "pursue", updatedAt: "t" },
      b: { state: "pursue", updatedAt: "t" },
      c: { state: "skip", updatedAt: "t" },
    });
    expect(counts).toEqual({ pursue: 2, watch: 0, skip: 1 });
  });
});

describe("isPursuitState", () => {
  it("accepts only the three real states", () => {
    expect(isPursuitState("pursue")).toBe(true);
    expect(isPursuitState("skip")).toBe(true);
    expect(isPursuitState("archived")).toBe(false);
    expect(isPursuitState(null)).toBe(false);
  });
});
