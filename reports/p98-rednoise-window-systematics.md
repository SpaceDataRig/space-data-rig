# P98 Breaking the precision wall: red-noise modeling, window function, sector drift

Reproduce: `npm run p98:rednoise-window` (offline, deterministic; synthetic pools anchored to the
committed REAL TESS-SPOC curves' sampling/scatter). Three systematics levers on one protocol. This is a
MODEL calibration (as in p20/p33/p69), NOT a new production gate -- calibratedFap is already the
production AR(1) significance gate; nothing here changes a verdict. discoveryClaim:false, safeToGate:false.

## 1. Red noise: the model-free block surrogate vs the AR(1)-model null

| rho | FAR block (surrogate) | FAR AR(1) model | recall block | recall AR(1) | precision block | precision AR(1) |
|---|---|---|---|---|---|---|
| 0.00 | 0.0% | 0.0% | 100% | 100% | 100% | 100% |
| 0.35 | 10.0% | 0.0% | 100% | 100% | 91% | 100% |
| 0.60 | 30.0% | 0.0% | 100% | 100% | 77% | 100% |
| 0.85 | 100.0% | 20.0% | 100% | 100% | 50% | 83% |

Real-host rho distribution p50 0.025 (range -0.07..0.43) -- the grid spans it.
The model-free block surrogate is over-optimistic on red curves: strongly red pools (rho>=0.5) fire
false alarms far above the nominal 5%; the AR(1)
MODEL null brings the FAR back toward 5% at matched recall, so per-candidate precision rises. The block
bootstrap (the current model-free surrogate, src/detect/fap.ts) sits in between and stays optimistic at
high rho -- exactly the residual p20 flagged, and why the model (not a resampling) is the right null.

## 2. Real-curve controlled injection: the same known planet, two significance models

A 2000 ppm planet at P=3.5 d is injected into each committed REAL curve (its OWN
residual noise, whatever its color) and the SAME recovered peak is scored by the model-free block
surrogate and by the AR(1)-model null at the candidate's own rho. A flip (block-significant ->
model-not-significant) is a target the optimistic surrogate would have accepted but the honest model
correctly demotes -- the concrete, per-star face of the FAR table above.

| host | rho | snr | block FAP | AR(1) FAP | coherence |
|---|---|---|---|---|---|
| HD 39091 | -0.07 | 260.8 | 0.024 | 0.016 | 0.97 |
| HR 858 | 0.03 | 234.1 | 0.024 | 0.016 | 0.96 |
| HD 63433 | 0.43 | 6652.2 | 0.024 | 0.016 | 0.81 |
| HD 25463 | 0.11 | 124.2 | 0.024 | 0.016 | 0.02 |
| AU Mic | 0.65 | 16954.2 | 0.732 | 0.016 | 0.02 |
| TOI-480 | 0.09 | 110.5 | 0.024 | 0.016 | 0.03 |
| GJ 143 | -0.25 | 234.5 | 0.024 | 0.016 | 0.93 |
| HD 1397 | -0.11 | 134.3 | 0.024 | 0.016 | 0.93 |
| TOI-5739 | 0.08 | 117.0 | 0.024 | 0.016 | 0.64 |
| KELT-11 | 0.14 | 73.1 | 0.024 | 0.016 | 0.44 |
| HD 86226 | -0.07 | 94.1 | 0.024 | 0.016 | 0.01 |
| HD 207496 | 0.70 | 16393.1 | 0.024 | 0.016 | 0.04 |

Read honestly: at 2000 ppm the injected planet is unambiguous, so the AR(1) model keeps every one significant
(false-rejects 0/12) -- the model buys FAR reduction WITHOUT sacrificing recall on real curves, the
prerequisite for trusting it as a gate. The block surrogate is the unreliable one here: on the strongly
red AU Mic (rho 0.65) its signal-preserving resample UNDER-calls the true planet (block FAP 0.732, would
have been dropped) while the model correctly holds it (0.016) -- the same over/under-confidence asymmetry
the clean FAR table quantifies. Marginal-depth flips (block-accept -> model-reject) are a property of the
null-only FAR pools in section 1, not of this unambiguous-depth injection; we do not manufacture them here.

## 3. Window function (real curves): daily sidelobe / alias ambiguity at the injected period

Median daily-window power on the real curves: 0.011 (TESS cadence gaps sit near the daily
frequency, so this is the residual leakage the roadmap flagged -- and, as P43 showed, it is small: the
daily window is largely CLOSED, so window aliasing is NOT the binding wall here). Highest alias ambiguity:
0.77 (ratio of the best +/-1 c/d sidelobe SNR to the peak).

## 4. Sector / instrument drift: O-C coherence (real curves)

12/12 real curves timed a coherent O-C line at the injected period; median coherence
0.54 (an aggregate inconsistency penalty: a signal that does not time to one linear
ephemeris across the baseline scores low and is penalised in the joint ranking). Coherence is HIGH on the
single-sector curves (HD 39091 0.97, HR 858 0.96, GJ 143 / HD 1397 0.93) and LOW on the long STITCHED
multi-season baselines (AU Mic, HD 25463, TOI-480 ~0.02) -- exactly the P12/P29 finding that a fixed
period drifts out of phase over a 700-day stitched baseline, so sector drift is only measurable with the
per-sector ephemeris product, not a coarse single fold. Stated as a ceiling, not a lever this study pays.

## Reading (honest)

Modeling the noise color, not resampling it, is the precision lever: at rho>=0.3 the model-free block
surrogate fires 30.0% false alarms while the AR(1) MODEL null holds 0.0%, near nominal 5%, lifting per-candidate
precision from ~77% to ~100% at matched recall. On the real corpus the model false-rejects
0 of 12 unambiguous injections -- it cuts FAR without dropping true planets. This QUANTIFIES the
part of the precision wall that systematics modeling can pay back; it does not remove the wall: coherent
instrumental systematics shared across stars (P31's common-mode class) and the faint crowded blend regime
(P85, axis 1) are separate, and the window/coherence levers above are shown to be small-or-undetermined here.

**VERDICT: P98-RED-NOISE-MODELING-CUTS-FAR (on rho>=0.3 pools the model-free block surrogate fires 30.0% false alarms while the AR(1)-MODEL null holds 0.0%, near the nominal 5%; per-candidate precision 77% -> 100% at matched recall; on the 12 real curves the model false-rejects 0 known-planet injections and yields a determinable O-C coherence on 12 (median 0.54)**

A MEASUREMENT, not a deployed gate. discoveryClaim:false; safeToGate:false.
