import assert from "node:assert/strict";
import { robustPerSectorDepth } from "../src/detect/perSectorRun.ts";
import { transitFlux } from "../src/sim/transitModel.ts";
import type { LightCurve } from "../src/core/types.ts";

const PERIOD = 3.5;
const EPOCH = 2458100;
const STAR_R = 0.66; // -> Kepler a/Rs ~12.6, matching the injected orbit below

// One sector = a 9-day window at 5-min cadence containing a clean (or deliberately biased) transit.
function makeSector(startDay: number, depthFrac: number): LightCurve {
  const cadenceDays = 300 / 86400;
  const p = Math.sqrt(depthFrac); // radius ratio ~ sqrt(depth) for the near-uniform source limit
  const orbit = { periodDays: PERIOD, t0Bjd: EPOCH, aOverRs: 12.6, impactParam: 0.3, planetRadiusRatio: p };
  const points = [];
  for (let t = EPOCH + startDay; t < EPOCH + startDay + 9; t += cadenceDays) {
    points.push({ time: t, flux: transitFlux(t, orbit) });
  }
  return { targetId: `SECTOR ${startDay}`, mission: "TESS", cadenceSec: 300, points };
}

async function run() {
  // 3 clean ~1% sectors + 1 smeared ~3% sector; the median must land near 1%, not chase the outlier.
  const sectors = [1, 2, 3, 4];
  const curves = new Map<number, LightCurve>([
    [1, makeSector(0, 0.01)],
    [2, makeSector(20, 0.01)],
    [3, makeSector(40, 0.012)],
    [4, makeSector(60, 0.03)], // biased outlier
  ]);
  let fetches = 0;
  const est = await robustPerSectorDepth({
    tic: 999,
    sectors,
    label: "TEST",
    periodDays: PERIOD,
    epochBjd: EPOCH,
    starRadiusRsun: STAR_R,
    fetchSector: async (_tic, s) => { fetches++; return curves.get(s) ?? null; },
  });
  assert.ok(est, "returns an estimate when >=2 sectors are characterisable");
  assert.ok(est!.nUsable >= 3, `used the tight cluster of sectors, got nUsable=${est!.nUsable}`);
  assert.ok(est!.medianDepthFrac > 0.006 && est!.medianDepthFrac < 0.018, `robust median near the true ~1%, got ${(est!.medianDepthFrac * 1e6).toFixed(0)}ppm`);
  assert.ok(est!.medianDepthFrac < 0.02, "median shrugs off the 3% outlier a mean would chase");

  // Safe fallback: fewer than minUsable sectors -> null (caller keeps its single-fit depth).
  const single = await robustPerSectorDepth({
    tic: 999,
    sectors: [1, 2, 3, 4],
    label: "TEST",
    periodDays: PERIOD,
    epochBjd: EPOCH,
    starRadiusRsun: STAR_R,
    fetchSector: async (_tic, s) => (s === 1 ? curves.get(1)! : null), // only one sector available
  });
  assert.equal(single, null, "one usable sector is not enough to trust a median -> null fallback");

  // Cost cap: only maxSectors are fetched even if more are offered.
  let capped = 0;
  await robustPerSectorDepth({
    tic: 999,
    sectors: [1, 2, 3, 4, 5, 6, 7, 8],
    label: "TEST",
    periodDays: PERIOD,
    epochBjd: EPOCH,
    starRadiusRsun: STAR_R,
    maxSectors: 3,
    fetchSector: async () => { capped++; return null; },
  });
  assert.equal(capped, 3, "fetches at most maxSectors sectors");
}

await run();
console.log("perSectorRun.test.ts OK");
