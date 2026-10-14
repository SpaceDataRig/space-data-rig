// CROWDING METRIC for a target (validation roadmap, priority 6 follow-up / blend-veto acceptance).
//
// A blended-EB veto tool only has to work where blends actually happen: crowded, low-galactic-latitude
// fields with many neighbours inside the (very wide, ~21") TESS aperture. To acceptance-test such a tool
// honestly we must first be able to SAY how crowded a given field is, and to stratify a validation sample
// across a crowding GRADIENT instead of testing only on bright isolated hosts (the gap a reviewer flagged:
// a synthetic pass and an uncrowded-host pass are not enough). This module computes that metric: the
// absolute galactic latitude |b| (a proxy for stellar density) and the number / nearest separation of
// Gaia neighbours inside the aperture. Pure + deterministic + no network; the data fetch is in
// scripts/p51-crowding-stratified.ts. Not imported by the runtime pipeline.

export interface GaiaNeighbor {
  gmag: number;
  sepArcsec: number;
}

/** ICRS equatorial -> galactic latitude b (degrees). NGP at (ra=192.85948, dec=27.12825). */
export function galacticLatitudeDeg(ra: number, dec: number): number {
  const d2r = Math.PI / 180;
  const raNGP = 192.85948 * d2r;
  const decNGP = 27.12825 * d2r;
  const a = ra * d2r;
  const d = dec * d2r;
  const sinB = Math.sin(d) * Math.sin(decNGP) + Math.cos(d) * Math.cos(decNGP) * Math.cos(a - raNGP);
  return Math.asin(Math.max(-1, Math.min(1, sinB))) / d2r;
}

export function absGalacticLatitude(ra: number, dec: number): number {
  return Math.abs(galacticLatitudeDeg(ra, dec));
}

/** Gaia neighbours whose separation from the target is within the photometric aperture. */
export function neighborsInAperture(neighbors: GaiaNeighbor[], apertureArcsec: number): GaiaNeighbor[] {
  return neighbors.filter((n) => Number.isFinite(n.sepArcsec) && n.sepArcsec >= 0 && n.sepArcsec <= apertureArcsec);
}

export type CrowdingBin = "isolated" | "moderate" | "crowded";

/**
 * Bucket by the number of neighbours in the aperture. Thresholds are a documented, adjustable convention
 * (isolated <= 1, moderate <= 4, crowded > 4) chosen so "crowded" means several potential contaminants in
 * the ~21" aperture -- the regime a blend veto must handle. Exposed so the caller can report the cut.
 */
export function crowdingBin(nInAperture: number, moderateMax = 4): CrowdingBin {
  if (nInAperture <= 1) return "isolated";
  if (nInAperture <= moderateMax) return "moderate";
  return "crowded";
}

export interface CrowdingMetric {
  absB: number; // |galactic latitude|, degrees (low b ~ dense disc)
  nInAperture: number; // Gaia neighbours within the aperture
  nearestSepArcsec: number; // nearest neighbour separation (Infinity if none)
  bin: CrowdingBin;
}

/** Full crowding description for one target from its position + Gaia neighbour list + aperture. */
export function crowdingOf(ra: number, dec: number, neighbors: GaiaNeighbor[], apertureArcsec: number, moderateMax = 4): CrowdingMetric {
  const inAp = neighborsInAperture(neighbors, apertureArcsec);
  const nearest = inAp.length ? Math.min(...inAp.map((n) => n.sepArcsec)) : Infinity;
  return {
    absB: +absGalacticLatitude(ra, dec).toFixed(3),
    nInAperture: inAp.length,
    nearestSepArcsec: Number.isFinite(nearest) ? +nearest.toFixed(3) : Infinity,
    bin: crowdingBin(inAp.length, moderateMax),
  };
}
