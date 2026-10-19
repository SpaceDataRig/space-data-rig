# 2026-10-19 -- the run-mutex release defect audit pass 8 published as open, root-caused and fixed with live proof

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override (text + maxlen=25000, which
short-circuits the digest tiers).

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39196432928 -- `completed / success`, job `digest` success
- posted id: `2112028196636135722`, from the job log line `x:post: OK posted (id 2112028196636135722).`
- head at dispatch: `29018f5e3fd1cb2fd752cb275fdeba089d96c722` (main), the commit that carries the fix; production was
  confirmed running it through `GET /health` (`gitSha 29018f5...`, `deployVersion 5ac79e25-5681-4e03-b4e3-9ee302929a21`).
- pre-flight through the REAL posting guard rather than a mirror of it:
  `npm run x:post -- --text-file out/mutex-fix-push.txt --max-len 25000` printed `DRY RUN` and the full text with
  `length=6868/25000`, exit 0 -- the same code path the workflow uses, so the local verdict cannot disagree with the
  production one. No over-claim trip: the only "discovery" in the text is the negation "publishes no discovery claim".
- every link in the Proof block checked before dispatch: `node out/_links.mjs out/mutex-fix-push.txt` reported
  `LINKS checked=5 ok=5 dead=0 unknown=0`, exit 0. GitHub objects were fetched as HTML pages and the live endpoints
  directly; a 403/429 would have been reported as UNKNOWN, never as a dead link.

Numbers in the text, and where each came from (all read from the live rig or the local gate, none asserted):

- the pre-fix wedge (`run-20261019-023019` claimed 02:30:20Z, last event 02:35:02Z, still running at 03:07:59Z with no
  `finishedAt`, released by the stale takeover at 03:15:18Z across two refused scheduled claims at 02:45Z and 03:00Z):
  `GET /api/state` (`activeRun`, `events`) polled through `out/_probe.mjs` while the defect was live.
- `median idle between passes 2101s` against `full-pass span median 232s`: `npm run deploy:window` at 03:05:25Z
  (`out/dw-predeploy.json`), measured from the recorded findings timestamps.
- the three post-fix passes (`run-031518` claimed 03:15:18Z, finished 03:27:09Z; `run-033019` claimed 03:30:19Z with no
  stale event, finished 03:33:44Z; `run-034518` claimed 03:45:18Z) and `surveyPass 101 -> 102 -> 103 -> 104`:
  `GET /api/state` polled at 03:19Z, 03:24Z, 03:27Z, 03:32Z and 03:45Z.
- the roughly nine-second normal heavy scout (box search plus four-of-four sector depth): the per-target event timestamps
  for TOI-5082.01 (03:19:28Z -> 03:19:37Z) and TOI-1962.01 (03:24:29Z -> 03:24:37Z) in the same live event log.
- deploy provenance (`gitSha 29018f5...`, `deployVersion 5ac79e25...`, clean tree, green CI): `GET /health`, `git status`,
  and the CI run `39192864742` for that exact sha.
- suite `104 files / 803 tests / 803 passing / none skipped`, typecheck and lint clean, English-only gate zero non-ASCII:
  `npm test`, `npm run typecheck:all` and `npm run lint` locally, the same commands continuous integration runs.

## Text as pushed

