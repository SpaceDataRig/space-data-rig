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
| The dashboard's "blind candidates" tile over-counted | `blindCandidates` counted EVERY `blind-toi` row including the ones the critic REJECTED as noise, while the X digest deliberately counted only surviving ones -- one phrase, two populations, neither surface saying which. Production showed 47 on the board where the feed's honest figure was 26 (21 rejected). | Split into `blindHeld`/`blindCandidates` (held-for-follow-up over assessed), centralised the predicate in `src/core/stats-definitions.ts` so the Durable Object's SQL, the Node mirror and the digest all call `isHeldBlindCandidate`, and made the board render both. Also fixed two adjacent mislabels: `surveyPass` is passes CLAIMED (not completed), and `distinctHosts` is hosts with a RECORDED RESULT (not targets analysed). | `tests/stats-definitions.test.ts` (9 tests) runs the DO's actual SQL against real `node:sqlite` rows and asserts it matches the JS predicate, pins that the digest no longer keeps a hand-written copy of the filter, and checks the served markup carries each definition on hover -- the hover text is served on the payload (`/api/state` `statDefinitions`) and built by the browser from it, with no copy typed into the markup. | Shipped (live: /api/state serves it). |
| The deploy window was planned from an unmeasured cadence | The working belief was "a pass takes ~45 minutes and leaves seconds of idle", so every deploy felt like squeezing into a narrow hole -- and the two bad outcomes are exactly what happened: uploading inside a live pass, or waiting for a hole that was never there and leaving production stale. Measured: cron every 15 min, full-pass write span median 260 s (164-307 s) over 24 recorded passes, median idle between passes ~2400 s. | `src/deploy/deployWindow.ts` (pure) + `npm run deploy:window`: GO only when no claim is live AND the idle left before the next cron boundary covers the upload budget; the stale-claim threshold is IMPORTED from the DO's own `isStaleClaim`, and an unreachable rig is UNKNOWN/exit 2, never a reassuring GO. | `tests/deploy-window.test.ts` (10 tests): live claim WAIT / idle GO / near-boundary WAIT / stale claim free / missing state UNKNOWN, boundary math incl. hour roll-over, clustering yields no invented cadence from <2 rows, stale threshold equals the DO's, and the script delegates rather than reimplementing. | Shipped. |
| A governance rule lived only in prose | GOVERNANCE.md states commits are co-signed and HANDOFF documents the trailer -- two commits this pass were pushed without it, with every other gate green, because nothing looked. | `tests/commit-co-sign.test.ts` checks the HEAD commit for the co-sign trailer and the labelled author identity, so the omission fails `npm test` before it can be pushed. History was NOT rewritten (the ledger and devlog cite published SHAs); the deviation is recorded in CHANGELOG and HANDOFF. | The new test fails on a HEAD without the trailer (verified against the two commits it is describing) and passes once the tip is co-signed. | Shipped. |

### Honesty note on audit-7

The p91 study verifies a claim's PROVENANCE, not its ASTRONOMY: nothing gates, anchors or retracts on its output, and
a metadata mismatch (e.g. the post's "JUST IN" sitting 26 days behind the primary's public date) is evidence about the
post, not about the sky. The coordinates attached to the reviewed claim are labelled as the reviewer's annotation from
the located paper's field, not the post's own. And the count correction is published as a correction, not buried: the
board's 47 was a real over-count against the feed's 26, and both runtimes now share the one rule that makes them agree.

## Eighth pass -- self-audit: what a report re-run and a dead method have in common

