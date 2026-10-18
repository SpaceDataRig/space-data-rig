# Response to the audit-10 review

This is a point-by-point, honest ledger of the eleven review items raised in the "audit-10"
pass and what was actually done about each. It is deliberately not a victory lap: every row
states the *residual risk* that remains, and items that were not done, or could not be done in
this environment, say so plainly. Numbers quoted are from committed reports only.

Legend for status:
- **Shipped** -- implemented, verification gates pass, committed to `main`.
- **Deploy-pending** -- merged on `main`, but only takes effect in production once deployed.
- **Shipped + mainnet-proven** -- deployed to production AND its effect observed live (an on-chain anchor paid / a fee saved), not just merged.
- **Blocked** -- cannot be completed in this environment; the reason is stated.
- **Partial / by-design** -- done, but the honest ceiling is recorded rather than oversold.

> **Deployment status update (audit-6, 2026-10-16).** Every row still marked *deploy-pending* below has since
> gone live: the Web assets and the Worker are both deployed at Workers version `f4dfb1a9` on
> spacedatarig.app, verified on the live site (`/api/events` returns 426 to a plain GET, the legacy-card relabel
> fires 4/4, and the autonomous `surveyPass` counter advanced 0->1). The `scienceHash` dedup is not merely
> deployed but **mainnet-proven**: re-running the F-HR-858-b/c/d trio (one detection under three catalog labels,
> which now collapses to a single `scienceHash`) paid exactly ONE anchor fee for `F-HR-858-b` and de-duplicated
> `c` and `d` against it -- two mainnet fees saved, the precise cost the audit-3/audit-4 rows were written to
> prevent. Those two rows are updated inline to *Shipped + mainnet-proven*; the remaining deploy-pending markers
> are superseded by this note.

