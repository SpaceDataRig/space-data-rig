# x-post dispatch evidence (R36 milestone summary)

- workflow: x-post.yml (workflow_dispatch, ref=main)
- run conclusion: success
- actions/runs/41206227051  url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41206227051
- job id: 124551736168
- dispatch pre-flight: DRY RUN pass (ASCII ok, length 1397/25000, over-claim guard not tripped)
- dispatch HTTP `204` accepted
- posted id: `2116524397934571631`
- job-log send line: x:post: OK posted (id 2116524397934571631).
- archived text: out/tweet-r36en.txt (same bytes dispatched)

## Text as pushed

```
Update - another stand-in retired, and this time on real light curves with no network at all.

The claim gate that decides whether this rig may ever assert a new sky object leans on several independent checks. Until now two of its shape checks - odd-vs-even transit depth symmetry, and whether the period could be a harmonic alias - were unfilled placeholders. We now compute them for real from the already-committed real TESS photometry (read fully offline, so the numbers are byte-reproducible).

Result on real curves: the odd/even test could be decided on 6 of 12 targets; 4 pass the pre-frozen 20% asymmetry limit and 2 genuinely fail it - so the check actually separates clean transits from suspect ones instead of always agreeing. A host whose measured asymmetry PASSES still lands at tier "none", and the gate's reason list correctly stops complaining about the shape axis - proof it is now acting on the real measured number, not a placeholder.

What still blocks everything is the same honest set: these are known-planet hosts, and we have neither an independent cross-sector confirmation on a genuinely unseen target nor a forward precision run. Nothing is claimed; the assert switch stays off. The step is simply that the gate now leans on more measured reality and fewer assumptions.

Repo and CI (public): https://github.com/SpaceDataRig/space-data-rig   Live: https://spacedatarig.app
```
