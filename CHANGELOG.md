# Changelog

All notable changes to Space Data Rig are documented here. This project aims to follow
Keep a Changelog and adheres to Semantic Versioning.

## Unreleased

### Operator-directed change: X-post cadence halved to cut posting cost (2026-10-27)
The public digest fired twice an hour (a Cloudflare `*/15` research tick dispatching x-post at `:00`/`:30`, with a
GitHub `*/30` schedule as backup). On operator request ("cost still too high, halve the frequency") the posting cadence
is now once an hour: `src/cf/worker.ts` wakes x-post only at `wakeMinute === 0`, and the GitHub backup `on.schedule` is
`0 * * * *`. The `*/15` research cron is unchanged -- it drives the science loop, not posting. Every current-behavior
comment that said "half-hourly" was updated to "hourly"; historical devlog and CHANGELOG entries that recorded the
earlier cadence were left as accurate history. No test asserted the old `:00/:30` gate; typecheck + full suite 1028/0.

### Twenty-sixth round (the unstamped half of the corpus): "unattested: 39" turned out to be three different problems, and one of them was hiding a real drift (2026-10-26)
Round-25 closed with 39 of 56 published reports carrying no attestation at all, and the ledger's explanation was
"re-running their generators mostly needs network". That sentence is true and useless: it treats 39 rows as one
problem. Round-26 starts by measuring the difference instead of repeating the claim.
- **R26-1, the census, done offline and made to account for itself.** `scripts/audit/unattested-census26.mjs` sorts
  every unattested row by whether its generator could run on a machine with no network at all (reads only
  `reports/` + `tests/fixtures/`, no fetch/http/URL). Result: **5 offline-capable, 34 network-bound, 39 accounted
  for** -- the script asserts its own bucket arithmetic against the row count and exits non-zero if a row goes
  unclassified, because round-25's lesson was that a checker which silently skips a row reports agreement instead of
  coverage.
- **R26-2, the real reason those 5 were unattested was not the network: their generators never wrote a stamp.** Each
  of `p34-cost-model`, `p54-selection-function`, `p63-soft-score`, `p68-discriminator-roc`, `p79-benchmark` builds a
  `meta` block by hand and calls no `buildStamp`, so re-running them -- offline or not -- could never have produced a
  checkable input. p79 was worse in a specific way: it declared `inputs` as an array of bare path *strings*, the exact
  shape `report-freshness.ts` documents as "a name with nothing to compare", so its row could not verify even though it
  looked like it had provenance. All five now import `buildStamp` and stamp the files they actually read plus their own
  source, so a later edit to the model code shows up as staleness too.
- **R26-3, what the missing stamp had been hiding: p34's published numbers were already wrong for its own input.**
  Re-running the cost model moved almost everything, because its input catalog `reports/p33-catalog.json` had grown
  from 33 curves to 204 since the numbers were frozen: sampleN 33 -> 204, fit exponent p 2.936 -> 2.873, k
  8.567e-7 -> 9.482e-7, R^2 0.837 -> 0.788, mean per-curve ms 27857 -> 15838, doubling cost factor 7.655 -> 7.326. No
  gate fired, and none *could* have: an unstamped row is never compared to anything. The other four reproduce
  byte-identically -- their diffs are the stamp fields and one JSON comma each -- which is why this is worth stating
  precisely: the absence of a stamp does not mean the numbers moved, it means nobody knew whether they had.
- **R26-3a, the claim in the draft of this entry was wrong, and the correction is the bigger finding.** The first draft
  said "no published material quotes the p34 cost numbers, so the refresh moves a report page, not a cited figure".
  Searching `web/` properly disproves it: `scripts/p38-research-bundle.ts` distils `reports/*.json` into
  `web/research.json`, and `web/app.js` renders that bundle's `compute` block as a visible metric card --
  `scaling exponent ~${cm.exponentP.toFixed(2)} (R^2 ${cm.r2.toFixed(2)})`. Re-running p38 refreshed the committed
  bundle to `exponentP 2.873 / r2 0.788 / sampleN 204`, while the file in `HEAD` still said `2.936 / 0.837 / 33`. In
  prose no post quotes the exponent (`git grep` over the devlogs, README, RESEARCH, HANDOFF and CHANGELOG for
  `2.936`, `2.94`, `7.7x` returns nothing), so the reach is the rendered card, not a feed line.
- **R26-3b, and it was not only p34: the public bundle had no currency gate at all.** `web/research.json` is the asset
  the digest itself links as "Numbers + data", yet nothing rebuilds it in CI and no test compares it to the reports it
  claims to summarise. It was last generated 2026-10-20T04:01Z; two of its sources have been re-measured since, on the
  networked `freshness-regen` fleet, and the bundle kept publishing the older figures:
  `trueVetoAcceptance.addressable` still showed `caught 2 of 13 negatives, vetoPower 0.154 [0.043, 0.422], AUC 0.742`
  while the committed `reports/p59-offtarget-subset.json` (stamped 2026-10-22, inputs tracked) records
  `addressableNegatives: 0, caughtOnAddressable: 0` -- the refreshed bundle publishes `0 of 0, vetoPower null, AUC 0`,
  which is weaker and true. Checked before attributing it to the bundler: p38 reads
  `p59.counts.addressableNegatives` and the current artifact really does carry zeros, so this is a stale-summary being
  corrected, not a missing-key default. `multiSourceNoveltyP76` moves the same way (novel 5 -> 4, and its row goes from
  `stamped: false / snapshotAt: null` to the stamp the re-run wrote).
- **R26-3c, measured on the live endpoint before and after, because R25-10 set that rule.** `GET
  https://spacedatarig.app/research.json` answered HTTP 200 in 34.5 s with `generatedAt 2026-10-20T04:01:42.762Z`,
  `compute {p: 2.936437697567511, r2: 0.8366052738431159, sampleN: 33}` and `addressable {negatives: 13, caught: 2,
  auc: 0.7423076923076923}`. That is the number a visitor sees today. The refreshed bundle is therefore deployed in
  this increment, not queued: publishing a figure its own source report no longer supports is the exact failure the
  freshness gate exists to prevent, and the gate simply never covered this surface.
- **R26-4, counts after the refresh, and what they are not.** The library rebuilt to 56 rows / 22 stamped / 21
  verified / 21 fully verified / **0 stale**, so unattested went 39 -> 34. `scripts/audit/freshness-recheck.mjs`
  re-derives all of it without importing the audited module: `rows=56 opened=54 absent=2 unstamped-artifacts=32
  stamped=22/22 (flat-shaped=2) verified=21/21 findings=0`. Written while still repo-only, per R25-10's rule that
  "shipped" is not true until the endpoint agrees -- which it now does: see R26-10 for the deploy and the read-back
  values, which match these exactly.
- **R26-5, a third stamp shape that neither the gate nor round-25's checker could see.** `scripts/audit/stamp-shapes26.ts`
  walks every artifact in `reports/` for a `generatedAt` anywhere in the document and asks whether the gate's reader
  would find it. One row does: `p91-claim-provenance.json` writes a complete, checksum-bearing stamp under the key
  `stamp`, which neither `obj.meta` nor the flat top level reaches. So round-25's conclusion "both stamp shapes are now
  understood" was itself an undercount -- the honest statement is "two of the three shapes that exist". Measured before
  touching anything: two of p91's three recorded inputs still match this checkout, and the third is its own generator,
  which has been edited since the run -- so if the reader were widened to see p91's stamp, p91 would publish **stale**,
  not verified. Decision recorded rather than guessed: fix the writer (emit into `meta` like the other 50) rather than
  reinterpret the reader's contract, and re-run it where its citation endpoints answer. **Writer shipped in this
  round's second commit; the artifact deliberately untouched.** Measured before deciding, on this workstation:
  `api.crossref.org` answers 200 in 855 ms while `export.arxiv.org` fails to fetch, and an offline replay
  (`--offline`) reproduces all five verdicts and every control but silently rewrites two resolved paper titles
  (`Multi-Object` -> `Multiobject`, the captured fixture versus the live Crossref record) and flips `mode: live ->
  offline`. Publishing a re-run whose evidence strings differ from the run that made the claim is not a stamping fix,
  so the row stays unattested until the fleet does it live -- which round-26 also wired:
  `.github/workflows/freshness-regen.yml` now runs p91 (deliberately not `--offline`, for exactly the reason above) and
  `scripts/p38-research-bundle.ts`, publishes `reports/p91-claim-provenance.*` and `web/research.json` alongside the
  existing four arms, and triggers on the two new generators, `reports/p91-claims.json` and
  `src/claims/claimReview.ts`. `scripts/p38-research-bundle.ts`'s `claimProvenanceP91.stamp` also stopped reading the
  third key: it now prefers `meta` and still accepts `stamp`, so fixing the address cannot make the summary claim the
  row lost its provenance.
- **R26-6, two rows the site publishes with no machine-readable artifact at all.** `p33-scale-roc` and
  `p39-instrumental-fp` have an `.md` and a served fragment but no JSON artifact in the repository at all, so nothing
  about them can be re-derived by anyone. The recheck counts them under `absent=2` as an *observation*, which is how a
  permanent hole stays politely invisible: "every published count reproduced" says nothing about a row that cannot be
  reproduced by construction. Decided to keep it as an observation with a named list rather than promote it to a
  blocking finding that would sit red for days -- but the census prints the ids, and they are the first thing to fix
  once MAST answers. OPEN.
- **R26-7, second-pass census: "34 unattested" is not one number either.** `scripts/audit/unattested-blockers26.mjs`
  splits the remainder by what actually blocks each row, using only tracked files: **32** generators still write no
  stamp at all (bucket C -- the same edit round-26 made five times, then a networked re-run), **2** already stamp but
  their committed artifact predates the wiring (bucket A: p81, p91), **0** unopenable, **0** without a generator, and
  the arithmetic checks out at 34/34. That kills the vaguer framing "34 need network": p81's and p91's artifacts are
  stale-by-omission, not unreachable, and 32 of the rest are a code change waiting for a runner.
- **R26-8, CLOSED the same round by R26-9 below.** The bundle was corrected once by hand, which is not a fix: nothing
  prevented `web/research.json` from drifting behind `reports/` again, and the same 6-day gap would recur the next time
  the networked fleet re-measured a source. The gate that should exist is a rebuild-and-compare --
  generate the bundle into a scratch path (p38 wrote to `web/research.json` unconditionally, so it needed an output
  argument first) and fail when the committed bundle differs from the fresh one in anything but its own
  `generatedAt`. The stale bundle this round found is the positive control, so the test is provably capable of failing
  on the real fault rather than on an invented one.
- **R26-10, deployed and read back from the public endpoints, including a first attempt that failed for real.** The
  refresh ships as `e97c4fde57d0d146b16620a484b58a80c44ad1c8`. The first `npm run cf:deploy:sha` did NOT deploy: wrangler
  reported `Your auth token has expired and could not be refreshed because the Cloudflare auth server could not be
  reached`, and stopped with credentials unchanged. Two probes then answered (`cloudflare.com/access/oauth2/token` 404
  in 2.7 s, `api.cloudflare.com` 403 in 1.9 s -- reachable, and not authorised), so the diagnosis was a transport blip
  and not a bad login; a straight retry succeeded. Version `556fede6-b5ef-495d-82d5-8c5fc10dac77`, created
  2026-10-27T01:09:35.384Z per `wrangler deployments list`, 3 assets uploaded /
  97 already cached, after a `--dry-run` that printed the env block and confirmed the spending vars are untouched
  (`AUTO_ANCHOR=live`, `OBSERVE_ANCHOR=live`, `AUTO_ANCHOR_DAILY_CAP=100`, `OBSERVE_ANCHOR_DAILY_CAP=unlimited`).
  Read back with `scripts/audit/live-readback26.mjs`, which asserts facts about responses rather than about the tool's
  exit line: `/health` `gitSha=e97c4fd...` with `deployVersion=556fede6...`; `/research.json` now
  `generatedAt 2026-10-27T00:54:33.209Z`, `compute {p 2.8730627278616767, r2 0.7880192356593715, sampleN 204}` and
  `addressable {negatives 0, caught 0, vetoPower null, auc 0}` -- the two figures this round found unsupported are gone
  from the public surface; `/reports/index.json` `count 56`, `verified 21 / fullyVerified 21 / stamped 22 /
  unattested 34 / stale []`, with all five refreshed rows `stamped=true verified=true fresh=true` and
  `reproducible` 2/3/3/3/4; and the served `/reports/p34-cost-model.html` matches `2.87`, contains no `2.93`/`2.94` and
  no stale-or-unverified banner. `git push` itself is still failing on `github.com:443` (connect timeout, then `Empty
  reply from server`) while the deploy path works -- retried in the background, and the remote is checked with
  `git ls-remote` rather than inferred from an exit code.
- **R26-9, the gate for the public bundle, written against a fault that had already happened.** A one-off manual
  correction is not a fix, so `scripts/p38-research-bundle.ts` learned an `--out=<path>` argument (default unchanged,
  and a path resolving outside the working directory throws rather than writing wherever it is pointed) and
  `tests/research-bundle-currency.test.ts` rebuilds the bundle into `out/` and compares it to the committed asset with
  the bundle's own `generatedAt` removed from both sides -- so a rebuild that changed nothing is not a false positive,
  and a source that moved really is. The test runs the bundler with cwd at the repo root because the script resolves
  every input relative to cwd; its own scratch guard is what makes that safe.
  Mutation-checked in the strongest way available: the pre-refresh bytes were injected in place of the committed
  bundle and the file re-tested -- 2 of 3 red, with the diff naming `compute.exponentP: published 2.936437697567511 vs
  a fresh build 2.8730627278616767`, all six `trueVetoAcceptance.addressable` fields, and the five
  `multiSourceNoveltyP76` fields. The second case went red for an instructive reason: with the stale bundle installed,
  the committed asset and the historical control became the same bytes, so the control could no longer see a
  difference -- a gate and its positive control must not share a file. Restoring gave 3/3, and the injected backup was
  deleted rather than left to be found later. One bug in the test itself surfaced during this: the timestamp-stripping
  regex was missing the closing quote, so it matched nothing and every case failed with "no top-level generatedAt line
  found" -- which is precisely the loud-failure branch it was written to have, and it fired on the test rather than on
  the data.
- **R26-11, a regression this commit caused, and the non-hermetic test that let it hide.** After `e97c4fd` landed,
  `npm test` went red on `tests/x-post-preflight.test.ts`'s F13 empty-window case: the pre-flight answered
  `proceed (web/research.json changed inside the science window)`. The drill extracts the real workflow step and runs
  it under `bash -eo pipefail`, but launches it with cwd at THIS checkout, so every `git log` inside the step read the
  repository running the suite instead of the throwaway fixture the test had built -- and the science cursor is
  deliberately in the past. A commit touching `web/research.json` here therefore flipped a fixture's verdict for a
  reason that had nothing to do with the gate under test; the suite had been green only because no recent commit had
  touched that path inside the window. Fixed by pointing `GIT_DIR`/`GIT_WORK_TREE` at the fixture for the step block
  (cwd stays, because the step refers to `scripts/x-post-preflight.mjs` by a repo-relative path). Fixing it exposed a
  second gap: the research milestone -- the one tier allowed to announce a science result -- had never been exercised
  through the step at all, so two cases were added that commit `web/research.json` inside the fixture, one minute-side
  and one cursor-side, proving the tier fires on the window rather than on the file's existence. 17 -> 19 cases, all
  green.
