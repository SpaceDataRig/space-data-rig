// Offline tests for PSF-model double-difference localization (discovery roadmap, priority 2).
// Synthetic target-pixel cubes only -- deterministic, no network. The point of this method over
// the naive centroid (src/detect/diffImaging.ts) is MODEL COMPARISON: a clean point-source drop
// ON the target fits a PSF at the star well and gains little from moving it; a genuine off-axis
// blend gains a LOT (large deltaChi2) and is vetoed; and a coherent dipole systematic -- the thing
// that fooled the naive centroid into a ~24" false offset -- fits neither hypothesis as a point
// source, so the judge must REFUSE to veto it. Whether it is safe on REAL data is decided only by
// scripts/p53, never by these synthetic tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localizePsfDiff,
  judgePsfDiff,
  estimatePsf,
  gaussianPsf,
  fitDifferenceSource,
  type PsfDiffLocalization,
} from "../src/detect/psfDiffImaging.ts";
import { splitByPhase, PIXEL_SCALE_ARCSEC, type PixelCube } from "../src/detect/diffImaging.ts";

interface Star {
  x: number;
  y: number;
  amp: number;
  varies: boolean;
}

/** Build a Gaussian-aperture cube; stars flagged `varies` dim by `depth` during transit. */
function makeCube(stars: Star[], opts: { period: number; t0: number; durHours: number; baselineDays: number; cadenceDays: number; depth: number; nx?: number; ny?: number; noise?: number; seed?: number; dipole?: number }): PixelCube {
  const nx = opts.nx ?? 14;
  const ny = opts.ny ?? 14;
  const n = Math.round(opts.baselineDays / opts.cadenceDays);
  const time = new Float64Array(n);
  const quality = new Float64Array(n);
  const flux = new Float64Array(n * nx * ny);
  const halfDur = opts.durHours / 24 / 2;
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
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
        // A coherent pointing/focus systematic: a small stellar-image SHIFT produces a
        // difference image proportional to the gradient of the stellar PSF (an antisymmetric
        // dipole about the star with ZERO net flux) -- exactly what drags a naive centroid off.
        if (opts.dipole && isIn) {
          const r2 = (x - cx) ** 2 + (y - cy) ** 2;
          v += opts.dipole * (-(x - cx)) * Math.exp(-r2 / 2);
        }
        if (opts.noise) v += rand() * opts.noise;
        flux[base + y * nx + x] = v;
      }
    }
  }
  return { rows: n, nx, ny, time, quality, flux };
}

const EPOCH = { period: 6, t0: 2458400, durHours: 6, baselineDays: 60, cadenceDays: 0.01, depth: 0.03 };

test("estimatePsf recovers a known Gaussian center and width", () => {
  const nx = 14;
  const ny = 14;
  const img = gaussianPsf(nx, ny, 6.3, 7.1, 1.4);
  for (let i = 0; i < img.length; i++) img[i] *= 1e5;
  const psf = estimatePsf(img, nx, ny);
  assert.ok(Math.abs(psf.x0 - 6.3) < 0.2, `x0 ${psf.x0}`);
  assert.ok(Math.abs(psf.y0 - 7.1) < 0.2, `y0 ${psf.y0}`);
  assert.ok(psf.sigma > 0.8 && psf.sigma < 3.5, `sigma ${psf.sigma}`);
});

test("on-target transit: PSF fits the target well and moving it gains little (deltaChi2 small)", () => {
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], EPOCH);
  const loc = localizePsfDiff(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { bootstraps: 40 })!;
  assert.ok(loc.determined, "should be determined");
  assert.ok(loc.offsetArcsec < 1.0, `offset should be sub-pixel, got ${loc.offsetArcsec}"`);
  assert.ok(loc.ampSnr > 5, `a deep clean transit is significant, got ${loc.ampSnr}`);
  assert.ok(loc.deltaChi2 < 9, `moving a clean on-target source should not help, deltaChi2 ${loc.deltaChi2}`);
  const v = judgePsfDiff(loc, 1.0);
  assert.equal(v.classification, "on-target");
  assert.equal(v.onTarget, true);
});

test("genuine off-axis point source: displaced PSF fits far better (large deltaChi2) -> vetoed", () => {
  const cube = makeCube(
    [
      { x: 6.5, y: 6.5, amp: 1e5, varies: false }, // steady target
      { x: 3, y: 3, amp: 3e4, varies: true }, // contaminant that eclipses
    ],
    EPOCH,
  );
  const loc = localizePsfDiff(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { bootstraps: 40 })!;
  assert.ok(loc.determined);
  assert.ok(loc.offsetArcsec > 40, `blend offset should be large, got ${loc.offsetArcsec}"`);
  assert.ok(loc.deltaChi2 > 20, `a displaced source should fit much better, deltaChi2 ${loc.deltaChi2}`);
  const v = judgePsfDiff(loc, 1.0);
  assert.equal(v.classification, "off-target");
  assert.equal(v.onTarget, false);
});

