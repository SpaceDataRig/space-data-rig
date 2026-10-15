# P69 is the AR(1)-model significance gate faithful to real red noise?

Reproduce: `npm run p69:rednoise-significance -- --targets 10 --nnull 100 --trials 100`

The production gate calibrates against an AR(1) null matched to lag-1 rho. This study masks the transit
on real known-planet hosts and compares, on the SAME noise-only residual bump, the AR(1)-model FAP against
a model-free block-bootstrap FAP that preserves the true autocorrelation beyond lag 1.

| bucket | hosts | mean (block - AR1) FAP delta | bumps AR1 passes but block does not |
|---|---|---|---|
| quiet (rho<=0.2) | 8 | 0.2661 | 5 |
| red (rho>0.2)    | 2 | 0.0990 | 2 |

Mean AR(1)-ACF excessAtLastLag = -0.014 (positive = residuals have longer memory than AR(1)).
Flips at FAP<0.05: all 7/10, noise-like 5/8.

**VERDICT: AR1-MODEL-NULL-TOO-PERMISSIVE vs the model-free reference: on 5/8 genuine noise bumps the production AR(1)-model null clears FAP<0.05 while the block bootstrap (same real noise) does not (mean delta 0.266); the synthetic AR(1) ensemble understates real residual tails. This is NOT an active-star effect (quiet mean delta 0.266 >= red 0.099, excessAtLastLag -0.01 <= 0). CAVEAT: transit-masked residuals on multi-planet hosts keep real coherent sibling signals (max resSnr 1172), so a fully clean calibration needs planet-free real windows, not masked multi-planet curves.**

Measures calibration of the existing gate; changes no threshold, touches no money path; discoveryClaim false.
