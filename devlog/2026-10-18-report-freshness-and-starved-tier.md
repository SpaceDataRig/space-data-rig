# 2026-10-18 -- report-freshness verification, and the starved build-note tier

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override.

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39089221538
- posted id: `2111641428334149796`
- job log: `posting override (maxlen=25000): Space Data Rig: what changed in the pipeline, stated plainly.`
  then `x:post: OK posted (id 2111641428334149796)`
- head at dispatch: `43dcf7122915dd46735f671bb9fe8f8f183ff98a`
- pre-flight: ASCII-only, no red-line hits, 2447 chars (ceiling 25000)

One item was deliberately held back from this text: the claim that the posting volume limits had been
removed. That change had not been made yet, so publishing it would have been a false statement about the
rig. It is reported in
[2026-10-18-posting-volume-unrationed.md](2026-10-18-posting-volume-unrationed.md) instead, after the
change shipped.

## Text as pushed

```
Space Data Rig: what changed in the pipeline, stated plainly.

1. The report-freshness gate was counting a timestamp as verification. A report that merely carried a generatedAt field was treated as one whose inputs had been re-hashed and matched. That gap is closed. "verified" now means at least one recorded input sha256 was recomputed and matched; "stamped" means only that a timestamp exists; the two are reported separately instead of being collapsed into a single flattering number.

2. Measured coverage, not claimed coverage: of 48 published reports, 4 are verified, 6 are stamped, 48 carry a timestamp, and 0 are stale. The honest denominator is printed next to the honest numerator, so the 4-of-48 cannot be read as 48-of-48.

3. Four further defects surfaced by the same recheck are fixed: a max_results=1 that the X API v2 rejects with HTTP 400 (the legal floor is 5), a set -eo pipefail that aborted the posting step on a harmless non-zero exit, a CI-only shell path that no offline check could exercise, and a harness referenced from documentation at a gitignored path the next person could not run.

4. The X digest's build-note tier was being starved by its own science tier. Both read one cursor anchored to the newest tweet of any kind, and the build note is reachable only when a window holds no science, so every science post advanced the cursor past commits the build note had never reported. A push of five commits produced one build note covering one commit; two fix commits were consumed and never announced, and nothing on the feed indicated they had been skipped. The tiers now hold separate cursors: science reads the newest tweet, the build note reads the newest build note, recognised by membership in one exported headline list rather than a hard-coded string, because the wording rotates deterministically between runs.

Verified end to end against the live feed, not only against fixtures: a scheduled run logged a dev window anchored to a build note it had found nine hours earlier on the real timeline, then posted. Full test suite 602 of 602 passing, typecheck and lint clean, CI green on both commits.

Nothing here is a new planet. Every candidate this rig produces is UNCONFIRMED and is posted for human follow-up. Reports computed from stand-in data are labelled as such at the source.

Code, history and full methods: github.com/SpaceDataRig/space-data-rig
Live rig and its sealed analyses: spacedatarig.app
```
