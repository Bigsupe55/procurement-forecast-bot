import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, writeSnapshot, readSnapshot } from "../src/core/snapshot.js";
import type { Scored } from "../src/core/score.js";

function scored(id: string, score: number, over: Partial<Scored> = {}): Scored {
  return {
    source: "treasury-forecast",
    id,
    fingerprint: `fp-${id}`,
    title: id,
    agency: "Treasury",
    oppType: "New",
    url: "",
    fitTag: "direct-fit",
    matchedTerms: [],
    score,
    scoreReasons: [],
    ...over,
  };
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "snap-")), "snapshot.json");

describe("buildSnapshot", () => {
  it("counts items at or above the threshold", () => {
    const s = buildSnapshot([scored("a", 91), scored("b", 70), scored("c", 12)], { worthActingOn: 70 });
    expect(s.meta.totalScored).toBe(3);
    expect(s.meta.priorityCount).toBe(2); // 70 counts as clearing the bar
  });

  it("tallies items per source", () => {
    const s = buildSnapshot(
      [scored("a", 5), scored("b", 5, { source: "dhs-apfs" }), scored("c", 5, { source: "dhs-apfs" })],
      { worthActingOn: 70 }
    );
    expect(s.meta.countsBySource).toEqual({ "treasury-forecast": 1, "dhs-apfs": 2 });
  });

  it("truncates long descriptions and collapses whitespace", () => {
    const s = buildSnapshot([scored("a", 5, { description: `${"x".repeat(2000)}` })], { worthActingOn: 70 });
    const d = s.opportunities[0]?.description ?? "";
    expect(d.length).toBeLessThan(2000);
    expect(d.endsWith("...")).toBe(true);
  });

  it("leaves a short description alone apart from whitespace", () => {
    const s = buildSnapshot([scored("a", 5, { description: "  two   words  " })], { worthActingOn: 70 });
    expect(s.opportunities[0]?.description).toBe("two words");
  });

  it("carries run notes through so the UI can surface a skipped stream", () => {
    const s = buildSnapshot([], { worthActingOn: 70, notes: ["gateway stream skipped: timeout"] });
    expect(s.meta.notes).toEqual(["gateway stream skipped: timeout"]);
  });
});

describe("readSnapshot", () => {
  it("round-trips through disk", () => {
    const p = tmpFile();
    writeSnapshot(p, buildSnapshot([scored("a", 91)], { worthActingOn: 70 }));
    expect(readSnapshot(p)?.opportunities[0]?.title).toBe("a");
  });

  it("returns null when there is no snapshot yet", () => {
    expect(readSnapshot(join(tmpdir(), "no-snapshot-here-4b1c.json"))).toBeNull();
  });

  it("returns null on a corrupt file instead of throwing", () => {
    const p = tmpFile();
    writeFileSync(p, "{half-written");
    expect(readSnapshot(p)).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    const p = tmpFile();
    writeFileSync(p, JSON.stringify({ meta: {}, opportunities: "not an array" }));
    expect(readSnapshot(p)).toBeNull();
  });
});
