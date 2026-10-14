# P53 PSF-model double-difference imaging vs the naive centroid (P44), on confirmed planets

Reproduce: `npm run p53:psf-diff-imaging -- --targets 24 --tmag 11 --boot 120`
Data: real TESS-SPOC target-pixel cubes (token-free public S3), confirmed-planet catalog
ephemerides. Modules: `src/detect/psfDiffImaging.ts` (under test) vs `src/detect/diffImaging.ts`
(naive, shown unsafe in P44). A confirmed planet transits its host, so any off-target veto is a
FALSE KILL; one false kill disqualifies the gate (measure-before-gate).

Measured on **15** confirmed planets:

| metric (arcsec) | min | p50 | p90 | max |
|---|---|---|---|---|
| PSF-model offset | 0.00 | 19.36 | 54.60 | 73.50 |
| naive diff-image offset | 11.41 | 20.33 | 28.85 | 29.51 |
| full-aperture centroid shift | 0.02 | 0.17 | 0.85 | 1.02 |

At 2.0" the PSF judge forms an opinion on 6/15 planets (naive: 6/15).
PSF verdicts at 2.0": on-target 5, off-target 1, inconclusive 9.

## False-kill sweep (a confirmed planet wrongly vetoed disqualifies the gate)

| threshold (arcsec) | PSF-model false-kills | naive false-kills |
|---|---|---|
| 0.5 | 1/15 | 6/15 |
| 1.0 | 1/15 | 6/15 |
| 1.5 | 1/15 | 6/15 |
| 2.0 | 1/15 | 6/15 |
| 3.0 | 1/15 | 6/15 |
| 5.0 | 1/15 | 6/15 |

## Reading (honest)

On 15 confirmed planets the PSF-model double-difference vetoed **1** at 2.0", down from
**6** for the naive difference-image centroid (P44) on the SAME cubes -- a large reduction, so the
PSF-gradient nuisance plus the displaced-PSF deltaChi2 gate genuinely tames the failure mode that made
the naive centroid unsafe (coherent pointing / focus structure masquerading as an off-axis source).
Still NOT zero false-kills (1 killed); one confirmed planet wrongly vetoed disqualifies the gate (measure-before-gate): the PSF method gets much closer than naive but is not yet safe to gate.

**Veto power is unproven regardless.** Every target here is a confirmed planet (all truly on-target), so
a veto that rarely fires shows safety but NOT the ability to CATCH a real blend -- that needs a labelled
negative class, which public token-free data cannot supply (see scripts/p52). The point-source drop is
also faint on single-sector data, so the judge stays inconclusive on most targets (low amp snr). VERDICT
below keeps safeToGate=false pending both a zero-false-kill sample and a negative-class power test.

**VERDICT: P53-NOT-SAFE-TO-GATE (a PSF threshold still killed a confirmed planet)**

This is a MEASUREMENT, not a deployed gate. Wiring it into the critic / money path is a
separate, operator-authorized step and only after a labelled negative class proves veto power.
discoveryClaim: false.
