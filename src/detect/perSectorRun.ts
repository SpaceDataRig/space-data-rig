// PRODUCTION-READY per-sector ROBUST depth (roadmap item 8 wiring, used by src/cf/workflow.ts).
//
// The workflow calls this ONLY when env.PERSECTOR === "1"; with the flag unset the scout step is
// byte-for-byte unchanged (this module is simply never invoked), so the bundle hash / money path
// are untouched until an operator deliberately enables it in a safe deploy window.
//
// It implements the recipe p12/p14 proved robust on real long-period planets: characterise EACH
// sector locally (fold at the candidate ephemeris + fit the exact limb-darkened depth) and take the
// robust MEDIAN across sectors, rather than trusting one stitched long fold. It reuses only
// already-tested primitives -- foldAtPhase + fitExactTransit (transitFit), Kepler a/Rs (transitModel),
// and combineSectorFits (perSector) -- and the light-curve fetch is injected so the logic is unit-
// testable OFFLINE with no network. It degrades to null (caller keeps the original depth) whenever
// fewer than `minUsable` sectors can be characterised, so it can never turn a real detection into a
// bogus number.

import { foldAtPhase, fitExactTransit } from "./transitFit.ts";
import { aOverRsFromKepler, mainSequenceMassFromRadius } from "../sim/transitModel.ts";
import { combineSectorFits, type CombinedEstimate, type SectorFit } from "./perSector.ts";
import type { LightCurve } from "../core/types.ts";

export interface PerSectorDepthArgs {
  tic: number;
  sectors: number[];
  label: string;
  periodDays: number; // candidate period (from OUR blind scout, not the catalogue)
  epochBjd: number; // candidate epoch
  starRadiusRsun: number; // host radius -> Kepler a/Rs
  minUsable?: number; // default 2 sectors needed to trust the median
  maxSectors?: number; // cap sectors fetched per target (cost), default 6
  minInWindow?: number; // per-sector fit guard, default 15 (matches p9/p11)
  fetchSector: (tic: number, sector: number, label: string) => Promise<LightCurve | null>;
}

/** Fit ONE sector at the candidate ephemeris and report its local depth. */
function fitOneSector(lc: LightCurve, a: PerSectorDepthArgs): SectorFit {
  const guard = { depthFrac: NaN, ok: false };
  try {
    const pts = lc.points;
    if (pts.length < 30) return guard;
    const times = pts.map((p) => p.time);
    const flux = pts.map((p) => p.flux);
    const mass = mainSequenceMassFromRadius(a.starRadiusRsun);
    const aOverRs = aOverRsFromKepler(a.periodDays, mass, a.starRadiusRsun);
    const folded = foldAtPhase(times, flux, a.periodDays, a.epochBjd);
    const fit = fitExactTransit(folded, { aOverRs, t0Window: 0.02 });
    const minWin = a.minInWindow ?? 15;
    if (!Number.isFinite(fit.depthFrac) || fit.depthFrac <= 0 || fit.nInWindow < minWin) return guard;
    return { depthFrac: fit.depthFrac, ok: true };
  } catch {
    return guard;
  }
}

/**
 * Robust per-sector depth for one candidate. Returns null when it cannot characterise at least
 * `minUsable` sectors -- the caller then keeps its existing single-fit depth (safe fallback).
 */
export async function robustPerSectorDepth(a: PerSectorDepthArgs): Promise<CombinedEstimate | null> {
  const cap = a.maxSectors ?? 6;
  const sectors = a.sectors.slice(0, cap);
  if (sectors.length === 0 || !Number.isFinite(a.starRadiusRsun) || a.starRadiusRsun <= 0) return null;
  const fits: SectorFit[] = [];
  for (const s of sectors) {
    const lc = await a.fetchSector(a.tic, s, a.label).catch(() => null);
    if (!lc) continue;
    fits.push(fitOneSector(lc, a));
  }
  const est = combineSectorFits(fits);
  return est.nUsable >= (a.minUsable ?? 2) ? est : null;
}
