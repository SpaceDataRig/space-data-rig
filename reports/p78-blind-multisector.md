# P78 multi-sector blind test on real photometry

Reproduce: `npm run p78:blind-multisector -- --stars 24 --sectors 4 --inject-frac 0.5 --seed 11`

Where P49 stitched sectors into one baseline and forced corroboratedSectors=1 (so the 2-sector bar accepted
nothing by construction), P78 runs the detector SECTOR BY SECTOR on real TESS-SPOC curves, plants one
phase-coherent ephemeris across the sectors (or leaves real nulls), and counts corroboration as the number of
independent sectors that found the same period. The 2-sector bar is then MEASURED, not assumed.

**24 hosts, all with >=2 real sectors** (10 injected, 14 null), 55 period-clusters

| metric | value |
|---|---|
| recall (any sectors) | 90.0% [59.6%, 98.2%] |
| precision (lower bound) | 16.4% [8.9%, 28.3%] |
| FP rate per null host | 1.57 |
| corroboration histogram (1..5 sectors) | 38 / 13 / 1 / 3 / 0 |
| accepted under 2-sector bar | 17 |
| ACCEPTED recall under 2-sector bar | 80.0% (8/10) |
| FALSE-ACCEPTS under 2-sector bar | 9 |
| accepted precision | 47.1% |

Honest reading: precision is a LOWER bound (a detection that is the host's own real planet counts FP). The
decisive results are whether injected planets clear the 2-sector bar (accepted recall) and whether null hosts
stay at zero false accepts under it -- i.e. whether real multi-sector corroboration suppresses real noise.
Measure only; nothing gated, anchored, claimed, or deployed. `discoveryClaim: false`, `safeToGate: false`.
