# P47 two-dimensional completeness map (period x depth) on real light curves

Reproduce: `npm run p47:completeness-grid -- --targets 20 --tmag 11 --trials 2 --min-snr 7`

**Target selection function (stated a priori):** unique TIC hosts from the confirmed-planet catalog at Tmag<=11, first SPOC light curve with >=200 points among up to 3 sectors containing the coordinate; injection grid period=[1.5,3,5.25,8,11.25]d x depth=[300,550,950,1850,3750,7000]ppm x 2 trials, recovered = BLS(SNR>=7) period matched within 2%. NOTE: hosts are planet-bearing and bright, so this is detector efficiency on real photometry, not an unbiased survey selection.

Measured by injecting **960** transits into **20** real TESS-SPOC light curves and running the
same detector the pipeline uses. Cells show `recovery% / trials`; `--` = no injections landed there (long-period
bins are coverage-limited by the ~27-day single-sector baseline).

| period (d) \\ depth (ppm) | 300 | 550 | 950 | 1850 | 3750 | 7000 |
|---|---|---|---|---|---|---|
| 1.5 | 85% (40) | 88% (40) | 95% (40) | 95% (40) | 100% (40) | 100% (40) |
| 3.0 | 70% (40) | 80% (40) | 85% (40) | 90% (40) | 95% (40) | 100% (40) |
| 5.3 | 45% (40) | 65% (40) | 73% (40) | 80% (40) | 85% (40) | 88% (40) |
| 8.0 | 13% (40) | 33% (40) | 38% (40) | 50% (40) | 65% (40) | 65% (40) |
| 11.3 | -- | -- | -- | -- | -- | -- |

**50%-completeness depth threshold per period bin** (the detection-limit curve):

| period (d) | 50% depth (ppm) |
|---|---|
| 1.5 | 300 |
| 3.0 | 300 |
| 5.3 | 363 |
| 8.0 | 1850 |
| 11.3 | not reached |

**4/5** period bins reach 50% completeness within the injected depth range;
each cell carries a Wilson 95% interval in the JSON (`ciLow`/`ciHigh`) so thin cells are not over-read.

Honest limits: the host sample is bright and planet-bearing (catalog-derived), so this is detector
efficiency on real photometry, not an unbiased survey selection function; long-period cells are empty
because a single sector cannot hold two of their transits. Positive control only; nothing gated,
anchored, claimed, or deployed. `discoveryClaim: false`.
