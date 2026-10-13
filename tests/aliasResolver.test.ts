// Period-alias resolver (odd/even per-epoch depth test). Offline, deterministic, NO network.
// Load-bearing property: when BLS locks a HALF-period alias (dips actually occur every 2nd candidate
// epoch), resolvePeriodAlias must multiply the period back to the true one; a genuine period-1 signal
// must be left alone. This is the disambiguation p30 relies on to turn a coarse joint BLS peak into the
// real orbit before cross-sector confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePeriodAlias } from "../src/sim/aliasResolver.ts";

// Build a light curve with a transit of the given depth+width at every `truePeriod` days across a span.
function curve(truePeriod: number, depth: number, widthDays: number, spanDays: number, cadence: number) {
  const times: number[] = [];
  const flux: number[] = [];
  for (let t = 0; t <= spanDays; t += cadence) {
    const ph = ((t % truePeriod) + truePeriod) % truePeriod;
    const dCenter = Math.min(ph, truePeriod - ph);
    times.push(t);
    flux.push(dCenter <= widthDays / 2 ? 1 - depth : 1.0);
  }
  return { times, flux };
}

test("a half-period alias is multiplied back to the true period", () => {
  // true period 6 d; we hand the resolver the P/2 = 3 d alias with an epoch on a real transit.
  const { times, flux } = curve(6.0, 0.01, 0.5, 60, 0.1);
  const r = resolvePeriodAlias(times, flux, 3.0, 0.0, 0.5);
  assert.equal(r.multiple, 2, "should detect dips every 2nd candidate epoch");
  assert.ok(Math.abs(r.period - 6.0) < 1e-9, `expected resolved period 6, got ${r.period}`);
});

test("a genuine period-1 signal is left alone", () => {
  const { times, flux } = curve(5.0, 0.01, 0.5, 60, 0.1);
  const r = resolvePeriodAlias(times, flux, 5.0, 0.0, 0.5);
  assert.equal(r.multiple, 1, "no alias to fix");
  assert.ok(Math.abs(r.period - 5.0) < 1e-9, `expected period 5, got ${r.period}`);
});

test("too few measurable epochs returns multiple 1 (refuses to guess)", () => {
  // a very long period relative to the span -> fewer than 3 transit epochs -> no alias decision
  const { times, flux } = curve(40.0, 0.01, 0.5, 60, 0.5);
  const r = resolvePeriodAlias(times, flux, 40.0, 0.0, 0.5);
  assert.equal(r.multiple, 1);
  assert.ok(r.nEpochs < 3 || r.multiple === 1);
});
