# P73 masked recovery: is the P62 'seed wall' mostly sibling crowding?

Reproduce: `npm run p73:masked-recovery -- --minsnr 7 --tol 5 --win 0.1 --k 3 --pad 0.25`

P62/P67 put the joint-search bottleneck on SEED ACQUISITION: a blind fold locks onto a neighbouring planet
or a harmonic and re-finds only 4-6/20, while a truth-seeded ORACLE fold reaches 10/20. The external
eumemic/exoplanets pipeline attacks this a different way -- it MASKS every already-known planet (catalog
period+epoch+duration widened) and searches the residual. This study applies that lever on the SAME P60
planets: for each target we mask its host's OTHER confirmed planets and compare re-find (20 planets, 12 with >=1 catalogued sibling).

| arm | re-find /20 |
|---|---|
| SINGLE (best per-sector) | 4/20 |
| NAIVE-JOINT (stitched BLS) | 6/20 |
| MASK-JOINT (siblings masked, then BLS) | 7/20  [95% Wilson 18-57%] |
| MASK-ITERATIVE top-1 | 5/20 |
| MASK-ITERATIVE top-3 (any) | 5/20 |
| ORACLE (truth seed, ceiling) | 11/20 |

Masking gained 1 re-finds the blind joint fold missed and lost 0 (net +1).

**Honesty bound.** The MASK arms consume GROUND-TRUTH catalog ephemerides of the siblings, so they are an
ASSISTED ceiling ("how many come back if you already know the neighbours"), not a fully blind result.

**VERDICT: MODEST-SIBLING-LIFT: masking siblings nudges re-find 6->7/20 (+1/-0) but stays well under the ORACLE 11/20 -- neighbour-lock is only part of the wall; the rest is intrinsic alias/noise confusion.**

Positive control on known planets; discovery claims structurally false; nothing gated, anchored or deployed.
