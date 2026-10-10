// Pure, runtime-agnostic seat compute shared by the Node Orchestrator and the
// Cloudflare RigRunWorkflow.
//
// Each function takes plain data and returns plain data -- no store, no event
// emitter, no filesystem, no bindings. The driver on each runtime keeps its own
// side effects (Node: RigStore + fs; Workers: RigStateDO + R2) and its own event
// formatting, while the *science* stays identical across both paths. This is what
// lets one bundle hash be reproducible whether produced locally or on the edge.

import { detectTransit, type DetectionResult } from "../detect/pipeline.ts";
import {
  assessSignal,
  estimateNoisePpm,
  type ConfidenceOptions,
  type ConfidenceResult,
  type SignalParams,
} from "../sim/confidence.ts";
import { reviewCandidate, type ReviewResult } from "../critic/review.ts";
import { mainSequenceMassFromRadius } from "../sim/transitModel.ts";
import { narrateFinding } from "../reporter/narrate.ts";
import { foldedPlotSVG, periodogramSVG, timeSeriesPlotSVG } from "../detect/svgPlot.ts";
import {
  canonicalJson,
  composeBundle,
  sha256Hex,
  type ComposedBundle,
  type EphemerisRecord,
  type InMemoryArtifact,
} from "../bundle/bundle.ts";
import type { ArchivePlanet, Finding, LightCurve } from "../core/types.ts";

const encoder = new TextEncoder();

/** SHA-256 over a canonical projection of the light curve (data provenance hash). */
export async function computeDataHash(lc: LightCurve): Promise<string> {
  return sha256Hex(
    canonicalJson({
      targetId: lc.targetId,
      cadenceSec: lc.cadenceSec,
      n: lc.points.length,
      // round to keep the hash stable across float formatting
      points: lc.points.map((p) => [Number(p.time.toFixed(6)), Number(p.flux.toFixed(9))]),
    }),
  );
}

/** anomaly-scout: BLS transit search + odd-even alias resolution. */
export function scout(lc: LightCurve): DetectionResult {
  return detectTransit(lc, { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 });
}

export interface SimulateInput {
  lc: LightCurve;
  detection: DetectionResult;
  planet: ArchivePlanet;
  index: number;
  confidenceTrials: number;
}

export interface SimulateOutput {
  confidence: ConfidenceResult;
  ephemeris: EphemerisRecord;
  noisePpm: number;
}

/**
 * The fully-resolved recipe for the sim-runner's injection-recovery study: the
 * signal to re-inject, its epoch, the robust noise floor, and the Monte-Carlo
 * options (deterministic seed + trial count). Returned as plain data so the Cloudflare
 * workflow can persist it and feed `recoveryTrial`/`combineTrials` step-by-step while
 * reproducing EXACTLY the Node `simulate`/`assessSignal` result (hash parity).
 */
export interface SimPlan {
  signal: SignalParams;
  epochBjd: number;
  noisePpm: number;
  options: ConfidenceOptions;
}

/**
 * Derive the sim-runner plan from a detection. This resolves every default (noise
 * floor, cadence, baseline, seed) once, up front, so both drivers agree on the
 * numbers before any trial runs.
 */
export function simPlan({ lc, detection, planet, index, confidenceTrials }: SimulateInput): SimPlan {
  const c = detection.candidate;
  const noisePpm = estimateNoisePpm(detection.clean);
  const signal: SignalParams = {
    periodDays: c.periodDays,
    depthFrac: Math.max(1e-6, c.depthFrac),
    stellarRadiusRsun: planet.st_rad ?? 1,
    stellarMassMsun: planet.st_mass ?? mainSequenceMassFromRadius(planet.st_rad ?? 1), // catalog mass; empirical M-R only as fallback
    noisePpm,
    cadenceSec: lc.cadenceSec ?? 120,
    baselineDays: 27,
  };
  const options: ConfidenceOptions = { nTrials: confidenceTrials, seed: 5000 + index * 31 };
  return { signal, epochBjd: c.epochBjd, noisePpm, options };
}

