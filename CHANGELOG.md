# Changelog

All notable changes to Space Data Rig are documented here. This project aims to follow
Keep a Changelog and adheres to Semantic Versioning.

## Unreleased

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