| # | Criticism raised | Fix | Verification | Residual risk |
|---|---|---|---|---|
| 1 | A single bundle hash conflates a timestamped commitment with a content address, so the same science re-run "changes its hash" and looks unreproducible. | `hashScience()` normalises `createdAt`/`runId` out; new memos append a stable `scienceHash` alongside the existing `bundleHash`. Old anchors stay byte-identical. | `tests/core.test.ts` (+3); verification still matches on the `bundleHash` substring. Commit `7887121`. | **Deployed** (version c9af4564): live on spacedatarig.app; affects only *new* anchors, historical memos carry no `scienceHash` by design. |
| 2 | The P81 report could turn "Gaia unavailable" into a silent NaN, and treat a physically impossible de-diluted depth as a real planet. | `undetermined` census state (not NaN); `depthPhysicallyInconsistent` (>10% depth) is excluded from the graded ratio but kept as blend-contradiction evidence; the denominator is written into the verdict. | `tests/triceratopsLite.test.ts`; `reports/p81-triceratops-lite.{md,json}` regenerated under the guardrails. Commits `47e5701`, `3ee17e5`. | The depth cap is a documented physical guard, not a calibrated astrophysical prior; a genuinely extreme-but-real source would be filtered out. |
| 3 | TRICERATOPS-lite should be cross-checked against the official tool. | Re-implemented the blended-FPP maths natively (`daveBlendedFpp`) and unit-tested it; a real Python cross-check harness runs in CI (`.github/workflows/crosscheck-python.yml`: `pip install wotan astropy batman transitleastsquares` -> `scripts/cross_pipeline.py`). | Native FPP tests pass; the Python cross-pipeline runs on GH runners. | **Partial (corrected 2026-10-16).** Our earlier "Blocked: no Python here" was wrong -- runners *do* have Python/pip, and a detection-side Python cross-check already runs in CI. What has NOT been done is an end-to-end run against the **official TRICERATOPS package**; the real blocker is that tool's own `starfield`/POPS stellar-density dependency and its heavier install, not the absence of Python. The native reimplementation is self-consistent, not yet third-party-validated. |
| 4 | The centroid F-test caught only 2/6 expected blends -- is that a statistic problem or a coverage problem? | `scripts/p84-centroid-diagnosis.ts` splits COVERAGE (never localised) from POWER, reading the P82 checkpoint. | `reports/p84-centroid-diagnosis.{md,json}`; commit `70578d5`. | **Partial / by-design.** Root cause is pixel-baseline-bound (71% of targets never localise), not the F-test; a bigger sample narrows the bar, it does not remove the ceiling. |
| 5 | The P80 headline silently selected its easiest subset -- an unstated selection effect. | Report names its easiest subset (depth>=3000 ppm / Tmag<=11) as the headline and shows a harder 300-1000 ppm tier alongside, even where that tier scores 0/N. | `scripts/p80-external-validation.ts`; commit `4061b0f`. | The headline rate is explicitly the easiest-subset rate, **not** a population-wide completeness; the hard tier is honestly weak. |
| 6 | The inverted / masked planet-free null was a one-off script, not a reusable, testable product. | Extracted `src/detect/invertedNull.ts` (invert-about-median + mask catalogued transits), unit-tested; README now leads with the P75 finding. | `tests/invertedNull.test.ts`; README lead; commit `68802bb`. | Small calibration sample (n=16); the AR(1) gate flags 75% of pure-noise bumps vs a nominal 5% -- reported, re-tested, deliberately *not* silently recalibrated. |
| 7 | Admin mutations were not deny-by-default, and a same-run re-entrant anchor could double-spend SOL. | `isAdminAuthorized` returns false when no token is set; a per-finding in-flight lock serialises `anchorFinding`; the abuse-brake counters moved from per-isolate to a `RateLimitDO` (global across isolates, local fail-open fallback); `SECURITY.md` published. | `tests/auth.test.ts` (default-deny); commits `c905d3f` + `34e93b8`. | **Deployed** (version c9af4564): verified 401/401/404/200 on the live site behind `ADMIN_TOKEN`; the dashboard prompts for the token on a 401. |
| 8 | Upstream schema/behaviour drift (NASA, ExoFOP, Gaia) is a silent science bug with no early warning. | `scripts/p8-live-probe.ts` issues the smallest real read-only query to each upstream and asserts consumed fields + row counts; weekly workflow opens an issue on a hard fail. | Local smoke: PASS on all three (NASA 1569 rows, ExoFOP 8152 lines, Gaia 5 rows, `source_id` string). Commit `9c857d4`. | A transient network error is *not* an alarm by design (exit 2, no issue); the probe checks shape/counts, not scientific correctness. |
| 9 | The money-adjacent send path had no CI integration test. | `scripts/p9-anchor-live-verify.ts` re-reads recent mainnet anchors keylessly and confirms each memo still contains its bundle hash; daily workflow. | Smoke: 3/3 recent anchors verified from-chain. Commit `1896fbf`. | Read-only: it proves past anchors still resolve, not that a *new* send succeeds; public-RPC rate limits can make a run INCONCLUSIVE (non-alarm). |
| 10 | No written, itemised audit response; the README is too long for a landing page; the repo description said "five-seat AI". | This document; a one-page "At a glance" block added at the top of the README, with the detailed long-form kept below as auditable context. | This file + README. Commit: this change. | **Partial.** The full long-form README is intentionally *kept* (it is audited, honest documentation) rather than deleted to force a literal one page; only a summary was added up front. Say the word for a hard cut. |
| 11 | CI did not fail on lint warnings, and line coverage alone hides untested branches. | `npm run lint` -> `eslint --max-warnings 0` (0 warnings tree-wide); coverage now enforces `--test-coverage-branches=75` alongside lines. | `npm run lint` exit 0; `npm run test:coverage` exit 0. Coverage is Node-version-dependent (V8 instrumentation differs slightly per runtime): originally measured line 95.8 / branch 80.4 / fn 91.8; an audit-4 re-measure on Node 24.15 got line 95.31 / branch 79.82 / fn 90.98 -- both clear the 85 (line) / 75 (branch) floors. The gate enforces FLOORS, not exact values, precisely so a ~0.5pp runtime wobble cannot turn it red. Commit `500a986`. | Research scripts under `scripts/**` keep a scoped override (no `any`/unused-var rules) -- deliberate for exploratory tooling; production `src/` and `tests/` stay strict. |

## Third-round (audit-3) follow-up

A later independent review confirmed 8 of the 11 audit-10 items were genuinely fixed and flagged
three that were *done but only half-done*, plus two new defects. Those are the focus here; the
remaining surface area is design/method work, not a patch, and is recorded as such rather than
pretended away.

