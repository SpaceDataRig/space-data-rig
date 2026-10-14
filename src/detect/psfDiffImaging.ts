// PSF-MODEL DOUBLE-DIFFERENCE SOURCE LOCALIZATION (discovery roadmap, priority 2).
//
// WHY THIS EXISTS. scripts/p44 (src/detect/diffImaging.ts) showed that the NAIVE
// difference-image localization -- take the flux-weighted centroid of the clipped-positive
// in-minus-out image -- systematically MISLOCALIZES confirmed transits by a median of ~24
// arcseconds (~1 TESS pixel) on real SPOC target-pixel cubes. The root cause is NOT noise:
// the in-minus-out residual carries coherent pointing / focus structure (a smooth gradient /
// dipole across the aperture), and a flux-weighted centroid of its positive half is dragged
// off-center by that structure no matter how significant the drop is. An snr floor cut the
// damage (12/12 -> 3/12) but could not make it safe.
//
// WHAT IS DIFFERENT HERE. This is a real double-difference fit, in the sense that matters:
//   1. Estimate the target PSF (a circular Gaussian) from the steady out-of-transit image.
//   2. Model the SIGNED difference image D = out - in as
//          D ~= a * PSF(x - sx, y - sy)  +  (a smooth nuisance plane: c0 + c1*x + c2*y)
//      fitted by weighted least squares. The plane absorbs exactly the coherent pointing /
//      focus structure that fooled the naive centroid, so it can no longer masquerade as an
//      off-axis source.
//   3. Scan the point-source position (sx, sy) and compare chi2 of a PSF pinned AT THE TARGET
//      (H0) against the best DISPLACED PSF (H1), BOTH with the same plane nuisance. A real
//      planet is a point source ON the star, so H1 gains little over H0 (small deltaChi2). A
//      coherent systematic is soaked up by the plane at every position, so moving the PSF still
//      gains little (small deltaChi2). Only a genuine off-axis point source (blend / background
//      EB) makes a displaced PSF fit dramatically better.
//
// The judge is conservative by construction: it calls "on-target" whenever the best-fit drop is
// at the star, and it refuses to veto a large offset unless a displaced point source fits
// significantly better than the on-target model (deltaChi2 floor). RESEARCH-ONLY: pure,
// deterministic, never wired into a verdict / bundle hash / money path. Whether it is SAFE TO
// GATE is decided only by calibrating it on confirmed planets (scripts/p53-*), never by its
// synthetic unit tests.

import { splitByPhase, PIXEL_SCALE_ARCSEC, type PixelCube } from "./diffImaging.ts";

export interface Point2D {
  x: number;
  y: number;
}

/** Circular Gaussian PSF estimated from a steady image. */
export interface PsfModel {
  x0: number;
  y0: number;
  sigma: number;
  amp: number;
}

/** Local deterministic PRNG (mulberry32) so bootstrap error bars are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * f;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-pixel mean and variance over the given cadence rows (finite samples only). */
function meanAndVar(cube: PixelCube, rows: number[]): { mean: Float64Array; variance: Float64Array } {
  const npix = cube.nx * cube.ny;
  const sum = new Float64Array(npix);
  const sumsq = new Float64Array(npix);
  const count = new Int32Array(npix);
  for (const r of rows) {
    const base = r * npix;
    for (let i = 0; i < npix; i++) {
      const v = cube.flux[base + i];
      if (!Number.isFinite(v)) continue;
      sum[i] += v;
      sumsq[i] += v * v;
      count[i]++;
    }
  }
  const mean = new Float64Array(npix);
  const variance = new Float64Array(npix);
  for (let i = 0; i < npix; i++) {
    if (count[i] > 0) {
      const m = sum[i] / count[i];
      mean[i] = m;
      const v = sumsq[i] / count[i] - m * m;
      variance[i] = v > 0 ? v : 0;
    }
  }
  return { mean, variance };
}

/**
 * Estimate a circular-Gaussian PSF from an image via flux-weighted (positive-part) moments.
 * Returns NaN fields when the image carries no positive signal.
 */
