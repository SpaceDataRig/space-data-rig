# P62 phase-aligned joint folding vs the naive stitch (targeted fix of the P60 negative)

Reproduce: `npm run p62:phase-aligned-joint -- --minsnr 7 --tol 5 --win 0.1 --oversample 24`

P60 found joint == single re-find (6/20 each) and the per-planet rows showed why: most
misses were PERIOD MISMATCH on the stitched long baseline (a high-SNR peak at the wrong period from phase
drift), not low SNR. This script tests the reviewer's fix -- detect per-sector first, then run a narrow,
high-oversample joint fold around that seed (phase-aligned period refinement) -- on the SAME planets.

| arm | re-find | 95% Wilson CI |
|---|---|---|
| single-sector (best) | 6/20 = 30.0% | - |
| naive joint (full-range) | 6/20 = 30.0% | [15, 52] |
| REFINED (data-seed, phase-aligned) | 4/20 = 20.0% | [8, 42] |
| ORACLE (truth-seed ceiling, diagnostic) | 10/20 = 50.0% | - |

Refinement FIXED 1 naive-misses and BROKE 3. Corroborated at the refined
ephemeris (>=2 sectors confirm a planet-plausible dip): 3/20.

**Bottleneck:** oracle minus refined = 6. A perfect (truth) seed recovers more than the data seed, so the binding constraint is single-sector seed acquisition, not the alignment step.

**VERDICT: NO-LIFT-JOINT-NOT-A-FREE-LUNCH (phase-aligned refinement does not recover more known planets on this few-sector sample; the P60 negative stands and is now mechanistically explained)**

Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.
