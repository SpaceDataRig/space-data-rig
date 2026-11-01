// R38: p104 audits, on committed REAL data, whether the two still-conservative gate corroboration axes
// (gaiaBlendRuledOut, psfOrDiffImagingClear) can be fed a FAVOURABLE value. The honest answer is a capability
// boundary: Gaia carries no decisive ruling here, and the pixel-centroid F-test catches 0 real blends while it
// would declare essentially all of them "clear" -- so promoting it would be a rubber stamp. This test pins that
// negative finding is real, re-derivable from the fixtures, and NOT silently upgraded: red lines false, gate fed
// both axes for real still lands every covered host at tier none, and the centroid axis is provably non-
// discriminating (would-clear >= caught, with caught 0 on blends) -- the guard that keeps it out of the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = JSON.parse(readFileSync(resolve(process.cwd(), "reports/p104-corroboration-capability.json"), "utf8"));
const gaia = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/live-gaia-rv.json"), "utf8"));
const centroid = readFileSync(resolve(process.cwd(), "tests/fixtures/scaled/centroid.jsonl"), "utf8").replace(/\r/g, "").trim().split("\n").map((l) => JSON.parse(l));
const ALPHA = 0.001;
const clears = (r) => r.testable && r.pTarget >= ALPHA;

test("p104 keeps the discovery red lines false", () => {
  assert.equal(R.discoveryClaim, false);
  assert.equal(R.safeToGate, false);
});

test("Gaia feeds NO favourable blend evidence on this committed set (decisive rulings == 0)", () => {
  assert.equal(R.alpha, ALPHA, "the centroid catch bar is pinned, not loosened");
  // re-derive straight from the fixture
  const decisive = gaia.cases.filter((c) => c.ebExclusion === "excluded" || c.ebExclusion === "supported").length;
  assert.equal(R.gaia.decisive, decisive);
  assert.equal(R.gaia.decisive, 0, "no Gaia host is decisively ruled out OR corroborated here");
  assert.equal(R.gaia.unknown, R.gaia.withData, "every host with Gaia data is 'unknown' (no orbit at the candidate period)");
});

test("the pixel-centroid F-test is provably NON-discriminating on the committed blends", () => {
  const blends = centroid.filter((r) => r.label === "blend");
  const blendsTestable = blends.filter((r) => r.testable);
  const caught = blendsTestable.filter((r) => r.caught).length;
  const wouldClear = blendsTestable.filter(clears).length;
  assert.equal(R.centroid.blendsTestable, blendsTestable.length);
  assert.equal(R.centroid.caught, caught);
  assert.equal(R.centroid.blendWouldClear, wouldClear);
  // the honest finding: it catches nothing real and would pass essentially all of them -> rubber stamp
  assert.equal(caught, 0, "the test catches 0 real blends on this data");
  assert.ok(wouldClear >= caught, "would-clear never trails caught (the axis cannot be a discriminating gate bar)");
  assert.equal(R.centroid.blendCatchRate, 0, "blend catch rate is exactly 0 -> it must NOT be promoted to the gate");
});

test("fed both axes for real, EVERY host covered by BOTH sources still lands tier none", () => {
  assert.ok(R.rows.length >= 1, "there is at least one host covered by both real sources");
  assert.equal(R.allNone, true, "all overlap hosts are tier none");
  for (const r of R.rows) {
    assert.equal(r.tier, "none", `host ${r.tic}: must not clear the gate`);
    assert.equal(r.gaiaBlendRuledOut, false, `host ${r.tic}: Gaia cannot rule out a blend here`);
    assert.ok(r.unmetCount >= 1, `host ${r.tic}: a refusal must list unmet bars`);
  }
});

test("the centroid clear predicate matches the published counts (no hidden re-derivation)", () => {
  const planets = centroid.filter((r) => r.label === "planet");
  const planetsTestable = planets.filter((r) => r.testable);
  assert.equal(R.centroid.planetsTestable, planetsTestable.length);
  assert.equal(R.centroid.planetWouldClear, planetsTestable.filter(clears).length);
  assert.equal(R.centroid.falseReject, planetsTestable.filter((r) => r.falseReject).length);
  assert.ok(R.centroid.blendWouldClear <= R.centroid.blendsTestable, "would-clear is bounded by testable blends");
});