export function estimatePsf(img: Float64Array, nx: number, ny: number): PsfModel {
  let s = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = img[y * nx + x];
      if (!Number.isFinite(v) || v <= 0) continue;
      s += v;
      sx += v * x;
      sy += v * y;
    }
  }
  if (s <= 0) return { x0: NaN, y0: NaN, sigma: NaN, amp: 0 };
  const x0 = sx / s;
  const y0 = sy / s;
  let mxx = 0;
  let myy = 0;
  let peak = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = img[y * nx + x];
      if (!Number.isFinite(v) || v <= 0) continue;
      const dx = x - x0;
      const dy = y - y0;
      mxx += v * dx * dx;
      myy += v * dy * dy;
      if (v > peak) peak = v;
    }
  }
  mxx /= s;
  myy /= s;
  let sigma = Math.sqrt(Math.max(0, 0.5 * (mxx + myy)));
  if (!Number.isFinite(sigma) || sigma <= 0) sigma = 1.2;
  sigma = Math.min(3.5, Math.max(0.8, sigma));
  return { x0, y0, sigma, amp: peak };
}

/** Normalized circular-Gaussian PSF image (sums to 1) centered at (cx, cy). */
export function gaussianPsf(nx: number, ny: number, cx: number, cy: number, sigma: number): Float64Array {
  const out = new Float64Array(nx * ny);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const g = Math.exp(-(dx * dx + dy * dy) * inv2s2);
      out[y * nx + x] = g;
      sum += g;
    }
  }
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/**
 * Solve a symmetric n x n linear system A x = b in place (Gaussian elimination with partial
 * pivoting). Small n (4) only; returns null if singular.
 */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-30) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

/** Invert a small symmetric matrix (Gauss-Jordan); null if singular. */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-30) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let k = 0; k < 2 * n; k++) M[col][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row) => row.slice(n));
}

interface PlaneFit {
  a: number;
  aSigma: number;
  chi2: number;
}

/**
 * Weighted least-squares fit of
 *     D ~= a*PSF(x-sx, y-sy)  +  c0 + c1*x + c2*y  +  g1*gx + g2*gy
 * where gx, gy are the spatial derivatives of the TARGET PSF (centered at cx, cy). The plane
 * absorbs large-scale focus gradients and gx/gy absorb a coherent POINTING shift -- which is
 * exactly the structure (a dipole aligned with the stellar profile) that fooled the naive
 * centroid. With those nuisances present at BOTH hypotheses, a small pointing wobble can no
 * longer masquerade as an off-axis point source. Returns the point-source amplitude, its 1-sigma
 * uncertainty, and the chi2.
 */
function fitPsfWithNuisance(psf: Float64Array, D: Float64Array, w: Float64Array, nx: number, ny: number, cx: number, cy: number, sigma: number): PlaneFit {
  const base = gaussianPsf(nx, ny, cx, cy, sigma);
  const invS2 = 1 / (sigma * sigma);
  const m = 6;
  const cols: Float64Array[] = [psf, new Float64Array(psf.length).fill(1), new Float64Array(psf.length), new Float64Array(psf.length), new Float64Array(psf.length), new Float64Array(psf.length)];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      cols[2][i] = x;
      cols[3][i] = y;
      cols[4][i] = (x - cx) * invS2 * base[i];
      cols[5][i] = (y - cy) * invS2 * base[i];
    }
  }
  const AtWA: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const AtWd = new Array<number>(m).fill(0);
  for (let p = 0; p < m; p++) {
    for (let q = p; q < m; q++) {
      let acc = 0;
      for (let i = 0; i < psf.length; i++) acc += w[i] * cols[p][i] * cols[q][i];
      AtWA[p][q] = acc;
      AtWA[q][p] = acc;
    }
    let acc = 0;
    for (let i = 0; i < psf.length; i++) acc += w[i] * cols[p][i] * D[i];
    AtWd[p] = acc;
  }
  const coef = solveLinear(AtWA, AtWd);
  if (!coef) return { a: 0, aSigma: Infinity, chi2: Infinity };
  let chi2 = 0;
  for (let i = 0; i < psf.length; i++) {
    let model = 0;
    for (let p = 0; p < m; p++) model += coef[p] * cols[p][i];
    const r = D[i] - model;
    chi2 += w[i] * r * r;
  }
  const cov = invert(AtWA);
  const aSigma = cov && cov[0][0] > 0 ? Math.sqrt(cov[0][0]) : Infinity;
  return { a: coef[0], aSigma, chi2 };
}

