# x-post dispatch evidence (R37 milestone summary)

- workflow: x-post.yml (id 384495786)
- actions/runs/41287858368 url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41287858368
- dispatch HTTP `204` accepted (override inputs.text + maxlen 25000)
- run conclusion: `success` (compose step success; guard passed ASCII + length + over-claim)
- posted id: `2116805577632522610`
- compose log line: `x:post: OK posted (id 2116805577632522610).`
- source text bytes: out/tweet-r37en.txt (archived verbatim by devlog-archive)
- R37 code commit (CI GREEN, digest+checks success): f700ec9284e2d9718962d9a2f2ead1a4748c13a7
- backfill confirmation after the spend cap lifted: run 41286881361 posted id 2116802095231938722

## Text as pushed

```
Progress on the evidence gate that a real find must pass.

We folded every measurement we trust into one per-star decision table (p103):
cross-sector agreement, transit shape, catalog status, and a significance
false-alarm rate now computed per star from that star's own light-curve noise
instead of left blank.

On 9 real TESS stars: significance clears 9/9, cross-sector 4/9, shape 4/9. All
9 still land at the lowest tier -- correctly -- because each is already a
catalogued system, and we have not run independent follow-up imaging or a
forward validation on any of them. The gate refuses on the right grounds, not
because a number is missing. A real announcement would take a star no survey has
flagged before; that is not something you can build out of catalogued ones.

Code and reports: https://github.com/SpaceDataRig/space-data-rig
Live rig: https://spacedatarig.app
```
