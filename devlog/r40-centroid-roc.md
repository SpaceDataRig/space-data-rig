# x-post dispatch evidence (milestone summary)

- workflow: x-post.yml (id 384495786)
- actions/runs/41396984042 url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41396984042
- dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
- run conclusion: `success` (compose step success; guard passed ASCII + length + over-claim)
- posted id: `2117134005053399392`
- code commit (expected CI green): 412a5250a6fadd5cfbf3f065ffc003c443d59d20

## Text as pushed

```
A test that never worked, now proven to never work.

We use a light-centroid check as a cross-examination: when a star's dimming might
belong to a neighbouring blob, does it line up with the star itself? At one setting
it had flagged 0 of 59 known blends, so we would not trust it. This time we swept
every setting at once. Across 114 real stars with known labels, its target score
separates blend from planet with an AUC of 0.48 -- a coin flip -- and even the best
cut only reaches 0.63 on / 0.49 off.

Conclusion: no threshold rescues it, so it stays out of the decision gate. A check
that cannot tell the two apart is worse than useless as evidence -- it would let
false alarms pass. Numbers are as measured on the committed data.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
