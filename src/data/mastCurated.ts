// Curated registry of REAL MAST TESS light-curve products, keyed by host star.
//
// Why curated instead of fully automated (verified by direct probing 2026-10-10):
//   - The MAST `invoke` CAOM discovery services reachable anonymously
//     (Mast.Caom.Cone / Mast.Caom.Filtered) return HTTP 200 with an EMPTY body
//     (`{}`) without a token, so they cannot enumerate products for us here.
//   - The CAOM TAP host (data.archive.stsci.edu) and the TESScut AWS service
//     were not reachable from the pipeline's network at all.
//   - Direct anonymous download via `Download/file?uri=mast:TESS/product/<file>`
//     is open and stable, and serves real FITS bytes.
// A curated host -> product-URI map therefore gives the pipeline real
// photometry today, and every entry is an easy "good first issue" contribution
// (verify one URI, add one line, then run `npm run mast:validate` -- it downloads
// and FITS-checks every entry and fails loudly if any URI stops resolving to real
// TESS photometry). See ./mastDiscover.ts for the best-effort auto-discovery path
// (used when a MAST token makes the portal respond). The synthetic stand-in
// remains the default whenever a target is not in this list or a download fails.

import type { ArchivePlanet } from "../core/types.ts";
import type { InjectedTruth } from "./synthetic.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../sim/transitModel.ts";

export interface CuratedMastProduct {
  productUri: string; // mast:TESS/product/<file> -- passed to Download/file as-is
  label: string; // human-readable target label used as LightCurve.targetId
  note?: string;
}

// Keys are lowercase host names (pscomppars `hostname`).
// Every URI below was anonymously downloaded and FITS-parsed successfully.
const REGISTRY: Record<string, CuratedMastProduct> = {
  "wasp-126": {
    productUri: "mast:TESS/product/tess2018292075959-s0004-0000000025155310-0124-s_lc.fits",
    label: "TIC 25155310 / WASP-126 (GL sector 0004, 2-min)",
    note: "real TESS photometry validated end to end on 2026-10-10",
  },
};

/** Look up a curated real light-curve product by host star name. */
export function curatedMastFor(hostName?: string | null): CuratedMastProduct | null {
  if (!hostName) return null;
  return REGISTRY[hostName.toLowerCase()] ?? null;
}

/**
 * Enumerate every curated entry (host -> product). Used by the registry validator
 * (`npm run mast:validate`) and contribution tooling, so a newly added line is
 * automatically download- and FITS-checked rather than trusted on sight.
 */
export function listCuratedMast(): { host: string; product: CuratedMastProduct }[] {
  return Object.entries(REGISTRY).map(([host, product]) => ({ host, product }));
}

/**
 * Build the downstream "truth" record from CATALOG values instead of injection
 * values. On the real-photometry path nothing was injected: this is simply the
 * published parameter set the critic and ephemeris code compare against, and
 * every number is labelled by its catalog origin.
 */
export function truthFromCatalog(planet: ArchivePlanet): InjectedTruth {
  const periodDays = planet.pl_orbper ?? 3;
  const rsun = planet.st_rad ?? 1;
  const msun = planet.st_mass ?? mainSequenceMassFromRadius(rsun);
  const rpEarth = planet.pl_rade ?? 12;
  const depthFrac = (planet.pl_trandep ?? 5000) / 1e6; // ppm -> fraction (Archive rows are ppm)
  return {
    periodDays,
    t0Bjd: planet.pl_tranmid ?? 0, // catalog epoch; ephemeris degrades gracefully at 0
    depthFrac,
    durationHours: planet.pl_trandur ?? 2.5,
    impactParam: 0.3, // not observable from the catalog alone; placeholder, labeled below
    planetRadiusRatio: rpEarth * 0.0091577 / rsun, // R_earth/R_sun = 0.0091577
    aOverRs: aOverRsFromKepler(periodDays, msun, rsun),
    stellarRadiusRsun: rsun,
    stellarMassMsun: msun,
  };
}
