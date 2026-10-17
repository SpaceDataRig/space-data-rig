# P89 multi-epoch PSF diff-imaging -- a real veto 2x2 with a labelled negative class

Reproduce: `npm run p89:multiepoch-di -- --pos 6 --neg 8 --max-sectors 2 --tmag 13 --boot 60`

The PSF double-difference localizer is run for 2 confirmed planets (must keep) and 3 community FP/EB blends (should be caught), each across up to 2 covering sectors. A target is vetoed if ANY epoch places the transit flux more than 2 arcsec off the host with sufficient amplitude/shape significance.

| | labelled blend (should veto) | labelled planet (must keep) |
|---|---|---|
| DI localizes off-target | 0 | 2 |
| DI does not | 3 | 0 |

- veto power (blends caught): 0.00 [0,0.5615060804490177]
- false-veto (real planets wrongly killed): 2 of 2 (1.000) -- any > 0 disqualifies
- AUC (max off-target offset, blend vs planet): 0.000

**VERDICT: safeToGate = false.** 2 real planet(s) wrongly vetoed (max 0) -- measure-before-gate disqualifies the gate

Multi-epoch PSF diff imaging is a genuine localization test (does the dip move OFF the host across independent
epochs?), strictly stronger than the single-epoch P58 veto; but it can only fire where a SPOC target-pixel cube
exists and is measurable. research-only; discoveryClaim false; nothing anchored, gated, or deployed.
