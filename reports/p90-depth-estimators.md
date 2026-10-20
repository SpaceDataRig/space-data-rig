# P90 - which depth should the rig publish?

Two estimators, one reference. Box depth = the BLS step-function fit that `scout()` returns and that the
detection SNR is computed from. Per-sector depth = the limb-darkened shape fit the pipeline runs sector by
sector at the DETECTOR'S ephemeris and combines by robust median. Reference = the NASA Exoplanet Archive
`pl_trandep` for confirmed transiting planets, consulted AFTER both fits and never given to either.

Production parity: `seats.scout()` (0.8-16 d, oversample 8, nDurations 12), `detect/perSectorRun.robustPerSectorDepth()`
with the catalogue stellar radius, and `detect/depthAdoption.decideDepthAdoption()` at the shipped bound of
5x. Nothing here gates, anchors or claims; the archive value is a measuring stick, not a truth
the rig is allowed to see. Rows are kept only for stars with >=2 fetched sectors and >=200 points.

## Sample

- catalogue pull: `nasa-tap`, Tmag <= 9.5, P in [0.8, 15] d, scan window 90, scanned 16.
- records with both estimators and a period match within 5%: **6 of 16 recorded**.
- excluded from every statistic: 10 period-mismatched and 0 without a usable per-sector fit.

## Result

| estimator | median signed error vs catalogue | median absolute error | wins (closer to catalogue) |
|---|---|---|---|
| BLS box | -58.60% | 58.60% | 3/6 |
| per-sector median | -31.10% | 31.10% | 3/6 |
| what the guard publishes | -31.10% | 31.10% | 3/6 |

Adoption at the 5x bound: **5 adopted**, 1 refused.
Adoptions that came out FURTHER from the catalogue than the box they replaced: **3 of 5**.
Refusals where keeping the box was in fact the closer choice: 0 of 1.

## What error bar a published depth actually earns (same rows, empirical coverage)

| arm | median abs err | radius covering 68% | radius covering 95% | 68%/median | worst row |
|---|---|---|---|---|---|
| BLS box | 58.6% | 65.0% | 85.7% | 1.11x | 92.3% |
| per-sector median | 31.1% | 46.8% | 69.8% | 1.51x | 76.8% |
| what the guard publishes | 31.1% | 58.0% | 88.4% | 1.86x | 92.3% |

- A "+/-" is read as one standard deviation, which is about 68% coverage, so the honest bar on a published
  depth is 58.0%, not the 31.1% median: the median is the radius that covers
  half these rows, and calling it a sigma would under-state the error by a factor of 1.86.
- The distribution is heavier-tailed than a normal one. Reaching 95% needs 88.4%, and the worst
  row in the sample is off by 92.3% -- more than the depth itself. So the bar is defensible at
  the one-sigma level and must NOT be doubled to advertise a 95% interval; nothing here is Gaussian enough for that.
- At n=6 a 68% quantile interpolates between two neighbouring rows, so this radius is stated to
  one significant figure in the code that uses it and is re-estimated whenever the sample grows. It is a floor
  measured on 6 targets, not a property of the sky.
- Carried into the presentation layer as `DEPTH_SYSTEMATIC_REL = 0.60`
  (rounded UP from 58.0%), combined there with each record's own statistical term 1/|snr| in
  quadrature -- which can only make a bar wider, never narrower, than what was measured.

## Per-target table

