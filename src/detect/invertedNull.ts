// INVERTED, PLANET-FREE CLEAN NULL -- a reusable significance-calibration generator (audit-10 #6: "make P75 a
// standalone, reusable product", not a null buried inside one script).
//
// WHY. To know whether a significance gate is honest you need a null that contains NO planets by construction --
// not a masked residual that can keep sibling bumps (P69's caveat). The external project's trick (eumemic
// EXO_INVERT), which P75 adopted, is: reflect a REAL light curve about its median (every transit dip becomes a
// bump), then drop every cadence that is in-transit for a catalogued planet on that host (ground-truth ephemeris,
// window widened). The strongest residual POSITIVE fold that survives can then only be noise / systematics -- a
// clean false-alarm sample you can score against any gate. This module isolates those two pure, offline-testable
// steps so any study can build the same null; P75 pairs the result with BOTH the production AR(1) gate
// (calibratedFap) and a model-free block bootstrap (estimateFap) to report the empirical FP rate two ways.
//
// On real SPOC (P75, n=16) this null showed the AR(1) gate signing off 75% of pure-noise bumps at FAP<0.05 vs the
// nominal 5% -- the AR(1) null is optimistic on real systematics tails. This module only BUILDS the null; it
// scores nothing, gates nothing, anchors nothing. Pure + deterministic + research-only: no network, no worker
// import, cannot touch a verdict / bundle hash / money path. discoveryClaim stays false.

import type { LightCurve } from "../core/types.ts";
import { inTransitMask } from "./iterative.ts";

/** A catalogued transit to mask out of a null curve (period d, mid-transit epoch BJD, duration days). */
export interface KnownTransit {
  period: number;
  epoch: number;
  durDays: number;
}

/** Median of a curve's finite flux values (null-safe; 1 when empty). */
function medianFlux(lc: LightCurve): number {
  const vals = lc.points.map((p) => p.flux).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)]! : 1;
}

/**
 * Reflect flux about its median: flux -> 2*median - flux. Every dip becomes a bump and vice versa, so a
 * transit-only search on the result can find nothing real. Returns a FRESH curve; the input is never mutated.
 */
export function invertCurve(lc: LightCurve): LightCurve {
  const med = medianFlux(lc);
  return { ...lc, points: lc.points.map((p) => ({ ...p, flux: Number.isFinite(p.flux) ? 2 * med - p.flux : p.flux })) };
}

/**
 * Drop every cadence that is in-transit for any of `planets`, widening each transit window by `padFrac` so the
 * wings go too. Returns a FRESH curve; the input is never mutated. With no planets this is a copy.
 */
export function maskKnownTransits(lc: LightCurve, planets: KnownTransit[], padFrac = 0.5): LightCurve {
  const times = lc.points.map((p) => p.time);
  const drop = times.map(() => false);
  for (const s of planets) {
    const m = inTransitMask(times, s.period, s.epoch, s.durDays, padFrac);
    for (let i = 0; i < m.length; i++) if (m[i]) drop[i] = true;
  }
  return { ...lc, points: lc.points.filter((_, i) => !drop[i]) };
}

/**
 * Build the clean planet-free null in one call: invert, then mask every catalogued transit. The surviving
 * positive folds are noise / systematics only -- a false-alarm sample for calibrating a significance gate.
 */
export function invertedPlanetFreeNull(lc: LightCurve, planets: KnownTransit[], padFrac = 0.5): LightCurve {
  return maskKnownTransits(invertCurve(lc), planets, padFrac);
}
