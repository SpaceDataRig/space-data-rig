import assert from "node:assert/strict";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";

const grid = { minPeriodDays: 1, maxPeriodDays: 6, oversample: 8, nDurations: 8 };

// host curve: real-ish white/red light, planet-free (depthFrac 0) so any recovery is the injection.
function host(seed: number) {
  return makeRedNoiseLightCurve({ seed, periodDays: 2.5, depthFrac: 0, noisePpm: 300, rho: 0.3, cadenceSec: 150, baselineDays: 22 });
}

// 1. A deep injected transit is recovered at the true period (multiplicative dip on real sampling).
{
  const h = host(9);
  const inj = injectTransitInto(h, { seed: 100, periodDays: 2.5, depthFrac: 0.02 });
  const r = bls(preprocess(inj, 0.5), grid);
  assert.ok(periodMatched(r.periodDays, 2.5, 2), `deep injection not period-matched: ${r.periodDays}`);
  assert.ok(r.snr >= 8, `deep injection should be strong, got ${r.snr.toFixed(1)}`);
  assert.match(String(inj.source ?? ""), /injected into/);
}

// 2. depthFrac 0 is a no-op: the injected curve equals the host point-for-point (only a control pass).
{
  const h = host(11);
  const pass = injectTransitInto(h, { seed: 5, periodDays: 3.0, depthFrac: 0 });
  assert.equal(pass.points.length, h.points.length);
  for (let i = 0; i < pass.points.length; i++) {
    assert.equal(pass.points[i].flux, h.points[i].flux); // p=0 -> transitFlux==1 -> flux unchanged
  }
}

// 3. Determinism: same seed + same options -> identical curve.
{
  const h = host(13);
  const a = injectTransitInto(h, { seed: 77, periodDays: 2.2, depthFrac: 0.01 });
  const b = injectTransitInto(h, { seed: 77, periodDays: 2.2, depthFrac: 0.01 });
  assert.deepEqual(a.points, b.points);
}

// 4. Completeness is monotone in depth: deep injections are recovered at least as often as shallow.
{
  const recover = (depth: number) => {
    let hit = 0;
    const n = 12;
    for (let k = 0; k < n; k++) {
      const h = host(200 + k);
      const P = 2.0 + (k % 3) * 0.4;
      const inj = injectTransitInto(h, { seed: 500 + k, periodDays: P, depthFrac: depth });
      try {
        const r = bls(preprocess(inj, 0.5), grid);
        if (r.snr >= 7 && periodMatched(r.periodDays, P, 2)) hit++;
      } catch { /* miss */ }
    }
    return hit / n;
  };
  const deep = recover(0.02);
  const shallow = recover(0.0015);
  assert.ok(deep >= shallow, `deep completeness (${deep}) must be >= shallow (${shallow})`);
  assert.ok(deep >= 0.6, `deep injections should mostly be recovered, got ${deep}`);
}

console.log("injectInto.test.ts OK");
