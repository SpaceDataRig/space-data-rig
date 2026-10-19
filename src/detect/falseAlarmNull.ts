// SCRAMBLED FALSE-ALARM NULL + Robovetter-style completeness / reliability metrics.
//
// WHY THIS EXISTS (authority roadmap, priority 3). To turn a set of vetting thresholds into a defensible
// instrument you need (a) a PLANET-FREE false-alarm population to measure REABILITY against, and (b) an injected
// planet population to measure COMPLETENESS against -- then you pick thresholds that jointly maximise both. This
// is the technique the field validated in 2025: LEO-Vetter (Kunimoto et al. 2025, ApJ) classifies every TCE as a
// Planet Candidate (PC), an astrophysical False Positive (FP), or a noise/systematic False Alarm (FA), and tunes
// its flux-level thresholds by minimising sqrt((1-C)^2 + (1-R_FA)^2). It reached ~91-93% completeness on injected
// planets and known-TOI recovery on ~200k M-dwarf curves with that objective.
//
// SCRAMBLE, NOT INVERT. The repo already has two nulls: a per-candidate moving-block phase-scrambling FAP
// (src/detect/fap.ts -- a p-VALUE for one detection) and a curve INVERSION that reflects a light curve about its
// median so every dip becomes a bump (src/detect/invertedNull.ts). Neither is a candidate-level false-alarm
// POPULATION, and LEO-Vetter measured that INVERSION is the weaker surrogate: scattered-light ramps at the start
// of each TESS orbit are NOT symmetric under reflection (an up-ramp becomes a down-ramp that a box search reads as
// a transit), and M-dwarf flares invert into absorption dips. A time-SCRAMBLE -- permute the flux values among the
// fixed cadences -- keeps the exact flux amplitude distribution (same scatter, same outliers) while destroying any
// phase-coherent periodic dip, so the BLS peaks it leaves are the real false-alarm population. That is what this
// module builds.
//
// SCOPE / HONESTY. Pure + deterministic + research-only. No network, no worker/DO import, nothing wired into a
// verdict / bundle hash / money path. `detect` is injected by the caller so this file has no heavy dependency and
// is unit-testable with a stub. This module only measures and reports; it claims nothing and gates nothing.
// discoveryClaim stays false.

import type { LightCurve, LightCurvePoint } from "../core/types.ts";

/** A threshold-free classification of one TCE against the vetting battery (the PC/FP/FA split). */
export type TceClass = "PC" | "FP" | "FA";

/** Local deterministic PRNG (mulberry32), matching the convention in fap.ts so surrogates are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScrambleOptions {
  /** fixed seed -- scrambling must be reproducible for a byte-exact replay. */
  seed: number;
  /** "shuffle" permutes individual cadences (LEO-Vetter-style, flattens long-range structure);
   *  "block" permutes contiguous blocks so short-range AR(1) correlation survives (conservative variant). */
  mode?: "shuffle" | "block";
  /** block length in cadences, used only in "block" mode (default 8, like fap.ts). */
  blockLength?: number;
}

/**
 * Scramble a light curve's flux among its (unchanged) cadences, returning a FRESH curve; the input is never
 * mutated. Times are held fixed and the (flux, fluxErr) pairs move together, so the amplitude distribution --
 * scatter and outliers included -- is exactly preserved while no periodic transit can survive stacking.
 */
export function scrambleFlux(lc: LightCurve, opts: ScrambleOptions): LightCurve {
  const n = lc.points.length;
  const rand = prng(opts.seed);
  const pairs: LightCurvePoint[] = lc.points.map((p) => ({ ...p }));
  const mode = opts.mode ?? "shuffle";
  if (mode === "shuffle") {
    // Fisher-Yates over whole pairs so fluxErr stays glued to its flux.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const a = pairs[i]!;
      const b = pairs[j]!;
      pairs[i] = b;
      pairs[j] = a;
    }
  } else {
    // Block shuffle: cut into contiguous blocks, permute block ORDER (not intra-block points), so a single
    // block still carries the local noise memory while a curve-wide periodic dip no longer stacks.
    const block = Math.max(1, Math.min(opts.blockLength ?? 8, n));
    const blocks: LightCurvePoint[][] = [];
    for (let s = 0; s < n; s += block) blocks.push(pairs.slice(s, s + block));
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const a = blocks[i]!;
      const b = blocks[j]!;
      blocks[i] = b;
      blocks[j] = a;
    }
    let w = 0;
    for (const blk of blocks) for (const p of blk) pairs[w++] = p!;
  }
  // Re-attach the original cadence grid: flux values move, times do not.
  const out: LightCurvePoint[] = lc.points.map((origPoint, i) => ({ ...origPoint, flux: pairs[i]!.flux, fluxErr: pairs[i]!.fluxErr }));
  return { ...lc, points: out };
}

/** A minimal TCE record a detector callback returns (period + the statistic the gate is set on). */
export interface Tce {
  targetId: string;
  periodDays: number;
  /** the detection statistic used for the completeness / reliability sweep (e.g. BLS SNR or SDE). */
  stat: number;
  /** true when this TCE came from an injected planet (for completeness) rather than a scrambled null (for FA). */
  injected: boolean;
  /** the injected truth period, present only when injected -- a recovered TCE must alias-match it. */
  truthPeriodDays?: number;
  /** ground-truth astrophysical label (FP) when known; FA is inferred from the scrambled/injected flag. */
  class?: TceClass;
}

