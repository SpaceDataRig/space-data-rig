// OCCURRENCE-RATE KERNEL -- the Poisson/selection arithmetic that turns "what a survey sees" into "what a
// population contains", and the forward-model consistency test that checks a pipeline's yield against the field's
// published rates WITHOUT pretending to measure a rate from a tiny, biased sample.
//
// WHY (authority roadmap, priority 5). An occurrence rate eta (planets per star over a radius/period box) is the
// single most-quoted number a transit survey produces, and getting it right is the difference between an instrument
// and a detector. The honest relation is
//     E[N_det] = N_stars * eta * S,        S = < geometric transit prob * detection completeness > over the box,
// so a survey that has MEASURED its selection S (our real P47 completeness grid x real geometry) can either
//   (a) INVERT a detection count into an eta +- Poisson CI (etaFromCounts), or
//   (b) FORWARD-MODEL the expected detections from a published eta and check that its own yield is consistent
//       (expectedYield + consistencyZ) -- the discipline this project can actually afford on a small, biased sample.
// We deliberately do NOT publish an inverted eta as a measurement: our target set is bright planet-bearing hosts
// (the P47 grid says so in its own meta), and a selection function built on a biased sample cannot support a rate.
// What we CAN do, defensibly, is show the kernel is correctly wired and that the pipeline's real recovered-planet
// yield agrees with the field's anchor rate (Gillis et al. 2025/2026, AJ, cumulative 1.10 +- 0.16 for R>1 R_earth
// inside 30 d) to within Poisson/box-overlap uncertainty. This module is pure arithmetic -- no network, no detector,
// nothing wired into a verdict / bundle hash / money path; discoveryClaim stays false.

/** Poisson-observation Gehrels (1986) 1-sigma (68.27%) confidence interval on a measured count n. */
export function gehrelsInterval(n: number): [number, number] {
  if (!Number.isFinite(n) || n < 0) return [NaN, NaN];
  // Gehrels' closed-form for the 68.27% interval around an observed Poisson count.
  const lo = n > 0 ? n * (1 - 1 / (9 * n) - 1.2815516 / (3 * Math.sqrt(n))) ** 3 : 0.115;
  const hi = (n + 1) * (1 - 1 / (9 * (n + 1)) + 1.2815516 / Math.sqrt(9 * (n + 1))) ** 2;
  return [lo, hi];
}

/**
 * Invert a detection count into a rate per star given the survey selection S (in (0,1]) and the number of stars.
 * eta = n / (N * S), with the Poisson uncertainty on n propagated linearly (the S and N uncertainties are added by
 * the caller as a separate multiplicative term). Returns null for an impossible configuration.
 */
export function etaFromCounts(o: { nDetections: number; nStars: number; selection: number }):
  { eta: number; lo: number; hi: number } | null {
  const { nDetections: n, nStars: N, selection: S } = o;
  if (!(N > 0) || !(S > 0) || S > 1 || !Number.isFinite(n) || n < 0) return null;
  const eta = n / (N * S);
  const [lo, hi] = gehrelsInterval(n);
  return { eta, lo: lo / (N * S), hi: hi / (N * S) };
}

/**
 * Forward-model the expected number of detections for a published rate: E[N] = N_stars * eta * S. The reference eta
 * may carry a symmetric uncertainty (refSigma, same units as refEta); it is carried through as the prediction band
 * [E - N*S*refSigma, E + N*S*refSigma] so the caller can widen the expectation by the literature error.
 */
export function expectedYield(o: { nStars: number; refEta: number; refSigma?: number; selection: number }):
  { expected: number; bandLo: number; bandHi: number } | null {
  const { nStars: N, refEta: eta, selection: S } = o;
  const refSigma = o.refSigma ?? 0;
  if (!(N > 0) || !(S > 0) || !(eta >= 0) || !(refSigma >= 0)) return null;
  const expected = N * eta * S;
  const half = N * S * refSigma;
  return { expected, bandLo: Math.max(0, expected - half), bandHi: expected + half };
}

/**
 * Standardised consistency score between an observed count and a Poisson expected yield: how many sigmas apart,
 * using the symmetric Gehrels half-width on the observation and the Poisson spread on the expectation. |z| < ~2 is
 * "consistent"; this is a two-sided check, not a detection claim.
 */
export function consistencyZ(observed: number, expected: number): { z: number; note: string } {
  if (!Number.isFinite(observed) || !(expected >= 0)) return { z: NaN, note: "undefined" };
  const [lo, hi] = gehrelsInterval(observed);
  const sigmaObs = Math.max((hi - lo) / 2, Math.sqrt(expected), 1); // at least Poisson on the expectation
  const z = (observed - expected) / sigmaObs;
  const band = Math.abs(z) < 1 ? "within 1 sigma (consistent)" : Math.abs(z) < 2 ? "within 2 sigma (consistent)" : Math.abs(z) < 3 ? "2-3 sigma (tension)" : "beyond 3 sigma (inconsistent)";
  return { z, note: `observed ${observed} vs expected ${expected.toFixed(2)}: ${z.toFixed(2)} sigma, ${band}` };
}
