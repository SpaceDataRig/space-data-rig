# Cross-pipeline validation: Python stack on the committed real-curve fixtures

Stack: batman + wotan biweight (1.0 d window) + astropy BLS (transitleastsquares imported but returned no period on any null curve -- see tlsNullPeriods)
Fixtures: 12 real public TESS-SPOC curves (seed 7, cap 2500 pts), byte-identical input each run.
Versions: {"numpy": "1.26.4", "python": "3.11.17", "astropy": "5.3.4", "batman": "2.4.8", "wotan": "imported", "transitleastsquares": "2.0.1"}

## NULL arm (independent stack on the real curve as-is)

- detections: 12/12; TP 7 / FP 5 (alias-tolerant match against KNOWN CONFIRMED planets;
  a genuine unconfirmed planet counts FP, so purity is a lower bound -- same semantics as p33)
- purity lower bound: 0.583

## INJECT arm (batman transit at P=3 d, astropy BLS recovery)

Two recovery columns: RAW (BLS on the injected curve as-is) and DETRENDED (wotan then BLS). Each
injection is verified present in the data (measuredInjectedPpm in the JSON) before scoring.

| depth (ppm) | raw recovered | raw rate | detrended recovered | detrended rate |
|---|---|---|---|---|
| 300 | 4/12 | 0.333 | 6/12 | 0.5 |
| 500 | 6/12 | 0.5 | 7/12 | 0.583 |
| 1000 | 7/12 | 0.583 | 8/12 | 0.667 |
| 2000 | 8/12 | 0.667 | 10/12 | 0.833 |
| 4000 | 10/12 | 0.833 | 12/12 | 1.0 |
| 8000 | 11/12 | 0.917 | 12/12 | 1.0 |

Injection model(s) used: box-fallback. ('box-fallback' means batman raised, so a labelled pure-numpy box transit was injected instead; the batman exception text is published below.)

### Captured injection/scoring errors (published here so they are legible outside the CI log)

- (72x) `inject_batman: TypeError: TransitModel.light_curve() takes 2 positional arguments but 3 were given`

Compare with the TypeScript pipeline on the same kind of real noise (p33, 33 curves, full resolution): 42.4% @300 ppm -> 81.8% @4000+. Differences here are expected and informative: these fixtures are subsampled (cap 2500 pts), the injection geometry is fixed, and the detrended column applies wotan where the TS p33 inject arm used the raw stitched curve -- the raw column is the like-for-like comparison.
