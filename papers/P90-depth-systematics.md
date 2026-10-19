# Which transit depth should an automated pipeline publish? Two estimators, one external reference, and the error bar a published depth actually earns

Short paper, P90. Research only. Nothing is gated, anchored, claimed, or deployed; the external reference is a
measuring stick the rig is never allowed to see before it fits, and `discoveryClaim` is false throughout. Reproduce
commands at the end.

## Abstract

An autonomous transit pipeline reports a depth, but how accurate is that number and what uncertainty does it deserve?
We compare two depth estimators the rig actually computes -- the BLS box-step depth from which the detection SNR is
derived, and a per-sector limb-darkened shape fit combined by robust median -- against a reference neither is given:
the NASA Exoplanet Archive `pl_trandep` for confirmed planets, consulted only after both fits. On 16 matched
known-planet rows (from 30 recorded) we find: both estimators are biased in the SAME direction, under-reading the
archive by a median of 35.4% (box) and 26.2% (per-sector), so their disagreement with each other is smaller than the
offset they share with the reference; the two are statistically inseparable head to head (8 vs 8, two-sided sign test
p = 1.00); and the shipped adoption guard, which refuses a per-sector value more than 5x from the box, publishes the
best result on this sample (median absolute error 33.0%) -- and the gain comes entirely from the refusals, not the
adoptions. Most importantly, we translate the measurement into the one number a reader actually needs: the radius
that gives 68% empirical coverage of the true depth is 48%, not the 33% median, because a "plus/minus" bar is read as
one standard deviation and a median only covers half the rows. That is the floor we now carry into the presentation
layer.

## Method: two estimators, one reference, production parity

- Box depth: the step-function amplitude from `seats.scout()` (0.8-16 d, oversample 8, nDurations 12) -- the value the
  detection SNR is computed from.
- Per-sector depth: the limb-darkened shape fit the pipeline runs sector by sector at the DETECTOR'S ephemeris,
  combined by robust median with the catalogue stellar radius (`detect/perSectorRun.robustPerSectorDepth()`).
- Reference: the archive `pl_trandep` for confirmed planets, never shown to either fit.
- Adoption: `depthAdoption.decideDepthAdoption()` at the shipped 5x bound -- the per-sector value is adopted only if it
  is within 5x of the box, else the box is kept.

Rows are kept only for stars with at least two fetched sectors and 200 points, and a period match within 5%. This run
was a REPLAY: statistics recomputed from the rows of a prior photometric fetch, so the analysis is reproducible
without re-downloading.

## Result: bias, separability, and what the guard publishes

| estimator                | median signed error vs catalogue | median absolute error | wins (closer to catalogue) |
|--------------------------|---------------------------------:|----------------------:|---------------------------:|
| BLS box                  | -35.44%                          | 36.68%                | 8 / 16                     |
| per-sector median        | -26.16%                          | 44.16%                | 8 / 16                     |
| what the guard publishes | -26.16%                          | 33.02%                | 11 / 16                    |

Adoption at 5x: 13 adopted, 3 refused. Of the 13 adoptions, 5 moved AWAY from the reference; of the 3 refusals, all 3
were cases where the box was in fact the closer measurement. So the guard's edge over either single estimator is a
win-loss record that favours keeping the box when the per-sector fit is a large outlier.

## The number a reader needs: the coverage-calibrated error bar

A published "plus/minus" is read as one standard deviation, roughly 68% coverage. Empirical coverage on the same rows:

| arm                    | median abs err | radius covering 68% | radius covering 95% | 68% / median | worst row |
|------------------------|---------------:|--------------------:|--------------------:|-------------:|----------:|
| BLS box                | 36.7%          | 47.1%               | 116.4%              | 1.28x        | 236.8%    |
| per-sector median      | 44.2%          | 72.9%               | 145.1%              | 1.65x        | 188.9%    |
| what the guard publishes | 33.0%        | 48.0%               | 104.4%              | 1.45x        | 188.9%    |

Two consequences:

- The honest one-sigma bar on a published depth is 48.0%, not the 33.0% median; calling the median a sigma would
  under-state the error by 1.45x.
- The distribution is heavier-tailed than a normal one: reaching 95% coverage needs 104.4% and the worst row is off by
  188.9% -- more than the depth itself. The bar is defensible at one sigma and MUST NOT be doubled to advertise a 95%
  interval; nothing here is Gaussian enough for that.

This 48% radius (rounded up) is carried into the presentation layer as `DEPTH_SYSTEMATIC_REL = 0.50`, combined there
with each record's own statistical term `1/|snr|` in quadrature -- which can only widen a bar, never narrow it below
what was measured.

## Is the 5x adoption bound load-bearing? (sweep on the same rows)

| bound  | adopted | median abs err of published depth | rows no worse than the box |
|--------|--------:|----------------------------------:|---------------------------:|
| 1.2x   | 4 / 16  | 35.4%                             | 15 / 16                    |
| 1.5x   | 7 / 16  | 35.2%                             | 14 / 16                    |
| 2x     | 11 / 16 | 32.4%                             | 13 / 16                    |
| 3x     | 13 / 16 | 33.0%                             | 11 / 16                    |
| 5x (shipped) | 13 / 16 | 33.0%                         | 11 / 16                    |
| 10x    | 15 / 16 | 39.3%                             | 9 / 16                     |
| 1000x  | 16 / 16 | 44.2%                             | 8 / 16                     |

Across bounds the published median absolute error moves by 11.8 percentage points on n = 16, against an estimator
spread of 36.7%. We therefore report the shipped 5x bound as NOT load-bearing at this n rather than tuned to it.
Moving a gate to chase a difference this small would be fitting a decision to sampling noise -- the exact failure the
measure-before-gate rule exists to prevent.

## The honesty fix this drove

Every surface used to render the same depth as an integer number of ppm with a percent to three decimals -- a
precision claim neither estimator supports. Depth and period now go through ONE rule on every surface
(`src/core/depthFormat.ts`, mirrored for the board by `web/honest-precision.js`, kept in step by
`tests/depth-honesty.test.ts`), and the bar printed is the 68%-coverage radius above, not the median.

## Limitations

- n = 16. At that size a 68% quantile interpolates between two neighbouring rows, so the radius is stated to one
  significant figure in the code that uses it and re-estimated whenever the sample grows. It is a floor measured on
  16 targets, not a property of the sky.
- The archive reference is itself a fitted parameter -- a transit depth from a published discovery fit with its own
  dilution, limb-darkening and stellar-density assumptions. A median disagreement of 33% bounds the AGREEMENT between
  three reductions of the same photometry, not the accuracy of any one of them against the sky.
- Period-mismatched rows (14 of 30) are excluded from every statistic; this is about depth, given a correct period.

## Reproduce

    npm run p90:depth-estimators        # recomputes reports/p90-depth-estimators.{md,json}
    # replay path reads the committed run rows; no re-fetch required

Measure-only: safeToGate false, discoveryClaim false. Full data: reports/p90-depth-estimators.{md,json}.
