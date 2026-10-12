// CROSS-CANDIDATE EPHEMERIS COINCIDENCE COLLAPSE (discovery roadmap, Stage 4 -- false-positive control).
//
// WHY THIS EXISTS. The single-sector blind search (p19) can surface the SAME ephemeris -- identical
// period and identical epoch -- on several unrelated host stars. When that happens they are NOT several
// independent planets: it is a shared systematic leaking into every light curve of the sector (a
// sector-common dip picked by the crude "deepest cadence" epoch estimator, or a ~sector-length window
// alias of the BLS periodogram). Scaling out to more sectors WITHOUT collapsing these would just
// multiply one artifact into a thousand fake "candidates". So before any cross-sector aggregation we
// cluster candidates by ephemeris and flag any cluster that spans multiple distinct hosts as a suspected
// common systematic, reporting ONE representative plus the number of hosts that shared it.
//
// This is the honest inverse of a real detection: a genuine planet sits on ONE star; many stars lighting
// up at the exact same (period, epoch) is evidence about the DATA, not the sky. It never deletes anything
// silently -- the members are retained in the group and counted in the card.
//
// PURE + DI + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash / money path.

import type { CandidateRecord } from "./candidateRecord.ts";

export interface CoincidenceOptions {
  periodTolPct: number; // two periods are coincident if |dP|/min(P) is within this fraction (percent)
  t0TolDays: number; // epochs are coincident if their period-folded separation is within this many days
}

export const DEFAULT_COINCIDENCE: CoincidenceOptions = { periodTolPct: 0.5, t0TolDays: 0.05 };

export interface EphemerisGroup {
  members: CandidateRecord[]; // every candidate that clustered together (kept, not dropped)
  representative: CandidateRecord; // highest-SNR member, used for ranking / display
  distinctHosts: number; // how many different TICs share this ephemeris
  suspectedCommonSystematic: boolean; // >1 distinct host on one ephemeris -> a data artifact, not N planets
}

function minPositive(a: number, b: number): number {
  const lo = Math.min(a, b);
  return lo > 0 ? lo : Math.max(a, b);
}

/** Period-folded absolute separation between two epochs, wrapped to [0, P/2] (phase, not raw time). */
export function foldedEpochDelta(t0a: number, t0b: number, periodDays: number): number {
  if (!Number.isFinite(t0a) || !Number.isFinite(t0b) || !Number.isFinite(periodDays) || periodDays <= 0) return Infinity;
  const half = periodDays / 2;
  const x = ((((t0a - t0b) % periodDays) + periodDays) % periodDays); // normalize into [0, P)
  return x > half ? periodDays - x : x; // fold (P/2, P) back to (0, P/2]
}

function coincident(a: CandidateRecord, b: CandidateRecord, o: CoincidenceOptions): boolean {
  const pa = a.detection.periodDays;
  const pb = b.detection.periodDays;
  if (!Number.isFinite(pa) || !Number.isFinite(pb) || pa <= 0 || pb <= 0) return false;
  if (Math.abs(pa - pb) / minPositive(pa, pb) > o.periodTolPct / 100) return false;
  const avgP = (pa + pb) / 2;
  return foldedEpochDelta(a.detection.epochBjd, b.detection.epochBjd, avgP) <= o.t0TolDays;
}

function bySnrDesc(a: CandidateRecord, b: CandidateRecord): number {
  return (b.detection.snr ?? -Infinity) - (a.detection.snr ?? -Infinity);
}

/**
 * Cluster candidate records by ephemeris coincidence (greedy single-link over a deterministic order).
 * Records with an unusable period/epoch are left in singleton groups (never merged on garbage). Returns
 * groups sorted by representative SNR descending, each flagged whether it spans multiple distinct hosts.
 */
export function collapseCoincident(records: CandidateRecord[], o: CoincidenceOptions = DEFAULT_COINCIDENCE): EphemerisGroup[] {
  const sorted = [...records].sort(bySnrDesc);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (coincident(sorted[i], sorted[j], o)) union(i, j);
    }
  }
  const buckets = new Map<number, CandidateRecord[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    const arr = buckets.get(root) ?? [];
    arr.push(sorted[i]);
    buckets.set(root, arr);
  }
  const groups: EphemerisGroup[] = [];
  for (const members of buckets.values()) {
    const distinctHosts = new Set(members.map((m) => m.host.tic)).size;
    groups.push({
      members,
      representative: members.slice().sort(bySnrDesc)[0],
      distinctHosts,
      suspectedCommonSystematic: distinctHosts > 1,
    });
  }
  // order groups by their representative's SNR, best first
  groups.sort((a, b) => bySnrDesc(a.representative, b.representative));
  return groups;
}
