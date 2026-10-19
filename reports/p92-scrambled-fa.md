# P92 scrambled false-alarm null and a data-driven completeness/reliability gate

Reproduce: `npm run p92:scrambled-fa -- --targets 10 --perCurve 3 --maxsectors 1 --seed 7`

LEO-Vetter (Kunimoto et al. 2025, ApJ) tunes its flux-level vetting by minimising sqrt((1-C)^2 + (1-R_FA)^2),
completeness on injected planets and reliability against false alarms drawn from a time-SCRAMBLED population --
and it shows scrambling is the honest false-alarm surrogate where INVERSION is not (orbit-start scattered-light
ramps are asymmetric under reflection; flares invert into dips). This repo had a per-candidate phase-scrambling
FAP and an inversion null but no candidate-level false-alarm POPULATION scored jointly with completeness. On
**10 real TESS-SPOC curves** we build exactly that: 50 injected transits, 57
scrambled TCEs (shuffle + block), 0 inverted TCEs, all through src/detect/falseAlarmNull.ts.

| BLS SNR gate | completeness C | reliability R_FA | joint objective |
|---|---|---|---|
| 5 | 100.0% | 47.6% | 0.524 |
| 8 | 100.0% | 53.8% | 0.462 |
| 10 | 100.0% | 60.2% | 0.398 |
| 12 | 100.0% | 66.7% | 0.333 |
| 15 | 96.0% | 73.8% | 0.265 |
| 18 | 94.0% | 75.8% | 0.249 |
| 22 | 88.0% | 78.6% | 0.246 |
| 26 | 86.0% | 78.2% | 0.259 |
| 30 | 80.0% | 76.9% | 0.305 |
| 35 | 76.0% | 76.0% | 0.339 |
| 40 | 72.0% | 75.0% | 0.375 |

**Optimum: SNR>=22 (C=88.0%, R_FA=78.6%, objective=0.246).**

False alarms clearing the optimum gate: scrambled 12/57 (21.1%), inverted 0/0 (n/a); median BLS SNR 10.8 (scrambled) vs NaN (inverted).

**VERDICT: C/R-OPTIMISED: the joint objective sqrt((1-C)^2+(1-R_FA)^2) is minimised at SNR>=22 giving C=88.0%, R_FA=78.6% on 10 real curves; the scrambled false-alarm null puts 12/57 (21.1%) peaks past that gate, the inverted null 0/0 (n/a%). Measures a candidate-level null and reads a threshold off it; wires nothing, claims nothing.**

Builds a reusable candidate-level false-alarm null and reads a threshold off real data; wires nothing into the
runtime, changes no production gate, claims no discovery. discoveryClaim false.
