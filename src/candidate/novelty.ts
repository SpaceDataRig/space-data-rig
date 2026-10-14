// NOVELTY DISPOSITION for a blind-search candidate (validation roadmap, priority 5 prerequisite).
//
// A candidate being "not yet announced" is a factual, checkable statement -- but it is NOT the same as
// "we found a planet." This module answers the narrow, honest question: given a candidate position /
// TIC / period and a list of catalog entries (TOI rows and confirmed-planet rows fetched from the NASA
// Exoplanet Archive), has ANYONE already announced a transit signal at or near this location, and does
// any such announcement share our period? It reports a DISPOSITION, never a discovery claim.
//
// The interpretation that keeps this honest lives in the caller/report: an ABSENCE of any TOI at a deep,
// single-sector, neighbouring-TIC-pair signal is evidence the signal is a FALSE POSITIVE (the TESS
// pipeline itself did not flag a credible transit here), not evidence of a hidden new planet.
//
// PURE + DETERMINISTIC + NO NETWORK. The network fetch is in scripts/p48-novelty-check.ts; this only
// matches already-fetched rows. Not imported by the runtime pipeline; no verdict/bundle hash/money path.

export interface SkyPos {
  ra: number; // degrees
  dec: number; // degrees
}

export type CatalogKind = "toi" | "confirmed";

export interface CatalogEntry {
  label: string; // e.g. "TOI-1011.01" or "TOI-1011 b"
  kind: CatalogKind;
  ra: number;
  dec: number;
  tic?: number; // host TIC when the row carries one
  periodDays?: number; // reference period when available
}

export interface CandidatePos {
  tic: number;
  ra: number;
  dec: number;
  periodDays: number;
}

export interface MatchOptions {
  /** neighbours within this angular radius count as "at this location" (default 30 arcsec). */
  radiusArcsec?: number;
  /** relative period window for calling an announcement the SAME signal (default 0.02 = 2%). */
  periodTolFrac?: number;
}

export interface CatalogMatch {
  entry: CatalogEntry;
  sepArcsec: number;
  sameTic: boolean;
  withinRadius: boolean;
  samePeriod: boolean;
}

export interface Disposition {
  announced: boolean; // any catalog row at the same TIC or within radius
  samePeriodAnnounced: boolean; // an announcement that also matches our period -> almost certainly the SAME signal
  novelLocation: boolean; // nothing announced at/near this position
  nearestLabel: string | null;
  nearestSepArcsec: number | null;
  nMatches: number;
  discoveryClaim: false; // structurally never a discovery
}

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Great-circle (haversine) angular separation in arcsec between two ICRS positions. */
export function angularSeparationArcsec(a: SkyPos, b: SkyPos): number {
  const dDec = toRad(a.dec - b.dec);
  const dRa = toRad(a.ra - b.ra);
  const s =
    Math.sin(dDec / 2) ** 2 +
    Math.cos(toRad(a.dec)) * Math.cos(toRad(b.dec)) * Math.sin(dRa / 2) ** 2;
  const angDeg = (2 * Math.asin(Math.min(1, Math.sqrt(s))) * 180) / Math.PI;
  return angDeg * 3600;
}

/**
 * Find catalog rows that are the same host (matching TIC) or a sky neighbour (within radius). Rows
 * outside both are ignored. Each match records whether its period also agrees with the candidate.
 */
export function findMatches(cand: CandidatePos, entries: CatalogEntry[], opts: MatchOptions = {}): CatalogMatch[] {
  const radius = opts.radiusArcsec ?? 30;
  const tol = opts.periodTolFrac ?? 0.02;
  const out: CatalogMatch[] = [];
  for (const e of entries) {
    const sepArcsec = angularSeparationArcsec(cand, e);
    const sameTic = e.tic != null && e.tic === cand.tic;
    const withinRadius = sepArcsec <= radius;
    if (!sameTic && !withinRadius) continue;
    const samePeriod =
      e.periodDays != null && cand.periodDays > 0 &&
      Math.abs(e.periodDays - cand.periodDays) / cand.periodDays <= tol;
    out.push({ entry: e, sepArcsec, sameTic, withinRadius, samePeriod });
  }
  return out;
}

/**
 * Summarise a candidate against its catalog matches. `novelLocation` is true only when NOTHING is
 * announced at or near the position; it is a statement about the catalogs, NOT a claim of a planet.
 */
export function disposition(cand: CandidatePos, entries: CatalogEntry[], opts: MatchOptions = {}): Disposition {
  const matches = findMatches(cand, entries, opts);
  let nearest: CatalogMatch | null = null;
  for (const m of matches) if (!nearest || m.sepArcsec < nearest.sepArcsec) nearest = m;
  return {
    announced: matches.length > 0,
    samePeriodAnnounced: matches.some((m) => m.samePeriod),
    novelLocation: matches.length === 0,
    nearestLabel: nearest ? nearest.entry.label : null,
    nearestSepArcsec: nearest ? +nearest.sepArcsec.toFixed(3) : null,
    nMatches: matches.length,
    discoveryClaim: false,
  };
}
