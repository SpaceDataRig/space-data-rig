# P33 large-scale completeness / purity ROC (real photometry)

Sample: first 40 TIC-bearing hosts (T<=12, P in [1,13] d) in deterministic
catalog order; 33 had usable public TESS-SPOC curves (<=2 sectors stitched), 7 coverage misses.
Inject period 3 d; depths [300, 500, 1000, 2000, 4000, 8000] ppm; seed 7; match tol 2%.
Detector: iterativeBls maxSignals=3 with production gate (SNR>=7, depth>=200 ppm, depth-regime screen).

| metric | value |
|---|---|
| null curves | 33 |
| gated null detections | 29 |
| true-pos (match known catalog planet) | 12 |
| false-pos | 17 |
| blind FP rate | 51.5% |
| purity TP/(TP+FP) | 41.4% |
| completeness @ 300 ppm | 14/33 (42.4%) |
| completeness @ 500 ppm | 18/33 (54.5%) |
| completeness @ 1000 ppm | 23/33 (69.7%) |
| completeness @ 2000 ppm | 26/33 (78.8%) |
| completeness @ 4000 ppm | 27/33 (81.8%) |
| completeness @ 8000 ppm | 27/33 (81.8%) |
| mean wall-clock per curve (null+6 injects) | 27.86 s |

Reproduce: `npm run p33:scale-roc -- --stars 40 --maxsectors 2 --period 3 --seed 7`
