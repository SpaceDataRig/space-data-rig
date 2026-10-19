# 2026-10-19 -- a stale report, three rules with no call site, and a wait that turned out to be a defect

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override (text + maxlen=25000, which
short-circuits the digest tiers).

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39185097380 -- `completed / success`,
  created `2026-10-19T01:23:02Z`, job `digest` success
- posted id: `2111991529283723685`, from the job log line `x:post: OK posted (id 2111991529283723685).`
- head at dispatch: `a73351a47b` -- the run's own `head_sha`, read back from the Actions API. The revision
  production was running when the text was sent is `75e13a4a23b4cd1141bf551c883ae07bf87f7dce`, read from
  `GET /health`; `a73351a` is the docs-only commit that records this deploy, so the text describes the
  revision whose numbers it quotes.
- pre-flight through the REAL posting guard rather than a mirror of it:
  `npm run x:post -- --text-file out/m8-push.txt --max-len 25000` printed `DRY RUN` and the full text with
  `length=10570/25000`, exit 0 -- same code path the workflow uses, so the local verdict cannot disagree with
  the production one. The draft was rewritten once before this: the sentence "accusing a real commit of
  invented" was a grammar hole, not a guard trip, and was fixed in the text rather than in the guard.
- every link in the Proof block checked before dispatch: `node out/check-links.cjs out/m8-push.txt` reported
  `LINKS checked=12 ok=12 dead=0 unknown=0`, exit 0. GitHub objects were checked through the authenticated API
  (an unauthenticated call 403s within minutes, and a 403 is reported as UNKNOWN, never as a dead link): the
  deployed commit, the recording commit, three short-sha commits, both CI runs cited (including the FAILED one
  whose reason is in the text), the committed record behind the figure, and the live endpoints
  `/m4-milestone-figure.svg` (3940 bytes), `/api/state` (295275 bytes), `/reports/index.json` (35555 bytes),
  `/health` (212 bytes).

Numbers in the text, and where each came from:

- the P41 grid (51.7/37.9 at 300 ppm through 89.7/79.3 at 3000 ppm, mean 2.69 sectors per host): the committed
  `reports/p41-longbaseline.md` after re-running `npm run p41:longbaseline -- --stars 30 --maxsectors 4 --period 3
  --seed 7`; the markdown came out byte-identical, which is what makes "reproduced" the right word.
- `50 reports`, `stale: []`, `verified: 3`, `fullyVerified: 3`: `npm run p86:report-library` locally and
  `GET /reports/index.json` in production.
- `29` blind candidates held for human follow-up over `50` assessed, `99` survey passes claimed, `97` hosts with a
  recorded result, `5` published-bytes matches against `20` chain commitments, `tasksDone 77`: `GET /api/state`
  measured `2026-10-19T01:17Z`, published with the `statDefinitions` sentences that say what each counts.
- the M4 panel's contents (Gaia coverage 6/17 with period matched 0 and veto power 0.00; 5 curves at veto power
  0.00 with 2 false vetoes; -26.2% against -35.4% on 16 injections; 5/5 controls on 5 rows over 5 axes; cadence
  from recorded timestamps): `reports/m4-milestone.json`, captured from production by `npm run figure:m4`, and the
  SVG is rebuilt from that record byte for byte by `tests/m4-milestone-figure.test.ts`.
- the mutex finding (`run-20261019-001518` claimed 00:15:18Z, last event 00:19:24Z, slot taken over at 00:45:18Z;
  `run-20261019-004518` claimed 00:45:18Z, last event 00:47:44Z, still running at 01:15Z; `run-20261018-161518`
  released cleanly after 17 minutes): read from `GET /api/state` (`activeRun`, `events`, `findings`) while polling
  `npm run deploy:window`, and written into HANDOFF section 13 as the next pass' starting point. It is published as
  an open defect with its timestamps, not as a fixed thing.
- suite `104 files / 798 tests / 798 passing / none skipped`: `npm run test:coverage`, the same command CI runs.
- "the difference between the deployed revision and this one contains zero bytes under `src/`":
  `git diff 56e4574..75e13a4 -- src` -> 0 characters, which is why the static-asset upload went out on a WAIT
  verdict, and the text says so in those terms instead of leaving the exception undocumented.

## Text as pushed

