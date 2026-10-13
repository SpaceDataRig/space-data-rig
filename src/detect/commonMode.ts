// COMMON-MODE (ENSEMBLE) SYSTEMATICS REMOVAL -- the source-level false-positive lever for FFI blind search.
//
// WHY THIS EXISTS. Our own candidate-chain measurement (npm run p23:candidate-validation) found a ~25%
// false-alarm rate on real TGLC full-frame curves that the per-candidate empirical-FAP gate barely moved
// (25% -> 23%). The reason is load-bearing: calibratedFap's null ensemble models each star's OWN random
// noise color, but the surviving false positives are COHERENT INSTRUMENTAL SYSTEMATICS -- a dip / spike
// shared by MANY unrelated stars at the SAME cadence (scattered light, thermal settling, momentum dumps,
// CCD-level artifacts). A per-star significance gate cannot touch those because they are significant
// against a star's own noise. The L3 shared-ephemeris collapse (src/candidate/corroboration.ts) only
// clusters candidates AFTER detection -- by then the false BLS peak has already formed.
//
// THE PHYSICS-GROUNDED FIX. Stars read out on the same CCD in the same sector share the spacecraft /
// instrument signal but NOT each other's astrophysics. So at every cadence the ROBUST (median) fractional
// deviation across an ensemble of stars estimates the COMMON instrumental component; subtracting it from
// each star removes the coherent artifact while leaving a transit intact -- a transit is a minority signal
// (one star, one phase) and the median is robust to it. This is the same principle behind Kepler PDC-MAP
// cotrending and per-CCD background modeling, applied here to the blind FFI ensemble. It attacks the false
// peak at its SOURCE, in the photometry, before BLS ever runs -- strictly stronger than post-hoc clustering.
//
// HONEST SCOPE. It removes only what is SHARED across the ensemble at a given time; a star's own
// variability and any genuine transit are preserved (that is the point, and it is measured, not asserted --
// see tests/commonMode.test.ts and scripts/p31-common-mode-fp.ts). Below `minStars` there is no reliable
// common mode, so it is an exact no-op. Sector-wide ensembles catch spacecraft-level events; CCD-level
// artifacts are best removed from an ensemble grouped by camera/CCD (the caller may pass such a subset).
//
// PURE + DETERMINISTIC + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash /
// money path. Never mutates its inputs (returns fresh curves).

import type { LightCurve } from "../core/types.ts";

export interface CommonModeOptions {
  /** Minimum ensemble size to build a template; below this the transform is an exact no-op (default 8). */
  minStars?: number;
  /** Minimum DISTINCT stars contributing to one cadence bin for its template value to be trusted; a bin with
   *  fewer stars gets zero correction (default 5). Keeps a hole left by quality-masking from baking one or two
   *  stars' astrophysics into the "common" signal. */
  minStarsPerBin?: number;
  /** Half-width (days) used to group cadences across stars into one bin. Same-sector stars share TESS cadence
   *  timestamps, so this must stay below HALF the cadence (120 s -> 0.00069 d; default 0.0005 d ~ 43 s). */
  timeTolDays?: number;
  /** When > 0, remove ONLY anomalously large shared excursions: each cadence's template value is soft-thresholded
   *  by `spikeGateSigma` x the robust sigma of the template, so typical cadences are left untouched. Motivation
   *  (measured, scripts/p31-common-mode-fp.ts): the false positives come from RARE coherent dips/spikes (a real
   *  sector-1 template has ~5000 ppm RMS but peaks near 11%), while subtracting the small typical-cadence common
   *  mode injects template-estimation noise (SE ~ sigma/sqrt(N)) into every star and slightly costs completeness.
   *  Gating keeps the FP-killing spikes and protects the shallow-signal floor. Default 0 = subtract the full template. */
  spikeGateSigma?: number;
}

/** One cadence bin of the common-mode template: the shared fractional deviation at that time. */
export interface CommonModeBin {
  time: number; // representative (bin-start) BJD
  value: number; // robust shared deviation (flux units, positive = ensemble brightened)
  nStars: number; // distinct stars that contributed
}

export interface CommonModeTemplate {
  bins: CommonModeBin[];
  nStars: number;
  applied: boolean; // false => ensemble too small, template empty
  rmsPpm: number; // RMS of the trusted template values, in ppm
  maxAbsPpm: number; // peak shared deviation removed, in ppm
}

