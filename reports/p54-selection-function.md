# P54 selection-function skeleton, composed on the real P47 completeness grid

Reproduce: `npm run p54:selection-function`
Module: `src/sim/selectionFunction.ts`. Inputs: the REAL 2-D completeness map from `reports/p47`
(period x observed-depth detector efficiency on real TESS-SPOC photometry), composed with a
geometric transit probability and a dilution window.

**Illustrative, not a rate.** The dilution factors (1.0 / 0.9 / 0.7) and the solar-twin star
(R* = M* = 1) are documented ASSUMPTIONS for a demonstration, not per-target Gaia measurements or
stellar parameters. This shows the SHAPE of the eta_earth denominator; it is not an occurrence
rate and claims no detections.

## Geometric transit probability (solar twin, per period bin)

| period bin (d) | geometric P |
|---|---|
| 1-2 | 0.1813 |
| 2-4 | 0.1142 |
| 4-6.5 | 0.0787 |
| 6.5-9.5 | 0.0594 |
| 9.5-13 | 0.0473 |

## 50%-completeness depth, observed vs TRUE (after undoing dilution)

| dilution | 1-2d obs/true (ppm) | 2-4d obs/true (ppm) | 4-6.5d obs/true (ppm) | 6.5-9.5d obs/true (ppm) | 9.5-13d obs/true (ppm) |
|---|---|---|---|---|---|
| 1.00 | 300 / 300 | 300 / 300 | 363 / 363 | 1850 / 1850 | - / - |
| 0.90 | 300 / 333 | 300 / 333 | 363 / 403 | 1850 / 2056 | - / - |
| 0.70 | 300 / 429 | 300 / 429 | 363 / 518 | 1850 / 2643 | - / - |

Reading: a diluted host (0.7) needs a TRUE transit ~1/0.7 = 1.43x deeper than the observed 50%
threshold to be recovered -- the dilution window inflates the detectable planet radius. Turning this
into eta_earth requires per-target Gaia dilution + stellar radii/masses over an UNBIASED sample
(P47 hosts are bright planet-bearing stars, so this is efficiency, not a survey selection function)
-- that is the honest next step, not run here. discoveryClaim: false.
