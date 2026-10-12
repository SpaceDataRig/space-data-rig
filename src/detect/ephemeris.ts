// Per-transit ephemeris refinement (O-C timing) -- the principled fix for the long-period
// phase-coherence limit that scripts/p12-multisector.ts exposed.
//
// The problem: a single TESS sector is ~27 days, so long-period planets show too few transits; and
// stitching many sectors into one long baseline and folding it at the CATALOG ephemeris makes the
// depth WORSE, because a tiny catalog period error accumulates phase drift over 1000-1800 days and
// smears the fold (p12 finding). The fix is to stop trusting the catalog period blindly: time each
// individual transit, then fit a linear cycle-vs-time (O-C) relation to recover a precise period and
// epoch, and fold the long baseline at THAT so every transit lands at phase ~0.
//
// timeTransitEvents uses a flux-weighted dip centroid inside a search window around each predicted
// center -- if the dip is fully inside the window the centroid is unbiased by the window position, so
// a generous window still recovers the true mid-time even when the initial ephemeris has drifted.
// refitEphemeris does a (once sigma-clipped) least-squares line center = t0 + period * cycle.
//
// Pure, deterministic, no network. Additive: used only by scripts/p14-longperiod-coherence.ts and its
// tests, NEVER in the runtime pipeline or the synthetic injection path, so no bundle hash changes.

export interface TransitEvent {
  cycle: number; // integer transit number relative to the search epoch
  predicted: number; // predicted center time (BJD) from the initial ephemeris
  center: number; // observed center time (BJD) from the flux-weighted dip centroid
  weight: number; // summed (baseline - flux) dip weight; a proxy for detection confidence
  ok: boolean; // true if a real dip was found inside the window
}

export interface EventTimingOptions {
  /** Search half-window around each predicted center, in orbital phase cycles (default 0.05). */
  windowPhase?: number;
  /** Minimum number of data points inside the window to trust a timing (default 4). */
  minPoints?: number;
  /** Minimum summed dip weight (in flux) to call a transit detected (default 0.002). */
  minWeight?: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Time every predicted transit in [tmin, tmax] by the flux-weighted centroid of the dip inside a
 * search window. times must be strictly increasing BJD; flux is normalized so out-of-transit ~ 1.
 * Returns events (ok-flagged) sorted by cycle.
 */
export function timeTransitEvents(
  times: number[],
  flux: number[],
  periodDays: number,
  t0Bjd: number,
  opts: EventTimingOptions = {},
): TransitEvent[] {
  const windowPhase = opts.windowPhase ?? 0.05;
  const minPoints = opts.minPoints ?? 4;
  const minWeight = opts.minWeight ?? 0.002;
  const n = times.length;
  if (n < minPoints || periodDays <= 0) return [];
  const baseline = median(flux);
  const halfWin = windowPhase * periodDays;
  const tmin = times[0];
  const tmax = times[n - 1];
  const c0 = Math.ceil((tmin + halfWin - t0Bjd) / periodDays);
  const c1 = Math.floor((tmax - halfWin - t0Bjd) / periodDays);
  const events: TransitEvent[] = [];
  for (let cycle = c0; cycle <= c1; cycle++) {
    const predicted = t0Bjd + cycle * periodDays;
    let wsum = 0;
    let tw = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const dt = times[i] - predicted;
      if (dt < -halfWin || dt > halfWin) continue;
      count++;
      if (!Number.isFinite(flux[i])) continue;
      const w = Math.max(0, baseline - flux[i]); // how far below baseline (0 out of transit)
      if (w > 0) { wsum += w; tw += times[i] * w; }
    }
    if (count < minPoints || wsum <= 0) {
      events.push({ cycle, predicted, center: NaN, weight: wsum, ok: false });
      continue;
    }
    const center = tw / wsum;
    const ok = wsum >= minWeight && Math.abs(center - predicted) <= halfWin;
    events.push({ cycle, predicted, center: ok ? center : NaN, weight: wsum, ok });
  }
  return events;
}

export interface EphemerisFit {
  periodDays: number;
  t0Bjd: number;
  rms: number; // RMS of (observed - predicted) center times, days
  nEvents: number; // events used in the final fit
  maxAbsResid: number; // worst residual, days
}

/**
 * Fit a linear O-C relation center = t0 + period * cycle to the ok events (one 3-MAD sigma-clip pass
 * when there are enough points). Returns NaN fields if fewer than 3 usable events remain.
 */
export function refitEphemeris(events: TransitEvent[]): EphemerisFit {
  const use = events.filter((e) => e.ok && Number.isFinite(e.center));
  if (use.length < 3) {
    return { periodDays: NaN, t0Bjd: NaN, rms: NaN, nEvents: use.length, maxAbsResid: NaN };
  }
  let keep = use;
  const fitOnce = (pts: TransitEvent[]) => {
    const mc = median(pts.map((p) => p.cycle));
    const mt = median(pts.map((p) => p.center));
    let sxy = 0;
    let sxx = 0;
    for (const p of pts) { sxy += (p.cycle - mc) * (p.center - mt); sxx += (p.cycle - mc) ** 2; }
    const period = sxx > 0 ? sxy / sxx : NaN;
    const t0 = mt - period * mc;
    return { period, t0 };
  };
  let { period, t0 } = fitOnce(keep);
  if (!Number.isFinite(period) || !Number.isFinite(t0)) {
    return { periodDays: NaN, t0Bjd: NaN, rms: NaN, nEvents: keep.length, maxAbsResid: NaN };
  }
  // one robust sigma-clip pass using median absolute residual
  if (keep.length >= 6) {
    const resid = keep.map((p) => Math.abs(p.center - (t0 + period * p.cycle)));
    const mres = median(resid);
    const thresh = Math.max(0.002, 3 * mres);
    const kept = keep.filter((p) => Math.abs(p.center - (t0 + period * p.cycle)) <= thresh);
    if (kept.length >= 3) {
      keep = kept;
      const refit = fitOnce(keep);
      if (Number.isFinite(refit.period) && Number.isFinite(refit.t0)) { period = refit.period; t0 = refit.t0; }
    }
  }
  let sse = 0;
  let maxAbs = 0;
  for (const p of keep) {
    const r = p.center - (t0 + period * p.cycle);
    sse += r * r;
    if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
  }
  return {
    periodDays: period,
    t0Bjd: t0,
    rms: Math.sqrt(sse / keep.length),
    nEvents: keep.length,
    maxAbsResid: maxAbs,
  };
}
