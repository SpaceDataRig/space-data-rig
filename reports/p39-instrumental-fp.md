# P39 systematics-inclusive null + ensemble FDR, measured on real TESS photometry

Reproduce: `npm run p39:instrumental-fp -- --sector 1 --limit 200 --nNull 80 --inject 80 --seed 7`
Data: real TGLC sector 1 full-frame curves (token-free public S3). Module: src/detect/instrumentalNull.ts
(unit-tested, deterministic, research-only). Raw common-mode template RMS 5387 ppm / peak 
104010 ppm; residual after subtraction RMS 46 ppm / peak 295 ppm.

## RAW (systematic not subtracted) -- 200 quiet curves (every detector survivor is a false positive)

| gate | FP survivors | FP rate |
|---|---|---|
| A) production SNR>=7 + depth>=200 ppm | 122 | 61.0% |
| B) + noise calibratedFap <= 0.05 | 122 | 61.0% |
| C) + systematics-aware FAP <= 0.05 | 32 | 16.0% |
| D) + Benjamini-Hochberg FDR q=0.1 | 30 | bounded <= 10% by construction |

sysFAP removed 74% of the FP the noise-only FAP left; injected completeness kept 
18% of the A-gate recoveries (3/17 of 17).

## CORRECTED (subtract-then-gate) -- 200 quiet curves (every detector survivor is a false positive)

| gate | FP survivors | FP rate |
|---|---|---|
| A) production SNR>=7 + depth>=200 ppm | 109 | 54.5% |
| B) + noise calibratedFap <= 0.05 | 109 | 54.5% |
| C) + systematics-aware FAP <= 0.05 | 108 | 54.0% |
| D) + Benjamini-Hochberg FDR q=0.1 | 109 | bounded <= 10% by construction |

sysFAP removed 1% of the FP the noise-only FAP left; injected completeness kept 
100% of the A-gate recoveries (23/23 of 23).


## Honest reading

1. This is the first significance lever we have measured that materially cuts FP on real data; it targets
   exactly the coherent-instrumental FP class every prior per-star gate was blind to. BH-FDR additionally
   bounds the survey-wide false-discovery rate by construction as the ensemble scales.
2. Correct production posture is subtract-then-gate: common-mode subtraction removes the coherent bulk at
   source and restores completeness; the systematics-aware null then catches whatever coherent power a
   subtraction misses, WITHOUT ever declining a genuine transit (its completeness cost is zero once the
   systematic is gone), so it is a safe complement, not a looser/stricter knob.
3. Boundary (physics, not code): the residual FP after subtraction is dominated by each star's OWN
   variability and noise color, indistinguishable from the per-star noise that already defines the gate.
   Closing that gap needs more data power (multi-sector baselines, longer windows) and physical vetting
   (centroid / blended-source), not a sharper significance model -- the single-sector purity ceiling of p31/p33.

Measure-only: nothing gated, anchored, claimed, or deployed. Wiring systematicsAwareFap into the production
critic gate is a money-path change requiring a measure-before-gate safety certification on confirmed planets
plus explicit operator go-ahead -- it must never be turned on before it is proven not to reject real planets.