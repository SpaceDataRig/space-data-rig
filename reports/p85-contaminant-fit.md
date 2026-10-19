# P85 -- faithful per-contaminant centroid F-test (eumemic method), on the real P82 run

Statistic: `src/detect/centroidFtest.ts` -- F = n(n-1)|m-s|^2 / RSS, 1"/axis scatter floor, df=(2,2(n-1)), closed-form p. Run for the target (s=0,0) AND for every neighbour bright enough to cause the dip (`neighbourCanCauseDip`). Source: tests/fixtures/scaled/centroid.jsonl (500 targets).

## Coverage (the honest ceiling)

- testable (>=2 localised sectors): **114/500** (22.8%)
- never localised (pixel-baseline bound, P84): **386/500**

## Headline at the run threshold (alpha=0.001)

- known-planet false-reject: **2/55** (3.6%) -- the calibration arm; eumemic report 0/565 at p<0.001
- blend caught (target rejected AND a contaminant fits): **0/59** (0.0%)
- among testable blends that HAVE a bright-enough neighbour, a neighbour's offset explains the mean in **49/52** (94.2%)

## Sensitivity to the significance threshold

| alpha | planet false-reject | blend caught | contaminant fits / viable |
|-------|--------------------:|-------------:|--------------------------:|
| 0.0001 | 0/55 | 0/59 | 50/52 |
| 0.001 | 2/55 | 0/59 | 49/52 |
| 0.01 | 5/55 | 1/59 | 43/52 |

## Methodological choices (where the author's doc left them open)

- **Which star fits:** max-p across bright-enough contaminants (a neighbour 'explains' the mean offset); NOT a joint/min-p test.
- **Scatter floor:** 1"/axis floor applied to the residual scatter AFTER the mean offset (per-axis min SS = (n-1)*floor^2).
- **Brightness gate:** neighbourCanCauseDip: a total eclipse of the neighbour, diluted by the host, must reach the observed depth.

## Verdict

FAITHFUL-REPRODUCTION-RUN. The per-contaminant F-test is implemented and executed over 114 localisable real targets. The statistic behaves as calibrated (a low known-planet false-reject rate), but its POWER is bounded by the same pixel-baseline coverage limit P84 identified: 386/500 targets never localise a >=2-sector offset to test at all. Widening the sample narrows the error bars; it does not remove the coverage wall. safeToGate=false, discoveryClaim=false.
