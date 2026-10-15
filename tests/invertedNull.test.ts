import { test } from "node:test";
import assert from "node:assert/strict";

import { invertCurve, maskKnownTransits, invertedPlanetFreeNull, type KnownTransit } from "../src/detect/invertedNull.ts";
import type { LightCurve } from "../src/core/types.ts";

function curve(fluxes: number[]): LightCurve {
  return {
    targetId: "t",
    mission: "synthetic",
    points: fluxes.map((f, i) => ({ time: i, flux: f, fluxErr: 1e-4 })),
    source: "test",
  };
}

test("invertCurve reflects flux about the median (a dip becomes a bump) and does not mutate the input", () => {
  const lc = curve([1, 1, 0.9, 1, 1.1]); // median 1
  const frozen = JSON.parse(JSON.stringify(lc));
  const inv = invertCurve(lc);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert.ok(near(inv.points[2]!.flux, 1.1)); // the 0.9 dip -> 1.1 bump
  assert.ok(near(inv.points[4]!.flux, 0.9)); // the 1.1 bump -> 0.9 dip
  assert.ok(near(inv.points[0]!.flux, 1)); // on-median stays
  assert.deepEqual(lc, frozen); // original untouched
  assert.notEqual(inv, lc); // fresh object
});

test("maskKnownTransits keeps every cadence when there are no planets and drops in-transit ones", () => {
  const times = Array.from({ length: 40 }, (_, i) => i); // 40 daily cadences, 0..39
  const lc: LightCurve = { targetId: "t", mission: "synthetic", points: times.map((t) => ({ time: t, flux: 1, fluxErr: 1e-4 })), source: "test" };
  assert.equal(maskKnownTransits(lc, [], 0.5).points.length, 40); // no mask -> copy
  const planet: KnownTransit = { period: 100, epoch: 20, durDays: 3 }; // period > baseline so exactly one transit window lands in range
  const masked = maskKnownTransits(lc, [planet], 0.5);
  assert.ok(masked.points.length < 40, "in-transit cadences must be removed");
  assert.ok(!masked.points.some((p) => p.time === 20), "the mid-transit cadence is dropped");
  assert.ok(masked.points.length >= 30 && masked.points.length <= 39, "only the transit window is removed");
});

test("invertedPlanetFreeNull composes invert + mask and shrinks below the input length", () => {
  const lc = curve(Array.from({ length: 40 }, () => 1));
  const null_ = invertedPlanetFreeNull(lc, [{ period: 10, epoch: 20, durDays: 3 }], 0.5);
  assert.ok(null_.points.length < lc.points.length);
  assert.equal(lc.points.length, 40); // input untouched
});
