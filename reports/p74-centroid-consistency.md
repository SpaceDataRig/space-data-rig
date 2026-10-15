# P74 multi-sector centroid consistency: does cross-sector coherence fix the pixel veto?

Reproduce: `npm run p74:centroid-consistency -- --pos 16 --neg 16 --maxsectors 5 --gate 2 --minsnr 5`

P53/P57/P58 proved the SINGLE difference-image centroid veto is not safe to gate (it false-kills real
planets). **Attribution corrected after the eumemic author (@dysmemic) replied:** eumemic's real cross-sector
check runs an F-test on the MEAN offset across sectors (per-axis scatter floored at 1") against the target AND
each star within 2' bright enough to cause the dip -- on their calibration set 0/565 known planets rejected at
p<0.001 and 73% of 175 neighbour-blended TOIs caught (38% within 15"); see their `validation/centroid_sectors.md`.
That is NOT a same-direction test. What we scored here is our OWN simpler directional-coherence (Rayleigh)
statistic (reject only when offsets point consistently off-target), so the numbers below characterise OUR
variant -- not eumemic's F-test -- on 28 real SPOC targets from the token-free ExoFOP table
(16 known planets to keep, 12 FP/EB blends to veto).

| | blend catch (power) | known-planet FALSE-KILL | AUC | safe-to-gate |
|---|---|---|---|---|
| SINGLE sector (P57) | 50% | 9/16 | 0.469 | false |
| MULTI sector (coherent) | 0% | 0/16 | 0.495 | false |

Cross-sector consistency removed 9 of the single-sector known-planet false-kills; multi power 0%, multi AUC 0.495.
Planet mean resultant p50 2.99" vs blend 3.86".

Caveat: FP/EB labels mix off-target blends (catchable) with on-target eclipsing binaries (not), so blend
power is a LOWER bound; the load-bearing number is the known-planet false-kill.

**VERDICT: COHERENCE-SAVES-PLANETS-BUT-NO-POWER. safeToGate(multi)=false.** This is a MEASUREMENT; nothing is wired into the critic / money path.
discoveryClaim: false.
