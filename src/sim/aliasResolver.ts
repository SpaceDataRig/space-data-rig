// Period-alias resolver via the odd-even (per-epoch transit) test.
// BLS on short baselines often peaks at P/2 or P/3 because few transits stack.
// Power comparison can't fix this (the alias can score HIGHER). The standard
// astronomical fix: measure the transit depth at each candidate epoch spaced by
// Pb; if dips occur only every m-th epoch, the true period is m*Pb.

import { median } from "../detect/detrend.ts";

export interface AliasResult {
  period: number;
  epoch: number;
  multiple: number; // 1 = no alias, 2 = was P/2, 3 = was P/3
  perEpochDepth: (number | null)[]; // depth at each Pb-spaced epoch (for UI/debug)
  nEpochs: number;
}

/**
 * @param times  observation times (BJD)
 * @param flux   normalized flux (out-of-transit ~ 1)
 * @param period candidate period from BLS (possibly an alias)
 * @param epoch  a transit center time for that candidate
 * @param durationDays transit duration (days) to define the in-transit window
 * @param baselineDays total time span (to bound epoch count)
 */
export function resolvePeriodAlias(
  times: number[],
  flux: number[],
  period: number,
  epoch: number,
  durationDays: number,
  baselineDays?: number,
  maxMultiple = 3,
): AliasResult {
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const _baseline = baselineDays ?? tMax - tMin; // kept for the caller-provided baselineDays arg wiring; not used in this fold
  const halfWin = Math.max(durationDays / 2, (times[1] - times[0]) * 1.5);

  const depthAt = (tc: number): number | null => {
    const inWin: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (Math.abs(times[i] - tc) <= halfWin) inWin.push(flux[i]);
    }
    if (inWin.length < 3) return null;
    return 1 - median(inWin); // positive => a dip
  };

  // Anchor epoch to the first transit at/after tMin
  const kStart = Math.ceil((tMin - epoch) / period);
  const t0 = epoch + kStart * period;
  const K = Math.floor((tMax - t0) / period) + 1;
  const depths: (number | null)[] = [];
  for (let k = 0; k < K; k++) depths.push(depthAt(t0 + k * period));

  const valid = depths.filter((d): d is number => d != null);
  if (valid.length < 3) {
    return { period, epoch: t0, multiple: 1, perEpochDepth: depths, nEpochs: K };
  }
  const dmax = Math.max(...valid);
  if (dmax <= 0) {
    return { period, epoch: t0, multiple: 1, perEpochDepth: depths, nEpochs: K };
  }
  const thresh = 0.4 * dmax;
  const dip = depths.map((d) => d != null && d > thresh);

  let bestM = 1;
  for (let m = 1; m <= maxMultiple; m++) {
    let onCorrect = 0;
    let onTotal = 0;
    let offWrong = 0;
    let offTotal = 0;
    for (let k = 0; k < K; k++) {
      if (depths[k] == null) continue;
      if (k % m === 0) {
        onTotal++;
        if (dip[k]) onCorrect++;
      } else {
        offTotal++;
        if (dip[k]) offWrong++;
      }
    }
    const onFrac = onTotal ? onCorrect / onTotal : 0;
    const offFrac = offTotal ? offWrong / offTotal : 1;
    if (onTotal >= 2 && onFrac >= 0.7 && offFrac <= 0.35) {
      bestM = m;
      break;
    }
  }

  return {
    period: period * bestM,
    epoch: t0,
    multiple: bestM,
    perEpochDepth: depths,
    nEpochs: K,
  };
}