export interface PsfFitResult {
  best: { x: number; y: number; a: number; chi2: number };
  atTarget: { a: number; chi2: number };
}

/**
 * Scan PSF positions in a window around (cx, cy) and return the best-fit displaced PSF plus the
 * chi2 of a PSF pinned at the target center. Coarse step then a fine local refine, all
 * deterministic. Both models carry the same plane nuisance, so the comparison isolates the
 * point-source position from smooth coherent structure.
 */
export function fitDifferenceSource(
  D: Float64Array,
  w: Float64Array,
  nx: number,
  ny: number,
  cx: number,
  cy: number,
  sigma: number,
  opts: { searchRadiusPx?: number; coarseStep?: number; fineStep?: number } = {},
): PsfFitResult {
  const R = opts.searchRadiusPx ?? 5;
  const coarse = opts.coarseStep ?? 0.5;
  const fine = opts.fineStep ?? 0.1;
  const at = fitPsfWithNuisance(gaussianPsf(nx, ny, cx, cy, sigma), D, w, nx, ny, cx, cy, sigma);
  const atTarget = { a: at.a, chi2: at.chi2 };

  let best = { x: cx, y: cy, a: at.a, chi2: at.chi2 };
  const xLo = Math.max(0, cx - R);
  const xHi = Math.min(nx - 1, cx + R);
  const yLo = Math.max(0, cy - R);
  const yHi = Math.min(ny - 1, cy + R);
  for (let yy = yLo; yy <= yHi + 1e-9; yy += coarse) {
    for (let xx = xLo; xx <= xHi + 1e-9; xx += coarse) {
      const fit = fitPsfWithNuisance(gaussianPsf(nx, ny, xx, yy, sigma), D, w, nx, ny, cx, cy, sigma);
      if (fit.chi2 < best.chi2) best = { x: xx, y: yy, a: fit.a, chi2: fit.chi2 };
    }
  }
  const fxLo = Math.max(0, best.x - coarse);
  const fxHi = Math.min(nx - 1, best.x + coarse);
  const fyLo = Math.max(0, best.y - coarse);
  const fyHi = Math.min(ny - 1, best.y + coarse);
  for (let yy = fyLo; yy <= fyHi + 1e-9; yy += fine) {
    for (let xx = fxLo; xx <= fxHi + 1e-9; xx += fine) {
      const fit = fitPsfWithNuisance(gaussianPsf(nx, ny, xx, yy, sigma), D, w, nx, ny, cx, cy, sigma);
      if (fit.chi2 < best.chi2) best = { x: xx, y: yy, a: fit.a, chi2: fit.chi2 };
    }
  }
  return { best, atTarget };
}

export interface PsfDiffLocalization {
  /** PSF center of the steady starlight (from the out-of-transit image). */
  targetCentroid: Point2D;
  /** Best-fit PSF center of the varied source in the difference image. */
  sourcePosition: Point2D;
  sigmaPx: number;
  /** |source - target| separation, arcsec. */
  offsetArcsec: number;
  /** 1-sigma half-width of the offset from a cadence bootstrap (NaN if not estimable). */
  offsetSigmaArcsec: number;
  /** Best-fit drop amplitude (aperture-flux units; positive = flux dropped in transit). */
  amp: number;
  /** amp / sigma(amp) from the weighted fit -- significance of the point-source drop. */
  ampSnr: number;
  chi2Target: number;
  chi2Best: number;
  /** chi2Target - chi2Best: how much better a DISPLACED point source explains the data. */
  deltaChi2: number;
  dof: number;
  /** chi2Target / dof: goodness of fit of the on-target model (>>1 = not a clean point source). */
  gofTarget: number;
  inCount: number;
  outCount: number;
  determined: boolean;
}

export interface PsfDiffOptions {
  bootstraps?: number;
  seed?: number;
  searchRadiusPx?: number;
}

/** Per-pixel variance of the difference of two independent means, floored by a photometric
 *  floor so weights stay finite on near-noiseless synthetic cubes. */
