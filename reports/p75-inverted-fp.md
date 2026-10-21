# P75 inverted-curve false alarms: an empirical, model-free check on the AR(1) gate

Reproduce: `npm run p75:inverted-fp` replays the frozen rows offline; `npm run p75:inverted-fp -- --live` re-measures against the live Archive/S3 (and may move the numbers).
This report is an OFFLINE REPLAY of the 200 rows frozen on 2026-10-20T01:48:43Z; the false-alarm rate is byte-stable across runs.

P69 flagged that its masked-residual comparison kept real sibling bumps. This study uses the external
project's cleaner null: on a real TESS-SPOC sector INVERT the curve (dips become bumps), then MASK every
catalogued planet (ground-truth ephemeris, window widened). Only a POSITIVE transit-like residual dip is
kept -- a transit gate never reports a leftover bump -- so each sample is a pure-noise false-transit
candidate, scored under the production AR(1) gate and a model-free block bootstrap on the SAME dip.

| null | false alarms at FAP<0.05 | rate |
|---|---|---|
| AR(1)-model gate | 148/200 | 74% (nominal 5%) |
| model-free block | 64/200 | 32% |

AR(1) passes but model-free rejects: 86/200 (red 1/3, quiet 85/197); mean FAP delta (block-AR1) 0.1869.

**VERDICT: GATE-OPTIMISTIC-ON-REAL-NOISE: on inverted (planet-free) curves the production AR(1) gate signs off 148/200 noise bumps as significant at FAP<0.05 -- 74% >> the nominal 5% -- and the model-free block bootstrap rejects 86 of them; real systematics have tails AR(1) under-states (recovers P69's finding on a CLEAN null). Measured only; threshold unchanged.**

Quantifies the existing gate's calibration on a model-free null; changes no threshold, touches no money path; discoveryClaim false.
