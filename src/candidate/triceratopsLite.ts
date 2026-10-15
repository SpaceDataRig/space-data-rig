// TRICERATOPS-LITE validation helpers (audit finding 9 gap 3, "make the CP independent validation closer to
// TRICERATOPS grade"). P80 moved external-candidate validation off 0/2 with a BLIND, non-circular corroboration
// match, but its residual weakness -- quantified in P78 -- is ALIAS risk (period-only 2-sector corroboration is
// only ~47% precise) and un-modelled blends. TRICERATOPS attacks exactly those two: a per-target blend EB
// false-positive probability (fed here by a real Gaia neighbour census) and harmonic aliasing. This module holds
// the small pure, offline-testable pieces; the network script (scripts/p81-triceratops-lite.ts) supplies the
// measured inputs (Gaia contrasts, per-sector centroid F-test p, the P78 empirical false-coincidence base).
//
// It is deliberately NOT a reimplementation of TRICERATOPS proper (that needs space-to-ground tables + limb-
// darkening + dilution-corrected radius posteriors). It is a defensible first-order grade-up of our validation:
// blend FPP + dilution + explicit alias accounting, with every assumption stated. Research only; no runtime
// import, so no bundle hash / verdict / money path. discoveryClaim stays false.

/** Flux ratios (F_neighbour / F_target) of every star in the aperture, brightest contaminant first. */
export function neighborContrasts(hostGmag: number, neighborGmags: number[]): number[] {
  return neighborGmags
    .filter((g) => Number.isFinite(g))
    .map((g) => Math.pow(10, -0.4 * (g - hostGmag)))
    .filter((c) => c > 0)
    .sort((a, b) => b - a);
}

/** Observed (diluted) depth corrected by the aperture dilution factor: a real blend host is deeper than seen. */
export function dilutionCorrectedDepthPpm(observedDepthPpm: number, dilutionFactor: number): number {
  if (!Number.isFinite(observedDepthPpm) || !(dilutionFactor > 0 && dilutionFactor <= 1)) return observedDepthPpm;
  return observedDepthPpm / dilutionFactor;
}

// Harmonic ratios that produce the classic BLS period aliases (half / double / third / 3-over-2 ...).
const ALIAS_RATIOS = [2, 3, 1 / 2, 1 / 3, 3 / 2, 2 / 3];

/**
 * Count how many OTHER corroborated peaks of the same host sit at a simple harmonic of `period` -- each is an
 * alternative period the blind search could equally have chosen, i.e. residual alias ambiguity. `peaks` are the
 * host's corroborated cluster periods; `tolFrac` is the relative match window. Self (ratio 1) is excluded.
 */
export function countHarmonicSiblings(period: number, peaks: number[], tolFrac = 0.05): number {
  if (!(period > 0)) return 0;
  let n = 0;
  for (const p of peaks) {
    if (!(p > 0) || p === period) continue;
    const r = p / period;
    for (const a of ALIAS_RATIOS) {
      if (Math.abs(r - a) / a <= tolFrac) { n++; break; }
    }
  }
  return n;
}

export type AliasLevel = "low" | "moderate" | "high";

export interface AliasRiskInput {
  harmonicSiblings: number; // count from countHarmonicSiblings
  falseCoincidenceBase: number // empirical P78 rate: 1 - accepted precision (~0.53 at the 2-sector bar)
  centroidOnTarget: boolean | null; // multi-sector centroid F-test agrees the light is on-target (null = not measured)
  blendFpp: number; // daveBlendedFpp from the real Gaia census
}

/**
 * Fold the three independent discriminants into one honest alias-risk grade. No single number is a validated FPP;
 * this is a documented, monotone ranking: siblings and blends raise risk, an on-target centroid lowers it.
 * A candidate is only "low" when it is a unique corroborated period, the blend FPP is small, AND the centroid
 * test does not reject the target. Anything unmeasured is treated conservatively (cannot upgrade to low).
 */
export function aliasRiskLevel(i: AliasRiskInput): { level: AliasLevel; note: string } {
  const reasons: string[] = [];
  let score = 0;
  if (i.harmonicSiblings > 0) { score += Math.min(2, i.harmonicSiblings); reasons.push(`${i.harmonicSiblings} harmonic sibling peak(s)`); }
  if (i.blendFpp >= 0.01) { score += 2; reasons.push(`blend FPP ${i.blendFpp.toFixed(3)}`); }
  else if (i.blendFpp >= 1e-3) { score += 1; reasons.push(`blend FPP ${i.blendFpp.toExponential(1)}`); }
  if (i.centroidOnTarget === false) { score += 2; reasons.push("centroid F-test rejects target (off-source)"); }
  else if (i.centroidOnTarget === true) { reasons.push("centroid on-target"); }
  else { score += 2; reasons.push("centroid not measured (unverified)"); }
  // the empirical base rate caps how "low" anything can honestly be at our current sensitivity
  if (i.falseCoincidenceBase >= 0.4) score += 1;
  const level: AliasLevel = score <= 1 ? "low" : score <= 2.5 ? "moderate" : "high";
  return { level, note: reasons.join("; ") || "clean" };
}
