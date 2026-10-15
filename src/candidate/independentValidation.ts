// INDEPENDENT VALIDATION core predicate (audit finding 9, gap 3: "at least one external candidate
// independently validated").
//
// The prior 0/2 external-candidate result was STRUCTURAL: the P65 critic audits an outside claim while
// deliberately running the detector with an EMPTY catalog, so an unconfirmed claim can never self-corroborate
// and honestly caps at needs-more-data. That is the correct safety behaviour, but it means the project had no
// demonstrated path to INDEPENDENTLY VALIDATE an external claim at all.
//
// This module supplies the one clean, non-circular validation relation: a claim is INDEPENDENTLY CONFIRMED when
// our detector -- which was never shown the claim's ephemeris and searched periods blind -- produces a signal that
// (a) recurs in at least `minCorroboration` INDEPENDENT sectors and (b) matches the claim's period within a tight
// tolerance. The two paths (external claim vs our blind raw-pixel corroboration) are independent, so agreement is
// genuine confirmation, not the detector parroting the input. This is a mechanism/positive-control result for
// known-planet claims and a first independent check for still-uncertain candidate-planet claims; it is NOT a
// discovery claim. Pure + deterministic + offline-testable; never imported by the runtime (no bundle hash).

export interface BlindDetection {
  periodDays: number; // recovered by a BLIND search (the claim's period was not given to the detector)
  corroboratedSectors: number; // number of independent sectors in which this period recurred
}

export interface ExternalClaim {
  id: string; // e.g. "TOI 1234.01" or "TIC 370612437"
  periodDays: number; // the claimed period (used only to JUDGE agreement, never to detect)
  disposition: string; // KP (known planet) | CP (candidate planet) | other -- the claim's external status
}

export interface ConfirmationResult {
  validated: boolean;
  relPeriodDiff: number; // |recovered - claimed| / claimed
  reason: string;
}

/**
 * Decide whether a blind, corroboration-gated detection independently confirms an external claim.
 * - minCorroboration (default 2): the recovered period must appear in >= this many independent sectors.
 * - periodTolFrac (default 0.02): agreement window on the period.
 * Guards non-finite inputs (a claim or detection without a usable period can never be validated).
 */
export function independentlyConfirmed(
  d: BlindDetection,
  claim: ExternalClaim,
  opts: { minCorroboration?: number; periodTolFrac?: number } = {},
): ConfirmationResult {
  const minCorr = opts.minCorroboration ?? 2;
  const tol = opts.periodTolFrac ?? 0.02;
  if (!Number.isFinite(d.periodDays) || d.periodDays <= 0 || !Number.isFinite(claim.periodDays) || claim.periodDays <= 0) {
    return { validated: false, relPeriodDiff: NaN, reason: "missing a usable period (detector or claim)" };
  }
  const rel = Math.abs(d.periodDays - claim.periodDays) / claim.periodDays;
  if (d.corroboratedSectors < minCorr) {
    return { validated: false, relPeriodDiff: rel, reason: `blind detection corroborated in only ${d.corroboratedSectors} sector(s) (< ${minCorr})` };
  }
  if (rel > tol) {
    return { validated: false, relPeriodDiff: rel, reason: `recovered period off by ${(rel * 100).toFixed(1)}% (> ${(tol * 100).toFixed(0)}%)` };
  }
  return { validated: true, relPeriodDiff: rel, reason: `blind detection at ${(d.corroboratedSectors)} independent sectors reproduces the claim within ${(rel * 100).toFixed(2)}%` };
}
