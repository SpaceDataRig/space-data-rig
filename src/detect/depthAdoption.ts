// DEPTH ADOPTION GUARD (audit b1, 2026-10-18).
//
// WHAT THIS DECIDES. The scout measures a transit depth one way (the BLS box: a step-function fit over the
// folded curve, and the SNR is computed from exactly that depth and the out-of-box scatter). When
// PERSECTOR=1, the workflow can replace it with a second measurement: a limb-darkened shape fit performed
// locally in each sector and taken as a robust median. Two independent estimators agreeing is evidence; one
// silently replacing the other is not, and the replacement was previously unconditional.
//
// WHY UNCONDITIONAL ADOPTION IS WRONG, MEASURED ON LIVE DATA. Of 90 published findings, 84 carried a
// depthPpt/depthFrac pair that disagreed, and the disagreement was not mild. KELT-24 b -- a catalogued hot
// Jupiter, so its depth is independently known -- had a box depth of 6100 ppm and a published depth of 38 ppm,
// a factor of 159. Its quoted SNR of 252.5 over 40 in-transit points implies a per-point noise of 153 ppm if
// the 6100 ppm depth is the one that was detected (a normal TESS bright-star noise) and 0.96 ppm if the 38 ppm
// depth is (below the instrument's photon floor -- not physical). The record therefore contained its own
// refutation: the SNR described the box depth while the published number was the fitted one. The same
// contradiction made a frontend card say "the star's brightness dips by about 38 parts per million" about a
// transit two hundred times deeper.
//
// THE RULE, AND WHY IT IS THE SAFE ONE. Adopt the per-sector median only when it is within
// DEPTH_ADOPTION_MAX_FACTOR of the depth the detection was measured and gated on. Outside that band, keep the
// box depth and say so: a shape fit that disagrees with the box by more than a factor of five is not refining
// it, it is measuring something else -- a wrong ephemeris drifting across sectors, a diluting blend, a
// duration prior mismatch, or a fit onto noise. Refusing to adopt in that case never invents a number; the
// conservative failure mode is the depth the pipeline already proved detectable. This mirrors the guard the
// per-sector module documents for itself ("it degrades to null ... so it can never turn a real detection into a
// bogus number") -- which only held while the estimate stayed sane, because the caller did not check.
//
// THE CAP ON ITS OWN DID NOT FIX THE CLASS, AND WAS MEASURED FAILING WITHIN MINUTES. After this bound shipped,
// five records adopted a per-sector depth and all five still quoted the SNR the box had produced: TOI-1978.01
// published 2784 ppm beside SNR 109, whose own significance on the same scatter is 29.4. Capping the swap at 5x
// had made the contradiction smaller without removing it, because swapping a depth silently re-prices the
// significance of the record. So the decision is applied as a SET (applyDepthDecision): both depth
// representations, the surviving estimator's label, the refused estimate, and an SNR recomputed for the depth
// actually published. The search's own statistic is preserved as `detectionSnr`, because the >= 7 floor and the
// calibrated false-alarm ensemble are distributions of the BOX statistic and must stay in those units -- the
// gate sees exactly the number it always saw, and no verdict moves.
//
// PURE: no I/O, no clock, no network. Both verdicts are pinned by tests/depth-adoption.test.ts.
import type { TransitCandidate } from "../core/types.ts";

/** Largest ratio between the two estimators that still counts as a refinement rather than a different measurement. */
export const DEPTH_ADOPTION_MAX_FACTOR = 5;

export type DepthSource = "bls-box" | "per-sector-median";

export interface DepthAdoptionDecision {
  /** The depth the record should carry. */
  depthFrac: number;
  depthSource: DepthSource;
  /** The depth the detector measured and the detection was gated on, kept even when not published. */
  boxDepthFrac: number;
  adopted: boolean;
  /** Why an estimate was refused, or the agreement factor when it was not. Never empty: silence is not a decision. */
  reason: string;
}

function positiveFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/**
 * Decide which depth a candidate should publish. `box` is what the detection was gated on; `estimate` is the
 * per-sector median, or null/undefined when the estimator declined to produce one (fewer than minUsable
 * sectors characterisable), which is the module's own documented degradation and is always safe.
 */
