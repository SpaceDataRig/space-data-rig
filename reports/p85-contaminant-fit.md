# P85 -- faithful per-contaminant centroid F-test (eumemic method), on the real P82 run

Statistic: `src/detect/centroidFtest.ts` -- F = n(n-1)|m-s|^2 / RSS, 1"/axis scatter floor, df=(2,2(n-1)), closed-form p. Run for the target (s=0,0) AND for every neighbour bright enough to cause the dip (`neighbourCanCauseDip`). Source: out/scaled/centroid.jsonl (500 targets).

## Coverage (the honest ceiling)

- testable (>=2 localised sectors): **109/500** (21.8%)
- never localised (pixel-baseline bound, P84): **391/500**

## Headline at the run threshold (alpha=0.001)

- known-planet false-reject: **1/53** (1.9%) -- the calibration arm; eumemic report 0/565 at p<0.001
- blend caught (target rejected AND a contaminant fits): **0/56** (0.0%)
- among testable blends that HAVE a bright-enough neighbour, a neighbour's offset explains the mean in **54/56** (96.4%)

## Sensitivity to the significance threshold

| alpha | planet false-reject | blend caught | contaminant fits / viable |
|-------|--------------------:|-------------:|--------------------------:|
| 0.0001 | 0/53 | 0/56 | 56/56 |
| 0.001 | 1/53 | 0/56 | 54/56 |
| 0.01 | 3/53 | 2/56 | 40/56 |

## Methodological choices (where the author's doc left them open)

- **Which star fits:** max-p across bright-enough contaminants (a neighbour 'explains' the mean offset); NOT a joint/min-p test.
- **Scatter floor:** 1"/axis floor applied to the residual scatter AFTER the mean offset (per-axis min SS = (n-1)*floor^2).
- **Brightness gate:** neighbourCanCauseDip: a total eclipse of the neighbour, diluted by the host, must reach the observed depth.

## Verdict

FAITHFUL-REPRODUCTION-RUN. The per-contaminant F-test is implemented and executed over 109 localisable real targets. The statistic behaves as calibrated (a low known-planet false-reject rate), but its POWER is bounded by the same pixel-baseline coverage limit P84 identified: 391/500 targets never localise a >=2-sector offset to test at all. Widening the sample narrows the error bars; it does not remove the coverage wall. safeToGate=false, discoveryClaim=false.