function diffWeights(outMV: { mean: Float64Array; variance: Float64Array }, inMean: Float64Array, inVar: Float64Array, nOut: number, nIn: number, steadyPeak: number): { D: Float64Array; w: Float64Array } {
  const npix = outMV.mean.length;
  const D = new Float64Array(npix);
  const w = new Float64Array(npix);
  const vv: number[] = [];
  for (let i = 0; i < npix; i++) {
    D[i] = outMV.mean[i] - inMean[i];
    vv.push(outMV.variance[i] / nOut + inVar[i] / nIn);
  }
  const sorted = [...vv].sort((a, b) => a - b);
  const medVar = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const floor = Math.max(medVar * 1e-6, (1e-3 * steadyPeak) ** 2 * (1 / nOut + 1 / nIn));
  for (let i = 0; i < npix; i++) w[i] = 1 / Math.max(vv[i], floor);
  return { D, w };
}

/**
 * PSF-model double-difference localization of the varied source. Returns null when the cube has
 * too few good cadences (in or out < 3) or the PSF cannot be estimated.
 */
export function localizePsfDiff(
  cube: PixelCube,
  t0Bjd: number,
  periodDays: number,
  durationHours: number,
  opts: PsfDiffOptions = {},
): PsfDiffLocalization | null {
  const { inRows, outRows } = splitByPhase(cube, t0Bjd, periodDays, durationHours);
  if (inRows.length < 3 || outRows.length < 3) return null;

  const outMV = meanAndVar(cube, outRows);
  const psf = estimatePsf(outMV.mean, cube.nx, cube.ny);
  if (!Number.isFinite(psf.x0) || !Number.isFinite(psf.y0)) return null;

  const inM = meanAndVar(cube, inRows);
  let steadyPeak = 0;
  for (let i = 0; i < outMV.mean.length; i++) if (outMV.mean[i] > steadyPeak) steadyPeak = outMV.mean[i];
  const npix = cube.nx * cube.ny;
  const { D, w } = diffWeights(outMV, inM.mean, inM.variance, outRows.length, inRows.length, steadyPeak);

  const fit = fitDifferenceSource(D, w, cube.nx, cube.ny, psf.x0, psf.y0, psf.sigma, {
    searchRadiusPx: opts.searchRadiusPx ?? 5,
  });
  const bestPsf = gaussianPsf(cube.nx, cube.ny, fit.best.x, fit.best.y, psf.sigma);
  const bestFit = fitPsfWithNuisance(bestPsf, D, w, cube.nx, cube.ny, psf.x0, psf.y0, psf.sigma);
  const ampSnr = Number.isFinite(bestFit.aSigma) && bestFit.aSigma > 0 ? Math.abs(fit.best.a) / bestFit.aSigma : 0;

  const offsetArcsec = Math.hypot(fit.best.x - psf.x0, fit.best.y - psf.y0) * PIXEL_SCALE_ARCSEC;
  const dof = Math.max(1, npix - 6);
  const deltaChi2 = fit.atTarget.chi2 - fit.best.chi2;
  const gofTarget = fit.atTarget.chi2 / dof;

  // Bootstrap the offset by resampling in/out cadences and refitting (deterministic).
  const B = opts.bootstraps ?? 120;
  const rand = prng(opts.seed ?? 12345);
  const offsets: number[] = [];
  for (let b = 0; b < B; b++) {
    const inSample = new Array<number>(inRows.length);
    for (let j = 0; j < inRows.length; j++) inSample[j] = inRows[Math.floor(rand() * inRows.length)];
    const outSample = new Array<number>(outRows.length);
    for (let j = 0; j < outRows.length; j++) outSample[j] = outRows[Math.floor(rand() * outRows.length)];
    const oB = meanAndVar(cube, outSample);
    const iB = meanAndVar(cube, inSample);
    const pB = estimatePsf(oB.mean, cube.nx, cube.ny);
    if (!Number.isFinite(pB.x0)) continue;
    let peakB = 0;
    for (let i = 0; i < npix; i++) if (oB.mean[i] > peakB) peakB = oB.mean[i];
    const wB = diffWeights(oB, iB.mean, iB.variance, outSample.length, inSample.length, peakB);
    const fB = fitDifferenceSource(wB.D, wB.w, cube.nx, cube.ny, pB.x0, pB.y0, pB.sigma, {
      searchRadiusPx: opts.searchRadiusPx ?? 5,
      coarseStep: 1.0,
      fineStep: 0.25,
    });
    offsets.push(Math.hypot(fB.best.x - pB.x0, fB.best.y - pB.y0) * PIXEL_SCALE_ARCSEC);
  }
  let offsetSigmaArcsec = NaN;
  if (offsets.length >= 8) {
    offsets.sort((a, c) => a - c);
    offsetSigmaArcsec = (quantile(offsets, 0.84) - quantile(offsets, 0.16)) / 2;
  }

  const determined = Number.isFinite(offsetArcsec) && fit.best.a > 0;
  return {
    targetCentroid: { x: psf.x0, y: psf.y0 },
    sourcePosition: { x: fit.best.x, y: fit.best.y },
    sigmaPx: psf.sigma,
    offsetArcsec,
    offsetSigmaArcsec,
    amp: fit.best.a,
    ampSnr,
    chi2Target: fit.atTarget.chi2,
    chi2Best: fit.best.chi2,
    deltaChi2,
    dof,
    gofTarget,
    inCount: inRows.length,
    outCount: outRows.length,
    determined,
  };
}

