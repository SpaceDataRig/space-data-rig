# P90 - which depth should the rig publish?

Reproduce: `npm run p90:depth-estimators`

Two estimators, one reference. Box depth = the BLS step-function fit that `scout()` returns and that the
detection SNR is computed from. Per-sector depth = the limb-darkened shape fit the pipeline runs sector by
sector at the DETECTOR'S ephemeris and combines by robust median. Reference = the NASA Exoplanet Archive
`pl_trandep` for confirmed transiting planets, consulted AFTER both fits and never given to either.

Production parity: `seats.scout()` (0.8-16 d, oversample 8, nDurations 12), `detect/perSectorRun.robustPerSectorDepth()`
with the catalogue stellar radius, and `detect/depthAdoption.decideDepthAdoption()` at the shipped bound of
5x. Nothing here gates, anchors or claims; the archive value is a measuring stick, not a truth
the rig is allowed to see. Rows are kept only for stars with >=2 fetched sectors and >=200 points.

## Sample

- catalogue pull: `nasa-tap`, Tmag <= 9.5, P in [0.8, 8] d, scan window 150, scanned 30.
- **REPLAY**: these statistics were recomputed from the rows of the run dated 2026-10-18T09:41:09.459Z; the photometry was fetched then, not now. The light-curve work is unchanged, only the analysis of it.
- records with both estimators and a period match within 5%: **16 of 30 recorded**.
- excluded from every statistic: 14 period-mismatched and 0 without a usable per-sector fit.

## Result

| estimator | median signed error vs catalogue | median absolute error | wins (closer to catalogue) |
|---|---|---|---|
| BLS box | -35.44% | 36.68% | 8/16 |
| per-sector median | -26.16% | 44.16% | 8/16 |
| what the guard publishes | -26.16% | 33.02% | 11/16 |

Adoption at the 5x bound: **13 adopted**, 3 refused.
Adoptions that came out FURTHER from the catalogue than the box they replaced: **5 of 13**.
Refusals where keeping the box was in fact the closer choice: 3 of 3.

## What error bar a published depth actually earns (same rows, empirical coverage)

| arm | median abs err | radius covering 68% | radius covering 95% | 68%/median | worst row |
|---|---|---|---|---|---|
| BLS box | 36.7% | 47.1% | 116.4% | 1.28x | 236.8% |
| per-sector median | 44.2% | 72.9% | 145.1% | 1.65x | 188.9% |
| what the guard publishes | 33.0% | 48.0% | 104.4% | 1.45x | 188.9% |

- A "+/-" is read as one standard deviation, which is about 68% coverage, so the honest bar on a published
  depth is 48.0%, not the 33.0% median: the median is the radius that covers
  half these rows, and calling it a sigma would under-state the error by a factor of 1.45.
- The distribution is heavier-tailed than a normal one. Reaching 95% needs 104.4%, and the worst
  row in the sample is off by 188.9% -- more than the depth itself. So the bar is defensible at
  the one-sigma level and must NOT be doubled to advertise a 95% interval; nothing here is Gaussian enough for that.
- At n=16 a 68% quantile interpolates between two neighbouring rows, so this radius is stated to
  one significant figure in the code that uses it and is re-estimated whenever the sample grows. It is a floor
  measured on 16 targets, not a property of the sky.
- Carried into the presentation layer as `DEPTH_SYSTEMATIC_REL = 0.50`
  (rounded UP from 48.0%), combined there with each record's own statistical term 1/|snr| in
  quadrature -- which can only make a bar wider, never narrower, than what was measured.

## Per-target table

