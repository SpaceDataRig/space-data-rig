// 2-D COMPLETENESS GRID (period x depth) with honest binomial confidence intervals -- the
// detection-efficiency object an occurrence-rate calculation actually needs (validation roadmap,
// priority 4).
//
// WHY A GRID, NOT A CURVE. scripts/p1-real-completeness.ts and p33-scale-roc.ts report completeness
// MARGINALLY -- recovery vs depth, or vs period, one at a time. But the number of planets you can
// find around a star depends on the JOINT (period, depth) surface: a 300 ppm dip at 3 days and the
// same dip at 20 days are not equally recoverable. Turning detections into rates (eta_earth) means
// dividing by a per-(period,depth) detection efficiency, so we need the 2-D map, each cell with an
// honest error bar, plus the depth at which each period bin crosses 50% completeness.
//
// HONEST INTERVALS. Per-cell counts are binomial (k recovered out of n injected). We use the Wilson
// score interval, not the naive normal approximation, because grid cells are often small and the
// naive interval gives nonsense negative bounds or zero-width at k=0. A k=0 cell still gets a real
// upper bound -- "we saw none" is not "there are none".
//
// PURE + DETERMINISTIC + NO NETWORK. This module only BINS trials that a caller measured (see
// scripts/p47-completeness-grid.ts, which injects into REAL light curves). Nothing here runs a
// detector or touches the runtime pipeline / verdict / bundle hash / money path.

export interface Trial {
  periodDays: number;
  depthPpm: number;
  recovered: boolean;
}

export interface GridCell {
  periodIndex: number;
  depthIndex: number;
  periodLo: number;
  periodHi: number;
  depthLo: number;
  depthHi: number;
  n: number; // injections in this cell
  k: number; // recovered
  completeness: number; // k / n (NaN if n == 0)
  ciLow: number; // Wilson 95% lower bound
  ciHigh: number; // Wilson 95% upper bound
}

/**
 * Wilson score interval for a binomial proportion at the given z (default 1.96 ~ 95%). Returns
 * [0, 1] for n == 0 (total ignorance). Robust at k == 0 and k == n, where the naive normal interval
 * collapses or leaves [0,1].
 */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (!(n > 0)) return [0, 1];
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  // at k==n the Wilson upper bound is exactly 1; snap it (float round-off otherwise yields 0.9999...).
  const hi = k >= n ? 1 : Math.min(1, centre + half);
  return [Math.max(0, centre - half), hi];
}

/** Bin a trial into [periodIndex, depthIndex] using ascending edges; returns null if out of range. */
function binIndex(edges: number[], v: number): number {
  for (let i = 0; i < edges.length - 1; i++) {
    if (v >= edges[i] && v < edges[i + 1]) return i;
  }
  return -1;
}

/**
 * Bin trials into a period x depth grid. `periodEdges` and `depthEdges` are ascending bin boundaries
 * (length P+1 and D+1); trials outside any bin are dropped and counted in `outside`. Every cell is
 * emitted (including empty ones, completeness NaN) so the map is rectangular and renderable.
 */
export function binCompleteness(
  trials: Trial[],
  periodEdges: number[],
  depthEdges: number[],
): { cells: GridCell[]; periodEdges: number[]; depthEdges: number[]; used: number; outside: number } {
  const P = periodEdges.length - 1;
  const D = depthEdges.length - 1;
  const counts = Array.from({ length: P * D }, () => ({ n: 0, k: 0 }));
  let used = 0;
  let outside = 0;
  for (const t of trials) {
    const pi = binIndex(periodEdges, t.periodDays);
    const di = binIndex(depthEdges, t.depthPpm);
    if (pi < 0 || di < 0) {
      outside++;
      continue;
    }
    used++;
    const c = counts[pi * D + di];
    c.n++;
    if (t.recovered) c.k++;
  }
  const cells: GridCell[] = [];
  for (let pi = 0; pi < P; pi++) {
    for (let di = 0; di < D; di++) {
      const { n, k } = counts[pi * D + di];
      const [lo, hi] = wilsonInterval(k, n);
      cells.push({
        periodIndex: pi,
        depthIndex: di,
        periodLo: periodEdges[pi],
        periodHi: periodEdges[pi + 1],
        depthLo: depthEdges[di],
        depthHi: depthEdges[di + 1],
        n,
        k,
        completeness: n > 0 ? k / n : NaN,
        ciLow: n > 0 ? lo : NaN,
        ciHigh: n > 0 ? hi : NaN,
      });
    }
  }
  return { cells, periodEdges, depthEdges, used, outside };
}

/**
 * For each period bin, the smallest depth whose point completeness reaches `target`, found by linear
 * interpolation between the bracketing depth-bin centres (or null if the bin never reaches target).
 * This is the "detection threshold curve" an occurrence analysis needs.
 */
export function thresholdDepthAt(grid: { cells: GridCell[]; periodEdges: number[]; depthEdges: number[] }, target = 0.5): { periodIndex: number; periodLo: number; periodHi: number; depthPpm: number | null }[] {
  const P = grid.periodEdges.length - 1;
  const D = grid.depthEdges.length - 1;
  const out: { periodIndex: number; periodLo: number; periodHi: number; depthPpm: number | null }[] = [];
  for (let pi = 0; pi < P; pi++) {
    let crossing: number | null = null;
    let prevC = -Infinity;
    let prevCentre = NaN;
    for (let di = 0; di < D; di++) {
      const cell = grid.cells[pi * D + di];
      const c = cell.n > 0 ? cell.completeness : -1; // treat empty cells as a gap, not 0
      const centre = (cell.depthLo + cell.depthHi) / 2;
      if (c >= target) {
        if (prevC < 0 || !Number.isFinite(prevCentre)) crossing = centre;
        else crossing = prevCentre + ((target - prevC) / (c - prevC)) * (centre - prevCentre);
        break;
      }
      if (c >= 0) {
        prevC = c;
        prevCentre = centre;
      }
    }
    out.push({ periodIndex: pi, periodLo: grid.periodEdges[pi], periodHi: grid.periodEdges[pi + 1], depthPpm: crossing });
  }
  return out;
}