- **R26-13, CI was RED on the first increment, and the diagnosis is proven rather than argued.**
  `scripts/audit/ci-watch26.mjs` reads check runs and workflow runs as API objects (github.com HTML does not load from
  this workstation): run 40431879147 for `e97c4fd` concluded failure at the step "Tests + coverage gate
  (auto-discovers tests/*.test.ts)". Anonymous log download is auth-gated, so the cause was reproduced instead of
  guessed: `scripts/audit/diagnose26-preflight.mjs` strips the `GIT_DIR`/`GIT_WORK_TREE` lines from the pre-flight
  drill, re-runs that file and restores it -- 2 of 19 fail with the assertion text
  `x-post-preflight: proceed (web/research.json changed inside the science window)`, the identical failure CI hit. So
  the second increment is not a plausible fix; it addresses the observed red, and the local 1011/0 had been measured
  with HEAD still on the pre-refresh commit. The process lesson is narrower and less comfortable than the code fix:
  every gate here is run against a tree, but this test reads the repository's HISTORY, so when a commit touches a path
  a window check inspects, the honest sequence is commit, then run the suite with that commit as HEAD, then push.
- **R26-14, the fleet fired.** Pushing the second increment triggered `freshness-regen` (run 40433770058, created
  2026-10-27T01:38:31Z) on the new trigger paths, with `CI` run 40433769938 alongside. The fleet now carries the live
  p91 arm and the p38 rebuild; whether it publishes a stamped p91 and a bundle that still passes the currency gate is
  knowable only from that run and its publish commit, so this entry records "in progress" instead of a predicted
  success. **Resolved while this increment was still being written:** the run completed SUCCESS and published
  `61ca06c` ("freshness-regen: re-stamp p48/p59/p76/p91/p92 + rebuild research bundle and report library") at
  2026-10-27T01:40:52Z. Read from the remote tree through the contents API, p91 is now `mode: live` with its stamp under
  `meta` and three hashed inputs, its row reads `stamped=true verified=true rehashed=3 reproducible=3`, and the published
  freshness moved to stamped 23 / verified 22 / fullyVerified 22 / **unattested 33** / stale [] -- the third-key-shape
  finding closed by the writer fix plus a run nobody had to fake. That commit also re-triggered CI, whose verdict is
  fetched rather than assumed.
- **R26-15, six published rows told readers nothing about how to re-run them, and five of them were `verified`.** The
  report index carries a `reproduce` command per row, which `scripts/report-md.ts` scrapes from a
  `Reproduce: \`...\`` line in the report's own markdown. `scripts/audit/reproduce-command-census26.mjs` found 6 of 56
  rows with none: p68, p85, p90, p91 and both `crosscheck/` rows. Freshness and reproducibility are different promises
  -- a row can match every recorded checksum and still be unrepeatable by the person reading the page -- and nothing in
  the suite was comparing the two. Fixed in the generators, never in the markdown (hand-editing a generated `.md` is
  the artifact-versus-source divergence this entire round has been chasing): p68, p90 and p91 now emit their own
  command line. p68 and p90 were re-run offline and their `.md` diffs are the added line plus a blank -- each `.json`
  moved only its `generatedAt`, `gitSha` and its own script hash; the re-run of p90 also refreshed a seven-day-old
  artifact whose recorded `gitSha` was `e8d6de4`. That leaves 4 rows, each with a named reason in the new
  `tests/report-reproduce-command.test.ts` allow-list: p85 (its stamp covers `out/scaled/*.jsonl`, gitignored, so
  re-running it here would restamp the row against bytes that exist on one workstation), p91 (fixed in code, waiting on
  the fleet's live arm, which this push retriggers), and the two CI-harness crosscheck reports, whose generator is a
  Python job with no npm command to emit yet. The test asserts BOTH directions -- an unexcused row may not lose its
  command, and an excused row may not stay excused once it has one -- and
  `scripts/audit/mutate26-reproduce-test.mjs` proves each half: clearing p34's command fails case 1 naming
  `p34-cost-model (stamped=true verified=true)`, giving p85 one fails case 2 demanding the list be pruned, and
  restoring leaves the index byte-identical with 3/3 green.
- **R26-16, the round-25 handoff gate could not see its own marker, and said so in a way that wasted a commit.** After
  the increment-3 artifacts landed, `tests/handoff-freshness.test.ts` went red: the Production bullet named `e97c4fd`
  while three served files differed from it -- a true statement of fact, and exactly what the check exists to force
  into the open. The bullet *did* say so: it carried `AWAITING DEPLOY` on its third line. The R25-11 implementation read
  only the single line matching `- Production:` and matched `/awaiting deploy/` case-sensitively, so a disclosure placed
  where it naturally belongs -- next to the version id it qualifies, one line down -- was invisible to the gate it was
  written for. Fixed by scoping the search to the whole bullet and making the marker match
  case-insensitive, with `scripts/audit/mutate26-handoff-marker.mjs` proving the widened check is not vacuous: stripping
  every case variant of the phrase (not just the first hit -- the bullet also quotes the marker historically, so a
  one-occurrence replacement would delete a mention and leave the live marker in place, reporting success about nothing)
  makes the gate red naming the same three files, and restoring gives 6/0 with the handoff byte-identical. The
  instructive part is that the failure I blamed on my ledger prose was a failure of the check's own scope.
- **R26-17, the research-bundle currency gate's own positive control decayed to a no-op when the fleet merged, and the
  rebased suite caught it.** Increment 2 shipped `tests/research-bundle-currency.test.ts`, whose positive control read
  "the second-newest revision of `web/research.json`" and asserted the diff still named `compute.exponentP`. On the day
  it was written that slot held the pre-refresh bundle (exponent 2.936). But increment 1's refresh (`e97c4fd`) and the
  fleet's refresh (`61ca06c`) both landed *after* it, so the second-newest revision became an already-refreshed bundle
  (2.873): the control silently stopped naming the figure it exists to prove, and the gate kept passing while believing
  it had a working positive control. The suite caught it only on the rebased HEAD -- 1 of 1019 red, naming
  `trueVetoAcceptance.addressable.*` as the only differences and none in `compute.exponentP`. Fixed by anchoring the
  control to CONTENT (the newest revision that still published 2.936, located by walking `git log -- web/research.json`)
  rather than to a fixed position, plus a guard that the shipped bundle no longer carries 2.936 -- so if the drift were
  ever un-fixed the control fails loudly instead of going vacuous. `scripts/audit/mutate26-currency-control.mjs`
  recomputes both anchors independently of the test: the content anchor produces 19 diffs naming the exponent, the old
  position anchor produces 7 and does not -- the regression, reproduced. This is the third time this round a check of
  mine read a moving slot and called it a control; the lesson is the same one from R26-8 (a gate and its control must
  not share a file) sharpened to *history*: a control must be anchored to the fact it demonstrates, not to where that
  fact happened to sit when the test was written.
- **R26-18, the reproduce-command ratchet pruned its own exemption the moment the fleet made it false -- the both-ways
  list earning its keep.** R26-15 excused four rows for lacking a `reproduce` command, one of them `p91-claim-provenance`
  with the explicit reason "code fixed, awaiting the networked fleet arm to re-run it". This push triggered that arm: the
  fleet re-ran p91 live against the generator that now emits the line, published `5e4d683`, and `reports/p91-claim-provenance.md`
  gained `Reproduce: \`npm run p91:claim-provenance\`` while its index row went `verified=true, reproducible=3`. Fast-forwarding
  onto that publish and re-running the suite flipped the ratchet's *prune* direction red -- "these rows now DO carry a
  reproduce command, so remove them from the allow-list" -- which is the exemption list behaving exactly as designed: it
  does not let a fixed row keep a stale excuse that would read as a claim about the present. Fixed by dropping p91 from
  `ALLOWED_EMPTY`, folding p91's markdown into the generator-sourced assertion (now satisfiable), and correcting the header
  prose; three rows stay excused (p85 over a gitignored checkpoint, and the two CI-harness `crosscheck/` reports). Full
  suite 1019/1019/0 on the integrated HEAD. No hand-edited `.md`, no offline replay to manufacture the command -- the
  networked run produced it and the gate noticed.
- **R26-19, round-26 increment 3 deployed and read back from the live endpoint, which is the only place "shipped" is
  decided.** `c93a43c` (whose `src/` and `web/` trees equal the fleet's `5e4d683` publish) went to production as version
  `6a9958fa-1620-488c-87ba-8e111bab585e`. The deploy is what the R25-11 handoff gate had been marking `AWAITING DEPLOY`
  for, and the marker is now removed by this record, exactly as that gate's contract requires. `npm run cf:deploy:sha`
  refused the FIRST attempt -- `REFUSED: the working tree is not what HEAD is (1 uncommitted path(s))`, an untracked
  scratch file in `scripts/` -- and the refusal was taken seriously rather than bypassed with `--allow-dirty`: the file
  was deleted and the clean tree redeployed, because a gitSha must not describe bytes that were never committed. Live
  read-back: `GET /health` -> `deployVersion 6a9958fa / gitSha c93a43c`; `GET /reports/index.json` -> `freshness {stamped
  23, verified 22, fullyVerified 22, unattested 33, stale []}` with `p91-claim-provenance` served `verified=true
  fresh=true reproducible=3` and a reproduce command; `GET /research.json` -> the refreshed `compute {2.873, 0.788, 204}`
  and `addressable {0, 0, null, 0}`. No `src/` change, every spending var byte-identical, `discoveryClaim`/`safeToGate`
  still false. The served library now equals the committed, gate-verified library -- the gap between "a green CI badge"
  and "what a visitor is shown", which round-25 named as the freshness gate's own failure mode arriving in the handoff,
  is closed for this round by measurement rather than by the word.
- **R26-20, the last offline-rebuildable public asset had no currency gate, and the census's "needs network" label was a
  regex, not a measurement.** After deploy, the next audit pass swept two things the round had asserted but not tested.
  First, `scripts/audit/unattested-blockers26.mjs` flags each unstamped generator `network-needed=true` with a SUBSTRING
  regex, so "32 rows need a networked runner" was a claim resting on a mention of `fetch`/`http`/a fetcher module --
  exactly the kind of over-claim that hides an offline win. `scripts/audit/net-census-audit26.mjs` re-checked each of the
  32 for an actual call site rather than a mention: all 32 make a real network call (`realCall=32, mentionOnly=0`), so
  the framing holds -- but now because it was measured, and the negative is recorded so a future reader does not
  re-litigate it. Second, sweeping `web/` for derived assets left ungated by a rebuild test: `research.json` (gated
  R26-8/9), `reports/index.json` (gated), `figures.json` (`figures-manifest.test.ts`), but `replay-manifest.json`,
  `candidates.json` and `observe-stars.json` had no "committed bytes == a fresh build" gate. Only `replay-manifest.json`
  is offline-rebuildable -- `scripts/p55-replay-manifest.ts` derives it purely from the committed `reports/p50-replay.json`
  and writes NO timestamp, so it is a deterministic byte function; `candidates.json`/`observe-stars.json` need a networked
  p22/p24 run and join the parked-32, now named rather than silently absent. So p55 gained `--out=` (same escape-the-repo
  guard as p38), `tests/replay-manifest-currency.test.ts` rebuilds into `out/` and requires byte equality plus
  `discoveryClaim=false` and a well-formed 64-hex `replayHash`, and its positive control flips the hash and asserts BOTH
  that the byte gate sees a difference AND that the semantic `verifyManifest` rejects it -- the gate watches the field
  that actually matters. `scripts/audit/mutate26-replay-currency.mjs` proves non-vacuity by tampering the committed bytes:
  fail 2 naming the mismatch, restore to 3/3 byte-identical. The manifest was already fresh (single commit since 2026-10-14,
  rebuild byte-identical), so this is a preventive gate closing a latent instance of the exact class that caught
  `research.json` six days late -- found before it drifted, not after.
- **R26-21, the two red lines were enforced in the code that produces them but never scanned in the artifacts that ship
  them.** A sweep of the test suite first confirmed the round's remaining position/history-anchored checks are sound
  (`deploy-guard.test.ts` branches on the observed tree state, not a slot; the CI test workflow sets `fetch-depth: 0`, so
  R26-17's content-walk reaches the pre-refresh revision -- and CI `checks` passed on `aad7cde`, the commit carrying that
  rewrite). The gap was elsewhere: `discoveryClaim` and `safeToGate` -- the booleans encoding "never claim a planet" and
  "never arm a spending gate uncalibrated" -- are pinned false by many per-module tests of the GENERATION code, but
  nothing read the PUBLISHED BYTES as a corpus, which is precisely the surface a visitor sees. `tests/redline-artifact-scan.test.ts`
  walks every `reports/**/*.json` plus `web/research.json`, `web/replay-manifest.json` and `web/candidates.json`
  RECURSIVELY and requires each `discoveryClaim`/`safeToGate` to be exactly `false`. The recursion is the point -- a
  nested `foo.discoveryClaim=true` is the same violation a shallow key lookup sails past. Two guards keep it honest: the
  scan asserts the fields actually appear in the corpus (so "zero violations" is a reading, not an absent-key tautology),
  and its control feeds a deeply-nested synthetic object and requires the walker to surface both flags.
  `scripts/audit/mutate26-redline.mjs` then tampers a REAL committed artifact (p44's `discoveryClaim` -> true) and requires
  the corpus case to go red naming that file, restore to 3/3, byte-identical. The corpus is clean today; this turns "the
  code would not produce it" into "the bytes we ship do not contain it."
- **R26-22, the report library's index and its built pages are only checked for one row, and the fleet's own merge is a
  desync path.** `web/app.js:1638` maps every index row's `slug` to `/reports/<slug>.html`, so a published row whose
  fragment is missing is a link a visitor clicks into a 404 -- the exact class round-25 hit when its release text cited
  `https://spacedatarig.app/reports/` (a directory with no index). Until now only p90's page was pinned
  (`tests/report-library.test.ts`). A live probe over all 56 rows was attempted and is the right manual complement
  (`scripts/audit/live-link-integrity26.mjs`), but outbound network to the edge was flaky this session, and per the
  round's own rule a transient connect timeout is not reported as a defect. The durable, hermetic version is the invariant
  itself: `tests/report-library-bijection.test.ts` reads the committed tree and requires the published `index.json` rows
  and the `web/reports/*.html` fragments to be a BIJECTION -- no row without a page (a live 404), and no orphan fragment no
  row references (dead bytes on the CDN) -- a real risk because `freshness-regen` merges with `-X ours` across `index.json`
  and fragments, so the committed state can be assembled by a merge rather than a clean p86 run. The comparison logic is
  exercised on synthetic mismatch/clean inputs before the corpus is checked, so "56 rows, 56 pages, 0 missing, 0 orphans"
  is a reading, not an absence. Corpus is consistent today; this is the backstop for the merge path.
- **R26-23, the live probe I shipped one commit earlier was itself broken, and running it is what said so.**
  `scripts/audit/live-link-integrity26.mjs` (added in `506c62f`) had two defects the round's own standard -- a transient
  network failure is never evidence -- indicts. First, it relied on undici's default (no timeout) with an uncaught top-level
  `fetch`, so a stalled edge connection HUNG the run forever instead of reporting. Second, once bounded, it still labelled
  `status 0` timeouts as "BROKEN (published row without a served page)": at concurrency 6 over a flaky network it accused 14
  report rows of being 404s that were really dropped requests -- the exact false accusation of the library that the tool's
  stated contract forbids. Fixed by giving every request `AbortSignal.timeout(12s)`, catching the index read, dropping
  concurrency to 2 with a retry, and splitting the outcome into three honest buckets: BROKEN only when the server ANSWERED
  with a non-200/non-HTML response; INCONCLUSIVE (exit 2) when pages could not be reached; OK only when all 56 resolved.
  Re-running against the live edge now returns "UNREACHABLE ... NOT a pass and NOT a defect" (exit 2) instead of hanging or
  falsely reporting. The hermetic bijection test is what CI trusts; the probe is best-effort and had to be held to the same
  honesty rule as everything else this round -- including, now, its own first author.
- **R26-24, R26-23's "run it before you trust it" was applied to the whole audit fleet, and the defect it found stayed
  isolated.** Rather than trust the tools that assert the round's numbers, each offline one was executed at HEAD
  `2f10f3a`: `unattested-census26` (33/33), `reproduce-command-census26`, `freshness-recheck` (findings 0),
  `net-census-audit26` (realCall 32 / mentionOnly 0), `unattested-blockers26`, `diagnose26-preflight` -- all exit 0.
  Every mutation drill (`stamp`/`reproduce`/`currency-control`/`replay-currency`/`redline`/`handoff-marker`) was re-run
  and each restored the tree byte-identical with `git status` clean afterward -- the positive controls still fire, and the
  drills still do not litter. Then the R26-23 class itself was swept across the network tools that share the flaky edge:
  `live-readback26` (120s timeout, throws loudly on failure so it never fakes a pass), `feed-fetch-to-post-gap` (45s +
  retry/backoff), `ci-watch26` (30s). All three already bound their requests, so the missing-timeout / transient-labelled-
  as-verdict defect was confined to the one probe R26-23 fixed, not a fleet pattern. No code change resulted -- the value
  is the reading: the tools that produce the ledger's claims were executed, not merely asserted, and their one known
  failure mode was shown bounded.
- **R26-25, R26-24 called a crash "throwing loudly," and running the tool proved the two are not the same thing.**
  R26-24 graded `live-readback26.mjs` as safe because its timeout made it "throw loudly on failure so it never fakes a
  pass." That is true but incomplete, and only re-executing the tool said so: the failure surfaces as an uncaught
  `DOMException [TimeoutError]` stack trace at exit 1, which is indistinguishable from "the tool broke" or "the served
  content disagreed" -- the exact ambiguity R26-23 removed from its sibling probe. A pass/fail exit code that fires for a
  dead network is itself a small false signal (the round's rule is that a transient failure is NOT a defect, so it must not
  leave the loudest exit code). Fixed by the same discipline: bound (60s, one retry -- long enough that a legitimately slow
  but working large `index.json` is not over-eagerly declared unreachable, the mirror image of R26-23's false 404), catch
  each request, and split buckets -- a clean "UNREACHABLE ... NOT a pass and NOT a defect" at exit 2 reserved for where
  the edge did not answer, while a 200 that disagrees with the committed bytes still surfaces. Guarded the served-index
  row lookup too, so a missing id reports `MISSING FROM SERVED INDEX` instead of throwing on `undefined.stamped`. Running
  the fixed probe against the degraded edge returned `UNREACHABLE: ... /reports/index.json (timeout)` exit 2 -- the honest
  verdict. `live-readback26` is still a diagnostic that cannot CONCLUDE while the network is down; the fix is that it now
  says which of the two it is doing.
- **R26-26, R26-25's lens (inspect the failure OUTPUT, not just the timeout) caught ci-watch26, which R26-24 had cleared.**
  R26-24's static fleet sweep marked `ci-watch26.mjs` sound because it set `AbortSignal.timeout(30s)`. But its `api()`
  only turned a bad HTTP *status* into `{error}`; a *thrown* fetch -- the very `github.com:443` connect timeout its own
  header comment describes -- still escaped as an uncaught DOMException, the same loud-but-illegible crash R26-25 had just
  removed from `live-readback26`. Having a timeout and failing legibly on a timeout are different properties, and only the
  R26-25 question ("what does the reader actually see when the network is down?") distinguishes them. Fixed by wrapping
  the request so both a non-2xx and a throw route through the same `{error}` shape the callers already print
  (`network: timeout` / `HTTP <status>`), never a stack trace. Re-run reached api.github.com and printed live check-runs
  (f833a92 in_progress, prior pushes success) with no crash. The sibling `feed-fetch-to-post-gap.mjs` was checked the same
  way and already qualifies -- it catches per request with backoff and guards every downstream field -- so it needed no
  change; recording that negative is what stops the next reader re-sweeping it.
- **R26-27, a public reply drafted this session attributed research-only false-positive machinery to the production gate,
  and tracing the claim to the code said so.** Answering a follower's methods question, the draft listed "subtract an
  ensemble common-mode template before BLS" and "a systematics-inclusive null" among the checks that run "before calling
  it a candidate." Those tools exist and are honest -- `src/detect/commonMode.ts`, `src/detect/instrumentalNull.ts`,
  measured in `scripts/p31-common-mode-fp.ts` / `p39` -- and `review.ts` / `candidateRecord.ts` will gate on a
  `systematicsFap` IF a caller supplies one. But the live money path never does: `src/cf/workflow.ts` builds the gating
  `vetting` object with exactly two fields, `fap` (the per-star `calibratedFap` red-noise null, :493) and
  `centroidShiftArcsec` (:531); it never sets `systematicsFap` and never subtracts common mode from `fr.lc` before the
  search, and it computes odd/even + secondary only to EMIT them as "informational, not gating" (:514-521). So the draft
  described a research result as a live veto -- the "deployed but inert" class, arriving through prose this time. The
  committed docs were already correct (`README.md` labels common-mode "research-only, worker not imported"; the
  workflow comment states the boundary precisely), so the fix is to the un-posted draft, not the code: it was rewritten
  to gate-claims only what the live path gates on, and to name the common-mode/systematics-null work as measured
  research pending calibration -- which is both true and a stronger answer, since it also concedes the per-star FAP alone
  moves the blind FP rate only ~25%->23%. Recorded as a self-caught communication defect. The durable lesson: before
  publishing any "our pipeline does X" claim, read the fields the production caller actually assigns, not the modules
  that exist.
- **R26-28, having caught the R26-27 overclaim in a draft, the same lens was turned on the committed docs -- and they
  hold the line.** The natural follow-up question is whether the boundary my draft blurred is blurred anywhere durable too.
  A sweep of `README.md` and `RESEARCH.md` for the research-only tools (common-mode, systematics-aware FAP, odd/even,
  secondary-eclipse) found every mention correctly scoped: README calls odd/even + secondary "DIAGNOSTIC ONLY and
  deliberately NOT [gates]" (:444-447, :1354) and common-mode "research-only, worker not imported" (:1509); RESEARCH.md
  presents the 35-42% and 61%->16% common-mode/systematics results as measured findings WITH their price stated ("keeps
  only 3 of 17 injected planets", :26-27) and describes `candidateRecord.ts` as accepting an *optional* `systematicsFap`
  (:277), never as a live gate. So the R26-27 defect was confined to an un-posted ad-hoc reply; the shipped documentation
  already maintains the research-vs-money-path boundary. Negative confirmation, no change -- recorded so the next reader
  does not re-run the sweep wondering whether the docs were ever checked.
- **R26-29, "32 rows need a networked re-run" was necessary but not sufficient -- the generators have no stamp to write.**
  The census framed the 33 unattested report rows as "waiting on a networked runner," implying a fleet re-run would attest
  them. `scripts/audit/stamping-plan26.mjs` checked the other half and found it missing: all 33 network generators call
  `buildStamp` ZERO times, so a fleet re-run today would STILL emit unstamped, unattested rows -- the network is necessary
  but not sufficient. The naive fix (stamp each generator's own source) is a trap the freshness gate itself warns about:
  a stamp naming only the generating code "verifies" nothing but "the code file did not change," flipping a row to
  `verified` as hollow false-comfort. So the tool separates the honest cases from that trap: it reads the published
  `index.json` for the authoritative unattested set, maps each to its generator, and statically extracts the committed
  DATA inputs each reads (excluding its own output, which is circular). Result: 10 generators have a real upstream
  committed input (p33/p35 read `p33-catalog.json`; p56 reads `p47`; p62/p67/p69/p73 read `p60`; p52 reads
  `src/data/vizierEb.ts`; ...) and can be stamped meaningfully -- the tool prints the exact `buildStamp([...])` line for
  each -- while 23 reference no committed input at all (pure network data), so they cannot be honestly attested from
  committed bytes and would need a network-provenance design, not a code-only stamp. All 10's inputs are confirmed present
  and git-tracked (0 absent/untracked), so those stamps would re-hash on any checkout. No generator was edited blind: the
  wiring is left as a turnkey, validated plan (the artifact half still needs the networked fleet to run), and the 23 are
  named rather than papered over with a hollow stamp.
- **R26-30, the served library was finally read back CONCLUSIVELY from the live edge, and it matches the committed,
  gate-verified tree -- including the 33-unattested figure R26-29 derived locally.** Every served-state read-back since
  the R26-19 deploy had been inconclusive (R26-23 and R26-25 both hit the flaky edge and correctly refused to call a
  timeout a pass). `scripts/audit/live-readback26.mjs` (the R26-25 three-bucket version) ran clean at exit 0 once the
  edge answered: `/health` -> gitSha `c93a43c`, deployVersion `6a9958fa`; `/research.json` -> the refreshed compute
  `{p 2.873, R^2 0.788, sampleN 204}` and addressable `{negatives 13, caught 2, auc 0.742}`; `/reports/index.json` -> 56
  rows, freshness `{stamped 23, verified 22, fullyVerified 22, unattested 33, stale []}`, with the five spot-checked rows
  all `stamped=true verified=true fresh=true`. Two things this closes: the R26-19 "what a visitor is actually shown"
  claim is now measured, not asserted; and the served `unattested=33` independently confirms R26-29's local-tree census
  from the public side -- the committed bytes and the served bytes agree, which is exactly the deployed-vs-inert gap the
  round keeps probing. No redeploy was warranted: R26-20..29 touched only offline tests, audit tools and ledgers, so the
  deployed `src/`/`web/` trees still equal HEAD's; the read-back confirms that rather than assuming it.
- **R26-31, turning R26-29's plan into write-side code -- and finding three bugs in my own planner before trusting it.**
  R26-29 shipped `stamping-plan26.mjs` as a "turnkey" that printed the `buildStamp([...])` line to wire per generator.
  Before editing any science generator I checked each printed input against the actual read site, and the tool was wrong
  three ways. (1) It counted p33 and p39 as "having a committed input" because they reference `reports/p33-catalog.json` /
  `reports/p39-candidates.json` by literal path -- but they *write* those, they don't read them; wiring them would have
  produced exactly the circular stamp (a file verified against itself) the tool's own header warns about. The scan only
  excluded the *primary* output `reports/<id>.json`, not secondary write targets. (2) It mapped a report id to its
  generator by bare `pNN` prefix, so the `p81` row resolved to `p81-round-figure.ts` (which writes only an SVG) instead of
  `p81-triceratops-lite.ts` (the real generator, which *already* stamps). The honest split is not "10 determinable" but
  **7 to wire** (p35, p52, p56, p62, p67, p69, p73), each verified to `readFileSync` a tracked committed report (or import
  a tracked src module) that it does not itself write. Those seven are now wired with `...buildStamp([...])` in their `meta`.
  (3) My first `tests/generator-stamp-wiring.test.ts` looked green but was **vacuous**: it grepped the whole file for the
  input path, so pointing a stamp at the wrong file still passed (the genuine read line elsewhere contained the path
  anyway). A mutation -- editing p35 to stamp its own output -- proved it: 0 failures. I rewrote the test to parse the
  actual `buildStamp([...])` argument list and assert every named input is read and none is a file the generator writes;
  the same mutation then produced 2 failures, and reverting restored 3/3. The artifact half of these seven rows stays
  `unattested` until the fleet re-runs them (MAST/S3 unreachable), the same write-side-ready / pending-fleet state as
  R26-5's p91 -- the wiring is committed and pinned by a test that is known, by mutation, to actually bite.
- **R26-32, the first of the seven wired generators actually RUN and attested, closing the R26-29->31 chain.** After a
  network switch the data-source probe read MAST/SPOC-S3/tesscut still UNREACHABLE but exoplanet-archive + Gaia TAP + the
  edge all HTTP 200. `p56-real-selection` is the one wired generator whose only live inputs are the archive and Gaia (it
  reads the committed `reports/p47-completeness-grid.json` and needs no S3), so it was runnable now. Ran it at exit 0 over
  18 real TIC hosts: the freshly generated `reports/p56-real-selection.md` is **byte-identical to the committed one**
  (only the `.json` changed, purely by the added `generatedAt`/`gitSha ddb1f1f`/`inputs` stamp), so the science
  reproduced exactly and the run added provenance rather than moving numbers. `p86-report-library` re-built the served
  index and the row flipped: `p56` is now `stamped=true verified=true fresh=true`, and the library moved from
  `{verified 22, unattested 33}` to `{verified 23, unattested 32}` with `stale=[]`. This is the proof-of-life for R26-31's
  write-side wiring -- the "network AND buildStamp, both required" thesis is now demonstrated end-to-end on one row, not
  asserted. The other six wired generators (p35/p62/p67/p69/p73 need SPOC S3; p52 needs S3 target pixels) stay
  write-side-only until those sources return; running them now would either fail or emit a degenerate report, which is
  not attestation. Web assets changed, so this batch needs a redeploy to reach the public served index.
- **R26-33, the public read-back was spot-checking yesterday's frontier, not today's.** `live-readback26.mjs` hard-coded its
  spot-check list to the R26-2 offline FIVE (p34/p54/p63/p68/p79), so even after R26-32 attested p56 the conclusive served
  read-back never actually looked at the row that had just flipped -- it confirmed a set that hadn't changed in six rounds
  and stayed silent on the one that had. Added `p56-real-selection` to the list (renamed the key `five` -> `spotChecks`) and
  commented that it must track the attestation frontier. Re-ran against the live edge: `p56-real-selection: stamped=true
  verified=true fresh=true reproducible=2`, exit 0. A smaller cousin of the R26-24 lesson -- a checker is only as good as
  whether it inspects the thing that actually moved.
- **R26-34, CI caught my own process miss: the R26-32 milestone archive was committed red, and the gate that fired was
  the one that reads the archive itself.** `b27c8db`'s `checks` job went `completed/failure` on one test:
  `devlog/2026-10-27-r32-p56-attestation-milestone.md: must cite the Actions run that posted it`. The repo's
  `devlog-archive.test.ts` requires every archived entry's header to literally contain `actions/runs/<id>`,
  ``posted id: `<digits>` `` and ``HTTP `204` `` -- the evidence format that makes a public post auditable. My R26-32
  evidence wrote those facts loosely (`run=40497903118`, "Tweet id:", "HTTP 204 accepted"), so the archive failed its
  own integrity gate. The deeper miss is procedural: `187b086` added a `devlog/*.md` -- a path the test suite inspects --
  but I ran `npm test` at `c888151`, *before* the archive existed, and then committed and pushed the archive without
  re-running the suite at that commit, which is exactly the R26-13 rule. CI did the job my local gate skipped. Fix: the
  evidence header now uses the canonical citation form (matching `2026-10-18-byte-exact-devlog-archive.md`), re-archived
  through `devlog-archive.ts` so the pushed text stays the same 1341 bytes, and `npm test` re-run at the corrected tree
  gives 1031/0. Recorded plainly because a checker that only the CI catches is a checker I should have run.
- **R26-35, running a "determinable" generator proved two of my own earlier claims wrong.** (1) R26-32 said the six
  remaining wired generators were blocked because SPOC S3 was unreachable. That probe hit the WRONG host: `mastS3.ts`
  actually fetches from `stpubdata.s3.amazonaws.com`, which answers HTTP 200 (the `aws-oss.mast.stsci.edu` I probed is not
  what the code uses). p35 ran against REAL photometry for 27 host curves right now -- reachability was never the blocker.
  (2) More importantly, "has a committed input" (the R26-31 stampability criterion) turned out to be *necessary but still
  not sufficient*. Re-running p35 faithfully (`--stars 33 --maxsectors 2 --seed 7`) did NOT byte-reproduce its published
  numbers: 27 curves / 6 coverage misses vs the committed 26 / 7, and PDM-vs-BLS agreement and per-depth completeness all
  moved. The reason is that p35's result is determined by the SPOC bytes it *fetches*, and its `buildStamp` only hashes the
  committed catalog + its own source -- so the artifact would flip to `verified` while the thing that actually changed (the
  network light curves) sits outside the stamp. That is false comfort in a subtler costume than the own-source trap: a
  stamp that passes but does not pin the real inputs. p56 was safe to attest precisely because it *byte-reproduced* -- its
  committed p47 grid fully determined the output, so the run added provenance without moving a number. Decision: p35 was
  reverted, not attested; a misleading `verified` row is worse than an honest `unattested` one. Each of the other five
  wired generators now faces the same test -- attest only the ones that byte-reproduce; the rest need a data-provenance
  design that records the fetched bytes (the R26-29 "provenance design," now shown to apply to the wired six too, not just
  the pure-network 25). Lesson for the ledger: a network-data generator is only honestly stampable when its non-committed
  inputs are themselves reproducible, and the way to find that out is to run it and diff, not to trust the input list.
- **R26-36, the run-and-diff test the R26-35 lesson demands, applied to p69 -- which reproduced and so was attested.**
  p35 failed to reproduce because its host sample comes from the p33 catalog that grew 33->204; but `p69`
  (`rednoise-significance`) draws its fixed 10-host set from the *committed* `reports/p60-joint-vs-single.json`, so the
  R26-35 reasoning predicted it might reproduce. Ran it faithfully (`--targets 10 --nnull 100 --trials 100`, seed 7): the
  report `.md` came out **byte-identical** (same 10 hosts 8-quiet/2-red, mean delta 0.266, 5/8, max resSnr 1172, same
  verdict), and the `.json` changed only by the added stamp plus a cosmetic row re-order (HR 858 c/d, HD 25463 b/c swapped
  -- same set, sequence only, which is exactly why the aggregate md is unchanged). So p69's published science genuinely
  reproduced and its stamp pins the real determinant (p60). `p86` re-attested: p69 now `verified/fresh=true`, library
  `{verified 24, unattested 31}`. This is the R26-35 rule working as intended -- attest on byte-reproduction, not on the
  input list. The remaining p60-based wired generators (p62/p67/p73) share p69's fixed-host pattern and are the next
  run-and-diff candidates; p52 (S3 target pixels + vizier) is its own case. Reverted p35 stays unattested.
- **R26-37, p62 and p67 both byte-reproduced and were attested -- unattested 31 -> 29.** Following the R26-35/36 rule,
  ran the two p60-based joint generators faithfully at their committed settings (p62 `--minsnr 7 --tol 5 --win 0.1
  --oversample 24`; p67 `--minsnr 7 --tol 5 --win 0.1 --k 3`) over the fixed 20-planet P60 sample. Both report `.md` came
  out **byte-identical** (`git diff --numstat` empty; VERDICTs unchanged -- p62 "NO-LIFT-JOINT-NOT-A-FREE-LUNCH", p67
  "MODEST-SEED-LIFT"), and each `.json` changed only by the added stamp plus a cosmetic row re-order (the same async
  fetch-completion ordering seen in p69: same row multiset, different sequence -- which is exactly why the aggregate `.md`
  is stable). So both reproduce and both were attested via `p86`: `{verified 26, unattested 29}`. A noted wart, honestly
  recorded: p62/p67/p69 emit their JSON rows in non-deterministic order, so the committed artifact is stable in its
  published numbers but not byte-identical in row sequence across runs -- the freshness gate is unaffected (it hashes the
  inputs, not the output order), and the `.md` is the human-facing surface. p73 (masked-recovery, same fixed-host pattern)
  and p52 (target-pixel based) remain to be run-and-diff tested; p35 stays reverted.
- **R26-38, p73 byte-reproduced and was attested -- the whole fixed-p60-family is now machine-verified (unattested 29 -> 28).**
  Ran p73 (`--minsnr 7 --tol 5 --win 0.1 --k 3 --pad 0.25`, masked-recovery over the 20-planet P60 sample with sibling
  masking). Its `.md` came out byte-identical (`numstat` empty; VERDICT unchanged: "MODEST-SIBLING-LIFT: re-find 6->7/20,
  well under the ORACLE 11/20"), and the `.json` gained only the stamp + the same cosmetic row re-order. `p86` re-attested:
  `{verified 27, unattested 28}`. With this, every generator whose committed input fully determines the output on a fixed
  host set is attested (p56 via p47; p69/p62/p67/p73 via p60). Of the original seven wired candidates, only p35 stays
  unattested (its p33-catalog grew -> does not reproduce) and p52 remains to test (target-pixel based). The R26-35 rule
  -- attest only on byte-reproduction, never on the input list -- has now gated four attests and one refusal, exactly as
  intended.
- **R26-39, the session attestation milestone is archived verbatim to `devlog/`.** The milestone post (id
  `2115284343753003238`, dispatch run `40626792063`, head `43352f5`, CI run `40625542765` completed/success) is
  byte-copied through `devlog-archive.ts`; the evidence header carries the canonical citations the integrity gate
  requires (`actions/runs/<id>`, backtick-wrapped `posted id`, HTTP `204`) per R26-34. Because it touches `devlog/`
  (a test-inspected path) the full suite was re-run at this HEAD: 1031/0. No `src`/`web` change, so no redeploy.
- **R26-40, p52 tested by the run-and-diff rule and correctly kept unattested -- the mechanical-stamping frontier is exhausted.**
  Ran p52 faithfully (`--hosts 12 --cone-radius-arcsec 21 --list-rows 3000`). It did **not** byte-reproduce: the committed
  report parsed 9000 GCVS variables / 944 eclipsing binaries, the re-run fetched 0 (the VizieR list path was returning empty),
  so the intermediate numbers moved even though the final verdict (0 usable negatives, NOT-CONSTRUCTIBLE) matched. p52's
  `buildStamp` pins only its own source + `src/data/vizierEb.ts` -- a code module, not the live GCVS bytes that determine the
  result -- so stamping it would be the same false-comfort R26-35 refused for p35. Reverted (`git checkout --`), kept unattested.
  Conclusion: of the seven R26-31-wired generators, five (p56/p69/p62/p67/p73) reproduce on fixed committed inputs and are
  attested; two (p35, p52) are network-determined and cannot be honestly stamped by run-and-diff. Raising the verified count
  further needs a data-provenance design that hashes the *fetched bytes* into the stamp, not more mechanical stamping.
- **R26-41, the freshness gate itself over-counted `verified`: a code-only stamp is now refused (verified 27 -> 24).**
  Testing R26-40's conclusion against the *published* index found the same false-comfort already shipped as machine-checked:
  p41, p88 and p92 were `verified:true` purely because their `buildStamp` re-hashed `.ts` files (the generator's own source +
  imported detection/data modules). Re-hashing code proves the algorithm is unchanged; it can never reveal a stale DATA input,
  which is exactly what these network-photometry reports derive their numbers from -- so a stamp over only code was the R26-35
  own-source trap in its published form. Fix, in the pure decision logic (`report-freshness.ts`): `compareInputs` now counts
  `reproducibleData` (re-hashed, tracked, matching inputs that are NOT source code) and `verified` requires `reproducibleData > 0`;
  a fresh-but-code-only row keeps a precise reason ("source code, not a data file the numbers were computed from") and the amber
  provenance note, never the green check. `p86` publishes the new `reproducibleData` field; the independent `freshness-recheck.mjs`
  audit tool mirrors the rule WITHOUT importing the gate, so if the gate drifts the two disagree and the alarm rings. Rebuilding
  the library moved served `verified`/`fullyVerified` 27 -> 24 (the three demoted are the code-only set); `unattested` stays 28
  (driven by stamped count) and `stale=[]`. This is a *downward* correction of our own published figure -- the honest machine-checked
  count is 24, not 27. Mutation-checked: reverting the rule fails the new code-only test; the recheck-tool fixture was switched to a
  data input so it still proves flat-shape handling. Tests touched -> full suite re-run at HEAD before push (R26-13/R26-34).
- **R26-42, the R26-41 correction is published and archived verbatim.** Because the previous milestone post (id
  `2115284343753003238`) reported `verified 27` -- a figure R26-41 proved was inflated -- prose must not lead the served data:
  a transparency follow-up was dispatched through `x-post.yml` (`workflow_dispatch` run `40632716937`, HTTP `204`, head `20457a3`,
  CI `40631800220` completed/success), confirmed by the job log `x:post: OK posted (id 2115300234591076859)`, and guarded by a
  real pre-flight DRY RUN (`length=1472/25000`, nothing sent locally). The post text and evidence are byte-archived to
  `devlog/2026-10-28-r41-verified-count-correction.md`. The post states the lowered count (24, not 27) and the code-vs-data rule;
  it claims no discovery. Only `devlog/` + this ledger changed -> no `src`/`web`, no redeploy; full suite re-run at HEAD (R26-34).
- **R26-43, a call-site-precise sweep confirms the offline-attestation frontier is exhausted (negative finding, ledgers only).**
  After R26-41 the question was whether any of the 30 remaining unattested/unverified reports could still be honestly stamped by
  re-running offline against a committed data input. A scanner that flags a generator as network ONLY when it INVOKES a real data
  fetch (not merely imports a parser, prints an `https` link, or references a URL string) found all 30 call SPOC / Gaia / ExoFOP /
  VizieR at runtime (`fetchSpocBytes`/`fetchSpocLightCurve`/`fetchSpocTargetPixels`/`sectorsForCoord`/`buildEbListUrl`/...). So the
  fixed-committed-input family (p56/p62/p67/p69/p73) is fully attested and NOTHING more is mechanically attestable -- raising
  `verified` past 24 needs the fetched-bytes provenance design, and the network sources are additionally unreachable from this
  environment right now. Recording the boundary so the next reader does not redo the sweep; the gate R26-41 hardened is what keeps
  this honest (no code-only stamp can quietly re-inflate the number). No code/artifact/index changed, so no redeploy.
- **R26-44, the R26-41 code-vs-data lesson transplanted to `web/research.json`: clean, and pinned a stronger way (negative).**
  `research.json` is the other asset the feed links as "Numbers + data" (its `compute.exponentP` renders as a dashboard card),
  and it carries only a `generatedAt` -- no `inputs`/sha256 stamp -- so the natural worry was the same hollow-verified shape.
  It is not. The `tests/research-bundle-currency.test.ts` gate does not trust a stamp at all: it re-runs `p38` from the
  committed reports RIGHT NOW and asserts the shipped bundle is byte-equal to the fresh build (ignoring only `generatedAt`),
  so it pins the DATA (`reports/p33/p34/p35/p39/p50`) by reconstruction -- strictly stronger than a checksum that re-hashes code.
  Its positive control is content-anchored (locates the pre-refresh exponent `2.936...` in git history, not a log position) and
  fails the gate on the rendered `compute.exponentP` path specifically. So no gap to fix here; recorded so the next reader does
  not re-audit it. No code/artifact/index change, no redeploy.
- **R26-45, the live read-back now proves the served FRAGMENT matches the index verdict (codifies R26-41's reader-facing effect).**
  The index flag (`verified:false` for p41/p88/p92) and the rendered HTML fragment are two byte streams a deploy can desync --
  index rebuilt but fragment stale, or vice versa -- so a demotion that is real in the JSON but invisible on the page would still
  mislead a reader (the R26-22/R26-24 lesson: a checker must inspect what actually moved). `scripts/audit/live-readback26.mjs` now
  re-derives the code-only class from the SERVED index (stamped, not verified, still code-reproducible) and fetches each row's page,
  asserting the amber provenance banner is present -- and that a spot-checked verified row renders WITHOUT it -- exiting 1 on any
  divergence. Run against production it confirms all three demoted pages carry the banner and three verified pages render clean
  (exit 0). Verified live because it is a network tool by design (not part of `npm test`). The tool is the only change; no
  artifact/index touched, so no redeploy. The R26-41 correction is now provably visible to a visitor, not just machine-readable.
- **R26-46, a tracked live-API coherence probe covers the surface `npm test` cannot reach.**
  The dashboard- and digest-facing endpoints (`/api/state`, `/api/findings`, `/api/anchor-health`, `/health`, `/research.json`)
  are hermetically invisible to the test suite: a wrong top-level projection or a secret leaking into a response body would keep
  `npm test` green. Ad-hoc `out/` probes checked them but are gitignored and easily lost (the R25-5 lesson: measurement scripts the
  ledgers promise belong on tracked paths). `scripts/audit/api-surface-probe26.mjs` now pins each endpoint's load-bearing projection
  keys and scans every body against a SECRET pattern (alch_/ghp_/sk-/xai-/private-key/ACCESS_TOKEN_SECRET/SOLANA_KEYPAIR), applying the
  R26-25 semantics: unreachable -> exit 2 (not a defect), a non-200 / missing key / leak -> exit 1 naming the finding, else exit 0. Run
  live: all five endpoints 200, shapes ok, no leak. Mutation-verified -- demanding a bogus key made it exit 1 and name it, proving the
  detector is not a vacuous pass. New tracked tool + ledgers only; no artifact/index/src change, so no redeploy.

Tests: new `tests/generator-stamped-reports.test.ts` (4 cases) pins the fix from three angles at once -- the generator
source must call `buildStamp`, the artifact must record a non-null checksum for every input and every input must be
tracked *and* still match the bytes on disk, and the built index must call the row verified rather than merely stamped.
New `tests/generator-stamp-wiring.test.ts` (3 cases, R26-31) pins the seven write-side wirings by parsing the actual
`buildStamp([...])` argument list -- asserting each named input is genuinely `readFileSync`'d and that no stamped input
is a file the same generator writes. It was mutation-checked by pointing p35's stamp at its own output: the first
(whole-file grep) version stayed green and was rewritten; the argument-list version failed 2 of 3 and restored on revert.
Mutation-checked with `scripts/audit/mutate26-stamp-test.mjs`, which restores both files byte-for-byte and re-runs:
deleting p79's `buildStamp` call turns 2 of 4 red (the source check *and* the self-referential checksum, which is the
point of stamping a generator's own file); corrupting one recorded checksum turns 1 red and names the input it is stale
against; restored gives 4/4. The drill also exposes its own limit and it is recorded here rather than hidden: the
index-level case did **not** fail on the corrupted artifact, because the index was built before the corruption -- so the
reproduction case, not the publication case, is the sharp one.

Close: suite 1007 -> **1019** pass / 0 fail (132 files, +3 files / +12 tests), `typecheck:all` 0, `eslint
--max-warnings 0` clean. No `src/` change and no `web/app.js` change in this round's first increment; the shipped
surfaces are `reports/`, `scripts/`, `web/reports/` and `web/research.json`, deployed as version 556fede6 (R26-10). The
second increment touches `scripts/p38-research-bundle.ts`, `scripts/p91-claim-provenance.ts`,
`.github/workflows/freshness-regen.yml` and tests only, so the deployed assets are unchanged and no second upload was
needed. The third increment adds reproduce commands to three generators (p68/p90 re-run offline, p91 awaiting the
networked fleet), the `reproduce`-command ratchet and the round's audit tools, and merges the fleet's own publish commit
`61ca06c`, which moved the published library to verified 22 / unattested 33. A deploy follows the merge, because after
it the local tree is ahead of what the edge serves. `discoveryClaim` stays false in every report touched,
`ledgerAnchored` stays 23, and no anchor or wallet operation is involved.

### Twenty-fifth round (audit of the REPORTING gate, then of the audit of it): the freshness verdicts reproduce independently, the alarm nobody had ever heard now rings, and the round's own checker turned out to have the same blind spot (2026-10-26)
Round-25 rotates off the X channel onto the surface round-23's public post leaned on: `scripts/report-freshness.ts` +
`scripts/p86-report-library.ts`, the gate that decides which reports the site may call machine-checked. Method, same as
round-24: do not trust the artifact's own summary -- recompute it, then make the alarm fire on purpose.
- **R25-1, measured and CLEAN (recorded because a passing gate is a claim too):** every `verified` / `stale` verdict in
  the published `web/reports/index.json` was re-derived from this checkout by a script that deliberately does NOT
  import the module under audit (`scripts/audit/freshness-recheck.mjs`: own sha256 with the same EOL normalisation, own
  `git ls-files`). **Every stamped-with-checksums report reproduced exactly, 0 disagreements, 0 stale.** Round-23's post
  cited p82/p84/p85/p93 as verified; their stamps cover committed fixtures (`tests/fixtures/scaled/*.jsonl`), not
  gitignored working files, so that citation stands.
  WITHDRAWN THE SAME ROUND, see R25-7: the count "15 of 15" in the first draft of this line was the CHECKER's coverage,
  not the library's -- the recheck could not read the flat stamp shape at all, so the two rows it silently skipped were
  the two rows this round was sent to investigate. The verdicts it did compare still reproduce; the sentence that said
  which ones had been compared was wrong.
- **R25-2, the real gap: the gate's second half had never been executed anywhere.** `report-freshness.ts` opens by
  claiming the "prove the alarm rings" pattern, and `tests/report-freshness.test.ts` does honour it -- for the pure
  decision function. But p86's publish-time behaviour (exit non-zero on a stale report, the red banner on the
  fragment, the id landing in `freshness.stale`) was covered only by static assertions on the COMMITTED artifact, which
  prove the last build saw a clean tree and nothing about the next one. New
  `tests/p86-stale-alarm.test.ts` (4 cases) runs the REAL script in a throwaway git repo with one stamped report whose
  single recorded input is a tracked file, then tampers that file: baseline publishes it as `verified` with
  `stale: []`; tampered, p86 exits 1, prints `p86: STALE p99-drill ... sha256 differs`, refuses ("refusing to publish
  1 stale report") and still records the id in the index it just wrote; `--allow-stale` returns 0 but keeps the
  banner AND the stale entry.
- **R25-3, the posture the header quietly overstated:** the ONE workflow that rebuilds and publishes the library
  (`freshness-regen.yml`) passes `--allow-stale` by design -- one unreachable catalog must not block three good
  refreshes -- so the blocking exit is not on any CI path, and what the public actually relies on is the RED MARK
  surviving that flag. Deliberate, not a bug; but "exits non-zero so the deploy step refuses to publish" reads like a
  live guarantee unless you go find the caller. Stated in the module header now, and pinned by a test so a future
  edit that makes `--allow-stale` suppress the banner as well (or drops the word `stale` from index.json while keeping
  the banner) fails instead of rotting silently.
- **R25-5, the audit tooling had the same hole the gate exists to close -- three times over.** Round-24's ledger
  promised "the measurement script is the tripwire", this round's draft said the same about its own recheck script, and
  round-21 had pinned a number to a script that lived only in the gitignored scratch directory. `out/` is ignored and
  `git ls-files out/` returns NOTHING, so in all three cases the artefact a reader is directed to does not exist
  outside the one
  workstation that ran it: computed but not published, the round-6 failure class aimed at our own audit trail. Fixed
  by moving all three under `scripts/audit/` (`freshness-recheck.mjs`, `feed-fetch-to-post-gap.mjs`,
  `anchor-health-measure21.ts`), re-pointing every ledger sentence, and adding
  `tests/ledger-artifacts-tracked.test.ts` (3 cases): any `out|scripts|tests|src|reports|web/...{.mjs,.ts,.py,.sh,.js}`
  path named in CHANGELOG / RESPONSE-TO-AUDIT / HANDOFF must be in `git ls-files`, with a two-entry allowlist for
  genuine runtime paths that is itself tested (every exempt path must still be untracked and still be under `out/`).
  The gate failed on its FIRST run, which is the only useful thing a new gate can do: three ledger sentences still
  named the script at its ignored path, and one of those sentences had been written by this round. Moving the script
  into `scripts/` also exposed that it had NEVER been typechecked or linted (it lived in the ignored directory); it
  now is, and re-running it reproduces round-21's pinned counters byte-for-byte
  (`20 anchored / 0 match / 2 nmd / 1 rejected / 3 conflict / 3 stand-in / 4 unverifiable / 0 missing`).
- **R25-6, the site's honesty marks had never been executed by anything, and one was written fail-OPEN.**
  `web/app.js` draws three badges per report row, and 40 of the 56 published rows exist in the public eye only because
  one of them says `provenance unverified`. The predicate was `r.verified === false`: a row whose `verified` key is
  merely ABSENT -- an older or hand-patched `index.json`, a partial publish, a future writer that forgets the field --
  rendered with no mark at all and read as clean. The gate's own doctrine is that machine-checked must be EARNED, so
  the mark now fires unless `verified` is explicitly `true` (`!== true`). New `tests/web-report-badges.test.ts` (3
  cases) lifts the three predicates verbatim out of the served file and runs them, the way round-24 ran the workflow's
  own shell: a truth table, plus an assertion over the REAL published `index.json` that every not-machine-checked row
  carries a mark. Mutation-checked -- restoring `=== false` fails the table with `actual: [] expected: [ri-unverified]`.
- **R25-7, the checker had the blind spot it was written to find -- and this round walked into it twice.** The
  independent recheck resolved the stamp from `doc.meta` only, while generators emit two shapes: nested `meta`, or
  spread flat at the top level. The flat rows are p88 and p89, the two this round was sent to investigate, so the tool
  printed `stamped=15, disagreements=0` against a published index of 17 and the mismatch got rationalised in the ledger
  prose (see the withdrawal in R25-1) instead of being flagged. It also `continue`d past any row whose JSON it could
  not open: a `verified: true` claim over a missing artifact would have scored as agreement. Fixed by resolving both
  shapes independently, putting every row in exactly one named bucket, comparing the tool's buckets to the index's own
  counts as a finding, splitting fatal disagreements from already-disclosed observations (a permanently-red gate gets
  ignored, which is the round-24 lesson), and exiting 1 on any finding. It now accounts for all 56 rows
  (`opened=54 absent=2`, `stamped=17/17 (flat-shaped=2)`, `verified=16/16`, `findings=0 observations=1`). New
  `tests/freshness-recheck-gate.test.ts` (4 cases) runs the real script over this checkout AND over throwaway repos
  holding deliberately mis-stamped indexes -- the flat stamp is now seen, `verified=true` over a missing artifact and a
  changed checksum inside a flat stamp both ring -- so the recheck is executed by CI through `npm test` rather than
  being a script someone might remember to run.
- **R25-8, p88 was the cheap unattested row, and it is now fully verified with zero drift.** Re-ran the generator with
  the same arguments the index records (`--pos 8 --neg 10 --tmag 12`) after probing both archives from this workstation
  (ExoFOP 200 in 25.6 s, Gaia TAP 200). The only byte changes in the artifact are its `generatedAt` and the stamp the
  script had been emitting all along but the committed file predated: `gitSha` plus three input checksums. Every
  published number is identical -- n=17, 7 planet / 10 blend, 6 with Gaia data, 0 period-matched, 0 false vetoes,
  `safeToGate: false`, and the `.md` is unchanged enough to not even show in `git status`. Through the CI invocation
  (`npm run p86:report-library -- --allow-stale`) the library moved 15 -> 16 `verified` and 15 -> 16 `fullyVerified`,
  `stamped` 17, `stale: []`, `unattested` 39 -- no public claim needed correcting, because nothing quoted a p88 number
  as verified before and the row's own `verified` flag flipped only after the re-run.
- **p89 stays open, measured rather than assumed:** its re-run needs the MAST API and this workstation cannot reach it
  (`mast.stsci.edu` connect-timed out at ~10.6 s on three probes while `stpubdata` S3 answered 200), so it remains the
  one flat-shaped, input-less stamp. That is the honest state the site publishes (`stamped`, not `verified`), and the
  scheduled runner -- which has network -- is where it gets closed.
- **R25-9, measured and DECLINED (a no-change with evidence, not a shrug):** the gate's soft note "a source this report reads is
  newer than the report" only fires when the report has recorded checksums, so the 39 unstamped rows can never get it -- and
  their sources are not recorded anywhere, since only two `SOURCE_DEPS` entries exist. The tempting fix was to derive the
  generator from the report id: a `pNN-something` id naming the same-named module under `scripts/`. Measured first: the convention resolves
  35 of 39 rows (4 do not: p44-diff-imaging, p58-veto-2x2, p61-llm-hypothesis, p65-external-audit), and of the 35 exactly 3
  have a generator whose last commit is later than the report's `.md` -- by 2 h 15 m, 2 h 36 m and 3 h 12 m, all same-day.
  Those are the shape of a generator being finished after its output was written, which is the identical false-positive class
  that made this gate stop using wall-clock to BLOCK (round-16's lesson, stated in `evaluateAgainst`'s own header). Inventing
  provenance for a row to then mark it "possibly out of date" would trade a true `unattested: 39` for a fabricated 3. Left
  alone; the real fix is re-running the generators.
- **R25-10, "shipped" was not true yet, and the ledger said so wrongly.** Both entries above used the word published and the
  close line said "nothing deployed" -- but `web/reports/index.json` and `web/app.js` are SERVED files, and no workflow in
  this repository deploys anything (checked: 14 workflows, zero `wrangler deploy`; `ci.yml` only tests, and
  `freshness-regen.yml` commits a rebuilt library without publishing it). Measured against the live site before acting:
  `/reports/index.json` was generated 2026-10-23 and still said `verified: 15` with p88 `verified=false`, one row diverging
  from the repo. `/health` gave the reason precisely -- `gitSha ab0ce34...`, the newest `src/` commit, with 15 src files
  differing from the older `1e6572b` the HANDOFF had called the serving commit, and `wrangler.toml`/`package.json` identical
  since -- so a redeploy from HEAD ships the SAME Worker code and config (`AUTO_ANCHOR=live` untouched) and changes only the
  static assets. Deployed through the repo's own `npm run cf:deploy:sha` (dry-run first), version
  `f1a50e51-104c-4838-86cb-f9827c426cd2`, then verified what the public receives rather than what wrangler reported:
  `/health` `gitSha=8aad1dd2edf3...` and `deployVersion` matching, live `index.json` `verified=16 fullyVerified=16 stamped=17
  unattested=39 stale=[]`, p88 `verified=true rehashed=3`, served `app.js` containing `r.verified !== true` and no longer
  containing `r.verified === false`, the p88 fragment carrying neither the red banner nor the amber note, and `/api/state`
  200 with 104 findings. This is the round-24 F16 class one layer up: a green check that never touched the surface a reader
  sees.
- **R25-11, the handoff's own clock could name a sha and still describe a stale deployment -- now it cannot be that
  silent.** Round-24's F15 found this bullet two deploys behind and concluded `tests/handoff-freshness.test.ts` "cannot
  catch this class", because it never compares the named revision with the live endpoint. CI has no network, so that
  half is still out of reach -- but the other half is a git fact: `wrangler deploy` uploads exactly two trees, the
  Worker bundle from `src/` and the static assets from `web/`. A fifth check now requires the revision named as
  production to have the SAME `src/` and `web/` content as HEAD, or the bullet must carry the marker
  `awaiting deploy` so the gap is stated where a reader finds it. Mutation-checked by pointing the bullet at the real
  previous deploy (`ab0ce34`, before today's asset work): it fails naming precisely `web/app.js`,
  `web/reports/index.json`, `web/reports/p88-independent-corroboration.html` and no `src/` file -- which is exactly the
  shape of what R25-10 had to deploy. Before that, this gate would have let round-25's "shipped" stand.
- **Tests + close.** `tests/p86-stale-alarm.test.ts` is the first file in the suite to execute p86 at all, and
  `tests/ledger-artifacts-tracked.test.ts` the first to check what the ledgers promise;
  `tests/web-report-badges.test.ts` is the first to run the served badge predicates, and
  `tests/freshness-recheck-gate.test.ts` the first to gate the independent recheck. Suite 992 ->
  **1007** pass / 0 fail (129 files, +4 files / +15 tests), `typecheck:all` 0, `eslint --max-warnings 0` clean,
  `node --check` clean on all 6 `web/*.js`; CI green on both round-25 commits (`12fedbf`, `8aad1dd` -- checks + digest),
  which also proves the two alarm drills work on the runner and not just on this workstation. No `src/` change; the
  static-asset deploy R25-10 required shipped identical Worker code and config, live-verified at
  `f1a50e51-104c-4838-86cb-f9827c426cd2`. The alarm drills write only inside their own temp repos. And the ledger gate
  earned its keep a second time in the same round: it failed the suite over the schematic path written in this round's
  own R25-9 entry (`scripts/` + a placeholder filename that is not a real file), which is a false positive only in the
  sense that the sentence was careless -- it named something no checkout can contain, exactly as the three real
  offenders did. Rewritten to describe the convention instead of printing a path.
- **Milestone post, published once.** The English feed post for this round (5584 chars / 32 lines / pure ASCII) went out
  through `x-post.yml` `workflow_dispatch` with `inputs.maxlen=25000`: HTTP `204` at
  2026-10-26T13:59:34.822Z, run 40335501130 (`digest` success), posted id `2114718667191816270`. The local guard DRY RUN
  (a scratch script that calls the sender's own three predicates over the exact bytes, no send path involved) REFUSED
  twice -- the stem
  `first`, then the time word `today` -- and both times the text was rewritten and the guard left untouched; a third
  phrase was corrected before the guard saw it, because "blind to a third of the corpus" was wrong arithmetic (2 of 17
  stamped rows, not a third) and no regex catches a wrong number. Link checking caught a live 404:
  `https://spacedatarig.app/reports/` has no directory index, so the post cites `reports/index.json` and the p88
  fragment, both fetched at 200, while the three commit objects and the CI run were confirmed through the API because
  github.com HTML pages time out from this workstation -- disclosed in the evidence header rather than glossed. The
  figure was drawn twice: the first render made the "1 stamped, no inputs" band about a third of the bar wide, lying
  about its own label, the same defect round-24 found in its own plot; the published version draws it as one unit of 56
  with a leader line. `devlog/2026-10-26-round25-audit-of-the-checker.md` (11763 bytes) carries the posted text
  verbatim, asserted byte-for-byte by a scratch integrity check (5584 == 5584, appearing exactly once, evidence header
  included). The evidence header names no working file as a kept artefact, for the reason R25-5 gives.
- **Still open after this pass, named rather than smoothed:** `unattested: 39` of 56 reports carry no stamp at all --
  the gate cannot detect staleness in them and the site says so, but 39 is a large honest hole and closing it means
  re-running 39 generators, most of them network-bound. p88 closed here (R25-8); p89 is blocked on MAST reachability
  from this workstation and is left to the scheduled runner rather than faked with a hand-written stamp.

### Twenty-fourth round (self-audit): the round-22 feed-efficiency gate skipped nothing for ten runs, and the one window it DID prove empty came back as a failed job (2026-10-26)
Round-24 is an audit of the previous round's own work rather than of the science. Method: read the pre-flight
against the composer it gates, then falsify it against live traffic instead of trusting the local four-case check
that round-22 had shipped on. Eleven defects closed (F1, F2, F3, F4, F5, F11, F13, F16, F17, F18, F19), one measurement that
stopped us changing something, and two ledger
failures of our own. Nothing here alters what the feed posts or how often, with one deliberate exception (F16): the
gate changes are all conservative in the same direction -- they can only make the pre-flight PROCEED more often, never
suppress a post -- F17 restores a watchdog the gate had quietly disabled, F18 only changes what the auditor can see,
and F16 turns a silently mangled post into a refusal.
- **F3, the root cause (measured, not guessed): the gate was inert.** Over the ten live runs after it shipped it
  skipped **0**, and two of them paid for a full compose pass on content the previous run had already announced.
  The cached hint recorded only the cursors a run READ off the feed, never what it POSTED, so it lagged one full
  cadence and the "is there anything new?" test kept answering yes about yesterday's news. The hint is now advanced
  from the run's own pre-fetch snapshot (`FETCH_EPOCH`, backed off 30 s, and provably never newer than a post the
  run makes), and any cursor the run could not read is written EMPTY so the next pre-flight must proceed. Verified
  live: run 40301862903 read a 09:00:38 cursor, posted twice, and wrote a 09:44:02 hint -- a ~44-minute lag became
  ~30 seconds, and the next tick proceeded on a real new candidate instead of an announced one.
- **F13, found because F3 finally let the empty branch fire: a provably-empty window FAILED the job.** GitHub runs
  every `run:` block under `bash -e`, and the step called the pre-flight as a bare `node ...` followed by
  `code=$?` -- so returning the designed 42 aborted the step on the spot. Observed live on run 40303969337
  (`x-post-preflight: window provably empty ... ##[error]Process completed with exit code 42`): `skip=1` was never
  written, the job was red, and the later steps were skipped by the failure rule rather than by the gate. The cost
  saving was real; the "clean skip" round-22 documented was not a thing. Fixed with `code=0; node ... || code=$?`,
  proven mechanically (old idiom exits 42 and never reaches the next line, new idiom exits 0) and pinned by two new
  tests that extract the real block from the real YAML and run it under the runner's own shell options.
- **F1 (permanent-suppression class): boundary disagreement.** The composer's window start is inclusive
  (`within()` tests `t >= start`); the pre-flight compared with a strict `>`. An item timestamped in the cursor's
  own second is therefore reportable forever AND skippable forever, because skipping never advances a cursor. Both
  comparisons are now `>=`.
- **F4: a hint dated ahead of the clock is untrusted input** and proceeds, closing the inverted-window variant of
  the same class. **F5: an override or `dry_heartbeat` run exits before writing the hint, yet its `cache/save`
  step still stored an EMPTY entry that shadowed the last good hint** (restore-keys match the newest cache), so
  every manual post silently threw away the next tick's saving; the save is now gated on the file being present.
- **F11, found by writing the test:** the pre-flight built git commands as a shell string, so the quoted `:!`
  pathspecs survive `cmd.exe` verbatim, match no file, and make the dev window read as empty on Windows while
  behaving correctly on the Linux runner. git is now invoked with an argv array -- a gate that can suppress posts
  must not have platform-dependent semantics.
- **F9 measured instead of "fixed": the composer's fetch-to-post gap.** The science window starts at the last
  science POST time, so an item created between a run's state fetch and its post sits behind the next run's cursor
  and is never reported. Structural, but is it real? Measured over every posting run today: **13 examined, 0 items
  landing inside a gap.** Re-pointing the cursor at the fetch time would trade a zero-observed-loss hazard for a
  real duplicate-post risk, so it is left alone and recorded here; the measurement is reproducible via
  `scripts/audit/feed-fetch-to-post-gap.mjs` (moved out of the gitignored `out/` in round-25 precisely because a
  tripwire nobody can run is not a tripwire).
- **F14 and F15, our own ledger failures.** Round-22 shipped a workflow change and a new script and was recorded in
  `devlog/` only -- absent from CHANGELOG and RESPONSE-TO-AUDIT entirely, which the two retroactive entries below
  fix. And `HANDOFF` section 13 still claimed production ran `336840b` with the round-21 deploy "to follow", while
  `GET /health` has returned `ab0ce34c` since that deploy: the freshness test only checks that a named sha is
  reachable from HEAD, never that the production bullet matches the live endpoint, so the claim rotted silently.
  Both bullets are re-measured and corrected in this commit.
- **F17, a regression this round introduced and its own audit caught: the F3 hint laundering the silence watchdog.**
  `hint_for()` bumps a cursor to the run's snapshot, and it was applied to all three fields -- but `last_post` is not
  a window start, it is the pre-flight's watchdog input (`now - last_post >= 45 min`). Bumped every half hour, it
  caps `silentMin` at the cadence, so a heartbeat could never come due and the gate would skip exactly the windows
  the heartbeat exists to cover. Now only a run that actually SENT something may advance `last_post`; the two window
  cursors keep advancing. Pinned three ways, including the seam: the shipped hint block is extracted from the real
  YAML, run under `bash -eo pipefail`, and the cursor file it writes is fed back to the real CLI, which must answer
  "silent 180 min >= heartbeat" rather than 42. Verified non-vacuous by reverting the branch -- 2 of the 3 fail.
- **F16, found by typing the wrong flag myself: the sender truncated silently and called it success.**
  `post-x-text.ts` cut an over-ceiling text to `MAXLEN-3` + "..." and carried on, so the send path printed
  `x:post: OK posted` and exited 0 on a mangled post -- the tail being where a caveat or scope note lives. It is
  reachable by accident, not only by malice: the workflow's override path omits `--max-len` entirely when the
  `maxlen` input is blank, and on this pass `--maxlen` (one missing hyphen) silently dropped the ceiling to 280 and
  reported green on a 279-char stump of a 3186-char post. Over-ceiling now REFUSES (exit 1) naming both lengths.
  Unlike the gate changes above this one *can* stop a post -- deliberately: posting nothing and saying why is
  honest, posting a truncated claim is not. The digest path is unaffected (`clip()` already bounds at 25000 and the
  workflow passes `--max-len 25000`; the two ceilings drifting apart is exactly what this would catch).
- **F18, the monitor of the thing just fixed could not see it -- and the naive detector for it was unsound.**
  `scripts/xpost-health.ts` reads the channel out of its job logs and knew nothing about the gate, so a skipped run
  (no `tier manifest:` line, no posts, conclusion success) would have been reported as "tier(s) with no post ... and
  no per-tier manifest line" on exactly the quiet windows the gate now exists to skip. Worse: prototyping the
  detector, a substring search for the skip message matched SIX consecutive runs -- none of which had skipped. GitHub
  echoes each command before running it, so the log carries the step's own SOURCE line, indented, and `messagesOf()`
  only trims the right. Start-anchored on the tool's own output, the distinction holds: across the 60 runs the
  auditor pulled for this check, the `EMPTY-NOT-SKIPPED` marker lands on run 40303969337 and on nothing else.
  Two findings added for the directions that matter --
  proved-empty-but-posted-anyway (a FALSE empty verdict: the gate would have suppressed real science) and
  proved-empty-with-no-skip (the verdict was discarded, which is what 40303969337 actually was) -- and skipped runs
  leave the tier-coverage denominator while the silence rule still counts them, so a gate stuck open cannot hide.
- **F19, a false safety claim on a branch that is (for now) unreachable.** The posting loop's runaway-ceiling warning
  promised "the remaining items stay ahead of the cursors for the next window". They do not: the science window starts
  at this run's last POST, so a run that posts item 1 and defers item 2 has moved the cursor past everything item 2
  was composed from -- the same permanent-suppression class as F1, reached from the other side. Measured rather than
  assumed: the compose step can emit at most 4 tier files plus one note file per `DEV_BATCH` subjects over at most
  `DEV_COMMITS_MAX` of them, i.e. **13 files against a ceiling of 25**, so nothing is lost today; the branch becomes
  reachable at `DEV_COMMITS_MAX=488`. The warning now says what actually happens, and a test pins the arithmetic, so
  the safety is a checked property rather than a coincidence about numbers nobody re-read.
- **Tests + close.** New `tests/x-post-preflight.test.ts` (14): the empty window, every untrusted-input branch, the
  F1/F4 regressions, the rejected-blind-row case that proves the predicate is applied rather than a timestamp scan,
  the relative-path CLI case (a naive import guard would have disabled the gate on exactly the path CI uses), the
  F2 pin that the hand-copied blind predicate cannot drift from `isHeldBlindCandidate`, the two F13 step-shell
  cases, and the three F17 hint-block cases (17 in the file now). `tests/post-x-text-guard.test.ts` gains the three
  F16 ceiling cases, and `tests/xpost-health.test.ts` gains the six F18 cases (19 -> 25), plus the F19 arithmetic pin
  in `tests/science-digest.test.ts`. This closes the gap the workflow header has named since audit-6 -- no test used to load this path at all.
  Suite 965 -> **992** pass / 0 fail (125 files discovered), `typecheck:all` 0, `eslint --max-warnings 0` clean,
  `bash -n` clean on all four run blocks, zero non-ASCII, zero secret hits. No `src/` runtime change, no deploy:
  the whole surface is CI-only.

### Twenty-second round (recorded late, by round-24): the feed's empty-window pre-flight, the node_modules cache, and the cursor hint
Round-22 answered "the automatic feed costs too much, without reducing how often it posts" by attacking the cost of
EMPTY windows rather than the number of posts: a dependency-free pre-flight (`scripts/x-post-preflight.mjs`) that
stops the job before `npm ci` when the window provably holds nothing, an `actions/cache` entry for `node_modules`
keyed on the lockfile, and a rolling cache of the three feed cursors used as a hint only. `on.schedule` and the
full-history checkout were deliberately KEPT (a redundant backup tick now costs a clone plus two cheap reads, and
the history is load-bearing for the research-milestone gate and old build-note windows). Recorded at the time in
`devlog/2026-10-26-twenty-second-round-feed-cost-gate.md` only -- see F14 above for why that was not enough. Two of
its mechanisms were then found broken by round-24 (F3, F13), and one live bug was caught during its own verification
(`actions/checkout`'s default `git clean -ffdx` deleted the hint restored before it; fixed in `c71f984`).

### Twenty-third round (recorded late, by round-24): what is actually worth citing -- vetting, not detection, is the binding constraint
Not a code round. It answered "what have we produced that the field would care about?" by ranking the committed
reports and publishing the one result whose numbers hold up: a measured negative about FALSE-POSITIVE VETTING, from
reports the freshness gate re-hashes and marks verified (P82 the 425-curve blind run -- recall 86.2%, accepted
precision 42.2%; P93 flux-only posterior -- planets kept 48/48, eclipsing-binary family rejected 191/192, blended
planets mis-validated 96/96; P84/P85 the pixel remedy -- 114/500 targets localisable, 0/59 labelled blends caught,
2/55 known-planet false rejects). Deliberately excluded P79 from the citation set because its report records input
paths but no checksums, so the gate cannot re-hash it. Posted to the feed as `workflow_dispatch` (HTTP 204, run
40292935756, posted id 2114636247310139865) and archived byte-exact in
`devlog/2026-10-26-vetting-coverage-bound-academic-post.md`; no discovery claim, nothing wired into a gate.


### Twenty-first round (self-audit): the three round-20 deploy-gated defects ship -- the anchor gate now refuses a NEW spend the current judgement does not stand behind, the data tier becomes served DATA, and the label predicate says when it structurally cannot verify (2026-10-26)
Round-21 is a self-audit round: it implements exactly the three findings round-20 measured and staged (Defects 2/3/5, the ones that needed a Worker change) and re-measured live first at 2026-10-26T01:05Z (`/api/state` + `/api/ledger` + `/api/findings`, scratch probe under `out/`, gitignored): ledger **23** anchored over **104** served rows; of the 23 commitments, by CURRENT served state -- 5 needs-more-data, 1 rejected, 4 `labelConflictsWithKnown:true`, 3 stand-in, **0** `bundleHash`-match, 5 asserting a planet letter the conflict predicate structurally cannot check; red lines held (blind-toi accepted **0**, `origin` present on 103/104 with F-WASP-121-b missing as since round-20); designator kinds `{candidate-number:58, planet-letter:41, none:5}`. No new anchor had landed since 2026-10-24 (23 for two days).
- **Defect 2 (the money path) -- a NEW on-chain commitment can no longer freeze a row the rig's OWN CURRENT judgement does not stand behind.** `anchorFinding` (`src/cf/rig-state.do.ts`) and the Node parity route (`POST /api/anchor/:id`, `src/api/server.ts`) now re-read the live kernel state (`labelConflict(f.targetId, f.crossmatch)`) immediately before the spend and refuse with **409** + a `reporter` warn event when `verdict !== "accepted"` OR the conflict flag is true. The gate sits deliberately AFTER the two NO-SPEND guards (prior-ledger idempotence, `scienceHash` dedup), so already-anchored rows still replay/re-stamp untouched, and a refused row becomes anchorable again the moment its verdict recovers or the flag clears. It gates NEW spends only: the 4 conflicting rows already on-chain stay on-chain (immutable history) -- and are now disclosed in aggregate instead of only row-by-row.
- **Defect 2 disclosure half -- `GET /api/anchor-health` on BOTH runtimes**, driven by one new pure helper `src/core/anchor-health.ts` (`anchorHealth(ledger, rows, asOf)`) that the edge route, the Node route and the tests all call with the same shape: how many anchored rows are currently needs-more-data / rejected / conflicting / stand-in / unverifiable-letter / missing-from-the-board, plus a per-row report. Read-only; it changes no verdict, no hash and no ledger row.
- **Defect 3 -- the data tier is now DATA on the served row.** `src/data/dataTier.ts` gains `DATA_TIER_REAL`/`DATA_TIER_STANDIN` + `dataTierOfSource` + `dataTierOfHeadline`; both `findingView`s serve `dataTier`, decoded losslessly from the `[real TESS photometry]` / `[stand-in synthetic curve]` tag `narrate.ts` prefixes EVERY headline with -- so all 104 stored rows carry the tier today with no re-run and no stored-row edit (an untagged headline reads as the conservative stand-in default). Measured on the capture: 99 real / 4 stand-in over 103 rows; live 2026-10-26: 3 of the 23 anchored rows are stand-in.
- **Defect 3 wording half -- a stand-in cross-match is no longer worded as independent evidence.** `reviewCandidate` accepts `standInCurve?` (threaded from the light-curve SOURCE through `critique` in `src/seats/seats.ts`, both callers `src/orchestrator/pipeline.ts` + `src/cf/workflow.ts` pass it); the blind `directMatch` accepted reason on a stand-in now reads "Stand-in curve: ... by construction and is NOT independent evidence of a recovery." The real-photometry wording is byte-identical (pinned by test), no verdict, score, check or hash moves -- the two sealed on-chain `verdictReason`s (F-GJ-1214-b, F-HD-189733-b) are immutable history and stay as they are; NEW rows can no longer mint that contradiction.
- **Defect 5 -- the predicate's structural blind spot is first-class data.** `labelConflict` now returns `status: "conflict" | "clear" | "unverifiable"` (either designator null -> `unverifiable`, i.e. `conflict:false` because there is nothing to compare, NOT because letters agree); both `findingView`s serve `labelConflictStatus`, and the aggregate counts it: capture 103 rows -> `{unverifiable:69, conflict:7, clear:27}`; of the 20 captured commitments 4 carry an unverifiable letter (F-GJ-1214-b, F-HAT-P-11-b, F-HD-189733-b, F-HD-63433-d), live 23 -> 5 with F-AU-Mic-b (anchored after the capture). The five ids the audit named are now exactly the rows `/api/anchor-health` discloses.
- **Tests + close.** New `tests/anchor-health.test.ts` (9 tests): the aggregate pinned on hand-built rows (only `status==="anchored"` counts, a vanished row is disclosed as `missing-row`), then MEASURED-WITH-THE-PRODUCTION-HELPERS over the captured live fixtures and pinned (20 anchored / 0 match / 2 nmd / 1 rejected / 3 conflict / 3 stand-in / 4 unverifiable / 0 missing -- `scripts/audit/anchor-health-measure21.ts` ran first, the test pins what it measured -- re-run and identical after the round-25 move; it lived in the gitignored scratch directory when this line was written, which round-25 fixed and now gates), the three-state `status`, the tier round-trip through both narrate tags, the stand-in wording (by-construction clause present, evidence clause gone, score/checks untouched), and structural wiring for the gate + both served fields + both endpoints on both runtimes (the DO cannot be imported under Node -- `cloudflare:workers` -- so the gate is pinned the round-17 way). Suite 956 -> **965** pass / 0 fail (123 files), `typecheck:all` 0, `eslint --max-warnings 0` clean, zero non-ASCII, zero secret hits. No stored row, manifest byte, `bundleHash` or `scienceHash` moved; the projection fields are read-side only. Deploy + live verification of `GET /api/anchor-health` and the 409 gate follow this commit.

### Twentieth-round audit: the on-chain ledger aged 20 -> 23 while a test had frozen "20 and moved no anchor" as an invariant, the anchor gate never looks at the conflict flag, and the auditor withdrew two of our own older claims (2026-10-24)
The twentieth pass re-measured everything first-hand at 2026-10-24T07:02Z (`/api/state`, `/api/ledger`, per-row `verify-onchain`, and the committed kernel over `tests/fixtures/live-catalog.json`) instead of trusting any prior figure. It OPENED by withdrawing two claims the auditor had itself made in rounds 4-14, confirmed every round-17/18/19 fix still recomputes, then raised seven new findings. Every number below was independently re-derived by us (scratch live probes under `out/`, gitignored) before writing. This round changes scripts/tests/docs ONLY -- NO `src/` runtime change, NO deploy -- so nothing is "changed but not shipped"; the three findings that need a Worker change are measured and staged for round-21.
- **CENTRAL CORRECTION -- every prior "`ledgerAnchored` stays exactly 20" is superseded as a LIVE figure.** `/api/state` re-measured **23** at 2026-10-24T07:02Z: three new real-fee anchors landed 2026-10-23 evening (F-AU-Mic-b 15:56:01Z, F-TOI-480-b 16:02:26Z slot 460503654, F-HD-110067-b 18:03:39Z), each with a real mainnet `signature` + `slot`. Every "exactly 20" / "no new commitment since 2026-10-20" in this file, `RESPONSE-TO-AUDIT.md`, `HANDOFF.md` and `README.md` was TRUE as-of its own round's capture and is hereby superseded; the class is AGING, not error (the auditor named the part we were wrongly blamed for -- the number was real when written). Going forward every count carries an as-of stamp and is RE-MEASURED (`npm run fixtures:capture-catalog` / a live probe), never trusted frozen. Corrected by ONE central note plus short markers on the instances that read as present-tense (README:85, RESPONSE:442, the round-18/19 close lines), NOT by rewriting each dated close-note.
- **Two of OUR older defects are withdrawn -- and we re-confirmed both first-hand, not on trust.** (a) "A planet label leaks into the `scienceHash` content address" is FALSE now: `scienceProjection` (`src/bundle/bundle.ts`) returns only candidate/verdict/verdictReason/recoveryConfidence/aliasMultiple/ephemeris/crossmatch/dataProvenance/checks -- no `targetId`, no `findingId`. Live proof: HR 858 b/c/d all recompute to ONE `currentScienceHash` `4ec80a3a32...` (HD 260655 b/c to `400a5557ce9c`); the THREE distinct hashes on `/api/ledger` are SEALED history anchored under an older projection, not today's projection. (b) "`scienceHash` dedup is dead code" is FALSE now -- it is correct idempotence: the 2026-10-24T01:31:18Z event stream shows `Skipped anchor for F-HD-260655-c: identical science (content hash) already anchored as F-HD-260655-b -- no new fee spent`, then `Auto-anchor F-HD-260655-c: mode=live spent=false` -- the exact thing round-4 called "structurally impossible". A third, self-inflicted error is recorded so it is not repeated: the new ledger rows DO carry real signatures -- the field is `signature`/`slot`/`memo`, NOT `solanaTx` (which does not exist); all 23 rows have a signature and a slot, so the three new anchors are permanent, irrevocable on-chain commitments.
- **Defect 1 (the headline) -- a test had frozen the OLD number AND a now-false invariant.** Beyond the aged 20, `tests/live-catalog-accounting.test.ts:89` named "the wider predicate moved no anchor" an INVARIANT while sourcing the anchor set from a FROZEN fixture -- and production falsifies it: F-HD-110067-b is BOTH anchored (signature + slot, 18:03Z) AND `labelConflictsWithKnown:true` today. CI stayed green and blind because it reads the fixture, not live. FIXED read-side only: the assertions are UNCHANGED (the fixture is still 20 rows / 3 distinct stored hashes -- a capture, correctly), but the header and every message are RE-SCOPED to say CAPTURE-not-live-invariant, name F-HD-110067-b's live double state, and carry the two withdrawals; 7/7 pass. This is the round-17 lesson ("freezing a wrong expectation as a gate is worse than not fixing it") recurring on the MONEY path -- except the wrong expectation came from a production MOVE, not a predicate blind spot.
- **Defect 4 -- the coverage net was still a phrase-matcher; the three plainest rephrasings escaped.** Of 25 adversarial samples, 3 got through by simple rewording -- `reads the catalog in full`, `parses the entire input`, `handles everything`. FIXED in `scripts/science-digest.ts` (SEND-side only): `COVERAGE_TOTALITY` is recomposed from shared fragments (verb list gains parses/handles/processes, reach-noun gains input) with three new branches -- postpositive (`reads the catalog IN FULL`), bare-object (`handles EVERYTHING`), standalone idiom -- and a new `COVERAGE_CONTRASTIVE` catches the exact shipped form `went from 28 of 103 TO ALL 103` EVEN THOUGH it carries a denominator (that denominator is the OLD value, not the basis), so `feedCoverageViolations` checks contrastive FIRST, bypassing the denom gate. +3 regression tests: the 3 escapes + 5 prior catches all REFUSE, the contrastive form REFUSES, 5 honest controls pass; 14/14. RESIDUAL, documented not guessed: a totality beside an UNRELATED denominator that is not the from-to-all form still passes -- semantic co-reference is not something a regex does reliably.
- **Defect 6 -- "recorded, not deleted" was stated as an external limit; it is a POLICY choice.** The round-18 devlog said removal is "not something this repo can do" because `post-x-text.ts` has a POST path only. But X API v2 DOES expose `DELETE /2/tweets/:id`; the repo simply does not implement it, on purpose (immutable-archive discipline: record + annotate, never erase our own public error). The devlog META (outside the immutable pushed fence) and the HANDOFF line are corrected to say POLICY, not platform limit; the discipline itself is unchanged and endorsed.
- **Defect 7 -- the round-18 correction post's "re-tested on live production" aged within hours.** Its live figures (103 rows / 99 / 34 / ceiling 38 / none 4) were true when posted; live is now 104 / 99 / 34 / ceiling 39 / none 5, so reach is 34/104 = **32.7%**. The numerator (34) and conflict count (7) held; the DENOMINATOR moved. A pushed post is immutable and is NOT re-stamped; the discipline adopted is that every figure states "as of the capture <UTC>" in the body, never an open-ended "on live production". The lightweight sibling of Defect 1's aging class.
- **Defects 2, 3, 5 -- MEASURED and documented, deploy-gated to round-21 (no `src/` change this round).** (2) The anchor gate is decoupled from the board: `anchorFinding` (`src/cf/rig-state.do.ts:630-725`) checks only that the `bundleHash` exists and the `scienceHash` is not already anchored -- NOT `verdict`, NOT the `labelConflictsWithKnown` flag, NOT the data tier. The auto path (`src/cf/workflow.ts:628`) requires `verdict === "accepted"`, so the three new anchors were accepted at anchor time and later downgraded; but a row NEW in content AND carrying `labelConflictsWithKnown:true` would auto-spend a permanent commitment with no gate between -- F-HD-110067-b is the live proof. Of 23 anchored rows by today's served state: 5 needs-more-data, 1 rejected (F-HD-63433-d), 4 `labelConflictsWithKnown:true`, 3 on a synthetic stand-in curve, and 0/23 match their row's current `bundleHash` (a designed consequence of a timestamped commitment, disclosed per-card in `web/app.js`). MINIMAL FIX PLANNED: refuse (or human-confirm) `labelConflictsWithKnown === true` in the new-spend branch of `anchorFinding`, plus a READ-ONLY aggregate endpoint for those counts. (3) The data tier is prose, not data: `isRealPhotometry` (`src/data/dataTier.ts`) has exactly ONE consumer (`src/reporter/narrate.ts:111`, a `[stand-in synthetic curve]` headline prefix) -- no verdict gate, no anchor gate, no tier field on any of the 20 served fields. 4 stand-in rows exist; two (GJ 1214 b, HD 189733 b) are `accepted` AND on-chain, and their own `verdictReason` ("...cross-matches ... on evidence alone, without using any truth period") CONTRADICTS their headline (`[stand-in synthetic curve]`) and README:187 ("by construction, not evidence of a find"). Row-level disclosure shipped last round; AGGREGATE disclosure exists nowhere. FIX PLANNED: a served `tier` field + an aggregate stand-in/on-chain disclosure. (5) Five on-chain ids assert a planet letter the label-conflict predicate STRUCTURALLY cannot verify -- F-AU-Mic-b and F-HD-63433-d (a letter in the label but no crossmatch name, so `detectedDesignator` is null) and F-GJ-1214-b / F-HAT-P-11-b / F-HD-189733-b (a bare star name as the label, so `requestedDesignator` is null while the comparison name carries the letter). The on-chain identifier claims "b" while the predicate built to prevent label conflicts cannot run on any of the five -- the same structural root as Defect 2.
- **Close -- no deploy.** Scripts/tests/docs only (`scripts/science-digest.ts`, `tests/post-x-text-guard.test.ts` +3, `tests/live-catalog-accounting.test.ts` re-scoped, README/RESPONSE/HANDOFF/CHANGELOG + one devlog META line); NO `src/` runtime change, NO Worker redeploy, no served-bundle change. Suite 953 -> **956 pass / 0 fail locally** (+3 regression tests); on a `.git`-less, FITS-un-prefetched tarball the auditor read 942 pass / 3 env-fail / 8 skip (the known `git merge-base` ancestry + `existsSync("out/probe-*.fits")` guards), and CI is green because it checks out full history and prefetches. `typecheck:all` clean, `eslint --max-warnings 0` clean, `node --check web/*.js` clean (6/6), zero non-ASCII, zero secret hits, the send+archive+composer paths still share ONE `FEED_TIME_WORDS`/`FEED_SPEND_WORDS`/`feedCoverageViolations`. No stored row, manifest byte, `bundleHash`, `scienceHash`, verdict gate or anchor semantic moved. `ledgerAnchored` re-measured **23** as-of 2026-10-24T07:02Z (NOT a frozen 20), blind-toi accepted 0, every `discoveryClaim` false. The anchor-gate / tier / aggregate-disclosure work (Defects 2/3/5) and the two standing calibration-gated research decisions (a mint-time duplicate-suppression guard, a seat-identity-free content address) are the round-21 programme.

### Nineteenth-round audit: the round-18 nets over-refused honest technical prose (`burn-in`, `Sol`, "the whole light curve") -- narrowed, with every money/coverage CATCH kept and pinned (2026-10-23)
The nineteenth pass audited the round-18 guard hardening from the outside: it re-derived the reach figures with ZERO regression (reachable 34/103 = 33.0%, ceiling 38, 65 rows with no comparison name, `requestedDesignator` non-null 99/103, `requestedDesignatorKind {candidate-number:58, planet-letter:41, none:4}`, conflicts 7, distinct hosts 90, distinct signals 91, accepted 18 with-origin 17 blind-toi-accepted 0 -- all byte-identical to round-18), then probed the two nets round-18 had just widened/added for the failure mode the round-18 note itself warned against: an over-refusing guard. It found two. Both are fixed by NARROWING, and every CATCH round-18 added is kept and pinned, because tightening a guard must not quietly re-open the hole it was built to close. Every number below was re-run on the committed fixture before writing.
- **The widened money rule over-refused methods + astronomy prose (F1).** Round-18's `FEED_SPEND_WORDS` widening added a bare `\bburn\w*\b` and a bare `\bsol\b`, which measured as FALSE hits on honest technical prose: `MCMC burn-in` / `CCD burn-in` / `a burn-in period` (a methods staple) and `Sol` / `per sol` / `the Sun (Sol)` (the Sun, a Martian day). Narrowed, not reverted: `burn` now matches only the token-burn forms `\bburn(?:ed|ing|s)?\b(?!-)` (a hyphenated compound is not a burn), and `sol` now requires a VALUE context -- `\d+(?:\.\d+)? sol` (a quantity) or `sol token|coin|price|balance`. All 10 currency probes (`$SDR`, `burn`, `burned`, `fee`, `spend`, `lamports`, `rent`, `payout`, `wallet`, `seed phrase`) still REFUSE, each matching `/wallet\/spend/i`; `feedback`/`coffee`/`solution`/`parent`/`costly` stay clean. RESIDUAL, accepted and pinned: a citation surname (`Burns 2019`) still hits -- rare in feed prose, and safer to refuse than to loosen the money rule for it.
- **The coverage net over-refused TRUE processing statements (F2).** Round-18's `COVERAGE_TOTALITY` fired on a coverage verb + a universal with ANY object, so it refused sentences that are not reach claims at all -- `reads the whole light curve`, `scans every sector`, `covers the full sector` (honest aperture/processing prose). Narrowed: the verb+totality alternative now requires the totality to govern a REACH noun (`catalog(ue)` / `dataset` / `row` / `finding` / `record`), so all 6 catalog-reach catches (`reads the whole catalog`, `sees all rows`, `covers every finding`, `spans the entire dataset`, `decodes the complete catalog`, and the shipped round-17 sentence) still REFUSE while light-curve/sector prose passes. The denominator gate (`COVERAGE_DENOM`) is UNCHANGED.
- **One documented hole stays documented, not guessed at (F3).** A sentence carrying ANY `N of M` / `N%` denominator still passes, so the `reach went from 28 of 103 to all 103` construction is NOT caught; distinguishing a false "to all N" from a true "across all N rows" is not something a regex does reliably, and the form that actually shipped was the bare "reads the whole catalog", which IS caught. Recorded again here rather than papered over with a guess.
- **Close -- no deploy.** Scripts/tests only (`scripts/science-digest.ts` regex-narrowed + `tests/post-x-text-guard.test.ts` +3 regression tests); NO Worker redeploy, no served-bundle change. Suite 950 -> **953 pass / 0 fail locally** (+3: the burn-in/Sol/sol non-refusal test, the token-burn-forms + surname-residual test, the light-curve/sector non-refusal test); `typecheck:all` clean, `eslint --max-warnings 0` clean, `node --check web/*.js` clean (6/6), zero non-ASCII, zero secret hits, the send+archive+composer paths still share ONE `FEED_TIME_WORDS`/`FEED_SPEND_WORDS`/`feedCoverageViolations` (no local copy re-forked). No stored row, manifest byte, `bundleHash`, `scienceHash`, verdict gate, anchor semantic or money path moved; `ledgerAnchored` stays exactly 20 [ROUND-20: aged -- live re-measured 23 @ 2026-10-24T07:02Z; see the twentieth-round CENTRAL CORRECTION], blind-toi accepted 0, every `discoveryClaim` false. The two calibration-gated research decisions -- a mint-time duplicate-suppression guard and a seat-identity-free content address -- remain untouched again this round.

### Eighteenth-round audit: the round-17 fix was right and independently recomputable, but our PUBLIC post overstated its reach ~3x -- and all three feed nets missed a capability claim (2026-10-23)
The eighteenth pass re-derived the round-17 Defect-1 fix from THREE independent angles at once (our kernel, `/api/findings`, `/api/state`, plus a neutral comparator knowing no ExoFOP convention beyond `.NN`) with ZERO mismatch -- `.01 -> b` live, conflicts exactly 7 on all three, the gate direction corrected in the SAME commit as the kernel change, and the wiring + `node --check` gates proven live by injecting an ESM syntax error and watching exit 1. It then found the first PUBLIC-number miss in sixteen rounds, and it is ours: the round-17 post said the predicate "reads the whole catalog" and the devlog header said reach went "to all 103". Every number below was re-run on the committed fixture AND live production before writing.
- **The over-claim, corrected to a verifiable reach.** Designator PARSING genuinely spans 103/103 and `requestedDesignator` is non-null on 99/103 (4 unnamed rows -- GJ 1214, HAT-P-11, HD 189733, WASP-121 -- correctly `none`); but the label-conflict PREDICATE can only FIRE where BOTH sides decode a designator AND the row carries a NASA `crossmatch.knownPlanetName` to contradict. That is **34 of 103 rows (33.0%)**, ceiling 38 (the rows with a comparison name), 65 rows with nothing to contradict -- so **27.2% -> 33.0%, NOT -> 100%**. The correction is stated in all three ledgers and in the round-17 devlog HEADER; the immutable pushed bytes (the fenced devlog block, id `2113577794491896133`) are NOT re-stamped, because an archive must never drift.
- **A fourth public net for capability/coverage claims.** The three existing nets each guard one forbidden class -- `OVERCLAIM_STEM` (discover/confirm/first/novel/...), `FEED_TIME_WORDS` (the time window), `FEED_SPEND_WORDS` (money) -- and a coverage over-claim walked through all three, because "our check can now do X" is the sentence this repo writes MOST and nothing owned it. A new `feedCoverageViolations()` on the SEND path (`scripts/post-x-text.ts`, after the red-line net) refuses a totality claim (a coverage verb reads/sees/covers/spans/decodes/scans/reaches + a universal whole/entire/full/complete/all/every, or "whole/entire/complete/full catalog/dataset") whose sentence carries NO denominator; stating the basis ("34 of 103 rows", "33.0%") passes. It is deliberately NARROW -- an honest "every candidate is UNCONFIRMED" still passes, because an over-refusing guard is its own failure. KNOWN LIMIT documented in-source: a sentence carrying any "N of M"/"N%" denominator passes, so "from 28 of 103 to all 103" is not caught; the shipped over-claim was the bare "reads the whole catalog", which is.
- **The money-word guard widened from an ENUM toward a rule.** 8 of 19 probes evaded the old `FEED_SPEND_WORDS` -- `$SDR`, `burn`/`burned`, `fee`, `spend`, `lamports`, `rent`, `payout` -- this system's OWN currency vocabulary (`\$\d` misses `$SDR`; the chain's native verbs were absent). Now `\$\w`, `\bburn\w*\b`, `\bfees?\b`, `\bspend\w*\b`, `\bspent\b`, `\blamports?\b`, `\brent\b`, `\bpayouts?\b`; all 8 probes REFUSED and pinned, each matching /wallet\/spend/i.
- **One money/time rule, not three.** A THIRD, WIDER time-word list lived in `tests/science-digest.test.ts` (extra `last night`/`this morning`/`this evening`/`in recent`), so the composer test guarded a different rule than the send path -- and the mismatch ran in the direction that had let the round-17 violation through. The local copy and an inline spend regex were DELETED; `assertTweetSafe` and `classifySubject` now import the shared `FEED_TIME_WORDS`/`FEED_SPEND_WORDS` (the four extra phrases folded into the single exec-layer rule), so send + archive + composer are one predicate. `devlog-archive.test.ts` imports the same pair, with a documented grandfather for the one `2026-10-18-byte-exact` archive whose META prose quotes the phrase "no spend wording" (an archive must never drift, so the quoted rule-text is exempted by name, not by weakening the scan).
- **The `hostKeyOf` component asymmetry: documented + tested, NOT code-fixed.** Keeping a binary's component letter (round-17) has a price: a label carrying a component the crossmatch name lacks ("HD 202772 A c" vs known "HD 202772 b") yields different host keys ("hd 202772 a" vs "hd 202772"), so `sameHost` is false and a REAL designator disagreement is SUPPRESSED -- and `signalKeyOf`, keyed on the same host, will not merge the pair either. The prose also drifted from the code (it claimed "strip only when a planet designator follows"; the code strips one trailing letter UNCONDITIONALLY, so a bare "HD 202772 A" still loses its A). NO code change: the served catalog holds 0 bare-component labels and 0 asymmetric rows, so a fix is a verified no-op and the false-merge it prevents is worse. Instead `signal-identity.test.ts` PINS the asymmetry (every value measured on the live catalog first, per the round-17 lesson) and the `labelConflict` doc-comment states the COST beside the benefit, warning that a future mint guard deduping on `signalKeyOf` must confront it.
- **Two forensic caveats, neither a code change.** (a) `origin`: "the 18 accepted are all revalidations" is positively provable on 17/18 -- `F-WASP-121-b` was minted before the origin projection and carries NEITHER `origin` NOR `recoveryTrials`, so its revalidation status is INFERRED from the `seats.ts:165` cap (`origin === "blind-toi" && verdict === "accepted"` is force-downgraded, so an accepted row can never be blind-toi) plus its own `crossmatch.knownPlanetName === "WASP-121 b"`; red line 2 holds at blind-toi accepted 0. (b) `hashScience` is LAYERED, not closed: the CURRENT code collapses the HR-858 trio to ONE hash `f6eb9cc6ac17` (distinct 1/3, green in `live-data-regression.test.ts`), but the ANCHORED trio on `/api/ledger` stays three DISTINCT pre-audit-4 hashes (`4ec80a3a32`/`e154b8b1a7`/`66a8db3f1c`, 4-field memos sealed on-chain, immutable), so as a dedup key against the STORED ledger it remains separated (`findAnchoredScience` matches stored values, not a recompute). Reconciling storage to code would RE-ANCHOR three immutable commitments = a second fee = the money path = calibration-gated (red line 3), untouched. `verify-onchain` already reports both lineages (`ledgerScienceHash` anchored vs `currentScienceHash` recomputed, `anchoredScienceDrift:true`).
- **The round-17 violation post is disposed, not just re-sent.** The superseded first attempt (id `2113575468452454508`, carried the time token "today's") was recorded round-17 as re-sent but never disposed, leaving two near-identical posts live. Its devlog header now carries the disposal line: it is marked superseded-by id `2113577794491896133` and annotated by the round-18 correction post -- RECORDED, not deleted (this repo has no `DELETE /2/tweets/:id` path and we do not silently erase our own public error; deletion, if wanted, is a stated one-line follow-up). The send-time time-word guard that would have blocked "today's" is live since round-17 (`ee72057`), so the class cannot recur.
- **Close -- no deploy.** Scripts/tests/docs only; `src/core/signal-identity.ts` changed by a DOC-COMMENT alone (byte-identical runtime, served bundle unchanged), so NO Worker redeploy. Suite 944 -> **950 pass / 0 fail locally** (+6: the 8-probe spend test, three coverage-net tests, two hostKey-asymmetry tests); on a `.git`-less, FITS-un-prefetched tarball the same suite reads 939 pass / 8 skip / 3 env-fail (the `git merge-base` ancestry checks + the `existsSync("out/probe-*.fits")` guards), and CI is green because it checks out full history and prefetches. `typecheck:all` clean, `eslint --max-warnings 0` clean, `node --check web/*.js` clean, zero non-ASCII, zero secret hits. No stored row, manifest byte, `bundleHash`, `scienceHash`, verdict gate, anchor semantic or money path moved; `ledgerAnchored` stays exactly 20, blind-toi accepted 0, every `discoveryClaim` false. The two things that could actually move the evaluation -- a mint-time duplicate-suppression guard and a seat-identity-free content address -- remain calibration-gated research decisions, unchanged again this round.

### Seventeenth-round audit: the disclosure predicate could only see 27% of the catalog, and the gate had nailed the blind spot shut as "correct" (2026-10-23)
The seventeenth pass credited the sixteenth round's bookkeeping (host count corrected to 90 with both counts published side by side, `.01` terminology fixed, and -- the point the auditor scored explicitly -- OUR numbers committed back as the regression baseline rather than argued), then found that the newly written decision kernel could only see part of the catalog, and that a test had frozen the blind spot as the expected answer. `labelDesignatorOf` / `knownDesignatorOf` returned `null` on a `.NN` candidate number, so `labelConflict` needed BOTH sides to be a trailing planet letter before it could decide: the predicate was reachable on 28/103 rows (27.2%), `requestedDesignator` was `null` on 62, and the kernel flagged 5 conflicts where a decode-aware neutral comparator (`.01` -> b, `.02` -> c, star component kept) flags 7. Every number below was re-run off production (`GET /api/findings?limit=500` + `GET /api/ledger`) before and after the change.
- **Defect 1 -- the predicate only saw letters, and the gate pinned the miss as passing.** The two rows the letter-only rule dropped are exactly the ones a reader can count by hand from `GET /api/findings`: `TOI-6054.02` (label claims candidate `.02`, its own crossmatch says `TOI-6054.01`) and `TOI-4443 c` (label claims `c`, crossmatch says `TOI-4443.01`) -- both served `labelConflictsWithKnown:false`. Worse, the gate direction was inverted: `tests/signal-identity.test.ts` asserted `labelDesignatorOf("TOI-2016.01") === null` ("a candidate NUMBER is not a planet letter -- no claim to compare") and `tests/live-catalog-accounting.test.ts` asserted `conflicts.length === 5`, so the commit that fixed the predicate would turn THEIR CI red. Fixed read-side only: a new pure `candidateNumberToLetter()` decodes `.01` -> b ... `.25` -> z (`>= 26` -> `null`, `.00` -> `null`), `labelDesignatorOf` / `knownDesignatorOf` use it, and both test expectations were flipped to the decoded truth (`labelDesignatorOf("TOI-2016.01") === "b"`, `conflicts.length === 7`). NO hash input moved -- `signal-identity.ts` is imported only by the served views, `finding-query.ts` and `stats-definitions.ts`, never by `bundle.ts` / `solana` / `seats`.
- **Defect 2 -- `hostKeyOf` stripped the STAR COMPONENT letter too (latent today, wrong the day a B component is minted).** `hostKeyOf` lowercased then looped `/\s+([a-z])$/i`, so a binary's component letter was peeled like a planet suffix: `hostKeyOf("HD 202772 A b") === hostKeyOf("HD 202772 B b") === "hd 202772"`, and `labelConflict("HD 202772 A c", { knownPlanetName: "HD 202772 B b" })` returned `conflict:true` -- two different stars judged self-contradictory. Fixed by stripping a trailing single letter ONLY when a planet designator still follows it, so the component survives (`HD 202772 A b` -> `hd 202772 a`); two binary-star cases (`HD 202772 A/B b` distinct, `DS Tuc A b` -> `ds tuc a`) were added. HONEST SCOPE: today's catalog carries only A components, so live `distinctHosts` stays exactly **90** (a neutral component-preserving recomputation agrees, 0 cross-star collisions) -- this is a latent defect closed before it could false-merge, NOT a corrected count.
- **Legacy 4 -- `requestedDesignator:null` was ambiguous (62 rows).** `null` meant both "no claim" and "an undecoded candidate number". A new `designatorKindOf()` publishes `requestedDesignatorKind` / `detectedDesignatorKind` (`planet-letter` / `candidate-number` / `none`) on every served finding AND on `verify-onchain`, so a reader is never left guessing; live the kinds span `{candidate-number:58, planet-letter:41, none:4}` -- the auditor's own independent measurement, matched exactly.
- **Legacy 1 -- the disclosure reaches the HUMAN reader, not just the machine.** `web/app.js` renders a `labelConflictNote` on the card ("Label claims planet C (decoded from its TOI candidate number), but this row's own NASA cross-match matches ... (planet B) -- the seat label disagrees with its own evidence") with a `label-conflict-note` style in `web/styles.css`. The browser reads the SERVED flag and designators; it does NOT re-decode the candidate number (the rule stays single-sourced in the kernel). A person opening the site now sees the same fact the API returns.
- **Legacy 2 -- served == kernel, proven offline by construction (no risky fixture re-capture).** Re-capturing `live-catalog.json` after deploy would drift the 103/91/90 hard counts against a production that legitimately re-mints every 15 minutes, so instead a STRUCTURAL wiring test in `tests/signal-identity.test.ts` asserts BOTH `findingView`s serve all five disclosure fields from ONE `labelConflict()` call (`labelConflictsWithKnown: lc.conflict` -- served IS the kernel), and that `app.js` reads the served flag and `doesNotMatch(/candidateNumberToLetter/)` (the browser cannot re-derive a divergent answer). This is the offline teeth for the "kernel decision vs processor-served value can never disagree" invariant the fixture alone could not catch.
- **Legacy 3 -- one honest no-change, one gate added.** (a) `freshness-regen.yml`'s unconditional `--allow-stale` is INTENTIONAL and left as-is: one offline upstream must not block publishing the other three reports (documented, not "fixed" into a brittle failure). (b) `web/` sat outside `lint` (`eslint src tests scripts`) and both tsconfigs, so the browser files had no automated gate at all -- `ci.yml` now runs `node --check web/*.js` as a syntax gate, so a served file can no longer ship a parse error silently.
- **Legacy 5 -- deferred, stated plainly.** A daily `capture` + HARD-FAIL on any fixture/production `(targetId, verdict, ppm)` divergence was NOT wired: production re-mints every 15 minutes, so a hard count-diff gate would cry wolf on legal growth, and scheduled workflows are fragile here (the X-post lesson). The wiring test above covers the served==kernel invariant offline; the README's 103/91/90/12 remains a hand-refreshed snapshot, and this is recorded rather than glossed.
- **RESPONSE-TO-AUDIT.md:459 self-contradiction reconciled.** The round-16 D1 row's Concern column said "7 of 103 rows disagree" while its Verification column said "exactly 5" -- the 7 was the auditor's decode-aware count, the 5 was our letter-only predicate; round-17's candidate-number decode lifts the predicate to 7, so both columns now agree and the row carries a note pointing at the round-17 section instead of a silent 2-row gap.
- **Close + deploy + live proof.** Suite 937 -> 940 pass / 0 fail locally (+3: the `candidateNumberToLetter` block, the `designatorKindOf` block, the wiring test); `typecheck:all` 0, `eslint --max-warnings 0` clean, zero non-ASCII, zero secret hits; CI green on `336840b` including the new `web` syntax gate. `deploy:window` cleared GO (the pass `run-20261023-091528` held the mutex to 09:25:04Z -- a ~9.6 min mutex-finish span overrun, still intermittent -- leaving 269 s of idle before the 09:30 claim) and `cf:deploy:sha` uploaded at version `2327eda2-7043-42f3-9485-72fa3bf309ce`; `/health` gitSha is `336840b`. All 23 post-deploy live assertions passed on REAL rows: 103 findings, **7** flagged (including `TOI-6054.02` + `TOI-4443 c` that round-16 missed, both `needs-more-data`), served == kernel == neutral comparator with 0 mismatch, `requestedDesignatorKind {candidate-number:58, planet-letter:41, none:4}`, `distinctHosts` **90** / `distinctRecords` **103**, `verify-onchain` on `F-HD-260655-c` returns `labelMatchesKnownPlanet:false` with `ledgerBundleMatch:true` and `ledgerScienceHash` byte-equal to the committed fixture (`d00fe82d...`), the served `app.js` byte-identical after EOL normalisation, blind-toi accepted 0, every card `discoveryClaim` false. `ledgerAnchored` still exactly 20 and NEITHER newly-flagged row is anchored (no `F-TOI-6054` / `F-TOI-4443`) -- the two misses never touched the money path. No verdict gate, bundle hash, anchor semantics or money path moved. The two things that could actually move the evaluation -- a mint-time duplicate-suppression guard and a seat-identity-free content address -- remain calibration-gated research decisions, unchanged this round.

### Sixteenth-round audit: the record/accounting layer -- one physical candidate minted under several seat labels, disclosed as machine-readable data (2026-10-23)
The sixteenth pass confirmed all four fifteenth-round fixes LIVE by the auditor's own hand, then moved below the interface: the machine copies ONE physical candidate into one record PER TOI-table planet row, the label can contradict the row's own crossmatch, and the contradiction was already paid for and written into immutable on-chain commitments. Every number below was recomputed by us from `GET /api/findings?limit=500` + `GET /api/ledger` before touching code: 103 rows = 91 recovered signals = 90 host stars (11 signals under >= 2 ids, 12 pure duplicate rows); accepted 18 rows = 15 signals / 15 stars; 5 rows whose label disagrees with their own `crossmatch.knownPlanetName`, 3 of them accepted (`HR 858 d`, `HR 858 c`, `HD 260655 c`); 20 chain commitments covering 17 candidates (HR 858 x3, HD 260655 x2), the three HR 858 rows carrying THREE different `scienceHash`es.
- **D1/D2 disclosure (this round's shipped half).** A new runtime-agnostic pure module `src/core/signal-identity.ts` (`hostKeyOf` / `signalKeyOf` / `labelConflict` / `groupBySignal`) is the single source for "same signal? label lying?" across all surfaces. The served views are response projections, so disclosure fields touch NO stored row, manifest byte, `bundleHash` or `scienceHash`: every finding now carries `requestedDesignator` + `labelConflictsWithKnown`, and `verify-onchain` carries `labelMatchesKnownPlanet` + requested/detected designators -- an external reader sees the self-contradiction at the exact byte it can verify, instead of having to diff fields by hand.
- **Secondary #1 -- `distinctHosts` now counts host STARS (103 -> 90), `distinctRecords` (103) published beside it.** The old SQL counted distinct label strings while `PUBLIC_STAT_DEFINITIONS`, README and the board's summary line all read them as hosts -- a 13-star overstatement by our own "state the measure" rule. The DO drops to a JS pass over the same rows (SQLite has no regex) using the shared `hostKeyOf`; the Node mirror matches; both definitions and the README counter paragraph were rewritten; the board sentence "hosts with recorded results" is now literally true.
- **Secondary #2/#3 -- terminology and the narrow regex.** The round-15 comments called `.01` a "TESS cadence suffix"; it is the ExoFOP TOI-table CANDIDATE PLANET NUMBER (`toidisplay` / `ctoi_alias`, `src/data/toiArchive.ts`), an identifier, not noise -- the comment now says so. And `identifierRuns()` no longer carries its own `/(toi-\d+)\.\d+/` pattern: it reduces via `hostKeyOf` first, so a future `TIC 1234567.01` or `TOI 1234.01` cannot re-leak the candidate number with CI silent.
- **D4 -- the accounting is now gated on REAL served bytes.** `scripts/capture-served-catalog.ts` (`npm run fixtures:capture-catalog`) commits the full catalog + ledger as `tests/fixtures/live-catalog.json` / `live-ledger.json`; `tests/live-catalog-accounting.test.ts` drives the PRODUCTION functions over them and pins 103/91/90/12/15/17, the 5+3 accepted contradictions by name, the trio's three distinct science hashes, `tic=01` -> 0 on every real row, and `computeStats` distinctHosts 90 / distinctRecords 103 -- the missing half-direction that let rounds 14-15 pass twice. `tests/signal-identity.test.ts` pins the predicates on synthetic edges. The round-15 echo-parity source-regex test is renamed to what it is: a STRUCTURAL wiring check (the logic is behaviourally tested in shared `src/core`).
- **NOT done on purpose -- D3's money half.** Suppressing a duplicate at mint time changes which records exist and which get anchored; per red line 3 (measure before gate) the mint guard and any `scienceHash` re-derivation are recorded in HANDOFF as calibration-gated research decisions, not silent code changes. `collapseCoincident` stays offline-only, and README's new Capability-boundaries entry states it plainly: the board does not merge, the chain pays per label -- measured 20 -> 17. The `dir=asc` default-limit note joined the API table.
- **Close + deploy + live proof.** Suite 925 -> 937 pass / 0 fail locally (+12 across two new files), 122 test files; after CI green on `c70593e`, `deploy:window` cleared GO (the pass `run-20261023-060140` released at 06:17:12Z, >=120 s idle before the 06:30 claim) and `cf:deploy:sha` uploaded at version `0ea4089b-dd49-4c93-b185-4260fd215158`; `/health` gitSha is `c70593e`. All 17 post-deploy live assertions passed on REAL rows: 103/103 findings carry the two new fields with exactly 5 flagged and 3 accepted; `/api/state/summary` reads `distinctHosts 90` / `distinctRecords 103`; `tic=01` -> 0 and `tic=0858` -> 3; and `verify-onchain` on `F-HD-260655-c` returns `labelMatchesKnownPlanet false` with the on-chain memo `bundleHash` and `ledgerScienceHash` byte-equal to the committed fixture -- the endpoint's own `anchoredScienceDrift true` for the CURRENT bundle hash is a pre-existing re-derivation state, untouched here (`src/bundle/`, `src/solana/`, `dedup.ts`, `workflow.ts`, `seats.ts` are absent from this commit). Public counters: surveyPass 476, `ledgerAnchored` still exactly 20 (no new commitment since 2026-10-20), blind-toi accepted 0, every card `discoveryClaim` false. No verdict gate, bundle hash, anchor semantics or money path moved.

### Fifteenth-round audit of the v0.2 query surface: the tic fix stops matching a TESS cadence suffix as an identifier, a lone dir stops being inert, and a clamped limit says so (2026-10-23)
The fifteenth pass re-measured all six fourteenth-round fixes on production by hand (five closed; the auditor WITHDREW its own prior N5 latency claim, vindicating our rebuttal) and then caught that our OWN round-14 `tic` fix had opened a bigger hole -- the very fixture meant to guard it (TOI-6265.01) only exercised the host direction. Four new findings T1-T4, each re-verified against the source, pinned by behaviour tests, and confirmed live. Deployed at version `281de4e3` (`gitSha bf12a62`, `codeVersion space-data-rig@0.2.0`).
- **T1 (a regression we introduced) -- numeric tic matching tripped on the TESS cadence suffix, larger than the original bug.** Target ids are `TOI-<host>.<cadence>`; round-14's `/\d+/g` made the `.01` suffix a legal "digit run", so the auditor measured `?tic=01` -> 53/103 LIVE and zero-padded `?tic=0858` (a real HR 858) -> 0. A narrow `identifierRuns()` now strips ONLY the `<toi-number>.<cadence>` suffix (hyphen/word ids like HAT-P-11 keep their digit semantics) and a purely numeric `tic` compares NUMERICALLY so leading zeros normalise -- `tic=01` matches nothing, `tic=0858` == `tic=858`. LIVE at `bf12a62` on the real row `TOI-1684.01`: `tic=01` -> 0, `tic=1684` -> 1, `tic=01684` -> 1; behaviour tests pin BOTH directions, the half the round-14 fixture skipped.
- **T2 -- `dir` used alone was a legal-but-inert criterion, slipping straight past N1's honest echo.** `queryFindings`' active-set listed verdict/origin/tic/q/the five numerics/sort/limit/offset but NOT `dir`, so `?dir=asc` alone fell to the inactive branch: unsorted, all 103 rows returned (>120 KB still streaming), `ignored:[]` -- "gave a condition, nothing happened" surviving on a valid value from their own vocabulary, and re-hitting the transport wall `/api/state/summary` exists to dodge. `dir` is now active and genuinely sorts (LIVE: oldest->newest, paged at the default 100, `hasMore` true).
- **T3 -- `?limit=0` was silently clamped to 1.** Clamping is a different act from dropping, but "I said 0, you gave 1" still deserves an echo for a direct-URL verifier; a new pure `clampedFindingParams()` reports finite paging keys the parser moved, and both handlers echo `clamped:[...]` alongside `ignored:[...]` (the two sets are disjoint). LIVE: `limit=0` -> 1 row + `clamped:["limit"]`; `limit=99999` -> 500 + `clamped`; `limit=24` -> nothing clamped.
- **T4 -- one dead ternary.** `const dir = q.dir ?? (sortKey === "recent" ? "desc" : "desc")` -- both arms identical, a constant in a rule's clothes -- collapsed to `q.dir ?? "desc"`; behaviour unchanged (default newest/highest-first).
- **Left as-is, stated plainly.** `freshness-regen.yml` still passes `--allow-stale` unconditionally, so p86's `process.exit(1)` branch stays dead in the automated path; `web/` is still outside lint (`eslint src tests scripts`) and both tsconfigs -- the extracted browser reducers are reached only by a reverse-import from `tests/`. And the two things that could actually move the evaluation -- lifting the mixed-source 0/56 pixel ceiling (P85 has the mechanism) and making `scienceHash` a true content address once `targetId`/cadence labels are removed (HR 858 b/c/d still differ; 2 of 20 ledger rows are still legacy 3-field memos) -- are a research programme, not interface work.
- **Close + deploy + live proof.** `tests/finding-query.test.ts` grew +4 (T1 both-directions + zero-pad, T2 dir-active, T3 clamp-echo, T4 default + an edge+Node echo-parity assertion); suite 921 -> 925 pass / 0 fail locally -- and the auditor's count-wording point is taken: a `.git`-less, FITS-un-prefetched tarball reads 910 pass / 8 skip / 3 env-fail, so the ledgers now say so rather than a bare "N/N". After CI green on `bf12a62`, `deploy:window` cleared GO (the pass `run-20261023-041518` released at 04:21:39Z, 316 s idle before the 04:30 claim), `cf:deploy:sha` uploaded at version `281de4e3-40a1-426e-a068-23e5187237db`; `/health` gitSha is `bf12a62`. Public counters: surveyPass 468, `ledgerAnchored` still exactly 20 (no new chain commitment since 2026-10-20 -- dedup spends no second fee), blind-toi accepted 0, every card `discoveryClaim` false. No verdict gate, bundle hash, anchor semantics or money path moved.

### Fourteenth-round audit of the v0.2 interface layer: honest query echoes, an identifier that matches identifiers, a serialised money path, and browser reducers you can actually test (2026-10-23)
The fourteenth pass re-tested the twelfth round's seven residuals (six closed, one honestly acknowledged), corrected the auditor's OWN prior attribution for the large-payload fetch failures (volume x their link, not a DO wedge), and raised six new findings N1-N6 against the SHIPPED v0.2 surface (`ef5805ac` / `bb16fd7`). The defect class had moved from the data layer to the interface layer -- each is one-to-two commits to clear, not a structural re-verification failure. Every one was re-verified against the real source and live production data before being touched; four are fixed with behaviour tests, one as an additive honesty signal, one rebutted with evidence. Deployed at version `995b627a` (`gitSha 8dd1748`, `codeVersion space-data-rig@0.2.0` -- a hardening of the v0.2 line, not a version bump).
- **N1 -- an unknown-but-supplied enum was silently dropped.** `?verdict=typo` vanished without a trace: a direct URL reader got the whole catalog and the echoed `query` object omitted the parameter entirely, so nothing said "your filter did nothing." `parseFindingQuery` still drops bad values BY DESIGN (the empty-query identity invariant -- a typo must not 500), but a new pure `ignoredFindingParams()` mirrors the exact drop rules and BOTH `/api/findings` handlers (edge + Node) now echo `ignored:[...]`. LIVE: `?verdict/origin/sort/dir/limit=<garbage>` each echo `ignored:["<name>"]` with `matched=103=total` unchanged.
- **N2 -- `tic` promised an identifier but did a blind substring.** `tic=858` swept in any target whose name contained `858` (8581, S8581), so an "exact TIC filter" was a lie. A purely numeric `tic` must now equal a whole digit RUN of the target id; alphabetic/spaced queries keep the contains behaviour, and the free-text `q` stays the loose tool. LIVE on the real catalog: `tic=148` returns 0 rows where the old substring would have matched `TOI-1487.01`, and `tic=1487` returns that single row exactly.
- **N3 (money path) -- the burn replay guard had a concurrency window.** `observeCommission` checked the by-signature guard MANY `await`s before it wrote it, with the on-chain anchor in between, so two concurrent same-signature requests could both pass step 3 and both spend SOL (the operator pays twice) -- while `anchorFinding` had long used an `anchorInFlight` lock keyed by findingId. Both runtimes now serialise by signature: the DO gains `commissionInFlight` mirroring that idiom (released in a `finally`), the Node route chains through a new pure `serializeByKey` (`src/core/inFlightLock.ts`, chain-and-rerun so a Response body is never shared). The concurrency is BEHAVIOUR-tested on real parallel calls -> exactly one spend, results `['commissioned','already-used']`. NOT live-fired -- verifying it would spend real SOL -- proven by the algorithm test + deployed-commit identity. No verdict gate, bundle hash, or anchor semantics moved.
- **N4 (gates) -- browser race/failure logic was proven by regex-matching `app.js`** -- the exact audit-4 anti-pattern the same test file criticises. The merge/failure logic moved into pure `applyFindingsPage` / `applyFailedPage` reducers in `web/findings-query-ui.js`, driven by real response envelopes in tests; `app.js` keeps only the genuinely browser-timing token guard, asserted as wiring. The served `findings-query-ui.js` (10,506 B) and `app.js` (115,608 B) are byte-for-byte the committed files after EOL normalisation.
- **N6 (report library) -- 39/56 unstamped reports still read as plain `fresh`.** An unattested report is "not known stale", never "verified current", so `unattested: total - stamped` is now a first-class published number (index regenerated: `unattested: 39`), pinned by a freshness test; the `fresh` boolean was deliberately NOT flipped (that would mislabel unattested as out-of-date). `--allow-stale` stays and is stated plainly -- one offline upstream must not block publishing the rest.
- **N5 (rebutted, not changed) -- the claim that `/api/findings` is the SLOWER path is inverted.** The DO `getState()` behind the fast summary ALSO calls `listFindings()` plus bundles+events+computeStats -- both read the same rows; the latency delta is transport + DO turn-serialization behind an in-flight pass (the audit-12 D4 infra characteristic). No risky SQL pushdown was made to chase a mis-attributed cost.
- **Close-out + deploy + live proof.** `tests/in-flight-lock.test.ts` is new, `finding-query` grew the N1 `ignored` + N2 `tic` behaviour, `findings-query-ui` gained the reducer behaviour tests, and `report-freshness` pins `unattested`; suite 908 -> 921 green across 120 files, `typecheck:all` 0, `eslint --max-warnings 0` clean, ASCII-clean, no secrets. After CI green on `8dd1748`, `deploy:window` cleared GO (the pass `run-20261023-014518` released at 01:54:46Z, 198 s of idle before the 02:00 claim -- over the 120 s budget), `cf:deploy:sha` uploaded at version `995b627a-c6d5-40b3-b2fd-b0d084b0f8c7`; `/health` gitSha is `8dd1748` and the served modules are byte-identical. Public counters unchanged in kind: surveyPass advancing, `ledgerAnchored` still exactly 20 (no new chain commitment since 2026-10-20 -- dedup correctly spends no second fee), every card `discoveryClaim` false.

### Thirteenth-round audit of the v0.2 console: an honest projection stops contradicting its own manifest, and the query view can no longer race or duplicate itself (2026-10-23)
Round 13 turned six findings against the Interactive Verification Console (`ef07167..d6825a8`). The theme: a read-only view can still lie about the science it mirrors, and a browser console can race or double its own data. Each was re-verified against the real source and production fixtures before being touched, then pinned by behaviour tests (not string-matches). Deployed at version `ef5805ac` (`gitSha bb16fd7`, `codeVersion space-data-rig@0.2.0`), and confirmed live by running the DEPLOYED predicate over real production bytes.
- **P1 -- the Evidence panel claimed a harmonic alias on cards that had none.** `evidenceHtml` stamped "harmonic alias xN" whenever `aliasMultiple != null`, but `aliasMultiple === 1` means "the BLS period was already correct" (`src/detect/pipeline.ts`; `src/critic/review.ts` sets the odd-even PASS from exactly that), so the note contradicted the sealed manifest's own `period is clean (alias x1)` line printed directly above it. A new pure predicate `isHarmonicAlias()` (in `web/findings-query-ui.js`) flags only a finite multiple that is genuinely not 1; `evidenceHtml` gates on it. Proven on `tests/fixtures/live-manifests.json` (3 real sealed bundles, all x1) AND against live production: a probe through the deployed predicate over the first 40 catalog manifests found `aliasMultiple` set `{1, 2}` -- 5 genuine x2 aliases correctly flagged, 35 clean x1 cards no longer mislabeled (the old gate would have lied on the majority of cards a reader opens).
- **P1 -- a fresh query issued during "load more" silently did nothing.** `fetchFindingsPage` had one `loading` guard that blocked every overlapping request, so pressing Apply while a page was network-bound dropped the new query and left the OLD result under the NEW meta. Offset-0 requests now preempt an in-flight page; a monotonic `token` discards any response a newer query/reset superseded before it can mutate state; Reset bumps the token.
- **P2 -- a failed fresh query left the previous result stranded on screen.** The catch only rewrote the status line; the last page's cards stayed rendered. On offset-0 failure the rows/matched/total/hasMore are now cleared and the board re-rendered to an honest empty state before the error text.
- **P2 -- "load more" could render the same finding twice.** Pages are appended, and when the catalog shifts between two requests (a run upserts a row, the sort recomputes) a finding lands on consecutive slices. A pure `dedupeById()` now collapses appended pages by id, keeping the first occurrence.
- **P2 -- the panel said "(no filter)" whenever `matched === total`.** An empty query and an all-matching filter both give `matched===total`, so the phrase was ambiguous -- telling a reader their filter "did nothing" when it ran and kept everything. `resultMeta(res, shown, {filtered, sort})` now decides "no filter" from `hasConstraints(form)` -- what the reader actually typed -- never from the count (and `hasConstraints` finally has a consumer).
- **P2 -- the load-more cue always said "for older".** Under a depth/snr/TIC sort the console pages in that key's order, not chronologically; the cue now names the active sort ("load more for the next by <sort>") and keeps "for older" only under the default `recent`.
- **Close-out.** `tests/findings-query-ui.test.ts` grew 12 -> 18 (predicate behaviour + the rewritten `resultMeta` + a live-data alias regression + a structural test that the fixes are WIRED into `app.js`, not merely defined in the pure module); suite 902 -> 908 green, `typecheck:all` 0, ASCII-clean, no secrets. `deploy:window` cleared GO (the pass `run-20261022-170048` released at 17:07:26Z, 287 s of idle before the 17:15 claim -- a milder recurrence of the mutex-finish span-overrun, still intermittent, root cause open). Server `queryFindings` untouched, so the empty-query identity contract the committed depth figure depends on holds; no verdict gate, bundle hash, or money path moved; `discoveryClaim` false throughout.

### v0.2 "Interactive Verification Console" shipped and deployed -- the catalog can now be queried, its evidence read, its fold redrawn (2026-10-22)
The twelfth-round audit named a gap the past eleven had not: the reader could only ever SEE the catalog, not ASK it anything. This is the first coherent v0.2 slice -- released as `0.2.0` (package.json + the edge's `CODE_VERSION` var), deployed to spacedatarig.app, and live-verified against the real 103-row catalog. Nothing here runs a detector, gates a verdict, or touches the money path; every slice is a projection over records that already exist.
- **P0 -- server-side query (code `fd3810e`)**, the API half: `src/core/finding-query.ts` (runtime-agnostic `parseFindingQuery` + `queryFindings`) wired into `/api/findings` on BOTH runtimes, so a reader filters/sorts/pages on the edge instead of pulling ~324 KB and filtering in memory. Backward-compatible by invariant: an empty query returns the whole catalog in the store's own order (the committed depth-significance figure depends on it); `tests/finding-query.test.ts` (+7). The library then converged to carry D5's stamped cross-pipeline artifact (`1e6572b`).
- **P0b -- the query console (code `ef07167`)**, the reader half: `web/findings-query-ui.js` (pure builder) + a `#findings-query` toolbar in index.html + `app.js` render branch. Every control maps to a parameter `parseFindingQuery` already reads (verdict, origin, tic, free-text q, period/depth-ppm/snr ranges, sort/dir) and pages against `/api/findings` with a "Load more". The builder is a pure module so `tests/findings-query-ui.test.ts` (+12) drives the REAL function and round-trips its output through the SERVER parser (key-name parity) -- the audit-4 lesson, applied to the new console rather than string-matching app.js. LIVE-verified: `?verdict=accepted&sort=depth&limit=3` on the served edge returned `total 103 / matched 18 / hasMore true`, and the browser console's `?limit=24&offset=0&snrMin=30` matched 29 of 103 then paged 24 -> 29 on "Load more".
- **P1 -- per-discriminator Evidence on every card**: the Details panel now prints the mission-critic's own gating checks straight from the sealed bundle manifest already cached for provenance (`manifestCache`, no new request), each tagged gating vs advisory with the SAME `/non-gating|post-hoc` predicate `bundle.ts` uses to keep post-hoc checks out of the science hash. It shows committed numbers; it re-derives and re-gates nothing. LIVE-verified: the first card rendered 10 `.ev-check` rows, correctly splitting `catalog-lookup (non-gating)` as advisory from snr/depth/coverage/fap as gating.
- **P2 -- live in-browser phase fold, honestly bounded**: `foldPlotHtml` draws a hoverable phase-folded light curve from `candidate.folded` when a row carries it, above the three static SVGs, and says nothing (lets the sealed `folded.svg` stand) when it does not -- it never draws a lie. KNOWN LIMITATION recorded plainly, not glossed: `RigStateDO.stripFinding` deliberately drops `candidate.folded` from every stored finding ("would bloat SQLite rows + WS frames"), so the live catalog delivers ZERO fold points (measured: 0 of 103 candidates carry `folded`; the historical local snapshot did, which initially misled the slice). Lighting it up on the existing rows would require writing fold points as a side artifact in the run/seal path -- touching the anchoring-adjacent code and, for already-sealed rows, a re-observation -- so it was NOT done here; P2 ships as a correct enhancement that activates wherever points are delivered and otherwise falls back.
- **Two defects found and fixed while verifying this slice (not shipped blind)**: (1) the Plots lazy-load guard tested `!plots.dataset.loaded`, but the card writes `data-loaded="0"` -- the STRING "0" is truthy, so the fill branch NEVER ran and NEITHER the three static SVGs NOR the fold rendered on a real click (a genuine pre-existing bug, browser-QA-caught); now gates on `!== "1"`, pinned by a regression test. (2) the Node server's explicit static allowlist was missing the split browser modules `app.js` imports (`relabel.js`, `honest-precision.js`) plus the new `findings-query-ui.js`, so `npm run api` served a blank board whose import chain 404'd -- all three added (the edge already serves them assets-first).
- **Deploy + live proof**: after CI green on `d6825a8`, `deploy:window` cleared GO (previous pass finished, ~565 s idle over a 240 s upload budget), `cf:deploy:sha` uploaded at version `81d18679-6942-4345-8a6f-bb5aada9dd50`. Cache-busted `/health` returns `codeVersion space-data-rig@0.2.0`, `gitSha d6825a8`, and the served `/api/findings`, `/app.js`, `/findings-query-ui.js` all 200. Public counters at that moment (`/api/state/summary`): surveyPass 423, distinctHosts 103, blindHeld 29 over blindCandidates 53, ledgerAnchored 20, bundlesAnchored 0 (dedup correctly spends no second fee), tasksDone 97; the report library serves 56 with `stale: []`, 17 stamped / 15 verified / 15 fully. Suite 902 green across 119 files, `typecheck:all` 0, ASCII-clean, no secrets. `discoveryClaim` false throughout; no verdict, gate or money path changed.

### Twelfth-round external audit: the publishing pipeline re-verified a rotten sentence -- so prose now cannot quote a number its own data denies (2026-10-22)
The sharpest finding of the twelve rounds was not "fixed but not deployed" but its inverse: `6b3b158` re-ran P48, the freshness gate stamped it `verified`, CI rebuilt the library -- and the published page still asserted "the board collapsed 2 multi-host systematic groups BEFORE emitting these 5" while the `/2` board it reads says **1** collapsed and **4** emitted. The gate verifies bytes-against-inputs, never prose-against-data, and no test referenced p48 at all. Every point was closed against bytes:
- **D1 (generated prose contradicting its own JSON, shipped fresh)** `scripts/p48-novelty-check.ts` interpolated every count in that paragraph EXCEPT the collapse sentence -- a hardcoded constant that was true of the old `/1` board and rotted under re-stamping. The sentence now interpolates `board.summary.systematicCollapsed` (and the `corroboratedHosts` count beside it), the JSON carries the source fields (`boardSystematicCollapsed`/`boardEmittedCandidates`/`boardSchema`), and `tests/p48-copy-consistency.test.ts` (+4) pins every load-bearing number in the md to its JSON/board row -- the class of gap the freshness gate structurally cannot see. p48 re-run live against the Archive (control PASS, verdict NOVELTY-CHECK-RAN); the CI fleet then re-stamped it again (`44e5c5d`) and the served sentence reads 1 group / 4 candidates.
- **D2 (dedup and freshness are mutually exclusive -- by design, and the claim was retired)** with science-hash dedup ON, an identical-content repeat is deliberately not re-anchored (no second fee), while the served bundle always carries a new `generatedAt` -- so "the on-chain commitment covers the bytes you are reading now" can NEVER be true for deduplicated science (measured: `anchorCoversCurrentBundle` false on 20/20). Rather than rewrite anchor semantics (money path, untouched), the capability claim was WITHDRAWN: README states the mutual exclusion plainly, and the per-card `verify-onchain` branch that hardcoded the wrong cause ("pre-dates a re-derive (timestamp moved); content address stable") now names both possibilities and points at the science-hash verdict as the load-bearing one (test-pinned to not come back).
- **D3 (the 20-vs-0 relationship was only decodable by reading DO SQL)** both anchor counts now ship their population definitions in the published payload (`src/core/stats-definitions.ts` gains `bundlesAnchored`/`ledgerAnchored` sentences) and render as tooltips on the two ticker chips where the numbers sit -- the same single-source channel the rotation counters already use; `tests/stats-definitions.test.ts` (+1) fails the build if the definitions ship without a consumer.
- **D4 (a 324 KB `/api/state` that external verifiers measured failing 40-60% of fetches)** added `GET /api/state/summary` -- a pure projection (`src/core/state-summary.ts`) under ~8 KB carrying the same `stats`/`statDefinitions` plus verdict/origin populations and a cards-with-tx count, wired into BOTH runtimes with behavior tests (`tests/state-summary.test.ts` +3, including a size-ratio assertion); card detail stays at `/api/findings` and `/api/bundles/:id/verify-onchain`.
- **D5 (the other crosscheck report still lived outside the stamping)** `cross_pipeline.py` now writes `generatedAt`/`gitSha`/`inputs` exactly like its sibling benchmark (EOL-mirrored hashes). The fleet caught the coupling live mid-batch: editing `cross_pipeline.py` made the served `benchmark-vs-field.json` HARD-STALE (it hashes that file as a stamp input) while nothing re-fired -- so `leo-vetter.yml` now watches `scripts/cross_pipeline.py` (`176dc31`), and the re-stamp/rebuild chain runs on CI.
- **D6/D7 (phrasing discipline)** the "autonomously producing verifiable on-chain records" framing gets no incremental data support while dedup suppresses new anchors (0 new chain commitments across ~21 h / ~70 passes) -- said plainly here rather than papered over; the README blind-toi wording was tightened to what the code does (caps an ACCEPTED verdict at needs-more-data; critic rejections stay rejected); and the HANDOFF date line finally moved off 2026-10-13 with a note on what it protects.
- **Batch close (write-back identity, the long arm's publish race, and deploy)** landing this batch surfaced two structural gaps the audit had named only indirectly. (1) The nine report write-back workflows committed as `sdr-bot` with no co-sign trailer, so a fresh checkout whose HEAD happened to be a write-back commit failed the very `commit-co-sign` gate it had just pulled (found live at `fc59dcc`); they now commit under the labelled `Space Data Rig` identity plus the `Co-authored-by` trailer GOVERNANCE.md promises -- no history rewritten, and the re-stamp publish-backs that landed during this batch already carry it. (2) The longest arm (`cross-pipeline-python`, 60-90 min) lost its publish to push contention -- a single `git push` rejected as a non-fast-forward after sibling write-backs advanced main -- so its step now commits once and retries the push under `git rebase origin/main`. The library converged to that HEAD (56 reports, `stale: []`, 16 stamped / 14 verified / 14 fully) and deployed: `deploy:window` cleared GO on an idle claimed-run, `cf:deploy:sha` at version `2cfaf03b`, and eight live edge assertions passed -- `/health.gitSha` == the deployed sha, `GET /api/state/summary` 200 at 3,876 bytes against a 325,362-byte full `/api/state`, `app.js` carrying the `statDefCache`/`defKey` render, the served p48 page reading **1 group / 4 candidates** with the corrupt "5" gone, and the library index `stale: []`.

### Seven-point quantitative external audit: gate coverage on the two headline benchmarks, a generated (not typed) poster, an unambiguous crossmatch state, and a board that cannot bake a rotting countdown (2026-10-21)
A fourth third-party pass (R1-R7 + two small items) probed the same failure shape one layer deeper -- *a fix that is true in code but never reaches the surface a reader re-checks*. Every point was closed against bytes, not prose:
- **R1 (the gate covered 26%; the two brightest external benchmarks were outside it)** the freshest scaled report `p75-inverted-fp.json` (n=200, AR(1) FP 0.74, block 0.32, flips 86) and the LEO-Vetter `crosscheck/benchmark-vs-field.json` carried no `generatedAt`/`gitSha`/`inputs`, and `p86` never recursed into `reports/crosscheck/`. `p75` was frozen the same way `p90` was -- a committed `reports/fixtures/p75-frozen-rows.json` replayed OFFLINE by default (`--live` is the deliberate re-measure), its data stamp covering `[script, fixture]` so a scheduled job cannot gamble the cited rate on the live Archive; `benchmark_vs_field.py` gained a Python `freshness_stamp` whose EOL-normalised sha256 mirrors the TS gate; `p86` now enumerates `reports/crosscheck/` (flat `crosscheck-*` slugs) and verifies their inputs (`c7f29b6`). CI (leo-vetter) republished the stamped benchmark, and a local `p86` rebuild confirmed it stamped / verified / reproducible=4 across platforms (`7d5f8d0`); new `tests/r1-gate-coverage.test.ts`.
- **R2 (RESEARCH.md trailed the report it cites)** section 29 still narrated the pre-scale N=16 run (12/16 = 75%, overturns 7) while the committed report and `web/research.json` had moved to N=200 (ar1Fp 148 / blockFp 64 / flips 86). Synced the prose to the frozen N=200 (`c4791be`).
- **R3 (the six-point poster was hand-typed literals that aged inside its own batch)** `web/audit-remediation6-figure.svg` had no generator: "stamped 8 -> 12 of 54", "machine-verified 6 -> 8", "p59/p90 flagged STALE (red banner)" (library is `stale:[]` now), "crossmatch tri-state ... still deferred" (shipped in `ee7389d`), and a baked "deploy f31b87a" (superseded by any later deploy). The figure-no-retracted gate blocks known withdrawn tokens but cannot catch a number that merely ages. Added `scripts/audit6-remediation-figure.ts` (`npm run figure:audit6-remediation`) that READS every volatile figure from committed bytes -- library freshness (16/56 stamped, 14/56 machine-verified, 0 stale) from `web/reports/index.json` and the blend/coverage figures from `p84` -- and refers to the deploy revision by the endpoint that always reflects it (`/health.gitSha`) instead of a frozen SHA; idempotent, nonASCII 0 (`1ed1ddf`).
- **R4 (the two crossmatch states that motivated the audit never fired, and "none" was ambiguous again)** a `hostCatalog === undefined` (missing `meta.hostName`, so the workflow lookup never ran) fell through to the same `"none"` as "lookup completed and found nothing". Added a distinct `lookup-not-run` state (type + decision chain + reason branch) that only appears on the opt-in review path; the default synthetic/bundle path stays byte-identical (`c4791be`, +1 vetting test).
- **R5 ("physically-consistent" still on 38/103, including SNR 45172)** the surviving rows are immutable historical anchored bundles whose stored `verdictReason` the critic no longer emits; rewriting them would move a `scienceHash`. Following the projection-relabel precedent, shared one `SNR_IMPLAUSIBLE = 1000` constant between `src/critic/review.ts` and `web/relabel.js` (a test pins them equal) and added a render-layer `degeneracyCaveat` that annotates any high-SNR "physically-consistent" line at display time -- no bundle rewrite (`76b3524`, +`tests/degeneracy-relabel.test.ts`).
- **R6 (the auto-refresh workflow re-fired on its own commits and left a red publish)** `freshness-regen.yml` had a concurrency group but no self `paths-ignore`, and its re-entrant publish died on `git checkout -B main origin/main` ("local changes would be overwritten"). Made the publish non-destructive: commit first, then MERGE the remote with `-X ours` (this run's fresh bytes win) and retry the push, with the publish commit touching only non-trigger paths (`c4791be`).
- **R7 (the on-chain truth existed but a reader could not reach it)** `verify-onchain` was routed on both runtimes and named four times in the README, yet `grep web/` was empty and the science-drift rows were unflagged. Each finding card now carries an On-chain button that fetches `/api/bundles/:id/verify-onchain` and reports the honest branch (`not anchored` / `chainReadable:false` / `verifiable` / `anchoredScienceDrift` / bundle-vs-science match) (`76b3524`).
- **Small: the candidate board could no longer bake a rotting countdown.** `web/candidates.json` (a dated snapshot) shipped `nextTransitBjd`/`daysUntilNext`; the console already projects the countdown live from `epochBjd + periodDays`, but a raw-JSON consumer still got a stale day-count. Fixed at the contract boundary: `CANDIDATE_SCHEMA` -> `sdr-candidates/2`, the row type and the `p22` writer drop the two now-relative fields, and the validator now REJECTS a stale `/1` snapshot (kept `altitudeDeg`, which is geometric placement, not a clock) (`d5dd629`, +2 snapshot tests). The served `/1` file flips to `/2` on the next networked `p22` publish, where its stamped dependents `p48`/`p76` re-stamp alongside it; a local re-stamp of `p76` is impossible because ExoFOP returns 0 rows to an anonymous sandbox fetch, so it -- and the re-observation `p22` itself -- are deliberately left to a networked runner rather than hand-edited into a HARD-STALE inconsistency. To make that residual self-heal rather than wait on a manual step, `d9c270f` extended the `freshness-regen` fleet: `p48` (previously outside it, though it also stamps the board) gained a fast Archive-only arm + its publish `git add`, and `web/candidates.json` became a push trigger -- so a deliberate `p22` board republish re-stamps BOTH novelty reports together on a networked runner and the rebuilt library never carries a stale novelty report. **The residual is now closed.** `p22` was re-observed against live MAST TGLC (sectors 1-3) + the NASA Archive, emitting a fresh `/2` board (24 raw -> 6 planet-plausible -> 5 independent ephemerides, L3 collapsed 1 systematic, 4 rows, all `discoveryClaim` false) with p48 re-stamped locally (`6b3b158`); the push to `web/candidates.json` auto-fired `freshness-regen`, which re-stamped p76 on the networked runner and rebuilt the library to `stale:[]` (`14f1d15`), then deployed (`cf:deploy:sha`, version `919be633`) -- live `/health.gitSha` equals `14f1d15`, live `/candidates.json` serves schema `/2` with no `daysUntilNext`/`nextTransitBjd`, and the R3 poster's 16/56-stamped / 14/56-verified / 0-stale counts still match the served index exactly.
- **Small: /api/state latency (341 s for the auditor) is a DO turn-serialization cost, not a wrong number.** The handler awaits one `getState()` RPC then maps findings through a trivial projection; there is no O(N^2) or per-finding await. The long tail is a strong-consistency read queued behind an in-flight survey pass inside the single-threaded Durable Object, plus cold start. `deploy:window` now MEASURES that cadence from the live rig rather than assuming a 45-minute pass: this pass observed 35 recorded passes, full-pass span median 238 s, idle median 276 s. Left as latency (accuracy is unaffected); no blind DO-consistency/caching change was shipped because it cannot be re-measured against the contention window from here.

Deployed and live-verified via `cf:deploy:sha` (version `0684a371`): `/health.gitSha` equals the deployed commit `d5dd629`; cache-busted `GET /audit-remediation6-figure.svg` serves the generated data-driven poster (16/56 stamped, `/health.gitSha`, no baked `f31b87a`), `/app.js` carries the On-chain action + degeneracy caveat, `/relabel.js` carries `SNR_IMPLAUSIBLE`, and `GET /api/bundles/F-TOI-1608-01/verify-onchain` returns 200 with the honest `anchored:false / chainReadable:false` branch. Suite grew 861 -> 875 green; `typecheck:all`, `eslint --max-warnings 0` and coverage (95.97% lines / 83.02% branches) clean. Research-only throughout: no discovery claim, and no verdict-gate semantics or money path changed without measurement.

### Six-point quantitative external audit: a keyless on-chain read-back, a crossmatch that cannot call a failed lookup "novel", and a depth calibration frozen so a cited number stops moving (2026-10-20)
A third-party six-point audit found the same shape of defect across the whole stack -- *a thing was computed but never
actually reaches the surface a reader checks*. Each point was closed against code, not prose:
- **#1 (retracted number still printed live)** `audit10-close-figure.svg` / `audit3-remediation-figure.svg` still printed a
  withdrawn `71%` (correct values: P84 coverage-loss 70%, P85 contaminant 77.2%, both report-driven); the
  figure-no-retracted guard only scanned top-level SVGs and its banned-token list predated `71%`. Widened the guard to
  recurse over every served SVG/HTML fragment and added the retracted string (`fe0c268`).
- **#2 (false "not machine-verifiable" banner)** the served index under-counted `verified`/`fullyVerified` and three reports
  carried a red "blind.jsonl not tracked" note that was no longer true. Fixed in the prior batch (`55dec68`/`b367e09`) and
  re-verified live this pass.
- **#3 (freshness coverage + stale presented as current)** the gate covered 8 of 54 reports; P92/P93/P95/P96/P48/P76
  carried no `generatedAt`/`gitSha`/`inputs`; and `research.json`/`app.js` rendered the P76 multi-source figure as a live
  count while its generator had not re-run since the ExoFOP 3.8 MB pull timed out at the old 45 s default. Wired
  `buildStamp` into those generators, raised the ExoFOP fetch timeout to 180 s, and marked P76 point-in-time with a
  `snapshotAt`/`stamped` caveat rather than presenting a shrink-0 as a current number (`b4f1518`).
- **#4 (README over-promised on-chain trust)** `/api/bundles/:id/verify` only self-compares the served bytes to a served
  `HASH.txt` -- it never queried Solana -- so "anyone can re-read the memo and check the science against the site" was a
  write-path fact with no read path. Reworded the README to the narrow truth (`f31b87a`) and then MADE it true: a shared,
  runtime-agnostic, dependency-free `src/solana/memoVerify.ts` decodes the sealed memo's `bundleHash` AND `scienceHash`
  from a live `jsonParsed` getTransaction and compares both to what the site serves now, surfaced as keyless
  `GET /api/bundles/:id/verify-onchain` on both runtimes, reporting `chainReadable:false` rather than a false "verified"
  when no RPC answers, and an explicit `anchoredScienceDrift` only when the chain sealed a *different* science (a
  historical 3-field memo is `legacyMemo`, deliberately not drift) (`13a30bb`, 11 offline mock-RPC tests).
- **#5 (degeneracy called "physically-consistent"; crossmatch conflated a failed lookup with empty)** stopped labelling
  degenerate fits physically consistent and widened the harmonics sweep (`b1fd728`); and `crossmatchPeriod` is now
  tri-state: `fetchPlanetsByHost` distinguishes "completed-and-empty" from "lookup-failed", the critic adds a
  non-gating `catalog-lookup` status (`hit`/`alias`/`off-slice`/`none`/`lookup-failed`), a failed/off-slice lookup can only
  DOWNGRADE a "novel" reading and the accepted set never widens, and the default synthetic/bundle path is byte-identical
  (`ee7389d`, +6 behaviour tests).
- **#6 (candidate countdown baked a stale day-count)** the countdown printed a value frozen at build time; it is now
  projected live (`724cfc1`).
- **Making the clears stick.** A dedicated CI workflow `freshness-regen.yml` re-runs the network-bound reports on a
  runner where ExoFOP/MAST/Gaia answer (they time out in a laptop sandbox) and publishes the re-stamped reports + the
  rebuilt library back to the repo, clearing every red STALE and giving p92/p76 a real stamp (`b38ae21` -> `80d179c`);
  the live library is now `stale:[]`, 14 stamped / 12 verified / 12 fullyVerified of 54. Re-measuring p90 against the
  LIVE Archive moved its period-matched sample 16 -> 6 and the published depth error bar 48% -> 58% -- a figure
  `src/core/depthFormat.ts` bakes into the public cards -- so p90 is now frozen against a committed snapshot
  (`reports/fixtures/p90-frozen-rows.json`) and replays OFFLINE/deterministically by default, its data stamp pointing at
  the fixture rather than the fetch layer, so a scheduled job can no longer gamble a cited number on when it ran;
  the published 16/48 numbers are UNCHANGED and `--live` stays the deliberate re-measure path (`e8d6de4`, `ad7b61a`).

Verified end to end: `typecheck:all` and `eslint --max-warnings 0` clean, 113 test files green with coverage 95.95% lines
/ 83.03% branches; deployed via `cf:deploy:sha` (version `8aede3ec`) with `/health.gitSha` equal to the deployed commit
`ad7b61a` and CI green on it; live `GET /api/bundles/F-HR-858-b/verify-onchain` returns `chainReadable:true`,
`ledgerBundleMatch:true`, `anchorCoversCurrentBundle:false` (the timestamped bundle re-derived) yet
`scienceHashMatch:true` / `anchoredScienceDrift:false` (the science content address held). Research-only throughout;
no discovery claim, and no production verdict-gate semantics changed without measurement.

### An occurrence-rate kernel, a real selection integral, and a forward-model consistency check that refuses to fake a rate (2026-10-19, thirteenth pass)
Priority 5. `src/sim/occurrenceRate.ts` (7 unit tests) is the pure kernel: Gehrels (1986) Poisson intervals on a
count, the `eta = n/(N*S)` inversion, and the forward model `E[N] = N*eta*S` with a standardised consistency score.
`scripts/p96-occurrence-kernel.ts` composes the committed P47 completeness grid (960 injections on real photometry)
with real Keplerian geometry to MEASURE the survey selection integral **S = 0.0995** over the box it actually covers
(P in [1,9.5] d, Rp ~> 1.5 R_earth, solar-twin reference) -- a real, citable sensitivity number. It then FORWARD-MODELS
the field anchor rate (Gillis et al. 2025/2026, AJ, 1.10 +- 0.16 planets/star, R>1 R_earth, P<30 d) through S: ~0.87
expected detections over an unbiased 12-star sample vs the pipeline's recovered 8 on its deliberately planet-bearing
hosts, a +2.1 sigma excess that IS the known selection bias, reported as such. The naive inverted eta (6.7/star) is
printed only to prove the kernel runs and is labelled NOT a measurement -- a selection function built on confirmed-
planet hosts cannot support a rate, and the study says so. Research-only; discoveryClaim / safeToGate false; RESEARCH
section 35 documents it. `reports/p96-occurrence-kernel.{md,json}`.

### A bounded, citable unified catalogue with a measured known-planet recovery and a joint C/R operating point (2026-10-19, twelfth pass)
`scripts/p95-unified-catalog.ts` assembles ONE reproducible, quotable object from committed bytes -- the byte-exact
real SPOC fixtures, the NASA-archive stellar parameters from p94, and the P3 candidate-level null -- no network, so
every run re-reads identical data. It measures three things: a real KNOWN-PLANET RECOVERY rate (the pipeline's blind
BLS argmax landing, alias-tolerantly, on each host's own confirmed planets -- the pipeline analog of the field's
known-TOI recovery), the joint `sqrt((1-C)^2+(1-R_FA)^2)` OPERATING POINT (completeness on injected transits vs
reliability on a time-scrambled population, threshold chosen by the objective), and the catalogue table (TIC, sectors,
Teff/R/M/rho, known periods, blind best SNR/period, recovered?). On 12 real hosts: blind known-planet recovery 8/12
(66.7%); the C/R objective has a clean interior minimum at BLS SNR>=15 (C=98.3%, R_FA=89.4%, objective 0.107) with
7/35 scrambled false alarms clearing that gate and 5/12 recoveries standing at the operating threshold. The 66.7% is
reported honestly, not smoothed: a single blind peak on multi-planet-rich bright hosts lands on one companion, whereas
LEO-Vetter's ~90% is a mature multi-year multi-ephemeris statistic -- different numbers, both as measured. Bounded n=12
is a demonstration catalogue; the SNR is read off THIS sample, not asserted survey-wide; discoveryClaim / safeToGate
false; RESEARCH section 34 documents it. `reports/p95-unified-catalog.{md,json}`.

### Running the field's actual reference vetter (LEO-Vetter) on our fixtures -- closing the benchmark gap (2026-10-19, eleventh pass)
RESEARCH section 4c: the rig's vetting had only ever been scored against our own re-implementations. Priority 1 runs
the field's published 2025 vetter, LEO-Vetter (Kunimoto+ 2025, AJ 170, 280), on the SAME committed real-curve
fixtures. `scripts/p94-stellar-params.ts` sources the stellar dictionary LEO-Vetter needs (Teff/radius/mass/rho/logg)
from the NASA Exoplanet Archive TAP the pipeline already trusts -- one deterministic row per host (innermost confirmed
planet; pscomppars lists a star once per planet, the ambiguity that churned p60), rho derived from the same catalog
mass/radius, committed to `tests/fixtures/spoc-curves/stellar-params.json` with provenance (3 offline schema tests); limb
darkening is computed by LEO-Vetter's own Claret (2021) interpolator, not fabricated; the CSVs are untouched.
`scripts/benchmark_vs_field.py` runs in `crosscheck-python.yml` AFTER the detection harness (so a dependency resolution
cannot disturb it): injected planets -> LEO-Vetter Planet-Candidate completeness across a depth grid; an injected
equal-brightness eclipsing binary -> its false-positive flag rate. Every cell and the package import are guarded; the
script always exits 0, so an honest LEO-VETTER-MISSING report beats a masked null and the arm can never redden CI. The
CI-measured numbers publish to `reports/crosscheck/benchmark-vs-field.{md,json}` and sit beside p92 completeness and p93
ROC on identical inputs. Research-only; discoveryClaim / safeToGate false; RESEARCH section 33 documents it.

### A labelled false-positive taxonomy and the flux-validation ROC it measures (2026-10-19, tenth pass)
The rig could analyse false positives (secondary-eclipse / odd-even discriminants, a neighbour blend FPP, an alias
grader) but had never GENERATED the labelled family the field trains and scores on, nor COMBINED its discriminants
into a single posterior. `src/sim/falsePositiveTaxonomy.ts` (7 offline tests) synthesises the physical FP taxonomy --
planet, EB, HEB, BEB, NEB (the eclipsing-binary family) and HTP, NTP (blended planets) -- onto real curves; the tests
pin the load-bearing physics: an EB carries a phase-0.5 secondary that survives dilution as a fixed ratio, a planet
carries none, and a blended planet is flux-degenerate with an on-target planet. `src/candidate/validationPosterior.ts`
(7 offline tests) folds the repo's own discriminants into one additive-log-odds planet posterior and applies the
field's > 0.99 validate norm; crucially an UNDETERMINED discriminant contributes nothing, so a too-shallow signal
stays uncertain and is never falsely validated. `scripts/p93-fp-taxonomy.ts` scores them on 12 committed byte-exact
real SPOC fixtures (48 injections per class, flux-only arm, conditioned on the correct ephemeris): positive control
validated 48/48 (100%), EB-family rejected via its secondary 191/192 (99%), blended planets HTP/NTP mis-validated
96/96 (100%) -- the last being the honest point, not a failure: flux ALONE cannot separate a diluted planet-shaped
blend from a real transit; only pixel/centroid vetting (P53 / P58 / P89) breaks that degeneracy. Neither module is
wired into the critic, verdict, bundle hash, or money path; discoveryClaim / safeToGate false; RESEARCH section 32
documents it. `reports/p93-fp-taxonomy.{md,json}`.

### A candidate-level scrambled false-alarm null, and the completeness/reliability gate it reads off real data (2026-10-19, ninth pass)
`src/detect/falseAlarmNull.ts` (8 offline behavioural tests) gives the rig, for the first time, a CANDIDATE-level
false-alarm POPULATION and the LEO-Vetter joint objective `sqrt((1-C)^2 + (1-R_FA)^2)` scored against it --
completeness on injected planets, reliability against time-scrambled TCEs. It reuses the repo's two existing nulls
where they belong (`fap.ts` per-candidate phase-scrambling FAP, `invertedNull.ts` inversion) and adds what neither
is: a shuffled curve (permute the flux among fixed cadences) keeps the exact amplitude distribution but destroys
any phase-coherent transit, so every surviving BLS peak is a false alarm by construction. `scrambleFlux` ships a
`shuffle` mode (LEO-Vetter's) and a `block` mode that preserves short-range correlation; the tests pin that both
really break a transit's stacking -- the documented trap where a circular time-shift would NOT.

`scripts/p92-scrambled-fa.ts` measures it on 10 real TESS-SPOC curves (50 injected transits, 57 scrambled TCEs). The
joint objective has a genuine interior minimum at BLS **SNR >= 22 (C = 88.0%, R_FA = 78.6%)**; a pure-noise-amplitude
scrambled null still pushes 21.1% of spurious peaks past that gate (median BLS SNR 10.8). That is the same lesson
P23 / P39 taught -- a fixed noise-SNR gate is nowhere near enough against a real-noise false-alarm population -- now
quantified at the candidate level. Honest limits recorded in `reports/p92-scrambled-fa.md`: n = 10 is a method
demonstration not a production threshold; shuffle whitens the noise colour so this is the look-elsewhere / outlier
false-alarm FLOOR, complementary to the AR(1) and coherent-systematic nulls; the inverted arm yielded 0 transit-like
false alarms, itself consistent with LEO-Vetter finding inversion the weaker surrogate. Completeness is scored at the
injected ephemeris (narrow BLS grid at the truth period) to stay immune to host-planet contamination. Nothing wired
into the critic or the money path; discoveryClaim / safeToGate false; RESEARCH section 31 documents it.

### A stale report blocked the library, and reproducing it nearly broke the documents that cite it (2026-10-18, eighth pass)
`npm run p86:report-library` exited non-zero: `p41-longbaseline` was flagged STALE because `61d7c68` changed
`src/detect/bls.ts`, one of its recorded inputs. The gate worked -- it was saying the published completeness table had
not been recomputed under the current detector. Re-running with the script's *current defaults* (40 hosts) changed the
numbers, and that is the trap: `RESEARCH.md` section 9 and several CHANGELOG entries quote this table, so publishing a
40-host version would have left two documents citing percentages the committed report no longer contains -- the same
cross-document counter drift as the `blindCandidates` split above. Re-run instead at the parameters the report itself
records (`--stars 30 --maxsectors 4 --period 3 --seed 7`): every cell reproduces exactly (51.7/37.9 at 300 ppm,
65.5/65.5 at 500, 75.9/75.9 at 800, 82.8/75.9 at 1500, 89.7/79.3 at 3000, mean 2.69 sectors per host) and the rendered
markdown is byte-unchanged. Only the stamp and the per-host sector point counts moved -- those counts track whatever
SPOC served on the run day, which is a fetch difference, not a detector difference, and the 40-host run is kept as an
gitignored sample-size sensitivity note (`out/p41-40hosts-sensitivity.{md,json}`) rather than quietly published.
The library now reports **0 stale** with `fullyVerified` 3 (was 2).

Also new: the M4 milestone figure (`src/figures/m4MilestoneFigure.ts` for the geometry and wording, `npm run
figure:m4` for the capture). Its one hard rule is that no number is typed into the drawer -- the record is assembled
from the committed `reports/p88..p91` JSON plus the live counters, and the builder throws on a missing field rather
than rendering a zero, because "this measured zero" and "nobody looked" must never print the same way. The cadence
quoted on the picture comes from `measurePassSpans` over the recorded timestamps, the same function `deploy:window`
uses, so the figure and the deployment rule cannot describe different rhythms. `tests/m4-milestone-figure.test.ts`
pins the rules offline and rebuilds the committed SVG from the committed record byte for byte.

The record and the panel are now committed, captured from production after the deploy: `reports/m4-milestone.json`
(measured 2026-10-18T16:34:34Z) and `web/m4-milestone-figure.svg`, inventoried by `npm run p87:figures-manifest` as
the 27th figure in the gallery. It prints what the measurements said -- p88 6/17 Gaia coverage with `period matched: 0`
and veto power 0.00 (drawn in the warn colour, not the colour of a positive result), p89 5 curves / veto power 0.00 /
2 false vetoes, p90 published estimator at -26.2% median signed error against the box statistic's -35.4% on 16
injections, p91 5/5 controls met on 5 rows over 5 axes, and the definition layer at 29/50 blind held/assessed with
cadence measured from the recorded timestamps. The three byte-equality assertions that were skipped pending this
capture now run: 104 test files / 798 tests / 0 failures / 0 skipped via `npm run test:coverage` (the CI command, so
the coverage floors are included).

Sweeping the same ground for "a rule with no call site" turned up three more, all fixed here:

- `RigStateDO.advanceSurveyPass()` was dead: nothing in `src/`, `scripts/`, `tests/` or `web/` called it, and the
  comment above it still described the pre-audit-6 control flow -- "advanced idempotently at the end" -- which is
  precisely the tail-side advance that froze the survey at pass 1 for 22 hours. A stale comment next to a dead
  method is an invitation to rebuild the bug, so the method is gone and `tests/run-mutex.test.ts` now asserts the
  wiring the DO itself cannot be imported to check: no pass-advance RPC exists, `decideAdvance` has exactly one
  production call site (inside `decideStart`), and every write of the `surveyPass` key lives in the atomic claim.
- `PUBLIC_STAT_DEFINITIONS` had zero call sites while `web/index.html` carried a hand-typed copy of the same
  sentences in its tooltips -- a module documented as the single source of truth for what each counter counts,
  and readers were being told by a paragraph nobody checked against the query. The definitions are now published
  on the state payload (`DashboardState.statDefinitions`, filled from the same constant by both the Durable Object
  and the Node server) and the browser writes the tooltip from that payload; the markup quotes none of them, and
  an older server that sends no definitions gets no tooltip rather than an unverified one.
- `HANDOFF.md` section 5, the repository map, had no line for `src/figures/` or `src/survey/`, and nothing was
  checking. `tests/repo-hygiene.test.ts` now requires the layout to name exactly the directories that exist -- in
  both directions, so a deleted directory cannot keep pointing a reader at nothing.
- `HANDOFF.md` section 13, "Current state", was dated 2026-10-13 with HEAD 148ff2c roughly sixty commits and six audit
  passes ago -- a snapshot presenting itself as the present. It is rewritten from the live rig (deployed version and
  gitSha read back from `GET /health`, switches off the deploy's binding list, counters off `GET /api/state`) and
  `tests/handoff-freshness.test.ts` now holds it to its date: the as-of date may not trail the newest dated CHANGELOG
  entry, every commit sha it names must be reachable from HEAD, and the production bullet must name the revision it was
  built from. The gate's first run on the old text failed three ways, including calling the wrangler version id -- a
  hex UUID -- an unreachable commit, which is why it strips versions before asking about shas.
- That new gate then failed in CI (run 39146663797) while passing locally, and the reason was worth keeping: the job
  log said `not ok - every commit sha section 13 names is reachable from HEAD` because `actions/checkout` defaults to
  `fetch-depth: 1`. In a shallow clone every real ancestor looks unreachable, so the gate was asking a question the
  checkout could not answer. Fixed on both sides, not by relaxing the assertion:
  `.github/workflows/ci.yml` now checks out with `fetch-depth: 0`, and the test fails with "this checkout is shallow,
  so commit reachability is unknowable here" instead of reporting a real commit as invented. A gate that goes green
  because the environment cannot compute the answer is the failure mode this whole pass is about.

Deployed on the measured window rather than a hunch: `npm run deploy:window` returned WAIT through two live passes,
then GO at 16:32:59Z (previous pass finished 16:32:31Z, 720 s of idle against a 120 s budget), and version
`045d730c-7a99-45c7-93ad-eea12e6293d6` went out from a clean tree. Live evidence after the deploy: `/health.gitSha` =
`56e4574` = HEAD, `/api/state` publishes `blindHeld` 29 over `blindCandidates` 50 plus the four `statDefinitions`
sentences, the report library serves `stale: []` with `fullyVerified: 3`, and the p91 page returns 200 with no STALE
banner on p41.

The static-asset redeploy that followed (version `a3d0ea01-df36-47d0-88fb-0c0f46f5ff37`, gitSha `75e13a4`, serving the
M4 panel and the 27-entry manifest) went out on a WAIT verdict, stated rather than smuggled: the tool had returned WAIT
on fourteen consecutive checks and one UNKNOWN over roughly two hours. The justification is measurable, not a mood --
`git diff 56e4574..75e13a4 -- src` is 0 bytes, so no survey pass could straddle two code versions, which is the only
thing the window protects against. What those two hours of WAIT actually revealed is a defect, recorded in HANDOFF
section 13 as the next pass' starting point: two consecutive autonomous passes wrote their last row within about four
minutes and then held the run mutex until the 30-minute stale takeover released them
(`run-20261019-001518` claimed 00:15:18Z / last event 00:19:24Z / released 00:45:18Z; `run-20261019-004518` claimed
00:45:18Z / last event 00:47:44Z / still live at 01:15Z), while `run-20261018-161518` released cleanly after 17 minutes
-- so the finish path is intermittently not running. Consequence: the survey does roughly one pass per 30-45 minutes
against a `*/15` cron, half the scheduled claims are refused by a slot that is doing nothing, and deploys inherit that
waiting. It is the audit-6 family on the FINISH half of the mutex, and shortening `STALE_RUN_MS` would be the wrong
fix -- that re-opens the slot to a genuinely slow pass and lets two passes write concurrently.

Measured in the same read: `bundlesAnchored` moved from 11 to 5 while `ledgerAnchored` held at 20. That is the
anchor-count semantics from the sixth pass working as documented -- re-derived records leave the published-bytes count
without leaving the chain -- and it is now stated in the snapshot so the movement is not read as lost evidence.

### The deploy-window belief was wrong by an order of magnitude, and a governance rule with no gate lapsed (2026-10-18, seventh pass)
The plan carried "a survey pass takes ~45 minutes and leaves only seconds of idle", which made every deploy feel like
a gamble squeezed into a narrow hole. Measured against production it is simply not the regime. `npm run deploy:window`
(new; rule in `src/deploy/deployWindow.ts`, pinned by `tests/deploy-window.test.ts`) now reads the live claimed-run
state and the recorded finding timestamps and prints a verdict -- GO / WAIT / UNKNOWN -- alongside the cadence it
measured: across 24 recorded passes the cron fires every 15 minutes, a full 8-target pass writes over a median of
**260 s** (164-307 s), and the median idle gap between passes is **~2400 s**. The survey holds about a fifth of each
slot. Both historical failure modes came from trusting a number instead of taking it: uploading inside a live pass (a
pass straddling two versions leaves `/health.gitSha` able to name only one) or waiting for a hole that was never there
and leaving production stale. GO requires no live claim AND enough idle before the next boundary to cover the upload
budget; the stale-claim threshold is imported from `src/cf/run-mutex.ts::isStaleClaim` rather than restated, so the
window and the Durable Object can never disagree about what a dead claim is, and an unreachable rig reports UNKNOWN
(exit 2), never a reassuring GO.

Also fixed, against myself rather than the auditor: GOVERNANCE.md says commits are co-signed and this file documented
the exact trailer -- and two commits this pass were pushed without it while every other gate stayed green, because a
convention that lives only in prose depends on being remembered in a different context each time. `tests/commit-co-sign.test.ts`
now checks the HEAD commit for the co-sign trailer and the labelled author identity, so the next omission fails
`npm test` before it can be pushed. The two commits were NOT rewritten: published history is what the ledger and the
devlog cite, so the deviation is recorded here plainly instead of being quietly amended away.

### The board counted critic-rejected noise as blind candidates, and two other numbers were mis-labelled (2026-10-18, seventh pass)
`blindCandidates` on `/api/state` counted every row tagged `origin="blind-toi"` -- including the ones the critic had
just REJECTED as noise -- while the X digest deliberately counted only surviving candidates. One phrase, two
populations, neither surface saying which: production showed 47 blind candidates on the board where the feed's honest
figure was 26, 21 of them rejected dips. The population is now split into `blindHeld` (still held for human follow-up)
over `blindCandidates` (assessed), and the rule lives once in `src/core/stats-definitions.ts` as `isHeldBlindCandidate`,
which the Durable Object's SQL, the Node mirror and `science-digest.ts` all call -- the digest's hand-written copy of
the filter is gone, so the board and the feed cannot disagree about what a "blind candidate" is. Two adjacent mislabels
were fixed in the same sweep, in the same spirit as the anchor-count split: `surveyPass` is passes CLAIMED, not
completed (the cursor advances when a run takes the slot, so a hung pass counts once and never twice), and
`distinctHosts` is distinct hosts among RECORDED results of any verdict, not targets analysed (that is the separate
`targets` tile). Each counter now carries its definition on hover in the served markup. `tests/stats-definitions.test.ts`
(9 tests) runs the Durable Object's actual SQL against real `node:sqlite` rows and asserts it selects exactly the rows
the JavaScript predicate does, so the two runtimes cannot report different totals for the same phrase.

### "Can this rig verify a claim like this one?" -- a provenance review of a public astronomy claim (P91, 2026-10-18)
The operator pasted a widely-shared post ("JUST IN: NASA's James Webb Space Telescope detects a mysterious infrared
light signal ... from a seemingly empty void") and asked whether the system verifies phenomena like it. The honest
answer is no: the rig is a broadband optical (0.6-1.0 micron) transit finder and the claim is a narrow ~1.6 micron
emission line with no ephemeris to fold. So P91 does not pretend to re-measure the SKY; `src/claims/claimReview.ts`
(pure, network-free) plus `scripts/p91-claim-provenance.ts` audit the CLAIM's own structure on five axes -- subject,
recency, attribution, band, corroboration -- each printing its rule beside its result, resolving identifiers against
Crossref and arXiv directly rather than a search summary, and keeping what the post cited separate from what the
reviewer located so our diligence is never read as the poster's. Controls ship with the real row: a same-day citing
post must come back clean (a verifier that only complains is caught), a wrong-observatory post must MISMATCH even
though its link resolves, a dead DOI must report CITATION-DOES-NOT-RESOLVE and never "no such result exists", and a
retrospective post with no freshness wording must stay silent on timing. The first fixture pass caught two of its own
false alarms -- an invented "4.4 micron" (the abstracts say 1.60) and a Hubble control that matched because Hubble is
in the paper's own abstract -- corrected against the real records. Offline and live verdicts are identical
(`tests/claim-provenance.test.ts`); `safeToGate` is false on every row and no discovery wording is emitted.

### Two different anchor counts were being published as one, and chasing it found a ledger that could forget (2026-10-18, sixth pass)
`/api/state` reported `bundlesAnchored: 7` while `/api/ledger` listed 18 anchored rows, and the dashboard rendered the 7
under the label "on-chain" -- which every reader, including the operator writing a summary, reads as the total. Both
numbers were correct. `bundlesAnchored` counts findings whose CURRENTLY PUBLISHED bundle carries a confirmed stamp: the
bytes you can download now are the bytes a commitment covers. A bundle hash folds the run's `createdAt`, so any
re-derivation by the rotating survey produces a hash the chain never saw, the stale stamp is dropped rather than
inherited, and the record leaves the 7 while its transaction stays on mainnet. Eleven rows were in that state when this
was found; a re-reading during the same pass had the split moved to 9 and 9 with the total unchanged -- which is the
point: the smaller figure moves while nothing is being un-anchored, so it was never a total. The metric that answers
"how many results has this rig put on chain" did not exist anywhere.

Both exist now. `RigStats.ledgerAnchored` counts ledger rows that record a commitment which landed -- status `anchored`
AND a signature somebody can look up, so a row that never resolved is not counted as evidence. The rule is
`isCommittedLedgerRow` in `src/core/anchor-verify.ts` (generic over the row shape, because the Durable Object and the
filesystem ledger declare different `LedgerEntry` types and must not hold two versions of this), with the Durable
Object's SQL form exported as `LEDGER_COMMITTED_SQL` so a test can compare the query against the predicate: the DO
imports `cloudflare:workers` and cannot be loaded by the Node runner, exactly as in `tests/run-mutex.test.ts`. The
dashboard gained a second tile -- "sealed as published" beside "chain commitments" -- each carrying its definition in a
hover attribute, and the feed ticker chips were split the same way.

Following the discrepancy into the write path found something worse than a mislabelled number. The ledger keeps ONE row
per finding (`INSERT OR REPLACE`, primary key `finding_id`; the fs ledger matches by findingId and replaces in place),
and both runtimes stored whatever the newest attempt produced. A FAILED re-anchor of an already-anchored finding
therefore overwrote the signature, slot and explorer URL of a commitment that is still live on mainnet: provenance
evidence destroyed by a transient RPC error, and the cumulative count falling on a network hiccup. `mergeLedgerRow`
(now the single rule both runtimes call) refuses the demotion: a landed row keeps its proof, the lost attempt is
recorded beside it in `lastAttemptError` / `lastAttemptBundleHash` / `lastAttemptAt`, and a genuinely newer successful
anchor still replaces the row as it should. The anchoring CLI had a third copy of the count, a looser one
(`status === "anchored"`, ignoring the signature); it now calls the shared predicate, and it reads the ledger before
writing the snapshot it persists, which previously froze whatever total the earlier run had left.

`tests/anchored-stats.test.ts` (11 tests) pins the predicate over anchored/failed/pending rows with and without a
signature, the merge in both directions, the two counters disagreeing on one store by construction, and then the wiring:
that the DO reads the prior row, merges, and writes the merged value; that the fs ledger no longer contains the spread
that allowed the demotion; that the Node API server passes ledger rows to every surface that renders these numbers and
to both snapshot writes; that the served `index.html` has six tiles whose labels no longer include the word
"confirmed" -- a verdict tile bearing that word contradicted the project's own wording rule, since a card for the same
verdict says RECOVERED -- and that the stylesheet's grid column count equals the number of tiles the page actually
renders. No test touched `web/index.html` before this pass.

The discrepancy is also drawn, from production rather than from prose: `npm run figure:anchor-counts` reads
`/api/state` and `/api/ledger`, writes `reports/anchor-counts.json` (the rows, the two published counters, the read
instant) and `web/anchor-counts-figure.svg`, and the builder in `src/figures/anchorCountsFigure.ts` REFUSES to draw
when the published counters do not follow from the rows -- first reading: 19 commitments, 12 sealed as published, 7
superseded by a re-derivation, 0 anomalies. The geometry is a pure function of the snapshot (no network, no clock),
so `tests/anchor-counts-figure.test.ts` rebuilds the shipped SVG from the shipped JSON and requires byte equality,
and checks each refusal separately. A number in a `<text>` element has the same authority as a number in a table and
none of the same friction; that is why the picture gets the strictest check of the three.

One inherited decision item closed in the same pass, on my own authority and stated rather than asked: the suite's
own floors were raised. Coverage gate 85/75 (lines/branches) to 90/78, measured headroom 95.7/82.5; test-file
discovery floor 60 to 90, measured 97. A floor that does not move while the number above it climbs for six audit
passes records a permission, not a gate -- the old discovery floor would have waved through the loss of a third of
the suite. Headroom is kept deliberately, because a gate that fails on measurement noise between local and CI runs
gets switched off, which is worse than a slightly lower gate.

Registering the new panel also exposed a fourth gap of the kind this pass keeps finding: `web/figures.json`, the
manifest the dashboard Gallery builds itself from, had not been regenerated since the depth-precision figure was
added. That figure was reachable -- `web/*.svg` is served straight off the directory -- and was cited in a published
summary, while the page a reader goes to for "all the figures" did not list it. A served file and an inventoried
file are two different claims. Regenerated (26 figures, both new panels present) and pinned by
`tests/figures-manifest.test.ts`, which fails if any committed SVG is missing from the manifest, if a card points at
a file that is not there, or if the declared count and the list disagree -- the same shape of gate as
`tests/report-library.test.ts` for reports. It names the two figures added here rather than only counting entries,
because "the manifest has 26 items" stays green while the two nobody looks for are the two that are missing.

Suite 747 of 747, typecheck and lint clean, coverage 95.7% lines / 82.5% branches, `anchor-verify.ts` and
`anchorCountsFigure.ts` both at 100% lines, English-only gate green.
No verdict, gate, threshold, bundle field or anchored address moved: this changed how counts are computed, labelled and
preserved, not what the pipeline decides.

### /health certified a commit that was not what production was running (2026-10-18, fifth pass)
Found by looking at live records instead of trusting the deploy log: seven rows carried narration that the shipped
code could not have written. The depth bars were computed from a constant that had been superseded, and the sentence
explaining them was an earlier draft.

`npm run cf:deploy:sha` exists to keep one claim true: that the bytes in production are the bytes in a reviewed
commit. It sets the `GIT_SHA` secret from `git rev-parse HEAD`, then runs `wrangler deploy`. But wrangler uploads
the files on disk, and the two agree only when the working tree is clean. The script knew that and printed a
warning -- a warning that changes nothing is a notice to whoever reads the console. An automated deploy fired at
09:19Z from a gap-catcher watcher while my tree held an in-progress, uncommitted renderer; it uploaded that tree
and /health reported `f473c72`. For 75 minutes production ran code that existed in no commit, no CI run and no
review, and every proof built on the deployed-revision self-report inherited the mismatch, including seven records
whose published wording no merged revision could produce.

The fix is a refusal, not a warning. `scripts/deploy-with-sha.ts` now calls `deployDecision()` from
`src/deploy/deployGuard.ts` BEFORE writing the secret or uploading: an unresolvable HEAD is refused (unchanged), and
any uncommitted path is refused with each one listed, exit 1, nothing uploaded. `--allow-dirty` remains for a
deliberate emergency and logs, in the operator's face, that gitSha will not describe those paths.

The test is `tests/deploy-guard.test.ts`, and it does not stop at the pure function -- a unit test on a predicate
whose call site was deleted would stay green forever, the failure mode this repository has already been audited
into twice. It asserts the script imports the shared rule rather than copying it, that the refusal exits non-zero,
that the guard runs before both the secret write and the upload, that the old warning-only line is gone rather than
merely superseded, and it drives the REAL CLI: it creates an untracked probe file, runs the deploy command in
dry-run, and requires exit 1 with the probe listed and no upload attempted. The probe file is deliberately NOT
gitignored, because an ignore rule would hide the exact dirt the gate must catch and the test would then watch the
CLI take the clean path while still reporting green.

Consequence for the record, stated rather than buried: the seven rows written inside that window were narrated by
unreviewed code. Their numbers are correct (the depth, SNR and scatter they publish satisfy the invariant the
shipped code enforces, verified row by row), but their error bars came from a constant that measurement later
superseded, so those rows are re-derived on the next survey pass at that host like everything else, and the
prose that quoted an unrounded figure is gone from the tree. Nothing anchored, gated or claimed depends on them.

Also in this pass: the live verification of the depth/SNR repricing (7 of 7 rows rewritten after the deploy carry
`detectionSnr` and satisfy `snr = depth/scatter*sqrt(nIn)` at ratio 1.000; 26 of 38 pre-deploy rows still show the
old mismatch and heal as hosts are re-measured), and the honest-precision surfaces described in the entry below.
`npm test` 726/726.

### The depth on every card promised a precision nothing has ever measured (2026-10-18, fourth pass)
P90 closed with a consequence: its own measured error is of order a third, while the board and the finding card
rendered the same quantity as an integer number of ppm. This pass implemented that consequence -- and in doing so
found that the first attempt at it was wrong, in a way the repository had already answered once before.

**What was printed, and what it claimed.** `narrateFinding` wrote "the star's brightness dips by about 1200 parts
per million" and the stats row `1200 ppm (0.120%)`, while `web/app.js` rendered `Math.round(c.depthPpm)` ppm
and `c.periodDays.toFixed(3)` days on three separate surfaces. A percent to three decimals is a claim of about one
part in a thousand. P90 measured the agreement these estimators actually have with an outside catalogue at a median
33.0-44.2% depending on the arm, and `src/core/periodFormat.ts` had already ruled three-decimal periods illegitimate
for a grid node whose spacing grows as P^2 -- the narration had been fixed by that rule and the board had not been
reached. Both are now covered: depth and period each print with the uncertainty they earned, on the narration, the
finding card, the candidate card and the observe panel.

**Where the number comes from, and the mistake that got corrected.** The first version of this pass took P90's
median absolute error (37%) as the error bar. That is wrong in the direction that matters: a "+/-" is read as one
standard deviation, which covers about two thirds of a symmetric distribution, while a median absolute error covers
exactly HALF the rows -- so using the median as a sigma under-states the error by design. The repository had already
been through this: p9 (README, "Can we make the error bar honest?") found its statistical bar undercovering and
inflated it by a measured factor k = 3.2 until 68% of catalogue-matched rows fell inside. Applying the same question
to P90's own rows gives the empirical radii -- for the published depth, median 33.0%, 68% radius **48.0%**, 95%
radius 104.4%, worst row 188.9% -- and the bar the surfaces print is that 48% carried UP to one significant figure,
combined in quadrature with each record's own statistical term `1/|snr|` (which is exactly what the published
`snr = depthFrac/noiseSigmaFrac*sqrt(nIn)` relation makes it). The tail is heavy enough that nothing doubles this
bar into a 95% interval, and the value keeps its own digits rather than being re-rounded, so a card can never
disagree with the bundle it describes.

**One rule, two runtimes, enforced rather than trusted.** `src/core/depthFormat.ts` holds the reasoning for the
worker and the narration; `web/honest-precision.js` is the browser mirror, because `web/app.js` is served as plain
ES modules and `tsconfig.json` has no `allowJs`. Two implementations of one rule drift by default and the drift is
invisible, so `tests/depth-honesty.test.ts` sweeps both over every depth, SNR, period and grid resolution the
surfaces can receive and requires identical strings, pins each repeated constant to the same number, and asserts the
call sites exist in `web/app.js` -- the failure mode this project has already been audited into twice (a predicate
that matched nothing, a gate that gated nothing). It also recomputes the medians and coverage radii FROM the rows P90
committed, with statistics written independently of the report generator, and requires the report's own table and the
cited constant to agree: a hand-edited report or a re-run on a different sample now turns the suite red instead of
leaving the prose citing a number the data no longer says.

**Two defects found while building the check.** (1) The new narration said "measured on 16 confirmed planets" --
the stem `confirm` is exactly what the posting guard refuses, so the sentence would have been rejected at send time
and stopped the loop. The over-claim scan added to `tests/narrate.test.ts` last pass caught it in the generator
rather than in production, and the wording is now "planets with published transit depths", which is also the more
accurate description of the sample. (2) `scripts/p90-depth-estimators.ts` grew a `--from-json` replay mode so the
statistics above could be recomputed from the stored rows without re-fetching photometry; its first version took the
sample description (magnitude cut and period range) from the CLI defaults instead of the stored run metadata, and
silently rewrote the report to claim `P in [0.8, 15] d` for rows gathered with `P in [0.8, 8] d` -- a report that
misstates its own sampling is worse than one that omits it. Fixed to read every sample parameter from the stored
meta, and the report now carries a REPLAY line saying the photometry was fetched by the earlier run, not by this
analysis. No verdict, gate, FAP, bundle field or anchored hash moved: this is the layer that describes measurements,
not the layer that makes them. `npm test` 715/715.

**And one gap this round's own post caught.** While assembling the public summary, the link to P90's report page
returned 404. `reports/*.md` is the measurement record; `web/reports/*.html` is what a reader can open, and the two
are generated apart -- `npm run p86:report-library` had not been re-run, so a report committed, announced in
RESEARCH.md and cited in a post had no page anyone could read. Regenerated (P90's page publishes and indexes as
`verified`, i.e. reproducible from a clean checkout: 10 cited inputs, 10 re-hashed) and pinned by
`tests/report-library.test.ts`: every report in the record must have a page, the index must name every page and no
index entry may point at nothing. The same run did honest damage in the other direction: p41-longbaseline is now
flagged un-fresh because the depth/SNR fix changed `src/detect/bls.ts`, one of the inputs its stamp names. Its page
stays served and loses its verified mark -- a code change under a report must cost that report its reproducibility
claim, which is exactly what the stamp is for.

### Which depth the rig publishes is now measured, not argued (2026-10-18, P90)
The depth-adoption guard shipped two rounds ago refuses a per-sector shape fit that disagrees with the detector's
BLS box by more than 5x. The bound was set by argument ("a fit that far off is measuring something else"), and the
argument is sound -- but the same module re-prices the record's SNR when it adopts, so which estimator survives
changes BOTH headline numbers of a finding, and nothing in the repository had ever compared the two against an
outside reference. The audit that motivated the guard found 10 live adoptions and could not say whether any of them
was an improvement. That is the gap `scripts/p90-depth-estimators.ts` closes.

Method, and the parts that decide whether the numbers mean anything: the production path is replayed in order on
real light curves (`seats.scout()` at the shipped BLS settings -> `detect/perSectorRun.robustPerSectorDepth()` fed
the DETECTOR's ephemeris, never the catalogue's, since production cannot see it -> `decideDepthAdoption()` at the
shipped bound). The NASA Exoplanet Archive `pl_trandep` is consulted AFTER both fits and is a measuring stick, not
a truth either fit is allowed to see. A row only counts toward the headline comparison when the detection is
demonstrably the same transit the catalogue lists (period within 5%); the other 14 of 30 scanned rows are counted,
listed and EXCLUDED from the medians rather than quietly dropped. Of 30 bright confirmed planets, 16 qualify.

What came back (medians against the archive value): the BLS box UNDER-reads by 35.4%, the per-sector median by
26.2%; median absolute error 36.7% (box) against 44.2% (per-sector); head to head 8/16 versus 8/16, exact two-sided
sign test p = 1.00 -- the two estimators are NOT separable on this sample. What the guard actually publishes beats
both alone: 33.0% median absolute error, 11/16 rows no worse than the box. The gain is carried by the refusals
(3/3 were cases where the box really was the closer measurement), not by the adoptions -- 5 of 13 adoptions moved
AWAY from the reference. Re-running the same rows under bounds of 1.2x, 1.5x, 2x, 3x, 5x, 10x and 1000x moves the
published median absolute error by 11.8 percentage points on 16 rows against a 36.7% estimator spread, so the report
states that the shipped 5x bound is not load-bearing at this n instead of claiming it was tuned to; changing a gate
to follow a difference that small would be fitting a decision to sampling noise, which is the failure mode the
measure-before-gate rule exists to stop. The run also refuses to emit calibration numbers if the catalogue pull falls
back to the bundled sample, and self-refused once already at n = 6 before the period range was tightened.

Two limits the data imposes on the write-up, both stated in the report rather than in a caveat footnote. The archive
value is itself a fitted parameter, with its own dilution, limb-darkening and stellar-density assumptions, so these
figures bound the AGREEMENT between three reductions of the same photometry -- not the accuracy of any one of them
against the sky. And a ~37% median absolute error is not compatible with the way every surface in the project
renders the same quantity, as an integer number of ppm: that is an unearned precision claim, and it is now the next
open item rather than a finished one.

The same audit found a documentation gap beside the measurement: `RESEARCH.md`, the outward statement of what has
been measured, had never recorded P89 (multi-epoch PSF diff-imaging, committed and reporting a 2/2 false-veto rate
that disqualifies the gate) and did not record P90 either. Both are now in it, with their numbers and their
negative results. Nothing here gated, anchored, claimed or deployed; no production record was modified.
`npm test` 701/701.

### A record's own sentence described a transit that was never measured (2026-10-18, third pass)
The guard and the repricing shipped in the last two entries fixed the NUMBERS. This pass went one layer closer to
the reader and found the prose, which had the same defect and no test covering it.

`src/reporter/narrate.ts` writes every human-facing sentence in the project -- the finding card, the board, the
digest's source text. For a candidate whose BLS box landed on a BRIGHTENING (the box statistic is
`Swy^2/(Sw(1-Sw))`, sign-blind, so an anti-transit can win the period grid while `depth` and `snr` keep the sign),
it rendered: "The star's brightness dips by about **-105** parts per million once every 3.14 days -- that repeating
dip is the fingerprint of a planet crossing (transiting) the star." The critic rejected the row, which is correct;
the sentence written over it asserted a transit the detector measured the opposite of, in the one place a human
actually reads. `narrateFinding` now branches on whether a dip was measured at all: the brightening case says the
box is a brightening of N ppm and that nothing here is a planet crossing the star, the SNR sentence says "not a dip
at all (SNR -9)" instead of "weak -- barely distinguishable from noise", the headline says "No transit measured",
and the depth stat reads "no dip measured -- the box is a rise of 105 ppm". A zero depth takes the same branch: a
flat box is not a shallow transit. `web/app.js` mirrors the label so the card cannot say what the narration forbids.

Also caught in the same file, by reading rather than by a failure: `narrateRunSummary` printed "N **confirmed**" --
the exact discovery-grade word audit #3/#4 removed from the badge and the headline, and the word the posting guard
refuses. Nothing calls that function today, so the defect was latent, which is why it survived: a wrong sentence in
unwired code has no way to complain. It now says "N recovered, M needing more data", and a test scans every
narrated string (headline, explainer, stats, run summary) across all three verdicts and both depth branches for the
affirmative stems, so the guard is enforced where the words are generated rather than only where they are posted.

**The anchored bundle could not be checked from the anchored bundle.** A published record carries `snr`, `depthFrac`
and `nPointsInTransit` in its manifest, and the relation that makes them checkable --
`snr = depthFrac / noiseSigmaFrac * sqrt(nPointsInTransit)` -- needs the scatter, which was not committed; neither
were the detector's own box depth, the refused estimate, the estimator label or the search statistic. A reader of the
committed file therefore could not verify the very invariant the last two rounds established, nor see how far apart
the two measurements were. `src/bundle/bundle.ts` now writes those five fields into the manifest candidate when the
candidate has them, and EXCLUDES them from `scienceProjection` via `PROVENANCE_ONLY_CANDIDATE_KEYS`: the commitment
carries what an auditor needs, while the content address stays the address of the published science. That separation
is not cosmetic -- folding the new fields into the address would give two runs of identical published numbers
different `scienceHash`es and re-open the dead-dedup bug that once cost three mainnet fees for one detection
(audit-3 P0-B, and the live HR-858 b/c/d trio). `tests/core.test.ts` pins both halves: identical science under
different provenance keeps one content address (and one legacy fallback address), the manifest hash does differ, and
a candidate without the diagnostics produces the old manifest shape, so nothing already anchored is re-priced.
`tests/live-data-regression.test.ts`, which drives the real captured manifests, stays green -- the projection is
byte-identical for existing records.

No verdict, no gate, no FAP, no anchor and no already-committed address moved. `npm test` 701/701.

### The depth guard's own fix was audited, and it had left the defect class in place (2026-10-18, second pass)
The entry below was committed at 06:21Z and went live at 06:31Z. Re-running the same third-party question against
the rig an hour later returned a worse answer than the one that motivated it.

`applyDepthDecision` kept `depthPpt` and `depthFrac` in step and capped the swap at 5x -- and every record that
used it still published a depth its quoted SNR did not describe. Sampled `/api/findings` at 06:52Z: **10 findings
had adopted a per-sector refinement, and 7 of them quoted a significance belonging to the box rather than to the
depth they published** (TOI-1978.01:
published 2784 ppm beside SNR 108.7, which on the record's own 974.7 ppm scatter over 106 in-transit points is the
significance of a 10287 ppm depth; the published depth's own SNR is 29.4). Capping the swap had made the
contradiction smaller without removing it, because swapping a depth silently re-prices the record: `snr` is not an
independent measurement, it is `depth/sigma*sqrt(nIn)`, and sigma and nIn are properties of the fold.

Two more live cases closed the remaining holes. TOI-1487.01 and TOI-1689.01 are records where the BLS box landed on
a BUMP (depth -104.92 ppm and -207 ppm; the box power statistic `Swy^2/(Sw(1-Sw))` is sign-blind, so an inverted
feature can win the period grid, while `depth` and therefore `snr` keep the sign). Both were rejected by the
physical-sanity and SNR floors -- the correct outcome -- but the first version of the guard handed them the shape
fit's positive depth anyway, publishing "a 46 ppm dip" for an anti-transit while still labelling the record's
`depthSource` as `bls-box` -- a label that contradicted the number beside it. A non-positive box now forfeits
adoption outright: with nothing to refine, nothing may be substituted.

The decision is therefore applied as a SET. `depthFrac`, `depthPpt`, the estimator label, the refused estimate and
the SNR recomputed for the depth actually published all move together, and the search's own statistic is preserved
as the new `detectionSnr`. The `>= 7` floor and the calibrated false-alarm ensemble read `detectionSnr`, because
both are distributions of the box statistic -- feeding them a shape fit's re-priced SNR would be a unit mismatch.
So no verdict and no FAP moved: measured on the live set, gating on the published depth instead would have pushed
3 records (GJ 341 b at 7.4 -> 1.7 among them) under the floor, which is a calibration question this round refused
to answer on 10 records. The critic's `snr` check now states both numbers when they differ, and its informational
depth-vs-significance check can no longer fire on a new record by construction -- it exists to catch a future path
that replaces a depth without going through the helper.

`scripts/xpost-health.ts`, the posting auditor, was also found wrong by its own production log: the npm runner
prefixes a child tool's stderr with `<script-id> stderr: `, so the anchored match for `x-last-post: wrote N
already-reported subject(s)` never fired, `alreadyReported` stayed null, and the backlog rule could not fire in
either direction -- it was reporting both "no stall" and "not a stall" while measuring nothing. Heartbeat was
likewise flagged as missing although it is a fallback that must not run when another tier had content. Both fixed,
with a test that parses a line copied out of the real job log, and the tool gained an npm entry point (`x:health`).
Forward evidence, sampled from production logs of the 8h window ending 06:48Z: 19 confirmed posts across 23 runs,
tiers note=6 and blind=4, no frozen backlog and no unreported residual; 2 findings remain, both the same historical
REFUSED override run.

Live effect of the pair fix, measured at three samples of the same endpoint: findings carrying a disagreeing
`depthPpt`/`depthFrac` pair went 84 of 90 (05:53Z) -> 80 of 94 (06:35Z) -> 72 of 94 (06:52Z) as targets are
re-measured by the deployed code. All 72 remaining are rows written before the guard; none of the 16 re-derived
rows claims an anchor stamp whose ledger entry does not match its current bundle hash (checked against
`/api/ledger`), so a re-measured record cannot borrow an old commitment. The bundles already committed on-chain
keep the bytes they were committed with, contradiction included -- the counts above are the disclosure.

### A record published a transit depth its own signal-to-noise ratio refuted (2026-10-18)
The third pass of the audit loop asked the live rig a question its tests could not answer: inside a single
published finding, do all the numbers describe the same transit? They did not.

`src/core/types.ts` documents `depthPpt` as the transit depth in parts-per-thousand and `depthFrac` as the same
depth as a fraction, and `src/detect/bls.ts` writes them as exactly that pair (`depthPpt = depthFrac * 1000`).
`src/cf/workflow.ts` then replaced one of them: when `PERSECTOR=1`, the robust per-sector limb-darkened shape fit
assigned `det.candidate.depthFrac = est.medianDepthFrac` and left `depthPpt` holding the detector's box depth.
Measured on the live rig: **84 of 90 findings carried a pair that disagreed**, 82 of them by more than 5%, and
8 of the 15 accepted ones by more than 1.5x. That is not a formatting slip -- it is two measurements of different
things occupying the same quantity.

The worst row is the one that proves the direction. KELT-24 b is a catalogued hot Jupiter, so its depth is known
independently of us. The record carried a box depth of 6100 ppm and a published depth of 38 ppm, 160x apart.
Its quoted SNR of 252.5 over 40 in-transit points is `depth/sigma*sqrt(nIn)`, which closes on 153 ppm of
per-point scatter for the 6100 ppm depth -- ordinary for a TESS bright star -- and on 0.96 ppm for the 38 ppm one,
below the instrument's photon floor. The record contained its own refutation, and the public finding card read
"the star's brightness dips by about 38 parts per million" about a transit two hundred times deeper. The same
pattern held for TOI-1431 b (57x), HD 202772 A b (29x), TOI-588.01 (14x).

Two changes, and deliberately no third. `src/detect/depthAdoption.ts` now decides the adoption: a per-sector fit
is accepted only when it agrees with the box depth within `DEPTH_ADOPTION_MAX_FACTOR` (5x, symmetric), and
otherwise the box depth -- the number the detection was gated on and the SNR computed from -- is kept, with the
refusal and its factor logged to the event stream. An estimator that disagrees by two orders of magnitude is not
refining a measurement, it is measuring something else (a drifting ephemeris across sectors, a diluting blend, a
fit onto noise), and the conservative failure mode is the depth whose detectability was actually proved. The
record keeps BOTH estimators (`blsBoxDepthFrac`, `perSectorDepthFrac`, `depthSource`), and the only writer of a
revised depth is `applyDepthDecision`, which updates both representations together -- so the pair cannot drift
again and a reader can still see what was refused. The critic gained `depth-vs-significance-consistency (informational, non-gating)`, which
inverts the SNR formula and states the disagreement in ppm -- non-gating by name, so `scienceProjection()` drops
it and no already-anchored science re-prices. What this round did NOT do is re-gate anything on depth: verdict
semantics move only with a calibration run, and the honest number of anchors whose published depth this guard
would have refused is a measurement still to be made.

Old records stay exactly as they are, including the inconsistency, because an anchored bundle must remain
replayable byte-for-byte: deriving `depthPpt` at publication would have silently changed historical content
addresses, which is a worse offence than a disclosed one. The fix is forward-only and the historical count above
is the disclosure.

Also from the same pass, in the freshness gate that decides whether a report may be quoted: `verified` had meant
"a checksum was recorded" rather than "a checksum was compared", so three of the four reports the site called
machine-verified were verified only on the workstation that generated them -- their stamps point at
`out/scaled/*.jsonl`, which is gitignored and exists on no other checkout. `verified` now requires a recorded
checksum re-hashed against a file the REPOSITORY CARRIES, `fullyVerified` requires every one of them, and a
report whose inputs were only partly checkable says which paths could not be re-hashed instead of claiming a
clean bill. The published count fell from 4 to **1 of 48** -- only `p59-offtarget-subset`, whose three inputs are
all tracked files, survived the stricter definition -- and the downward correction is the point: a gate that
over-counts is worse than a smaller number that is true. Raising it legitimately means re-running a generator so
the stamp comes from the run itself, which is what p41 did: re-measured against the live archive and SPOC files, it
reproduced its twelve published completeness figures **byte-for-byte** (`reports/p41-longbaseline.md` came back
unchanged), and its report page is now the second one a stranger can re-hash end to end -- 2 of 48.
`scripts/p41-longbaseline.ts` gained the JSON artifact and freshness stamp its twelve published completeness
figures never had, re-measured live rather than transcribed.

**A rehearsal of an alarm must not wear the alarm's shape.** `npm test` printed
`FAIL gaia-tap missing columns: parallax` and `VERDICT: FAIL -- 1 upstream(s) drifted schema / row-count ... Open an
issue`, and this audit nearly filed an upstream-drift report against a healthy Gaia endpoint. The lines came from
the live-probe's own offline positive control: a synthetic drifted row fed to `evaluate()` to prove the exit-code
wiring still trips (it does, and the probe is what caught the 22-hour freeze). The wiring was right; the log was
illegible. `evaluate()` now tags every line it prints in self-test mode with `[drill]`, the live path keeps its
untagged shape -- tagging a real alert would blunt the thing it exists to raise -- and a test pins both halves so
the rehearsal cannot quietly become indistinguishable from the event again.

Gates: 686 tests pass (+21 over the 665 that shipped the period fix), `typecheck:all` and
`eslint --max-warnings 0` clean, the new `tests/repo-hygiene.test.ts`
makes the English-only rule CI-enforced over 562 human-readable files instead of a gitignored scratch script,
and `tests/depth-adoption.test.ts` + `tests/report-freshness.test.ts` pin both corrections in each direction.

### The feed published a period precision the search never had, and named the weakest candidate as the example (2026-10-18)
A third-party-perspective audit of the rig's own OUTPUT (not its tests) found two public-claim defects, plus one
in the audit tooling itself. Both defects were measured before being fixed.

**A grid node is not a measurement.** `src/detect/bls.ts` reports `periodDays = 1/(fMin + k*df)` -- a discrete
trial-grid node, with no continuous period fit anywhere in the path. Node spacing grows as P^2 (dP = P^2 * df), so
hundredths of a day are genuine at P=2 d and fiction at P=16 d. Everything published a fixed precision anyway: the
feed and `src/reporter/narrate.ts` used `toFixed(2)`, and the frontend stats table used `toFixed(4)`. Measured: 3
of 90 live findings sit at `periodDays` exactly `16.000000`, which is the k=0 node of the 16-day maximum
`src/seats/seats.ts` scouts to -- a peak ON the boundary is the search running out of range, not a detection at
that period. One of the three (TOI-588.01) had already been announced on the feed as "P=16.00d", a claim of
+/- 0.005 d where the grid step is about 1.2 d. The detector now records `periodResolutionDays`,
`searchMaxPeriodDays` and `atSearchBoundary`; `src/core/periodFormat.ts` renders a value against its uncertainty
(one significant figure on the uncertainty, value matched to it, and a conservative shortest-plausible-baseline
bound for older records, which can only ever under-claim); every surface now says "at least 16 days (the search
limit)" where that is what is known. The critic records it as an explicitly NON-gating check, so the fact enters the
bundle commitment while `scienceProjection()` drops it -- the content address, and every already-anchored science,
is unchanged and nothing re-prices. No verdict semantics moved: gating on the boundary would need its own
calibration run, and this is a reporting fix.

**"e.g." implies representative, so name the strongest.** The blind tier chose its example as the NEWEST candidate
in the window. The newest row is not the best-supported one: in practice it could be a candidate the rig's own
targeted re-injection recovered 0 out of 8 times, while a 7/8 candidate in the same batch went unmentioned -- and
the recovery figure was never in the post at all. The example is now chosen by strength of evidence and published
with its recovery count, so the reader who follows the named target sees the number the rig itself saw.

**An audit that greps a log is unsound when the log contains the audited content.** The new
`scripts/xpost-health.ts` reads job LOGS rather than run conclusions, because a run can be completed/success while
posting nothing and completed/failure because the honesty guard refused text. Its first output was a false alarm it
had to be fixed for: it reported "DRY RUN in production -- credentials missing" for a run that had in fact posted,
because the summary it pushed contained the words "prints DRY RUN" and the workflow echoes post bodies into the
log. Status signals are now anchored to the emitting tool's own prefix, and a DRY RUN that contradicts a confirmed
post is treated as content. The same pass corrected a backlog rule pointed the wrong way: `build-note backlog: N`
counts subjects in the window INCLUDING ones the feed already announced, so a non-zero N is not by itself a stall --
the sound test is the residual against the already-announced count. Both directions are pinned by fixtures, along
with a healthy-window case, so the tool cannot earn a clean verdict by never reporting anything.

**Which tiers POSTED is not which tiers were ATTEMPTED.** Nothing in the log distinguished "this tier had nothing
honest to report" from "this tier was never run" -- the same blind spot behind the 22-hour survey freeze recorded in
HANDOFF. `x-post.yml` now echoes a per-tier manifest on every run, and `verify-xpost-shell.sh` extracts the real run
block and asserts the manifest appears and names all five tiers.

Live while writing this: `surveyPass` advanced 50 -> 51, so the rig is not frozen; three separate runs posted two
items in one run.

### The project's one hard external rule had no gate, and the report library's machine-verifiable coverage was measured (2026-10-18)
The second pass of the same audit loop looked at the repository rather than at the feed, at two questions a stranger
could ask about it.

**"Everything published is English" was a preference, not a check.** It was policed only by a scratch script under
`out/`, which is `.gitignored`: CI never ran it and a fresh clone could not reproduce it. The gap is not theoretical.
While writing the HANDOFF pitfall recording this audit, two Chinese characters went into `HANDOFF.md` and were caught
only by re-reading the diff. `tests/repo-hygiene.test.ts` now walks the working tree (skipping generated and
unpublished directories), scans 562 human-readable files for CJK/kana/Hangul/fullwidth forms and for PEM private-key
headers, asserts both sets are empty, and includes a self-check that the detectors FIRE -- a scanner whose regex never
matches would otherwise report green forever. On its first run the gate scanned its own test fixture and flagged it as
committed key material; correct behaviour for a scanner, so the fixture was changed rather than the file exempted, since
an exclusion list is exactly the hole a secret scanner needs to grow.

**Report artifacts: measured, then stated.** The site publishes 48 reports. All 48 have a served HTML page and an
`index.json` entry, and no page is orphaned. 47 machine-readable JSON artifacts exist; 45 pair with their prose by
slug, and two of the three remaining mismatches are deliberate and documented -- `p33-catalog.json` is the per-star
recovery catalog downstream scripts re-fit from (`p34`, `p35`, `p37`, `p38` read it by that name) and
`p39-candidates.json` is the candidate list, so both are named for their role, not for their page. One is not:
`reports/p41-longbaseline.md` publishes twelve completeness figures and its generator (`scripts/p41-longbaseline.ts`)
writes only prose, so that page is the one report whose numbers cannot be machine-checked at all. The honest reading
of the freshness gate is the same shape: of 48 published reports, 6 carry a provenance stamp and only 4 are
re-hashed against their inputs, so 44 pages carry the amber "provenance not machine-verifiable" note. That note is
accurate and already on the pages, so this is a disclosed limitation, not a hidden one -- but closing it means
RE-RUNNING the generators under stamping. A stamp written after the fact records when it was typed, not what the run
read, which is the one thing the gate exists to prove; retroactive stamping would be fabrication dressed as
provenance and is explicitly rejected as a way to raise the ratio.

### devlog/ archives what was pushed to the feed, and the un-rationing proved itself live (2026-10-18)
Three long-form operator summaries are now archived in `devlog/`, each composed by `scripts/devlog-archive.ts`
from the SAME BYTES handed to the dispatcher rather than re-typed, each carrying its dispatch evidence: the HTTP
204, the Actions run, the posted tweet id, the job-log line proving the send, and the pre-flight result. A
re-typed copy drifts -- a softened number, a dropped hedge -- and a drifted archive is worse than no archive
because it looks authoritative. `tests/devlog-archive.test.ts` runs that CLI over fixtures (exact output bytes,
CRLF normalisation, both refusals, missing-argument and empty-text handling) and then asserts the send path's own
red lines over every entry already committed, so `devlog/` cannot grow into a record of things never said.

The un-rationing recorded below then proved itself on the live feed, not only in the rehearsal harness. Run
39095577800 at head `d3314084` posted TWO items in one run: the science tier (id 2111668756908790082) and the
build-note tier (id 2111668780724027403), five seconds apart, oldest item first, under a runaway ceiling of 25.
Before commit `c9684ff` that run could have published at most one of them, and the build note only if the science
tier had nothing to say. The build note's bullet was the `docs(devlog):` commit itself, which the old filter
discarded outright.

Also corrected two stale claims in HANDOFF section 5 that would have cost a successor time: `npm test` runs
`tsx scripts/run-tests.ts`, which discovers every `tests/*.test.ts`, so there is no hand-maintained list in
`package.json` to update; and `x-post.yml` is now named in the layout section, because a workflow with no push
trigger that publishes publicly is exactly what that section should list. A count of test files was deleted
outright rather than refreshed -- a number that goes stale on every commit is worse than the fact that matters.

### An unpostable commit subject would have stalled the build-note cursor permanently (2026-10-18)
Found by the honesty guard refusing a text I authored for the feed: `post-x-text.ts` runs `overclaimViolations`
over the FINAL text of every post -- override included -- and exits non-zero on a hit. Combined with the posting
loop's break-on-failure (correct: the cursors are read off the feed, so continuing would advance them past an
unsent item), one subject carrying a stem like `first` / `novel` / `confirm` would poison its entire batch for
good. Every window would re-compose the same note, be refused, and the backlog would never clear -- the exact
starvation the un-rationing recorded below was meant to end, reintroduced through the guard that keeps the feed
honest.

`classifySubject` (the reason-reporting form of what was `sanitizeSubject`) now drops any subject whose bullet
would trip the net, and `rejectedDevSubjects` lets `main()` log each drop with its reason to stderr, so a commit
the feed is silent about is explainable from a job log rather than invisible. Hedged subjects survive: the drop
targets affirmative wording, not the vocabulary, so `fix(p57): do not confirm a candidate from one sector` is
still reported. Measured before fixing: 0 of the last 201 commit subjects carry a stem, so this was latent rather
than active -- but `\bfirst\b` also matches inside a hyphenated `oldest-first`, which is ordinary phrasing, and
the deadlock has no self-healing path. Pinned by an invariant test over every stem the guard knows plus the
red-line vocabulary: no combination of subjects may compose a note that would be refused.

Also corrected a now-stale comment in `src/cf/worker.ts`: the dispatch wake it performs feeds a workflow with
three per-tier cursors, not one anchored to "the last ACTUAL post". Comment only; no behaviour change.

The pre-flight for any authored text is now recorded in HANDOFF as a command that exists in the repository:
`npm run x:post -- --text-file <path> --max-len 25000` with no `X_*` credentials in the environment runs the full
ASCII + length + over-claim validation and prints `DRY RUN`, sending nothing. It is the same code path the
workflow uses, so it cannot disagree with production -- unlike a local mirror of the red lines.

### The X posting path rationed itself to one tweet per window; that ration is removed (2026-10-18)
Four separate limits capped how much the rig published. None of them came from X, from the API, or from any
honesty red line -- they were all volume guesses I baked in while trying to avoid looking like a spam account.
The effect was that reportable work was silently discarded: the operator's instruction was that budget is not the
constraint and anything worth reporting should be posted.

- **At most one post per window.** `composeDigest` walked its tier list and returned on the FIRST tier with
  something to say, so a window holding both a surviving blind candidate and forty unannounced commits published
  one of them.
- **The science tier suppressed the build note.** The workflow only composed a build note
  `if [ ! -s out/digest.txt ]`, i.e. development progress was reportable exactly when nothing scientific happened.
- **`head -5`** truncated the commit backlog to five subjects and dropped the rest with no log line saying so.
- **`grep -Eiv '^(chore|docs?)(\([a-z0-9-]+\))?:'`** discarded every `docs:` commit outright. Documentation is
  work; filtering it made the feed understate what shipped.

What replaced them: `composeDigest` gained an `only` tier selector (`ledger` / `blind` / `milestone` / `science` /
`build-note` / `heartbeat`; absent keeps the historical first-match behaviour, so every existing test and caller
is untouched). The workflow now asks tier by tier into `out/posts/*.txt`, batches the commit backlog oldest-first
with `split -l $DEV_BATCH`, and a loop posts every composed item. Rehearsed against the real repository state: a
42-subject backlog composed into 2 build notes (2718 and 1860 bytes) and posted both in one run, where the same
backlog previously yielded at most one note of five subjects and only if the science tier was empty.

**Multi-posting introduced a new defect of the same class, fixed here rather than shipped.** With one post per
window, anchoring the science cursor to "the newest tweet of any kind" was safe. With several, a build note
posted later in the SAME run became the newest tweet, so the next window's science cursor was pushed past the
moment the science data had been fetched -- any finding produced in between would never be reported, which is
precisely the starvation the previous entry fixed for the dev tier, mirrored onto science. There are now THREE
cursors read off one page of the feed: `last_science` (newest tweet that is neither a build note nor a heartbeat,
via `newestScienceAt`; `HEARTBEAT_HEADLINE` is exported from `science-digest.ts` so composing and matching cannot
drift), `last_build_note`, and `last_post` (silence measurement for the heartbeat only).

Two supporting changes keep "report everything" from turning into "report things twice":

- The dev window starts `DEV_OVERLAP_MIN` (10) minutes BEFORE the last build note. Without overlap a commit
  landing mid-run sat behind a cursor already set to the posting instant. Overlap re-reads commits already
  covered, so `x-last-post.ts` also grew `reportedSubjects()`, which lifts the bullet lines back out of the
  feed's own build notes and feeds them to `composeDigest`'s new `alreadyReported` exact-string de-duplication.
  A test round-trips a REAL composed note through that path and asserts the backlog composes to nothing the
  second time while a genuinely new subject still gets reported.
- Batching is **oldest-first** (`tac`) because the posting loop BREAKS on the first failure. Newest-first would
  leave unsent NEW commits behind an advanced cursor, losing them permanently; oldest-first leaves them ahead of
  it, so the next window picks them up.

Kept deliberately, because these protect the feed rather than ration it: sha256 dedupe of byte-identical items
within a run, `MAX_POSTS_PER_RUN=25` as a runaway brake (the loop warns and leaves the remainder ahead of the
cursors), and `POST_DELAY_S=5` between posts so a large backlog cannot trip X's rate limits. `timeout-minutes`
5 -> 15, since 5 was sized for a single post. `DEV_BULLETS_MAX=40` stays in the composer as a safety net, and a
test reads the workflow YAML to assert `DEV_BATCH <= DEV_BULLETS_MAX` so the net can never silently bite.
`DEV_COMMIT_EXCLUDE` now defaults to `^chore\(deps` only (dependency-bot noise) and can be set empty to report
everything.

Volume numbers are all plain `env` values. There is no per-window post cap left to find, and a test fails if
`head -5`, the `digest.txt` suppression, or the `docs:` filter ever returns.

### A stage summary can now be pushed straight to the feed, and one was (2026-10-18)
The `workflow_dispatch` override (`inputs.text` -> `OVERRIDE_TEXT` -> `npm run x:post --max-len=25000`,
short-circuiting every tier) was already the right channel for publishing an operator-facing summary of what
changed, rather than only describing it in conversation. Used for real: the pipeline-change summary was
pre-flown locally for ASCII-only bytes, the spend/time/discovery red lines, and length, then dispatched
(`204`) and posted as id `2111641428334149796`. One item was deliberately held back from that text -- the claim
that the posting limits had been removed -- because the change had not been made yet; it is true as of this
entry, not as of that tweet.

This is now a durable practice rather than a one-off: `devlog/` archives each long-form summary that was actually
pushed, with its dispatch evidence (run id, posted tweet id, the job-log line proving it went out, and the
pre-flight result), so a public post can be audited against the commits it describes. `scripts/devlog-archive.ts`
composes each entry from the SAME BYTES that were handed to the dispatcher -- normalising CRLF to LF the way the
dispatcher does -- instead of a re-typed copy, and refuses to write an archive holding a code fence (it would
truncate silently) or a non-ASCII byte (post-x-text.ts would never have sent it, so the archive would be a
fabricated record). `tests/devlog-archive.test.ts` runs the script for real over fixtures and then asserts the same
red lines over every entry already committed, so devlog/ cannot drift into holding text that could never have been
posted. Two entries are archived, covering both summaries pushed here.

No test covered the workflow's shell path, which is how the limits above survived in the first place.
`scripts/verify-xpost-shell.sh` now EXTRACTS the real `run:` block from the YAML with awk and executes it with
`npm run x:post` and `curl` stubbed (the stubs need `export -f`; the block runs in a child bash), asserting that
nothing reaches X, that every recorded item is non-empty ASCII within the ceiling, that both cursors and the
backlog count are echoed, and that the script reaches its summary line. A mirrored copy of the logic can no
longer pass while the shipped file is broken. `SHELL_LOGIC_PASS`. 614 tests pass (was 602).

### The X digest's build-note tier was starved by its own science tier (2026-10-18)
Both tiers shared ONE window start, anchored to the newest tweet of any kind. That is correct for science (a
result must not be re-reported) and fatal for build notes: the dev tier is reached only when a window has no
science, so every science post advanced the shared cursor past commits the dev tier had never reported, and they
were dropped for good. Read out of the production job logs, a push of five commits produced exactly one build
note covering one commit -- the 16:00:34Z run posted 3 new UNCONFIRMED candidates and thereby consumed
`39177d1` and `bb1dfe6` without ever announcing them; the 16:37:02Z note covered `d17b032` alone; `33e8758`
and `65193ca` are `docs:` and are filtered by design. Two shipped fixes went unannounced and nothing on the feed
indicated they had been skipped.

Fixed by splitting the cursor, from the same single X read:

- `scripts/science-digest.ts` exports `BUILD_NOTE_HEADLINES` as the single source of truth. `pick()` rotates the
  headline, so a note is identified by MEMBERSHIP in that list, not by one hardcoded string -- composing and
  matching can no longer drift apart silently.
- `scripts/x-last-post.ts` now reads `created_at` AND `text` over the largest legal page (100; a build note is
  rare and a 5-tweet page covers well under an hour of this feed, so it would almost never contain one and the
  dev cursor would silently degrade back to the shared one), adds `isBuildNoteText` / `newestBuildNoteAt`, and
  prints two LABELLED lines. The labels are load-bearing: the workflow pulled the ISO with
  `grep -Eo <ISO> | tail -1`, which would hand the dev tier's time to the science window, or the reverse, the
  moment a second timestamp appeared on that stream.
- `.github/workflows/x-post.yml` parses both labels (tolerating the previous bare-ISO shape so an older ref still
  yields a usable science cursor), derives `DEV_SINCE` from the newest build note, else a bounded look-back
  (`BUILD_NOTE_LOOKBACK_H`, default 48h) so a starved backlog is still reported once -- still batched by
  `head -5`, never per-commit, still at most one post per window. The cursor is logged on EVERY run rather than
  only inside the no-science branch, so it is verifiable from a job log where science wins and the dev tier is
  never reached.

No test covers the workflow's shell path (CI-only -- the same blind spot that previously shipped a pipefail abort
and an illegal `max_results` undetected), so `scripts/verify-xpost-shell.sh` exercises the label parsing, the
legacy branch, the read-failure degradation and the `DEV_SINCE` derivation directly: `SHELL_LOGIC_PASS`. Added
tests pin
every headline `composeDigest` can emit as recognised, a REAL composed note round-tripping through the matcher,
science / heartbeat / blind-candidate posts NOT matching (or the dev window would jump forward and re-starve the
tier), the two cursors differing on a realistic page, and the `tweet.fields` / page-size shape. 602 tests pass.

Verified live rather than assumed: the first run on the new workflow (01:30:19Z, head `e1c3c44`) logged
`build-note cursor: dev window since 2026-10-17T16:37:02Z`, i.e. it found the previous build note roughly nine
hours back on the real feed -- matched by `isBuildNoteText` against actual tweet text, not a fixture -- then
composed and posted a note for the fix itself (`OK posted (id 2111630997347602591)`).

Residue deliberately NOT rewritten: `39177d1` and `bb1dfe6` remain unannounced. Backfilling them would require
an explicit dispatch override and would re-report two commits that were already covered, which trades one
honesty property (nothing skipped) for another (nothing reported twice); the fix is forward-looking.

### Audit-6 re-check: the freshness gate itself had two false-positive bugs, and report order was not reproducible (2026-10-17)
Re-verifying the audit-6 remediation end to end (rather than trusting it) found five defects, two of them IN
the gate that was added to stop stale numbers -- so they were fixed, not worked around with `--allow-stale`.

- **CRLF false positive that blocked deploys** (`scripts/report-freshness.ts`). The CI bot published
  `reports/p59-offtarget-subset.json` from LF bytes; on a Windows checkout (`core.autocrlf=true`) the tracked
  `src/data/*.ts` inputs materialise as CRLF, so hashing raw working-tree bytes declared a report the bot had
  just written to be HARD-STALE and p86 exited 1 -- while `git show HEAD:<path>` was byte-identical to the
  recorded stamp. `sha256File` now normalises CRLF/CR to LF; binary (a NUL in the leading 8 KiB, exactly git's
  own test) is hashed untouched. Measured before switching: raw flagged 2 inputs stale, normalised flagged 0,
  and every previously recorded stamp still matched, so nothing was invalidated.
- **Hash-less input declarations were silently dropped.** `p79-benchmark.json` declares its inputs as bare path
  strings; the strict filter discarded them, so the report looked fully verified when nothing about it could be
  checked. They now become `{path, sha256: null}` and the verdict SAYS they cannot be re-verified instead of
  returning an empty reason list that reads as "checked and clean".
- **Non-deterministic catalog order churned report bytes** (`src/data/exoplanetArchive.ts`).
  `fetchConfirmedPlanets` sorted by `sy_tmag` alone; every planet of a host shares a magnitude, so they all tied,
  and a stable sort preserved whatever order TAP returned (the SQL has no ORDER BY -- NASA's WAF rejects the
  clauses needed). The bot's Roadmap-5 commit shows p60 publishing HR 858 c/d and HD 25463 b/c swapped over an
  UNCHANGED catalog. That churns the bytes of every per-planet report and so invalidates the sha256 other reports
  record for them: left alone it would have made the gate above flap stale forever. Ties now break on `pl_name`
  then `pl_orbper`, by plain code-unit comparison -- not `localeCompare`, whose collation depends on host ICU
  data and would only trade one platform dependence for another.
- **Never publish an unreachable build SHA.** `web/reports/index.json` recorded the HEAD at build time under the
  plain name `gitSha`; because the artifact is built, then committed, then deployed, that value necessarily
  trails `/health.gitSha` by one commit, and after an amend it named a commit that was never pushed at all
  (`merge-base --is-ancestor` exit 1). Renamed to `builtAtGitSha` with a `shaNote` stating the trail and pointing
  at `/health.gitSha`; an invariant test now fails if the published SHA is not an ancestor of HEAD.
- **"stamped" was being read as "machine-checked", overstating verification.** `evaluateAgainst` set
  `stamped` from the presence of a `generatedAt` timestamp alone, so a report carrying a timestamp but ZERO
  input checksums counted toward the published "6 stamped" as though the gate had re-hashed something. The
  published p88/p89 artifacts are exactly that shape -- both generators grew the `buildStamp` wiring in
  `19251cb`, after those artifacts were written, and neither has been re-run since. The honest reason string
  ("stamped but records no input checkpoint to re-verify") was computed and then DROPPED: it reached neither
  `index.json` nor the fragment, because only hard-stale reports got a banner. This is the p79 bare-string
  false comfort one level up. Added a separate `verified` flag (true only when at least one recorded checksum
  was re-hashed and matched), published per report and in the aggregate, and surfaced the dropped reasons as
  an AMBER "provenance not machine-verifiable" note on the fragment plus a list badge -- amber, not red, and
  explicitly not a build failure, because these numbers are unaudited rather than known-wrong. The honest
  count is 4 verified of 48, not 6 of 48; `stamped` keeps its old meaning so no consumer is silently
  reinterpreted. Re-running p88/p89 to earn real stamps would change published science numbers, so it is
  left as an explicit decision rather than done as a side effect of a build fix.

**Measured coverage of the gate, stated plainly because the mechanism existing is not the same as it
covering anything.** Of the 48 published reports: 4 carry re-hashed input checksums and are genuinely
verified (p59, p82, p84, p85); 2 carry a timestamp and zero checksums (p88, p89); 41 carry no stamp at
all. Seven generators call `buildStamp`, so three reports (p81, p88, p89) would earn a real stamp from a
re-run alone -- but each is a network run that rewrites published numbers, and p89 has no cache and writes
straight into `reports/`, so none is safe to re-run opportunistically. The remaining 40 need their
generator wired first. The gate is non-blocking for those by design (failing the build for 44 legacy
reports would be a false-positive machine), so the honest state is: the alarm is proven to ring, and it
currently watches 4 reports -- with the other 44 saying so on their own page rather than sitting silently
inside a count that reads as checked.

Tests 586 to 598 (+7 freshness, +2 tap, +1 reachability invariant, +2 verified-vs-stamped); `typecheck:all` and
`lint --max-warnings 0` exit 0; p86 publishes 48 fragments, 4 verified, 6 stamped, 0 stale, exit 0 -- where it
previously exited 1 on a false positive. Deployed and verified live: `/health` gitSha equals HEAD,
`freshness.stale` empty, P81 free of the stale `contradictions (4)`, P84/P85 showing the corrected-sky figures,
and `stats.surveyPass` at 24 against the review's snapshot of 17 -- the claim-time cursor advance holding in
production.

### Audit-6 remediation: RA-unit re-run, a report freshness gate, and coverage for the frozen path (2026-10-17)
The sixth review's central finding was the same failure class in a third domain -- round 1 "computed but not
anchored", round 4 "deployed but not in effect", this round "fixed but not re-run, re-run but not published".

- **Right-ascension unit bug blast radius + re-run.** `parseRa` returned sexagesimal hours as degrees (fixed
  `d306ce6`); production `src/` never referenced it, but research scripts did, and P82's centroid probe wrote
  the checkpoint P84/P85 read. Re-ran the offline P82(aggregate)/P84/P85 on the corrected sky and refreshed
  every figure: pixel-only quantities moved slightly (testable 109 to 114/500, known-planet false-reject 1/53
  to 2/55); the Gaia-derived ones were re-measured and are the honest ones now (blend caught 0/59, a neighbour
  explains the mean 49/52, viableNeighbours 52). README "Capability boundaries" states which class is which and
  WITHDRAWS the old 0/56 / 54/56 as wrong-sky. P59/P81/P82 re-runs (commits `55f4cee`/`22e491d`/`7c0bbc5`) are
  entered in the ledger for the first time.
- **Report freshness gate** (`scripts/report-freshness.ts` + `p86-report-library.ts`): regenerated reports now
  stamp `generatedAt` + git SHA + `inputs:[{path,sha256}]`; before publishing p86 re-hashes each recorded input
  and, on a mismatch, marks the fragment RED, flags it in `web/reports/index.json`, and exits non-zero so a
  deploy refuses to ship stale numbers -- closing the "public site serving a superseded figure" class (the P81
  `contradictions (4)` staleness). `tests/report-freshness.test.ts` proves the alarm offline. Wall-clock
  heuristics were tried and rejected for false-positives on unrelated edits.
- **run-mutex behaviour test** (`src/cf/run-mutex.ts`): the claim/advance/finish decisions that froze the
  survey for 22 hours (and had zero coverage, because `RigStateDO` imports `cloudflare:workers` and cannot be
  loaded by the Node runner) are extracted into a pure module the DO now delegates to. `tests/run-mutex.test.ts`
  drives PRODUCTION logic: the rotation claim advances the cursor exactly once, a live claim returns 409, a
  stale claim is taken over, and a zombie finish cannot release a successor's slot.
- **Survey-progress assertion in the weekly live-probe**: between consecutive runs `surveyPass` MUST increase
  and `distinctHosts` MUST NOT decrease, else FAIL + open issue (previous sample carried across runs via Actions
  cache). The freeze is now caught by a gate, not by "the feed stopped posting". `judgeProgress` + exit wiring
  verified offline (`tests/live-probe-drill.test.ts`, `--self-test`).
- **P88 framing**: retitled and headlined to state it measured independent-instrument COVERAGE (Gaia present
  6/17, period-matched 0), NOT a Gaia-vs-TESS crossmatch -- the 2x2 is all-zeros by construction.
- **Output-level over-claim net** (`overclaimViolations` in `science-digest.ts`): since the per-post
  `discoveryClaim=false` stamp was removed, a hedge-aware scan now runs on the FINAL string -- as an offline
  assertion across every tier AND a runtime refusal in `post-x-text.ts` that blocks any affirmative
  discover/confirm/first send.

Full suite 586/586 green; `npm run typecheck:all` + `npm run lint --max-warnings 0` + `node --check web/app.js`
exit 0; all touched files byte-level ASCII. No discovery claimed; no historical bundle/science hash or anchor
changes (none of this reaches the manifest).

### Frontend: four new/expanded read-only views over already-published artifacts (2026-10-17)
The hash-routed SPA gained four views that surface more of the rig's own output, all served from build-time
static assets under web/ -- no new Worker route, no Durable Object, pipeline or bundle/science-hash change.
(1) Reports: scripts/report-md.ts renders the committed reports/*.md through an escape-first Markdown-subset
renderer, and scripts/p86-report-library.ts distills them into web/reports/index.json plus one HTML fragment
per report (46 fragments); the view lazy-loads the index and injects a fragment per click. (2) Gallery:
scripts/p87-figures-manifest.ts scans web/*.svg into web/figures.json (23 figures) and the view also renders
each finding's light-curve / phase-fold plots. (3) Survey timeline: the autonomous passes bucketed to
15-minute UTC edges from the existing /api/state + /api/ledger, honestly badged (RECOVERED vs UNCONFIRMED
blind-TOI). (4) Finding Details: a collapsible panel per card with a client-side linear ephemeris countdown to
the next transit, the NASA cross-match, injection-recovery, the bundle hash and a one-click on-chain proof.
New tests/report-md.test.ts guards the renderer's escaping; the tests/projection-relabel.test.ts structural
assertions on web/app.js are preserved verbatim.

### X digest now reports science, not commit counts (2026-10-17)
The half-hourly X digest (.github/workflows/x-post.yml) no longer counts commits landed since the last run; it
composes ONE honest English line about the most important SCIENCE the rig produced in the window, via
scripts/science-digest.ts (a pure composeDigest, unit-tested in tests/science-digest.test.ts, with all
network/file I/O kept in an entry-guarded main()). Priority: (1) a result sealed on-chain -- named only when
it resolves to a known-planet re-validation, otherwise an honest count; (2) newly flagged UNCONFIRMED blind
candidates, worded "for human follow-up rather than any claimed discovery"; (3) a research milestone, and
only when web/research.json actually landed in the window. A window with no new result still posts nothing.
The window start is normalized to ISO 8601 so `git log --since` and the digest agree exactly; English-only /
ASCII-only and dry-run-without-secrets behaviour are unchanged (enforced in both the workflow and
post-x-text.ts). Photon-tier honesty is preserved: only blind-TOI findings (contractually recovered on real
photometry) may say "real TESS photometry", and purity is cited as the lower bound research.json declares.

### X digest gained a silence heartbeat + a regression net for its read (2026-10-17)
The half-hourly digest posts nothing when there is no new science -- correct anti-spam behaviour, but a long
quiet stretch then read as if the rig had stopped. composeDigest gained a fourth, PURE branch (scripts/
science-digest.ts): when a run has nothing new to report AND the account has actually been quiet past
HEARTBEAT_AFTER_MIN (default 90 min), it composes ONE honest status heartbeat instead of going silent. The
silence gap is measured by scripts/x-last-post.ts reading the account's own newest tweet (so a human reply also
counts and no needless note is sent); a real result always outranks the heartbeat and the read costs an extra
API call only on the empty-science branch. Three defects surfaced and were fixed while verifying it live:
(1) the read was wrapped in a `set -o pipefail` command substitution that aborted the WHOLE run whenever the
read returned no match -- every quiet scheduled run went red and the heartbeat never ran (fixed: read captured
to files with an explicit exit-code check + `|| true` guards, so a failed read now degrades to an honest skip);
(2) x-last-post.ts requested max_results=1, which X API v2 rejects with HTTP 400 (legal range 5..100), so the
read always failed (fixed: request the smallest legal page and take the newest created_at); (3) all of this
shipped with zero test coverage on the read -- it is now covered by tests/x-last-post.test.ts (5 offline
behaviour tests pinning the request shape, newest-timestamp selection, /2/users/me id parse and RFC-3986
encoding, none of which touch the network). CI-only (workflow + scripts run from the runner checkout, not the
Worker bundle), so it is live on push with no redeploy; verified end-to-end on a real dispatch run that read the
gap correctly and suppressed the heartbeat below threshold.
A workflow_dispatch input dry_heartbeat=1 was added as the standing way to prove the heartbeat tier end-to-end on
the runner WITHOUT touching the feed: it composes a heartbeat over a valid-but-empty window (past --since AND
--until, since an inverted window trips composeDigest's guard before the fallback tier), asserts the output is
non-empty and ASCII-only, prints it, and exits before any post. The workflow header now records that `npm test`
being green does NOT exercise the compose/watchdog path, so this dry dispatch is the real pre-merge gate.

### Blind-candidate counts now exclude critic-rejected dips (live-data verified) (2026-10-17)
With the rotation unfrozen, live /api/state began producing origin="blind-toi" rows for real -- a mix of SURVIVING
needs-more-data candidates AND critic-REJECTED dips. The digest blind tier (priority 2) and the silence heartbeat
counted EVERY blind-toi row in the window, so a rejected dip (noise) was reported as an "UNCONFIRMED candidate for
human follow-up" -- an over-count that overstated the catalog. Both now filter verdict !== "rejected", so only
surviving candidates are cited. Per the project's live-data doctrine, this is guarded by tests/live-blind-digest.test.ts
over tests/fixtures/live-blind-candidates.json (captured from the real site by the new npm run fixtures:capture-blind,
re-runnable) -- it drives the actual composeDigest and asserts the reported count equals the surviving count and
never the total, plus the honesty invariants on production bytes (no discoveryClaim, none auto-anchored). The live
fixture at capture time held 2 surviving + 2 rejected; before the fix the digest/heartbeat reported 4.

### Digest window now anchored to the last ACTUAL post, not the last run (2026-10-17)
The digest cursor used the previous completed x-post RUN's start time. Any run that posted NOTHING -- an empty-
science tick, a dry_heartbeat, or a verification dispatch -- still advanced that cursor, so science sealed between
the last real tweet and a no-op run fell OUTSIDE the next window and was skipped FOREVER. This is the real reason
the feed went silent while the survey kept producing results: a fresh re-validation (KELT-20 b) sat unposted
because a string of no-op runs had marched the cursor past it. The window is now anchored to the account's
newest tweet (the same single up-front X read that feeds the heartbeat), falling back to override --since / prior
run / ~40m, so the range is self-healing across skipped, failed OR throttled runs -- nothing is dropped until it
has actually been reported. CI-only.

### Reliable X-post trigger from the Cloudflare cron (2026-10-17)
GitHub throttles the x-post workflow's own `on.schedule` (observed 2-5h gaps), so the feed could go silent even
while the survey kept producing results -- and the silence heartbeat could not fire because it lives inside the
skipped run. The dependable clock is this app's Cloudflare `*/15` cron, which fires on time. Twice an hour (at
:00 / :30) the `scheduled` handler now POSTs a workflow_dispatch to wake x-post.yml -- but ONLY if the
`GH_XPOST_DISPATCH_TOKEN` secret (a fine-grained GitHub PAT with Actions:write on this repo, nothing more) is
present. The dispatch merely starts a run; it carries no content and cannot post by itself, and the digest window
is anchored to the last actual post and self-heals, so an extra wake never double-posts or drops science. Inert
without the secret (this code changes nothing until it is provisioned), failures are swallowed so the research
tick is never blocked, and GitHub's own schedule stays as a backup. This is a Worker change -> requires wrangler
deploy to take effect.

### Digest tone: no per-post disclaimer, varied phrasing, lean footnotes + a build-note tier (2026-10-17)
The auto digest read as copy-paste because every post reused the SAME three blocks -- a fixed "discoveryClaim=false"
sentence, the standing characterization numbers (unchanged until research.json changes), and the same proof links --
so only the headline differed. The maintainer had also asked to stop stamping that disclaimer on every post.
composeDigest now: (1) drops the literal "discoveryClaim=false" stamp (honesty rides on plain wording +
numbers-with-basis); (2) rotates each headline / honest line among a few paraphrases picked DETERMINISTICALLY by a
hash of the window, so it stays a PURE testable function (no clock/random) while consecutive posts stop looking
identical; (3) keeps the characterization block + research.json/figure/p49 links ONLY on the research milestone
(there those numbers ARE the content) and makes routine result/candidate posts lean (headline + one honest line +
the sealing tx when any + the live rig). Added a BUILD-NOTE tier (priority 4): when a window has no new science the
workflow gathers non-research, non-chore commit subjects since the last post and composeDigest emits a plain dev
update; sanitizeSubject drops any line mentioning spend/wallet/key or a time word, so commit coverage is BATCHED
(never per-commit) and deduped by the last-post cursor, with the silence heartbeat still the last resort. CI-only
(workflow + scripts run from the runner checkout, not the Worker bundle) -> push activates, no redeploy.
typecheck:all + eslint clean; 545 pass (was 539, +6 for rotation / lean footnotes / build-note tier / filtering).

### Audit-6: X auto-post switched from per-push to an hourly commit digest (2026-10-16)
Posting one tweet per qualifying push got noisy: a run of consecutive commits (like this audit remediation)
produced a run of consecutive tweets. `.github/workflows/x-post.yml` no longer has a push trigger -- it is now
a once-an-hour scheduled DIGEST (cron `0 * * * *`) that counts the commits landed on main since the previous
digest and posts ONE English, text-only line (count + links), e.g. "3 new commits shipped to Space Data Rig -
spacedatarig.app - github.com/SpaceDataRig/space-data-rig". An hour with no new commits posts nothing (no empty
tweet). The look-back cursor is the previous completed run's start time (read via the Actions API), so a delayed
or skipped tick stretches the next window instead of dropping commits; if the lookup fails it falls back to a
~70-minute window. English-only/ASCII-only and dry-run-without-secrets behaviour are unchanged, and a manual
workflow_dispatch can still post an override or a custom window.

### Audit-6 P2: ledger status corrected from "deploy-pending" to shipped + mainnet-proven (2026-10-16)
RESPONSE-TO-AUDIT.md and this file still described the scienceHash dedup and several fixes as "Shipped
(deploy-pending)", which was stale: as of the current deploy the Web assets and the Worker are both live at
Workers version f4dfb1a9 on spacedatarig.app. The two dedup rows are now marked "Shipped + mainnet-proven":
re-running the F-HR-858-b/c/d trio (one detection under three catalog labels, which now collapses to a single
scienceHash) paid exactly ONE anchor fee for F-HR-858-b and de-duplicated c/d against it -- two mainnet fees
saved, verified live. A dated deployment-status note supersedes the remaining deploy-pending markers, and the
stale "Commit 34e93b8 (deploy pending)" line is corrected to "deployed, version c9af4564".

### Audit-6 small: .gitattributes pins eol=lf so deployed bytes match the repo (2026-10-16)
The live site was serving CRLF while the repo stored LF (a Windows checkout with core.autocrlf rewrote the
line endings on the way out), so byte-comparing deployed static assets against the repo -- ETag, size, hash --
lied and sent us chasing a phantom diff. `.gitattributes` now sets `* text=auto eol=lf`, so what is committed
is what gets deployed regardless of the checkout platform; the existing spoc-curves fixtures rule is kept and
binary artifacts (FITS/PNG/fonts/archives) are explicitly exempted from any EOL conversion or text diff.

### Audit-6 P2: /health now self-proves which deployment is live (2026-10-16)
For five rounds /health reported only codeVersion = space-data-rig@0.1.1 (the package version), so confirming
"a deploy landed" required byte-comparing static assets and inferring line-ending differences. The Worker
probe now also returns deployVersion (the Workers Versions metadata id via a new version_metadata binding,
which changes on every upload) and gitSha (the commit the deployment was built from, supplied at deploy time
as the GIT_SHA secret); the Node server's /health echoes GIT_SHA for parity. One GET now answers "which
commit is live".

### Audit-6 P2 follow-up: gitSha stays honest across deploys (2026-10-16)
GIT_SHA is a static secret, so a plain `wrangler deploy` uploads new code but leaves /health reporting the
PREVIOUS commit -- the self-proof would quietly start lying after the next deploy. `npm run cf:deploy:sha`
(scripts/deploy-with-sha.ts) is now the recommended deploy path: it re-sets GIT_SHA to the current HEAD
immediately before deploying (warning on a dirty tree), so the live gitSha always equals the deployed commit.
`--dry-run` resolves the sha and builds the bundle without writing the secret or uploading. The
version_metadata binding was also corrected to the object form `{ binding = "CF_VERSION_METADATA" }` that
wrangler 4.149 requires -- a bare string fails config parsing, which tsc/tests do not cover, so it was caught
only by `wrangler whoami` / `deploy --dry-run` (recorded as a pitfall: always parse-check wrangler.toml before
pushing). Live /health verified after deploy: gitSha = the deployed HEAD, deployVersion = the Workers version id.

### Audit-6 P2: the six real-MAST-FITS gates now run in CI (2026-10-16)
tests/mast.test.ts, tests/mastS3.test.ts and tests/mastS3Pixels.test.ts skip themselves when out/probe-lc.fits
or out/probe-tp.fits are absent, and out/ is gitignored -- so on a fresh CI checkout the gates closest to
external-data fragility ("real MAST FITS parses", "BLS finds the strong signal in real photometry", "the
target-pixel cube parses") never executed. Committing ~7 MB of binary probes was rejected in favour of a CI
prefetch step: scripts/ci-fetch-probe-fits.ts (npm run ci:probe-fits) downloads the same two public,
token-free products through the production fetch code (curated MAST Download URI + anonymous TESS-SPOC S3
target-pixel object) with retries, reusing any local cache; a download that still fails exits 1 so the gate
fails loudly instead of silently skipping. .github/workflows/ci.yml runs it before the test gate.

### Audit-6 P1: the content address re-binds which photometry the science used (2026-10-16)
The audit-4 rewrite excluded dataProvenance from scienceProjection to fix label-polluted hashing; the cost was
that the science address no longer bound the data source, so a synthetic stand-in run through the same blind
detection shared the real-data address. Measured on live manifests FIRST: catalogSource and lightCurveSource
are identical across the F-HR-858-b/c/d labels and, since computeDataHash() dropped targetId, lightCurveHash
is label- and timestamp-independent too -- so all three fields are re-included without resurrecting the
dead-dedup problem (the live trio still collapses to ONE hash; fixtures re-captured 2026-10-16).

- scienceProjection now carries dataProvenance; a swapped lightCurveHash or a stand-in lightCurveSource moves
  the address (new live-data assertions), while a later re-run of the same bytes keeps it.
- Dedup safety for history: rows sealed before this change store the pre-audit-6 hash, so anchorFinding also
  matches on hashScienceLegacy() (the legacy projection, consulted for the dedup lookup only -- never stored,
  never placed in a memo), so already-anchored science cannot be paid for a second time after the address
  definition changed.
- tests/live-data-regression.test.ts gains provenance-equality/presence assertions, the stand-in-address test
  and the legacy-fallback test, all driven by the re-captured live fixtures.

### X auto-post channel enabled via operator-supplied Actions secrets (2026-10-16)
The CI auto-publish channel (scripts/post-x-text.ts plus .github/workflows/x-post.yml) originally shipped inert:
with no X credentials in Actions secrets it only dry-runs and sends nothing. The operator has now added the four
X platform keys (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) under repo Settings > Secrets
and variables > Actions, so a qualifying push (reports/**.md, web/research.json or CHANGELOG.md) posts ONE
English, text-only status line through the X API v2 using hand-rolled OAuth 1.0a.

- English-only and text-only are enforced twice: the workflow strips non-ASCII from the composed line and the
  posting script refuses any payload containing a non-ASCII byte, so CI can never publish Chinese or an image.
- Loop and spam guards are unchanged: the job skips github-actions[bot] publish-back commits and is
  concurrency-grouped, so a regenerated report cannot trigger a second post.
- Credentials live only in Actions secrets; the repository and the workflow file contain no key material, and a
  missing secret keeps the channel in dry-run.

### Audit-5 follow-up: the rotating survey makes the catalog grow, and the frontend explains what it is (2026-10-16)
A reader asked why FINDINGS CATALOG always showed the same handful and whether the project was doing anything
visible. The honest root cause: the autonomous survey selected the brightest N KNOWN planets every pass, and
because finding ids are deterministic (`F-<target>`) + `recordFinding` is `INSERT OR REPLACE`, each pass
OVERWROTE the same rows -- so the catalog churned in place and looked static, while the genuinely interesting
work (blind recovery of UNCONFIRMED candidates, the p7 statistic) ran offline and never reached the site.

- The autonomous run now ROTATES through a broad real pool (known-planet re-validation + UNCONFIRMED TOI
  candidates) selected from a persisted survey cursor (`src/survey/rotation.ts` windowing; `surveyPass` in DO
  meta, advanced once per pass, idempotent by runId), so the catalog accumulates NEW rows across passes.
  Gated by `AUTO_RESEARCH_ROTATION`; a manual dashboard run keeps the historical brightest-top-N selection.
- Real blind-TOI candidates run through the SAME 5-seat pipeline (`toiToArchivePlanet` maps a `TocCandidate`
  onto the seat-level `ArchivePlanet`; the TOI ephemeris is withheld so detection stays BLIND, exactly p5/p7).
  A TOI with no token-free SPOC photometry is SKIPPED, never given a synthetic stand-in that could fake a
  "recovery".
- Honesty red lines enforced in code, not prose: `Finding.origin` labels each row (`revalidation` vs
  `blind-toi`); `critique()` caps a `blind-toi` candidate at `needs-more-data` even if the evidence would
  accept it; the auto-anchor branch additionally refuses `origin === "blind-toi"`; and `origin` is NOT part of
  the bundle manifest, so it moves no bundleHash/scienceHash and touches no anchored row (behavior-tested).
- Frontend legibility: catalog cards carry an origin pill ("Known-planet re-validation" vs gold "BLIND
  CANDIDATE - UNCONFIRMED"), filter chips (All / re-validation / blind candidates), an honest section note,
  and a live "survey pass / distinct targets / blind candidates" counter sourced from DO state.
- 6 new behavior tests (`tests/rotation.test.ts`): windowing determinism/wrap/growth, TOI field units, the
  blind-TOI verdict ceiling, and the load-bearing bundleHash-invariance-under-origin check. Gates: typecheck:all
  + worker exit 0, npm test 487/487, eslint 0, node --check web/app.js 0, non-ASCII 0, secret scan 0.

### Audit-4 follow-up: two "deployed but inert" fixes made to actually fire, plus a live-data gate (2026-10-16)
A fourth independent review re-tested the audit-3 fixes on the LIVE site and found two of them were correct,
unit-tested, and deployed -- but never took effect on real data, because a non-science field had been folded
into a hash. Both are fixed at the root and, crucially, guarded by a new class of test that runs the REAL
captured production records through the REAL predicate.

- scienceHash dedup was DEAD CODE: `hashScience()` was `{ ...manifest, createdAt:"", runId:"" }`, still folding
  in `findingId`/`targetId`/`artifacts`/`dataProvenance`, so the live F-HR-858-b/c/d trio (one detection under
  three catalog labels) hashed to THREE values and never deduped -- three mainnet fees for one content.
  Replaced with `scienceProjection()` (blind science + gating checks only); `computeDataHash()` no longer hashes
  `targetId`. Proven on the real captured manifests: 3 distinct scienceHashes -> 1.
- Measuring the real data CORRECTED the audit's own field list: its suggested projection included `checks`, but
  `checks[6]` "period-vs-truth (post-hoc, non-gating)" differs per label, so including it verbatim would have
  kept the dedup dead. The projection filters post-hoc/non-gating checks and keeps the 8 gating ones.
- Legacy "Confirmed:" relabel was OFF-BY-ONE-DAY: `created < "2026-10-12"` excluded all four live legacy cards
  (created ON that date), and its test only string-matched source so it stayed green. Boundary is now `<=`; the
  predicate moved to `web/relabel.js` (imported by app.js AND the tests); `tests/projection-relabel.test.ts`
  rewritten from string-matching to BEHAVIOUR.
- The dedup's honest API reply showed as "anchor failed" in the UI (app.js had no `deduplicated` branch, so
  `res.ok && res.signature` fell through). Added the branch: "no new tx -- identical science already anchored as
  <id>"; the button reads "Deduplicated"; the foreign signature is deliberately NOT stamped on the card.
- Plain `GET /api/events` returned 500: the worker forwarded it with an injected `Upgrade: websocket` header, so
  the DO's correct 426 branch was unreachable. The worker now checks `Upgrade` first and returns 426 for a
  non-WebSocket request (the DO branch stays as defence-in-depth).
- One run re-downloaded the same light curve per catalog row on a star. Added an optional run-scoped BYTE cache
  to `fetchSpocBytes` (keyed by tic+sector, never the label) + a per-run sector memo; each row still parses its
  own targetId, so points/dataHash/bundle stay byte-identical. Pure latency/GET saving on the token-free path.
- Defect C ledger wording CORRECTED: it was remediated ~23 min AFTER the audit-3 snapshot (34e93b8 @ 00:55Z vs
  584c1e47 @ 00:32Z), not "before this review's snapshot", and it is a global DO with in-memory counters (reset
  on eviction), NOT "global SQLite". Coverage values now carry a Node-version caveat (branch 80.4 vs an audit
  re-measure of 79.82 on Node 24.15; the gate enforces FLOORS, not exact values).
- NEW GATE: `scripts/capture-live-fixtures.ts` (`npm run fixtures:capture`) snapshots the live /api/state and
  stored manifests into committed fixtures; `tests/live-data-regression.test.ts` drives the real predicates over
  them. This is the class of test that would have caught both inert fixes before deploy.

### Audit-3 follow-up: half-done items closed, two new defects fixed, limits made explicit (2026-10-16)
A third independent review confirmed 8/11 audit-10 items and flagged three that were *done but only
half-done* plus two new defects. The one-line-code-and-a-test items are shipped; the design/method items
are recorded honestly as limits, not patched over.

- Defect A -- memo shape now identical on both runtimes: `scienceHash` is threaded through the shared
  `anchorOnEndpoints` primitive, so the Node (`anchorBundleHash`) and Worker (`anchorFinding`) paths build
  the same memo. The prior code computed `scienceHash` on the Worker but the on-chain tx was still built
  3-field, so the content address reached neither runtime's chain record. Contract test added. Commit f34d672.
- Identical-science anchors are now DEDUPED by `scienceHash` before spending: a byte-identical re-run gets a
  new timestamped `bundleHash`, so the old exact-hash guard missed it and paid a repeat mainnet fee (observed:
  3 txs for one content). A pure `findAnchoredScience` predicate skips the spend; we do NOT copy a foreign
  signature onto the card, preserving the anchor-stamp invariant. `scienceHash` persisted on the ledger. Commit 9dcf908.
- Defect B -- legacy CONFIRMED cards are relabeled in the render layer (history is never rewritten): a card
  whose stored headline says "confirm" AND predates the 2026-10-12 policy date gets a visible injection-recovery
  note; the rule is documented under README "Display / projection layer" and guarded by a drift test. Commit be553ed.
  NOTE: this commit's subject line was mislabelled (an embedded-double-quote escaping bug reused the previous
  commit text); the diff -- `web/app.js`, `web/styles.css`, `README.md`, `tests/projection-relabel.test.ts` -- is
  the projection-relabel work described here, not the anchor-dedup text in the subject.
- Defect C (rate limiting per-isolate + fail-open) was remediated ~23 min AFTER this review's snapshot, not
  before it (timeline corrected here per audit-4): the audit-3 snapshot 584c1e47 is 00:32Z, while the fix commit
  34e93b8 is 00:55Z and is itself titled "Audit-10 #7 residual". The abuse-brake counters live in a global
  `RateLimitDO` (`src/cf/rate-limit.do.ts`, deployed c9af4564) -- a Durable Object with pure **in-memory** counters
  (a `Map`, reset on DO eviction), NOT SQLite-backed; `worker.ts` `rateCheck` hits the DO stub first and only fails
  open to a local limiter if the DO call errors. `wrangler.toml` declares it via `new_sqlite_classes=["RateLimitDO"]`,
  which is the migration key this account requires for ANY new DO and does not imply SQLite storage.
- #10 / P1 -- the live-probe's failure mode is now PROVEN offline, not just present: each probe split into a
  fetch + pure `judge`, a `--self-test` drives drifted fixtures through the real detection logic and asserts the
  alert exit code, and 5 offline tests in `npm test` lock it in. Commit 97cddc6.
- Audit-10 #3 corrected from *Blocked* to *Partial*: "no Python here" was false (CI runners install Python and a
  detection-side cross-check already runs); the real blocker is the official TRICERATOPS package's own
  `starfield`/POPS dependency, not Python. README gained an explicit "Capability boundaries" section stating the
  blended/multi-source-per-pixel 0/56 result as a pixel-baseline-bound architecture limit, not a tuning gap.

## [0.1.1] - 2026-10-16

### Audit-10 response + P82 scaled validation + production hardening (2026-10-15/16)
A second external audit listed 11 prioritised items. All ten implementable ones are shipped; #1 and #7 are
now live in production (deployed behind an admin token). One item (#3) is blocked by the local environment.

- #2 P81 report-layer guardrails: a Gaia census that is unavailable now prints `undetermined` (was `NaN`) and is
  excluded from every rate; a de-diluted depth past the 10% physical cap is flagged `inconsistent`, excluded from
  grading, and reported as a blend-contradiction EVIDENCE section; VERDICT states the denominator. Commit 47e5701.
- #5 P80 depth-stratification: the headline now names its EASIEST subset (deep+bright) and a harder 300-1000 ppm
  tier is reported in the same run so the easy rate is never over-generalised. Commit 4061b0f.
- #6 Reusable inverted planet-free null `src/detect/invertedNull.ts` (+3 tests); P75 imports it. README now leads
  with the measured result: the AR(1) gate signs off 75% of pure-noise bumps at FAP<0.05 vs nominal 5%
  (model-free block 31%, n=16). Commit 68802bb.
- #4 P84 `scripts/p84-centroid-diagnosis.ts`: decomposes the scaled centroid result into COVERAGE vs POWER and
  concludes PIXEL-BASELINE-BOUND (71% of blend targets never localise; measurable blends match neither target nor
  contaminant) -- the statistic is fine, our per-sector centroid localisation is the limiter (chain payoff for
  P44/P53/P57/P59). Commit 70578d5.
- #1 Bundle integrity of the reproducibility claim: `hashScience()` splits the stable CONTENT ADDRESS from the
  timestamped `bundleHash` commitment (purely additive -- no existing bundle, hash, or verdict changes); new
  anchor memos append scienceHash (verify still matches the bundleHash at position 2). README's "same inputs ->
  same hash" line corrected to state it is a timestamped commitment. NOTE: this commit's message was mislabelled
  (an embedded-quote escaping bug reused the prior commit text); the diff -- 5 files at 7887121 -- is the #1 work.
- P82 scaled run: blind 425 curves (recall 86.2%, accepted precision 42.2%), external KP 182/234 + CP 104/179
  (strict TRICERATOPS-grade 1/234 & 5/179), centroid planet false-reject 1/53 vs blend catch 0/56.
- #7 Deny-by-default admin gate (`isAdminAuthorized` returns false when no token is set) + a per-finding
  in-flight anchor lock that stops a same-run re-entrant SOL double-spend; `SECURITY.md` published. Commit c905d3f.
  DEPLOYED (version fc6810a6): live on spacedatarig.app behind `ADMIN_TOKEN`; verified 401/401/404/200 against
  the running site. The dashboard now prompts for the token on a 401 (commit c9a95a8).
- #9 Keyless read-only on-chain verification `scripts/p9-anchor-live-verify.ts` + daily workflow: re-reads recent
  mainnet anchors straight from the chain and confirms each memo still matches its bundleHash. Smoke 3/3 OK. Commit 1896fbf.
- #11 `npm run lint` -> `eslint --max-warnings 0` (0 warnings tree-wide) + coverage gate widened to enforce
  `--test-coverage-branches=75` (measured line 95.8 / branch 80.4 / fn 91.8). Commit 500a986.
- #8 Weekly upstream live-probe `scripts/p8-live-probe.ts` + workflow (NASA/ExoFOP/Gaia minimal read-only queries,
  asserts consumed fields + row counts, opens an issue on a schema/row-count drift). Local smoke PASS 3/3. Commit 9c857d4.
- #10 `RESPONSE-TO-AUDIT.md`: four-column ledger (criticism -> fix -> verification -> residual risk) for all eleven
  items; README gained a one-page "At a glance" front (long-form kept as auditable context). Commit fe87fb5.
- #3 (run official TRICERATOPS via pip) remains BLOCKED: this environment has no Python/pip; the FPP maths is already
  reimplemented natively (`daveBlendedFpp`). All other items shipped.
- #7 residual: abuse-brake counters moved from per-isolate to a Durable Object (`RateLimitDO`) so the limit is
  global across isolates, with the local limiter kept as a fail-open fallback. Commit 34e93b8 (deployed, version c9af4564).
- P85 `scripts/p85-contaminant-fit.ts`: faithful per-contaminant centroid F-test (eumemic method) reported on the
  real 500-target run -- planet false-reject 1/53, blend caught 0/56, but a neighbour explains the mean in 54/56
  viable blends (the low power is target-not-rejected, not contaminant-not-fitting), with a threshold sensitivity
  table. Commit b8dad16. safeToGate=false, discoveryClaim=false.

### Audit-9 science-meaning program -- multi-sector blind test + TCE/DAVE/TPM benchmark (2026-10-15)
The external audit said the work is meaningful only with (a) a quantitative benchmark against TCE/DAVE/TPM,
(b) a blind test on more real sectors/stars (not stand-in + tiny), and (c) an externally-independently-validated
candidate. All three are now addressed on real data.

- P79 `src/detect/benchmark.ts` + `scripts/p79-benchmark.ts` (`npm run p79:benchmark`, offline): re-implements the
  headline statistic of each named tool -- TCE BLS SNR + the >=3-transit / SNR>=7 / depth-band acceptance,
  DAVE/TRICERATOPS blend FPP, and a TPM (Burke 2015) logistic completeness model FIT TO OUR OWN p47 grid (not
  Burke's Kepler coefficients). Result: cells the TCE rule accepts average 74% measured completeness vs 0% for
  cells it rejects -- our detector's completeness tracks the standard BLS/TCE detection limit on real photometry.
  8 offline tests.
- P78 `scripts/p78-blind-multisector.ts` (`npm run p78:blind-multisector`): a real multi-sector blind test that
  runs the detector SECTOR BY SECTOR (P49 stitched sectors and forced corroboratedSectors=1, so its 2-sector bar
  accepted nothing by construction). On 24 bright SPOC hosts (10 injected / 14 null, 55 period-clusters): under a
  2-sector corroboration bar the accepted recall is 8/10 (real planets DO clear it) but false-accepts are 9 and
  accepted precision only 47% (raw precision 16%). Honest finding: cross-sector period-only corroboration is
  necessary but NOT sufficient -- coherent systematics/aliases recur across sectors -- so it cannot alone carry a
  discovery claim. `reports/p78-blind-multisector.{md,json}`.
- P80 `src/candidate/independentValidation.ts` (+ 5 offline tests) + `scripts/p80-external-validation.ts`
  (`npm run p80:external-validation`): closes gap (c), which was STRUCTURAL -- the P65 critic audits an outside
  claim on an EMPTY catalog so it can never self-corroborate (hence 0/2). New non-circular path: ingest EXTERNAL
  claims from the anonymous ExoFOP table, run the detector BLIND (the claim's ephemeris is never fed; it searches
  1-13d) SECTOR BY SECTOR, corroborate a period across independent sectors, and confirm a claim only when that
  blind detection matches it. On real SPOC data: 9/11 confirmed-planet (KP) positive controls validated (machinery
  works) AND **5/9 still-uncertain candidate-planets (CP) independently validated** -- recovered periods matching
  the external claim to 0.002-0.065% across >=2 sectors. First independent external validations for the project
  (a first CHECK supporting a candidate, NOT a discovery or TRICERATOPS-grade validation; alias risk noted). No
  gate moved. `reports/p80-external-validation.{md,json}`.
- P81 `src/candidate/triceratopsLite.ts` (+ 5 offline tests: neighbour contrasts, dilution-corrected depth,
  harmonic-alias counting, monotone alias-risk grading) + `scripts/p81-triceratops-lite.ts`
  (`npm run p81:triceratops-lite`): grades the P80 validations closer to TRICERATOPS by adding three discriminants
  the detector never saw -- a real Gaia DR3 21-inch neighbour census -> dilution + blend EB FPP
  (benchmark.daveBlendedFpp on actual flux contrasts), harmonic-alias accounting, and the multi-sector centroid
  F-test (faithful to eumemic, run on real pixel cubes at the recovered ephemeris) -- folded with the P78 empirical
  false-coincidence base into a per-candidate alias-risk grade. On real data: of the 14 blind validations, 5/9
  confirmed-planet (KP) controls reach the strict TRICERATOPS-grade bar (blend FPP<1e-3 + centroid on-target + low
  alias) but 0/5 still-uncertain CP candidates do (heavy blends or centroid not localisable at this depth on public
  FFI) -- the same bar cleanly separates known planets from unconfirmed claims. First-order, not full TRICERATOPS;
  discoveryClaim false, safeToGate false. `reports/p81-triceratops-lite.{md,json}`.

### P77: faithful re-port of eumemic's centroid F-test, measured on our data -- closes the P74 follow-up (2026-10-15)

- `src/detect/centroidFtest.ts`: a faithful implementation of the author's statistic (`F = n(n-1)|mean-s|^2 / RSS`,
  per-axis scatter floored at 1", >=2 sectors, offsets beyond 60" dropped; df1=2 so p = `(1 + F/(n-1))^-(n-1)`),
  built from their `validation/centroid_sectors.md` rather than guessed. Pure + offline, with `targetCentroidP` /
  `neighbourCanCauseDip` helpers and 7 hand-checked tests. No verdict / bundle hash / money path; nothing gated.
- `scripts/p77-centroid-ctest.ts` (`npm run p77:centroid-ctest`) runs it on real SPOC cubes. Of 28 bright ExoFOP
  targets only 9 were testable (>=2 sectors -- our short-baseline limit); the F-test false-rejected 2/6 known planets
  at p<0.001 (vs eumemic's 0/565) and caught 0/3 labelled blends (ours are on-target EBs). Honest read: the statistic
  is correct, but our difference-image localization is too coarse (the 2 false-rejects had spurious 22"/35" offsets)
  and our sample too small to re-validate or gate on it. safeToGate/discoveryClaim false. `reports/p77-centroid-ctest.{md,json}`.

### Audit remediation -- honesty copy, positioning, test discovery, data contracts, rate limiting (2026-10-15)
A third-party audit raised nine findings; this round addresses the ones fixable in code/docs without touching the
verdict, bundle-hash or money path. Each is measured-labeled and gated by tests.
- **#3 user-facing over-claim** (`src/reporter/narrate.ts`): the accepted badge is now `RECOVERED` (was `CONFIRMED`,
  byte-agreeing with the frontend), the headline no longer says "Confirmed: a planet", and every headline labels its
  photons as `[real TESS photometry]` vs `[stand-in synthetic curve]` -- enforcing HANDOFF's own "label real vs stand-in
  in every user artifact" rule at the loudest surface, not just the manifest.
- **#4 optimistic recovery caliber** (narration + `Finding.recoveryTrials`): the re-injection number is now shown with its
  trial count and a 95% Wilson CI and framed as a *conditional* targeted re-injection, explicitly not blind-search
  capability. narration is excluded from `buildManifest`, so no bundle hash or verdict moved.
- **#1 AI-vs-pipeline framing** (README / RESEARCH): a plain-language note that the five seats are deterministic
  TypeScript stages, `src/ai/` is ~2% and advisory only, and P70 measured that removing the models changes zero verdicts.
- **Build & test hygiene** (#5): `npm test` no longer uses a hand-maintained file list (which let new tests
  be silently skipped) -- it now auto-discovers every `tests/*.test.ts` via `scripts/run-tests.ts`, with a floor
  guard that fails loudly if discovery ever regresses. Added ESLint (`eslint.config.js`, `npm run lint`, errors block),
  Prettier config (`npm run format` / `format:check`), and a coverage gate (`npm run test:coverage`, Node's built-in V8
  coverage, line floor 85 against the measured ~95%). CI now runs typecheck + lint + tests-with-coverage as blocking,
  with `npm audit` and `format:check` advisory until a one-time repo-wide format is agreed. Fixed the broken
  indentation in `package.json` scripts.
- **Collaboration status (#6)**: `GOVERNANCE.md` gains a "Maintenance cadence and dependency updates" section stating
  plainly that the commit rate is partly machine-generated under a sampling-and-gate review model, and that Dependabot
  PRs are opened automatically but merged only by the owner -- CI-action bumps after a green run, production-dependency
  bumps (next to the money path) only after explicit review. Docs only.
- **Brittle external-data deps (#7)**: added `src/data/dataTier.ts` as the single canonical schema contract --
  the real-vs-stand-in discriminator, the requested `pscomppars` column list (now the one source of truth for
  `fetchConfirmedPlanets`), and the required ExoFOP TOI header names -- pinned by `tests/schemaContract.test.ts`,
  so an upstream column rename or a source-label change turns into a red test instead of a silently mislabelled
  card or an all-`tic=0` table. In the process the contract test caught a real silent degradation: ExoFOP
  `parseToiTable` coerced a missing key column to `Number("")=0` and emitted garbage rows; it now fails closed
  (returns []) when the row-key column is gone. Docs/pure code only; no verdict/bundle-hash/money path.
- **Unauthenticated / unthrottled mutation endpoints (#8)**: the admin gate already existed but is opt-in (open
  when `ADMIN_TOKEN` is unset). Added a coarse per-client rate limiter (`src/core/rateLimit.ts`, fixed window keyed
  on `cf-connecting-ip`, returns 429 + `retryAfterSec`, deliberately fail-open) on `POST /api/run`, `POST
  /api/anchor/:id` and `POST /api/anchor/:id/deliberation`, gating BEFORE auth so unauthenticated floods are shed too.
  SECURITY.md documents it and re-stresses that setting `ADMIN_TOKEN` is the real fee-wallet protection. No verdict /
  bundle-hash / money-path logic changed; **not deployed** and the secret remains the operator's to set. Offline tests
  in `tests/rateLimit.test.ts` (5 cases).
- Locked by `tests/narrate.test.ts` (5 offline cases).
- **Scientific-novelty scope (#9)**: `RESEARCH.md` section 4c states plainly that our two cross-checks are
  same-problem re-implementations (PDM; a wotan+astropy BLS) and that we have run **no quantitative benchmark against
  TCE / DAVE / Drisser's TPM**, with small samples (12 fixtures / 33 hosts / 27-54 d baselines); it defines the honest
  deliverable (a reproducible harness + quantified negative results, not a new detector) and lists the concrete steps
  to paper-grade (Drisser/TPM + DAVE-style ROC on the same hosts; a large selection function; external re-derivation).
  Docs only. The benchmark studies themselves are follow-up research tasks, not run here.

### Correction -- we mis-described eumemic's centroid check; attribution fixed (2026-10-15)
The eumemic/exoplanets author (@dysmemic) replied to our thank-you note with a correction: their cross-sector
centroid check is NOT a "does the offset point the same way in every sector" test. It runs an **F-test on the mean
offset across sectors** (per-axis scatter floored at 1") against the target **and every star within 2' bright enough
to cause the dip**, reporting **0/565 known planets rejected at p<0.001** and **73% of 175 neighbour-blended TOIs
caught** (38% within 15") -- see their `validation/centroid_sectors.md`. Our P74 implemented a different, simpler
**directional-coherence (Rayleigh)** statistic, so `COHERENCE-SAVES-PLANETS-BUT-NO-POWER` is a verdict about OUR
variant, not a judgment of their method. We corrected the attribution in RESEARCH.md, the P74 script + report,
`diffImaging.ts` and the offline test's comments, the dashboard card, and the round figure, and logged a faithful
F-test re-port as follow-up. Numbers unchanged; docs/labels only; nothing gated.

### Research -- borrowing vetting levers from a real TESS survey, measured before gated (P73-P76) (2026-10-15)
- P73 masked sibling recovery (`scripts/p73-masked-recovery.ts`): ports eumemic's `--mask-tois` lever. Masking each
  host's OTHER catalogued planets lifts the blind joint re-find 6->7/20 (net +1, zero regressions) but stays far under
  the truth-seeded ORACLE 11/20. Verdict MODEST-SIBLING-LIFT -- neighbour-lock is only part of the P62 seed wall. The
  MASK arms use ground-truth sibling ephemerides, so they are an assisted ceiling, not a blind win.
- P74 multi-sector centroid consistency (`scripts/p74-centroid-consistency.ts` + reusable pure
  `multiSectorCentroidConsistency` in `src/detect/diffImaging.ts`, +7 offline tests): on 28 real SPOC targets, requiring
  the difference-image offset to point coherently across sectors removes all 9/16 single-sector known-planet false-kills
  but collapses blend power 50%->0% (AUC 0.495, chance). Verdict COHERENCE-SAVES-PLANETS-BUT-NO-POWER; safeToGate=false.
- P75 inverted-curve empirical FP rate (`scripts/p75-inverted-fp.ts`): the clean planet-free null P69 asked for -- invert
  a real curve, mask every catalogued planet (single sector, exact ephemeris), keep a positive transit-like residual dip.
  The AR(1) gate signs off 12/16 (75%) as significant vs the 5% it advertises; a model-free block bootstrap flags 5/16
  and overturns 7 (mean FAP delta +0.16). Verdict GATE-OPTIMISTIC-ON-REAL-NOISE; measured only, no threshold moved.
- P76 multi-source novelty (`scripts/p76-multisource-novelty.ts` + `CatalogKind` extended with `exofop`): adds the
  token-free ExoFOP TOI/CTOI table (8151 rows, FP/EB/KP labels) to P48's two Archive tables, with live controls on both
  paths. It moves 0/5 board candidates out of "novel" (shrink 0) -- the wider net confirms the positions are unannounced
  rather than hiding a CTOI. SPOC TCE and the literature remain uncovered. discoveryClaim/safeToGate false throughout.
- Dashboard/docs: `scripts/p38-research-bundle.ts` distills all four into `web/research.json` (a new
  `borrowedRoundP73P76` key) and `web/app.js` renders a "Borrowed from a real survey (P73-P76)" card; RESEARCH.md gains
  section 29. Two shareable figures added: `web/borrowed-figure.svg` (P73/P74) and `web/inverted-fp-figure.svg` (P75).

### Research -- five targeted follow-ups to the review (P67-P71), an offline-replay test, and a Launch-run fix (2026-10-15)
- P67 seed precision (`scripts/p67-seed-precision.ts`): does the production iterative detector clear the P62 "seed
  wall"? On the SAME 20 known planets, seed-hit is naive-peak 4/20 vs iterativeBls top-1 5/20 vs iterative top-3 5/20
  (refined re-find naive 4 / iter 5 / oracle 10). Verdict MODEST-SEED-LIFT: iterative extraction records only 0-1
  signals on these few-sector multi-planet hosts, so it barely beats a single peak -- the P62 bottleneck is CONFIRMED
  against the real detector, not a single-peak artifact.
- P68 discriminator ROC (`scripts/p68-discriminator-roc.ts`): P61 collapsed each vetting tool to one binary cut; this
  sweeps the FULL threshold (offline re-derivation of the committed P61 continuous metrics) with a Mann-Whitney AUC and
  best blend catch at a 0/5/10% false-kill budget. Best AUC 0.69 (shape-coherence); at zero false-kill no tool catches
  blends above chance (gaia-dilution 0.47, below chance). Verdict NO-GATE-CONFIRMED: the tools cannot self-validate,
  only rank -- softScore (P63) correctly stays advisory.
- P69 red-noise significance (`scripts/p69-rednoise-significance.ts`): compares the production AR(1)-model FAP to a
  model-free block bootstrap on transit-masked real residuals. 5/8 noise-like bumps clear FAP<0.05 under AR(1) but not
  under the model-free null (mean FAP delta +0.27); excessAtLastLag ~0, so it is NOT an active-star/long-memory effect.
  Verdict AR1-MODEL-NULL-TOO-PERMISSIVE -- a flagged calibration concern (re-tunes no threshold), with the masking
  confound recorded honestly.
- P70 LLM ablation (`scripts/p70-llm-ablation.ts`, models live): (1) removing the LLM changes ZERO decisions (verified
  by recompute -- verdicts come only from runHypothesisTest); (2) models called a labelled blend "planet" on 3/3 while
  the deterministic tests caught 1/3. Verdict LLM-DECISION-VALUE-ZERO: the model is a hypothesis broker, not an arbiter.
- P71 audit positive control (`scripts/p71-audit-positive-control.ts`): is P65's 0/2 a dead gate? Scoring the SAME
  detected candidate BLIND (catalog=[]) vs CORROBORATED (catalog=archive) on 14 known planets: BLIND 0/14 accepted,
  CORROBORATED 8/14. Verdict ACCEPT-PATH-REACHABLE -- the accept branch fires only when a genuine signal is corroborated;
  P65 caps novel claims at needs-more-data because it runs blind BY DESIGN, not because the gate is broken.
- Offline replay (`tests/offlineReplay.test.ts`): SHA-256-pins the 12 real-SPOC fixture curves and replays known-planet
  periods through the JS detectTransit chain with ZERO network (6/12 reproduce within 2%; determinism guard). npm test
  402 -> 405.
- fix(web): the header "Launch run" button now navigates to the Findings view first (the MISSION CONTROL form lives
  there and was display:none on the landing view, so the old scrollIntoView/focus was a no-op and the button looked
  dead). Backend /api/run was always healthy (200; 409 only while a run is genuinely active, with a 30-min stale guard).
  A second fix: setRunningUI no longer disables #run-btn while a run is active -- it is a pure navigation control, so an
  active OR zombie run greying it out made it look dead; only #run-submit reflects run state, and double-run safety stays
  server-side (409 + 30-min takeover), leaving the money path untouched.
- Dashboard: P67-P71 distilled into web/research.json (scripts/p38-research-bundle.ts) and rendered in the FP-control
  card; deployed and live-verified.
- Follow-ups figure (`scripts/p72-followups-figure.ts` -> `web/followups-figure.svg`): a shareable 2x3 panel synthesizing
  P67-P71. Re-derives ONLY numbers already published in reports/ (no network, no re-analysis, not read by the analysis
  core or bundle so hashes are unchanged); served as a static asset, byte-level ASCII clean, layout geometry-verified.

### Research -- LLM hypothesis closed loop, CI scaling, dashboard, and an English-only X auto-post channel (2026-10-14)
- P60 (`scripts/p60-joint-vs-single.ts`): joint multi-sector vs per-sector BLS re-find A/B on real curves --
  joint gives no detectability advantage over per-sector search; roadmap priority 1 closed negative.
- P62 (`scripts/p62-phase-aligned-joint.ts`): targeted mechanistic follow-up to P60 (the reviewer's phase-alignment
  fix) on the SAME 20 planets. Four arms: single 6/20, naive-joint 6/20, REFINED (per-sector seed -> narrow joint
  fold) 4/20 -- WORSE, and ORACLE (truth-seed ceiling) 10/20. Verdict `NO-LIFT-JOINT-NOT-A-FREE-LUNCH`: the
  long-baseline fold doubles re-find only with a correct period; a blind single-sector seed is usually the wrong
  period on multi-planet hosts, so seed acquisition (not the fold) is the wall. Written into RESEARCH limitations.
- `createSpocSectorFetcher` (`src/data/mastS3.ts`): one bounded pool + memo shared across TESS sectors for
  concurrent multi-sector fetch; `tests/mastS3.test.ts` asserts the concurrency cap.
- P61 LLM hypothesis closed loop (`src/ai/hypothesis.ts`, `src/detect/hypothesisTests.ts`,
  `scripts/p61-llm-hypothesis-loop.ts`, `tests/hypothesis.test.ts`): a model proposes a falsifiable hypothesis +
  picks a test from a strict whitelist menu; the rig runs it on real photometry and scores EVERY test as a 2x2
  (catch-rate on labelled blends vs false-veto on known planets) against ground truth from one token-free source
  (the ExoFOP TOI table). Six tests, incl. a PSF double-difference + Gaia-dilution check under `--deep`. The
  CI-published report at 24 planets + 18 blends gives `gateable-via-loop = NONE` (consistent with P53/P58/P59);
  the CI run is deterministic-2x2-only (no model keys in Actions secrets), so the audit is reproducible keys-free.
- CI: `llm-hypothesis-loop.yml` runs the loop at large N and publishes the report back to `reports/`;
  `veto-multisector.yml` extended to cover P60.
- Dashboard: the P61 2x2 is surfaced on the public research panel (`scripts/p38-research-bundle.ts` adds an
  `llmHypothesisLoop` section to `web/research.json`, rendered in the FP-control card); deployed (version
  ac190e4e) and live-verified -- research.json 200 with the section, discoveryClaim/safeToGate false.
- Docs (`CONTRIBUTING.md`): the LLM-injection -> opt-in-gate distinction, and an "adding a pXX study" guide.
- English-only, text-only X auto-post channel (`scripts/post-x-text.ts`, `.github/workflows/x-post.yml`): X API
  v2 with hand-rolled OAuth 1.0a; credentials read only from the environment, dry-run by default, refuses any
  non-ASCII. NOT enabled (no X API secrets configured). Uses the X platform API -- unrelated to the xAI/Grok key.
- P63 soft blend-likelihood score (`src/candidate/softScore.ts`, `src/critic/review.ts` `blendScore`,
  `scripts/p63-soft-score.ts`): the pixel/dilution vetting tools re-cast as a continuous 0..1 advisory score
  (never a hard veto -- they false-kill known planets, P57-P59); the critic consumes it as a bounded ranking
  downweight that cannot flip a verdict. Published false-kill rate (offline re-derivation from P61 metrics):
  28 labelled targets, mean 0.39 planets vs 0.50 blends, 50% of known planets flagged at the 0.5 cut -- advisory.
- P61 protocol extension: TEST_MENU grew 6 -> 9 (multisector-phase, common-mode-residual, dilution-prior),
  `p61` now feeds per-sector curves so multisector-phase is active; the CI-published report reflects it.
- P64 fetch telemetry (`src/data/mastS3.ts` `fetchStats()`, `scripts/p64-fetch-telemetry.ts`): measured the
  multi-sector helper cold vs warm -- download mean 1062 ms/sector; warm repeat sweep 100% cache hits
  (77 ms vs 7714 ms wall). Evidence for broad research use; production promotion stays a separate gated call.
- P65 external-candidate audit entry (`scripts/p65-external-candidate-audit.ts`): research-mode "submit a
  third-party claim -> run the full independent audit + mission-critic with current gates -> report pass/fail",
  not on-chain. Both sample external claims cap at rejected/needs-more-data, neither passes the accepted-only
  gate; discoveryClaim/anchored/safeToGate false.
- Milestone figure (`scripts/p66-milestone-figure.ts` -> `web/milestone-figure.svg`): a single shareable 2x2 panel
  synthesizing P62/P63/P64/P65. Re-derives ONLY numbers already published in `reports/` (no network, no re-analysis,
  not read by the analysis core or bundle so hashes are unchanged); served as a static asset, byte-level ASCII clean.
- Dashboard: P62 joint, P63 soft score, P64 telemetry and P65 external audit distilled into
  `web/research.json` (`scripts/p38-research-bundle.ts`) and rendered in the FP-control card.

### Science -- false-positive control (root cause)
- A systematics-inclusive null (`src/detect/instrumentalNull.ts`): the measured coherent common-mode template is
  injected into the phase-scrambled null, plus a Benjamini-Hochberg ensemble FDR. On 200 real TGLC curves (P39,
  CI-measured) it cuts raw false positives 61% -> 16% while the noise-only gate barely moves; under subtract-then-
  gate it keeps 100% of injected planets.
- Measure-before-gate safety certification (P40): over a 6x5 period-by-depth matrix the gate declined 0 of 40 real
  detections -> SAFE-TO-WIRE. The critic and the candidate contract accept an optional systematicsFap, but it is
  opt-in and inert (no live caller supplies a same-cadence ensemble), so the anchored verdict is byte-for-byte
  unchanged and nothing was enabled on the money path.
- P42 scales the control across 3 sectors (450 curves) with a threshold-free Mann-Whitney AUC and reports the
  honest bound: after common-mode subtraction the coherent null adds ~0 further discrimination (0.554 vs 0.550) --
  a zero-cost safety net, not a second win.
- P43 builds the sampling-window alias primitive (`src/detect/windowAlias.ts`) and measures it on 450 real curves:
  the 1 cycle/day spectral window is essentially closed on near-continuous TESS (median power 0.012), retiring a
  suspected false-positive driver with a clean negative result.

### Platform
- The public research dashboard (spacedatarig.app) now reports the false-positive control and its limits, not just
  wins; deployed and verified end-to-end (worker version swap; verdict/money-path logic unchanged).
- New CI publish-back workflow (`fp-scale`) re-runs P42 at scale; `instrumental-fp` re-runs P39. Test suite 285.

## v0.1.0

First tagged release of the reproducible exoplanet transit research rig.

### Platform
- Reproducible transit pipeline: NASA Exoplanet Archive + TESS candidates -> token-free TESS-SPOC
  public-S3 real photometry -> Box-Least-Squares detection -> exact limb-darkened depth/shape fit ->
  blind mission-critic -> sealed, reproducible result bundle.
- Runs identically on Node (local/dev) and Cloudflare Workers (production: Durable Object state,
  Workflows, R2 artifacts); live at spacedatarig.app on an hourly autonomous schedule.
- Content-addressed provenance anchoring to Solana mainnet for accepted findings, behind an explicit,
  budgeted switch.
- Deterministic, offline-safe core: fixed-seed pure functions; the full test suite plus Node and
  worker type-checks run on every push and pull request in CI.

### Science
- A pixel -> shape -> depth -> size -> error-calibration chain, reproduced on real confirmed planets.
- Exact limb-darkened transit fit and a per-candidate empirical false-alarm probability calibrated to
  each star's own noise color (quiet vs red-noise active hosts).
- Measured findings recorded honestly: the limb-darkening floor is not removable from the light curve
  (fitting u1 lowers rms but leaves true-depth error unchanged -> a shape degeneracy); statistical
  error bars under-cover and are brought to ~68% coverage only by an empirical inflation factor.
- Long-period depth accuracy is limited by phase coherence, not data volume: a robust per-sector
  median beats a naive multi-season long fold (measured 24.9% vs 34.7% median depth error, 18 planets).

### Independent review
- A reusable library to independently audit a THIRD-PARTY planet candidate: novelty vs the confirmed +
  TOI lists, Gaia host parameters and neighbour dilution / blend risk, a blind re-detection with the
  claim's ephemeris withheld, geometry self-consistency, unified significance, and a catalog version
  stamp. Research-only -- it never gates, accepts, or anchors.

### Robustness fixes
- Gaia `source_id` is cast to text at the query so IDs beyond 2^53 survive JSON parsing (previously a
  silently-rounded value produced a false "no such star").
- Per-sector robust depth is wired into the production scout step behind an explicit, default-off flag.
- A cadence-aware transit-box width is available opt-in; the default detector is byte-for-byte unchanged.

Safety: the rig measures and re-verifies. It makes no new-planet discovery claim, and any external
candidate it reviews remains attributed to its original author.