| planet | P cat (d) | P det (d) | dP % | depth cat (ppm) | box (ppm) | box err % | per-sector (ppm) | per err % | ratio | guard |
|---|---|---|---|---|---|---|---|---|---|---|
| pi Men c | 6.2678 | 6.2758 | 0.1 | 268 | 126.4 | -52.7 | 234.6 | -12.3 | 1.855 | adopted |
| HR 858 b | 3.5853 | 3.5872 | 0.1 | 214 | 202.8 | -5.1 | 178.0 | -16.7 | 0.877 | adopted |
| HR 858 c | 5.9739 | 3.5872 | -40.0 | 209 | 202.8 | -2.8 | 178.0 | -14.7 | 0.877 | adopted (excluded) |
| HR 858 d | 11.2305 | 3.5872 | -68.1 | 213 | 202.8 | -4.8 | 178.0 | -16.4 | 0.877 | adopted (excluded) |
| HD 63433 b | 7.1079 | 13.8548 | 94.9 | 502 | 660.0 | 31.6 | 1466.0 | 192.3 | 2.221 | adopted (excluded) |
| HD 50554 c | 5.9694 | 3.2202 | -46.1 | 106 | 94.7 | -10.3 | 65.6 | -37.8 | 0.693 | adopted (excluded) |
| HD 25463 b | 7.0491 | 7.0956 | 0.7 | 301 | 216.1 | -28.1 | 163.8 | -45.5 | 0.758 | adopted |
| HD 25463 c | 3.0440 | 7.0956 | 133.1 | 83 | 216.1 | 161.2 | 163.8 | 98.0 | 0.758 | adopted (excluded) |
| TOI-5789 c | 12.9277 | 13.0201 | 0.7 | 790 | 280.9 | -64.4 | 183.5 | -76.8 | 0.653 | adopted |
| HD 101581 b | 4.4657 | 13.0487 | 192.2 | 211 | 135.8 | -35.6 | 314.4 | 49.2 | 2.316 | adopted (excluded) |
| HD 101581 c | 6.2040 | 13.0487 | 110.3 | 211 | 135.8 | -35.6 | 314.4 | 49.1 | 2.316 | adopted (excluded) |
| AU Mic b | 8.4634 | 13.9257 | 64.5 | 2490 | 2484.4 | -0.2 | 499.4 | -79.9 | 0.201 | adopted (excluded) |
| TOI-480 b | 6.8662 | 6.8351 | -0.5 | 334 | 114.0 | -65.9 | 309.6 | -7.3 | 2.716 | adopted |
| TOI-5807 b | 14.2418 | 7.8225 | -45.1 | 225 | 139.4 | -38.0 | 79.9 | -64.5 | 0.573 | adopted (excluded) |
| HD 21749 c | 7.7899 | 16.0000 | 105.4 | 169 | 753.4 | 345.6 | 247.1 | 46.2 | 0.328 | adopted (excluded) |
| HD 1397 b | 11.5353 | 11.7663 | 2.0 | 2037 | 157.3 | -92.3 | 1041.4 | -48.9 | 6.623 | kept box |

## Reading

- The BLS box UNDER-reads the archive depth by a median of 58.6%; the per-sector median under-reads by 31.1%. Both estimators are biased in the SAME direction, so their disagreement with each other is smaller than the offset they share against the reference.
- Head to head the two estimators are NOT separable on this sample: 3 vs 3 of 6 (exact two-sided sign test p = 1.00). Median ABSOLUTE error is 58.6% (box) against 31.1% (per-sector).
- What the guard publishes is better than either estimator alone on this sample: median absolute error 31.1% against 58.6% (box) and 31.1% (per-sector), with 3/6 rows no worse than the box. The gain comes from the refusals (0/1 were cases where the box was in fact the closer measurement), not from the adoptions: 3 of 5 adoptions moved AWAY from the reference.
- The archive value is itself a fitted parameter (a transit depth from a published discovery fit, with its own dilution, limb-darkening and stellar-density assumptions), so a median disagreement of 31.1% here bounds the AGREEMENT between three different reductions of the same photometry, not the accuracy of any one of them against the sky.
- Practical consequence, and what was done about it: the median absolute error measured here is 58.6% (box)
  / 31.1% (per-sector), while every surface used to render the same quantity as an integer number of ppm
  and a percent to three decimals -- a precision claim neither estimator supports. Depth and period now go
  through one rule on every surface (src/core/depthFormat.ts, mirrored for the board by web/honest-precision.js,
  with the two kept in step by tests/depth-honesty.test.ts), and the bar they print is the 68%-coverage radius
  above rather than the median, because a median covers half the rows and a "+/-" promises about two thirds.

## What a different adoption bound would have published (same rows, same reference)

| bound | adopted | median abs err of published depth | rows no worse than the box |
|---|---|---|---|
| 1.2x | 1/6 | 58.6% | 5/6 |
| 1.5x | 2/6 | 58.6% | 4/6 |
| 2x | 4/6 | 55.7% | 3/6 |
| 3x | 5/6 | 31.1% | 3/6 |
| 5x (shipped) | 5/6 | 31.1% | 3/6 |
| 10x | 6/6 | 31.1% | 3/6 |
| 1000x | 6/6 | 31.1% | 3/6 |

Across these bounds the published median absolute error moves by 27.5 percentage points on
a sample of 6, against an estimator spread of 58.6%: the shipped 5x
bound is reported as not load-bearing at this n rather than tuned to it. Changing a gate to follow a
difference this small would be fitting a decision to sampling noise, which is the failure mode the
measure-before-gate rule exists to stop.

Measure-only: nothing gated, anchored, claimed or deployed; no production record was modified.
