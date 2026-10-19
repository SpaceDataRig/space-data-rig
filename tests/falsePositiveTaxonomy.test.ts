// Behavioural tests for the synthetic false-positive taxonomy. The science claims we pin offline:
//  (1) an EB carries a phase-0.5 secondary whose depth is a fixed fraction of the primary; a planet carries none;
//  (2) dilution (a blend) scales BOTH eclipse depths by the same factor, so the secondary/primary RATIO -- the flux
//      signature that separates the EB family from a planet -- survives dilution;
//  (3) a blended planet (HTP/NTP) is flux-DEGENERATE with an on-target planet (no secondary either way) -- the honest
//      limit that pixels exist to break;
//  (4) generation is deterministic and never mutates the host.
import { test } from "node:test";
import assert from "node:assert/strict";

import { synthesizeFalsePositive, eclipseFlux, dilute, type FpKind } from "../src/sim/falsePositiveTaxonomy.ts";
import type { LightCurve } from "../src/core/types.ts";

// A flat (flux=1) host spanning many periods at a 0.1 d cadence -- isolates the injected shape from any real noise.
function flatHost(n = 4000, dt = 0.1): LightCurve {
  const points = [];
  for (let i = 0; i < n; i++) points.push({ time: 2457000 + i * dt, flux: 1, fluxErr: 1e-4 });
  return { targetId: "flat", mission: "synthetic", points };
}

// Depth (1 - flux) at a given signed phase offset from t0, reading the generated curve.
function depthAtPhase(lc: LightCurve, period: number, t0: number, phase: number): number {
  const target = t0 + phase * period;
  let best = Infinity, bestFlux = 1;
  for (const p of lc.points) { const d = Math.abs(p.time - target); if (d < best) { best = d; bestFlux = p.flux; } }
  return 1 - bestFlux;
}

test("EB has a comparable secondary at phase 0.5; a planet has none", () => {
  const eb = synthesizeFalsePositive(flatHost(), { kind: "EB", periodDays: 3, t0Bjd: 2457010 });
  const pl = synthesizeFalsePositive(flatHost(), { kind: "planet", periodDays: 3, t0Bjd: 2457010 });
  const ebSecRatio = depthAtPhase(eb.lc, 3, 2457010, 0.5) / depthAtPhase(eb.lc, 3, 2457010, 0);
  const plSecRatio = depthAtPhase(pl.lc, 3, 2457010, 0.5) / Math.max(1e-9, depthAtPhase(pl.lc, 3, 2457010, 0));
  assert.ok(ebSecRatio > 0.4 && ebSecRatio < 0.9, `EB secondary/primary should be large, got ${ebSecRatio}`);
  assert.ok(plSecRatio < 0.02, `planet should have essentially no secondary, got ${plSecRatio}`);
});

test("dilution scales both eclipses equally so the EB secondary ratio survives", () => {
  const undiluted = synthesizeFalsePositive(flatHost(), { kind: "EB", periodDays: 3, t0Bjd: 2457010, blendFraction: 1 });
  const diluted = synthesizeFalsePositive(flatHost(), { kind: "EB", periodDays: 3, t0Bjd: 2457010, blendFraction: 0.1 });
  const ru = depthAtPhase(undiluted.lc, 3, 2457010, 0.5) / depthAtPhase(undiluted.lc, 3, 2457010, 0);
  const rd = depthAtPhase(diluted.lc, 3, 2457010, 0.5) / depthAtPhase(diluted.lc, 3, 2457010, 0);
  const ratio = Math.abs(ru - rd);
  assert.ok(ratio < 0.02, `secondary ratio should be dilution-invariant: ${ru} vs ${rd}`);
  assert.ok(depthAtPhase(diluted.lc, 3, 2457010, 0) < depthAtPhase(undiluted.lc, 3, 2457010, 0), "a blend must be shallower");
});

test("a blended planet is flux-degenerate with an on-target planet (no secondary either way)", () => {
  const onTarget = synthesizeFalsePositive(flatHost(), { kind: "planet", periodDays: 3, t0Bjd: 2457010 });
  const htp = synthesizeFalsePositive(flatHost(), { kind: "HTP", periodDays: 3, t0Bjd: 2457010 });
  const sOn = depthAtPhase(onTarget.lc, 3, 2457010, 0.5);
  const sHtp = depthAtPhase(htp.lc, 3, 2457010, 0.5);
  assert.ok(sOn < 1e-9 + 1e-6 && sHtp < 1e-6, "neither a planet nor a blended planet has a secondary eclipse");
});

test("eclipseFlux is 1.0 far from any conjunction and dips at phase 0", () => {
  const s = { periodDays: 4, t0Bjd: 0, depthPrimary: 0.05, secondaryRatio: 0, dutyCycle: 0.05, ingressFrac: 0.3, phaseShiftSec: 0 };
  assert.equal(eclipseFlux(1.7, s), 1); // mid-orbit, away from both conjunctions
  assert.ok(eclipseFlux(0, s) < 1, "dip at primary conjunction");
});

test("dilute scales a dip by the blend fraction", () => {
  assert.equal(dilute(1, 0.3), 1); // no dip -> no change
  assert.ok(Math.abs((1 - dilute(0.99, 0.5)) - 0.005) < 1e-12); // 1% dip diluted to half depth
});

test("synthesis is deterministic in (kind, params) and does not mutate the host", () => {
  const host = flatHost();
  const before = host.points[0]!.flux;
  const a = synthesizeFalsePositive(host, { kind: "EB", periodDays: 3, seed: 5 });
  const b = synthesizeFalsePositive(host, { kind: "EB", periodDays: 3, seed: 5 });
  assert.deepEqual(a.lc.points.map((p) => p.flux), b.lc.points.map((p) => p.flux));
  assert.equal(host.points[0]!.flux, before);
  assert.equal(a.truth, "EB" satisfies FpKind);
});

test("every FP class produces a finite curve no longer than a hair off baseline outside eclipses", () => {
  const kinds: FpKind[] = ["planet", "EB", "HEB", "BEB", "NEB", "HTP", "NTP"];
  for (const k of kinds) {
    const { lc } = synthesizeFalsePositive(flatHost(), { kind: k, periodDays: 3, seed: 9 });
    assert.equal(lc.points.length, 4000);
    assert.ok(lc.points.every((p) => Number.isFinite(p.flux) && p.flux > 0 && p.flux <= 1.0000001), `${k} produced an out-of-range flux`);
  }
});
