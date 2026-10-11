// Inject a physical transit INTO an existing (real) light curve, for a REAL-noise completeness study.
//
// The published completeness/purity curve (npm run p1:roc) is built on SYNTHETIC white/red noise.
// That characterizes the detector, but a survey reports completeness on its ACTUAL data. So here we
// take a real TESS-SPOC light curve (real noise color, real cadence, real data gaps) and multiply a
// known transit onto it, then hand it to the same detector (preprocess + BLS). Recovering the injected
// period at a given depth, across many depths, measures completeness against REAL photometry -- the
// honest "what fraction of planets of this size would we actually catch in THIS data" number.
//
// The transit is applied MULTIPLICATIVELY (flux *= model), so the target's own noise, sampling and
// gaps are untouched; only a dip is added. Deterministic given the seed. This module is used only by
// the benchmark script and tests -- never by the runtime pipeline -- so no bundle hash changes.

import type { LightCurve } from "../core/types.ts";
import {
  aOverRsFromKepler,
  inclinationFromImpact,
  transitFlux,
  transitDurationHours,
  type OrbitParams,
} from "./transitModel.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InjectOptions {
  seed?: number;
  periodDays: number;
  depthFrac: number; // 0 => no dip (a no-op pass-through, useful as a control)
  impactParam?: number;
  stellarRadiusRsun?: number;
  stellarMassMsun?: number;
  limbDarkening?: number;
  /** Transit-center epoch. If omitted it is placed at a random phase within the baseline (seeded). */
  t0Bjd?: number;
  /** Label target id with an injected suffix; keeps source host if not overridden. */
  label?: string;
}

/**
 * Return a new LightCurve whose flux is the input flux times a transit model at the given period /
 * depth / epoch. Times, fluxErr and cadence are preserved (real sampling + real scatter kept). The
 * baseline (out-of-transit) is unchanged, so the injected signal rides on the target's own noise.
 */
export function injectTransitInto(lc: LightCurve, o: InjectOptions): LightCurve {
  const rand = mulberry32(o.seed ?? 1);
  const depth = Math.max(0, o.depthFrac);
  const impactParam = o.impactParam ?? rand() * 0.7;
  const stellarRadiusRsun = o.stellarRadiusRsun ?? 1.2;
  const stellarMassMsun = o.stellarMassMsun ?? 1.0;

  const aOverRs = aOverRsFromKepler(o.periodDays, stellarMassMsun, stellarRadiusRsun);
  // Place the transit center a few periods into the baseline so multiple transits are visible.
  const tStart = lc.points.length ? lc.points[0].time : 2459000.5;
  const tEnd = lc.points.length ? lc.points[lc.points.length - 1].time : tStart + 27;
  const maxStart = Math.max(tStart, tEnd - o.periodDays);
  const t0Bjd = o.t0Bjd ?? tStart + o.periodDays + rand() * Math.max(0, maxStart - (tStart + o.periodDays));

  const orbit: OrbitParams = {
    periodDays: o.periodDays,
    t0Bjd,
    aOverRs,
    impactParam,
    planetRadiusRatio: Math.sqrt(depth),
    limbDarkening: o.limbDarkening ?? 0.3,
  };
  inclinationFromImpact(impactParam, aOverRs);

  const points = lc.points.map((p) => ({
    time: p.time,
    flux: p.flux * transitFlux(p.time, orbit), // multiplicative: keeps real noise/gaps, adds a dip
    fluxErr: p.fluxErr,
  }));

  const durationHours = transitDurationHours(orbit);
  return {
    targetId: (o.label ?? lc.targetId) + (depth > 0 ? `+INJ${(depth * 1e6).toFixed(0)}ppm` : ""),
    mission: lc.mission,
    cadenceSec: lc.cadenceSec,
    points,
    source: `injected into ${lc.source ?? "photometry"} (P=${o.periodDays.toFixed(3)}d, depth=${(depth * 1e6).toFixed(0)}ppm, b=${impactParam.toFixed(2)}, dur=${durationHours.toFixed(2)}h, seed=${o.seed ?? 1})`,
  };
}

/** Match a recovered period to truth allowing the usual aliases/harmonics. */
export function periodMatched(recovered: number, truth: number, tolPct: number): boolean {
  for (const f of [1, 0.5, 2, 1 / 3, 3, 2 / 3, 3 / 2, 1.5]) {
    if (Math.abs(recovered * f - truth) / truth <= tolPct / 100) return true;
  }
  return false;
}
