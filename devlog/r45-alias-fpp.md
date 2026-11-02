# R45 - Retire the last placeholder: measuring the harmonic/alias false-positive rate (p110)

Published to the feed via x-post.yml (workflow id 384495786):
  actions/runs/41473461115
  dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
  posted id: `2117280097614934347`
  code commit (CI green at this sha): d61c60875acf693ffa752a0ef9ea1c8424b24299

The decision gate should refuse a candidate for a reason we actually measured, not
because a slot was left blank. Over the last several rounds we filled every blank on
the significance side except one: p103 replaced the noise false-alarm placeholder with a
real per-star measurement, but the harmonic/alias check stayed a blank -- we could count
the sibling peaks of a detection, but not say how likely the detection is to be an alias
of something else.

## What we did
For each of the 9 real multi-sector star systems whose light curves are committed, we
replay the curve at the whole family of alias and harmonic periods near the detected
signal: half the period, one and a half, double, triple, the day-to-day sidelobes and the
season-to-season sidelobes. We ask how many of those would independently look
"significant". That fraction is the measured alias false-positive rate we feed to the
gate in place of the blank.

## What we found
It is high, and that is the honest point: across the 9 systems, 89% of the alias periods
look as significant as the chosen one, and every system's measured value sits far above
the 0.01 the gate would need to wave the alias concern through. HD 39091 is the clean
illustration -- the peak we recover at 3.1 days is exactly half the 6.3-day orbit of its
known planet. After feeding the measured numbers, all 9 systems still land at hold
(novelty, cross-sector, blend and prospective evidence still bind), so the verdict does
not flip.

## Why it matters
The gate's significance inputs now carry no blank slots -- the alias bar refuses for a
measured reason. Honest limit: this is a calibrated ambiguity estimate on the real curve,
not a proof that any given signal IS an alias; confirming a candidate is not an alias
still needs external inputs we do not yet hold. We loosened no threshold to get here.

Reproduce: `npm run p110:alias-fpp`

## Text as pushed

```
Every number a claim rests on should be measured, not assumed. We just closed the
last placeholder inside our decision gate.

The gate holds a transit signal back until its period is shown NOT to be a harmonic or
a sampling alias of something else. Rounds ago we replaced the significance placeholder
with a real per-star measurement; the alias check was still left blank -- we could
count sibling peaks, but not assign them a probability.

p110 measures it. For each of 9 real star systems we replay the light curve across the
whole family of harmonic and window-alias periods around the detected signal and count
how many would ALSO clear the significance bar. The answer is uncomfortable but
honest: 89% of the time an alias looks just as significant as the "real" period. HD
39091 is a textbook case -- the peak at 3.1 days is exactly half the 6.3-day orbit of
its known planet.

Feed those measured values into the gate and every system still lands at "hold" -- but
now the alias test refuses for a reason we measured, not a blank. The gate's
significance side has no unfilled slot left, and we loosened nothing to get here.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
