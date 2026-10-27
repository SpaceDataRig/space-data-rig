# P34 measured compute / cost model (scaling the survey)

Grounded in reports/p33-catalog.json (204 real TESS-SPOC curves). Re-fit every run; nothing hardcoded.

## Detector cost scaling (measured)

Least-squares power-law fit of perCurveMs vs nPoints (log-log):

| quantity | value |
|---|---|
| exponent p (perCurveMs ~ nPoints^p) | 2.873 |
| coefficient k (ms) | 9.482e-7 |
| R^2 (log-log) | 0.788 |
| sample N | 204 |
| reference baseline | <=2 sectors, mean 2649 pts/star |
| measured single-star survey detection (null arm) | 2.26 s |
| cost of doubling the baseline (f=2) | ~7.33x |

The near-cubic exponent (p ~= 2.87) is the central engineering fact: BLS over a fine period
grid is superlinear in the point count, the iterative mask-and-refind re-runs it per signal, so the lever
that raises completeness (deeper baselines => more sectors => more points) is priced ~nPoints^p. R^2 =
0.79 on N=204 is an empirical scaling for THIS detector + period grid, not a universal law;
treat extrapolations as order-of-magnitude planning figures, and re-fit after any detector/grid change.

## Survey CPU-hours (detection only; download/parse excluded)

Rows = survey size, columns = stitched sectors per star. surveyCPU = N * 2.26 s * (sectors/2)^2.87.

| stars | 1 sec | 2 sec | 4 sec |
|---|---|---|---|
| 1000 | 0.1 CPU-h | 0.6 CPU-h | 4.6 CPU-h |
| 5000 | 0.4 CPU-h | 3.1 CPU-h | 23.0 CPU-h |
| 20000 | 1.7 CPU-h | 12.6 CPU-h | 92.1 CPU-h |

## Wall-clock at parallelism (CPU-hours / P)

Detection is embarrassingly parallel across stars (no cross-star state), so wall-clock ~= CPU-h / P for P
independent workers (cores, or CI matrix shards).

| stars x sectors | P=1 | P=8 | P=64 |
|---|---|---|---|
| 1000 x 1 sec (0.1 CPU-h) | 0.09 h | 0.01 h | 0.00 h |
| 1000 x 2 sec (0.6 CPU-h) | 0.63 h | 0.08 h | 0.01 h |
| 1000 x 4 sec (4.6 CPU-h) | 4.60 h | 0.58 h | 0.07 h |
| 5000 x 1 sec (0.4 CPU-h) | 0.43 h | 0.05 h | 0.01 h |
| 5000 x 2 sec (3.1 CPU-h) | 3.14 h | 0.39 h | 0.05 h |
| 5000 x 4 sec (23.0 CPU-h) | 23.02 h | 2.88 h | 0.36 h |
| 20000 x 1 sec (1.7 CPU-h) | 1.72 h | 0.21 h | 0.03 h |
| 20000 x 2 sec (12.6 CPU-h) | 12.57 h | 1.57 h | 0.20 h |
| 20000 x 4 sec (92.1 CPU-h) | 92.09 h | 11.51 h | 1.44 h |

## Recommendation (compute is the funded lever)

- A 20000-star, 2-sector public catalog costs ~13 CPU-h for detection; on a
  64-way CI matrix that is ~0.2 h wall-clock, and shards restart independently.
- Deeper baselines are where completeness is won but cost ~nPoints^2.9: a 4-sector run of the same
  sample is ~7.3x the CPU. Buy depth selectively (bright/shallow hosts first), not uniformly.
- Dollar cost maps directly from any provider's vCPU-h price: cost ~= CPU-h x price_per_vCPU_h. This file
  quotes CPU-h only and does not invent a provider price.
- Download + FITS-parse I/O is NOT in these numbers (p33's timer starts after the curve is in memory) and at
  20000-star scale is the other real bottleneck; meter it separately in the scale-out and cache/prefetch products.

Reproduce: `npm run p34:cost-model -- --sectors 1,2,4 --stars 1000,5000,20000 --parallel 1,8,64`