No external audit prompted this round. It came from two operational events: the report library refused to publish over
a stale report, and the counter-definition work was checked for whether its own rule had a call site. Both produced
findings, recorded here in the same format as the auditor's.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| A published report went stale and blocked the site | `61d7c68` changed `src/detect/bls.ts`, a recorded input of `p41-longbaseline`, and nobody re-ran the study. The gate flagged it and p86 exited non-zero, which is the designed behaviour -- the failure would have been publishing a completeness table computed by a detector that no longer exists. | Re-ran at the parameters the report itself records (`--stars 30 --maxsectors 4 --period 3 --seed 7`). Re-running with the script's CURRENT defaults (40 hosts) changes the percentages, and `RESEARCH.md` section 9 quotes this table -- so a default-parameter re-run would have created exactly the cross-document drift the counter work was about. Every cell reproduces (51.7/37.9 at 300 ppm through 89.7/79.3 at 3000 ppm); the 40-host run is kept as a gitignored sensitivity note instead of being swapped in. | `npm run p86:report-library` reports 0 stale and `fullyVerified` 3 (was 2); the rendered markdown is byte-unchanged, and the only JSON moves are the stamp and the per-host sector point counts, which track what SPOC served that day. | Shipped. |
| A definition module nobody called | `PUBLIC_STAT_DEFINITIONS` was documented as the single source for what each public counter counts -- and its only reader was a paragraph hand-typed into `web/index.html`. The tooltip a user sees was the copy; the authoritative text had zero call sites, one edit from disagreeing with the query beside it. | The definitions are now served: `DashboardState.statDefinitions`, filled from the constant by both the Durable Object and the Node server, rendered into the hover text by `web/app.js`. The markup carries none of them, and a server that publishes no definitions produces no tooltip rather than an unverified one. | `tests/stats-definitions.test.ts` asserts each definition is absent from `index.html`, that both runtimes import and publish the constant, and that the browser has exactly one writer with both state-load call sites. Verified live after the 16:33Z deploy: /api/state returns the four definitions beside `blindHeld` 29 / `blindCandidates` 50, and /health.gitSha equals the deployed commit. | Shipped. |
| Dead code documenting the bug it replaced | `RigStateDO.advanceSurveyPass()` had no callers anywhere in `src/`, `scripts/`, `tests/` or `web/`, and the comment above it described advancing the cursor "at the end" -- the tail-side design whose failure caused the 22-hour survey freeze. Restoring it on the strength of that comment would restore the incident. | Removed the method; the cursor is written only inside the atomic claim. The DO cannot be imported into the Node runner, so the guard is textual. | `tests/run-mutex.test.ts` asserts no pass-advance RPC exists in the DO source, that `decideAdvance` has exactly one production call site (inside `decideStart`), and that every `surveyPass` write is inside `startRunIfIdle`. | Shipped. |
| The handover map had holes | HANDOFF section 5 was missing `src/figures/` and `src/survey/`; nothing compared the map to the tree, so a reader following it would conclude those directories were someone's scratch files. | Both entries written, and the check made mechanical. | `tests/repo-hygiene.test.ts` requires the layout to name exactly the `src/` directories that exist, in both directions. | Shipped. |
| The handover SNAPSHOT presented a five-day-old state as current | HANDOFF section 13 was titled "Current state (as of 2026-10-13)" naming HEAD 148ff2c, a wrangler version and a 260-test suite -- about sixty commits and six audit passes behind. Every sentence in it was true of a state that no longer held, and a successor reading it first would have acted on all of them. | Rewritten from measurements taken at the deploy: version and gitSha read back from `GET /health`, switches off the deploy's own binding list, counters off `GET /api/state`, library freshness off the served index. The older research bullets below are explicitly labelled history with `reports/*.md` as their authority. | `tests/handoff-freshness.test.ts` (5 tests): the checkout must carry full history, the as-of date may not trail the newest dated CHANGELOG entry, every commit sha named must be reachable from HEAD, and the production bullet must name the revision it was built from. Against the old text it failed on the date and on the missing deployed sha -- and on its first run also misread the wrangler version id (a hex UUID) as an unreachable commit, a bug in the gate rather than in the document, fixed by stripping version ids before matching shas. | Shipped. |

### Honesty note on the eighth pass

The milestone figure (`src/figures/m4MilestoneFigure.ts`) draws only from committed artifacts and the live counters, and
refuses to render a field that is absent rather than painting it as a zero. Its record was captured AFTER the deploy
that publishes `blindHeld` -- the CLI refuses to draw counters the deployed revision does not have -- so
`reports/m4-milestone.json` is a snapshot of production at 2026-10-18T16:34:34Z, not of the repository, and the
byte-equality assertions over it now run rather than being skipped. The figure reports two zero results (Gaia period
matched 0 of 17; PSF double-difference veto power 0.00 on 5 curves) in the warn colour: they are measurements, not
failures to look. And the p41 re-run reproduced the published table; it did not improve or re-validate it, and the
40-host variant is quoted nowhere in this repository because it is not what the documents cite.

## 2026-10-20 -- six-point quantitative external audit

