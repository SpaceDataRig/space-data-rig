// CROSS-SECTOR / MULTI-EPOCH CORROBORATION -- the structural false-positive lever the p23
// candidate-chain measurement pointed to.
//
// WHY THIS EXISTS. p23 (npm run p23:candidate-validation) measured the blind FFI candidate chain on real
// TGLC light curves and found a ~25% false-alarm rate that the per-candidate empirical-FAP gate barely
// reduced (25% -> 23%). The reason is load-bearing: calibratedFap's null ensemble only models each star's
// own RANDOM noise color, but the surviving false positives are COHERENT instrumental systematics -- a
// sector-common dip that lights up MANY unrelated hosts at one (period, epoch), and a one-off spike that
// is significant against its own noise yet is not a planet. A significance gate cannot touch those. The
// honest discriminator is REPEATABILITY: a real planet recurs at a coincident ephemeris on the SAME host
// across independent sectors, and its ephemeris is NOT shared by other hosts in the scan.
//
// WHAT THIS MODULE DOES. It applies four cumulative gates to a set of per-sector detections and reports
// how many distinct HOSTS survive each, so a completeness/false-alarm trade-off can be MEASURED rather
// than asserted (measure-before-gate). It deliberately does NOT decide accept/reject anywhere -- it is a
// quantifier that a research script drives.
//   L1  SNR + depth            -- already applied by the caller (the base candidate chain); we just count hosts.
//   L2  + empirical FAP <= thr  -- a stochastic-noise gate (keeps coherent systematics; the point of showing it).
//   L3  + reject multi-host ephemerides -- a (period, epoch) shared by >1 distinct host is a sector-common
//                                        systematic, not N planets, so the whole cluster is dropped.
//   L4  + require same-host recurrence -- a host survives only if one coincident ephemeris recurs on it in
//                                        >=2 independent sectors; this is what a single-sector spike cannot fake.
//
// PURE + DETERMINISTIC + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash /
// money path. Coincidence reuses foldedEpochDelta + DEFAULT_COINCIDENCE from ./dedup.ts so the cluster
// definition is byte-identical to the production candidate chain's collapse.

import { foldedEpochDelta, DEFAULT_COINCIDENCE, type CoincidenceOptions } from "./dedup.ts";

/** One detection: a single sector's blind BLS result for one host, tagged with the FAP-gate outcome. */
export interface SectorDetection {
  tic: number; // host identity (numeric); detections on the same host across sectors share it
  sector: number; // the TESS sector this curve came from (the independent-baseline axis)
  periodDays: number; // recovered period
  epochBjd: number; // recovered transit-center epoch (absolute BJD)
  fapPassed: boolean; // whether this detection cleared the empirical-FAP gate (layer L2)
}

/** Distinct surviving hosts at each cumulative layer (monotone non-increasing L1 >= L2 >= L3 >= L4). */
export interface LayerCounts {
  hostsL1: number; // base SNR+depth survivors
  hostsL2: number; // + empirical FAP
  hostsL3: number; // + reject multi-host shared ephemerides (sector-common systematic)
  hostsL4: number; // + require same-host recurrence across >=2 sectors (corroboration)
}

function usablePeriod(p: number): boolean {
  return Number.isFinite(p) && p > 0;
}

/** Ephemeris coincidence, identical tolerance to the production collapse (period within tol AND folded epoch within tol). */
function sameEphemeris(a: SectorDetection, b: SectorDetection, o: CoincidenceOptions): boolean {
  if (!usablePeriod(a.periodDays) || !usablePeriod(b.periodDays)) return false;
  const tol = o.periodTolPct / 100;
  if (Math.abs(a.periodDays - b.periodDays) / Math.min(a.periodDays, b.periodDays) > tol) return false;
  const avgP = (a.periodDays + b.periodDays) / 2;
  return foldedEpochDelta(a.epochBjd, b.epochBjd, avgP) <= o.t0TolDays;
}

/** Greedy single-link clusters (union-find) over detections sharing an ephemeris; deterministic by input order. */
function cluster(dets: SectorDetection[], o: CoincidenceOptions): SectorDetection[][] {
  const n = dets.length;
  const parent = dets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sameEphemeris(dets[i], dets[j], o)) union(i, j);
    }
  }
  const buckets = new Map<number, SectorDetection[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = buckets.get(root) ?? [];
    arr.push(dets[i]);
    buckets.set(root, arr);
  }
  return [...buckets.values()];
}

