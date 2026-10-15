# P75 inverted-curve false alarms: an empirical, model-free check on the AR(1) gate

Reproduce: `npm run p75:inverted-fp -- --targets 16 --nnull 60 --trials 80 --maxsectors 1`

P69 flagged that its masked-residual comparison kept real sibling bumps. This study uses the external
project's cleaner null: on a real TESS-SPOC sector INVERT the curve (dips become bumps), then MASK every
catalogued planet (ground-truth ephemeris, window widened). Only a POSITIVE transit-like residual dip is
kept -- a transit gate never reports a leftover bump -- so each sample is a pure-noise false-transit
candidate, scored under the production AR(1) gate and a model-free block bootstrap on the SAME dip.

| null | false alarms at FAP<0.05 | rate |
|---|---|---|
| AR(1)-model gate | 12/16 | 75% (nominal 5%) |
| model-free block | 5/16 | 31% |

AR(1) passes but model-free rejects: 7/16 (red 0/0, quiet 7/16); mean FAP delta (block-AR1) 0.1638.

**VERDICT: GATE-OPTIMISTIC-ON-REAL-NOISE: on inverted (planet-free) curves the production AR(1) gate signs off 12/16 noise bumps as significant at FAP<0.05 -- 75% >> the nominal 5% -- and the model-free block bootstrap rejects 7 of them; real systematics have tails AR(1) under-states (recovers P69's finding on a CLEAN null). Measured only; threshold unchanged.**

Quantifies the existing gate's calibration on a model-free null; changes no threshold, touches no money path; discoveryClaim false.
