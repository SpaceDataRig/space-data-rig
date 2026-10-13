# P35 independent cross-check: PDM vs box-fit BLS (real photometry)

Sample: first 40 TIC-bearing hosts (T<=12, P in [1,13] d) in deterministic catalog
order (the SAME seeded sample as p33); 33 had usable public TESS-SPOC curves (<=2 sectors stitched), 7 coverage misses.
PDM (Stellingwerf 1978, src/detect/pdm.ts) is a non-parametric period finder sharing NO machinery with the
box-fit family (bls.ts / iterative.ts): it minimizes the within-bin variance of the phase fold, theta. Inject
period 3 d; depths [300, 500, 1000, 2000, 4000, 8000] ppm; bins 12; oversample 10; match tol 2%; seed 7.

## (1) Independent period agreement on real curves (NULL arm)

| metric | value |
|---|---|
| curves with BOTH a gated BLS period and a finite PDM minimum | 18/33 |
| PDM-vs-BLS agreement (same period or harmonic) | 9/18 (50.0%) |

Agreement is corroboration between two independent estimators; disagreement localizes where the box-fit family
locks a peak PDM does not share (often a systematics or alias peak). PDM's global theta minimum on a real
variable star is frequently the dominant rotation/activity period, so a low agreement rate is expected and is
itself the honest finding (it is why transit pipelines use a detrended box-fit search, not raw PDM).

## (2) Independent completeness (PDM alone recovers a known injected transit)

PDM completeness vs the PUBLISHED BLS completeness (reports/p33-catalog.json) on the 33 shared stars:

| depth (ppm) | PDM recovered | BLS (p33) recovered |
|---|---|---|
| 300 | 8/33 (24.2%) | 14/33 (42.4%) |
| 500 | 12/33 (36.4%) | 18/33 (54.5%) |
| 1000 | 17/33 (51.5%) | 23/33 (69.7%) |
| 2000 | 20/33 (60.6%) | 26/33 (78.8%) |
| 4000 | 25/33 (75.8%) | 27/33 (81.8%) |
| 8000 | 26/33 (78.8%) | 27/33 (81.8%) |

Reproduce: `npm run p35:pdm-crosscheck -- --stars 40 --maxsectors 2 --period 3 --seed 7`