```
THE RUN-MUTEX DEFECT AUDIT PASS 8 PUBLISHED AS OPEN IS NOW ROOT-CAUSED, FIXED, AND VERIFIED LIVE

The previous pass published an open defect with its timestamps and named the wrong fix. Autonomous survey passes had stopped emitting events, stayed marked running, and held the single run slot until the 30-minute stale takeover released it; the survey ran roughly one pass per 30 to 45 minutes against a schedule that fires every 15, so about half the scheduled claims were refused by a slot doing nothing. That pass warned, correctly, that shortening the stale threshold would re-open the slot to a genuinely slow pass and let two passes write concurrently. It did not tighten a timeout. This pass found the mechanism and fixed that instead.

THE MECHANISM. A pass processes its targets in a loop, one durable Workflow step per seat. One seat step can be heavy: the anomaly scout runs a box-least-squares search and, with the per-sector depth flag on, fetches and folds up to six SPOC sectors inside the SAME step. On a wide-period, high-point target that step can exceed the runtime CPU budget. The runtime then terminates the step and retries it on a growing backoff; once the retries run out, step.do itself REJECTS. The step wrapper the loop used put its try/catch INSIDE the callback, so it caught an error the seat THREW but not a step the runtime KILLED. That rejection escaped the wrapper, escaped the per-target loop (which had no surrounding try/catch), and rejected the whole run before it reached its finish tail. The finish tail is the only normal release. It never ran, so finishRun was never called, and the slot stayed claimed until the stale takeover. It is the same family as the 22-hour freeze the cursor fix addressed, on the release half of the mutex instead of the advance half.

Read from the live rig while it was happening: run-20261019-023019 claimed its slot at 02:30:20Z, wrote its last event at 02:35:02Z, and was still marked running at 03:07:59Z with no finishedAt; the stale takeover released it at 03:15:18Z, 45 minutes after the claim and across two refused scheduled claims at 02:45Z and 03:00Z. A deploy-window measurement at 03:05Z put the median idle between passes at 2101 seconds against a full-pass span median of 232 seconds -- passes take about four minutes when they work and about thirty-five minutes apart, because a wedged one holds the slot for the whole stale window.

THE FIX, in three parts, none of which tightens the stale threshold:
- The step wrapper moved to its own module (src/cf/safe-step.ts) with only a type import, so the Node test runner can load it -- the exact reason the retry-exhaustion path had zero coverage while it was wedging production: the workflow entrypoint imports a runtime value the Node runner cannot resolve. It now has an OUTER try/catch that absorbs a step.do rejection into a per-target failure, and a BOUNDED retry policy (limit 2, five-second linear backoff, two-minute per-attempt ceiling) so a deterministically heavy step gives up, the loop marks that ONE target failed, and CONTINUES. The two-minute ceiling is generous against the roughly nine seconds a normal heavy scout takes (measured live: box search plus four-of-four sector depth in eight to nine seconds), so it trips only on a true pathological case, never on legitimate work.
- The finish tail is itself wrapped: if even that light step is terminated, the slot is released DIRECTLY through the runId-scoped finishRun before the error is re-thrown, so the mutex is never stranded. runId-scoped means a superseded run finishing late cannot clobber a live successor.
- The half-hourly feed trigger wake is no longer silently best-effort. An expired token (401) or a renamed workflow (404) used to stop the reliable trigger with no signal at all; the failure now surfaces on the rig event log. The token is never logged -- only the HTTP status or the error message.

VERIFIED ON PRODUCTION, not only in tests. The fix deployed at gitSha 29018f5e3fd1cb2fd752cb275fdeba089d96c722 (deployVersion 5ac79e25-5681-4e03-b4e3-9ee302929a21) from a clean tree on a green CI run for that exact commit. Then, read back from GET /api/state and GET /health:
- run-20261019-031518 claimed at 03:15:18Z (taking over the still-wedged zombie), processed all eight heavy targets with events flowing continuously, and FINISHED at 03:27:09Z -- running=false, finishedAt set -- releasing the slot through the normal finish tail, not a stale takeover. Eleven minutes fifty-one seconds start to finish, because every one of its eight targets was heavy (3151 to 3637 photometry points, per-sector depth on four of four sectors) and all eight completed rather than wedging.
- run-20261019-033019 then claimed at 03:30:19Z with NO "Releasing stale run" event -- the slot was genuinely idle because run-031518 had released cleanly -- and itself finished at 03:33:44Z, releasing cleanly again. The idle between those two passes was about 190 seconds against the 2101-second pre-fix median.
- A third pass, run-20261019-034518, claimed at 03:45:18Z. The rotation cursor resumed advancing on every scheduled boundary: surveyPass 101 (wedged) to 102 (03:15Z) to 103 (03:30Z) to 104 (03:45Z). The single stale takeover at 03:15Z cleaned up the last pre-fix zombie; every claim since found the slot idle, and both completed passes released through the finish tail, not the stale path.

WHAT THIS DOES NOT CLAIM. It does not make a pathological wide-period target succeed -- such a target is now marked failed and skipped instead of wedging the run and taking every queued target with it, which is the correct trade but still a lost target; bounding the search grid so those finish inside budget is the follow-up. It moves no verdict, no threshold, no gate meaning, no bundle field and no anchored address. The rig stays research-only and publishes no discovery claim.

Suite: 104 test files, 803 tests, 803 passing, none skipped -- five more than the previous pass, the new ones driving the real step wrapper with a mock step and pinning all three outcomes (resolve, callback-throws, step.do-rejects) plus the bounded retry policy, so a silent revert to an unbounded default reintroduces the wedge and fails. Typecheck and lint clean; the English-only gate reports zero non-ASCII characters across the human-readable tree.

Proof:
- Deployed commit (full SHA): https://github.com/SpaceDataRig/space-data-rig/commit/29018f5e3fd1cb2fd752cb275fdeba089d96c722
- CI run green on it: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39192864742
- The pass that published this defect as open: https://github.com/SpaceDataRig/space-data-rig/blob/main/devlog/2026-10-19-stale-report-rerun-rules-without-call-sites.md
- Deployed revision self-report: https://spacedatarig.app/health
- Live run bookkeeping and event log: https://spacedatarig.app/api/state
```
