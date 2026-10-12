import assert from "node:assert/strict";
import { bls, cadenceAwareOptions } from "../src/detect/bls.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { transitFlux } from "../src/sim/transitModel.ts";
import type { LightCurve } from "../src/core/types.ts";

// ---- cadenceAwareOptions: numeric semantics (smallest trial box >= k samples at this cadence) ----
{
  assert.equal(cadenceAwareOptions(1800).minDurationHours, 1.5, "30-min cadence, 3 samples -> 1.5h floor");
  assert.equal(cadenceAwareOptions(120).minDurationHours, 0.5, "2-min cadence floors to the 0.5h default");
  assert.equal(cadenceAwareOptions(0).minDurationHours, 0.5, "non-positive cadence -> default");
  assert.equal(cadenceAwareOptions(NaN).minDurationHours, 0.5, "NaN cadence -> default");
  assert.equal(cadenceAwareOptions(1800, { minSamplesInBox: 5 }).minDurationHours, 2.5);
  assert.equal(cadenceAwareOptions(28800).minDurationHours, 15, "huge cadence is capped at maxDurationCeil 15h");
  assert.equal(cadenceAwareOptions(1800, { oversample: 16 }).oversample, 16, "oversample passes through when asked");
}

// ---- a realistic 30-min FFI light curve with one clean injected transit ----
function makeLc(): LightCurve {
  const cadenceDays = 1800 / 86400; // 30 min
  const start = 2458000;
  const points = [];
  const orbit = { periodDays: 3, t0Bjd: start + 1, aOverRs: 12, impactParam: 0.5, planetRadiusRatio: 0.06 };
  for (let t = start; t < start + 27; t += cadenceDays) points.push({ time: t, flux: transitFlux(t, orbit) });
  return { targetId: "CADENCE TEST", mission: "TESS", cadenceSec: 1800, points };
}

// ---- the bundle-safety invariant: DEFAULT behaviour is byte-for-byte unchanged by adding the helper ----
{
  const lc = makeLc();
  const a = detectTransit(lc);
  const b = detectTransit(lc, {});
  assert.equal(a.bls.periodDays, b.bls.periodDays, "no-opts and {}-opts are identical (default untouched)");
  assert.equal(a.bls.snr, b.bls.snr);
}

// ---- opting in actually moves the search floor: bls cannot return a box thinner than requested ----
{
  const lc = makeLc();
  const opts = cadenceAwareOptions(1800); // minDurationHours 1.5
  const r = bls(lc, opts);
  assert.ok(r.durationDays * 24 >= opts.minDurationHours! - 1e-9, `adapted box >= ${opts.minDurationHours}h, got ${(r.durationDays * 24).toFixed(3)}h`);
}

console.log("cadenceAware.test.ts OK");
