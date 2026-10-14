# P57 the real true-veto 2x2 acceptance test (token-free labelled negative class)

Reproduce: `npm run p57:true-veto -- --neg 18 --pos 18 --tmag 11 --boot 120`
Labels come from the PUBLIC ExoFOP TOI table (no token): known planets (KP) = must keep, and
false positives / eclipsing binaries (FP/EB) = should veto. Each case's ephemeris drives a real
TESS-SPOC target-pixel cube through the PSF double-difference localization; the labelled
decisions go into the acceptance scorer (`src/candidate/vetoAcceptance.ts`).

**Population.** Table rows 8151; placeable labelled negatives 1319, positives 598;
brightest-first sample 18+18; **25 usable** (11 negatives, 14 positives) with a retrievable cube;
11 sampled targets had no SPOC product or too few in/out cadences.

## PSF double-difference -- the true 2x2

| | labelled blend (should veto) | labelled planet (must keep) |
|---|---|---|
| veto fired | 2 | 1 |
| kept | 9 | 13 |

- veto power (blends caught): **18%** (95% CI 0.05-0.48)
- false-veto rate (planets killed): **7%** (95% CI 0.01-0.31)
- ROC AUC (blend vs planet offset): 0.604; naive centroid AUC 0.539
- blend offsets p50 20.68" / max 106.21"; planet offsets p50 12.24" / max 53.21"

**VERDICT: safeToGate = false.** 1 real planet(s) wrongly vetoed (max 0) -- measure-before-gate disqualifies the gate

## Honest caveat (why a modest power number here is NOT the whole story)

The FP/EB label does not distinguish an **off-target blend** (light from a neighbouring star --
exactly what a localization veto can catch) from an **on-target eclipsing binary** (the dip really
is at the target -- which localization *legitimately cannot* reject and should not try; that needs a
shape / odd-even discriminator). So the catch-rate above is a **lower bound** for the localization
tool, not its true sensitivity. The precise, disqualifying number is the **false-veto rate**: a known
planet wrongly killed. Whatever the power number, we do NOT gate on it here.

This is a MEASUREMENT, not a deployed gate. Nothing is wired into the critic / money path.
discoveryClaim: false.
