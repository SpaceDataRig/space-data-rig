// Offline validation for the exact-transit fit. We synthesize a folded phase curve from the SAME
// exact model with KNOWN (p, b, aOverRs), then check the fitter recovers depth and shape. The fit
// grid is deterministic, so the noiseless case must recover truth to grid resolution and a modest
// fixed-seed noise must still land within a few percent. Pure, deterministic, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { exactTransitFlux, separationCircular } from "../src/sim/exactTransit.ts";
import { foldAtPhase, fitExactTransit } from "../src/detect/transitFit.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t ^ 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LD = { u1: 0.4, u2: 0.1 };

/** Build a synthetic folded curve at cadence-like spacing across one full phase cycle. */
function synthFolded(aOverRs: number, p: number, b: number, noiseSd: number, seed: number) {
  const rand = mulberry32(seed);
  const N = 1400;
  const folded: { phase: number; flux: number }[] = [];
  for (let i = 0; i < N; i++) {
    const phase = -0.5 + i / (N - 1);
    const z = separationCircular(phase, aOverRs, b);
    const clean = exactTransitFlux(z, p, LD, 2000);
    const noise = noiseSd === 0 ? 0 : (rand() + rand() + rand() - 1.5) * noiseSd; // ~triangular
    folded.push({ phase, flux: clean + noise });
  }
  return folded;
}

test("noiseless: recovers depth and radius ratio to grid resolution", () => {
  const aOverRs = 12;
  const p = 0.1;
  const b = 0.3;
  const folded = synthFolded(aOverRs, p, b, 0, 1);
  const fit = fitExactTransit(folded, { aOverRs });
  const truthDepth = 1 - exactTransitFlux(b, p, LD, 4000);
  assert.ok(Number.isFinite(fit.depthFrac), "fit should succeed");
  assert.ok(
    Math.abs(fit.depthFrac - truthDepth) / truthDepth < 0.05,
    `depth ${fit.depthFrac} vs truth ${truthDepth}`,
  );
  assert.ok(Math.abs(fit.radiusRatio - p) / p < 0.05, `p ${fit.radiusRatio} vs ${p}`);
  assert.ok(fit.impactParam >= 0 && fit.impactParam < 0.95, `b in range: ${fit.impactParam}`);
});

test("with realistic noise: recovers depth within ~10%", () => {
  const aOverRs = 15;
  const p = 0.12;
  const b = 0.45;
  const folded = synthFolded(aOverRs, p, b, 4e-4, 7); // ~400 ppm scatter
  const fit = fitExactTransit(folded, { aOverRs });
  const truthDepth = 1 - exactTransitFlux(b, p, LD, 4000);
  assert.ok(
    Math.abs(fit.depthFrac - truthDepth) / truthDepth < 0.12,
    `noisy depth ${fit.depthFrac} vs truth ${truthDepth}`,
  );
});

test("monotonic: a larger planet yields a larger recovered depth", () => {
  const aOverRs = 12;
  const dSmall = fitExactTransit(synthFolded(aOverRs, 0.05, 0.2, 0, 3), { aOverRs }).depthFrac;
  const dLarge = fitExactTransit(synthFolded(aOverRs, 0.15, 0.2, 0, 3), { aOverRs }).depthFrac;
  assert.ok(dLarge > dSmall * 4, `dLarge ${dLarge} should exceed ~9x dSmall ${dSmall} (p^2 scaling)`);
});

test("too few in-window points degrades gracefully to NaN, not a throw", () => {
  const aOverRs = 12;
  // every sample sits far from conjunction (|phase| > 0.3) so the transit window is unpopulated
  const sparse: { phase: number; flux: number }[] = [];
  for (let i = 0; i < 40; i++) sparse.push({ phase: i % 2 ? 0.32 + i / 200 : -(0.32 + i / 200), flux: 1 });
  const fit = fitExactTransit(sparse, { aOverRs });
  assert.ok(Number.isNaN(fit.depthFrac), "should be NaN when the transit is unpopulated");
  assert.equal(fit.nInWindow, 0);
});

test("foldAtPhase centers the transit at phase 0", () => {
  // one transit at t0, period 3d; sample times around it
  const t0 = 2000;
  const P = 3;
  const times: number[] = [];
  const flux: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = t0 + (i / 199 - 0.5) * 6 * P; // 6 periods of coverage
    times.push(t);
    const ph = ((t - t0) / P) % 1;
    const wrapped = ph > 0.5 ? ph - 1 : ph; // true centered phase
    flux.push(1 - 0.01 * Math.exp(-((wrapped * P) ** 2) / (2 * 0.05 ** 2))); // dip centered at t0
  }
  const folded = foldAtPhase(times, flux, P, t0);
  // the minimum flux should be near phase 0
  let minAt = folded[0];
  for (const f of folded) if (f.flux < minAt.flux) minAt = f;
  assert.ok(Math.abs(minAt.phase) < 0.02, `dip should sit at phase ~0, got ${minAt.phase}`);
});
