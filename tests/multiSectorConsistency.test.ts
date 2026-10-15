// Offline tests for the multi-sector centroid-consistency statistic (P74, borrowed from the
// eumemic/exoplanets cross-sector centroid test). Everything is synthetic and deterministic.
// The whole point is that a coherent off-target offset survives vector-averaging while random
// per-sector errors cancel -- so the test both rejects a consistent blend and refuses to kill a
// planet whose per-sector offsets are large but incoherent.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  multiSectorCentroidConsistency,
  judgeConsistency,
  type VectorOffset,
} from "../src/detect/diffImaging.ts";

test("coherent offsets across many sectors: high R, significant Rayleigh p, large resultant", () => {
  const offs: VectorOffset[] = Array.from({ length: 8 }, () => ({ dxArcsec: 5, dyArcsec: 0 }));
  const r = multiSectorCentroidConsistency(offs);
  assert.equal(r.n, 8);
  assert.ok(Math.abs(r.resultantArcsec - 5) < 1e-9);
  assert.ok(Math.abs(r.meanMagArcsec - 5) < 1e-9);
  assert.ok(Math.abs(r.consistencyR - 1) < 1e-9);
  // perfectly coherent 8 sectors -> Rayleigh p = exp(-8) ~ 3.4e-4 < 0.001
  assert.ok(r.rayleighP < 0.001, `p ${r.rayleighP}`);
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, true);
});

test("anti-coherent offsets cancel to ~zero resultant: keep the target even though each is large", () => {
  const offs: VectorOffset[] = [
    ...Array.from({ length: 4 }, () => ({ dxArcsec: 5, dyArcsec: 0 })),
    ...Array.from({ length: 4 }, () => ({ dxArcsec: -5, dyArcsec: 0 })),
  ];
  const r = multiSectorCentroidConsistency(offs);
  assert.equal(r.n, 8);
  assert.ok(r.resultantArcsec < 1e-9, `resultant ${r.resultantArcsec}`);
  assert.equal(r.consistencyR, 0);
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, false);
});

test("only 2 coherent sectors: direction is coherent but the small-sample Rayleigh bar is NOT met (conservative by design)", () => {
  const offs: VectorOffset[] = [{ dxArcsec: 5, dyArcsec: 0 }, { dxArcsec: 5, dyArcsec: 0 }];
  const r = multiSectorCentroidConsistency(offs);
  assert.equal(r.consistencyR, 1);
  // exp(-2) ~ 0.135 > 0.001: with 2 sectors the p<0.001 bar cannot fire -- refuses to veto.
  assert.ok(r.rayleighP > 0.001, `p ${r.rayleighP}`);
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, false);
});

test("a single usable sector cannot test consistency -> keep", () => {
  const r = multiSectorCentroidConsistency([{ dxArcsec: 9, dyArcsec: 0 }]);
  assert.equal(r.n, 1);
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, false);
});

test("empty input -> determined=false -> keep", () => {
  const r = multiSectorCentroidConsistency([]);
  assert.equal(r.determined, false);
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, false);
});

test("perpendicular offsets: partial coherence, resultant below the p bar -> keep", () => {
  const r = multiSectorCentroidConsistency([{ dxArcsec: 5, dyArcsec: 0 }, { dxArcsec: 0, dyArcsec: 5 }]);
  assert.ok(r.resultantArcsec < 4); // hypot(2.5,2.5) ~ 3.54
  assert.equal(judgeConsistency(r, 1.0).rejectTarget, false);
});

test("NaN offsets are dropped, not counted", () => {
  const r = multiSectorCentroidConsistency([{ dxArcsec: 5, dyArcsec: 0 }, { dxArcsec: NaN, dyArcsec: 2 }]);
  assert.equal(r.n, 1);
});
