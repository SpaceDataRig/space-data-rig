// Deterministic executors behind the LLM hypothesis loop (research; discovery roadmap P61).
//
// The model (src/ai/hypothesis.ts) only CHOOSES one of these whitelisted tests; the number it gets
// back is produced here by the pipeline's OWN vetting detectors, with no model involvement. That is
// the whole point of the closed loop: an LLM proposes, a deterministic measurement decides. Every
// executor is a thin, safe wrapper over an existing vetting function and maps the measured value to a
// planet-consistent / blend-consistent / inconclusive tag using thresholds that are stated inline so
// they are auditable. Nothing here touches the run pipeline, the bundle, a verdict, or any money path.

import { bls } from "./bls.ts";
import { shapeCoherence, foldedBoxDepth } from "./shapeCoherence.ts";
import { classifyDepthRegime } from "../candidate/falsePositive.ts";
import { oddEvenDepth, secondaryEclipse } from "./vetting.ts";
import { localizePsfDiff, judgePsfDiff } from "./psfDiffImaging.ts";
import type { PixelCube } from "./diffImaging.ts";
import type { LightCurve } from "../core/types.ts";
import type { DilutionResult } from "../data/gaiaDilution.ts";
import type { Prediction } from "../ai/hypothesis.ts";

export interface TestContext {
  lc: LightCurve;
  t0Bjd: number;
  periodDays: number;
  durationHours: number;
  /** optional target-pixel cube for the PSF localization test (a TargetPixelCube is structurally compatible). */
  cube?: PixelCube;
  /** optional pre-computed Gaia aperture dilution for the dilution test (the caller does the async fetch). */
  dilution?: DilutionResult;
  /** optional per-sector curves for the multi-sector phase-consistency test (the caller fetches each sector). */
  sectorLcs?: LightCurve[];
  /** optional pre-computed fraction [0,1] of the dip that SURVIVES common-mode (ensemble) subtraction. */
  commonModeResidualFrac?: number;
  /** optional pre-computed analytic blended-EB false-positive probability [0,1] (measured-Gaia prior). */
  blendPriorPfp?: number;
}

export interface TestOutcome {
  test: string;
  metricLabel: string;
  metric: number;
  /** what the DATA says (not the model): does this measurement look planet-consistent or blend-like? */
  outcome: Prediction;
  /** false when the test could not be judged (too few points / too few transits) -- never a failure. */
  determined: boolean;
  detail: string;
}

const undetermined = (test: string, label: string, detail: string): TestOutcome => ({
  test, metricLabel: label, metric: NaN, outcome: "inconclusive", determined: false, detail,
});

/**
 * Run the chosen deterministic test on real photometry. Returns an undetermined outcome (never throws)
 * on any input the detector cannot judge, so a bad model pick or a thin curve degrades honestly rather
 * than crashing the loop.
 */
