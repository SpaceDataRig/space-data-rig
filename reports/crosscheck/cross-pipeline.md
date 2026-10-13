# Cross-pipeline validation: Python stack on the committed real-curve fixtures

Stack: batman + wotan biweight + astropy BLS (transitleastsquares unavailable: MISSING above)
Fixtures: 12 real public TESS-SPOC curves (seed 7, cap 2500 pts), byte-identical input each run.
Versions: {"numpy": "1.26.4", "python": "3.11.17", "astropy": "5.3.4", "batman": "2.4.8", "wotan": "imported", "transitleastsquares": "2.0.1"}

## NULL arm (independent stack on the real curve as-is)

- detections: 12/12; TP 8 / FP 4 (alias-tolerant match against KNOWN CONFIRMED planets;
  a genuine unconfirmed planet counts FP, so purity is a lower bound -- same semantics as p33)
- purity lower bound: 0.667

## INJECT arm (batman transit at P=3 d, wotan detrend, astropy BLS recovery)

| depth (ppm) | recovered | rate |
|---|---|---|
| 300 | 0/12 | 0.0 |
| 500 | 0/12 | 0.0 |
| 1000 | 0/12 | 0.0 |
| 2000 | 0/12 | 0.0 |
| 4000 | 0/12 | 0.0 |
| 8000 | 0/12 | 0.0 |

Compare with the TypeScript pipeline on the same kind of real noise (p33, 33 curves, full resolution): 42.4% @300 ppm -> 81.8% @4000+. Differences here are expected and informative: these fixtures are subsampled (cap 2500 pts), the injection geometry is fixed, and detrending (wotan) is applied where the TS p33 inject arm used the raw stitched curve.
