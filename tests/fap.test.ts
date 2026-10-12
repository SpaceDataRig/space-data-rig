// Phase-scrambling FAP sanity: a real injected transit must be highly significant
// (near the surrogate floor), while pure noise must NOT be (its observed max-power is
// itself a null draw, so many surrogates match or beat it). Deterministic via fixed seeds.
import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateFap } from "../src/detect/fap.ts";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import type { LightCurve } from "../src/core/types.ts";

// Keep the period grid narrow so the ~60 surrogate BLS runs stay fast in CI.
const GRID = { minPeriodDays: 2, maxPeriodDays: 6, oversample: 5 };

function noiseOnlyLightCurve(n: number, seed: number): LightCurve {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const points = [];
  for (let i = 0; i < n; i++) {
    // gaussian-ish via sum of uniforms, sigma ~ 300 ppm, no dip anywhere
    const g = (u() + u() + u() + u() - 2) * 0.0003;
    points.push({ time: 2457000 + i * 0.137, flux: 1 + g, fluxErr: 0.0003 });
  }
  return {
    targetId: "fap-noise",
    cadence: "PT20M",
    qualityFlag: "NOISE",
    source: "synthetic gaussian noise, no transit",
    points,
  };
}

test("an injected transit gets a near-floor FAP (highly significant)", () => {
  const { lc } = generateSyntheticTransit({
    seed: 42,
    periodDays: 3.5,
    planetRadiusEarth: 12,
    stellarRadiusRsun: 1.0,
    impactParam: 0.2,
    noisePpm: 120,
    cadenceSec: 120,
    baselineDays: 20,
    targetIdLabel: "fap-planet",
  });
  const res = estimateFap(lc, { trials: 80, seed: 7, bls: GRID });
  assert.ok(res.fap <= res.minResolvableFap + 1e-9, `expected floor FAP, got ${res.fap} (exceedances ${res.exceedances})`);
  assert.equal(res.exceedances, 0, "no surrogate should match a strong coherent transit");
});

test("pure noise is NOT declared significant (FAP well above the floor)", () => {
  const lc = noiseOnlyLightCurve(1200, 1234);
  const res = estimateFap(lc, { trials: 80, seed: 99, bls: GRID });
  // A noise peak is a null draw, so a healthy fraction of surrogates reach it.
  assert.ok(res.fap > 0.1, `noise FAP should be large, got ${res.fap}`);
});

test("FAP is deterministic: same seed reproduces the same null exceedances", () => {
  const lc = noiseOnlyLightCurve(900, 55);
  const a = estimateFap(lc, { trials: 40, seed: 2024, bls: GRID });
  const b = estimateFap(lc, { trials: 40, seed: 2024, bls: GRID });
  assert.equal(a.exceedances, b.exceedances);
  assert.equal(a.fap, b.fap);
});

test("a red-noise planet-free curve is NOT spuriously significant (block bootstrap keeps correlation)", () => {
  // Regression guard for audit #3: the OLD per-point time-jitter surrogate whitened the null, so a
  // strongly correlated (rho=0.6) planet-free curve got a floor FAP (~0) and looked significant -- the
  // p20 probe measured that FAR climbing to ~100%. The moving-block bootstrap preserves the AR(1)
  // structure, so the null ensemble matches the observed power and the FAP must NOT sit at the floor.
  const lc = makeRedNoiseLightCurve({
    seed: 77,
    periodDays: 5,
    depthFrac: 0,
    noisePpm: 300,
    rho: 0.6,
    cadenceSec: 120,
    baselineDays: 20,
    dutyCycle: 0.9,
    targetIdLabel: "fap-red",
  });
  const res = estimateFap(lc, { trials: 60, seed: 5, bls: GRID });
  assert.ok(res.fap > 0.05, `a red-noise null must not look significant; got FAP ${res.fap} (exceedances ${res.exceedances})`);
});
