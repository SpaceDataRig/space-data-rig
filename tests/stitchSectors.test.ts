// Offline validation for stitchLightCurves: the multi-sector merge used by scripts/p12-multisector.ts.
// Pure + deterministic, no network. We check the three things that matter for a coherent longer-
// baseline fold: per-sector brightness offsets are normalized away (no step at the join), points are
// time-sorted with duplicates dropped, and a real transit dip survives the merge at its true depth.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

function lc(times: number[], flux: number[], id = "TIC 1"): LightCurve {
  return { targetId: id, mission: "TESS", points: times.map((t, i) => ({ time: t, flux: flux[i] })) };
}

test("per-sector offsets are normalized away so the join has no step", () => {
  const t1 = Array.from({ length: 100 }, (_, i) => 1000 + i);
  const f1 = t1.map(() => 2.0); // one sector sitting at 2.0 (different calibration)
  const t2 = Array.from({ length: 100 }, (_, i) => 1100 + i);
  const f2 = t2.map(() => 1.0); // another at 1.0
  const out = stitchLightCurves([lc(t1, f1), lc(t2, f2)]);
  assert.ok(out, "stitch should succeed");
  assert.equal(out!.points.length, 200);
  for (const p of out!.points) {
    assert.ok(Math.abs(p.flux - 1.0) < 1e-9, `normalized flux should be ~1, got ${p.flux}`);
  }
});

test("points are time-sorted and exact duplicate timestamps are dropped", () => {
  const t1 = Array.from({ length: 50 }, (_, i) => 2000 + i);
  const t2 = Array.from({ length: 50 }, (_, i) => 2040 + i); // overlaps 2040..2049 (10 shared)
  const out = stitchLightCurves([lc(t1, t1.map(() => 1)), lc(t2, t2.map(() => 1))]);
  assert.ok(out);
  assert.equal(out!.points.length, 90, "50 + 50 - 10 duplicates");
  for (let i = 1; i < out!.points.length; i++) {
    assert.ok(out!.points[i].time > out!.points[i - 1].time, "strictly increasing after dedup");
  }
});

test("a shallow transit dip survives the merge at its true depth", () => {
  // two sectors, each flat at 1.0 except a few points dipped to 0.99 (a 1% transit)
  const t1 = Array.from({ length: 60 }, (_, i) => 3000 + i * 0.5);
  const f1 = t1.map((_, i) => (i >= 10 && i <= 14 ? 0.99 : 1.0));
  const t2 = Array.from({ length: 60 }, (_, i) => 3060 + i * 0.5);
  const f2 = t2.map((_, i) => (i >= 30 && i <= 34 ? 0.99 : 1.0));
  const out = stitchLightCurves([lc(t1, f1), lc(t2, f2)]);
  assert.ok(out);
  const min = Math.min(...out!.points.map((p) => p.flux));
  assert.ok(Math.abs(min - 0.99) < 1e-6, `dip floor should be ~0.99, got ${min}`);
});

test("empty or too-sparse input degrades to null, not a throw", () => {
  assert.equal(stitchLightCurves([]), null);
  const tiny = lc(Array.from({ length: 10 }, (_, i) => i), Array.from({ length: 10 }, () => 1));
  assert.equal(stitchLightCurves([tiny]), null, "a single 10-point sector is below the 50-point floor");
});
