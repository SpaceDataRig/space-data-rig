# P96 occurrence-rate kernel and forward-model consistency check

Reproduce: `npm run p96:occurrence-kernel -- --nstars 12 --refEta 1.1 --refSigma 0.16 --refPeriodMax 30`

Real selection integral from the committed P47 grid (960 injections on real photometry) x Keplerian geometry, over **P=[1,9.5] d, Rp~>1.5 R_earth** (solar-twin reference):

**S = 0.0995** -- the mean probability that a planet in this box is BOTH geometrically transiting and detected by the pipeline. This is a citable sensitivity number.

Field anchor (Gillis et al. 2025/2026, AJ): **1.1 +- 0.16 planets/star, R>1 R_earth, P<30 d**. Log-uniform period overlap onto our window = 0.662 -> eta_box ~ 0.728.

**Forward model** over a hypothetical UNBIASED sample of 12 stars: expect 0.87 transiting detections (band 0.74-1.00). The pipeline actually recovered **8** known planets on its deliberately planet-bearing 12-host sample -- observed 8 vs expected 0.87: 2.09 sigma, 2-3 sigma (tension).

A naive inversion would give eta=6.700 /star (Gehrels 3.90-9.63); we DO NOT report this as a measurement -- it is inflated by the biased host selection and the small N, shown only to prove the kernel runs.

**VERDICT:** KERNEL-CONSISTENT (order-of-magnitude): the measured selection integral S=0.0995 over P=[1,9.5]d, Rp~>1.5 R_earth is the real, citable sensitivity of this pipeline; pushing the field's 1.1+-0.16/star rate through it predicts 0.87 transiting detections over an unbiased sample of 12, and the pipeline recovered 8 on its deliberately planet-biased 12-host sample (observed 8 vs expected 0.87: 2.09 sigma, 2-3 sigma (tension)). We report NO measured eta: a selection function built on bright confirmed-planet hosts cannot support a rate, and we say so. The kernel (src/sim/occurrenceRate.ts, 7 unit tests) is validated and ready for an unbiased target list. discoveryClaim false.

| period centre (d) | geometric prob | mean completeness |
|---|---|---|
| 1.50 | 0.1813 | 0.938 |
| 3.00 | 0.1142 | 0.866 |
| 5.25 | 0.0787 | 0.724 |
| 8.00 | 0.0594 | 0.439 |

Honest bounds: S is real and citable; the consistency check validates kernel wiring and bias direction, not a rate; nothing wired into the critic or money path; discoveryClaim/safeToGate false.