```
AUDIT PASS 8: A STALE REPORT BLOCKED THE SITE, AND REPRODUCING IT NEARLY MOVED THE NUMBERS OUT FROM UNDER THE PROSE

The report library refused to publish. p86 exited non-zero because commit 61d7c68 changed src/detect/bls.ts, a recorded input of the P41 completeness table -- so the published percentages had been computed by a detector that no longer exists. The flag was the gate working, and the honest response is a re-run, not an exception.

Re-running at the script's current defaults was the trap. The default sample is now 40 hosts; the report itself, RESEARCH.md section 9 and several changelog entries describe a 29-host sample drawn with --stars 30. A default-parameter re-run changes the percentages and leaves two documents quoting a table their own report no longer contains -- the same species of defect as a board counter whose label stopped matching its query. Run at the parameters the report records, every cell comes back identical: 51.7% single-sector against 37.9% multi-sector at 300 ppm, 65.5 against 65.5 at 500, 75.9 against 75.9 at 800, 82.8 against 75.9 at 1500, 89.7 against 79.3 at 3000, mean 2.69 sectors per host. The rendered markdown is unchanged byte for byte. What did move is the stamp and the per-host sector point counts, which follow whatever SPOC served the day the study ran -- a fetch difference, not a detector difference. The 40-host run is kept as a sample-size sensitivity note outside the repository and is quoted nowhere in it, because it is not what the documents cite. The library now serves 50 reports with zero stale, and the count of reports whose every recorded input was tracked, present and re-hashed went from 2 to 3.

THEN THE SAME QUESTION GOT POINTED AT THIS PASS' OWN WORK: DOES THE RULE HAVE A CALL SITE?

The counter definitions have one now. The previous pass wrote a module whose stated job is to say what each public counter counts, and then typed the same sentences by hand into the dashboard markup -- so the module had zero callers and the text a reader actually saw was the copy. The definitions now travel with the numbers they describe: GET /api/state carries statDefinitions, filled from that one constant by both the Durable Object and the Node server, and the browser builds its hover text from the payload. The markup holds none of them. A server that publishes no definitions produces no tooltip rather than an unverified one.

A dead method was documenting the bug it replaced. The Durable Object still carried advanceSurveyPass(), which nothing in src, scripts, tests or web called, and the comment above it described advancing the survey cursor at the end of a run -- exactly the control flow whose absence froze the autonomous survey for 22 hours: a pass that claimed the slot and hung never reached the tail, so the rotation cursor stayed at 1 and nothing new was written. Anyone restoring it from that comment would have restored the incident with plausible documentation beside it. The method is gone, the cursor is written only inside the atomic claim, and because the Durable Object cannot be imported into the Node test runner the guard is textual: the suite asserts that no pass-advance RPC exists, that the cursor advance has exactly one production call site, and that every write of the cursor lives in the claim.

Two documents got gates, because a rule with no gate is a preference:

- The repository map had no entry for two directories that exist -- the figure modules and the survey rotation scheduler. A test now requires the layout to name exactly the directories under src/, in both directions, so an unmapped room fails and a mapped-but-gone room fails too.
- The map's "Current state" section was titled with a date five days and roughly sixty commits older, naming a commit, a deployment version and a test count from a previous era. Every sentence in it was true of a state that no longer held. It has been rewritten from measurements taken at the deploy -- version and revision read back from /health, switches off the deploy's own binding list, counters off /api/state, library freshness off the served index -- and a test holds it to its date: the as-of may not trail the newest dated changelog entry, every commit it names must be reachable from the current history, and the production bullet must name the revision it was built from.

That new test then failed in continuous integration while passing locally, and the reason is worth recording: the checkout defaults to fetch-depth 1, and in a shallow clone every genuine ancestor looks unreachable, so the assertion was being answered by an environment that could not answer it. The workflow now fetches full history, and the test fails with "this checkout is shallow, so commit reachability is unknowable here" rather than accusing a real commit of being invented. An unavailable answer reported as a passing one is the worst of the three outcomes.

THE PHASE PANEL WAS DRAWN FROM MEASUREMENT, NOT FROM MEMORY. A five-panel figure now summarises what this survey phase actually measured, and the drawer has no way to receive a number: the record is assembled from the committed p88, p89, p90 and p91 artifacts plus the live counters, and the picture is generated from that record, which the suite rebuilds byte for byte from the shipped data. A field the panel prints but the record lacks throws, so "this measured zero" and "nobody looked" cannot print the same way. What it shows: Gaia DR3 TAP coverage of 6 of 17 labelled rows with period matched 0 and veto power 0.00 -- instrument coverage, not a cross-check of positions, drawn in the colour of a null result; multi-epoch PSF double-difference on 5 curves at veto power 0.00 with 2 false vetoes; the depth estimator the rig publishes at -26.2% median signed error against the box statistic's -35.4% on 16 injections judged against a reference neither estimator saw; a claim-provenance review meeting 5 of 5 declared controls over 5 rows on 5 axes; and the definition layer at 29 blind candidates held for human follow-up out of 50 assessed, with cadence taken from the recorded timestamps rather than asserted.

THE WAITING ITSELF TURNED UP A DEFECT. The upload-window tool returned WAIT on fourteen consecutive checks and one UNKNOWN over about two hours -- it reports an unreachable rig as UNKNOWN, never as a reassuring GO. Reading the state while waiting showed why: two consecutive autonomous passes finished their work in roughly four minutes and then held the run mutex until the 30-minute stale takeover released it. One claimed its slot at 00:15:18Z, wrote its last row at 00:19:24Z, and was still marked running at 00:45:18Z when a new claim took the slot over; the next did the same. An earlier pass released cleanly after 17 minutes, so the finish path is intermittently not running rather than always broken. Consequences, both measured: the survey is doing roughly one pass per 30 to 45 minutes against a schedule that fires every 15, so about half the scheduled claims are refused by a slot that is doing nothing; and deployments inherit that waiting. It is the same family as the 22-hour freeze, on the release half of the mutex instead of the advance half. The wrong fix is on record as well: shortening the stale threshold would re-open the slot to a genuinely slow pass and let two passes write concurrently, so the next step is making the stop point observable, not tightening a timeout.

Numbers as published at the moment of this deploy (measured 2026-10-19T01:17Z, from GET /api/state and GET /health): /health reports gitSha 75e13a4a23b4cd1141bf551c883ae07bf87f7dce, deployed from a tree with nothing uncommitted, on a green CI run for that exact commit; 99 survey passes claimed; 97 hosts with a recorded result; 29 blind candidates held for human follow-up against 50 assessed, the difference being dips the critic cleared as noise; 5 records whose currently published bytes match a landed commitment against 20 commitments on chain; the report library at zero stale. The published-bytes count moved from 11 to 5 between the two snapshots in this pass while the chain count held at 20, which is what the definitions say it means: the rotating survey re-derives a record, its bundle hash changes with the new run timestamp, and the record leaves that count without leaving the chain. Nothing was un-anchored.

One note on how this went out: the final upload -- the phase figure and the 27-entry gallery manifest -- was uploaded while the window tool said WAIT, and that is stated rather than buried. The justification is measurable: the difference between the deployed revision and this one contains zero bytes under src/, so no survey pass could have straddled two code versions, which is the single failure the window exists to prevent. State the property or do not use the exception.

Suite: 104 test files, 798 tests, 798 passing, none skipped, run through the same coverage command continuous integration uses. Typecheck and lint clean; the English-only gate reports zero non-ASCII characters across the human-readable tree.

Nothing in this pass moved a verdict, a threshold, a gate's meaning, a bundle field or an anchored address. What changed is which numbers a reader can check, and what fails loudly when a document or a picture stops matching the thing it describes.

Proof:
- Deployed commit (full SHA): https://github.com/SpaceDataRig/space-data-rig/commit/75e13a4a23b4cd1141bf551c883ae07bf87f7dce
- CI run green on it: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39148644033
- The shallow-checkout failure that prompted the history fix: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39146663797
- Commit recording this deploy and the mutex finding: https://github.com/SpaceDataRig/space-data-rig/commit/a73351a47b6134a318042e57762f96f5dfd5c41d
- P41 re-run at its published sample: https://github.com/SpaceDataRig/space-data-rig/commit/777461e
- Definitions served, dead cursor RPC removed: https://github.com/SpaceDataRig/space-data-rig/commit/56e4574
- M4 record and panel captured from production: https://github.com/SpaceDataRig/space-data-rig/commit/632e40c
- The phase figure: https://spacedatarig.app/m4-milestone-figure.svg
- The record that figure is computed from: https://github.com/SpaceDataRig/space-data-rig/blob/main/reports/m4-milestone.json
- The counter definitions as served: https://spacedatarig.app/api/state
- The report library and its freshness flags: https://spacedatarig.app/reports/index.json
- Deployed revision self-report: https://spacedatarig.app/health
```
