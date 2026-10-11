// Light-curve-only false-positive discriminators: two physics tests a genuine transiting
// planet passes and a blend / eclipsing-binary (EB) impostor tends to fail. Both are pure
// functions of a LightCurve + ephemeris (no extra data products), so they are cheap and can
// run on both the Node and Cloudflare runtimes alongside the summed photometry the pipeline
// already has -- unlike the pixel centroid test, which needs a target-pixel download.
//
// 1) ODD/EVEN DEPTH SYMMETRY. Fold on the detected period P and group in-transit cadences by
//    the integer epoch index parity (odd vs even transits). A real planet occultates once per
//    orbit, so odd and even transits have the same depth; a period-HALVED alias (true period
//    2P reported as P) stacks alternating real/empty events and shows unequal odd/even depths.
// 2) SECONDARY ECLIPSE. A planet's dayside is occulted near phase 0.5 producing a tiny dip
//    (usually far below TESS precision for small planets); an unresolved EB produces a
//    secondary comparable in depth to the primary. A large secondary relative to the primary
//    depth is a strong EB signature.
//
// Deterministic (fixed windows, plain medians/means). Threshold decisions live in the critic
// (src/critic/review.ts), NOT here -- this module only measures.

import type { LightCurve } from "../core/types.ts";

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** phase in [0,1) relative to t0 and period. */
function phaseOf(t: number, t0: number, period: number): number {
  let p = (t - t0) / period;
  p -= Math.floor(p);
  return p;
}

/** integer transit epoch index nearest to time t (0 = the reference transit at t0). */
function epochIndex(t: number, t0: number, period: number): number {
  return Math.round((t - t0) / period);
}

/** is time t within +/- halfDuration of the transit centered on epoch k? */
function withinTransit(t: number, t0: number, period: number, halfDurDays: number, k: number): boolean {
  const center = t0 + k * period;
  return Math.abs(t - center) <= halfDurDays;
}

export interface OddEvenResult {
  depthOddPpt: number;
  depthEvenPpt: number;
  /** |odd - even| depth difference, parts-per-thousand. */
  diffPpt: number;
  /** diff normalized by the mean depth: |odd-even| / ((|odd|+|even|)/2). */
  diffFrac: number;
  nOdd: number;
  nEven: number;
  /** false when there were too few transits on one side to judge (do NOT treat as a failure). */
  determined: boolean;
}

/** Measure the odd/even transit depth asymmetry for a signal of the given ephemeris. */
export function oddEvenDepth(lc: LightCurve, t0Bjd: number, periodDays: number, durationHours: number): OddEvenResult {
  const halfDur = durationHours / 24 / 2;
  const pts = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
  // baseline = median of out-of-transit flux (a few widths clear of any predicted transit).
  const out = pts
    .filter((p) => {
      const ph = phaseOf(p.time, t0Bjd, periodDays);
      const nearPrimary = ph <= halfDur / periodDays || ph >= 1 - halfDur / periodDays;
      return !nearPrimary;
    })
    .map((p) => p.flux);
  const baseline = median(out.length ? out : pts.map((p) => p.flux));

  let oddSum = 0;
  let oddN = 0;
  let evenSum = 0;
  let evenN = 0;
  for (const p of pts) {
    const k = epochIndex(p.time, t0Bjd, periodDays);
    if (!withinTransit(p.time, t0Bjd, periodDays, halfDur, k)) continue;
    if (k % 2 === 0) {
      evenSum += p.flux;
      evenN++;
    } else {
      oddSum += p.flux;
      oddN++;
    }
  }
  const mk = (sum: number, n: number) => (n > 0 ? (baseline - sum / n) * 1000 : 0);
  const depthEven = mk(evenSum, evenN);
  const depthOdd = mk(oddSum, oddN);
  const diffPpt = Math.abs(depthOdd - depthEven);
  const meanDepth = (Math.abs(depthOdd) + Math.abs(depthEven)) / 2;
  const determined = oddN >= 1 && evenN >= 1 && (oddN + evenN) >= 4 && meanDepth > 0;
  return {
    depthOddPpt: depthOdd,
    depthEvenPpt: depthEven,
    diffPpt,
    diffFrac: determined ? diffPpt / meanDepth : 0,
    nOdd: oddN,
    nEven: evenN,
    determined,
  };
}

export interface SecondaryEclipseResult {
  primaryDepthPpt: number;
  secondaryDepthPpt: number;
  /** secondary / primary depth (>=~0.2-0.3 points to a stellar companion, not a planet). */
  ratio: number;
  nPrimary: number;
  nSecondary: number;
  determined: boolean;
}

/** Measure the phase-0.5 secondary-eclipse depth relative to the phase-0 primary. */
export function secondaryEclipse(lc: LightCurve, t0Bjd: number, periodDays: number, durationHours: number): SecondaryEclipseResult {
  const halfDur = durationHours / 24 / 2;
  const pts = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
  const baseline = median(pts.map((p) => p.flux));
  let priSum = 0;
  let priN = 0;
  let secSum = 0;
  let secN = 0;
  for (const p of pts) {
    const ph = phaseOf(p.time, t0Bjd, periodDays);
    if (ph <= halfDur / periodDays || ph >= 1 - halfDur / periodDays) {
      priSum += p.flux;
      priN++;
    } else if (Math.abs(ph - 0.5) <= halfDur / periodDays) {
      secSum += p.flux;
      secN++;
    }
  }
  const primary = priN > 0 ? (baseline - priSum / priN) * 1000 : 0;
  const secondary = secN > 0 ? (baseline - secSum / secN) * 1000 : 0;
  const determined = priN >= 2 && secN >= 1 && primary > 0;
  return {
    primaryDepthPpt: primary,
    secondaryDepthPpt: secondary,
    ratio: determined && primary > 0 ? secondary / primary : 0,
    nPrimary: priN,
    nSecondary: secN,
    determined,
  };
}

