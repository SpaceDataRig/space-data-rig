// Behavioural tests for the scrambled false-alarm null + Robovetter-style completeness/reliability metrics.
// Everything here is offline and deterministic: a hand-built light curve with one deep periodic transit, a stub
// detector, and a synthetic labelled TCE pool. The load-bearing scientific claims we pin are (1) scrambling
// genuinely DESTROYS a coherent transit (a circular shift would not -- the known trap), (2) the amplitude
// distribution is preserved, (3) completeness / false-alarm-reliability / the joint objective compute correctly,
// and (4) optimizeThreshold picks the min-objective row.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scrambleFlux,
  collectScrambledTces,
  classifyTces,
  completeness,
  falseAlarmReliability,
  jointObjective,
  sweepThresholds,
  optimizeThreshold,
  type Tce,
  type TceClass,
} from "../src/detect/falseAlarmNull.ts";
import type { LightCurve } from "../src/core/types.ts";

// One deep box transit (P days) on top of flat baseline, tiny deterministic noise, no gaps.
function transitCurve(n = 300, period = 3, depth = 0.02): LightCurve {
  const points = [];
  for (let i = 0; i < n; i++) {
    const t = 2457000 + (i * period) / 40; // ~40 cadences per period
    const inT = ((t - 2457000) % period) < period * 0.05;
    points.push({ time: t, flux: inT ? 1 - depth : 1, fluxErr: 0.0001 });
  }
  return { targetId: "tc", mission: "synthetic", points };
}

// Mean in-phase minus out-of-phase depth (ppm) when folded at `period` -- a cheap, dependency-free "does a
// transit still stack here" statistic, used only to prove scrambling breaks coherence.
function foldedDepthPpm(lc: LightCurve, period: number): number {
  const ref = lc.points[0]!.time;
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (const p of lc.points) {
    const ph = (((p.time - ref) / period) % 1 + 1) % 1;
    if (ph < 0.05) { inSum += p.flux; inN++; } else { outSum += p.flux; outN++; }
  }
  if (!inN || !outN) return 0;
  return (outSum / outN - inSum / inN) * 1e6;
}

test("scrambleFlux is deterministic per seed and differs across seeds", () => {
  const lc = transitCurve();
  const a = scrambleFlux(lc, { seed: 7 });
  const b = scrambleFlux(lc, { seed: 7 });
  const c = scrambleFlux(lc, { seed: 8 });
  assert.deepEqual(a.points.map((p) => p.flux), b.points.map((p) => p.flux));
  assert.notDeepEqual(a.points.map((p) => p.flux), c.points.map((p) => p.flux));
});

test("scrambleFlux does not mutate its input", () => {
  const lc = transitCurve();
  const before = lc.points.map((p) => p.flux);
  scrambleFlux(lc, { seed: 3 });
  assert.deepEqual(lc.points.map((p) => p.flux), before);
});

test("shuffle scramble preserves the flux multiset and the cadence grid", () => {
  const lc = transitCurve();
  const s = scrambleFlux(lc, { seed: 11 });
  assert.equal(s.points.length, lc.points.length);
  const src = [...lc.points.map((p) => p.flux)].sort((x, y) => x - y);
  const dst = [...s.points.map((p) => p.flux)].sort((x, y) => x - y);
  assert.deepEqual(dst, src);
  for (let i = 0; i < s.points.length; i++) assert.equal(s.points[i]!.time, lc.points[i]!.time);
});

test("scrambling destroys a coherent transit in both modes (a circular shift would not)", () => {
  const lc = transitCurve();
  const period = 3;
  const original = foldedDepthPpm(lc, period);
  assert.ok(original > 10000, `expected a deep transit to stack, got ${original} ppm`);
  const shuffle = foldedDepthPpm(scrambleFlux(lc, { seed: 5, mode: "shuffle" }), period);
  const block = foldedDepthPpm(scrambleFlux(lc, { seed: 5, mode: "block", blockLength: 6 }), period);
  assert.ok(shuffle < original * 0.25, `shuffle should collapse coherence: ${shuffle} vs ${original}`);
  assert.ok(block < original * 0.5, `block should break cross-block coherence: ${block} vs ${original}`);
});

