// Token-free TESS-SPOC TARGET-PIXEL reader (runtime-agnostic: fetch + fits.ts).
//
// A pixel-level false-positive test needs the aperture pixels, not just the summed
// light curve. TESS-SPOC ships a target-pixel product alongside the light curve in
// the same public S3 bucket (same key, `_lc.fits` -> `_tp.fits`), downloaded the
// same anonymous way. Its BINTABLE (EXTNAME='PIXELS') carries, per cadence, a
// rectangular aperture of pixels (verified real shape: FLUX column TFORM '196E',
// TDIM '(14,14)'; TIME/QUALITY scalar). The flux-weighted centroid of that aperture
// is the core observable behind the strongest FP discriminators -- a real planet
// transits the target (centroid stays put), whereas a background/eclipsing-binary
// blend drags the centroid toward the contaminant during transit.
//
// Nothing here is invoked unless a caller opts in; a missing/failed object resolves
// to null so the pipeline keeps its deterministic behavior.

import { resolveSpocKey, fetchSpocBytes } from "./mastS3.ts";
import { readFitsTable, readColumn, readArrayColumn } from "./fits.ts";

/** TESS CCD pixel scale (arcsec/pixel); sufficient for a centroid-shift magnitude. */
export const PIXEL_SCALE_ARCSEC = 21;

export interface TargetPixelCube {
  targetId: string;
  /** Cadence count (table rows). */
  rows: number;
  /** Barycentric TDB time per cadence, normalized to full BJD. */
  time: Float64Array;
  /** QUALITY flag per cadence (nonzero = suspect; caller masks). */
  quality: Float64Array;
  /** Aperture grid width (TDIM first axis) and height (second axis). */
  nx: number;
  ny: number;
  /** Per-cadence aperture flux, flattened as values[r*nx*ny + y*nx + x]. */
  flux: Float64Array;
  source: string;
}

/** Fetch and parse a SPOC target-pixel cube; returns null if unavailable/unparsable. */
export async function fetchSpocTargetPixels(
  tic: number,
  sector: number,
  targetId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TargetPixelCube | null> {
  const key = resolveSpocKey(tic, sector, "tp");
  const bytes = await fetchSpocBytes(key, opts);
  if (!bytes) return null;
  let table;
  try {
    table = readFitsTable(bytes);
  } catch {
    return null;
  }
  const hasFlux = table.columns.some((c) => c.name === "FLUX");
  if (!hasFlux) return null;
  let timeRaw: Float64Array;
  let fluxArr: { values: Float64Array; count: number; dims?: number[] };
  try {
    timeRaw = readColumn(table, bytes, "TIME");
    fluxArr = readArrayColumn(table, bytes, "FLUX");
  } catch {
    return null;
  }
  const quality = table.columns.some((c) => c.name === "QUALITY") ? readColumn(table, bytes, "QUALITY") : new Float64Array(table.rows);
  const [nx, ny] = fluxArr.dims && fluxArr.dims.length >= 2 ? [fluxArr.dims[0], fluxArr.dims[1]] : [Math.round(Math.sqrt(fluxArr.count)), Math.round(Math.sqrt(fluxArr.count))];
  // TDIM '(14,14)': first axis varies fastest, so stored element index e maps to
  // x = e % nx, y = floor(e / nx) -- exactly the flattened [r][y][x] layout we keep.
  const time = new Float64Array(timeRaw.length);
  for (let i = 0; i < timeRaw.length; i++) time[i] = timeRaw[i] < 1e6 ? timeRaw[i] + 2457000 : timeRaw[i];

  return {
    targetId,
    rows: table.rows,
    time,
    quality,
    nx,
    ny,
    flux: fluxArr.values,
    source: `TESS-SPOC target pixel ${key.split("/").pop()} from public S3 (REAL photometry); CC BY 4.0, cite Caldwell et al. 2020`,
  };
}

export interface Centroid {
  x: number; // flux-weighted centroid column (0..nx)
  y: number; // flux-weighted centroid row (0..ny)
  total: number; // summed aperture flux used
}

/** Flux-weighted centroid of one cadence's aperture; NaN-masks quality-flagged rows. */
export function centroidOfCadence(cube: TargetPixelCube, r: number): Centroid | null {
  if (!Number.isFinite(cube.quality[r]) || cube.quality[r] !== 0) return null;
  const base = r * cube.nx * cube.ny;
  let sx = 0;
  let sy = 0;
  let s = 0;
  for (let y = 0; y < cube.ny; y++) {
    for (let x = 0; x < cube.nx; x++) {
      const v = cube.flux[base + y * cube.nx + x];
      if (!Number.isFinite(v) || v <= 0) continue; // drop NaN / negative pixels
      sx += v * x;
      sy += v * y;
      s += v;
    }
  }
  if (s <= 0) return null;
  return { x: sx / s, y: sy / s, total: s };
}

/** Is cadence t inside a transit centered at t0 with total duration durDays? */
function inTransit(t: number, t0: number, halfDurDays: number, periodDays: number): boolean {
  // fold into [-0.5, 0.5) of the period, then test the transit window.
  let d = (t - t0) / periodDays;
  d -= Math.round(d);
  return Math.abs(d * periodDays) <= halfDurDays;
}

export interface CentroidShift {
  dxPix: number;
  dyPix: number;
  shiftArcsec: number;
  inCount: number;
  outCount: number;
  /** 1 = centroid moves during transit (blend / off-target source likely); 0 = fixed (target). */
  shifts: boolean;
}

/**
 * Mean in-transit minus out-of-transit aperture centroid. A planet transiting the
 * target star leaves this near zero; an eclipsing binary or background blend that
 * dominates the aperture flux shifts it by a detectable fraction of a pixel.
 */
export function centroidShift(cube: TargetPixelCube, t0Bjd: number, periodDays: number, durationHours: number, thresholdArcsec = 1.0): CentroidShift {
  const halfDur = durationHours / 24 / 2;
  let inX = 0;
  let inY = 0;
  let inN = 0;
  let outX = 0;
  let outY = 0;
  let outN = 0;
  for (let r = 0; r < cube.rows; r++) {
    if (!Number.isFinite(cube.time[r])) continue;
    const c = centroidOfCadence(cube, r);
    if (!c) continue;
    if (inTransit(cube.time[r], t0Bjd, halfDur, periodDays)) {
      inX += c.x;
      inY += c.y;
      inN++;
    } else {
      outX += c.x;
      outY += c.y;
      outN++;
    }
  }
  if (inN < 2 || outN < 2) {
    return { dxPix: 0, dyPix: 0, shiftArcsec: 0, inCount: inN, outCount: outN, shifts: false };
  }
  const dxPix = inX / inN - outX / outN;
  const dyPix = inY / inN - outY / outN;
  const shiftArcsec = Math.hypot(dxPix, dyPix) * PIXEL_SCALE_ARCSEC;
  return { dxPix, dyPix, shiftArcsec, inCount: inN, outCount: outN, shifts: shiftArcsec > thresholdArcsec };
}