A separate auditor scored the stack on six points. They share one failure shape: a value was *computed* somewhere but
never actually reached the surface a reader checks -- a retracted number still printed on a deployed figure, a banner
asserting a file was untracked when it was, a README claiming a read-back that no endpoint performed, a label that
called a degenerate fit "physically consistent". Each row states what was measured, not what was intended.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| A retracted 71% still printed on the live figures | `audit10-close-figure.svg` / `audit3-remediation-figure.svg` carried a withdrawn `71%`; the correct report-driven values are P84 coverage-loss 70% and P85 contaminant 77.2%. The guard missed it because its banned-token list predated `71%` and it only scanned top-level SVGs, not nested `<g>` fragments. | Replaced the hard-coded strings with the live report numbers and widened the guard to recurse every served SVG/HTML fragment with `71%` in its banned set. | `tests/figure-no-retracted.test.ts` fails if any served figure contains a banned token; deployed `web/*.svg` fetched with cache-bust contain no bare `71%`. | Shipped (`fe0c268`). |
| The served index under-reported verification and stamped three reports as unverifiable | `index.json` showed `verified:3`/`fullyVerified:3` while 12 were actually verifiable, and p82/p84/p85 carried a red "PROVENANCE NOT MACHINE-VERIFIABLE ... blind.jsonl not tracked" note that was stale -- the file is tracked. | Corrected the tag counting and removed the obsolete notes. | Re-checked against the live library this pass: `stale:[]`, 14 stamped / 12 verified / 12 fullyVerified of 54. | Shipped (`55dec68`/`b367e09`), live-verified. |
| The freshness gate covered only 8 of 54 reports, and a stale figure was presented as current | P92/P93/P95/P96/P48/P76 had no `generatedAt`/`gitSha`/`inputs`; `research.json`/`app.js` rendered the P76 multi-source figure as a live number though its generator had not re-run since the ExoFOP 3.8 MB table timed out at the old 45 s default. | Wired `buildStamp` into those generators, raised the ExoFOP fetch timeout to 180 s so the default path no longer returns empty, and marked P76 point-in-time (`snapshotAt`/`stamped`) rather than presenting a measured zero as current. | `npm run p86:report-library` exits non-zero on any HARD-STALE; after the CI re-run the live library is `stale:[]`. | Shipped (`b4f1518`). |
| `/verify` proved nothing about the chain and the README over-promised | `/api/bundles/:id/verify` re-hashes the served bundle against the served `HASH.txt` only -- it never queried Solana -- so "re-read the memo and check the science against the site" was a write-path fact with no read path. | First told the truth (README reworded to the narrow fact), then made it true: a dependency-free, runtime-agnostic `src/solana/memoVerify.ts` decodes the sealed `bundleHash` AND `scienceHash` from a live `jsonParsed` getTransaction and compares both to the site's current values, exposed as keyless `GET /api/bundles/:id/verify-onchain`, honest `chainReadable:false` when no RPC answers, and `anchoredScienceDrift` only when the chain sealed a *different* science (a historical 3-field memo is `legacyMemo`, not drift). | 11 offline mock-RPC tests + worker parity source test; live `F-HR-858-b` returns `chainReadable:true`, `ledgerBundleMatch:true`, `anchorCoversCurrentBundle:false`, `scienceHashMatch:true`, `anchoredScienceDrift:false`. | Shipped + mainnet-proven (`f31b87a` reword, `13a30bb` endpoint). |
| Degenerate fits were called "physically-consistent" and a failed catalog lookup was indistinguishable from a genuinely empty one | The fit classifier labelled degenerate solutions consistent, and `crossmatchPeriod` collapsed three modes into "no known planet here" -- (i) lookup failed, (ii) succeeded but the planet was off the slice, (iii) succeeded and truly none -- which could overstate a signal as novel. | Stopped the consistent label and widened the harmonics sweep; and made the crossmatch tri-state: `fetchPlanetsByHost` distinguishes completed-and-empty from lookup-failed, the critic emits a non-gating `catalog-lookup` status, a failed/off-slice lookup can only DOWNGRADE a novel reading (the accepted set never widens), and the default synthetic/bundle path is left byte-identical. | `tests/vetting.test.ts` +6 behaviour tests (empty-with-hits stays, failed lookup no longer reads novel, off-slice handled, accept-set monotone). | Shipped (`b1fd728`, `ee7389d`). |
| The candidate countdown printed a number frozen at build time | A day-count was baked into the built artifact, so it aged wrongly between builds. | Projected live from the state the dashboard already reads. | Renders against `/api/state` counts. | Shipped (`724cfc1`). |

### Process finding this pass surfaced (recorded because it changed a design, not just a number)

Clearing the red STALE banners required re-running p90 on a runner (its network inputs are unreachable from a laptop
sandbox). Doing so moved p90's period-matched sample from 16 to 6 and the published depth error bar from 48% to 58% --
because the NASA Archive had added planets since 2026-10-18 -- and `src/core/depthFormat.ts` bakes that radius into the
public cards, breaking two parity guards. A CI job should not gamble a cited scientific number on WHEN it ran. The
operator was asked and chose to make p90 reproducible: it now replays a committed frozen snapshot
(`reports/fixtures/p90-frozen-rows.json`) offline and deterministically by default, and its data stamp tracks the
fixture + the script rather than the fetch layer, so scheduled re-runs no longer re-measure against a live catalog.
The published 16/48 numbers are unchanged; `--live` remains the deliberate, auditable re-measure path. The regeneration
workflow itself is now driven only by the data-layer sources still safe to re-measure (ExoFOP / TOI / Gaia-dilution /
MAST-S3), not by p90 or its archive query module, and no longer self-triggers on its own edits.

