// PIXEL-LEVEL DIFFERENCE-IMAGING SOURCE LOCALIZATION (validation roadmap, priority 1).
//
// WHY THIS EXISTS. The centroid test in src/data/mastS3Pixels.ts compares the mean
// in-transit aperture centroid to the mean out-of-transit centroid. That works, but it
// mixes the whole aperture together. The stronger, standard survey technique is a
// DIFFERENCE IMAGE: subtract the out-of-transit mean image from the in-transit mean
// image, pixel by pixel. The place where flux actually dropped is the location of the
// VARIED source. A real planet dims on the target star, so the difference image peaks
// where the steady starlight is; a background eclipsing binary or a blend dims somewhere
// ELSE in the aperture, so the difference image is offset from the starlight centroid.
// Measuring that offset -- and an error bar on it -- is the single highest-leverage way
// to tell a planet from an astrophysical false positive, and it needs no new data: the
// SPOC target-pixel cube already carries the 14x14 aperture.
//
// DESIGN. Pure and runtime-agnostic: it takes a minimal structural PixelCube (a
// TargetPixelCube satisfies it) so it never imports the data/network layer and stays
// unit-testable offline. Deterministic given a seed. RESEARCH-ONLY: nothing here is wired
// into a verdict / bundle hash / money path; the judge is deliberately conservative (it
// only calls "off-target" when the offset is significant even at the low end of its own
// error bar), because a false kill of a real planet is worse than a missed veto. Wiring it
// as a hard gate is a separate, calibration-gated step (scripts/p44-*, run on confirmed
// planets first).

/** TESS CCD pixel scale (arcsec/pixel); matches src/data/mastS3Pixels.ts. */
export const PIXEL_SCALE_ARCSEC = 21;

/** Minimal structural view of a target-pixel cube (a TargetPixelCube satisfies this). */
export interface PixelCube {
  rows: number;
  nx: number;
  ny: number;
  /** Barycentric TDB time per cadence (full BJD). */
  time: Float64Array;
  /** QUALITY flag per cadence; only exactly-0 finite rows are used. */
  quality: Float64Array;
  /** Per-cadence aperture flux, flattened as flux[r*nx*ny + y*nx + x]. */
  flux: Float64Array;
}

export interface Centroid2D {
  x: number;
  y: number;
  flux: number;
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

/** Fold time into the transit window centered on t0 (same convention as mastS3Pixels). */
function inTransit(t: number, t0: number, halfDurDays: number, periodDays: number): boolean {
  let d = (t - t0) / periodDays;
  d -= Math.round(d);
  return Math.abs(d * periodDays) <= halfDurDays;
}

/** Split cadence indices into in-transit and out-of-transit, dropping bad/NaN rows. */
export function splitByPhase(cube: PixelCube, t0Bjd: number, periodDays: number, durationHours: number): { inRows: number[]; outRows: number[] } {
  const halfDur = durationHours / 24 / 2;
  const inRows: number[] = [];
  const outRows: number[] = [];
  for (let r = 0; r < cube.rows; r++) {
    if (!Number.isFinite(cube.quality[r]) || cube.quality[r] !== 0) continue;
    if (!Number.isFinite(cube.time[r])) continue;
    if (inTransit(cube.time[r], t0Bjd, halfDur, periodDays)) inRows.push(r);
    else outRows.push(r);
  }
  return { inRows, outRows };
}

/** Per-pixel mean over the given cadence rows; pixels with no good sample are 0. */
function meanImage(cube: PixelCube, rows: number[]): { img: Float64Array; coverage: Int32Array } {
  const npix = cube.nx * cube.ny;
  const sum = new Float64Array(npix);
  const coverage = new Int32Array(npix);
  for (const r of rows) {
    const base = r * npix;
    for (let i = 0; i < npix; i++) {
      const v = cube.flux[base + i];
      if (!Number.isFinite(v)) continue;
      sum[i] += v;
      coverage[i]++;
    }
  }
  const img = new Float64Array(npix);
  for (let i = 0; i < npix; i++) img[i] = coverage[i] > 0 ? sum[i] / coverage[i] : 0;
  return { img, coverage };
}

/** Flux-weighted centroid of an image; if clipPositive, only max(v,0) contributes. */
function imageCentroid(img: Float64Array, nx: number, ny: number, clipPositive: boolean): Centroid2D {
  let sx = 0;
  let sy = 0;
  let s = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let v = img[y * nx + x];
      if (!Number.isFinite(v)) v = 0;
      if (clipPositive && v < 0) v = 0;
      if (v <= 0) continue;
      sx += v * x;
      sy += v * y;
      s += v;
    }
  }
  if (s <= 0) return { x: NaN, y: NaN, flux: 0 };
  return { x: sx / s, y: sy / s, flux: s };
}

