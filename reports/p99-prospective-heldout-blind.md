# P99 Prospective held-out blind validation + independent corroboration

Reproduce: `npm run p99:heldout-blind` (offline, deterministic; every input is a committed byte-exact
sealed-truth fixture). This upgrades the rig's RETROSPECTIVE operating point to a PROSPECTIVE blind split,
the held-out truth is sealed and never touches tuning. A validation-METHODOLOGY measurement, NOT a new
gate and NOT a discovery. discoveryClaim:false, safeToGate:false.

## 1. Deterministic split (sealed-truth pool = committed blind.jsonl)

Pool 425 real SPOC host curves (181 injected / 244 null), split by a
stable FNV-1a hash of each TIC. Held-out truth is sealed from every tuning decision below.

- TRAIN 315 (145 injected)  |  HELD-OUT 110 (36 injected) = 25.9% (>= 20% required)

## 2. Operating point tuned on TRAIN only (full grid, frozen argmax accepted-F1)

| depth floor | bar | accepted | accTP | false-acc | accepted-prec | accepted-rec | F1 |
|---|---|---|---|---|---|---|---|
| 0 ppm | 2 | 246 | 107 | 139 | 43.5% | 73.8% | 54.7% |
| 0 ppm | 3 | 106 | 65 | 41 | 61.3% | 44.8% | 51.8% |
| 300 ppm | 2 | 234 | 107 | 127 | 45.7% | 73.8% | 56.5% |
| 300 ppm | 3 | 104 | 65 | 39 | 62.5% | 44.8% | 52.2% |
| 500 ppm | 2 | 212 | 107 | 105 | 50.5% | 73.8% | 59.9% |
| 500 ppm | 3 | 97 | 65 | 32 | 67.0% | 44.8% | 53.7% |
| 800 ppm | 2 | 203 | 107 | 96 | 52.7% | 73.8% | 61.5% |
| 800 ppm | 3 | 94 | 65 | 29 | 69.1% | 44.8% | 54.4% |
| 1200 ppm | 2 | 194 | 107 | 87 | 55.2% | 73.8% | 63.1% <= FROZEN |
| 1200 ppm | 3 | 92 | 65 | 27 | 70.7% | 44.8% | 54.9% |

Frozen point: depth floor 1200 ppm, corroboration bar 2 sectors (train accepted-F1 63.1%).

## 3. Held-out applied with ZERO re-tuning

- verdict distribution: 47 accepted / 19 needs-more-data / 44 rejected
- held-out recall 91.7% CI [78,97]; precision 24.3% CI [18,32]; false-accepts 26
- accepted-under-bar 58 (of which acceptedTP 32); needs-more-data capped 78

## 4. Independent corroboration of survivors

Survivors (held-out curves accepted OR needs-more-data at the frozen point): 66; of these 0.55 fraction are truly injected
(the honest held-out precision of the SURVIVOR class). Two INDEPENDENT committed channels:

- literature cross-match (ExoFOP-validated external.jsonl): 10 survivors match a confirmed host (10 validated).
- Gaia-neighbour centroid clearance (centroid.jsonl testable & labelled planet, i.e. not a blend): 8.
- ANY independent channel corroborated: 11/66 = 16.7%.

## 5. Retrospective -> prospective deviation

Held-out recall differs from the tuning set by 6.8 percentage points and precision by -2.2pp.
A small deviation says the tuned operating point generalizes; a large one exposes retrospective optimism
(the metric the earlier single-sample reports could not, because they tuned and scored on the same curves).

## Reading (honest)

This is a prospective test of the METHOD on a committed sealed-truth fixture, so the answer key is real
but the injected planets are synthetic transits on real host curves (the sanctioned P49/P82 protocol) -- it
calibrates tuning-vs-generalization bias and the corroboration yield, it does not validate against a live
unconfirmed candidate list. The corroboration channels only cover hosts already in the confirmed/Gaia
fixtures, so a low survivor count caps the corroboration-rate precision; all ceilings are stated.

**VERDICT: P99-PROSPECTIVE-HELDOUT-DIVERGENT (tuned on train at 1200ppm/2-sector; applied BLIND to 110 held-out curves: recall 91.7% [dev 6.8pp vs train], precision 24.3% [dev -2.2pp], 26 false-accepts; 66 survivors, 11 independently corroborated (17%) via literature 10 + Gaia-cleared 8; held-out diverges -- the tuned point was optimistic (retrospective bias quantified))**

A validation METHODOLOGY, not a deployed gate. discoveryClaim:false; safeToGate:false.
