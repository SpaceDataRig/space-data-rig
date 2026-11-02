# R43 - The pixel-centroid ceiling: the best it can do, and the wall no score crosses (p109)

Published to the feed via x-post.yml (workflow id 384495786):
  actions/runs/41424740912
  dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
  posted id: `2117194224219377676`
  code commit (CI green at this sha): 93793ea6eaf0db994e7ad70042e4dc122dd84187

For several rounds we declined to promote the pixel-centroid test -- a method that
checks whether a transit signal sits steadily on the target star or drifts toward a
nearby neighbour. p104 said "it catches nothing at our working threshold"; p106 said
"its target signal carries no separation at any threshold". p109 answers the last,
fairest question: what is the absolute best this whole method can reach?

## What we measured
We took every rule the method could use and pushed each to its optimum: the target
signal alone, the neighbour-consistency signal alone, the two-value conjunction our own
harness uses, a combined score, and separate slices by how many neighbouring sources
exist. The best blend-versus-planet separation any of them reaches is an AUC of 0.68 --
weak, and under the 0.7 we would need before trusting it. A striking detail: the
combined score (0.57) is WORSE than the neighbour signal alone, because folding a
useless measurement in with a half-useful one drags the result down.

## The wall no score can cross
Even a higher number would not settle it. The blend/planet labels in this data come
from our own injection-and-validation harness, not from real follow-up imaging of those
exact skies. A test is only as trustworthy as its answer key, and this answer key is
self-graded. Confirming that a dip is a blended neighbour rather than a planet needs a
telescope resolution measurement of the neighbourhood -- the one input we do not have.

So the centroid axis stays a diagnostic, the gate stays shut for any candidate that
would lean on it, and we loosened nothing to reach that conclusion.

Reproduce: `npm run p109:centroid-ceiling`

## Text as pushed

```
We keep refusing to promote a shaky blend-test. This time we measured how shaky.

p109 sweeps every rule the pixel-centroid method could use -- each signal alone, the
pair combined, the two-value conjunction our harness used, a composite score, and a
stratification by how many neighbouring sources exist -- to find its CEILING. The best
blend-versus-planet separation it reaches at any threshold is an AUC of 0.68: weak,
under the 0.7 line we would need to trust it. Folding the useless axis in with the
half-useful one makes things worse, not better (0.57).

A harder limit no number fixes: the blend/planet labels here come from our own
injection harness, not from real follow-up imaging -- so even a higher score would not
be independent confirmation. Clearing a blend for real needs a telescope pointed at the
neighbourhood, the very input we do not yet have. So the axis stays diagnostic and the
gate stays shut -- no loosened bar, no claim.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