test("coherent DIPOLE systematic is NOT vetoed (the naive-centroid failure mode)", () => {
  // A real transit on the target PLUS a coherent antisymmetric pointing dipole. The naive centroid
  // gets dragged ~1px off; the plane nuisance + model comparison must soak up the dipole and keep
  // the point source on the star, so the judge must NOT return off-target.
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], { ...EPOCH, dipole: 1.2e4, noise: 400 });
  const loc = localizePsfDiff(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { bootstraps: 40 })!;
  const v = judgePsfDiff(loc, 1.0);
  assert.notEqual(v.classification, "off-target", `a dipole must not be called off-target, got ${v.classification}: ${v.reason}`);
});

test("too few in-transit cadences returns null and is inconclusive, never a veto", () => {
  const cfg = { period: 6, t0: 2458400, durHours: 0.05, baselineDays: 10, cadenceDays: 0.01, depth: 0.03 };
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], cfg);
  const split = splitByPhase(cube, cfg.t0, cfg.period, cfg.durHours);
  assert.ok(split.inRows.length < 3, `expected <3 in-transit, got ${split.inRows.length}`);
  const loc = localizePsfDiff(cube, cfg.t0, cfg.period, cfg.durHours);
  assert.equal(loc, null);
  assert.equal(judgePsfDiff(loc, 1.0).classification, "inconclusive");
});

test("offset error bar is deterministic for a fixed seed", () => {
  const cube = makeCube([{ x: 6.5, y: 6.5, amp: 1e5, varies: true }], { ...EPOCH, noise: 200 });
  const a = localizePsfDiff(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { seed: 99, bootstraps: 40 })!;
  const b = localizePsfDiff(cube, EPOCH.t0, EPOCH.period, EPOCH.durHours, { seed: 99, bootstraps: 40 })!;
  assert.equal(a.offsetSigmaArcsec, b.offsetSigmaArcsec);
  assert.equal(a.offsetArcsec, b.offsetArcsec);
});

test("fitDifferenceSource: a clean displaced drop is recovered near its true position", () => {
  const nx = 14;
  const ny = 14;
  const D = new Float64Array(nx * ny);
  const w = new Float64Array(nx * ny).fill(1);
  const drop = gaussianPsf(nx, ny, 4, 9, 1.2);
  for (let i = 0; i < D.length; i++) D[i] = drop[i] * 500;
  const fit = fitDifferenceSource(D, w, nx, ny, 6.5, 6.5, 1.2);
  assert.ok(Math.hypot(fit.best.x - 4, fit.best.y - 9) < 1.0, `best ${fit.best.x},${fit.best.y}`);
  assert.ok(fit.best.chi2 < fit.atTarget.chi2, "displaced model should beat the on-target model");
});

test("the judge is conservative on hand-built localizations", () => {
  const base: PsfDiffLocalization = {
    targetCentroid: { x: 6.5, y: 6.5 },
    sourcePosition: { x: 6.5, y: 6.5 },
    sigmaPx: 1.2,
    offsetArcsec: 0,
    offsetSigmaArcsec: 0.2,
    amp: 100,
    ampSnr: 50,
    chi2Target: 100,
    chi2Best: 100,
    deltaChi2: 0,
    dof: 192,
    gofTarget: 0.5,
    inCount: 100,
    outCount: 1000,
    determined: true,
  };
  // Drop sits at the star -> on-target regardless of deltaChi2.
  assert.equal(judgePsfDiff({ ...base, offsetArcsec: 0.3 }, 1).classification, "on-target");
  // Big offset but the displaced model does NOT fit better -> refuse to veto (inconclusive).
  assert.equal(judgePsfDiff({ ...base, offsetArcsec: 60, deltaChi2: 2 }, 1).classification, "inconclusive");
  // Big offset AND a displaced source fits far better -> veto.
  assert.equal(judgePsfDiff({ ...base, offsetArcsec: 60, deltaChi2: 200 }, 1).classification, "off-target");
  // Same but the point-source drop is insignificant -> refuse to veto.
  assert.equal(judgePsfDiff({ ...base, offsetArcsec: 60, deltaChi2: 200, ampSnr: 2 }, 1).classification, "inconclusive");
  // Offset above threshold but its 1sigma bound is not -> inconclusive.
  assert.equal(judgePsfDiff({ ...base, offsetArcsec: 1.5, offsetSigmaArcsec: 1.0, deltaChi2: 200 }, 1).classification, "inconclusive");
});

test("pixel scale constant matches the reader module", () => {
  assert.equal(PIXEL_SCALE_ARCSEC, 21);
});