### Honesty note on the six-point audit

Every fix here is a *narrowing of a claim to what is actually verifiable*, not an expansion of what the rig asserts.
The on-chain endpoint reports bundle drift honestly for a re-derived historical bundle and distinguishes it from a
science-address change; the crossmatch change can only ever shrink the set of "novel" readings; and the p90 change
does NOT re-measure or improve anything -- it freezes a measurement so a number already cited in the docs stops
moving under readers. Nothing on any path claims a new planet, and no production verdict gate was enabled without its
criterion being measured first.

## 2026-10-21 -- seven-point quantitative external audit

The same auditor returned with seven points (R1-R7) plus two small items, and the shape repeats one layer deeper: a
fix that is *true in code* but never reaches the surface a reader re-checks -- a benchmark report that clears the gate
only because the gate never looked at it, a poster whose numbers age inside the very batch that shipped it, a state the
audit motivated but that never fires on production data, an honest endpoint no link exposes. Each row states the
measured fact and the residual, not the intent.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| The gate covered 26%; the two most-cited external benchmarks (P75 n=200 AR(1) FP 0.74, and the LEO-Vetter cross-check) sat outside it, and `p86` never looked inside `reports/crosscheck/` | `p75-inverted-fp.ts` wrote its meta with no `generatedAt`/`gitSha`/`inputs`; `benchmark_vs_field.py` likewise; `p86` scanned only top-level `reports/*.md`. 40 of 54 reports were `stamped:false` yet all rendered `fresh:true`. | Froze P75 like P90 -- a committed `p75-frozen-rows.json` replayed offline by default, data stamp = `[script, fixture]` so a cron cannot re-measure the cited rate against the live Archive; added a Python `freshness_stamp` to the benchmark whose EOL-normalised sha256 mirrors the TS gate; made `p86` recurse `reports/crosscheck/`. | CI (leo-vetter) republished the stamped benchmark; local `p86` rebuild shows it stamped / verified / reproducible=4 cross-platform; live library `stale:[]`, 16 stamped / 14 verified of 56; `tests/r1-gate-coverage.test.ts`. | Shipped (`c7f29b6`, `7d5f8d0`). |
| RESEARCH.md section 29 quoted the old N=16 run while the report and research.json had moved to N=200 | `55dec68` propagated N=200 to the figure/research.json/report but not the long-form prose (75%->74%, 31%->32%, flips 7->86). | Synced section 29 to the frozen N=200. | Text matches the committed report and `web/research.json`. | Shipped (`c4791be`). |
| `web/audit-remediation6-figure.svg` was hand-typed and self-contradicted by later commits in the same batch | No generator produced it; five statements were already false (stamped 12 of 54 vs 14, machine-verified 8 vs 12, "p59/p90 STALE" vs `stale:[]`, "crossmatch deferred" vs shipped `ee7389d`, baked "deploy f31b87a"). The retracted-token gate cannot catch a value that merely ages. | Wrote `scripts/audit6-remediation-figure.ts` that READS every volatile figure from `index.json`/`p84` and refers to the deploy revision via `/health.gitSha`, never a frozen SHA. | Idempotent (re-run byte-identical), nonASCII 0, XML parses, `figure-no-retracted` + `figures-manifest` green; cache-busted live SVG shows 16/56 + `/health.gitSha`, no `f31b87a`. | Shipped (`1ed1ddf`), live-verified. |
| Off-slice / lookup-failed states never fired, and `"none"` conflated "lookup not run" with "ran and found nothing" | A missing `meta.hostName` skipped the workflow lookup, `hostCatalog === undefined` fell to the terminal `else` and was labelled `"none"` -- the shrunken `?? []` ambiguity returned. | Added a distinct `lookup-not-run` state on the opt-in review path only; default synthetic/bundle path unchanged. | `tests/vetting.test.ts` +1 case; default-path bytes unchanged. | Shipped (`c4791be`). |
| "physically-consistent" still on 38/103, including SNR 45172 | The survivors are immutable historical anchored rows whose stored `verdictReason` the critic no longer emits; the accept/hit branch text was not rewritten because editing them would move a `scienceHash`. | Shared one `SNR_IMPLAUSIBLE = 1000` between the critic and `relabel.js` (test-pinned equal) and added a render-layer `degeneracyCaveat` that annotates high-SNR "physically-consistent" lines at display. | `tests/degeneracy-relabel.test.ts` (8 cases: threshold equality, predicate, app wiring); no bundle rewritten, no hash moved. | Shipped (`76b3524`), live-verified. |
| The refresh workflow re-fired on its own commits and left red runs | `freshness-regen.yml` lacked a self `paths-ignore`; the re-entrant publish's `git checkout -B main origin/main` aborted on dirty generated files. | Made publish non-destructive: commit first, then merge `-X ours` (this run's fresh bytes win) with push retry; publish only touches non-trigger paths. | The fleet no longer self-fires; the merge-retry keeps the newest measurement on conflict. | Shipped (`c4791be`). |
| The on-chain truth existed but a reader could not reach it | `verify-onchain` was routed on both runtimes and cited in the README, but `grep web/` was empty and science-drift rows carried no flag. | Added an On-chain button per finding card that fetches the keyless endpoint and reports the honest branch. | Deployed `/app.js` carries the action; live `GET /api/bundles/F-TOI-1608-01/verify-onchain` returns 200 with `anchored:false / chainReadable:false` (a blind-toi row correctly reads as not anchored). | Shipped (`76b3524`), live-verified. |
| Small: the candidate board baked a now-relative countdown | A dated `web/candidates.json` shipped `daysUntilNext`/`nextTransitBjd`; the console projects them live but a raw-JSON consumer got the stale value. | `CANDIDATE_SCHEMA` -> `/2`; row + `p22` writer drop the two fields; validator now rejects a stale `/1`; kept geometric `altitudeDeg`. | `tests/snapshot.test.ts` 11/11 (+2); `/2` boundary verified against the stripped board. | Shipped (`d5dd629`). |
| Small: `/api/state` took 341 s for the auditor | One strong-consistency `getState()` RPC queued behind an in-flight survey pass in the single-threaded Durable Object, plus cold start -- latency, not a wrong number. | Diagnosed (no O(N^2)/per-finding await in the handler); `deploy:window` measures the real cadence instead of assuming it. | Measured 35 passes: span median 238 s, idle median 276 s. No unmeasurable DO-consistency change shipped. | Diagnosed, honestly left as latency. |

