# P40 systematics-aware FP gate -- measure-before-gate safety certification

Reproduce: `npm run p40:fp-safety -- --sector 1 --limit 80 --nNull 40 --seed 7`
Data: real TGLC sector 1 curves, common-mode subtracted first (the intended subtract-then-gate posture).
Residual coherent template after subtraction: RMS 44 ppm / peak 268 ppm.

Positive control: a star-specific transit injected onto a REAL corrected curve (real noise, gaps and
residual systematics). A genuine detection is one the production SNR>=7 / depth / plausibility gate
accepts AND whose period matches the injection. The safety number is what fraction of those the
systematics-aware gate would then DECLINE -- it must decline ~none, or the gate is unsafe to enable.

| period | depth ppm | production-detected | declined by sysFAP gate |
|---|---|---|---|
| 2 | 500 | 0 | 0 |
| 2 | 1000 | 0 | 0 |
| 2 | 2000 | 0 | 0 |
| 2 | 4000 | 0 | 0 |
| 2 | 8000 | 3 | 0 |
| 3 | 500 | 1 | 0 |
| 3 | 1000 | 0 | 0 |
| 3 | 2000 | 1 | 0 |
| 3 | 4000 | 4 | 0 |
| 3 | 8000 | 2 | 0 |
| 4 | 500 | 0 | 0 |
| 4 | 1000 | 0 | 0 |
| 4 | 2000 | 0 | 0 |
| 4 | 4000 | 0 | 0 |
| 4 | 8000 | 1 | 0 |
| 5 | 500 | 4 | 0 |
| 5 | 1000 | 7 | 0 |
| 5 | 2000 | 2 | 0 |
| 5 | 4000 | 6 | 0 |
| 5 | 8000 | 7 | 0 |
| 8 | 500 | 0 | 0 |
| 8 | 1000 | 0 | 0 |
| 8 | 2000 | 0 | 0 |
| 8 | 4000 | 0 | 0 |
| 8 | 8000 | 2 | 0 |
| 12 | 500 | 0 | 0 |
| 12 | 1000 | 0 | 0 |
| 12 | 2000 | 0 | 0 |
| 12 | 4000 | 0 | 0 |
| 12 | 8000 | 0 | 0 |

## Totals / verdict

- production-detected genuine transits: **40**
- of those, declined by the systematics-aware gate: **0**
- detection-survival (safety rate): **100.0%** (target ~100%)
- VERDICT: **SAFE-TO-WIRE**

Measure-before-gate: the systematics-aware FP gate may only be wired into the production critic /
candidate contract after this cert shows it declines (near-)none of the real detections. On RAW curves
with a huge coherent systematic the gate correctly declines shallow transits the systematic can explain
(see p39); the production posture is therefore subtract-then-gate. Nothing here gates, anchors, claims
or deploys; wiring into the money path additionally requires explicit operator go-ahead.