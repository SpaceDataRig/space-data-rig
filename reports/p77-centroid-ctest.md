# P77 eumemic multi-sector centroid F-test -- faithful re-port, measured on our data

Reproduce: `npm run p77:centroid-ctest -- --pos 14 --neg 14 --maxsectors 6 --minsnr 5`

P74 mislabelled eumemic's cross-sector centroid check; the author corrected us -- it is an F-test on the mean
offset (1"/axis floor, >=2 sectors) against the target and each star within 2'. src/detect/centroidFtest.ts now
reproduces that statistic (verified against their formula and offline tests); this script runs it on our real
SPOC cubes and reports the load-bearing number: does it false-reject our known planets?

| class | testable (>=2 sectors) | target-rejected p<0.001 | p<0.01 | mean offset p50 |
|---|---|---|---|---|
| known planets | 6 | 2 | 2 | 8.0" |
| labelled blends | 3 | 0 | 0 | 9.7" |

eumemic calibration for reference: 0/565 known planets rejected at p<0.001, 127/175 (73%) neighbour-blend TOIs caught.

**VERDICT: MEASURED-TINY (n=9 testable): known-planet false-reject 2/6 at p<0.001; blend catch 0/3. Non-zero false-rejects, n is far below their 565/175, so this is a smoke-test of the faithful re-port, NOT a re-validation. safeToGate stays false.**

Measures only; changes no threshold, gates nothing, touches no money path. Target-hypothesis rejection only (no
per-neighbour fit yet). discoveryClaim false, safeToGate false.
