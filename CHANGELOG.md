# Changelog

All notable changes to Space Data Rig are documented here. This project aims to follow
Keep a Changelog and adheres to Semantic Versioning.

## Unreleased

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
