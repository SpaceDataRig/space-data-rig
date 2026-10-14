# P44 difference-imaging off-target calibration on confirmed planets

Reproduce: `npm run p44:diff-imaging -- --targets 12 --tmag 10 --boot 200`
Data: real TESS-SPOC target-pixel cubes (token-free public S3), confirmed-planet catalog ephemerides.
Module: `src/detect/diffImaging.ts`. A confirmed planet transits its host, so the difference-image
offset (where flux dropped vs where the starlight is) must be small; its spread defines the veto cut.

Measured on **12** confirmed planets:

| metric (arcsec) | min | p50 | p90 | max |
|---|---|---|---|---|
| difference-image offset | 11.41 | 23.76 | 30.01 | 44.50 |
| legacy centroid shift | 0.03 | 0.18 | 0.49 | 0.57 |

Difference-image snr: min 0.3, p50 1.7, max 10.0 (judge floor 5).
At 2.0" the judge forms an opinion on 3/12 confirmed planets, and it is WRONG on
all of them (3 false-kills): the high-snr planets are still
mislocalized by 14-29" even though they are real transits on their host. This is a SYSTEMATIC bias of
the naive difference-image centroid on real SPOC pixels (coherent pointing / focus structure in the
in-minus-out image), NOT just noise -- so an snr floor reduces the damage (12/12 -> 3/12) but does NOT
make it safe. The full-aperture centroid shift on the SAME cubes stays <= 0.57", so it remains the
robust pixel veto. VERDICT: difference-image centroid localization is NOT safe to gate on this data;
a real discovery-grade version needs proper DRF / PSF-model double-difference imaging, not a centroid.

## False-kill sweep (a confirmed planet wrongly vetoed disqualifies the gate)

| threshold (arcsec) | confirmed planets vetoed |
|---|---|
| 0.5 | 3/12 |
| 1.0 | 3/12 |
| 1.5 | 3/12 |
| 2.0 | 3/12 |
| 3.0 | 3/12 |
| 5.0 | 3/12 |

**Suggested gate: 46.0"** (conservative margin above the observed true-planet spread).
**VERDICT: NOT safe to gate** -- thresholds with zero false-kills do not exist in the sweep.

This is a MEASUREMENT, not a deployed gate. Wiring it into the critic / money path is a
separate, operator-authorized step and only after a larger sample confirms zero false-kills.
discoveryClaim: false.