### Honesty note on the seven-point audit

Two residuals were stated rather than papered over, and the first is now closed. The served candidate board: flipping
it from `/1` to `/2` requires a live `p22` re-observation and re-stamping its dependants `p48`/`p76` needs ExoFOP, which
returns 0 rows to an anonymous sandbox fetch -- so rather than hand-edit it into the exact HARD-STALE inconsistency this
audit is about, the fleet was widened (`d9c270f`) so `p48` also auto-heals and `web/candidates.json` became a trigger, then
`p22` was re-observed against live MAST + Archive to emit a `/2` board (4 rows, no baked countdown, `discoveryClaim` false),
p48 re-stamped locally, and the push auto-fired `freshness-regen` to re-stamp p76 + rebuild the library to `stale:[]`
(`14f1d15`) and deploy (`919be633`) -- live `/candidates.json` now serves `/2` with no rotting day-count. The second
residual stands: the `/api/state` latency is an infra characteristic of a busy single-threaded DO, not a data bug, and no
blind caching or eventual-consistency change was shipped because its benefit could not be re-measured against the
contention window from here. Everything else is closed against bytes and re-checked on the deployed site. Research-only
throughout; no verdict gate or money path moved.

## Twelfth-round audit response (2026-10-22, HEAD tested `ad1d804`+)

