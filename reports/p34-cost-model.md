# P34 measured compute / cost model (scaling the survey)

Grounded in reports/p33-catalog.json (33 real TESS-SPOC curves). Re-fit every run; nothing hardcoded.

## Detector cost scaling (measured)

Least-squares power-law fit of perCurveMs vs nPoints (log-log):

| quantity | value |
|---|---|
| exponent p (perCurveMs ~ nPoints^p) | 2.936 |
| coefficient k (ms) | 8.567e-7 |
| R^2 (log-log) | 0.837 |
| sample N | 33 |
| reference baseline | <=2 sectors, mean 2899 pts/star |
| measured single-star survey detection (null arm) | 3.98 s |
| cost of doubling the baseline (f=2) | ~7.66x |

The near-cubic exponent (p ~= 2.94) is the central engineering fact: BLS over a fine period
grid is superlinear in the point count, the iterative mask-and-refind re-runs it per signal, so the lever
that raises completeness (deeper baselines => more sectors => more points) is priced ~nPoints^p. R^2 =
0.84 on N=33 is an empirical scaling for THIS detector + period grid, not a universal law;
treat extrapolations as order-of-magnitude planning figures, and re-fit after any detector/grid change.

## Survey CPU-hours (detection only; download/parse excluded)

Rows = survey size, columns = stitched sectors per star. surveyCPU = N * 3.98 s * (sectors/2)^2.94.

| stars | 1 sec | 2 sec | 4 sec |
|---|---|---|---|
| 1000 | 0.1 CPU-h | 1.1 CPU-h | 8.5 CPU-h |
| 5000 | 0.7 CPU-h | 5.5 CPU-h | 42.3 CPU-h |
| 20000 | 2.9 CPU-h | 22.1 CPU-h | 169.2 CPU-h |

## Wall-clock at parallelism (CPU-hours / P)

Detection is embarrassingly parallel across stars (no cross-star state), so wall-clock ~= CPU-h / P for P
independent workers (cores, or CI matrix shards).

| stars x sectors | P=1 | P=8 | P=64 |
|---|---|---|---|
| 1000 x 1 sec (0.1 CPU-h) | 0.14 h | 0.02 h | 0.00 h |
| 1000 x 2 sec (1.1 CPU-h) | 1.11 h | 0.14 h | 0.02 h |
| 1000 x 4 sec (8.5 CPU-h) | 8.46 h | 1.06 h | 0.13 h |
| 5000 x 1 sec (0.7 CPU-h) | 0.72 h | 0.09 h | 0.01 h |
| 5000 x 2 sec (5.5 CPU-h) | 5.53 h | 0.69 h | 0.09 h |
| 5000 x 4 sec (42.3 CPU-h) | 42.31 h | 5.29 h | 0.66 h |
| 20000 x 1 sec (2.9 CPU-h) | 2.89 h | 0.36 h | 0.05 h |
| 20000 x 2 sec (22.1 CPU-h) | 22.11 h | 2.76 h | 0.35 h |
| 20000 x 4 sec (169.2 CPU-h) | 169.24 h | 21.16 h | 2.64 h |

## Recommendation (compute is the funded lever)

- A 20000-star, 2-sector public catalog costs ~22 CPU-h for detection; on a
  64-way CI matrix that is ~0.3 h wall-clock, and shards restart independently.
- Deeper baselines are where completeness is won but cost ~nPoints^2.9: a 4-sector run of the same
  sample is ~7.7x the CPU. Buy depth selectively (bright/shallow hosts first), not uniformly.
- Dollar cost maps directly from any provider's vCPU-h price: cost ~= CPU-h x price_per_vCPU_h. This file
  quotes CPU-h only and does not invent a provider price.
- Download + FITS-parse I/O is NOT in these numbers (p33's timer starts after the curve is in memory) and at
  20000-star scale is the other real bottleneck; meter it separately in the scale-out and cache/prefetch products.

Reproduce: `npm run p34:cost-model -- --sectors 1,2,4 --stars 1000,5000,20000 --parallel 1,8,64`
