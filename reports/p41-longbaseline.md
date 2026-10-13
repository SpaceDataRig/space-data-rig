# P41 longer baseline (multi-sector) vs single sector -- completeness on real photometry

Reproduce: `npm run p41:longbaseline -- --stars 30 --maxsectors 4 --period 3 --seed 7`
Sample: first 30 seeded hosts (T<=12, P in [1,13] d); 29 had a public SPOC curve, 25 had >=2 sectors stitched.
Identical injection-recovery depth grid on (a) each host's longest single sector and (b) its stitched
multi-sector baseline; only the baseline differs. Detector: bls + SNR>=7 / depth>=200ppm / plausibility,
period match tol 5%, inject P=3d, seed 7.

| depth ppm | single-sector completeness | multi-sector completeness | lift (pp) |
|---|---|---|---|
| 300 | 51.7% (15/29) | 37.9% (11/29) | -13.8 |
| 500 | 65.5% (19/29) | 65.5% (19/29) | 0.0 |
| 800 | 75.9% (22/29) | 75.9% (22/29) | 0.0 |
| 1500 | 82.8% (24/29) | 75.9% (22/29) | -6.9 |
| 3000 | 89.7% (26/29) | 79.3% (23/29) | -10.3 |

Mean sectors/host used: 2.69. Measure-only: nothing gated, anchored,
claimed or deployed. Longer baselines (more sectors / full-frame surveys) are the honest lever against
the single-sector completeness ceiling; this quantifies its price on real data.