export interface CommonModeResult {
  /** Corrected curves, same order and length as the input; identical to the input when `applied` is false. */
  curves: LightCurve[];
  nStars: number;
  nBins: number; // cadence bins with a trusted (>= minStarsPerBin) template value
  templateRmsPpm: number;
  maxAbsTemplatePpm: number;
  applied: boolean;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation (not yet scaled to sigma) -- robust to the rare huge shared spikes we target. */
function madOf(xs: number[]): number {
  if (!xs.length) return NaN;
  const med = median(xs);
  return median(xs.map((v) => Math.abs(v - med)));
}

interface Item {
  t: number;
  s: number; // index into the input ensemble
  i: number; // index into that star's points array
  dev: number; // flux - that star's own median
}

/**
 * Walk the ensemble once: bin every finite cadence across all stars by time, take the robust median shared
 * deviation per bin, and subtract it from each contributing point. Returns both the corrected curves and the
 * template so a caller can inspect exactly what shared signal was removed. Deterministic: items are sorted by
 * time with a stable sort, and every reduction is a plain median over a fixed multiset.
 */
function buildAndApply(lcs: LightCurve[], opts: CommonModeOptions): {
  out: LightCurve[];
  bins: CommonModeBin[];
  applied: boolean;
  rmsPpm: number;
  maxAbsPpm: number;
} {
  const minStars = Math.max(2, opts.minStars ?? 8);
  const minStarsPerBin = Math.max(2, opts.minStarsPerBin ?? 5);
  const tol = opts.timeTolDays != null && opts.timeTolDays > 0 ? opts.timeTolDays : 0.0005;

  // Deep-copy so the transform never mutates the caller's curves.
  const out: LightCurve[] = lcs.map((lc) => ({ ...lc, points: lc.points.map((p) => ({ ...p })) }));

  const usable = lcs.filter((lc) => lc && Array.isArray(lc.points) && lc.points.length >= 8);
  if (usable.length < minStars) {
    return { out, bins: [], applied: false, rmsPpm: 0, maxAbsPpm: 0 };
  }

  // Per-star median, then collect deviations tagged with (star, point) so we can write corrections back.
  const items: Item[] = [];
  for (let s = 0; s < lcs.length; s++) {
    const lc = lcs[s]!;
    if (!lc || !Array.isArray(lc.points) || lc.points.length < 8) continue;
    const finite = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux)).map((p) => p.flux);
    if (finite.length < 8) continue;
    const med = median(finite);
    if (!Number.isFinite(med)) continue;
    for (let i = 0; i < lc.points.length; i++) {
      const p = lc.points[i]!;
      if (!Number.isFinite(p.time) || !Number.isFinite(p.flux)) continue;
      items.push({ t: p.time, s, i, dev: p.flux - med });
    }
  }
  if (!items.length) return { out, bins: [], applied: false, rmsPpm: 0, maxAbsPpm: 0 };

  items.sort((a, b) => a.t - b.t); // stable: equal times keep ensemble order

  // Cluster into cadence bins; record each item's bin so the correction maps straight back.
  const binOf = new Int32Array(items.length);
  const binDevs: number[][] = [];
  const binStars: Set<number>[] = [];
  const binTime: number[] = [];
  let binId = -1;
  let binStart = -Infinity;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (binId < 0 || it.t - binStart > tol) {
      binId++;
      binStart = it.t;
      binDevs.push([]);
      binStars.push(new Set<number>());
      binTime.push(it.t);
    }
    binDevs[binId]!.push(it.dev);
    binStars[binId]!.add(it.s);
    binOf[k] = binId;
  }

  // Template value per bin (0 = no correction when too few stars share the cadence).
  const template = new Float64Array(binDevs.length);
  const trustedIdx: number[] = [];
  const rawVals: number[] = [];
  for (let b = 0; b < binDevs.length; b++) {
    if (binStars[b]!.size >= minStarsPerBin) {
      const v = median(binDevs[b]!);
      template[b] = Number.isFinite(v) ? v : 0;
      trustedIdx.push(b);
      rawVals.push(template[b]!);
    }
  }

  // Optional SPIKE-GATE: soft-threshold the template so only anomalously large shared excursions are removed
  // (see CommonModeOptions.spikeGateSigma). Below the gate the shared signal is left in place, so a small
  // ensemble does not have its estimation noise stamped onto every cadence of every star.
  const gate = opts.spikeGateSigma ?? 0;
  if (gate > 0 && rawVals.length) {
    const sig = madOf(rawVals) * 1.4826;
    const thr = gate * sig;
    if (Number.isFinite(thr) && thr > 0) {
      for (const b of trustedIdx) {
        const v = template[b]!;
        const m = Math.abs(v) - thr;
        template[b] = m > 0 ? Math.sign(v) * m : 0;
      }
    }
  }

  // Report the FINAL (possibly gated) template and subtract it from every contributing point.
  const bins: CommonModeBin[] = [];
  const trusted: number[] = [];
  for (const b of trustedIdx) {
    bins.push({ time: binTime[b]!, value: template[b]!, nStars: binStars[b]!.size });
    trusted.push(template[b]!);
  }
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    out[it.s]!.points[it.i]!.flux -= template[binOf[k]!]!;
  }

  let sumSq = 0;
  let maxAbs = 0;
  for (const v of trusted) {
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  const rmsPpm = trusted.length ? Math.sqrt(sumSq / trusted.length) * 1e6 : 0;
  return { out, bins, applied: true, rmsPpm, maxAbsPpm: maxAbs * 1e6 };
}

/** Inspect the common-mode template an ensemble implies, without returning corrected curves. */
export function commonModeTemplate(lcs: LightCurve[], opts: CommonModeOptions = {}): CommonModeTemplate {
  const r = buildAndApply(lcs, opts);
  return { bins: r.bins, nStars: lcs.length, applied: r.applied, rmsPpm: r.rmsPpm, maxAbsPpm: r.maxAbsPpm };
}

/** Remove the ensemble-shared instrumental component from each curve. No-op (exact copies) below `minStars`. */
export function removeCommonMode(lcs: LightCurve[], opts: CommonModeOptions = {}): CommonModeResult {
  const r = buildAndApply(lcs, opts);
  const curves = r.applied
    ? r.out.map((lc) => ({ ...lc, source: `${lc.source ?? lc.targetId}; common-mode systematics removed (${lcs.length}-star ensemble)` }))
    : r.out;
  return {
    curves,
    nStars: lcs.length,
    nBins: r.bins.length,
    templateRmsPpm: r.rmsPpm,
    maxAbsTemplatePpm: r.maxAbsPpm,
    applied: r.applied,
  };
}
