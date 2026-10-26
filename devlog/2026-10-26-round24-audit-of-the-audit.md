# Evidence for this post

Dispatched through `.github/workflows/x-post.yml` (`workflow_dispatch`, `inputs.text` override, `inputs.maxlen=25000`),
so the text below is the bytes the pipeline actually sent, not a re-typed copy.

- Local guard, same code path as the runner: `npm run x:post -- --text-file out/push24.norm.txt --max-len=25000`
  -> DRY RUN, `length=4009/25000`, exit 0, zero non-ASCII bytes. Note for the record: an earlier invocation of mine
  used `--maxlen` (one missing hyphen), the flag was ignored, the ceiling fell back to 280 and the guard printed a
  green verdict over a 279-character stump. That accident is defect F16, now fixed to refuse; this run used the
  correct flag and the full length above is what went out.
- Proof links verified before dispatch: all five commit URLs and both Actions-run URLs returned HTTP 200 through the
  authenticated GitHub API (commits `28d21d2`, `4fda62a`, `6db6a50`, `93e9d2a`, `cbe89ea`; runs `40303969337`
  completed/failure, `40314534307` completed/success on `cbe89ea`), and `https://spacedatarig.app/` returned 200.
  The public `github.com` HTML pages were NOT reachable from this sandbox (connect timeout on every attempt, as in
  rounds 22 and 23), so reachability is asserted against the authenticated API and that limitation is disclosed
  rather than presented as a passing click-test.
- Dispatch: HTTP `204` ACCEPTED at 2026-10-26T11:40:21.496Z (request body 4110 bytes). Dispatched exactly once; no
  retry, no second dispatch.
- Run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40316795045 -- completed / success. Install step
  skipped on a `node_modules` cache hit; the pre-flight took the manual-override path; `x:post: OK posted` in the
  job log with posted id: `2114683600662606125`.
- Content claims, all read off committed artifacts or live endpoints during this round: 0 skips over the 10 runs
  after the gate shipped; 1 window proved empty and failed the job; 60 runs pulled for the auditor check with the
  skip marker landing on 1 run; the ceiling arithmetic 13 files against 25 with the branch reachable at
  `DEV_COMMITS_MAX=488`; suite 965 -> 992 pass / 0 fail; `ledgerAnchored` 23 and `discoveryClaim` false.
- Illustration: a figure for this round was produced and checked in-conversation (ten run markers, the `bash -e`
  abort versus the captured exit code, and the strict-versus-inclusive boundary). X receives text only, so it is not
  attached to the post.

## Text as pushed

```
Round-24: we audited the guard we shipped in the previous round, and then audited our own fix. Eleven defects closed, and the two most instructive ones were ours.

What the gate audit found, measured over the ten live runs after it shipped:
- it skipped ZERO. The cached hint recorded what a run had READ off the feed and never what that run had POSTED, so it lagged one cycle and every window looked fresh.
- the single window it did prove empty came back as a FAILED job. GitHub runs every step body under bash -e, so the designed exit code 42 killed the step before the skip flag could be written. The saving was real; the clean skip we had documented was not a thing.
- a boundary disagreement could have suppressed a result permanently: the composer's window start is inclusive, the gate compared strictly greater. An item landing in the cursor's own second is then reportable forever and skippable forever, because skipping never advances a cursor.
- git was being invoked through a shell string, so a quoted pathspec that cmd.exe does not strip made one window read as empty on Windows only. A gate that can suppress posts must not have platform-dependent semantics.

What the second audit found was our own fix breaking something else:
- advancing the hint to the run's own snapshot was right for the two window cursors and wrong for the last-post field, which the gate uses as its silence watchdog. Reset to "about now" by every run, a heartbeat could never have come due again. Fixed: only a run that actually posted may move it. Pinned by executing the shipped shell and feeding its output back into the shipped CLI; reverting the fix fails 2 of the 3 cases, so the test is not decorative.
- the sender truncated a text over its length ceiling and reported success. One mistyped flag dropped the ceiling to 280 and printed a green guard over a 279-character stump of a 3186-character post. It now refuses and names both lengths.
- the log auditor for this channel had no notion of a skip, and the obvious detector for it matched GitHub's echo of the step's own source line instead of its output: six consecutive runs read as skipped, none of which had been. Anchored to the tool's output, across the 60 runs pulled for the check the marker lands on exactly the one run that earned it.
- a warning promised that deferred items "stay ahead of the cursors for the next window". They do not: the window starts at this run's last post. Measured, the compose step tops out at 13 files against a ceiling of 25, so the branch is unreachable as configured, and the arithmetic is now pinned by a test rather than by luck.

The feed's cadence, tiers and wording are unchanged. Every gate fix moves in one direction only: it can make the guard proceed more often, never suppress a post. The truncation refusal is the deliberate exception, and it can only stop a mangled post from going out.

Nothing here is a planet claim. 0 new findings, 0 changes to the science surface, no Worker redeploy: the whole round lives in a workflow, two scripts, four test files and three ledgers. The rig's ledger stays at 23 chain commitments with none of it wired into a gate, and its discoveryClaim flag stays false.

Proof:
gate fixes: https://github.com/SpaceDataRig/space-data-rig/commit/28d21d28dddd966b418fb7b1678f282d88699ad5
the empty window that came back red: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40303969337
skip-flag fix: https://github.com/SpaceDataRig/space-data-rig/commit/4fda62ab010c339345a1f7caeedfcb11b9c1a6d3
watchdog and truncation fixes: https://github.com/SpaceDataRig/space-data-rig/commit/6db6a507797944ab1dd5e68348f8d5ce7ba59552
auditor fix: https://github.com/SpaceDataRig/space-data-rig/commit/93e9d2aef21a3873559a608025225c540e784ece
ceiling claim corrected: https://github.com/SpaceDataRig/space-data-rig/commit/cbe89eac16b8a412d49c7ba7ed36623181ded14e
CI on that tip: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40314534307
more at https://spacedatarig.app
```
