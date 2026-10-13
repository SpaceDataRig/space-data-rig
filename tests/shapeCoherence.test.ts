// In-transit shape-coherence statistic. Offline, deterministic, NO network.
// The load-bearing property: a transit that fills its box consistently scores ratio ~ 1, while a box whose
// mean depth is carried by a single outlier spike scores ratio ~ 0. This is the FP class that significance
// gates cannot touch (it is coherent, not random), so the statistic must be validated to actually separate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeCoherence, foldedBoxDepth } from "../src/detect/shapeCoherence.ts";
import type { BLSResult } from "../src/detect/bls.ts";
import type { LightCurve } from "../src/core/types.ts";

function lc(points: { time: number; flux: number }[]): LightCurve {
  return { targetId: "t", mission: "TESS", cadenceSec: 60, points, source: "synthetic" };
}
function res(periodDays: number, epochBjd: number, durationDays: number, depth: number): BLSResult {
  return { periodDays, epochBjd, durationDays, depth } as unknown as BLSResult;
}

test("a transit that fills its box consistently scores ratio ~ 1", () => {
  const P = 1.0;
  const halfDur = 0.1;
  const pts: { time: number; flux: number }[] = [];
  for (let i = 0; i < 100; i++) {
    const t = i * 0.05;
    // distance from the nearest transit center (phase folded, 0.5-center convention)
    const ph = ((t % P) + P) % P;
    const dCenter = Math.min(ph, P - ph); // days to nearest epoch at t = integer
    pts.push({ time: t, flux: dCenter <= halfDur ? 0.99 : 1.0 });
  }
  const r = shapeCoherence(lc(pts), res(P, 0.0, 2 * halfDur, 0.01));
  assert.ok(Number.isFinite(r.ratio), "ratio must be finite");
  assert.ok(r.ratio > 0.8 && r.ratio < 1.2, `expected ratio ~ 1, got ${r.ratio}`);
});

test("a single outlier spike that only shifts the box MEAN scores ratio ~ 0", () => {
  // 100 points at baseline 1.0, ONE deep at t=2.0; a bogus BLS result claims a 1-day box at a 5-day period,
  // its mean depth (0.005) carried entirely by that one outlier among ~20 in-box samples.
  const pts: { time: number; flux: number }[] = [];
  for (let i = 0; i < 100; i++) {
    const t = i * 0.05;
    pts.push({ time: t, flux: Math.abs(t - 2.0) < 1e-9 ? 0.9 : 1.0 });
  }
  const r = shapeCoherence(lc(pts), res(5.0, 2.0, 1.0, 0.005));
  assert.ok(Number.isFinite(r.ratio), "ratio must be finite");
  assert.ok(r.ratio < 0.3, `expected ratio near 0 for a one-point spike, got ${r.ratio}`);
});

test("guards: duration >= period or too few in-box samples return NaN (never fabricate)", () => {
  const flat = lc(Array.from({ length: 100 }, (_, i) => ({ time: i * 0.05, flux: 1.0 })));
  // durationDays >= periodDays is not a transit box
  assert.ok(Number.isNaN(shapeCoherence(flat, res(1.0, 0.0, 1.0, 0.01)).ratio));
  // a box so narrow it holds <3 samples
  const narrow = shapeCoherence(flat, res(50.0, 100.0, 0.01, 0.01));
  assert.ok(Number.isNaN(narrow.ratio));
  assert.ok(narrow.nInTransit < 3);
});

test("foldedBoxDepth: a real transit recurring at the fixed ephemeris gives a positive dip", () => {
  const P = 2.0;
  const epoch = 10.0;
  const halfDur = 0.1;
  const pts: { time: number; flux: number }[] = [];
  for (let i = 0; i < 400; i++) {
    const t = epoch + i * 0.05;
    const ph = (((t - epoch) % P) + P) % P; // 0 at transit center
    const dCenter = Math.min(ph, P - ph);
    pts.push({ time: t, flux: dCenter <= halfDur ? 0.99 : 1.0 });
  }
  const d = foldedBoxDepth(lc(pts), P, epoch, 2 * halfDur);
  assert.ok(Number.isFinite(d.depth), "depth must be finite");
  assert.ok(d.depth > 0.005 && d.depth < 0.015, `expected ~0.01 dip, got ${d.depth}`);
});

test("foldedBoxDepth: folding a FLAT curve at any ephemeris gives ~no dip (not a positive signal)", () => {
  const flat = lc(Array.from({ length: 200 }, (_, i) => ({ time: i * 0.1, flux: 1.0 })));
  const d = foldedBoxDepth(flat, 3.0, 5.0, 0.4);
  assert.ok(Number.isFinite(d.depth));
  assert.ok(Math.abs(d.depth) < 1e-9, `flat curve must give zero depth, got ${d.depth}`);
});

test("foldedBoxDepth: guards return NaN (incoherent ephemeris / too few in-box samples)", () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ time: i * 0.05, flux: 1.0 }));
  assert.ok(Number.isNaN(foldedBoxDepth(lc(pts), 1.0, 0.0, 1.5).depth)); // duration >= period
  assert.ok(Number.isNaN(foldedBoxDepth(lc(pts), NaN, 0.0, 0.1).depth)); // bad period
  const narrow = foldedBoxDepth(lc(pts), 50.0, 100.0, 0.01); // box holds <3 samples
  assert.ok(Number.isNaN(narrow.depth));
  assert.ok(narrow.nIn < 3);
});
