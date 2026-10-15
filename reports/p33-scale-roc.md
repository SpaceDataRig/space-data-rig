# P33 large-scale completeness / purity ROC (real photometry)

Sample: first 250 TIC-bearing hosts (T<=12, P in [1,13] d) in deterministic
catalog order; 204 had usable public TESS-SPOC curves (<=2 sectors stitched), 46 coverage misses.
Inject period 3 d; depths [300, 500, 1000, 2000, 4000, 8000] ppm; seed 7; match tol 2%.
Detector: iterativeBls maxSignals=3 with production gate (SNR>=7, depth>=200 ppm, depth-regime screen).

| metric | value |
|---|---|
| null curves | 204 |
| gated null detections | 222 |
| true-pos (match known catalog planet) | 118 |
| false-pos | 104 |
| blind FP rate | 51.0% |
| purity TP/(TP+FP) | 53.2% |
| completeness @ 300 ppm | 73/204 (35.8%) |
| completeness @ 500 ppm | 109/204 (53.4%) |
| completeness @ 1000 ppm | 144/204 (70.6%) |
| completeness @ 2000 ppm | 166/204 (81.4%) |
| completeness @ 4000 ppm | 181/204 (88.7%) |
| completeness @ 8000 ppm | 190/204 (93.1%) |
| mean wall-clock per curve (null+6 injects) | 28.11 s |

Reproduce: `npm run p33:scale-roc -- --stars 250 --maxsectors 2 --period 3 --seed 7`
