// Offline tests for multi-year O-C coherence (validation roadmap, priority 3).
// Synthetic multi-year curves with box transits; deterministic. The point under test is that a
// Keplerian (linear O-C) signal scores high coherence while a wrong-period / noise / non-Keplerian
// candidate does not -- so coherence can rank candidate periods. Harmonic aliases are explicitly NOT
// broken by this (see module note) and are not tested as if they were.
import { test } from "node:test";
import assert from "node:assert/strict";

import { multiYearCoherence, rankByCoherence } from "../src/detect/multiYearCoherence.ts";

/** Build a normalized light curve with box dips centered at the given BJD times. */
function curve(centers: number[], opts: { tmin: number; tmax: number; cadence: number; depth: number; durDays: number; noise?: number; seed?: number }) {
  const times: number[] = [];
  const flux: number[] = [];
  let s = opts.seed ?? 7;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const half = opts.durDays / 2;
  for (let t = opts.tmin; t <= opts.tmax; t += opts.cadence) {
    let f = 1;
    for (const c of centers) {
      if (Math.abs(t - c) <= half) {
        f -= opts.depth;
        break;
      }
    }
    if (opts.noise) f += rand() * opts.noise;
    times.push(t);
    flux.push(f);
  }
  return { times, flux };
}

function centersAt(period: number, t0: number, tmin: number, tmax: number, jitter?: (k: number) => number): number[] {
  const out: number[] = [];
  const k0 = Math.ceil((tmin - t0) / period);
  const k1 = Math.floor((tmax - t0) / period);
  for (let k = k0; k <= k1; k++) out.push(t0 + k * period + (jitter ? jitter(k) : 0));
  return out;
}

const T0 = 2458400;
const P = 12;
const BASE = { tmin: T0 - 300, tmax: T0 + 300, cadence: 0.25, depth: 0.02, durDays: 1.2, noise: 0.0006 };

test("a clean Keplerian multi-year signal scores high coherence", () => {
  const { times, flux } = curve(centersAt(P, T0, BASE.tmin, BASE.tmax), BASE);
  const r = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  assert.equal(r.determined, true);
  assert.ok(r.nEvents >= 10, `expected many timed transits, got ${r.nEvents}`);
  assert.ok(r.coherence > 0.7, `clean signal should score high, got ${r.coherence}`);
  assert.ok(r.ocRmsHours < 12, `O-C should be tight, got ${r.ocRmsHours}h`);
});

test("an unrelated period scores lower than the true one", () => {
  const { times, flux } = curve(centersAt(P, T0, BASE.tmin, BASE.tmax), BASE);
  const truth = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  const wrong = multiYearCoherence(times, flux, 7.31, T0, { durationDays: 1.2 });
  assert.ok(truth.coherence > wrong.coherence, `truth ${truth.coherence} should exceed wrong ${wrong.coherence}`);
});

test("a flat (transit-free) curve is not determined and scores zero", () => {
  const { times, flux } = curve([], BASE);
  const r = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  assert.equal(r.determined, false);
  assert.equal(r.coherence, 0);
});

test("a non-Keplerian (drifting) signal scores lower than a clean one", () => {
  const clean = curve(centersAt(P, T0, BASE.tmin, BASE.tmax), BASE);
  // transits present but their centers drift off a straight line (quadratic O-C) -> smeared fit
  const drift = curve(centersAt(P, T0, BASE.tmin, BASE.tmax, (k) => 0.02 * k * k), BASE);
  const rc = multiYearCoherence(clean.times, clean.flux, P, T0, { durationDays: 1.2 });
  const rd = multiYearCoherence(drift.times, drift.flux, P, T0, { durationDays: 1.2 });
  assert.ok(rc.coherence > rd.coherence, `clean ${rc.coherence} should exceed drifting ${rd.coherence}`);
});

test("rankByCoherence returns candidates sorted by descending coherence, true period first", () => {
  const { times, flux } = curve(centersAt(P, T0, BASE.tmin, BASE.tmax), BASE);
  const cands = [{ periodDays: 7.31, epochBjd: T0 }, { periodDays: P, epochBjd: T0 }, { periodDays: 20.7, epochBjd: T0 }];
  const ranked = rankByCoherence(times, flux, cands, { durationDays: 1.2 });
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].coherence >= ranked[1].coherence && ranked[1].coherence >= ranked[2].coherence);
  assert.ok(Math.abs(ranked[0].periodDays - P) < 1e-9, `true period should rank first, got ${ranked[0].periodDays}`);
});

test("the score is deterministic for identical inputs", () => {
  const { times, flux } = curve(centersAt(P, T0, BASE.tmin, BASE.tmax), BASE);
  const a = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  const b = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  assert.equal(a.coherence, b.coherence);
  assert.equal(a.ocRmsHours, b.ocRmsHours);
});

test("a baseline too short to time 3 transits is not determined", () => {
  const { times, flux } = curve(centersAt(P, T0, T0 - 5, T0 + 5, (_k) => 0), { ...BASE, tmin: T0 - 5, tmax: T0 + 5 });
  const r = multiYearCoherence(times, flux, P, T0, { durationDays: 1.2 });
  assert.equal(r.determined, false);
});
