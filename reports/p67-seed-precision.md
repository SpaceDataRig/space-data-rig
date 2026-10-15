# P67 seed-precision: does the production iterative detector clear the P62 'seed wall'?

Reproduce: `npm run p67:seed-precision -- --minsnr 7 --tol 5 --win 0.1 --k 3`

P62 localised the joint-search bottleneck to seed acquisition, but seeded the refinement from a NAIVE
single-sector BLS peak. The production detector (p33/p49/p50) is `iterativeBls` -- mask-and-refind top-k
signals. This study measures SEED HIT (does the seeder's period match catalog truth within tol) for each
seeder on the SAME 20 confirmed planets, then feeds each into P62's phase-aligned narrow joint fold.

| seeder | seed-hit | refined re-find | 95% Wilson CI (hit) |
|---|---|---|---|
| naive single peak | 4/20 | 4/20 | - |
| iterative top-1 | 5/20 | 5/20 | [11, 47] |
| iterative top-3 (any) | 5/20 | - | [11, 47] |
| ORACLE (truth seed, ceiling) | - | 10/20 | - |

Seed-recall gain (iterative top-3 over the single peak) = +5.0 pp.

**VERDICT: MODEST-SEED-LIFT (iterative top-3 recall exceeds the single peak but within overlapping Wilson CIs -- not decisive; the wall is real but somewhat softer than P62 implied).**

Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.
