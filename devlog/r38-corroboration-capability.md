# x-post dispatch evidence (R38 milestone summary)

- workflow: x-post.yml (id 384495786)
- actions/runs/41364408857 url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41364408857
- dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
- run conclusion: `success` (compose step success; guard passed ASCII + length + over-claim)
- posted id: `2117042818522767865`
- source text bytes: out/tweet-r38en.txt (archived verbatim by devlog-archive)
- R38 code commit (CI green expected): f21a7d363cb4d8613c948dff671c7a7af7dacea3

## Text as pushed

```
A negative result is still a result.

Two independent cross-checks we already run -- a Gaia star-catalogue look and a
per-pixel light-centroid test -- were the last two boxes our evidence gate had
left blank. We asked whether the real, already-held data lets either fill them
in. It does not: Gaia had no orbit at the candidate period for any of the 5 stars
with data, and the centroid test flagged 0 of 59 known blends while it would wave
all 59 through as clean.

Counting a check that catches nothing as corroboration would quietly weaken the
gate, not strengthen it, so we refused. Every target still stops short -- the
real unlock needs fresh observations, not a reshuffle of what we already have.
Numbers are as measured on the committed data.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