/** sim-runner: targeted injection-recovery confidence + forward ephemeris prediction. */
export function simulate(input: SimulateInput): SimulateOutput {
  const plan = simPlan(input);
  const confidence = assessSignal(plan.signal, plan.epochBjd, input.detection.clean, plan.options);
  const ephemeris: EphemerisRecord = {
    t0Bjd: plan.epochBjd,
    periodDays: input.detection.candidate.periodDays,
    nextTransitsBjd: confidence.nextTransitsBjd,
  };
  return { confidence, ephemeris, noisePpm: plan.noisePpm };
}

export interface CritiqueInput {
  detection: DetectionResult;
  catalog: ArchivePlanet[];
  hostName?: string;
  confidence?: ConfidenceResult;
  truthPeriodDays?: number;
}

/** mission-critic: defensible verdict + per-check results + composite score. */
export function critique({ detection, catalog, hostName, confidence, truthPeriodDays }: CritiqueInput): ReviewResult {
  return reviewCandidate({
    candidate: detection.candidate,
    aliasMultiple: detection.aliasMultiple,
    catalog,
    hostName,
    confidence,
    truthPeriodDays,
    minSnr: 7,
  });
}

export interface ReportInput {
  lc: LightCurve;
  detection: DetectionResult;
  confidence?: ConfidenceResult;
  review: ReviewResult;
  ephemeris?: EphemerisRecord;
  findingId: string;
  runId: string;
  codeVersion: string;
  catalogSource?: string;
  dataHash?: string;
  lightCurveSource?: string;
}

export interface ReportOutput {
  finding: Finding;
  composed: ComposedBundle;
  artifacts: InMemoryArtifact[];
}

/**
 * reporter: build the Finding, render the three SVG plots in memory, compose the
 * reproducible bundle manifest + hash, and attach the narration. Returns plain data
 * only -- the caller persists artifacts (Node fs / Workers R2) and updates state.
 *
 * Hash parity with the previous inline implementation is preserved: the manifest is
 * built from the same fields (candidate numbers, verdict, checks, provenance) and the
 * same UTF-8 artifact bytes, and canonicalJson sorts keys, so the bundle hash is
 * unchanged. The data hash (timestamp-free) is identical across runtimes.
 */
export async function report(input: ReportInput): Promise<ReportOutput> {
  const { lc, detection, review } = input;
  const c = detection.candidate;

  const finding: Finding = {
    id: input.findingId,
    targetId: lc.targetId,
    candidate: c,
    verdict: review.verdict,
    verdictReason: review.reason,
    crossmatch: review.crossmatch,
    recoveryConfidence: input.confidence?.confidence,
    score: review.score,
    ephemeris: input.ephemeris,
    createdAt: new Date().toISOString(),
  };

  const svgFolded = foldedPlotSVG(c.folded ?? [], { title: `${lc.targetId} - folded @ P=${c.periodDays.toFixed(4)}d` });
  const svgPeriod = periodogramSVG(detection.bls.periodGrid, { title: `${lc.targetId} - BLS periodogram` });
  const svgTime = timeSeriesPlotSVG(
    detection.clean.points.map((p) => ({ time: p.time, flux: p.flux })),
    detection.model,
    { title: `${lc.targetId} - light curve + transit model` },
  );
  const artifacts: InMemoryArtifact[] = [
    { name: "folded.svg", bytes: encoder.encode(svgFolded) },
    { name: "periodogram.svg", bytes: encoder.encode(svgPeriod) },
    { name: "timeseries.svg", bytes: encoder.encode(svgTime) },
  ];

  // manifest is composed BEFORE bundleHash/narration are set on the finding, exactly
  // as the prior inline reporter did -- the manifest never includes those fields.
  const composed = await composeBundle({
    finding,
    runId: input.runId,
    codeVersion: input.codeVersion,
    catalogSource: input.catalogSource,
    lightCurveHash: input.dataHash,
    lightCurveSource: input.lightCurveSource,
    ephemeris: input.ephemeris,
    aliasMultiple: detection.aliasMultiple,
    checks: review.checks,
    artifacts,
  });

  finding.bundleHash = composed.hash;
  const narration = narrateFinding(finding);
  finding.narration = { headline: narration.headline, explainer: narration.explainer };

  return { finding, composed, artifacts };
}