/**
 * Apply the four cumulative corroboration layers to a set of per-sector detections and return the number
 * of DISTINCT hosts surviving each. The input is assumed to already satisfy L1 (SNR + depth); this function
 * adds L2 (FAP), L3 (reject multi-host shared ephemerides), and L4 (require same-host cross-sector recurrence).
 */
export function applyLayerFilters(dets: SectorDetection[], o: CoincidenceOptions = DEFAULT_COINCIDENCE): LayerCounts {
  const hostsL1 = new Set(dets.map((d) => d.tic)).size;

  // L2: keep only detections that cleared the empirical-FAP gate.
  const l2 = dets.filter((d) => d.fapPassed);
  const hostsL2 = new Set(l2.map((d) => d.tic)).size;

  // L3: from the FAP survivors, drop any ephemeris cluster that spans MORE THAN ONE distinct host
  //     (a sector-common dip / window alias appearing on several stars is a data artifact, not planets).
  const l3Dets: SectorDetection[] = [];
  for (const cl of cluster(l2, o)) {
    const hosts = new Set(cl.map((d) => d.tic));
    if (hosts.size > 1) continue; // suspected common systematic -> reject the whole cluster
    l3Dets.push(...cl);
  }
  const hostsL3 = new Set(l3Dets.map((d) => d.tic)).size;

  // L4: from the single-host survivors, keep a host only if one coincident ephemeris recurs on it in >=2
  //     independent sectors. After L3 every remaining cluster is single-host, so this is a pure cross-sector test.
  const hostsL4Set = new Set<number>();
  for (const cl of cluster(l3Dets, o)) {
    const sectors = new Set(cl.map((d) => d.sector));
    if (sectors.size >= 2) for (const d of cl) hostsL4Set.add(d.tic);
  }
  const hostsL4 = hostsL4Set.size;

  return { hostsL1, hostsL2, hostsL3, hostsL4 };
}

/**
 * Count how many of the given detections correspond to a TRUE injected planet that still survives each layer
 * on its own host, so an INJECTED arm can report completeness alongside the false-alarm counts. A detection is
 * treated as matching truth if its period equals the injected period within the coincidence tolerance; the
 * layer reduction is then read off the same monotone host counts applyLayerFilters produces.
 *
 * This is a convenience for the measurement script: it forwards to applyLayerFilters for the counts, and
 * separately reports the per-layer surviving host set so the caller can intersect with a truth set.
 */
export function survivingHostsByLayer(
  dets: SectorDetection[],
  o: CoincidenceOptions = DEFAULT_COINCIDENCE,
): { l1: Set<number>; l2: Set<number>; l3: Set<number>; l4: Set<number> } {
  const l1 = new Set(dets.map((d) => d.tic));
  const l2Dets = dets.filter((d) => d.fapPassed);
  const l2 = new Set(l2Dets.map((d) => d.tic));
  const l3Dets: SectorDetection[] = [];
  for (const cl of cluster(l2Dets, o)) {
    const hosts = new Set(cl.map((d) => d.tic));
    if (hosts.size > 1) continue;
    l3Dets.push(...cl);
  }
  const l3 = new Set(l3Dets.map((d) => d.tic));
  const l4 = new Set<number>();
  for (const cl of cluster(l3Dets, o)) {
    const sectors = new Set(cl.map((d) => d.sector));
    if (sectors.size >= 2) for (const d of cl) l4.add(d.tic);
  }
  return { l1, l2, l3, l4 };
}

/**
 * L3 as an ACTIONABLE filter (not just a count). Given ephemeris groups already clustered by coincidence, split
 * them into INDEPENDENT candidates (a single host owns the ephemeris) versus SYSTEMATIC collapses (the same
 * (period, epoch) spans >1 distinct host -> a sector-common artifact, per the p26 measurement that dropping these
 * cuts the FAP-surviving false alarms ~52-63% at zero cost to single-host planets). The candidate chain emits the
 * independent set as follow-up rows and reports the systematic set only as a count, so a shared glitch is never
 * presented as a planet while the tally stays honest.
 */
export function partitionBySystematic<T extends { suspectedCommonSystematic: boolean }>(
  groups: T[],
): { independent: T[]; systematic: T[] } {
  const independent: T[] = [];
  const systematic: T[] = [];
  for (const g of groups) (g.suspectedCommonSystematic ? systematic : independent).push(g);
  return { independent, systematic };
}
