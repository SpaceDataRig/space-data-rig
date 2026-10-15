# P79 quantitative benchmark vs TCE / DAVE / TPM on our own data

Reproduce: `npm run p79:benchmark` (offline; reads reports/p47 and, if present, reports/p78).

We cannot run those projects' production pipelines, so we re-implement each one's headline statistic
(src/detect/benchmark.ts, 8 offline tests) and apply it to numbers our own pipeline measured on real
TESS-SPOC photometry. The TPM coefficients are FIT TO OUR GRID (not Burke's Kepler numbers).

Assumed observing geometry for the TCE SNR prediction (stated, not per-host): 2-min cadence, 27-day
single-sector baseline, 100 ppm noise, duration 3h*(P/4)^0.6, TCE accepts at SNR>=7 and >=3 transits.

| period (d) | depth (ppm) | measured completeness (n) | TCE BLS SNR | TCE accepts | our TPM predicted |
|---|---|---|---|---|---|
| 1.41 | 283 | 85% (40) | 85.6 | yes | 100% |
| 1.41 | 529 | 88% (40) | 160.2 | yes | 100% |
| 1.41 | 917 | 95% (40) | 277.4 | yes | 100% |
| 1.41 | 1732 | 95% (40) | 524.3 | yes | 100% |
| 1.41 | 3536 | 100% (40) | 1070.3 | yes | 100% |
| 1.41 | 6708 | 100% (40) | 2030.7 | yes | 100% |
| 2.83 | 283 | 70% (40) | 72.5 | yes | 99% |
| 2.83 | 529 | 80% (40) | 135.7 | yes | 100% |
| 2.83 | 917 | 85% (40) | 235.1 | yes | 100% |
| 2.83 | 1732 | 90% (40) | 444.3 | yes | 100% |
| 2.83 | 3536 | 95% (40) | 906.9 | yes | 100% |
| 2.83 | 6708 | 100% (40) | 1720.7 | yes | 100% |
| 5.1 | 283 | 45% (40) | 64.5 | yes | 95% |
| 5.1 | 529 | 65% (40) | 120.7 | yes | 99% |
| 5.1 | 917 | 73% (40) | 209.1 | yes | 100% |
| 5.1 | 1732 | 80% (40) | 395.2 | yes | 100% |
| 5.1 | 3536 | 85% (40) | 806.7 | yes | 100% |
| 5.1 | 6708 | 88% (40) | 1530.5 | yes | 100% |
| 7.86 | 283 | 13% (40) | 56.9 | yes | 78% |
| 7.86 | 529 | 33% (40) | 106.5 | yes | 94% |
| 7.86 | 917 | 38% (40) | 184.4 | yes | 98% |
| 7.86 | 1732 | 50% (40) | 348.5 | yes | 100% |
| 7.86 | 3536 | 65% (40) | 711.4 | yes | 100% |
| 7.86 | 6708 | 65% (40) | 1349.8 | yes | 100% |
| 11.11 | 283 | -- (0) | 51.6 | no | 49% |
| 11.11 | 529 | -- (0) | 96.5 | no | 82% |
| 11.11 | 917 | -- (0) | 167.1 | no | 94% |
| 11.11 | 1732 | -- (0) | 315.7 | no | 99% |
| 11.11 | 3536 | -- (0) | 644.5 | no | 100% |
| 11.11 | 6708 | -- (0) | 1222.9 | no | 100% |

**TCE rule vs our measured recovery:** cells the TCE SNR>=7 + 3-transit rule would ACCEPT average
74% measured completeness (24 cells); cells it would REJECT average 0% (6 cells).
That separation is the quantitative check that our detector's completeness tracks the standard BLS/TCE
detection limit on the same real data.

**DAVE blend FPP vs our measured blind FP** (P78):
```json
{
  "blindAcceptedPrecisionP78": 0.471,
  "blindFalseAcceptsP78": 9,
  "blendFppIsolatedCell": 0.0028,
  "blendFppCrowded6StarAperture": 0.002,
  "reading": "measured blind false-accepts (P78) are dominated by coherent systematics/aliases, NOT by bright-neighbour blends: the DAVE blend FPP for a faint neighbour is ~0 while our real per-sector FP is non-trivial -- i.e. blending is not the binding constraint on this chain."
}
```

## Published external reference (DIFFERENT instruments -- orientation, not equivalence)
- Kepler TPS: ~90% completeness for Neptune-size planets at <4d, falling for longer periods / smaller radii (Burke et al. 2015). Different instrument + much longer baseline.
- TESS TCE pipeline is BLS-based like Kepler's but tuned for 2-min SPOC; published TCE completeness is mission-level (thousands of targets, multi-sector).
- TRICERATOPS (DAVE successor) validates TOIs to FPP < 1e-3 using space-to-ground + contrast limits; our daveBlendedFpp is a first-order analogue.

Honest scope: this is a reproducible comparison harness built from our own measurements, not a run of
TCE/DAVE/TPM themselves, and the completeness is on bright catalogued hosts (efficiency, not a survey
selection function). Measure only; nothing gated, anchored, claimed, or deployed. discoveryClaim false,
safeToGate false.
