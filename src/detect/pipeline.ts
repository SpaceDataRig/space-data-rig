// anomaly-scout detection pipeline: preprocess -> BLS -> odd-even alias
// resolution -> TransitCandidate. This is the single function the seat calls
// per target, and what the orchestrator wires between seats.

import { preprocess } from "./detrend.ts";
import { bls, toCandidate, type BLSOptions, type BLSResult } from "./bls.ts";
import { resolvePeriodAlias } from "../sim/aliasResolver.ts";
import {
  aOverRsFromKepler,
  transitModel,
  type OrbitParams,
} from "../sim/transitModel.ts";
import type { LightCurve, TransitCandidate } from "../core/types.ts";

export interface DetectionResult {
  candidate: TransitCandidate;
  bls: BLSResult;
  aliasMultiple: number; // 1 = BLS period was already correct
  clean: LightCurve; // preprocessed curve (for plotting / model overlay)
  /** Transit model evaluated at the clean times, using recovered params. */
  model: { time: number; flux: number }[];
}

function frac(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

function recomputeFolded(times: number[], flux: number[], period: number, epoch: number) {
  const folded = times.map((t, i) => {
    let p = frac((t - epoch) / period + 0.5);
    if (p > 1) p -= 1;
    return { phase: p, flux: flux[i] };
  });
  folded.sort((a, b) => a.phase - b.phase);
  return folded;
}

/** Build a transit model overlay from recovered candidate params. */
export function modelFromCandidate(
  c: TransitCandidate,
  times: number[],
  stellarRadiusRsun = 1.0,
  stellarMassMsun = 1.0,
  impactParam = 0.3,
): { time: number; flux: number }[] {
  const aOverRs = aOverRsFromKepler(c.periodDays, stellarMassMsun, stellarRadiusRsun);
  const orbit: OrbitParams = {
    periodDays: c.periodDays,
    t0Bjd: c.epochBjd,
    aOverRs,
    impactParam,
    planetRadiusRatio: Math.sqrt(Math.max(1e-8, c.depthFrac)),
    limbDarkening: 0.3,
  };
  const m = transitModel(times, orbit);
  return times.map((t, i) => ({ time: t, flux: m[i] }));
}

/** Run the full detection chain on one (raw) light curve. */
export function detectTransit(lc: LightCurve, blsOpts: BLSOptions = {}): DetectionResult {
  const clean = preprocess(lc, 0.5);
  const r = bls(clean, blsOpts);
  const times = clean.points.map((p) => p.time);
  const flux = clean.points.map((p) => p.flux);
  const al = resolvePeriodAlias(times, flux, r.periodDays, r.epochBjd, r.durationDays);

  const candidate = toCandidate(clean, r);
  candidate.periodDays = al.period;
  candidate.epochBjd = al.epoch;
  // The alias resolver moves the period by an integer multiple. The grid uncertainty scales with it
  // (dP' = m * dP for P' = m * P), so rescale rather than keep the pre-alias number. atSearchBoundary is left
  // alone on purpose: a period doubled off the edge node is still a peak that ran into the wall.
  if (Number.isFinite(r.periodDays) && r.periodDays > 0 && Number.isFinite(al.period)) {
    candidate.periodResolutionDays = r.periodResolutionDays * (al.period / r.periodDays);
  }
  candidate.folded = recomputeFolded(times, flux, al.period, al.epoch);

  const model = modelFromCandidate(candidate, times);
  return { candidate, bls: r, aliasMultiple: al.multiple, clean, model };
}
