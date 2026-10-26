# 2026-10-26 - Round 22: the half-hourly feed stops paying for empty windows

## What was posted

One English long-form post to the project feed describing the round-22 efficiency
pass on the half-hourly science digest: a dependency-free pre-flight that stops
the CI job before any dependency install when the window provably holds nothing
reportable, plus a lockfile-keyed cache of the installed tree so a tick with real
work skips the install on a cache hit. Posting cadence and the feed's volume
protections are unchanged; the pre-flight is conservative by construction (any
missing or untrusted input runs the full path, and a stale cursor hint can only
push toward the full path, never past a real post).

## Preflight (local guard, nothing sent)

`npm run x:post -- --text-file out/push22.norm.txt --max-len 25000` on a
credential-free shell: DRY RUN, length=1791/25000, exit 0, no refusal. The same
normalized bytes were then dispatched and archived below.

## Dispatch evidence

- POST /repos/SpaceDataRig/space-data-rig/actions/workflows/x-post.yml/dispatches
  with body 1865 bytes -> HTTP `204` ACCEPTED at 2026-10-26T06:53:29Z.
- Actions run 40282474381 (workflow_dispatch) completed / success; job digest
  (121438609998) success. The override input short-circuits the digest tiers, so
  the run posted exactly the dispatched text.
- Job log send line: `x:post: OK posted (id 2114611417168986401).`
  -- posted id: `2114611417168986401`
- The same run also shows the new gate behaving: pre-flight logged
  "manual override / verification -> full path", and the install step reported
  skipped on a node_modules cache hit.
- Honesty note: a SECOND, redundant dispatch of the identical text went out at
  2026-10-26T06:56:22Z (run 40282758160, posted id 2114612131865690327) while the
  send path was being re-confirmed after a sequencing mistake. It produced a
  duplicate post of the same text. This archive cites the FIRST dispatch as
  canonical and records the duplicate here rather than omitting it.

## What this changes in the repo

- `.github/workflows/x-post.yml`: cursor-hint cache restore (after checkout, so
  the checkout clean cannot wipe it), the pre-flight step gating setup-node /
  node_modules restore / install / compose, and cache save steps for the
  installed tree and the cursor hint.
- `scripts/x-post-preflight.mjs`: the dependency-free emptiness check (cached
  cursors + two HTTPS reads of the public rig state + local git), exit 42 only
  when the window is provably empty.
- Commits 649b050 (the gate) and c71f984 (restore-order fix found by live
  verification), CI run 40280415375 completed / success.

## Proof links

- https://github.com/SpaceDataRig/space-data-rig/commit/c71f984114408c5b94900469090670143d39c5c8
- https://github.com/SpaceDataRig/space-data-rig/actions/runs/40280415375
- https://github.com/SpaceDataRig/space-data-rig/actions/runs/40282474381

## Text as pushed

```
Round 22 of the Space Data Rig self-audit ships an efficiency pass on the half-hourly science feed. Same cadence, same honesty, much less wasted work per tick.

What changed in the feed's CI job:
- A dependency-free pre-flight now runs before any dependency install. It asks whether the half-hour window could hold something reportable, using the previous run's cached feed cursors, two plain HTTPS reads of the public rig state, and local git. A confident "no" stops the job early; a missing or untrusted input runs the full path as before.
- The installed dependency tree is cached against the lockfile, so a tick with real work skips the install on a cache hit.
- A stale cursor hint can only push toward the full path, not past a real post: a genuinely new result is newer than the true cursor and therefore newer than the hint. The digest composer still makes the whole decision on any tick that reaches it.

Verified live, not just in tests:
- A verification dispatch composed and validated a status heartbeat without posting.
- A tick with no cursor hint ran the full path.
- A tick holding a live blind candidate newer than the cursor ran the full path and posted it (4 flagged candidates, e.g. TOI-1469.02) -- the gate swallowed no real science.
- Each tick since reports the install step as skipped on a cache hit.

Honest scope: no new planet is claimed; flagged blind candidates stay held for human follow-up. Posting frequency and the feed's volume protections are untouched -- this pass removes work that had nothing to report.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/commit/c71f984114408c5b94900469090670143d39c5c8
https://github.com/SpaceDataRig/space-data-rig/actions/runs/40280415375
```
