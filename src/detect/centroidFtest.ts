// A faithful re-port of eumemic's multi-sector centroid F-test (validation/centroid_sectors.md), which
// our P74 mis-described as a "same-direction coherence" test. This IS their statistic.
//
// METHOD (per the author, verified against their doc on 2026-10-15). Treat n per-sector difference-image
// centroid offsets (east/north arcsec) as scattered about the true source with a common, unknown spread.
// With mean offset m, hypothesised source offset s, and RSS the offsets' scatter about m (FLOORED at
// 1" per axis, because PRF fits carry ~1" systematic error), the statistic
//     F = ( n |m - s|^2 / 2 ) / ( RSS / (2(n-1)) )  =  n(n-1)|m - s|^2 / RSS
// follows F(2, 2(n-1)) if the source really is at s. Because df1 = 2 the survival has a closed form
//     p = ( 1 + F/(n-1) )^-(n-1)
// (no incomplete beta needed). The test is run for the TARGET (s = 0,0) and for every neighbouring star
// bright enough to cause the dip (s = that star's offset). Needs n >= 2 sectors; offsets beyond 60" are
// failed fits and dropped. A target is REJECTED at small p (the offsets are inconsistent with the star);
// a neighbouring star "fits" at large p (its predicted offset explains the mean).
//
// Pure + offline + deterministic; NOT wired into any verdict / bundle hash / money path. Research only.

export interface Offset {
  east: number; // arcsec east of target, in the sector pixel frame
  north: number; // arcsec north of target
}

export interface CentroidFtestResult {
  testable: boolean; // false if fewer than 2 usable sectors
  nUsed: number;
  nDropped: number; // sectors dropped for offset > maxOffsetArcsec / non-finite
  meanEast: number;
  meanNorth: number;
  rss: number; // floored residual sum of squares (both axes)
  F: number;
  df1: number; // always 2
  df2: number; // 2(n-1)
  p: number; // survival P(F_{2,2(n-1)} >= observed): reject s when small
}

/**
 * Run eumemic's multi-sector centroid F-test of the observed offsets against a hypothesised source at
 * offset `s`. `floorArcsec` is the per-axis scatter floor (default 1"), `maxOffsetArcsec` drops failed
 * fits (default 60"). Returns p for the hypothesis "the source is at s".
 */
export function centroidFtest(
  offsets: Offset[],
  s: Offset,
  opts: { floorArcsec?: number; maxOffsetArcsec?: number } = {},
): CentroidFtestResult {
  const floor = opts.floorArcsec ?? 1;
  const maxOff = opts.maxOffsetArcsec ?? 60;
  const kept = offsets.filter((o) => Number.isFinite(o.east) && Number.isFinite(o.north) && Math.hypot(o.east, o.north) <= maxOff);
  const n = kept.length;
  const dropped = offsets.length - n;
  const base: CentroidFtestResult = {
    testable: false, nUsed: n, nDropped: dropped,
    meanEast: NaN, meanNorth: NaN, rss: NaN, F: NaN, df1: 2, df2: 2 * (n - 1), p: 1,
  };
  if (n < 2) return base;
  const meanEast = kept.reduce((a, o) => a + o.east, 0) / n;
  const meanNorth = kept.reduce((a, o) => a + o.north, 0) / n;
  let sEast = 0;
  let sNorth = 0;
  for (const o of kept) {
    sEast += (o.east - meanEast) ** 2;
    sNorth += (o.north - meanNorth) ** 2;
  }
  // floor each axis's scatter so a perfectly consistent (zero-spread) set does not blow F to infinity;
  // the minimum per-axis sum of squares is (n-1)*floor^2.
  const rss = Math.max(sEast, (n - 1) * floor * floor) + Math.max(sNorth, (n - 1) * floor * floor);
  const d2 = (meanEast - s.east) ** 2 + (meanNorth - s.north) ** 2;
  const F = (n * (n - 1) * d2) / rss;
  const p = Math.pow(1 + F / (n - 1), -(n - 1));
  return { testable: true, nUsed: n, nDropped: dropped, meanEast, meanNorth, rss, F, df1: 2, df2: 2 * (n - 1), p };
}

/** Convenience: test the offsets against the TARGET hypothesis (source at 0,0). Reject when p < alpha. */
export function targetCentroidP(offsets: Offset[], opts: { floorArcsec?: number; maxOffsetArcsec?: number } = {}): CentroidFtestResult {
  return centroidFtest(offsets, { east: 0, north: 0 }, opts);
}

/**
 * Brightness gate: does a neighbour of T-magnitude `tMagStar` (target `tMagTarget`) have enough flux that
 * a TOTAL eclipse of it, diluted by the target, reaches the observed depth `depthFrac`? A full eclipse of
 * the neighbour dims it to 0, so the observed dip is F_star/(F_star+F_target); require that >= depthFrac.
 */
export function neighbourCanCauseDip(depthFrac: number, tMagStar: number, tMagTarget: number): boolean {
  if (!(depthFrac > 0 && depthFrac < 1)) return false;
  if (!Number.isFinite(tMagStar) || !Number.isFinite(tMagTarget)) return false;
  const requiredRatio = depthFrac / (1 - depthFrac); // F_star / F_target needed for a full eclipse to reach depth
  const fluxRatio = Math.pow(10, 0.4 * (tMagTarget - tMagStar));
  return fluxRatio >= requiredRatio;
}
