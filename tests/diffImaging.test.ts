// Offline tests for difference-imaging source localization (validation roadmap, priority 1).
// Everything runs on synthetic target-pixel cubes so it is deterministic and needs no
// network. The positive/negative contrast is the whole point of the method: a dip on the
// target star localizes at the starlight centroid (offset ~ 0), while a dip on an off-axis
// blend/EB localizes away from it (offset many arcsec).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localizeTransitSource,
  judgeLocalization,
  splitByPhase,
  PIXEL_SCALE_ARCSEC,
  type PixelCube,
} from "../src/detect/diffImaging.ts";

interface Star {
  x: number;
  y: number;
  amp: number;
  varies: boolean;
}

/** Build a Gaussian-aperture cube; stars flagged `varies` dim by `depth` during transit. */
function makeCube(stars: Star[], opts: { period: number; t0: number; durHours: number; baselineDays: number; cadenceDays: number; depth: number; nx?: number; ny?: number; noise?: number; seed?: number }): PixelCube {
  const nx = opts.nx ?? 14;
  const ny = opts.ny ?? 14;
  const n = Math.round(opts.baselineDays / opts.cadenceDays);
  const time = new Float64Array(n);
  const quality = new Float64Array(n);
  const flux = new Float64Array(n * nx * ny);
  const halfDur = opts.durHours / 24 / 2;
  let s = opts.seed ?? 1;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  for (let r = 0; r < n; r++) {
    const t = opts.t0 - opts.baselineDays / 2 + r * opts.cadenceDays;
    time[r] = t;
    quality[r] = 0;
    let d = (t - opts.t0) / opts.period;
    d -= Math.round(d);
    const isIn = Math.abs(d * opts.period) <= halfDur;
    const base = r * nx * ny;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let v = 0;
        for (const st of stars) {
          const amp = st.varies && isIn ? st.amp * (1 - opts.depth) : st.amp;
          v += amp * Math.exp(-(((x - st.x) ** 2 + (y - st.y) ** 2) / 2));
        }
        if (opts.noise) v += rand() * opts.noise;
        flux[base + y * nx + x] = v;
      }
    }
  }
  return { rows: n, nx, ny, time, quality, flux };
}

const EPOCH = { period: 6, t0: 2458400, durHours: 6, baselineDays: 60, cadenceDays: 0.01, depth: 0.03 };

test("on-target transit localizes at the starlight centroid (offset ~ 0)", () => {
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], EPOCH);
  const loc = localizeTransitSource(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours)!;
  assert.ok(loc.determined, "should be determined");
  assert.ok(loc.offsetArcsec < 0.5, `offset should be sub-pixel, got ${loc.offsetArcsec}"`);
  assert.ok(loc.depthFraction > 0.001 && loc.depthFraction < 0.2, `depthFraction sane, got ${loc.depthFraction}`);
  assert.ok(loc.concentration > 0.05, `a point source is concentrated, got ${loc.concentration}`);
  const v = judgeLocalization(loc, 1.0);
  assert.equal(v.classification, "on-target");
  assert.equal(v.onTarget, true);
});

test("off-axis blend localizes away from the target star (large offset, vetoed)", () => {
  const cube = makeCube(
    [
      { x: 6.5, y: 6.5, amp: 1e5, varies: false }, // steady target star
      { x: 3, y: 3, amp: 3e4, varies: true }, // contaminant that eclipses
    ],
    EPOCH,
  );
  const loc = localizeTransitSource(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours)!;
  assert.ok(loc.determined);
  // separation ~ (3.5,3.5) px -> ~ 4.95 px -> ~ 104 arcsec, far beyond any 1-2" threshold
  assert.ok(loc.offsetArcsec > 40, `blend offset should be large, got ${loc.offsetArcsec}"`);
  const v = judgeLocalization(loc, 1.0);
  assert.equal(v.classification, "off-target");
  assert.equal(v.onTarget, false);
});

test("a generous threshold downgrades an off-target blend to on-target (threshold matters)", () => {
  const cube = makeCube(
    [
      { x: 6.5, y: 6.5, amp: 1e5, varies: false },
      { x: 3, y: 3, amp: 3e4, varies: true },
    ],
    EPOCH,
  );
  const loc = localizeTransitSource(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours)!;
  const v = judgeLocalization(loc, 500); // absurdly loose threshold
  assert.equal(v.classification, "on-target");
});

test("too few in-transit cadences returns null and is inconclusive, never a veto", () => {
  // A short baseline (10 d, P=6 d) with a duration narrower than one cadence leaves
  // fewer than 3 in-transit samples, so the module must refuse to conclude.
  const cfg = { period: 6, t0: 2458400, durHours: 0.05, baselineDays: 10, cadenceDays: 0.01, depth: 0.03 };
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], cfg);
  const split = splitByPhase(cube, cfg.t0, cfg.period, cfg.durHours);
  assert.ok(split.inRows.length < 3, `expected <3 in-transit, got ${split.inRows.length}`);
  const loc = localizeTransitSource(cube, cfg.t0, cfg.period, cfg.durHours);
  assert.equal(loc, null);
  const v = judgeLocalization(loc, 1.0);
  assert.equal(v.classification, "inconclusive");
  assert.equal(v.onTarget, false);
});

test("offset error bar is deterministic for a fixed seed", () => {
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], { ...EPOCH, noise: 200 });
  const a = localizeTransitSource(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { seed: 99, bootstraps: 60 })!;
  const b = localizeTransitSource(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { seed: 99, bootstraps: 60 })!;
  assert.equal(a.offsetSigmaArcsec, b.offsetSigmaArcsec);
  assert.ok(Number.isFinite(a.offsetSigmaArcsec) && a.offsetSigmaArcsec >= 0);
});

test("the judge is conservative: it vetoes only when offset minus 1sigma clears the threshold", () => {
  const base = {
    targetCentroid: { x: 7, y: 7, flux: 1 },
    sourceCentroid: { x: 7, y: 7, flux: 1 },
    dropFlux: 1,
    depthFraction: 0.01,
    concentration: 0.2,
    inCount: 100,
    outCount: 1000,
    determined: true,
  };
  assert.equal(judgeLocalization({ ...base, offsetArcsec: 0.3, offsetSigmaArcsec: 0.1 }, 1).classification, "on-target");
  assert.equal(judgeLocalization({ ...base, offsetArcsec: 5, offsetSigmaArcsec: 0.5 }, 1).classification, "off-target");
  // offset above the threshold but its 1sigma bound is NOT -> inconclusive, never a veto
  assert.equal(judgeLocalization({ ...base, offsetArcsec: 1.5, offsetSigmaArcsec: 1.0 }, 1).classification, "inconclusive");
});

test("pixel scale constant matches the reader module", () => {
  assert.equal(PIXEL_SCALE_ARCSEC, 21);
});