| Item | What the review found | What was actually done | Verification | Status |
|---|---|---|---|---|
| Defect A - two ends, one memo shape | `scienceHash` was computed on the Worker path but the on-chain tx was still built 3-field, so the content address reached *neither* runtime's chain record. Node memos and Worker memos were not the same shape. | Threaded `scienceHash` through the single shared submit primitive `anchorOnEndpoints`, so Node (`anchorBundleHash`) and Worker (`anchorFinding`) build the identical memo. | `tests/core.test.ts` contract test (Node dryRun forwards `scienceHash` end-to-end; 3-field case unchanged). Commit `f34d672`. | **Shipped** (deploy-pending for new anchors). |
| Defect / cost - identical science re-anchored 3x | Re-running byte-identical science yields a new timestamped `bundleHash`, so the exact-hash guard missed it and paid a second/third mainnet fee (observed: 3 txs for one content). | Dedup by `scienceHash` before spending (`findAnchoredScience`, pure + runtime-agnostic); `scienceHash` persisted on the ledger. We deliberately do NOT copy a foreign signature onto the card, so the anchor-stamp invariant holds and the card stays honestly un-stamped. | `tests/core.test.ts` (+1 predicate test); commit `9dcf908`. | **Shipped + mainnet-proven** (deploy `f4dfb1a9`): the F-HR-858-b/c/d trio collapsed to one `scienceHash`, so `b` paid a single anchor fee and `c`/`d` de-duplicated against it -- **2 mainnet fees saved**. |
| Defect B - legacy CONFIRMED cards | Bundles are immutable, so pre-policy cards still render their stored "Confirmed:" headline -- older records looked *more* overclaiming over time. | Render-layer **derived relabel** (not a history rewrite): a card whose stored headline says "confirm" AND predates the policy date gets a visible "injection-recovery, not confirmation" note. Rule documented in README + guarded by a drift test. | `tests/projection-relabel.test.ts`; `node --check web/app.js`. Commit `be553ed`. | **Shipped** (web asset; deploy-pending to reach the site). |
| Defect C - rate limiting was per-isolate + fail-open | The review (correctly, for its snapshot 584c1e47 @ 00:32Z) found the abuse-brake counters were per-isolate fixed-window with fail-open, so cross-instance they gave each cold isolate its own budget. | Remediated ~23 min AFTER that snapshot, NOT before it: commit 34e93b8 @ 00:55Z (its own subject is "Audit-10 #7 residual") moved the counters into a global `RateLimitDO` (`src/cf/rate-limit.do.ts`) -- a Durable Object with pure **in-memory** counters (a `Map`, reset on DO eviction), NOT SQLite-backed -- keeping the per-isolate limiter only as a fail-open fallback if the DO call itself errors (an availability choice, documented). **Ledger correction (audit-4):** this row previously read "already remediated before this review's snapshot" and called it "global SQLite"; both were wrong and are fixed here. | Live code: `worker.ts` `rateCheck` calls the `RIG_RATELIMIT` stub first; `wrangler.toml` declares the DO via `new_sqlite_classes=["RateLimitDO"]` (the migration key this account requires for ANY new DO -- it does not mean the counters use SQLite); deployed in version c9af4564. Commit 34e93b8. | **Shipped + deployed.** Fail-open on DO transport error is deliberate (throttling must not take the site down); the counter is global across isolates but in-memory, so it resets when the DO is evicted -- an abuse brake, not a durable quota. |
| #10 / P1 - probe exists vs probe works | The weekly live-probe had never been shown to actually *alert*; a mechanism that exists is not one that works. | Split each probe into fetch + pure `judge`; added a `--self-test` that drives drifted fixtures through the real detection logic and asserts the alert exit code; 5 offline tests in `npm test`. | `tests/live-probe-drill.test.ts`; `npm run p8:live-probe -- --self-test` exit 0. Commit `97cddc6`. | **Shipped.** |
| #3 mislabel | "Blocked: no Python" was false -- CI runners install Python. | Corrected the ledger to **Partial**; the real blocker is the official TRICERATOPS `starfield`/POPS dependency, not Python. | This file. | **Corrected.** |
| 0/56 blend catch | Not a tuning gap -- pixel-baseline-bound; the current method cannot resolve blended (multi-source-per-pixel) scenes at all. | Recorded explicitly as a **capability boundary** in README (see "Capability boundaries"), not chased with a threshold. | `reports/p84-*`, `reports/p85-*`. | **By-design limit.** |
| $SDR payment layer | Repeatedly flagged as the least-coherent part of a "verifiable science" project. | Kept **isolated and explicitly non-scientific**: no verdict, `bundleHash`, or discovery claim reads from it; it is a separate commercialisation experiment. Restructuring/removal is an owner business decision, not a code patch, so it is *named*, not silently mixed into the science claims. | (positioning, no gate change) | **Open decision.** |

## Cross-cutting honesty

- **No discovery claim.** `discoveryClaim` stays false and `safeToGate` stays false across every
  report; the 42% accepted-precision wall, the strict grade-1 1/234 and grade-5 5/179 external
  numbers, and the 0/56 blend catch are reported as-is, not as findings.
- **Measure-before-gate.** None of these changes moved a production threshold, flipped a verdict,
  altered a historical `bundleHash`, or touched the money path. The two items that would
  (`#1`, `#7`) are now **deployed** (version c9af4564) and were verified against the live site.
- **Environment limits stated.** `#3` is **Partial**, not done: an official end-to-end run against
  the reference TRICERATOPS package has not been performed. We corrected an earlier mislabel here --
  the blocker is that tool's `starfield`/POPS dependency and install, *not* "no Python" (CI runners do
  have Python, and a detection-side Python cross-check already runs in `crosscheck-python.yml`).
  The GitHub repo "About" description (an owner-only setting, no `gh` CLI here) still carries the
  older "five-seat AI" phrasing; the README now leads with "five-stage deterministic pipeline" but the
  repo field itself must be edited by the owner in Settings.

