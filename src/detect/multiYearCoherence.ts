// MULTI-YEAR O-C COHERENCE as a period-confirmation score (validation roadmap, priority 3).
//
// WHY. scripts/p29/p30 measured the real bottleneck of cross-sector joint search: on a stitched
// multi-year baseline a single blind BLS locks the STRONGEST peak, which is often a DIFFERENT real
// planet in the same system -- so the period SELECTION, not the window function (P43 showed the daily
// window is closed on TESS), is what fails. This module supplies one selector for that. A genuine
// Keplerian signal has transits that land on a single straight line when you plot observed mid-time vs
// cycle number over the WHOLE baseline (a linear O-C with tiny residual). A signal borrowed from
// another planet, or a noise fluctuation, will not time consistently across years -- it yields few
// timed events or a large O-C scatter -- so scoring coherence and ranking candidates by it picks the
// self-consistent period over an inconsistent one.
//
// WHAT IT CANNOT DO (honest). A perfect half- or double-period HARMONIC ALIAS is itself exactly
// linear in O-C (the real dips fall on every other predicted cycle), so coherence does NOT break
// harmonic aliases -- that is the separate job of src/sim/aliasResolver.ts (odd/even depth). Coherence
// discriminates wrong-signal / non-Keplerian candidates, not harmonics. Use the two together.
//
// NOTE vs P14. scripts/p14 measured that REFITTING the period from few transits is noisier than the
// catalog value -- that is a refinement claim. Here we do NOT refine; we only USE the O-C fit residual
// as a DISCRIMINATOR to rank already-known candidate periods. Different question, different use.
//
// Pure, deterministic, no network. Additive: not imported by the runtime pipeline, so no bundle hash
// or money-path change. Composes src/detect/ephemeris.ts.

import { timeTransitEvents, refitEphemeris } from "./ephemeris.ts";

export interface CoherenceOptions {
  /** search half-window per predicted transit, in phase cycles (default 0.05). */
  windowPhase?: number;
  /** transit duration, days -- scales the "how tight is the O-C" score. */
  durationDays?: number;
  /** minimum timed events to call anything (default 3). */
  minEvents?: number;
}

export interface CoherenceReport {
  periodDays: number;
  /** transits successfully timed by the dip centroid. */
  nEvents: number;
  baselineDays: number;
  /** fraction of the baseline spanned between the first and last timed transit. */
  coverageFrac: number;
  /** RMS of the observed-minus-calculated (O-C) transit mid-times, hours. */
  ocRmsHours: number;
  /**
   * 0..1 coherence score = count x coverage x (O-C tightness). High only when many transits are
   * timed, spread across the baseline, and consistent with one linear ephemeris.
   */
  coherence: number;
  determined: boolean;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Score how coherent a candidate (period, epoch) is over a light curve's full baseline by timing each
 * predicted transit and fitting a linear O-C relation. Returns determined=false (coherence 0) when too
 * few transits can be timed to say anything -- so an untestable candidate never outranks a testable one.
 */
export function multiYearCoherence(
  times: number[],
  flux: number[],
  periodDays: number,
  epochBjd: number,
  opts: CoherenceOptions = {},
): CoherenceReport {
  const minEvents = opts.minEvents ?? 3;
  const baselineDays = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
  const empty: CoherenceReport = {
    periodDays,
    nEvents: 0,
    baselineDays,
    coverageFrac: 0,
    ocRmsHours: NaN,
    coherence: 0,
    determined: false,
  };
  if (times.length < 4 || !(periodDays > 0) || !(baselineDays > 0)) return empty;

  const events = timeTransitEvents(times, flux, periodDays, epochBjd, { windowPhase: opts.windowPhase ?? 0.05 });
  const fit = refitEphemeris(events);
  if (!Number.isFinite(fit.periodDays) || fit.nEvents < minEvents) return { ...empty, nEvents: fit.nEvents };

  const ok = events.filter((e) => e.ok && Number.isFinite(e.center));
  const span = ok.length >= 2 ? ok[ok.length - 1].center - ok[0].center : 0;
  const coverageFrac = clamp01(span / baselineDays);
  const ocRmsHours = fit.rms * 24;

  // O-C tightness relative to the transit duration: a real signal times to well inside a transit.
  const durDays = opts.durationDays && opts.durationDays > 0 ? opts.durationDays : Math.min(0.2, periodDays * 0.05);
  const durHours = durDays * 24;
  const tightness = Math.exp(-((ocRmsHours / durHours) ** 2)); // 1 when O-C << duration, ->0 when smeared
  const countScore = clamp01(fit.nEvents / 8);
  const coherence = clamp01(countScore * coverageFrac * tightness);

  return {
    periodDays,
    nEvents: fit.nEvents,
    baselineDays,
    coverageFrac,
    ocRmsHours,
    coherence,
    determined: true,
  };
}

/**
 * Given a set of candidate (period, epoch) pairs, return them ranked by descending coherence. Used to
 * ask whether O-C coherence selects the true period among the BLS peaks.
 */
export function rankByCoherence(
  times: number[],
  flux: number[],
  candidates: { periodDays: number; epochBjd: number }[],
  opts: CoherenceOptions = {},
): CoherenceReport[] {
  return candidates
    .map((c) => multiYearCoherence(times, flux, c.periodDays, c.epochBjd, opts))
    .sort((a, b) => b.coherence - a.coherence);
}
