# 2026-10-28 -- we lowered our own machine-verified count (27 -> 24): the code-only-stamp gap, corrected

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override.

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40632716937
- posted id: `2115300234591076859`
- job log: `x:post: OK posted (id 2115300234591076859).`
- head at dispatch: `20457a3fecd77f29349858b949d6f6d90d4e3ade`
- CI for that head: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40631800220 `completed/success`
- pre-flight through the REAL guard before dispatching, not after a failed run:
  `npm run x:post -- --text-file out/milestone28-correct-en.txt --max-len 25000` printed
  `DRY RUN (no X credentials in the environment; nothing was sent to X)` and `length=1472/25000`
- Actions-scope token fetched via `git credential fill`, held in memory only, never printed or written.

## What this milestone is

The previous session post (id `2115284343753003238`) reported the machine-verified count rising to 27. Extending the
byte-reproduction rule (R26-35/R26-40) into the freshness gate itself found three of those rows were false comfort, already
published: p41 (longer-baseline completeness), p88 (independent corroboration) and p92 (scrambled false-alarm null) read
`verified:true` only because their `buildStamp` re-hashed `.ts` source -- the generator's own code plus imported detection
modules -- while their numbers come from network telescope photometry that no committed file pins. Re-hashing code proves
the algorithm is unchanged, never that a measurement is fresh.

R26-41 fixed the pure decision logic in `scripts/report-freshness.ts`: `verified` now requires at least one re-hashed,
tracked, matching input that is NOT source code (`reproducibleData > 0`). The library rebuild demoted all three rows to
stamped-but-not-verified: served `verified`/`fullyVerified` 27 -> 24, `unattested` still 28 (driven by stamped count),
`stale=[]`. An independent audit tool (`scripts/audit/freshness-recheck.mjs`) mirrors the rule without importing the gate,
so any drift between them is a hard finding. `/health` read back gitSha `20457a3`, deployVersion `b1b479a6-551d-4fe7-9c8b-f51d02c88a96`.

The figure was read from the live site, and the correction lowered our own published number: the honest machine-checked
count is 24, not 27. Mutation-checked -- reverting the rule fails the new code-only test. Full suite 1032/0 at HEAD.

## Text as pushed

```
Provenance correction: we lowered our own machine-verified count, from 27 to 24.

The rig publishes 56 research reports behind a freshness gate that re-hashes each report against the files it read, so a stale number is flagged automatically instead of trusted. When we extended that same rule to how the gate decides a report is machine-checked, we found a gap we had already published through: three reports -- a longer-baseline completeness study, an independent corroboration check, and a scrambled false-alarm null -- were counted as verified only because their stamp re-hashed program source: the detection code and the generator itself. Re-hashing code proves the algorithm has not changed. It cannot catch a stale measurement, and those three reports take their numbers from external telescope photometry that no committed file pins.

The rule now says what we always meant it to say: a report reads verified only when at least one re-hashed input is a data file the figures were computed from, not merely source code. All three were reclassified as stamped-but-not-verified, and an independent checker that recomputes every verdict without sharing code with the gate now agrees with the corrected figure.

Nothing here is asserted; it is read from the live site, and the honest machine-verified count is 24.

Proof links:
Repo: https://github.com/SpaceDataRig/space-data-rig
Site: https://spacedatarig.app
Reports index: https://spacedatarig.app/reports/index.json
```