export function decideDepthAdoption(
  boxDepthFrac: number,
  estimateDepthFrac: number | null | undefined,
  maxFactor: number = DEPTH_ADOPTION_MAX_FACTOR,
): DepthAdoptionDecision {
  if (!positiveFinite(boxDepthFrac)) {
    // Nothing to compare against, so NOTHING may be adopted. Observed on the live rig minutes after this guard
    // shipped (TOI-1487.01, 06:33Z): the box landed on a BUMP, depth <= 0, while the shape fit offered a
    // positive 46 ppm. "No comparison possible" is not the same as "adoption is safe" -- publishing the fitted
    // number there would assert a transit the detector's own measurement denies, which is the exact failure this
    // module exists to prevent. Keep what was measured, record what was offered, say why.
    return { depthFrac: boxDepthFrac, depthSource: "bls-box", boxDepthFrac, adopted: false, reason: "the scout did not measure a positive depth, so a per-sector fit has nothing to refine and was not adopted" };
  }
  if (!positiveFinite(estimateDepthFrac)) {
    return { depthFrac: boxDepthFrac, depthSource: "bls-box", boxDepthFrac, adopted: false, reason: "no usable per-sector depth was produced; kept the depth the detection was measured on" };
  }
  const factor = estimateDepthFrac / boxDepthFrac;
  const agree = factor >= 1 / maxFactor && factor <= maxFactor;
  const x = factor >= 1 ? factor : 1 / factor;
  if (!agree) {
    return {
      depthFrac: boxDepthFrac,
      depthSource: "bls-box",
      boxDepthFrac,
      adopted: false,
      reason: `per-sector depth ${estimateDepthFrac * 1e6} ppm differs from the box depth ${boxDepthFrac * 1e6} ppm by ${x.toFixed(1)}x, beyond the ${maxFactor}x adoption bound, so the fitted depth was refused`,
    };
  }
  return {
    depthFrac: estimateDepthFrac,
    depthSource: "per-sector-median",
    boxDepthFrac,
    adopted: true,
    reason: `per-sector depth agrees with the box depth within ${x.toFixed(2)}x`,
  };
}

/**
 * Apply a decision to a candidate and keep every published number describing the SAME transit.
 *
 * WHY THIS IS A FUNCTION AND NOT A FEW ASSIGNMENTS AT THE CALL SITE. Three relations hold by definition and the
 * workflow used to break all of them: `depthPpt = depthFrac * 1000` (the same quantity in different units),
 * `blsBoxDepthFrac` surviving whatever was published, and `snr = depthFrac / noiseSigmaFrac * sqrt(nIn)`.
 * The last one is the reason an adopted refinement cannot simply be dropped into `depthFrac`: the scatter and the
 * in-transit count are properties of the fold, so replacing the depth silently re-prices the significance. On the
 * live rig, five records adopted a per-sector depth and ALL FIVE then quoted an SNR computed on the box -- 3.7x
 * apart on TOI-1978.01 (SNR 109 next to a 2784 ppm depth whose own significance is 29). The cap alone did not fix
 * the class of defect; it only made the contradiction smaller.
 *
 * So the SNR is rescaled to the depth being published (sigma and nIn unchanged, which is exactly
 * `snr' = snr * depth'/depth`), and the search's own statistic is preserved in `detectionSnr` -- the number the
 * >= 7 floor and the calibrated FAP ensemble are measured in, since both are distributions of the BOX statistic.
 * Rescaling is only done when the box depth is positive, i.e. when the algebra is meaningful; a bump record keeps
 * its negative depth and negative SNR together. Any future depth update that goes through anything other than
 * this helper is a bug; tests/depth-adoption.test.ts pins all three relations.
 */
export function applyDepthDecision(c: TransitCandidate, decision: DepthAdoptionDecision, estimateDepthFrac: number | null | undefined): TransitCandidate {
  if (Number.isFinite(c.snr) && !Number.isFinite(c.detectionSnr)) c.detectionSnr = c.snr;
  const box = decision.boxDepthFrac;
  const searchSnr = Number.isFinite(c.detectionSnr) ? (c.detectionSnr as number) : c.snr;
  c.depthFrac = decision.depthFrac;
  c.depthPpt = decision.depthFrac * 1000;
  c.depthSource = decision.depthSource;
  c.blsBoxDepthFrac = box;
  if (positiveFinite(box) && Number.isFinite(searchSnr)) c.snr = searchSnr * (decision.depthFrac / box);
  if (positiveFinite(estimateDepthFrac)) c.perSectorDepthFrac = estimateDepthFrac;
  return c;
}

/** The statistic the search gated on, falling back to the published SNR on records that predate the split. */
export function detectionSnrOf(c: TransitCandidate): number {
  return Number.isFinite(c.detectionSnr) ? (c.detectionSnr as number) : c.snr;
}

/**
 * The two estimators a record carries, as estimate/box. Null when the record has only one measurement. Below 1
 * the shape fit came out shallower than the box, above 1 deeper -- and the published `depthFrac` is whichever of
 * the two the guard accepted, so a reader who sees only that number can still ask how far the other one was.
 */
export function depthEstimatorRatio(c: TransitCandidate): number | null {
  if (!positiveFinite(c.perSectorDepthFrac) || !positiveFinite(c.blsBoxDepthFrac)) return null;
  return c.perSectorDepthFrac / c.blsBoxDepthFrac;
}
