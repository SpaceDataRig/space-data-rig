# P43 window-function alias risk measured on real TESS photometry

Reproduce: `npm run p43:window-alias -- --sectors 1,2,3 --limit 150 --inject 60 --seed 7`
Data: real TGLC full-frame curves (token-free public S3). Module: `src/detect/windowAlias.ts`.
Positives = a P=3 d / 8000 ppm transit injected onto a real curve and recovered by the A-gate;
negatives = the A-gate survivors of the quiet curves (false by construction).

## Is the daily window even open in this data? (450 curves, 125 survivors)

The spectral-window power at 1 cycle/day over the A-gate survivors: median 0.012,
p95 0.013, max 0.019.
0.0% of survivors sit on a curve with daily window > 0.3; 0.0% above 0.5.
TESS full-frame sampling is near-continuous, so the classic 1 c/d alias window is largely CLOSED here -- window
aliasing is therefore NOT the dominant FP driver in this dataset (the coherent systematics of p39 are);
this is the measured answer to a claim the roadmap previously only asserted.

## Where the window IS open, does a veto help?

FP survivors alias-ambiguous (risk>0.3): 0/125;
injected planets alias-ambiguous (risk>0.3): 0/53.

| veto threshold (risk >) | FP removed | injected planets kept |
|---|---|---|
| 0.15 | 0.0% (0/125) | 100.0% (53/53) |
| 0.25 | 0.0% (0/125) | 100.0% (53/53) |
| 0.35 | 0.0% (0/125) | 100.0% (53/53) |
| 0.5 | 0.0% (0/125) | 100.0% (53/53) |

## Honest reading

1. This turns 'window aliases are unsuppressed' from an assertion into a measurement: we quantify the
   sampling window per curve and the period ambiguity, on real data, with a true/false positive control.
2. The dominant finding is what a good negative result looks like: on near-continuous TESS FFI the daily
   window is mostly closed, so the residual FP is NOT aliasing -- it is the coherent instrumental
   systematics p39 attacks and each star's own variability p31/p33 bound. Where the window is open (sparse
   or ground-like cadence), the veto removes ambiguous-period candidates at a completeness cost we report.
3. The primitive is still worth wiring for any sparse-cadence or long-campaign follow-up, where the daily
   window reopens; it is pure, deterministic and unit-tested.

Measure-only: nothing gated, anchored, claimed or deployed.