test("collectScrambledTces yields one false-alarm-provenance TCE per (curve, perCurve)", () => {
  const curves = [transitCurve(), transitCurve()];
  const detect = () => ({ periodDays: 3, stat: 8 });
  const tces = collectScrambledTces(curves, detect, { seedBase: 100, perCurve: 2 });
  assert.equal(tces.length, 4);
  assert.ok(tces.every((t) => t.injected === false && t.class === undefined));
});

test("completeness / false-alarm-reliability / joint objective compute on a known pool", () => {
  // 4 injected: 2 recovered above threshold (PC), 2 missed (FA). 4 scrambled: 2 clear the gate (FA), 2 do not.
  const pool: Tce[] = [
    { targetId: "a", periodDays: 3, stat: 9, injected: true, truthPeriodDays: 3 },
    { targetId: "b", periodDays: 3, stat: 7, injected: true, truthPeriodDays: 3 },
    { targetId: "c", periodDays: 5, stat: 9, injected: true, truthPeriodDays: 3 }, // wrong period -> FA
    { targetId: "d", periodDays: 3, stat: 4, injected: true, truthPeriodDays: 3 }, // below gate -> FA
    { targetId: "e", periodDays: 4, stat: 9, injected: false }, // scrambled, cleared gate -> FA
    { targetId: "f", periodDays: 2, stat: 6, injected: false }, // scrambled, below gate -> not PC
    { targetId: "g", periodDays: 1, stat: 3, injected: false },
    { targetId: "h", periodDays: 8, stat: 5, injected: false },
  ];
  const classes: TceClass[] = classifyTces(pool, 6);
  assert.equal(completeness(pool, classes), 2 / 4);
  // PCs are a,b (recovered injections) and e,f (scrambled peaks that cleared the gate -> surviving candidates).
  // R_FA = injected-and-recovered PC / all PC = 2/4: the scrambled survivors are exactly what erodes reliability.
  assert.equal(falseAlarmReliability(pool, classes), 2 / 4);
  assert.equal(jointObjective(0.5, 0.5), Math.hypot(0.5, 0.5));
});

test("an un-alias-matched injected TCE counts as FA, not PC", () => {
  const pool: Tce[] = [{ targetId: "x", periodDays: 6.0, stat: 20, injected: true, truthPeriodDays: 3.0 }];
  // 6.0 / 3.0 = 2.0 which IS a low-order harmonic alias, so it should be accepted as recovered.
  assert.equal(completeness(pool, classifyTces(pool, 6)), 1);
  const off: Tce[] = [{ targetId: "y", periodDays: 4.4, stat: 20, injected: true, truthPeriodDays: 3.0 }];
  assert.equal(completeness(off, classifyTces(off, 6)), 0);
});

test("sweepThresholds + optimizeThreshold pick the min-objective threshold and propagate nulls", () => {
  const pool: Tce[] = [
    { targetId: "a", periodDays: 3, stat: 9, injected: true, truthPeriodDays: 3 },
    { targetId: "b", periodDays: 3, stat: 6, injected: true, truthPeriodDays: 3 },
    { targetId: "c", periodDays: 4, stat: 9, injected: false },
    { targetId: "d", periodDays: 2, stat: 6, injected: false },
  ];
  const rows = sweepThresholds(pool, [5, 8]);
  assert.equal(rows.length, 2);
  // threshold 8 keeps a (PC) + c (scrambled FA) -> C=1/2, R_FA=1/2; threshold 5 same set at these stats.
  const best = optimizeThreshold(rows);
  assert.ok(best && best.objective != null);
  const noInject: Tce[] = [{ targetId: "z", periodDays: 1, stat: 9, injected: false }];
  assert.equal(jointObjective(completeness(noInject, classifyTces(noInject, 5)), falseAlarmReliability(noInject, classifyTces(noInject, 5))), null);
  assert.equal(optimizeThreshold([{ threshold: 1, c: null, rFa: null, objective: null }]), null);
});