## Fourth-round (audit-4) follow-up -- the "deployed but never fires" class

A fourth independent review re-tested the audit-3 fixes ON THE LIVE SITE and surfaced the most
important problem yet: two of the three audit-3 "fixes" were correct code, passed their unit tests,
and were deployed -- yet never took effect on real data. Both failed for the same reason: something
that was not "the science" had been folded into a hash. This is a new failure class for this repo --
not "not done", not "half done", but "done, shipped, green, and inert".

### Cross-round comparison: raised before, only now truly closed

The instruction was to compare against prior rounds and fix, AT THE ROOT, the problems that keep
recurring. Two do. Both were "fixed" in audit-3 and both were still broken in audit-4:

| Root problem | audit-3 "fix" | audit-4 finding | Root fix now | Proof on real data |
|---|---|---|---|---|
| Identical science anchored 3x (repeat mainnet fee) | `scienceHash` dedup (`findAnchoredScience`, commit 9dcf908) | DEAD CODE. `hashScience()` was `{ ...manifest, createdAt:"", runId:"" }`, so it still folded in `findingId`/`targetId`/`artifacts`/`dataProvenance`. The live F-HR-858-b/c/d trio (ONE detection re-run under three catalog labels) produced THREE distinct hashes and never collided -- three fees for one content. | `scienceProjection()` hashes ONLY the blind science (candidate/verdict/verdictReason/recoveryConfidence/aliasMultiple/ephemeris/crossmatch + the GATING checks); identity, label, time, render and fetch fields are excluded. `computeDataHash()` no longer hashes `targetId`. | `tests/live-data-regression.test.ts` drives the REAL captured trio: 3 distinct scienceHashes -> 1. Distinct findingIds/targetIds/artifacts are asserted first, so the collapse cannot be a fixture artifact. |
| Legacy "Confirmed:" cards never re-labeled | render-layer relabel (commit be553ed) | OFF-BY-ONE-DAY. The predicate used `created < "2026-10-12"`, but all four live legacy cards were created ON 2026-10-12, so it matched ZERO cards. Its test only string-matched app.js source, so it stayed green. | Boundary is now `<=`; the predicate is extracted to `web/relabel.js` and imported by BOTH `web/app.js` and the tests, so the browser and the test run the SAME function. | The same regression test runs the predicate over the captured /api/state snapshot and asserts all four real cards (GJ 1214 b, KELT-9 b, HD 189733 b, WASP-121 b) are annotated, and that the boundary-day non-confirm card (HAT-P-11) is NOT. |

The common meta-pattern across three rounds is the one audit-3 Defect A already had (scienceHash
computed but never reaching the chain): a value is COMPUTED and UNIT-TESTED on a hand-built stub, so
the test proves the FUNCTION exists and returns the right shape -- never that the PRODUCTION RECORDS
flow through it correctly. Both audit-4 bugs are exactly this.

### The root gate this round adds: live-data regression tests

The fix is not "patch two lines" but "add a class of gate that makes this bug impossible to ship
again". `scripts/capture-live-fixtures.ts` (`npm run fixtures:capture`) snapshots the real public
/api/state findings and the real stored manifests into committed fixtures; `tests/live-data-
regression.test.ts` then drives the ACTUAL production predicates (`hashScience`, `scienceProjection`,
`findAnchoredScience`, `headlineRelabelNote`) over those real bytes. Re-add an identity field to the
science hash, or flip the relabel boundary back to `<`, and these fail on the real records -- which
is precisely what the old stub tests could not see.

### audit-4 point-by-point

