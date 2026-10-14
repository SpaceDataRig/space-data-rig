# P58 a larger, phase-refined true-veto 2x2 (priority-0 scale-up)

Reproduce: `npm run p58:veto-2x2 -- --neg 24 --pos 24 --tmag 11 --boot 80 --phases 16`
Same token-free ExoFOP labels as P57 (KP = keep, FP/EB = veto), but with more cases and a
transit-phase refinement: the fold is modulo the period, so we sweep one full period and localize
at the phase of the strongest real dip. This removes catalog-epoch mis-timing -- the likely cause
of P57's single false kill -- as a confound.

**Usable labelled cases: 36** (16 negatives, 20 positives) out of 48 sampled; 12 had no SPOC cube or no coherent transit.

## PSF double-difference -- true 2x2 (phase-refined)

| | labelled blend (should veto) | labelled planet (must keep) |
|---|---|---|
| veto fired | 2 | 1 |
| kept | 14 | 19 |

- veto power (blends caught): **13%** [0.03, 0.36] -- a LOWER bound
- false-veto rate (planets killed): **5%** [0.01, 0.24] -- exact
- ROC AUC: PSF 0.694 vs naive 0.566; naive false-veto rate 40%

**VERDICT: safeToGate = false.** 1 real planet(s) wrongly vetoed (max 0) -- measure-before-gate disqualifies the gate

## Honest reading

Even with the timing confound removed, the FP/EB negative class still contains on-target eclipsing
binaries that a localization veto legitimately cannot reject, so the catch-rate is a lower bound, not
the tool's sensitivity. The disqualifying number is the false-veto rate: any known planet the refined
PSF still kills is a genuine localization failure, and one is enough to keep the gate closed. Nothing
here is wired into the critic / money path; no candidate is cleared; discoveryClaim false.
