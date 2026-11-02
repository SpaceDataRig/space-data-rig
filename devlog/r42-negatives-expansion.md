# R42 - Grow the gate's specificity bound with every real known-planet host (p108)

Published to the feed via x-post.yml (workflow id 384495786):
  actions/runs/41420542121
  dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
  posted id: `2117186456481415273`
  code commit (CI green at this sha): 1b60064927617e473f75713c0822fa8a5d2fe74f

The decision gate has refused every real candidate we feed it. Is that caution or
competence? p108 puts a number on it. p105 had bounded the gate's true-rejection rate
on the 12 real hosts it could reach, and honestly called 0.757 a small-sample figure.
The committed data set actually holds 3 more real known-planet systems that were
never used -- HD 63433, TOI-5739 and KELT-11 -- skipped only because each was
observed in a single sector. Their curves are committed and their systems are
catalogued, so they are legitimate labelled negatives: cases where the correct answer
is "no new planet".

## What was done
For each single-sector system, the real transit period and signal-to-noise were taken
from the earlier shape audit (p102), a false-alarm rate was measured against a noise
model matched to that curve's own variability, and the result was fed through the
frozen gate exactly as the multi-sector hosts were. All three land at tier none.
Pooling them grows the labelled-negative set from 12 to 15 -- the gate refuses every
one, zero false promotions -- and the 95% lower bound on the true-rejection rate
tightens from 0.757 to 0.796. A test re-derives the bound and the ceiling independently
from the same function the gate uses, and confirms the new hosts are genuinely new
(no overlap with the earlier sets), so nothing is double-counted.

## Two honest edges
- A ceiling stated as a number, not a mood: to clear the protocol's own 0.95 precision
  bar on a zero-false-claim bound we would need at least 73 clean real negatives. We
  hold 15. The remaining gap is the sample size of real labelled planets, not the
  method.
- A detection-reliability observation: on 2 of the 3 single-sector systems the
  strongest signal did not even match the known planet. One patch of sky mis-detects
  even a familiar target -- which is exactly why the gate demands corroboration across
  independent sectors before it will entertain a claim.

The other direction -- promoting a genuinely novel signal -- is still established only
on simulated streams, and that asymmetry is stated, not hidden.

Reproduce: `npm run p108:negatives-expansion`

## Text as pushed

```
The decision gate has refused every real candidate we feed it. Is that caution, or
competence? We put a number on it.

p108 folds in 3 more real known-planet systems we had left unused (each seen in only
a single sector), so the labelled set the gate must correctly reject grows from 12 to
15. It refuses all 15 -- zero false promotions -- and the 95% lower bound on its
true-rejection rate tightens from 0.757 to 0.796.

Two honest edges. A ceiling stated as a number: to clear the protocol's 0.95 bar we
need at least 73 clean real negatives, and we hold 15 -- the gap is sample size, not
method. And on 2 of the 3 single-sector systems the strongest signal did not even
match the known planet: one patch of sky mis-detects even a familiar target, which is
precisely why we demand corroboration across independent sectors.

The other direction -- promoting a genuinely novel signal -- is still established
only on simulated streams, and we say so plainly.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
