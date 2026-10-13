// Window-function alias ambiguity (src/detect/windowAlias.ts). Offline, deterministic, NO network.
// Load-bearing properties: the spectral window must be high for daily-gapped sampling and low for continuous
// sampling; the daily-alias period algebra must be right; a clean transit must show LOW alias ambiguity while a
// daily-sampled curve carrying a 1-cycle/day artifact must show HIGH window power and near-1 ambiguity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spectralWindowPower,
  strongestWindowSidelobe,
  dailyAliasPeriods,
  snrAtPeriod,
  windowAliasAmbiguity,
} from "../src/detect/windowAlias.ts";
import type { LightCurve } from "../src/core/types.ts";

function curveFrom(times: number[], flux: number[], cadenceSec = 200): LightCurve {
  return {
    targetId: "test",
    mission: "synthetic",
    cadenceSec,
    points: times.map((t, i) => ({ time: t, flux: flux[i]!, fluxErr: 1e-4 })),
    source: "unit-test",
  };
}

// Times sampled continuously (every 0.01 d across 27 d) vs nightly-gapped: many points clustered inside a
// fixed phase-of-day window each night, with a ~1 day gap between nights (the classic daily-alias sampling).
const continuous: number[] = [];
for (let t = 0; t <= 27; t += 0.01) continuous.push(t);
const dailyGapped: number[] = [];
for (let d = 0; d <= 13; d++) for (let x = 0.2; x <= 0.4 + 1e-9; x += 0.01) dailyGapped.push(d + x);

test("spectral window at 1 c/d is near-zero for continuous sampling and high for daily-gapped sampling", () => {
  const cont = spectralWindowPower(continuous, 1);
  const daily = spectralWindowPower(dailyGapped, 1);
  assert.ok(cont < 0.05, `continuous sampling should carry almost no 1 c/d window power, got ${cont}`);
  assert.ok(daily > 0.7, `daily-gapped sampling should carry strong 1 c/d window power, got ${daily}`);
});

test("strongestWindowSidelobe finds the daily alias frequency for daily-gapped sampling", () => {
  const side = strongestWindowSidelobe(dailyGapped);
  assert.ok(Math.abs(side.freqCpd - 1) < 0.05, `expected the dominant sidelobe near 1 c/d, got ${side.freqCpd}`);
  assert.ok(side.power > 0.7, `expected strong sidelobe power, got ${side.power}`);
});

test("dailyAliasPeriods computes the +/- 1 c/d alias algebra and excludes the input period", () => {
  const a3 = dailyAliasPeriods(3);
  assert.ok(a3.some((p) => Math.abs(p - 0.75) < 1e-9), `P=3 d should alias to 1/(1/3+1)=0.75 d, got ${a3}`);
  assert.ok(!a3.includes(3), "the input period must not be its own alias");
  const a1 = dailyAliasPeriods(1);
  assert.ok(a1.some((p) => Math.abs(p - 0.5) < 1e-9), `P=1 d should alias to 1/(1+1)=0.5 d, got ${a1}`);
  assert.deepEqual(dailyAliasPeriods(0), [], "a non-positive period yields no aliases");
});

test("snrAtPeriod recovers a clean injected transit at its true period and not at a far alias", () => {
  const P = 3, depth = 0.02, width = 0.12;
  const flux = continuous.map((t) => {
    const ph = ((t % P) + P) % P;
    return 1 - (Math.abs(ph - P / 2) < width / 2 ? depth : 0);
  });
  const lc = curveFrom(continuous, flux);
  const atTrue = snrAtPeriod(lc, P);
  const atFar = snrAtPeriod(lc, 0.75);
  assert.ok(atTrue > 8, `expected a strong recovery at the true period, got ${atTrue}`);
  assert.ok(atFar < atTrue * 0.5, `the far alias should be much weaker (${atFar}) than the true peak (${atTrue})`);
});

test("a clean transit on continuous sampling has low window-alias ambiguity (true period wins decisively)", () => {
  const P = 3, depth = 0.02, width = 0.12;
  const flux = continuous.map((t) => {
    const ph = ((t % P) + P) % P;
    return 1 - (Math.abs(ph - P / 2) < width / 2 ? depth : 0);
  });
  const rep = windowAliasAmbiguity(curveFrom(continuous, flux), P);
  assert.ok(rep.snrBest > 8, `expected a strong peak, got ${rep.snrBest}`);
  assert.ok(rep.ambiguity < 0.6, `a clean signal should not be alias-ambiguous, got ${rep.ambiguity}`);
  assert.ok(rep.windowAliasRisk < 0.1, `continuous sampling has no daily window to project an alias, risk ${rep.windowAliasRisk}`);
});

test("a 1 c/d artifact on nightly-gapped sampling is flagged as a high window-alias risk", () => {
  // A dip recurring at the same phase-of-day every night: the true and the 1 c/d-aliased periods are nearly
  // indistinguishable AND the nightly-gapped sampling carries the window power to project them.
  const flux = dailyGapped.map((t) => 1 - 0.02 * (Math.abs((t % 1) - 0.3) < 0.03 ? 1 : 0));
  const rep = windowAliasAmbiguity(curveFrom(dailyGapped, flux, 3600), 1);
  assert.ok(rep.dailyWindowPower > 0.7, `nightly-gapped sampling should show strong window power, got ${rep.dailyWindowPower}`);
  assert.ok(rep.sidelobePower > 0.7, `dominant sidelobe should be strong, got ${rep.sidelobePower}`);
  assert.ok(rep.windowAliasRisk > 0.2, `a daily artifact on daily sampling should be a real window risk, got ${rep.windowAliasRisk}`);
});