| planet | P cat (d) | P det (d) | dP % | depth cat (ppm) | box (ppm) | box err % | per-sector (ppm) | per err % | ratio | guard |
|---|---|---|---|---|---|---|---|---|---|---|
| pi Men c | 6.2678 | 6.2758 | 0.1 | 268 | 126.4 | -52.7 | 234.6 | -12.3 | 1.855 | adopted |
| HR 858 b | 3.5853 | 3.5872 | 0.1 | 214 | 202.8 | -5.1 | 178.0 | -16.7 | 0.877 | adopted |
| HR 858 c | 5.9739 | 3.5872 | -40.0 | 209 | 202.8 | -2.8 | 178.0 | -14.7 | 0.877 | adopted (excluded) |
| HD 63433 b | 7.1079 | 13.8548 | 94.9 | 502 | 660.0 | 31.6 | 1466.0 | 192.3 | 2.221 | adopted (excluded) |
| HD 50554 c | 5.9694 | 3.2202 | -46.1 | 106 | 94.7 | -10.3 | 65.6 | -37.8 | 0.693 | adopted (excluded) |
| HD 25463 b | 7.0491 | 7.0956 | 0.7 | 301 | 216.1 | -28.1 | 163.8 | -45.5 | 0.758 | adopted |
| HD 25463 c | 3.0440 | 7.0956 | 133.1 | 83 | 216.1 | 161.2 | 163.8 | 98.0 | 0.758 | adopted (excluded) |
| HD 101581 b | 4.4657 | 13.0487 | 192.2 | 211 | 135.8 | -35.6 | 314.4 | 49.2 | 2.316 | adopted (excluded) |
| HD 101581 c | 6.2040 | 13.0487 | 110.3 | 211 | 135.8 | -35.6 | n/a | n/a | n/a | kept box (excluded) |
| TOI-480 b | 6.8662 | 6.9070 | 0.6 | 334 | 208.6 | -37.6 | 93.5 | -72.0 | 0.448 | adopted |
| HD 21749 c | 7.7899 | 16.0000 | 105.4 | 169 | 753.4 | 345.6 | 247.1 | 46.2 | 0.328 | adopted (excluded) |
| KELT-11 b | 4.7362 | 4.7883 | 1.1 | 2339 | 555.6 | -76.2 | 984.7 | -57.9 | 1.772 | adopted |
| HD 86226 c | 3.9844 | 3.9895 | 0.1 | 445 | 291.2 | -34.6 | 105.4 | -76.3 | 0.362 | adopted |
| HD 207496 b | 6.4410 | 12.9341 | 100.8 | 914 | 687.1 | -24.8 | 1533.6 | 67.8 | 2.232 | adopted (excluded) |
| HD 213885 b | 1.0080 | 1.0072 | -0.1 | 200 | 199.4 | -0.3 | 29.9 | -85.1 | 0.150 | kept box |
| TOI-6054.01 | 7.5014 | 7.4813 | -0.3 | 213 | 115.2 | -45.9 | 166.0 | -22.1 | 1.440 | adopted |
| KELT-20 b | 3.4741 | 3.4910 | 0.5 | 13090 | 8496.9 | -35.1 | 10361.3 | -20.8 | 1.219 | adopted |
| KELT-9 b | 1.4811 | 1.4823 | 0.1 | 6789 | 6298.0 | -7.2 | 7008.1 | 3.2 | 1.113 | adopted |
| TOI-5082.01 | 4.2401 | 4.2487 | 0.2 | 842 | 281.1 | -66.6 | 1940.8 | 130.5 | 6.905 | kept box |
| TOI-1776 b | 2.7999 | 13.1164 | 368.5 | 205 | 398.8 | 94.7 | 220.4 | 7.6 | 0.553 | adopted (excluded) |
| GJ 341 b | 7.5769 | 11.3171 | 49.4 | 289 | 476.1 | 64.7 | 283.0 | -2.1 | 0.595 | adopted (excluded) |
| TOI-411 b | 4.0403 | 10.0427 | 148.6 | 144 | 270.8 | 88.7 | 226.6 | 57.9 | 0.837 | adopted (excluded) |
| HIP 94235 b | 7.7131 | 2.2633 | -70.7 | 728 | 559.3 | -23.2 | n/a | n/a | n/a | kept box (excluded) |
| Kepler-21 b | 2.7858 | 14.8886 | 434.4 | 62 | 324.0 | 421.2 | 89.0 | 43.1 | 0.275 | adopted (excluded) |
| TOI-4602.01 | 3.9813 | 3.9553 | -0.7 | 60 | 202.1 | 236.8 | 173.3 | 188.9 | 0.858 | adopted |
| TOI-1860 b | 1.0662 | 4.2529 | 298.9 | 151 | 608.9 | 303.2 | 15239.6 | 9992.4 | 25.028 | kept box (excluded) |
| TOI-1431 b | 2.6502 | 2.6478 | -0.1 | 5797 | 2788.6 | -51.9 | 5445.0 | -6.1 | 1.953 | adopted |
| HD 202772 A b | 3.3089 | 3.3117 | 0.1 | 4670 | 2998.1 | -35.8 | 104.6 | -97.8 | 0.035 | kept box |
| WASP-33 b | 1.2199 | 1.2178 | -0.2 | 12160 | 11604.6 | -4.6 | 6952.5 | -42.8 | 0.599 | adopted |
| HD 260655 b | 2.7695 | 2.7654 | -0.1 | 712 | 440.8 | -38.1 | 496.7 | -30.2 | 1.127 | adopted |