| Item | What the review found | What was done | Verification | Status |
|---|---|---|---|---|
| 1 - scienceHash dedup dead | `hashScience()` folded identity/label/render/fetch fields into the content address, so identical science under different labels never collided; three mainnet fees for one content. | Rewrote it as `scienceProjection()` (blind science only) and removed `targetId` from `computeDataHash()`. | Real captured trio collapses 3->1; existing `tests/core.test.ts` cross-run stability still green. | Shipped + mainnet-proven (deploy `f4dfb1a9`): live trio collapsed to one `scienceHash`; `F-HR-858-b` paid one anchor fee, `c`/`d` de-duplicated -- 2 fees saved. |
| 1b - the audit's own field list was incomplete | The suggested projection INCLUDED `checks`. | Measured on the real manifests: `checks[6]` "period-vs-truth (post-hoc, non-gating)" differs per label (0.05% / 39.95% / 68.06%), so including `checks` verbatim would have kept the dedup dead. The projection filters non-gating/post-hoc checks and keeps the 8 gating ones. | The regression test asserts the raw `checks` arrays differ AND that no post-hoc check survives into the hash. | Shipped -- measuring the real data CORRECTED the recommendation. |
| 2 - relabel off-by-one | Strict `<` boundary matched zero live cards; the test only string-matched source. | `<=` boundary; predicate extracted to `web/relabel.js`; `tests/projection-relabel.test.ts` rewritten from string-matching to BEHAVIOUR (feeds createdAt=2026-10-12T16:00:50 + "Confirmed:" and asserts the note). | 9 behaviour/structural tests + the live-snapshot assertion (4/4 legacy cards). | Shipped (web asset; deploy-pending). |
| 3 - dedup reported as failure in the UI | The DO honestly returns `{ok:true, deduplicated:true, dedupOf}` with no signature, but app.js had no dedup branch, so `res.ok && res.signature` fell through to "anchor failed" -- the operator was told a cost-saving success had failed. | Added a `deduplicated` branch: shows "no new tx -- identical science already anchored as <id> (<tx>)", button reads "Deduplicated". Deliberately does NOT stamp the foreign signature onto this card (anchor-stamp invariant). | `node --check web/app.js`; render logic mirrors the DO contract. | Shipped (web asset; deploy-pending). |
| 4 - GET /api/events returned 500 | The worker forwarded a plain GET with an injected `Upgrade: websocket` header, so the DO's correct 426 branch was unreachable and any scanner could raise a Worker exception. | The worker now checks the `Upgrade` header first and returns 426 for a non-WebSocket request; the DO 426 branch stays as defence-in-depth. | `typecheck:worker`; a live curl after deploy must show 426. | Shipped (deploy-pending). |
| 5 - same curve fetched 3x per run | One run re-downloaded the identical light curve for each catalog row on a star (three dataHashes = three fetches). | Added an optional run-scoped BYTE cache to `fetchSpocBytes` (keyed by S3 key = tic+sector, never the label) + a per-run sector memo in the workflow. Caching BYTES (not the labelled curve) means each row still parses its own targetId. | `tests/mastS3.test.ts`: one download serves several rows, each with its OWN label; no cache => old behaviour. | Shipped (deploy-pending). After fix 1 this is a pure latency/GET saving -- the scienceHash jitter source was already removed. |
| 6 - Defect C history wording | The ledger said Defect C was "already remediated before this review's snapshot" and called it "global SQLite RateLimitDO". Both were wrong. | Corrected in the Third-round table: remediated ~23 min AFTER the audit-3 snapshot (34e93b8 @ 00:55Z vs 584c1e47 @ 00:32Z, subject "#7 residual"); a global DO with pure in-memory counters (reset on eviction), not SQLite. Coverage values now carry their Node-version caveat. | GitHub compare API timeline; `wrangler.toml` ("Pure in-memory counters (no SQLite)"); `rate-limit.do.ts` (`new Map`). | Corrected. |
| P85 contaminant fit | The review called `reports/p85-contaminant-fit.md` the most publishable artefact yet: it explains WHY 0/56 is a coverage wall + a "target must be rejected first" rule, not a broken statistic. | Recorded as the recommended short-paper body; no threshold was moved to chase the number. | `reports/p85-contaminant-fit.{md,json}` (commit b8dad16). | By-design limit, explained. |
| $SDR | Still the one open reputational item. | Kept isolated and explicitly non-scientific: no verdict, `bundleHash`, or discovery claim reads from it. Restructuring/removal is an owner business decision, so it is named, not silently folded into the science. | (positioning, no gate change) | Open decision. |

### Honesty note on this round

The two inert fixes were shipped under a ledger that said "deployed". They were deployed; they were
also ineffective, and the ledger could not see that, because the tests asserted stubs. The
reviewer's diagnosis is accepted in full: speed slightly outran verification. The correction is
structural, not a promise to be more careful -- from now on a render/dedup predicate ships with a
test that runs the REAL captured production records through the REAL function.

## Fifth-round (audit-5) follow-up -- the catalog looked static

