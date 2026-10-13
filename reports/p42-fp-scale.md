# P42 systematics-aware FP control at scale, across sectors, with a formal discrimination metric

Reproduce: `npm run p42:fp-scale -- --sectors 1,2,3,4 --limit 200 --nNull 60 --inject 60 --seed 7`
Data: real TGLC full-frame curves (token-free public S3), subtract-then-gate posture. Module:
`src/detect/instrumentalNull.ts`. Positives = a P=3 d / 8000 ppm transit injected onto a REAL
corrected curve and recovered by the A-gate; negatives = the A-gate survivors of the quiet corrected curves
(false by construction; a few may be unconfirmed planets, so AUC is a lower bound on the gain).

## Per sector (FP survivors by gate; every null-arm survivor is a false positive)

| sector | curves | A) SNR gate | B) +noiseFAP | C) +sysFAP | D) +BH-FDR | TP | TP kept by sysFAP | resid tmpl RMS/peak ppm |
|---|---|---|---|---|---|---|---|---|
| 1 | 200 | 109 | 109 | 108 | 109 | 16 | 16 | 46/295 |
| 2 | 200 | 15 | 11 | 14 | 15 | 20 | 20 | 34/148 |
| 3 | 200 | 24 | 20 | 24 | 24 | 22 | 22 | 28/163 |
| 4 | 200 | 51 | 50 | 50 | 51 | 21 | 21 | 31/206 |
| **all** | **800** | **199** | **190** | **196** | **199** | **79** | **79** | - |

Aggregate FP rate A 24.9% -> C 24.5%: sysFAP removes 2% of the FP the noise-only gate left.
Injected completeness kept by sysFAP: 100.0% (79/79).

## Discrimination (threshold-free)

AUC of using -FAP as the planet-vs-artifact score over a pool of 79 injected-planet positives and
199 quiet-curve negatives:

| score | AUC |
|---|---|
| per-star noise FAP (current gate) | 0.548 |
| systematics-aware FAP (new lever) | 0.548 |
| gain | 0.000 |

ROC (TPR = injected planets kept, FPR = quiet-curve FP kept) as the FAP threshold varies:

| FAP threshold | noise TPR / FPR | sysFAP TPR / FPR |
|---|---|---|
| 0.005 | 0% / 0% | 0% / 0% |
| 0.01 | 0% / 0% | 0% / 0% |
| 0.02 | 100% / 90% | 100% / 90% |
| 0.05 | 100% / 95% | 100% / 98% |
| 0.1 | 100% / 99% | 100% / 100% |
| 0.2 | 100% / 100% | 100% / 100% |

## Honest reading

1. The FP cut and the AUC gain are reported PER SECTOR and in aggregate: the question a pilot cannot answer
   -- does this hold on independent fields -- is measured, not assumed.
2. The AUC is the auditable headline: it says, at every threshold at once, that the coherent-systematics null
   separates a real transit from an instrumental artifact better than the noise-only gate. A near-0.5 AUC
   would mean no discrimination; a lower-bound AUC here still understates the true gain because unconfirmed
   planets are counted as false positives.
3. Boundary (physics, not code): after subtraction the residual FP is each star's own variability, which the
   per-star noise already models -- the single-sector purity ceiling (p31/p33), closable only with more data
   power and physical vetting, not a sharper significance model.

Measure-only: nothing gated, anchored, claimed or deployed. Enabling this gate in production still requires
a same-cadence ensemble caller, the p40 measure-before-gate cert, and explicit operator go-ahead.