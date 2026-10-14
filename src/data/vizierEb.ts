// VizieR eclipsing-binary access (validation roadmap P52 -- building a labelled NEGATIVE class).
//
// A veto tool's TRUE power (catching real blends) can only be acceptance-tested against a labelled negative
// class: real off-target eclipsing binaries at known positions. This module codifies token-free access to the
// General Catalogue of Variable Stars (B/gcvs) on VizieR, which returns REAL variables with decimal J2000
// positions, a variability type (VarType; eclipsing binaries are the "E*" classes) and a period. The parse is
// offline-testable against a captured VOTABLE fixture; the live fetch is in scripts/p52-negative-class.ts.
//
// Honest scope note (measured in P52): the VizieR LIST query works anonymously, but the CONE query returned
// empty even for a guaranteed match (Algol) through this endpoint, and GCVS is bright-star-only, so placing a
// catalogued EB inside a specific TESS ~21" host aperture is rare. This module therefore exposes BOTH the list
// and cone builders + a robust parser so the negative class is one call away once a working positional lookup
// (or an ExoFOP-TESS token) is available. Pure parsing + URL building; no verdict/bundle/money path.

export interface EbEntry {
  name: string;
  ra: number; // deg (J2000)
  dec: number; // deg (J2000)
  varType: string; // GCVS variability class; eclipsing binaries start with "E"
  periodDays: number | null;
}

const VOTABLE = "https://vizier.cds.unistra.fr/viz-bin/votable";
const GCVS = "B/gcvs";

/** List query (works anonymously): returns the first maxRows GCVS entries with positions + period. */
export function buildEbListUrl(maxRows = 2000): string {
  return `${VOTABLE}?-source=${GCVS}&-out.max=${maxRows}&-out.add=_RAJ2000,_DEJ2000,VarType,Period`;
}

/** Cone query around a position (radius in arcMIN). NOTE: measured empty through the anonymous endpoint. */
export function buildEbConeUrl(ra: number, dec: number, radiusArcmin: number): string {
  return `${VOTABLE}?-source=${GCVS}&-c=${ra}%20${dec}&-c.rs=${radiusArcmin}&-c.eq=J2000&-out.max=200&-out.add=_RAJ2000,_DEJ2000,VarType,Period`;
}

/**
 * Parse a GCVS VOTABLE into EbEntry[]. The response concatenates several sub-tables; only the main one has
 * decimal-deg RA/Dec as the first two columns, so a row is kept only when col0/col1 parse as finite numbers
 * and col0 is a plausible RA in [0,360). Columns follow the FIELD order _RAJ2000,_DEJ2000,VarType,Period.
 */
export function parseEbVotable(text: string): EbEntry[] {
  const out: EbEntry[] = [];
  for (const block of text.split("<TR").slice(1)) {
    const cells = [...block.matchAll(/<TD[^>]*>([^<]*)<\/TD>/g)].map((m) => m[1].trim());
    if (cells.length < 6) continue;
    const ra = Number(cells[0]);
    const dec = Number(cells[1]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90) continue;
    const varType = cells[2] ?? "";
    const period = Number(cells[3]);
    const name = cells[5] || cells[4] || `GCVS@${ra.toFixed(3)}`;
    out.push({ name, ra, dec, varType, periodDays: Number.isFinite(period) && period > 0 ? period : null });
  }
  return out;
}

/** Keep only eclipsing binaries (GCVS classes EA / EB / EW / and their subtypes, all begin with "E"). */
export function eclipsingOnly(entries: EbEntry[]): EbEntry[] {
  return entries.filter((e) => /^E[A-Z0-9]*/i.test(e.varType));
}