A reader asked: "Why does the frontend always show the same handful, and is the project even working? The
audience cannot feel what we do." This was not a false claim to walk back -- it was a legibility and breadth
failure, and the honest answer required first finding the real mechanism, then fixing it without re-introducing
the overclaiming the earlier rounds removed.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| Catalog never grows | The autonomous survey selected the brightest N KNOWN planets (`pscomppars`, tmag-sorted) every pass, and `findingId` is deterministic (`F-<target>`) + `recordFinding` is `INSERT OR REPLACE`, so each pass overwrote the same rows -- it churned in place. | The autonomous run now ROTATES a broad real pool (known re-validation + UNCONFIRMED TOI) chosen from a persisted pass cursor (`src/survey/rotation.ts`, `surveyPass` in DO meta, advanced once/pass, idempotent by runId). Gated by `AUTO_RESEARCH_ROTATION`; manual runs stay deterministic top-N. | `tests/rotation.test.ts`: windowing is deterministic, wraps, and covers a 50-pool in ~7 passes; live counters (`surveyPass`/`distinctHosts`/`blindCandidates`) surface in /api/state. | Shipped (deploy-pending). |
| "Is it even doing anything?" | The genuinely novel work -- blind recovery of unconfirmed candidates -- ran only offline (p5/p7: 27/70 recovered blind), never in the live catalog. | Wired the real TOI table (`src/data/toiArchive.ts`) into the SAME 5-seat pipeline: `toiToArchivePlanet` runs each TOI through real SPOC fetch + BLIND BLS (ephemeris withheld). A TOI with no downlinked photometry is SKIPPED, never synthesized. | `tests/rotation.test.ts` proves the field mapping (pl_trandep stays ppm) and the blind-TOI verdict ceiling. | Shipped (deploy-pending). |
| Danger of reading growth as "discoveries" | A bigger, livelier catalog could be misread as claiming new planets. | `Finding.origin` labels every row (`revalidation` vs `blind-toi`); `critique()` caps a blind-TOI at `needs-more-data` even when the evidence would accept; the auto-anchor branch also refuses `origin==="blind-toi"`; the UI shows a gold "BLIND CANDIDATE - UNCONFIRMED" pill + filter chips. `origin` is NOT in the bundle manifest, so no hash/anchor moves. | `tests/rotation.test.ts`: two findings identical except `origin` compose to the SAME bundleHash and the manifest carries no origin key. | Shipped (deploy-pending). |

### Honesty note on audit-5

The temptation with "make it look alive" is to inflate. The guard against that is structural, not a promise:
the only new row type that could read as a discovery (blind-TOI) is capped below `accepted` in the
runtime-agnostic critic AND blocked from the anchor branch in the workflow, and `origin` cannot reach the
manifest -- proven by a test that composes two identical findings differing only in `origin` and asserts
byte-identical hashes. What changed is breadth and legibility; the no-discovery red line and every existing
anchor are untouched.

## Sixth-round (audit-6) follow-up -- "fixed, but not re-run; re-run, but not published"

The sixth review confirmed the audit-5 rotation is live in production (surveyPass climbing, 27 blind-TOI
hosts, red line 2 holding -- 0 accepted / 0 solanaTx among blind rows) and that the content-addressing
fix from round 5 is writing on-chain. Its central finding was the most serious yet, and it is a NEW domain
of the SAME failure class seen across rounds: round 1 was "computed but not anchored", round 4 "deployed
but not in effect", this round "fixed but not re-run -- and re-run but not published".

### The blast radius of the right-ascension unit bug was under-stated

`parseRa` returned sexagesimal HOURS as DEGREES, so every host was squeezed into a 0-24 deg RA band. The
fix (`d306ce6`) touched only research code -- `src/` running path has ZERO references, so PRODUCTION was
never affected -- but 10+ research scripts import it, and the P82 centroid probe (`p82-scaled-validation.ts`)
writes the `out/scaled/centroid.jsonl` checkpoint that P84 AND P85 both consume. The auditor correctly split
the P85 numbers into two classes; we re-ran on the corrected sky and confirm the split:

| P85 / P84 quantity | class | pre-fix (wrong sky) | post-fix (re-run) | trustworthy? |
|---|---|---|---|---|
| testable (>=2 localised sectors) | pixel offsets only | 109/500 | 114/500 | yes (moved only with cube-fetch re-run) |
| never-localised coverage wall | pixel offsets only | 391/500 (~78%) | 386/500 (~77%) | yes |
| known-planet false-reject (calibration arm) | pixel offsets only | 1/53 | 2/55 | yes -- still the low arm |
| blend caught | **Gaia neighbour census** | 0/56 | **0/59** | was NOT valid pre-fix; now re-measured |
| "a neighbour explains the mean" | **Gaia neighbour census** | 54/56 | **49/52** | was inflated by querying the wrong field |
| viableNeighbours denominator | **Gaia neighbour census** | 56 | 52 | only meaningful post-fix |

The qualitative conclusion is unchanged (blends are pixel-baseline-bound and out of scope), but every
Gaia-derived figure cited before the fix was measured against an unrelated sky. The 54/56 -> 49/52 drop
confirms the suspicion that "in a random field you can always find a directionally-close star" had been
padding the number. README "Capability boundaries" now states both classes and withdraws 0/56 / 54/56.

The deeper problem the auditor named -- and fixed structurally -- was that NOTHING in the committed report
said WHEN it was generated or FROM WHICH input, so no one (including them) could tell a pre-fix report from
a post-fix one, and the PUBLIC site (web/reports) was still serving the pre-fix P81 "contradictions (4)"
while the repository md already said 0.

