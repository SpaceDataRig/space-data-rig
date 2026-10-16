# Response to the audit-10 review

This is a point-by-point, honest ledger of the eleven review items raised in the "audit-10"
pass and what was actually done about each. It is deliberately not a victory lap: every row
states the *residual risk* that remains, and items that were not done, or could not be done in
this environment, say so plainly. Numbers quoted are from committed reports only.

Legend for status:
- **Shipped** -- implemented, verification gates pass, committed to `main`.
- **Deploy-pending** -- merged on `main`, but only takes effect in production once deployed.
- **Blocked** -- cannot be completed in this environment; the reason is stated.
- **Partial / by-design** -- done, but the honest ceiling is recorded rather than oversold.

| # | Criticism raised | Fix | Verification | Residual risk |
|---|---|---|---|---|
| 1 | A single bundle hash conflates a timestamped commitment with a content address, so the same science re-run "changes its hash" and looks unreproducible. | `hashScience()` normalises `createdAt`/`runId` out; new memos append a stable `scienceHash` alongside the existing `bundleHash`. Old anchors stay byte-identical. | `tests/core.test.ts` (+3); verification still matches on the `bundleHash` substring. Commit `7887121`. | **Deployed** (version c9af4564): live on spacedatarig.app; affects only *new* anchors, historical memos carry no `scienceHash` by design. |
| 2 | The P81 report could turn "Gaia unavailable" into a silent NaN, and treat a physically impossible de-diluted depth as a real planet. | `undetermined` census state (not NaN); `depthPhysicallyInconsistent` (>10% depth) is excluded from the graded ratio but kept as blend-contradiction evidence; the denominator is written into the verdict. | `tests/triceratopsLite.test.ts`; `reports/p81-triceratops-lite.{md,json}` regenerated under the guardrails. Commits `47e5701`, `3ee17e5`. | The depth cap is a documented physical guard, not a calibrated astrophysical prior; a genuinely extreme-but-real source would be filtered out. |
| 3 | TRICERATOPS-lite should be cross-checked against the official tool. | Re-implemented the blended-FPP maths natively (`daveBlendedFpp`) and unit-tested it; the full official run needs Python. | Native FPP tests pass. | **Blocked here.** No Python/pip in this environment; an official end-to-end run against the reference package has *not* been performed. |
| 4 | The centroid F-test caught only 2/6 expected blends -- is that a statistic problem or a coverage problem? | `scripts/p84-centroid-diagnosis.ts` splits COVERAGE (never localised) from POWER, reading the P82 checkpoint. | `reports/p84-centroid-diagnosis.{md,json}`; commit `70578d5`. | **Partial / by-design.** Root cause is pixel-baseline-bound (71% of targets never localise), not the F-test; a bigger sample narrows the bar, it does not remove the ceiling. |
| 5 | The P80 headline silently selected its easiest subset -- an unstated selection effect. | Report names its easiest subset (depth>=3000 ppm / Tmag<=11) as the headline and shows a harder 300-1000 ppm tier alongside, even where that tier scores 0/N. | `scripts/p80-external-validation.ts`; commit `4061b0f`. | The headline rate is explicitly the easiest-subset rate, **not** a population-wide completeness; the hard tier is honestly weak. |
| 6 | The inverted / masked planet-free null was a one-off script, not a reusable, testable product. | Extracted `src/detect/invertedNull.ts` (invert-about-median + mask catalogued transits), unit-tested; README now leads with the P75 finding. | `tests/invertedNull.test.ts`; README lead; commit `68802bb`. | Small calibration sample (n=16); the AR(1) gate flags 75% of pure-noise bumps vs a nominal 5% -- reported, re-tested, deliberately *not* silently recalibrated. |
| 7 | Admin mutations were not deny-by-default, and a same-run re-entrant anchor could double-spend SOL. | `isAdminAuthorized` returns false when no token is set; a per-finding in-flight lock serialises `anchorFinding`; the abuse-brake counters moved from per-isolate to a `RateLimitDO` (global across isolates, local fail-open fallback); `SECURITY.md` published. | `tests/auth.test.ts` (default-deny); commits `c905d3f` + `34e93b8`. | **Deployed** (version c9af4564): verified 401/401/404/200 on the live site behind `ADMIN_TOKEN`; the dashboard prompts for the token on a 401. |
| 8 | Upstream schema/behaviour drift (NASA, ExoFOP, Gaia) is a silent science bug with no early warning. | `scripts/p8-live-probe.ts` issues the smallest real read-only query to each upstream and asserts consumed fields + row counts; weekly workflow opens an issue on a hard fail. | Local smoke: PASS on all three (NASA 1569 rows, ExoFOP 8152 lines, Gaia 5 rows, `source_id` string). Commit `9c857d4`. | A transient network error is *not* an alarm by design (exit 2, no issue); the probe checks shape/counts, not scientific correctness. |
| 9 | The money-adjacent send path had no CI integration test. | `scripts/p9-anchor-live-verify.ts` re-reads recent mainnet anchors keylessly and confirms each memo still contains its bundle hash; daily workflow. | Smoke: 3/3 recent anchors verified from-chain. Commit `1896fbf`. | Read-only: it proves past anchors still resolve, not that a *new* send succeeds; public-RPC rate limits can make a run INCONCLUSIVE (non-alarm). |
| 10 | No written, itemised audit response; the README is too long for a landing page; the repo description said "five-seat AI". | This document; a one-page "At a glance" block added at the top of the README, with the detailed long-form kept below as auditable context. | This file + README. Commit: this change. | **Partial.** The full long-form README is intentionally *kept* (it is audited, honest documentation) rather than deleted to force a literal one page; only a summary was added up front. Say the word for a hard cut. |
| 11 | CI did not fail on lint warnings, and line coverage alone hides untested branches. | `npm run lint` -> `eslint --max-warnings 0` (0 warnings tree-wide); coverage now enforces `--test-coverage-branches=75` alongside lines. | `npm run lint` exit 0; `npm run test:coverage` exit 0 (measured line 95.8 / branch 80.4 / fn 91.8). Commit `500a986`. | Research scripts under `scripts/**` keep a scoped override (no `any`/unused-var rules) -- deliberate for exploratory tooling; production `src/` and `tests/` stay strict. |

## Cross-cutting honesty

- **No discovery claim.** `discoveryClaim` stays false and `safeToGate` stays false across every
  report; the 42% accepted-precision wall, the strict grade-1 1/234 and grade-5 5/179 external
  numbers, and the 0/56 blend catch are reported as-is, not as findings.
- **Measure-before-gate.** None of these changes moved a production threshold, flipped a verdict,
  altered a historical `bundleHash`, or touched the money path. The two items that would
  (`#1`, `#7`) are now **deployed** (version c9af4564) and were verified against the live site.
- **Environment limits stated.** `#3` is genuinely blocked (no Python here); it is not marked done.
  The GitHub repo "About" description (an owner-only setting, no `gh` CLI here) still carries the
  older "five-seat AI" phrasing; the README now leads with "five-stage deterministic pipeline" but the
  repo field itself must be edited by the owner in Settings.
