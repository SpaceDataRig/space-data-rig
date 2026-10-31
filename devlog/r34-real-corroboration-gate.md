# x-post dispatch evidence (R34 milestone summary)

- workflow: x-post.yml (workflow_dispatch, ref=main)
- run id: 41168109281  conclusion: success  url: https://github.com/SpaceDataRig/space-data-rig/actions/runs/41168109281
- job id: 124439971569
- dispatch pre-flight: DRY RUN pass (ASCII ok, length 1479/25000, over-claim guard not tripped)
- dispatch HTTP `204` accepted
- posted id: `2116384645399085112`
- job-log send line: posted (id 2116384645399085112).
- archived text: out/tweet-r34en.txt (same bytes dispatched)

## Text as pushed

```
Update - a real-data step on the claim gate.

The gate that decides whether this rig may ever assert a new sky object was, until now, running one of its checks on a modelled stand-in: "is the same transit really seen in more than one observing sector?" We replaced that stand-in with a real measurement. The rig now re-downloads the sector-by-sector light curves of a set of real TESS targets straight from the public data bucket, cleans each one, recovers the strongest repeating dip, and counts how many sectors independently show it above a threshold we froze in advance.

Result on real bytes: across 9 multi-sector targets, 4 had at least two sectors independently flagging the same period - corroboration actually measured, not assumed. But every one of these targets is a star that already has a known planet, so the gate correctly refuses to assert anything and reports tier "none". A deliberately generous second test (pretend the signal were new, keep every other value real) still lands at "none", so a single flipped property is nowhere near enough on its own.

We also added a test that recomputes the published numbers straight from the frozen measurements, and proved it turns red if any number is inflated by hand. Nothing is claimed; the assert-a-planet switch stays welded off. The real forward step is simply that the gate now consumes measured real evidence.

Repo and CI (public): https://github.com/SpaceDataRig/space-data-rig   Live: https://spacedatarig.app
```