| Concern | Root cause | What was done | Verification | Status |
|---|---|---|---|---|
| Reports carry no provenance; stale numbers published on the site | `reports/*.json` had no timestamp/git-SHA/input-hash; `web/reports` was a hand-run build that could lag the repo md indefinitely. | `scripts/report-freshness.ts` stamps every regenerated report with `generatedAt` + `gitSha` + `inputs:[{path,sha256}]`; `p86-report-library.ts` re-hashes each recorded input before publishing and, on a mismatch, marks the fragment RED, flags it in `index.json`, and EXITS NON-ZERO so the deploy refuses to ship stale numbers. (Wall-clock heuristics were tried then dropped -- they false-positive on unrelated edits.) | `tests/report-freshness.test.ts` (offline, injected hashes): tampered input -> stale, matching -> authoritative, vanished gitignored checkpoint -> not blocking, legacy unstamped -> visible-not-stale. | Shipped (deploy-pending). |
| The stateful path that froze the survey had zero tests | `RigStateDO` imports `cloudflare:workers` so it cannot be loaded by the Node runner; `startRunIfIdle` -- the only broken path -- was the only untested one, and CI stayed green through a 22-hour freeze. | Extracted the claim/advance/finish decisions into `src/cf/run-mutex.ts` (CF-free, the precedent of `src/survey/rotation.ts`); the DO's `startRunIfIdle`/`advanceSurveyPass`/`finishRun` now delegate to it, so the test drives PRODUCTION logic. | `tests/run-mutex.test.ts`: claim advances the cursor exactly once, live claim -> 409 (no double-advance), stale takeover, zombie finish cannot release a successor's slot, resume reuses runId. | Shipped (deploy-pending). |
| The freeze was found by "the feed stopped posting", not by a gate | No check asserted the survey was actually progressing. | Added a SURVEY-PROGRESS assertion to the weekly live-probe: between consecutive runs `surveyPass` MUST increase and `distinctHosts` MUST NOT decrease, else FAIL (open issue). Previous sample carried across runs via Actions cache. | `tests/live-probe-drill.test.ts` + `p8:live-probe -- --self-test`: frozen/regressed -> FAIL, progress/baseline -> PASS, bad stats never silently ok. | Shipped (deploy-pending). |
| P88 could be read as "already cross-matched with Gaia" | `periodMatched=0` sat in the body; the title said "first INDEPENDENT-instrument 2x2". | Retitled the report and promoted a headline line stating the run measured independent-instrument COVERAGE (Gaia present for 6/17), NOT a Gaia-vs-TESS period crossmatch -- with 0 period matches the 2x2 is all-zeros by construction. | Committed `reports/p88-independent-corroboration.md`; note the run post-dates the RA fix, so 0 was a real coverage result, not a coordinate artifact. | Shipped. |
| Over-claim protection now rests only on wording (the fixed stamp was removed) | No independent check that the final string stays honest across every tier + the new build-note layer. | Added `overclaimViolations(text)` (hedge-aware: negated forms are honest, bare affirmatives are not) as BOTH an offline assertion across every tier AND a runtime refusal in `post-x-text.ts` that blocks any over-claiming send. | `tests/science-digest.test.ts`: every tier's composed text is clean; an accidental "discovered / confirms / first" template edit trips it; honest negations do not. | Shipped (deploy-pending). |

### Honesty note on audit-6

The small deviation the auditor flagged -- the plan said blind-TOI rows are "always needs-more-data" but the
implementation also allows `rejected` (13 of 27) -- is intentional and MORE honest (critic-rejected jitter
should not be filed under "awaiting follow-up" to pad the count); the docs now say so. P59/P81 re-runs are
recorded here for the first time; they were run in commits `55f4cee`/`22e491d`/`7c0bbc5` but had never been
entered in any ledger. No discovery is claimed anywhere; the no-discovery and no-unsupervised-spend red lines
are unchanged, and every historical anchor/hash is untouched because none of this round's code reaches the
manifest.

## Seventh-round (audit-7) follow-up -- "can you verify a claim like this", and what each public number counts