The audit's own framing was the correction: the defect class had moved from "fixed but never shipped" to
**"the shipping pipeline re-verified a rotten fact"**. The auditor independently reproduced every claimed number
against served bytes -- the first round where that held -- and then found what byte-vs-input gates structurally
cannot see: prose that disagrees with its own JSON. Response, per finding:

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| D1: P48's published prose claimed "collapsed 2 ... emitting these 5" while its own table and JSON said 1 / 4 -- and the gate signed it `verified` | `p48-novelty-check.ts` interpolated every other count but hardcoded that sentence; it described the old `/1` board and rotted under re-stamping. Tests referenced p48 zero times | Sentence now interpolates `board.summary` (+`corroboratedHosts` beside it); JSON carries the source fields; `tests/p48-copy-consistency.test.ts` pins every prose count to its data row | p48 re-run live (control PASS) says 1/4; CI fleet re-stamped it again at `44e5c5d` with the same sentence; +4 tests green | Shipped (`ad1d804`), CI-re-stamped. |
| D2: dedup and freshness are mutually exclusive -- `anchorCoversCurrentBundle` 0/20 forever while dedup spends no second fee | Two individually-correct mechanisms each eating the other's guarantee; the docs claimed the covered-bytes property as the thing provenance needs | Capability claim WITHDRAWN from README (steady state named plainly); the verify branch that hardcoded "re-derive (timestamp moved)" + asserted "content address stable" was rewritten to name both causes and defer to the science-hash verdict; money path untouched | `tests/stats-definitions.test.ts` asserts the withdrawn strings never come back; per-card state readable where it lives | Shipped (`ad1d804`). |
| D3: 20-vs-0 decodable only by reading DO SQL | Definitions existed only in code comments; the UI quoted numbers without their populations | `bundlesAnchored`/`ledgerAnchored` definitions added to the published payload (`stats-definitions.ts`) and rendered as tooltips on both ticker chips (payload-cached, no markup copies) | +1 test: definitions must exist AND have a consumer; single-source rule kept | Shipped (`ad1d804`). |
| D4: `/api/state` 324 KB with 40-60% measured fetch failure for verifiers | 270 KB of findings bytes in one payload; DO serialization adds latency | New `GET /api/state/summary`: pure projection (<8 KB) with the same stats/statDefinitions + verdict/origin populations + cards-with-tx count, wired in BOTH runtimes | `tests/state-summary.test.ts` +3 (behavior, size ratio, parity); live measurement after deploy | Shipped (`ad1d804`), live check below. |
| D5: cross-pipeline.json still unstamped; library `--allow-stale` keeps p86's block dead in CI | The second crosscheck arm never got the R1 stamp treatment | `cross_pipeline.py` gained the same EOL-mirrored `freshness_stamp`; discovered live: editing it HARD-STALE'd benchmark-vs-field (a hash input) with nothing re-firing -> `leo-vetter.yml` now watches `cross_pipeline.py` | CI arms re-stamp + rebuild on their own runners; no local Python -- said plainly | Shipped (`ad1d804`, `176dc31`), CI-verified in-flight. |
| D6: ~70 passes, 0 new chain commitments -- "continuously producing verifiable records" lacks incremental support | Correct: dedup suppresses re-anchoring identical science by design; the phrase came from session prose, not the repo | No new wording earned; the suppression is now stated in README/CHANGELOG where the counters live | grep: repo never carried the overclaim | Acknowledged, no papering. |
| D7: HANDOFF `Last updated: 2026-10-13` while the body cites 10-21/22; blind-toi phrasing stricter than the code | The date line was a resident claim without the git line's scope disclaimer; the README claimed a universal cap while seats.ts:165 caps only ACCEPTED | Date moved to 2026-10-22 with a what-this-line-protects note; README now says: never ACCEPTED, rejections stay rejected | `handoff-freshness` test; code-parity re-read of seats.ts | Shipped (`ad1d804`). |

### Honesty note on the twelfth round

Two residuals are stated, not closed. The `/api/state` DO-serialization latency still stands as an infra
characteristic -- the summary endpoint removes the transport wall for verifiers, it does not make the full payload
fast. And the p86 `--allow-stale` block in `freshness-regen.yml` still never hard-blocks in the automated path (the
library keeps serving stale-flagged entries honestly, with `stale[]` visible in the index). The retracted-sentence
class is now structurally closed for p48 (interpolation + row-pin test); the audit's lit12 scan found 13
hardcoded-count lines overall and every survivor was checked against its source (external citations, frozen
snapshot constants, or statistical conventions) -- only P48 had actually rotted, and the same test shape guards it
from silently repeating. Research-only throughout: no verdict gate, anchor semantics, or money path moved;
`discoveryClaim` false everywhere.

## Thirteenth-round audit response (2026-10-23, HEAD tested `bb16fd7`)

