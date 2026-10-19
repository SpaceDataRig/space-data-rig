// SYNTHETIC ASTROPHYSICAL FALSE-POSITIVE TAXONOMY -- a labeled generator that injects the eclipsing-binary /
// blend family into REAL light curves, so a vetting posterior can be scored against a KNOWN-negative population.
//
// WHY (authority roadmap, priority 2). The field's statistical-validation machinery (RAVEN, Hadjigeorghiou+ 2025
// MNRAS; LEO-Vetter, Kunimoto+ 2025 ApJ; TRICERATOPS, Giacalone+ 2020 ApJ) is trained/calibrated on a physical FP
// taxonomy: a transiting Planet (positive control) plus EB, hierarchical EB (HEB), background EB (BEB), nearby EB
// (NEB), hierarchical transiting planet (HTP), and nearby transiting planet (NTP). The repo had the ANALYSIS side
// of this -- discriminants (src/detect/vetting.ts secondaryEclipse / oddEvenRefined), a blend FPP (falsePositiveProbability.ts),
// an alias-risk grader (triceratopsLite.ts) -- but NO generator, so no measured ROC of "which FP classes a flux
// posterior can actually reject". This module is the missing generator: it multiplies a labeled eclipse/blend
// signal onto a real curve (real noise, cadence, gaps untouched) exactly as injectTransitInto does for planets.
//
// THE PHYSICS THAT THE DISCRIMINANTS KEY ON, encoded honestly:
//   * A PLANET is one dip per orbit with NO comparable secondary (the far-side occultation is ppm and ignored).
//   * An ECLIPSING BINARY has a SECOND dip at phase 0.5 whose depth is a large fraction of the primary (the
//     secondary/primary ratio approaches 1, not ~0) -- the signature secondaryEclipse() measures.
//   * A BLEND (HEB/BEB/NEB/HTP/NTP) is one of those signals seen through EXTRA starlight: its dips are DILUTED
//     (shallow, so it can mimic a planet by depth alone) but the shape -- secondary for the EB-family, none for
//     the planet-family -- is preserved. Crucially a blended PLANET (HTP/NTP) is FLUX-degenerate with an on-target
//     planet: only a centroid/pixel test separates them, which this repo measures elsewhere (P53/P58/P89) and found
//     false-kills real planets. That honest limit is what the downstream ROC is meant to expose, not paper over.
//
// Pure + deterministic (seeded epoch/durations) + research-only: no network, no worker import, nothing wired into
// a verdict / bundle hash / money path. Discovery-claim irrelevant here (these are labelled by construction). This
// module only GENERATES labelled curves and scores nothing.

import type { LightCurve } from "../core/types.ts";

/** The physical scenario a synthetic curve was built from. "planet" is the positive control (a true transit). */
export type FpKind = "planet" | "EB" | "HEB" | "BEB" | "NEB" | "HTP" | "NTP";

export interface EclipseShape {
  periodDays: number;
  t0Bjd: number; // phase-0 (primary) center
  depthPrimary: number; // intrinsic fractional dip (before any dilution)
  secondaryRatio: number; // secondary/primary depth; ~0 for a planet, 0.4-1.0 for an EB
  dutyCycle: number; // (transit duration / period); controls dip width
  ingressFrac: number; // fraction of the dip spent in/out of the box (V-vs-U shape)
  phaseShiftSec: number; // offset of the secondary from exact phase 0.5 (eccentricity proxy)
}

/** Signed orbital phase in [-0.5, 0.5), 0 at t0Bjd. */
function phaseAt(t: number, period: number, t0: number): number {
  let p = ((t - t0) / period) % 1;
  if (p > 0.5) p -= 1;
  if (p < -0.5) p += 1;
  return p;
}

/**
 * One trapezoidal eclipse centered at signed phase `center` with the given half-width and depth. Uniform outside
 * the box, linear ingress/egress over `ingressFrac` of the width -- a transparent approximation the depth/secondary
 * discriminants measure by in-transit mean, matching LEO-Vetter's own trapezoid model choice.
 */
function singleEclipse(phase: number, center: number, halfWidth: number, depth: number, ingressFrac: number): number {
  if (halfWidth <= 0 || depth <= 0) return 1;
  let d = phase - center;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  const ad = Math.abs(d);
  if (ad >= halfWidth) return 1;
  const ing = Math.max(1e-9, halfWidth * Math.min(0.9, ingressFrac));
  const edge = halfWidth - ad;
  const inFull = edge >= ing ? 1 : edge / ing; // 1 in the flat bottom, ramps to 0 at the very edge
  return 1 - depth * inFull;
}