The operator pasted a widely-shared post -- "JUST IN: NASA's James Webb Space Telescope detects a mysterious infrared
light signal emanating from a seemingly empty void in space" -- and asked whether the rig can verify phenomena like it.
Two things came out of answering honestly rather than reassuringly.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| The rig's detector cannot see the claim at all | It is a broadband optical (0.6-1.0 micron) transit finder; the claim is a narrow ~1.6 micron emission line from a spectrograph, with no ephemeris and no catalogue id for BLS to fold. There is nothing to re-measure. | Built `src/claims/claimReview.ts` (pure, network-free) + `scripts/p91-claim-provenance.ts`: instead of pretending to check the SKY, it checks the CLAIM's structure on five axes -- subject (does the resolved primary say what the post says), recency (does "JUST IN" survive the primary's own date), attribution (does the post cite anything persistent, and does that id resolve), band (is the wavelength inside our reach), corroboration (could this rig in principle bear on it). Identifiers the POST cited are kept separate from ones the reviewer LOCATED, so our diligence is never read as the poster's. | `tests/claim-provenance.test.ts` runs the fixture (positive + three negative controls) through the rules offline and asserts each declared tier; the script re-checks the same grid against the live Crossref/arXiv resolvers, and offline-vs-live verdicts are identical. `safeToGate` is false on every row; no discovery wording is emitted. | Shipped. |
| A verifier that has only ever been shown correct inputs is not trusted | The first fixture pass caught two of its own false alarms: it invented "4.4 micron" (the abstracts say 1.60), and its "wrong telescope" control named Hubble -- which is IN this paper's own abstract, so the control passed for the wrong reason. | Corrected the fixture against the real records; switched the negative control to an observatory absent from the record (Chandra); made `extractMicronBand` read the LaTeX/Crossref unit spellings the resolvers actually serve (`1.60 $\rm um$`, `1.60 u m`) and refuse to invent a band from a flux exponent (`2.5x10^-18`) or a stray `cm`. | The control grid now fails loudly if a rule changes direction: the positive control must come back CITES-PRIMARY / NO-TIMING-CLAIM (a verifier that only complains is caught), the dead-DOI control must report CITATION-DOES-NOT-RESOLVE and never "no such result", and the retrospective control must stay silent on timing. Offline and live agree. | Shipped. |
| The dashboard's "blind candidates" tile over-counted | `blindCandidates` counted EVERY `blind-toi` row including the ones the critic REJECTED as noise, while the X digest deliberately counted only surviving ones -- one phrase, two populations, neither surface saying which. Production showed 47 on the board where the feed's honest figure was 26 (21 rejected). | Split into `blindHeld`/`blindCandidates` (held-for-follow-up over assessed), centralised the predicate in `src/core/stats-definitions.ts` so the Durable Object's SQL, the Node mirror and the digest all call `isHeldBlindCandidate`, and made the board render both. Also fixed two adjacent mislabels: `surveyPass` is passes CLAIMED (not completed), and `distinctHosts` is hosts with a RECORDED RESULT (not targets analysed). | `tests/stats-definitions.test.ts` (9 tests) runs the DO's actual SQL against real `node:sqlite` rows and asserts it matches the JS predicate, pins that the digest no longer keeps a hand-written copy of the filter, and checks the served markup carries each definition on hover. | Shipped (deploy-pending). |
| The deploy window was planned from an unmeasured cadence | The working belief was "a pass takes ~45 minutes and leaves seconds of idle", so every deploy felt like squeezing into a narrow hole -- and the two bad outcomes are exactly what happened: uploading inside a live pass, or waiting for a hole that was never there and leaving production stale. Measured: cron every 15 min, full-pass write span median 260 s (164-307 s) over 24 recorded passes, median idle between passes ~2400 s. | `src/deploy/deployWindow.ts` (pure) + `npm run deploy:window`: GO only when no claim is live AND the idle left before the next cron boundary covers the upload budget; the stale-claim threshold is IMPORTED from the DO's own `isStaleClaim`, and an unreachable rig is UNKNOWN/exit 2, never a reassuring GO. | `tests/deploy-window.test.ts` (10 tests): live claim WAIT / idle GO / near-boundary WAIT / stale claim free / missing state UNKNOWN, boundary math incl. hour roll-over, clustering yields no invented cadence from <2 rows, stale threshold equals the DO's, and the script delegates rather than reimplementing. | Shipped. |
| A governance rule lived only in prose | GOVERNANCE.md states commits are co-signed and HANDOFF documents the trailer -- two commits this pass were pushed without it, with every other gate green, because nothing looked. | `tests/commit-co-sign.test.ts` checks the HEAD commit for the co-sign trailer and the labelled author identity, so the omission fails `npm test` before it can be pushed. History was NOT rewritten (the ledger and devlog cite published SHAs); the deviation is recorded in CHANGELOG and HANDOFF. | The new test fails on a HEAD without the trailer (verified against the two commits it is describing) and passes once the tip is co-signed. | Shipped. |

### Honesty note on audit-7

The p91 study verifies a claim's PROVENANCE, not its ASTRONOMY: nothing gates, anchors or retracts on its output, and
a metadata mismatch (e.g. the post's "JUST IN" sitting 26 days behind the primary's public date) is evidence about the
post, not about the sky. The coordinates attached to the reviewed claim are labelled as the reviewer's annotation from
the located paper's field, not the post's own. And the count correction is published as a correction, not buried: the
board's 47 was a real over-count against the feed's 26, and both runtimes now share the one rule that makes them agree.