// ---------------------------------------------------------------------------
// ROBUST (refit) ODD/EVEN.
//
// The plain oddEvenDepth above uses FIXED +/-halfDuration windows at the predicted epoch
// centers (t0 + k*P). On a single TESS sector a small catalog period error accumulates over
// many orbits, so distant transits drift OUT of their window and odd/even depths spuriously
// disagree (we measured 100-200% on REAL confirmed planets) -- unusable as a gate. This variant
// REFINES each transit's center independently: within a search radius around each predicted
// epoch it locates the deepest local transit, then measures the depth THERE. Because every event
// is measured at its own actual position, accumulated phase error cancels and a real planet reads
// symmetric, while a genuine period-halved alias still alternates deep/shallow events and is
// caught. This is what makes odd/even safe to gate -- but it must still be calibrated on real
// planets before it is allowed to reject (see scripts/p2-vet-calibrate).
// ---------------------------------------------------------------------------

export interface RefinedEvent {
  epoch: number; // integer epoch index
  centerBjd: number; // refined transit center
  depthPpt: number; // baseline - in-window mean flux (ppm*1e3)
  nPts: number;
}

export interface OddEvenRefinedResult extends OddEvenResult {
  events: RefinedEvent[];
  /** max |observed - predicted| residual of the per-event refit (days) -- a phase-drift gauge. */
  maxResidualDays: number;
}

/** Locate each transit's true center by local search and measure its depth there. */
export function findTransitEvents(
  lc: LightCurve,
  t0Bjd: number,
  periodDays: number,
  durationHours: number,
  searchFrac = 0.2,
): { events: RefinedEvent[]; baseline: number } {
  const halfDur = durationHours / 24 / 2;
  const pts = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
  if (pts.length < 8 || periodDays <= 0) return { events: [], baseline: NaN };
  const baseline = median(pts.map((p) => p.flux));
  const tFirst = pts[0].time;
  const tLast = pts[pts.length - 1].time;
  const radius = Math.min(searchFrac * periodDays, 0.4 * periodDays); // stay clear of the alias half-period
  const steps = 20;
  const events: RefinedEvent[] = [];
  const kMin = Math.ceil((tFirst - t0Bjd) / periodDays) + 1;
  const kMax = Math.floor((tLast - t0Bjd) / periodDays) - 1;
  for (let k = kMin; k <= kMax; k++) {
    const predicted = t0Bjd + k * periodDays;
    let best = { offset: 0, meanFlux: Infinity, nPts: 0 };
    for (let s = 0; s <= steps; s++) {
      const center = predicted - radius + (2 * radius * s) / steps;
      let sum = 0;
      let n = 0;
      for (const p of pts) {
        if (Math.abs(p.time - center) <= halfDur) {
          sum += p.flux;
          n++;
        }
      }
      if (n >= 2 && sum / n < best.meanFlux) best = { offset: center - predicted, meanFlux: sum / n, nPts: n };
    }
    if (best.nPts >= 2 && best.meanFlux < Infinity) {
      events.push({ epoch: k, centerBjd: predicted + best.offset, depthPpt: (baseline - best.meanFlux) * 1000, nPts: best.nPts });
    }
  }
  return { events, baseline };
}

/** Robust odd/even asymmetry measured at each transit's own refined center. */
export function oddEvenRefined(lc: LightCurve, t0Bjd: number, periodDays: number, durationHours: number): OddEvenRefinedResult {
  const { events } = findTransitEvents(lc, t0Bjd, periodDays, durationHours);
  const even: number[] = [];
  const odd: number[] = [];
  let maxResidual = 0;
  for (const e of events) {
    const resid = Math.abs(e.centerBjd - (t0Bjd + e.epoch * periodDays));
    if (resid > maxResidual) maxResidual = resid;
    if (e.depthPpt <= 0) continue; // not a dip at this epoch -> not an observed transit
    (e.epoch % 2 === 0 ? even : odd).push(e.depthPpt);
  }
  const depthEven = even.length ? median(even) : 0;
  const depthOdd = odd.length ? median(odd) : 0;
  const diffPpt = Math.abs(depthOdd - depthEven);
  const meanDepth = (Math.abs(depthOdd) + Math.abs(depthEven)) / 2;
  const determined = even.length >= 2 && odd.length >= 2 && meanDepth > 0;
  return {
    depthOddPpt: depthOdd,
    depthEvenPpt: depthEven,
    diffPpt,
    diffFrac: determined ? diffPpt / meanDepth : 0,
    nOdd: odd.length,
    nEven: even.length,
    determined,
    events,
    maxResidualDays: maxResidual,
  };
}