export interface SourceLocalization {
  /** Where the steady starlight sits in the aperture (centroid of the out-of-transit image). */
  targetCentroid: Centroid2D;
  /** Where the light dropped (centroid of the positive difference image). */
  sourceCentroid: Centroid2D;
  /** |source - target| separation, arcsec. */
  offsetArcsec: number;
  /** 1-sigma half-width of the offset from a cadence bootstrap (NaN if not estimable). */
  offsetSigmaArcsec: number;
  /** Total flux that dropped in-transit (sum of positive difference image). */
  dropFlux: number;
  /** 1-sigma spread of dropFlux from the bootstrap (NaN if not estimable). */
  dropFluxSigma: number;
  /**
   * Significance of the difference image itself: dropFlux / dropFluxSigma. A shallow real
   * transit on a noisy aperture has a LOW snr -- the difference image is then noise, and its
   * centroid is meaningless. The judge refuses to veto below a snr floor for this reason.
   */
  dropSnr: number;
  /** dropFlux / steady aperture flux -- the pixel-space transit depth. */
  depthFraction: number;
  /** Peak difference pixel / dropFlux: high = one compact source, low = diffuse systematic. */
  concentration: number;
  inCount: number;
  outCount: number;
  /** True only when there were enough cadences and a well-defined offset. */
  determined: boolean;
}

export interface LocalizeOptions {
  /** bootstrap resamples for the offset error bar (default 200). */
  bootstraps?: number;
  /** deterministic seed (default 12345). */
  seed?: number;
}

/**
 * Difference-image localization of the varied source. Returns null when the cube has too
 * few good cadences to say anything (in or out < 3), so callers never mistake "no data"
 * for "on target".
 */
export function localizeTransitSource(
  cube: PixelCube,
  t0Bjd: number,
  periodDays: number,
  durationHours: number,
  opts: LocalizeOptions = {},
): SourceLocalization | null {
  const { inRows, outRows } = splitByPhase(cube, t0Bjd, periodDays, durationHours);
  if (inRows.length < 3 || outRows.length < 3) return null;

  const outM = meanImage(cube, outRows);
  const inM = meanImage(cube, inRows);
  const npix = cube.nx * cube.ny;

  // Difference image: where flux DROPPED in transit is (out - in) > 0.
  const drop = new Float64Array(npix);
  let dropFlux = 0;
  let peak = 0;
  for (let i = 0; i < npix; i++) {
    const d = outM.img[i] - inM.img[i];
    const v = d > 0 ? d : 0;
    drop[i] = v;
    dropFlux += v;
    if (v > peak) peak = v;
  }

  const targetCentroid = imageCentroid(outM.img, cube.nx, cube.ny, true);
  const sourceCentroid = imageCentroid(drop, cube.nx, cube.ny, false);
  const steadyFlux = targetCentroid.flux;
  const offsetPix = Math.hypot(sourceCentroid.x - targetCentroid.x, sourceCentroid.y - targetCentroid.y);
  const offsetArcsec = offsetPix * PIXEL_SCALE_ARCSEC;

  // Bootstrap the offset by resampling in/out cadences with replacement (deterministic).
  const B = opts.bootstraps ?? 200;
  const rand = prng(opts.seed ?? 12345);
  const offsets: number[] = [];
  const drops: number[] = [];
  for (let b = 0; b < B; b++) {
    const inSample = new Array<number>(inRows.length);
    for (let j = 0; j < inRows.length; j++) inSample[j] = inRows[Math.floor(rand() * inRows.length)];
    const outSample = new Array<number>(outRows.length);
    for (let j = 0; j < outRows.length; j++) outSample[j] = outRows[Math.floor(rand() * outRows.length)];
    const inB = meanImage(cube, inSample);
    const outB = meanImage(cube, outSample);
    const dropB = new Float64Array(npix);
    let dropFluxB = 0;
    for (let i = 0; i < npix; i++) {
      const d = outB.img[i] - inB.img[i];
      const v = d > 0 ? d : 0;
      dropB[i] = v;
      dropFluxB += v;
    }
    drops.push(dropFluxB);
    const tB = imageCentroid(outB.img, cube.nx, cube.ny, true);
    const sB = imageCentroid(dropB, cube.nx, cube.ny, false);
    if (!Number.isFinite(tB.x) || !Number.isFinite(sB.x)) continue;
    offsets.push(Math.hypot(sB.x - tB.x, sB.y - tB.y) * PIXEL_SCALE_ARCSEC);
  }
  let offsetSigmaArcsec = NaN;
  if (offsets.length >= 8) {
    offsets.sort((a, c) => a - c);
    const lo = quantile(offsets, 0.16);
    const hi = quantile(offsets, 0.84);
    offsetSigmaArcsec = (hi - lo) / 2;
  }
  let dropFluxSigma = NaN;
  if (drops.length >= 8) {
    drops.sort((a, c) => a - c);
    dropFluxSigma = (quantile(drops, 0.84) - quantile(drops, 0.16)) / 2;
  }
  const dropSnr = dropFluxSigma > 0 ? dropFlux / dropFluxSigma : (dropFlux > 0 ? Infinity : 0);

  const determined = Number.isFinite(offsetArcsec) && dropFlux > 0 && steadyFlux > 0;
  return {
    targetCentroid,
    sourceCentroid,
    offsetArcsec,
    offsetSigmaArcsec,
    dropFlux,
    dropFluxSigma,
    dropSnr,
    depthFraction: steadyFlux > 0 ? dropFlux / steadyFlux : NaN,
    concentration: dropFlux > 0 ? peak / dropFlux : NaN,
    inCount: inRows.length,
    outCount: outRows.length,
    determined,
  };
}