## Reading

- The BLS box UNDER-reads the archive depth by a median of 35.4%; the per-sector median under-reads by 26.2%. Both estimators are biased in the SAME direction, so their disagreement with each other is smaller than the offset they share against the reference.
- Head to head the two estimators are NOT separable on this sample: 8 vs 8 of 16 (exact two-sided sign test p = 1.00). Median ABSOLUTE error is 36.7% (box) against 44.2% (per-sector).
- What the guard publishes is better than either estimator alone on this sample: median absolute error 33.0% against 36.7% (box) and 44.2% (per-sector), with 11/16 rows no worse than the box. The gain comes from the refusals (3/3 were cases where the box was in fact the closer measurement), not from the adoptions: 5 of 13 adoptions moved AWAY from the reference.
- The archive value is itself a fitted parameter (a transit depth from a published discovery fit, with its own dilution, limb-darkening and stellar-density assumptions), so a median disagreement of 33.0% here bounds the AGREEMENT between three different reductions of the same photometry, not the accuracy of any one of them against the sky.
- Practical consequence, and what was done about it: the median absolute error measured here is 36.7% (box)
  / 44.2% (per-sector), while every surface used to render the same quantity as an integer number of ppm
  and a percent to three decimals -- a precision claim neither estimator supports. Depth and period now go
  through one rule on every surface (src/core/depthFormat.ts, mirrored for the board by web/honest-precision.js,
  with the two kept in step by tests/depth-honesty.test.ts), and the bar they print is the 68%-coverage radius
  above rather than the median, because a median covers half the rows and a "+/-" promises about two thirds.

## What a different adoption bound would have published (same rows, same reference)

| bound | adopted | median abs err of published depth | rows no worse than the box |
|---|---|---|---|
| 1.2x | 4/16 | 35.4% | 15/16 |
| 1.5x | 7/16 | 35.2% | 14/16 |
| 2x | 11/16 | 32.4% | 13/16 |
| 3x | 13/16 | 33.0% | 11/16 |
| 5x (shipped) | 13/16 | 33.0% | 11/16 |
| 10x | 15/16 | 39.3% | 9/16 |
| 1000x | 16/16 | 44.2% | 8/16 |

Across these bounds the published median absolute error moves by 11.8 percentage points on
a sample of 16, against an estimator spread of 36.7%: the shipped 5x
bound is reported as not load-bearing at this n rather than tuned to it. Changing a gate to follow a
difference this small would be fitting a decision to sampling noise, which is the failure mode the
measure-before-gate rule exists to stop.

Measure-only: nothing gated, anchored, claimed or deployed; no production record was modified.