The thirteenth pass targeted the v0.2 Interactive Verification Console shipped at `ef07167`..`d6825a8`. Its central
theme: a read-only projection can still lie about the science it mirrors, and a browser view can race its own data.
Six findings (2 correctness/honesty, 4 wording/robustness); every one was re-verified against the real source and
production fixtures before being touched, then pinned by behaviour tests rather than string-matches.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| P1 Evidence note stamped "harmonic alias x1" on cards with no alias | `aliasMultiple === 1` means "BLS period was already correct" (`src/detect/pipeline.ts`, and `src/critic/review.ts` sets the odd-even PASS from exactly this), yet the note gated on `!= null` -- so the honesty panel contradicted the sealed manifest's own "period is clean (alias x1)" line printed right above it | New pure predicate `isHarmonicAlias()` in `web/findings-query-ui.js` returns true only for a finite multiple that is genuinely not 1; `evidenceHtml` gates on it | Behaviour tests (x1 false, x2/0.5 true, null/NaN/"abc"/absent false) + LIVE-DATA regression over `tests/fixtures/live-manifests.json`; live probe of 40 production manifests: aliasMultiple set {1,2}, 5 real aliases flagged, 35 clean cards no longer falsely stamped | Shipped (`bb16fd7`), live-verified. |
| P1 a fresh query issued during "load more" silently no-ops, leaving the OLD result under the NEW meta | `fetchFindingsPage` had a single `loading` guard that blocked every overlapping request, so clicking Apply while a page was network-bound dropped the new query entirely | Offset-0 requests now preempt an in-flight page; a monotonic `token` identifies the newest request and DISCARDS any response a newer query/reset superseded before it can mutate state; Reset bumps the token | Structural test pins `const token = ++findingsQuery.token` + the pre-render drop `if (token !== findingsQuery.token) return;`; served `app.js` carries it | Shipped (`bb16fd7`). |
| P2 a failed fresh query left the previous query's cards stranded on screen | The catch only rewrote the meta text; rows from the last successful page stayed rendered under an error line | On offset-0 failure the rows/matched/total/hasMore are cleared and the board re-rendered to an honest empty state before the error text | Structural test pins the clear inside the `offset === 0` branch | Shipped (`bb16fd7`). |
| P2 "load more" could render the same finding twice | Pages are appended; if the catalog shifts between two requests (a run upserts a row, the sort recomputes) a finding lands on consecutive slices | New pure `dedupeById()` collapses appended pages by id keeping the first occurrence | Behaviour test (order + first-copy kept + non-array degrades to empty); `findingsQuery.rows = dedupeById(combined)` wired at the append site | Shipped (`bb16fd7`). |
| P2 the panel claimed "(no filter)" whenever `matched === total` | An empty query AND an all-matching filter both give `matched===total`, so the phrase was ambiguous -- it told a reader their filter "did nothing" when it ran and kept everything | `resultMeta(res, shown, {filtered})` decides "no filter" from `hasConstraints(form)` -- what the reader typed -- never from the count; `hasConstraints` finally has a consumer | Behaviour tests: filtered view with every row matched still reads "matched 8 of 8", never "no filter"/"full catalog" | Shipped (`bb16fd7`). |
| P2 the load-more cue always said "for older", implying time order under any sort | The tail was hardcoded; a catalog sorted by depth/snr/TIC pages in that key's order, not chronologically | The cue now names the active sort -- "load more for the next by <sort>" -- and keeps "for older" only under the default `recent` sort | Behaviour tests on both branches; live render on the 103-row catalog shows the recent and depth variants side by side | Shipped (`bb16fd7`). |

### Honesty note on the thirteenth round

The alias finding is not hypothetical: the live probe found 5 of the first 40 production manifests genuinely carry
`aliasMultiple = 2` (a real odd-even-resolved alias) while 35 are clean `x1`, so the old gate mislabeled the majority
of cards a reader actually opens. The fix was kept strictly on the read/label path -- no verdict gate, no bundle hash,
no money path, and `isHarmonicAlias` never re-derives anything. Paging correctness (dedupe, race token) is a client
view concern; the server's `queryFindings` was not touched, so the empty-query identity contract that
`scripts/depth-significance-figure.ts` depends on is unchanged. Deployed at version `ef5805ac`, `/health` gitSha
`bb16fd7`, codeVersion `space-data-rig@0.2.0`; served `app.js` no longer contains the old `aliasMultiple != null`
gate. `npm test` 908/908 (was 902), typecheck:all clean, zero non-ASCII, zero secret hits.

## Fourteenth-round audit response (2026-10-23, HEAD tested `8dd1748`)

The fourteenth pass re-tested the twelfth round's seven residuals (six closed, one honestly acknowledged), corrected the
auditor's OWN twelfth-round failure-rate attribution (the 40-60% fetch loss was large-payload x their slow link, not a DO
wedge -- the summary endpoint they credit was still the right response), and then raised six new findings N1-N6 on the
shipped v0.2 interface layer (`ef5805ac` / `bb16fd7`). The defect class had moved from the data layer to the interface
layer. Each was re-verified against the real source and live production data before being touched; four are fixed with
behaviour tests, one as an additive honesty signal, one rebutted with evidence rather than changed.

