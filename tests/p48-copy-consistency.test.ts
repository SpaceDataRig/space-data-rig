// Audit-12 D1 guard: P48's PROSE must never quote a number its own JSON disagrees with. The shipped defect was
// a hand-typed sentence ("collapsed 2 ... emitting these 5") that survived the /1 -> /2 board re-measure
// (1 group / 4 candidates) because the freshness gate verifies bytes-against-inputs, not prose-against-data --
// so a stale sentence got re-stamped and re-published as "verified". These assertions read the committed report
// the repo actually publishes and pin every load-bearing count in the prose to its JSON/board field. Offline,
// deterministic, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = JSON.parse(readFileSync("reports/p48-novelty.json", "utf8")) as {
  nCandidates: number; novelLocationCount: number; samePeriodAnnouncedCount: number;
  boardSystematicCollapsed: number | null; boardEmittedCandidates: number | null;
  discoveryClaim: boolean;
};
const md = readFileSync("reports/p48-novelty.md", "utf8");
const board = JSON.parse(readFileSync("web/candidates.json", "utf8")) as {
  schema: string;
  summary: { systematicCollapsed: number; emittedCandidates: number };
  candidates: unknown[];
};

test("the collapse/emit sentence interpolates the report's own fields (no hand-typed counts)", () => {
  const m = md.match(/collapsed\s+(\d+)\s+multi-host systematic group\(s\) BEFORE emitting these\s+(\d+)/);
  assert.ok(m, "prose must carry the collapse sentence with numeric group and emit counts");
  assert.equal(Number(m[1]), json.boardSystematicCollapsed, "collapsed-group count matches JSON");
  assert.equal(Number(m[2]), json.nCandidates, "emitted-candidate count matches the rows actually reported");
});

test("the headline novel/same-period fractions in prose match the JSON counts", () => {
  const novel = md.match(/\*\*(\d+)\/(\d+)\*\* candidates sit at a location/);
  assert.ok(novel, "headline novel fraction present");
  assert.equal(Number(novel[1]), json.novelLocationCount);
  assert.equal(Number(novel[2]), json.nCandidates);
  const same = md.match(/\*\*(\d+)\/(\d+)\*\* match an already-announced period/);
  assert.ok(same, "headline same-period fraction present");
  assert.equal(Number(same[1]), json.samePeriodAnnouncedCount);
  assert.equal(Number(same[2]), json.nCandidates);
});

test("the report describes the board it actually audited", () => {
  assert.equal(json.nCandidates, board.candidates.length, "row count equals live board length");
  if (json.boardSystematicCollapsed !== null) {
    assert.equal(json.boardSystematicCollapsed, board.summary.systematicCollapsed, "collapse count equals board summary");
  }
  if (json.boardEmittedCandidates !== null) {
    assert.equal(json.boardEmittedCandidates, board.summary.emittedCandidates, "emitted count equals board summary");
  }
});

test("the report stays research-only", () => {
  assert.equal(json.discoveryClaim, false);
  assert.ok(md.includes("discoveryClaim: false"));
});