export interface LocalizationVerdict {
  /** "off-target" = the drop is significantly away from the starlight -> blend / EB suspect. */
  classification: "on-target" | "off-target" | "inconclusive";
  /** Convenience: true only when confidently on the target star. */
  onTarget: boolean;
  reason: string;
}

/**
 * Conservative judge. Refuses to veto unless BOTH conditions hold: (a) the difference image
 * is statistically significant (dropSnr >= minSnr) -- on a shallow/noisy real transit the
 * difference image is noise and its centroid is meaningless, so we must NOT veto; and (b) the
 * offset is beyond the threshold even after subtracting its own 1-sigma uncertainty. Missing /
 * thin / insignificant data is "inconclusive", never a veto -- a false kill of a real planet is
 * worse than a missed blend.
 */
export function judgeLocalization(loc: SourceLocalization | null, thresholdArcsec = 1.0, opts: { minSnr?: number } = {}): LocalizationVerdict {
  const minSnr = opts.minSnr ?? 5;
  if (!loc || !loc.determined || !Number.isFinite(loc.offsetArcsec)) {
    return { classification: "inconclusive", onTarget: false, reason: "too few good in/out cadences to localize the varied source" };
  }
  if (!(loc.dropSnr >= minSnr)) {
    return { classification: "inconclusive", onTarget: false, reason: `difference image not significant (snr ${Number.isFinite(loc.dropSnr) ? loc.dropSnr.toFixed(1) : "n/a"} < ${minSnr}): the drop is below the aperture noise, its position is meaningless -- refusing to veto` };
  }
  const sigma = Number.isFinite(loc.offsetSigmaArcsec) ? loc.offsetSigmaArcsec : 0;
  const lowerBound = loc.offsetArcsec - sigma;
  if (lowerBound > thresholdArcsec) {
    return {
      classification: "off-target",
      onTarget: false,
      reason: `varied source is ${loc.offsetArcsec.toFixed(2)}" from the starlight centroid (>=1sigma bound ${lowerBound.toFixed(2)}" > ${thresholdArcsec}", snr ${loc.dropSnr.toFixed(1)}): the dip is not on the target star`,
    };
  }
  if (loc.offsetArcsec <= thresholdArcsec) {
    return { classification: "on-target", onTarget: true, reason: `varied source is ${loc.offsetArcsec.toFixed(2)}" from the starlight centroid (<= ${thresholdArcsec}", snr ${loc.dropSnr.toFixed(1)}): consistent with a transit on the target star` };
  }
  return {
    classification: "inconclusive",
    onTarget: false,
    reason: `offset ${loc.offsetArcsec.toFixed(2)}" exceeds ${thresholdArcsec}" but its 1sigma bound (${lowerBound.toFixed(2)}") does not -- not significant enough to veto`,
  };
}