| Concern | Honest root cause | What was done | Verification | Status |
|---|---|---|---|---|
| N1: an unknown-but-supplied enum (`?verdict=typo`) was silently dropped -- a direct URL reader got the whole catalog with no trace their filter did nothing, and the echoed `query` object omitted the parameter entirely | `parseFindingQuery` drops bad values BY DESIGN (the empty-query identity invariant -- a typo must not 500), but nothing reported WHAT it dropped | New pure `ignoredFindingParams()` in `src/core/finding-query.ts` mirrors the exact drop rules; both `/api/findings` handlers (edge + Node) now echo `ignored:[...]` | LIVE: `?verdict/origin/sort/dir/limit=<garbage>` each echo `ignored:["<name>"]` and `matched=103=total` is unchanged; behaviour tests pin every drop rule | Shipped (`8dd1748`), live-verified. |
| N2: `tic` promised an identifier but did a blind substring -- `tic=858` swept in any id containing `858` (8581, S8581) | `!targetId.toLowerCase().includes(q.tic)` treats a numeric identifier as a loose substring | A purely numeric `tic` must now equal a whole digit RUN of the target id; alphabetic/spaced queries keep the contains behaviour; the free-text `q` stays the loose-contains tool | LIVE on real row `TOI-1487.01` (run `1487`): `tic=148` matched 0 (the old code swept this row in), `tic=1487` matched 1 exactly; behaviour tests | Shipped (`8dd1748`), live-verified. |
| N3 (money path): the burn-signature replay guard was checked MANY `await`s before it was written, with the on-chain anchor in between -- two concurrent same-signature commissions could both pass and both spend SOL | `observeCommission` had no per-signature serialisation, while `anchorFinding` had long used `anchorInFlight` keyed by findingId | Both runtimes serialise by signature: the DO gains `commissionInFlight` keyed by `burnSig` mirroring `anchorInFlight` (released in a `finally`); the Node route chains through a new pure `serializeByKey` (`src/core/inFlightLock.ts`) | Behaviour test drives REAL concurrency: two same-key calls -> exactly ONE spend, results `['commissioned','already-used']`; distinct keys run parallel; a rejection releases the key. NOT live-fired (it spends real SOL) -- proven by the algorithm test + deployed-commit identity | Shipped (`8dd1748`). No verdict/bundleHash moved. |
| N4 (gates): the race/merge/failure browser logic was proven by regex-matching `app.js` source -- exactly the audit-4 anti-pattern the same test file criticises | The pure helpers had escaped string-matching, but the two state mutations (race token, failure clear) were still asserted against source text | The logic moved into pure `applyFindingsPage` / `applyFailedPage` in `web/findings-query-ui.js`, driven by real response envelopes in tests; `app.js` keeps only the genuinely browser-timing token guard, asserted as wiring | Behaviour tests on the reducers; served `findings-query-ui.js` (10,506 B) is BYTE-IDENTICAL to the repo and contains both functions | Shipped (`8dd1748`), live-verified. |
| N6: 39/56 unstamped reports still read as plain `fresh` in the published index | p86 counted `stamped`/`verified` but left `fresh: !stale`, which reads "not known stale" as "verified current" | `unattested: total - stamped` is now a first-class published number (index regenerated: 39 unattested); `--allow-stale` stays and is stated plainly -- one offline upstream must not block publishing the rest | A freshness test pins `unattested`; the `fresh` boolean was deliberately NOT flipped (that would mislabel an unattested report as out-of-date) | Shipped (`8dd1748`). Additive honesty, not suppression. |
| N5 (rebutted): the claim that `/api/findings` is the SLOWER path because it does a full SQLite read while summary uses cached state is inverted | The DO `getState()` behind the fast summary ALSO calls `listFindings()` plus bundles+events+computeStats -- both read the same rows; the latency delta is transport + DO turn-serialization behind an in-flight pass, the infra characteristic already recorded under audit-12 D4 | No change; no risky SQL pushdown was made to chase a mis-attributed cost | Source read: `rig-state.do.ts` `getState()` -> `findings: this.listFindings()` | Acknowledged with evidence, not code. |

### Honesty note on the fourteenth round

N3 is the one finding on the money path, so it was handled with the most care and the least theater: the fix only
prevents a double payment -- it moves no verdict gate, no bundle hash, no anchor semantics -- and it is NOT claimed as
"live-verified" because verifying it would require spending real SOL. It is proven by a concurrency behaviour test that
drives two genuinely parallel same-signature calls and observes exactly one spend, plus the deployed-commit identity. N5
is stated as a rebuttal, not a fix: the auditor's own D4 self-correction (volume x link, not a DO wedge) is consistent
with the code fact that `getState()` reads the same findings rows the paginated endpoint does, so no speculative query
pushdown was made. The served `app.js` (115,608 B) and `findings-query-ui.js` (10,506 B) are byte-for-byte the committed
files after EOL normalisation, so "the behaviour you can poke live is the behaviour in the tests" holds for N1/N2/N4.
Deployed at version `995b627a`, `/health` gitSha `8dd1748`, codeVersion `space-data-rig@0.2.0` (a hardening of the v0.2
line, not a version bump -- the same shape as `bb16fd7`). Research posture unchanged: still zero new objects, every card
`discoveryClaim` false. `npm test` 921/921 (was 908), typecheck:all clean, eslint --max-warnings 0, zero non-ASCII, zero
secret hits.