/** Multiplicative flux model over one time: primary dip + (optionally) a phase-0.5 secondary. 1.0 = no signal. */
export function eclipseFlux(t: number, s: EclipseShape): number {
  const ph = phaseAt(t, s.periodDays, s.t0Bjd);
  const hw = Math.max(1e-4, s.dutyCycle / 2);
  const prim = singleEclipse(ph, 0, hw, s.depthPrimary, s.ingressFrac);
  if (s.secondaryRatio <= 0) return prim;
  const sec = singleEclipse(ph, 0.5 + s.phaseShiftSec, hw, s.depthPrimary * s.secondaryRatio, s.ingressFrac);
  return prim * sec;
}

/**
 * Dilute a signal into extra background starlight: the eclipsing source contributes `blendFraction` of the total
 * flux, so every dip is scaled by it and the rest of the light stays flat. blendFraction=1 means on-target; a blend
 * is blendFraction<1 (shallow dips that mimic a planet by depth but keep the shape/secondary).
 */
export function dilute(model: number, blendFraction: number): number {
  return 1 - blendFraction * (1 - model);
}

/** Per-kind preset (intrinsic, before dilution). Depths/ratios/durations are literature-motivated ranges, fixed
 *  per class here so the generator is deterministic; the ROC that consumes them states these as ASSUMPTIONS. */
const PRESET: Record<FpKind, { depthPrimary: number; secondaryRatio: number; dutyCycle: number; ingressFrac: number; blend: number }> = {
  planet: { depthPrimary: 0.006, secondaryRatio: 0.0, dutyCycle: 0.04, ingressFrac: 0.25, blend: 1.0 }, // on-target, no secondary
  EB: { depthPrimary: 0.03, secondaryRatio: 0.6, dutyCycle: 0.05, ingressFrac: 0.3, blend: 1.0 }, // full-depth double dip
  HEB: { depthPrimary: 0.05, secondaryRatio: 0.5, dutyCycle: 0.05, ingressFrac: 0.3, blend: 0.12 }, // diluted triple-system EB
  BEB: { depthPrimary: 0.06, secondaryRatio: 0.7, dutyCycle: 0.06, ingressFrac: 0.3, blend: 0.1 }, // diluted background EB
  NEB: { depthPrimary: 0.05, secondaryRatio: 0.65, dutyCycle: 0.05, ingressFrac: 0.3, blend: 0.15 }, // diluted nearby EB
  HTP: { depthPrimary: 0.02, secondaryRatio: 0.0, dutyCycle: 0.04, ingressFrac: 0.25, blend: 0.2 }, // diluted planet on a companion
  NTP: { depthPrimary: 0.03, secondaryRatio: 0.0, dutyCycle: 0.04, ingressFrac: 0.25, blend: 0.25 }, // diluted planet on a neighbour
};

export interface SynthesizeOptions {
  kind: FpKind;
  periodDays?: number;
  t0Bjd?: number;
  depthScale?: number; // multiply the preset intrinsic depth (for a depth sweep)
  phaseShiftSec?: number; // eccentricity proxy for the secondary, default 0
  seed?: number;
  /** override the preset blend fraction (e.g. to hold an EB undiluted); else the per-kind blend is used. */
  blendFraction?: number;
}

/**
 * Return a FRESH curve whose flux is the host's real flux times the labelled eclipse/blend model. Times, fluxErr,
 * cadence and gaps are preserved (real sampling + real scatter kept), exactly as the planet injector does. The host
 * is never mutated. Deterministic in `seed` when t0 is omitted (epoch placed at a seeded phase).
 */
export function synthesizeFalsePositive(host: LightCurve, o: SynthesizeOptions): { lc: LightCurve; truth: FpKind; shape: EclipseShape } {
  const preset = PRESET[o.kind];
  const period = o.periodDays ?? 3;
  const times = host.points.map((p) => p.time);
  const t0 = o.t0Bjd ?? pickEpoch(times, period, o.seed ?? 1);
  const shape: EclipseShape = {
    periodDays: period,
    t0Bjd: t0,
    depthPrimary: preset.depthPrimary * (o.depthScale ?? 1),
    secondaryRatio: preset.secondaryRatio,
    dutyCycle: preset.dutyCycle,
    ingressFrac: preset.ingressFrac,
    phaseShiftSec: o.phaseShiftSec ?? 0,
  };
  const blend = o.blendFraction ?? preset.blend;
  const points = host.points.map((p) => ({ ...p, flux: p.flux * dilute(eclipseFlux(p.time, shape), blend) }));
  return { lc: { ...host, points }, truth: o.kind, shape };
}

function pickEpoch(times: number[], period: number, seed: number): number {
  const tMin = times.reduce((a, b) => Math.min(a, b), Infinity);
  const tMax = times.reduce((a, b) => Math.max(a, b), -Infinity);
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) return 0;
  const span = Math.max(0, tMax - tMin - period);
  const r = (seed * 2654435761 % 100000) / 100000; // deterministic in seed, no shared PRNG needed
  return tMin + period / 2 + r * span;
}
