import assert from "node:assert/strict";
import { combineSectorFits, perSectorDepthEstimate, type SectorFit } from "../src/detect/perSector.ts";
import type { LightCurve } from "../src/core/types.ts";

// 1. MEDIAN resists the one smeared sector that a MEAN would chase -- the exact p12 failure mode.
{
  const fits: SectorFit[] = [{ depthFrac: 0.009, ok: true }, { depthFrac: 0.01, ok: true }, { depthFrac: 0.011, ok: true }, { depthFrac: 0.2, ok: true }];
  const c = combineSectorFits(fits);
  const mean = fits.reduce((a, f) => a + f.depthFrac, 0) / fits.length;
  assert.ok(c.medianDepthFrac >= 0.009 && c.medianDepthFrac <= 0.011, `median stays with the tight cluster, got ${c.medianDepthFrac}`);
  assert.ok(c.medianDepthFrac < mean / 2, `median ${c.medianDepthFrac} far below outlier-pulled mean ${mean.toFixed(4)}`);
  assert.equal(c.nUsable, 4);
  assert.ok(Number.isFinite(c.madFrac) && c.madFrac > 0);
}

// 2. !ok and non-finite depths are dropped, but nSectors still counts what was offered.
{
  const fits: SectorFit[] = [{ depthFrac: 0.01, ok: true }, { depthFrac: 0.012, ok: true }, { depthFrac: 0.9, ok: false }, { depthFrac: NaN, ok: true }];
  const c = combineSectorFits(fits);
  assert.equal(c.nUsable, 2, "the rejected + non-finite sectors are not pooled");
  assert.equal(c.nSectors, 4);
  assert.ok(Math.abs(c.medianDepthFrac - 0.011) < 1e-12, `median of the two usable -> 0.011, got ${c.medianDepthFrac}`);
}

// 3. Nothing usable -> NaN, no fake centre.
{
  const c = combineSectorFits([{ depthFrac: 0.01, ok: false }, { depthFrac: NaN, ok: true }]);
  assert.ok(Number.isNaN(c.medianDepthFrac) && Number.isNaN(c.madFrac) && c.nUsable === 0 && c.nSectors === 2);
}

// 4. Identical sectors -> zero spread; a real disagreement -> positive MAD.
{
  assert.equal(combineSectorFits([{ depthFrac: 0.02, ok: true }, { depthFrac: 0.02, ok: true }]).madFrac, 0);
  assert.ok(combineSectorFits([{ depthFrac: 0.01, ok: true }, { depthFrac: 0.03, ok: true }, { depthFrac: 0.02, ok: true }]).madFrac > 0);
}

// 5. The dependency-injected per-sector estimator maps each curve then merges (stub fit, no detector).
{
  const mk = (t: number): LightCurve => ({ targetId: "T", mission: "TESS", points: [{ time: t, flux: 1 }, { time: t + 1, flux: 1 }] });
  const depths = [0.008, 0.01, 0.012, 0.5]; // last sector smeared
  const est = perSectorDepthEstimate([mk(0), mk(10), mk(20), mk(30)], (lc) => ({ depthFrac: depths[lc.points[0].time], ok: true }));
  assert.equal(est.nSectors, 4);
  assert.ok(est.medianDepthFrac >= 0.008 && est.medianDepthFrac <= 0.012, `robust merge ignores the 0.5 outlier, got ${est.medianDepthFrac}`);
  // deterministic
  assert.deepEqual(est, perSectorDepthEstimate([mk(0), mk(10), mk(20), mk(30)], (lc) => ({ depthFrac: depths[lc.points[0].time], ok: true })));
}

console.log("perSector.test.ts OK");