export interface PsfDiffVerdict {
  classification: "on-target" | "off-target" | "inconclusive";
  onTarget: boolean;
  reason: string;
}

/**
 * Conservative model-comparison judge.
 *   - The best-fit drop sits AT the star (offset <= threshold) -> "on-target".
 *   - The drop is far away but a displaced point source does NOT fit better than the on-target
 *     model (deltaChi2 < floor) -> "inconclusive": the structure is a coherent systematic, not a
 *     clean off-axis source, so we REFUSE to veto (this is the naive-centroid failure mode).
 *   - The drop is far away AND a displaced point source fits significantly better AND the offset
 *     clears the threshold even at the low end of its error bar -> "off-target" (a real blend).
 * A shallow / insignificant drop (low ampSnr) is never vetoed.
 */
export function judgePsfDiff(
  loc: PsfDiffLocalization | null,
  thresholdArcsec = 1.0,
  opts: { minAmpSnr?: number; minDeltaChi2?: number } = {},
): PsfDiffVerdict {
  const minAmpSnr = opts.minAmpSnr ?? 5;
  const minDeltaChi2 = opts.minDeltaChi2 ?? 9; // ~3 sigma evidence that a displaced source wins
  if (!loc || !loc.determined || !Number.isFinite(loc.offsetArcsec)) {
    return { classification: "inconclusive", onTarget: false, reason: "too few good in/out cadences, or no positive point-source drop, to fit the difference image" };
  }
  if (loc.offsetArcsec <= thresholdArcsec) {
    return { classification: "on-target", onTarget: true, reason: `best-fit varied source is ${loc.offsetArcsec.toFixed(2)}" from the starlight (<= ${thresholdArcsec}", amp snr ${loc.ampSnr.toFixed(1)}): consistent with a transit on the target star` };
  }
  if (!(loc.ampSnr >= minAmpSnr)) {
    return { classification: "inconclusive", onTarget: false, reason: `point-source drop not significant (amp snr ${loc.ampSnr.toFixed(1)} < ${minAmpSnr}): refusing to veto` };
  }
  if (!(loc.deltaChi2 >= minDeltaChi2)) {
    return {
      classification: "inconclusive",
      onTarget: false,
      reason: `offset ${loc.offsetArcsec.toFixed(2)}" but a displaced point source does not fit better than the target (deltaChi2 ${loc.deltaChi2.toFixed(1)} < ${minDeltaChi2}, on-target gof ${loc.gofTarget.toFixed(1)}): coherent structure, not a clean off-axis source -- refusing to veto`,
    };
  }
  const sigma = Number.isFinite(loc.offsetSigmaArcsec) ? loc.offsetSigmaArcsec : 0;
  const lowerBound = loc.offsetArcsec - sigma;
  if (lowerBound > thresholdArcsec) {
    return {
      classification: "off-target",
      onTarget: false,
      reason: `best-fit varied source is ${loc.offsetArcsec.toFixed(2)}" from the starlight (>=1sigma ${lowerBound.toFixed(2)}" > ${thresholdArcsec}", displaced-PSF gain deltaChi2 ${loc.deltaChi2.toFixed(1)}): a real off-axis point source, not the target`,
    };
  }
  return {
    classification: "inconclusive",
    onTarget: false,
    reason: `offset ${loc.offsetArcsec.toFixed(2)}" exceeds ${thresholdArcsec}" but its 1sigma bound (${lowerBound.toFixed(2)}") does not -- not significant enough to veto`,
  };
}