export function runHypothesisTest(test: string, ctx: TestContext): TestOutcome {
  const { lc, t0Bjd, periodDays, durationHours } = ctx;
  try {
    switch (test) {
      case "bls-snr": {
        const b = bls(lc, { maxPeriodDays: Math.max(periodDays * 1.6, periodDays + 2) });
        const withinTol = Math.abs(b.periodDays - periodDays) / periodDays <= 0.05;
        const determined = Number.isFinite(b.snr) && lc.points.length >= 30;
        return {
          test, metricLabel: "re-detection SNR", metric: b.snr, determined,
          outcome: !determined ? "inconclusive" : b.snr >= 7 && withinTol ? "planet" : "inconclusive",
          detail: `BLS peak ${b.periodDays.toFixed(4)} d (claimed ${periodDays.toFixed(4)}, ${withinTol ? "within 5%" : "off by >5%"}), SNR ${b.snr.toFixed(1)}`,
        };
      }
      case "odd-even-depth": {
        const r = oddEvenDepth(lc, t0Bjd, periodDays, durationHours);
        if (!r.determined) return undetermined(test, "odd/even depth mismatch", "too few transits on one side to judge");
        return {
          test, metricLabel: "odd/even depth mismatch (frac)", metric: r.diffFrac, determined: true,
          outcome: r.diffFrac <= 0.3 ? "planet" : "blend",
          detail: `|odd-even|/mean depth = ${r.diffFrac.toFixed(2)} (odd ${r.depthOddPpt.toFixed(1)} ppt vs even ${r.depthEvenPpt.toFixed(1)} ppt)`,
        };
      }
      case "secondary-eclipse": {
        const s = secondaryEclipse(lc, t0Bjd, periodDays, durationHours);
        if (!s.determined) return undetermined(test, "secondary/primary depth ratio", "too few events to judge");
        return {
          test, metricLabel: "secondary/primary depth ratio", metric: s.ratio, determined: true,
          outcome: s.ratio < 0.2 ? "planet" : "blend",
          detail: `secondary/primary = ${s.ratio.toFixed(2)} (>=0.2 points to a stellar companion)`,
        };
      }
      case "shape-coherence": {
        const b = bls(lc, { maxPeriodDays: Math.max(periodDays * 1.6, periodDays + 2) });
        const c = shapeCoherence(lc, b);
        if (!Number.isFinite(c.ratio)) return undetermined(test, "folded shape coherence ratio", "ratio undefined on this curve");
        return {
          test, metricLabel: "folded shape coherence ratio", metric: c.ratio, determined: true,
          outcome: c.ratio >= 0.5 ? "planet" : c.ratio <= 0.2 ? "blend" : "inconclusive",
          detail: `median/mean depth = ${c.ratio.toFixed(2)} (near 1 = coherent box, near 0 = single-point spike)`,
        };
      }
      case "psf-localize": {
        if (!ctx.cube) return undetermined(test, "PSF double-difference offset (arcsec)", "no target-pixel cube supplied");
        const loc = localizePsfDiff(ctx.cube, t0Bjd, periodDays, durationHours, { bootstraps: 40, seed: 4242 });
        if (!loc || !loc.determined) return undetermined(test, "PSF double-difference offset (arcsec)", "localization not determined (no significant displaced source)");
        const cls = judgePsfDiff(loc, 2.0, { minAmpSnr: 5, minDeltaChi2: 9 }).classification;
        return {
          test, metricLabel: "PSF double-difference offset (arcsec)", metric: loc.offsetArcsec, determined: cls !== "inconclusive",
          outcome: cls === "off-target" ? "blend" : cls === "on-target" ? "planet" : "inconclusive",
          detail: `displaced source ${loc.offsetArcsec.toFixed(1)} arcsec from target, ampSnr ${loc.ampSnr.toFixed(1)}, deltaChi2 ${loc.deltaChi2.toFixed(0)} -> ${cls}`,
        };
      }
      case "gaia-dilution": {
        if (!ctx.dilution) return undetermined(test, "aperture dilution factor (host/total)", "no Gaia dilution supplied");
        const df = ctx.dilution.dilutionFactor;
        if (!Number.isFinite(df)) return undetermined(test, "aperture dilution factor (host/total)", "dilution factor undefined");
        return {
          test, metricLabel: "aperture dilution factor (host/total)", metric: df, determined: true,
          outcome: df >= 0.9 ? "planet" : df < 0.7 ? "blend" : "inconclusive",
          detail: `host fraction of aperture light = ${df.toFixed(3)} (< 0.7 = a resolved contaminant dilutes the signal)`,
        };
      }
      case "multisector-phase": {
        const secs = ctx.sectorLcs;
        if (!secs || secs.length < 2) return undetermined(test, "sectors confirming a dip at the same ephemeris", "fewer than 2 per-sector curves supplied");
        let nConfirm = 0;
        for (const s of secs) {
          const d = foldedBoxDepth(s, periodDays, t0Bjd, durationHours / 24);
          const depthPpm = d.depth * 1e6;
          if (Number.isFinite(depthPpm) && depthPpm >= 150 && classifyDepthRegime(depthPpm).planetPlausible) nConfirm++;
        }
        const frac = nConfirm / secs.length;
        return {
          test, metricLabel: "independent sectors confirming a dip (frac)", metric: frac, determined: true,
          outcome: nConfirm >= 2 ? "planet" : "blend",
          detail: `${nConfirm}/${secs.length} independent sectors show a planet-plausible dip at the SAME ephemeris (<2 = the signal is not phase-consistent across sectors)`,
        };
      }
      case "common-mode-residual": {
        const v = ctx.commonModeResidualFrac;
        if (!Number.isFinite(v)) return undetermined(test, "dip survival after common-mode subtraction", "no ensemble common-mode correction supplied");
        return {
          test, metricLabel: "dip survival after common-mode subtraction (frac)", metric: v as number, determined: true,
          outcome: (v as number) >= 0.7 ? "planet" : (v as number) <= 0.3 ? "blend" : "inconclusive",
          detail: `${((v as number) * 100).toFixed(0)}% of the dip survives removing the ensemble-common instrumental signal (low = a shared artifact, not a source)`,
        };
      }
      case "dilution-prior": {
        const v = ctx.blendPriorPfp;
        if (!Number.isFinite(v)) return undetermined(test, "blended-EB false-positive prior", "no analytic blend prior supplied");
        return {
          test, metricLabel: "blended-EB false-positive probability", metric: v as number, determined: true,
          outcome: (v as number) >= 0.5 ? "blend" : (v as number) <= 0.1 ? "planet" : "inconclusive",
          detail: "measured-Gaia analytic P(false positive = diluted blended EB) = " + (v as number).toFixed(2) + " (a prior, ranks candidates; never a verdict)",
        };
      }
      default:
        return undetermined(test, "(unknown test)", `test '${test}' is not in the executor menu`);
    }
  } catch (e) {
    return undetermined(test, "(executor error)", e instanceof Error ? e.message : String(e));
  }
}
