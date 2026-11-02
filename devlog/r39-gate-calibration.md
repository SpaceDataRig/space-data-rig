# x-post dispatch evidence (milestone summary)

- workflow: x-post.yml (id 384495786)
- actions/runs/41378082168 url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41378082168
- dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
- run conclusion: `success` (compose step success; guard passed ASCII + length + over-claim)
- posted id: `2117081886002466919`
- code commit (expected CI green): 5377d64ff5b4c53c1fc38ac44289ab06f3a29162

## Text as pushed

```
How do you trust a system that keeps saying no?

We graded the evidence gate like a classifier. Every star in our committed set is
an already-known planet, so the only correct verdict for each is "hold". Across all
12 such stars the gate said exactly that -- 12 out of 12, zero wrong green-lights.
A Wilson lower bound on that reliability sits at 0.757, and we quote the low
number on purpose: it is honest about how few labelled stars it has been checked
against, and it is why more real targets matter.

What held data can show is that the gate does not cry wolf. Showing it would flag a
genuine new one needs a star nobody has logged before -- that arm stays synthetic
for now.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
