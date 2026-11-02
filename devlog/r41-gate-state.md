# R41 - One machine-verified attestation of the whole earned gate (p107)

Published to the feed via x-post.yml (workflow id 384495786):
  actions/runs/41402360583
  dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
  posted id: `2117147151243366504`
  code commit (CI green at this sha): e698cba69528cd52db092ff2f3ae747937a27942

Rounds R32-R40 fed the automated decision gate every axis that real, committed data
can support, and proved which axes it cannot. That verdict was scattered across six
separate reports. p107 gathers it into a single per-bar scoreboard -- and, crucially,
it does not simply trust those reports: it re-computes every shared number from the
six sources and refuses to pass unless they all agree.

## What it verifies
The six studies came from different rounds reading different inputs. If any two ever
disagreed about a number they share, that would be a silent defect. p107 checks the
overlaps and they hold (all twelve cross-report consistency checks pass): the
labelled-negative count equals the decision-table targets plus the capability-round
overlap hosts; the two-or-more-sector count from the cross-sector round equals the
cross-sector clear count in the decision table; the centroid caught-count and its
threshold agree between the capability and ROC rounds; the astrometry round has zero
decisive rulings; the calibration round has zero false promotions; and every real host
sits at tier none and is already catalogued.

## The honest state of the gate (nine evidence bars)
- filled with real per-target measurements: 3 (significance, cross-sector
  corroboration, odd/even transit shape)
- correctly unmet because every real target we hold is already known: 1 (novelty)
- diagnostic only, not yet a calibrated probability: 1 (harmonic-alias counts)
- proven unsupportable from any committed data: 2 (the astrometry blend ruling, which
  is non-decisive on every host it holds; and the pixel-centroid imaging proxy, which
  a full ROC shows cannot separate blends from planets at any threshold)
- established only on simulated signals: 1 (prospective precision)
- a human sign-off rule, never automated: 1

## Reading
The gate is not stalled for want of numbers. It holds every candidate back because
the last few bars need observations we genuinely do not have yet -- an uncatalogued
target, astrometric orbits at the candidate period, real difference-imaging, and a
prospective run on new sky. We would rather say that plainly than loosen a bar.

## Guards
discoveryClaim false, safeToGate false. Fully offline over committed, tracked files;
a downstream attestation that goes stale if any upstream round changes. A test
re-derives the key cross-report equalities independently, so editing this report
alone cannot fake a green result. One feed phrasing tripped the posting guard's
money-wording check and was reworded before sending; the guard was not relaxed.

Reproduce: `npm run p107:gate-state`

## Text as pushed

```
Over eight rounds we fed one decision gate, then finally asked: what does the whole
thing say, together?

p107 gathers it into a single scoreboard that re-computes every shared number from
the six underlying studies and refuses to go green unless they all agree -- 12 of 12
cross-checks pass. Of nine evidence bars: 3 are now filled with real per-star
measurements, 1 is correctly unmet because every target we hold is already known, 1
is diagnostic only, 2 cannot be filled by any data we have, 1 is proven only on
simulated signals, and 1 is a human sign-off rule.

The honest headline: the gate is not stalled for lack of numbers. It holds every
candidate back because the last few bars need observations we genuinely do not have
yet -- and we would rather say that than loosen a bar.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