/** Detect a single TCE from a curve, or return null for no-detection. Injected so the module stays dependency-free. */
export type Detector = (lc: LightCurve) => { periodDays: number; stat: number } | null;

/**
 * Run a detector over the scrambled versions of a set of curves to collect a PLANET-FREE false-alarm TCE
 * population. One (or more) scramble per curve; each scramble destroys the transit but keeps the noise, so any
 * surviving peak is a false alarm by construction. Deterministic in `seedBase` (each curve seeds by index).
 */
export function collectScrambledTces(curves: LightCurve[], detect: Detector, opts: { seedBase: number; perCurve?: number; mode?: "shuffle" | "block" }): Tce[] {
  const perCurve = Math.max(1, Math.floor(opts.perCurve ?? 1));
  const tces: Tce[] = [];
  for (let c = 0; c < curves.length; c++) {
    const curve = curves[c]!;
    for (let k = 0; k < perCurve; k++) {
      const seed = opts.seedBase + c * 1000 + k;
      const hit = detect(scrambleFlux(curve, { seed, mode: opts.mode }));
      if (hit && Number.isFinite(hit.stat)) tces.push({ targetId: `${curve.targetId}#scram${k}`, periodDays: hit.periodDays, stat: hit.stat, injected: false });
    }
  }
  return tces;
}

/**
 * Accept a TCE if its statistic clears the threshold AND (when injected) it alias-matches the truth period within
 * `tolPct`. Mirrors the alias-tolerant recovery rule the pipeline already uses elsewhere.
 *
 * A scrambled (injected:false) peak that CLEARS the gate is classified PC, not FA -- that is the entire point of
 * the null: it is a candidate the vetting could not reject, so it counts against RELIABILITY downstream. Failing
 * the gate is what makes something FA. Returns the PC/FP/FA split used to score one threshold.
 */
export function classifyTces(tces: Tce[], threshold: number, tolPct = 2): TceClass[] {
  return tces.map((t) => {
    if (t.class === "FP") return "FP";
    if (!(t.stat >= threshold)) return "FA"; // fails the detection gate -> rejected as a false alarm
    if (t.injected) {
      const truth = t.truthPeriodDays;
      if (truth == null) return "PC";
      return isAliasWithinTol(t.periodDays, truth, tolPct) ? "PC" : "FA"; // injected but wrong period -> a false detection
    }
    return "PC"; // a scrambled peak that cleared the gate is a surviving candidate -> a false alarm for reliability
  });
}

function isAliasWithinTol(candidate: number, truth: number, tolPct: number): boolean {
  if (!Number.isFinite(candidate) || !Number.isFinite(truth) || candidate <= 0 || truth <= 0) return false;
  const ratio = candidate / truth;
  for (const f of [1, 0.5, 2, 1 / 3, 3, 2 / 3, 1.5, 3 / 2]) {
    if (Math.abs(ratio - f) / f * 100 <= tolPct) return true;
    if (Math.abs(1 / ratio - f) / f * 100 <= tolPct) return true;
  }
  return false;
}

/** Completeness C = injected TCEs classified PC / total injected TCEs. Null when there are no injected samples. */
export function completeness(tces: Tce[], classes: TceClass[]): number | null {
  let inj = 0;
  let pc = 0;
  for (let i = 0; i < tces.length; i++) {
    if (!tces[i]!.injected) continue;
    inj++;
    if (classes[i] === "PC") pc++;
  }
  return inj === 0 ? null : pc / inj;
}

/**
 * Reliability against false alarms R_FA = (candidates classified PC that are NOT false alarms) / (all PC). A
 * scrambled peak that survives the gate is a false alarm; a real injection recovered is not. Null when no PC.
 */
export function falseAlarmReliability(tces: Tce[], classes: TceClass[]): number | null {
  let pc = 0;
  let pcTrue = 0;
  for (let i = 0; i < tces.length; i++) {
    if (classes[i] !== "PC") continue;
    pc++;
    if (tces[i]!.injected) pcTrue++; // a PC that is a recovered injection is trustworthy; a scrambled PC is an FA
  }
  return pc === 0 ? null : pcTrue / pc;
}

/** The LEO-Vetter joint objective: minimise sqrt((1-C)^2 + (1-R_FA)^2). Either term null -> objective null. */
export function jointObjective(c: number | null, rFa: number | null): number | null {
  if (c == null || rFa == null) return null;
  return Math.hypot(1 - c, 1 - rFa);
}

export interface ThresholdSweepRow {
  threshold: number;
  c: number | null;
  rFa: number | null;
  objective: number | null;
}

/** Score a set of candidate thresholds against one labelled TCE pool, returning the C / R_FA / objective table. */
export function sweepThresholds(tces: Tce[], thresholds: number[], tolPct = 2): ThresholdSweepRow[] {
  return thresholds.map((threshold) => {
    const classes = classifyTces(tces, threshold, tolPct);
    const c = completeness(tces, classes);
    const rFa = falseAlarmReliability(tces, classes);
    return { threshold, c, rFa, objective: jointObjective(c, rFa) };
  });
}

/** Pick the threshold that minimises the joint objective among the rows that have both terms defined. */
export function optimizeThreshold(rows: ThresholdSweepRow[]): ThresholdSweepRow | null {
  let best: ThresholdSweepRow | null = null;
  for (const r of rows) {
    if (r.objective == null) continue;
    if (best == null || (best.objective != null && r.objective < best.objective)) best = r;
  }
  return best;
}
