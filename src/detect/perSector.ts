// PER-SECTOR CHARACTERISATION -> ROBUST MERGE (roadmap item 8, the SAFE primitive).
//
// WHY. p12 and p14 measured, on 18 real long-period planets, that the accuracy bottleneck for long
// periods is PHASE COHERENCE, not data volume: naively stitching many sectors and folding ONCE over a
// ~1000-1800 day baseline is WORSE (median depth error 34.7%) than fitting EACH sector separately and
// taking the robust MEDIAN of the depths (24.9%). The reason is that a tiny catalogue-period error
// accumulates over the long fold and smears the individual transits in phase, so one global t0 can
// only fit a compromise. The robust recipe is "stay locally coherent within each sector, characterise
// each, then merge with a median".
//
// This module isolates the durable, testable CORE of that recipe -- combineSectorFits -- so the
// production edge wiring (a later step that changes the worker bundle and must be deployed) just calls
// a small, already-proven primitive instead of re-deriving the statistics. It is PURE, deterministic,
// and NOT imported by the worker, so the production bundle / money path is unchanged here.

import type { LightCurve } from "../core/types.ts";

export interface SectorFit {
  depthFrac: number; // transit depth from ONE sector's local fit (fraction, e.g. 0.01 = 1%)
  ok: boolean; // false = that sector's fit was unreliable / non-finite and must not be pooled
}

export interface CombinedEstimate {
  medianDepthFrac: number; // robust centre over usable sectors (NaN if none usable)
  madFrac: number; // median absolute deviation of the usable depths (spread / disagreement)
  nUsable: number; // sectors actually used
  nSectors: number; // sectors offered (usable + discarded)
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Combine independent per-sector depth measurements with a MEDIAN, not a mean. A median resists the
 * one sector whose fold smeared or whose activity biased its depth -- exactly the long-period failure
 * mode p12 documented. Non-finite depths and fits flagged !ok are dropped; nSectors still counts them
 * so callers can see how much was rejected.
 */
export function combineSectorFits(fits: SectorFit[]): CombinedEstimate {
  const usable = fits.filter((f) => f.ok && Number.isFinite(f.depthFrac)).map((f) => f.depthFrac);
  const nUsable = usable.length;
  if (nUsable === 0) return { medianDepthFrac: NaN, madFrac: NaN, nUsable: 0, nSectors: fits.length };
  const med = median(usable);
  const mad = median(usable.map((x) => Math.abs(x - med))) * 1.4826; // scaled MAD ~ a robust sigma
  return { medianDepthFrac: med, madFrac: mad, nUsable, nSectors: fits.length };
}

/**
 * Characterise each sector independently (via an injected fit function -- the caller supplies BLS +
 * the exact limb-darkened fit, or a stub in tests) then robustly merge. Kept dependency-injected so
 * the statistic is testable offline with no network and no dependency on the detector's internals.
 */
export function perSectorDepthEstimate(lcs: LightCurve[], fitSector: (lc: LightCurve) => SectorFit): CombinedEstimate {
  return combineSectorFits(lcs.map(fitSector));
}
