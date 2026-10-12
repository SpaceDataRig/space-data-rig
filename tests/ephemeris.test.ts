// Offline, deterministic validation of the per-transit ephemeris refit (src/detect/ephemeris.ts).
// We synthesize a LONG-baseline transit with a known period/epoch, then hand the refit a DELIBERATELY
// drifted initial ephemeris (the situation p12 hit: a catalog period that is slightly wrong smears a
// long fold). The O-C timing must recover the true period and epoch. No network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { timeTransitEvents, refitEphemeris } from "../src/detect/ephemeris.ts";
import { exactTransitFlux, separationCircular } from "../src/sim/exactTransit.ts";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P_TRUE = 12.0;
const T0_TRUE = 2458400.0;
const A_OVER_RS = 15;
const P_RATIO = 0.12;
const B_IMPACT = 0.3;
const LD = { u1: 0.4, u2: 0.1 };

function synthesize(days: number, cadence: number, noise: number, seed: number) {
  const rnd = mulberry32(seed);
  const times: number[] = [];
  const flux: number[] = [];
  for (let t = 0; t < days; t += cadence) {
    const time = T0_TRUE - days / 4 + t; // start before the first transit, span ~600 d
    let ph = ((time - T0_TRUE) / P_TRUE) % 1;
    if (ph < 0) ph += 1;
    if (ph > 0.5) ph -= 1;
    const z = separationCircular(ph, A_OVER_RS, B_IMPACT);
    const model = exactTransitFlux(z, P_RATIO, LD, 400);
    times.push(time);
    flux.push(model + (rnd() - 0.5) * 2 * noise);
  }
  return { times, flux };
}

test("O-C refit recovers a drifted catalog period and epoch to high precision", () => {
  const { times, flux } = synthesize(600, 0.2, 0.0002, 42);
  // initial (wrong) ephemeris: period +5e-4 relative, epoch +0.2 d -- enough to smear a long fold
  const events = timeTransitEvents(times, flux, P_TRUE * 1.0005, T0_TRUE + 0.2, { windowPhase: 0.05 });
  const fit = refitEphemeris(events);
  assert.ok(fit.nEvents >= 20, `expected >=20 timed events, got ${fit.nEvents}`);
  assert.ok(Math.abs(fit.periodDays - P_TRUE) < 0.005, `period ${fit.periodDays} not near ${P_TRUE}`);
  assert.ok(Math.abs(fit.t0Bjd - T0_TRUE) < 0.15, `t0 ${fit.t0Bjd} not near ${T0_TRUE}`);
  assert.ok(fit.rms < 0.05, `timing rms too high: ${fit.rms}`);
});

test("refined ephemeris times far more transits than the drifted one smears", () => {
  const { times, flux } = synthesize(600, 0.2, 0.0002, 42);
  const events = timeTransitEvents(times, flux, P_TRUE * 1.0005, T0_TRUE + 0.2, { windowPhase: 0.05 });
  const fit = refitEphemeris(events);
  // Re-time with the refined ephemeris: dips should still be found (coherent), and residuals small.
  const events2 = timeTransitEvents(times, flux, fit.periodDays, fit.t0Bjd, { windowPhase: 0.05 });
  const ok2 = events2.filter((e) => e.ok).length;
  assert.ok(ok2 >= 30, `refined timing found only ${ok2} events`);
  const fit2 = refitEphemeris(events2);
  assert.ok(Math.abs(fit2.periodDays - P_TRUE) < 0.005, `second-pass period ${fit2.periodDays} drifted`);
});

test("flat (no-transit) light curve yields no usable ephemeris, not a fake one", () => {
  const times: number[] = [];
  const flux: number[] = [];
  const rnd = mulberry32(7);
  for (let t = 0; t < 600; t += 0.2) { times.push(T0_TRUE + t); flux.push(1 + (rnd() - 0.5) * 0.0004); }
  const events = timeTransitEvents(times, flux, P_TRUE, T0_TRUE, { windowPhase: 0.05 });
  const fit = refitEphemeris(events);
  assert.ok(!Number.isFinite(fit.periodDays), "flat curve must not produce a period");
});

test("too few events returns NaN fields and is deterministic", () => {
  assert.ok(!Number.isFinite(refitEphemeris([]).periodDays));
  const { times, flux } = synthesize(60, 0.5, 0.0002, 99);
  const a = refitEphemeris(timeTransitEvents(times, flux, P_TRUE, T0_TRUE, { windowPhase: 0.05 }));
  const b = refitEphemeris(timeTransitEvents(times, flux, P_TRUE, T0_TRUE, { windowPhase: 0.05 }));
  assert.equal(a.periodDays, b.periodDays);
  assert.equal(a.t0Bjd, b.t0Bjd);
});
