# Space Data Rig -- Full Project Handoff

Last updated: 2026-10-23 (this date line means "last full re-verification sweep of this document", refreshed at
each audit round; live counters quoted below are snapshots of that sweep and the git line names the tested
revision -- readers should treat per-field live values as of their own `GET /api/state/summary` call, which exists
precisely so a reader can re-check the numbers without downloading the full payload). Status: production live at
https://spacedatarig.app.
Repo: https://github.com/SpaceDataRig/space-data-rig (branch main).
This document is the single entry point for anyone (human or AI agent) taking over
the project. Read it fully before touching code, deploying, or spending money.

## 1. What this project is

Space Data Rig is an OpenRig-style, five-seat AI team that runs a fully reproducible
exoplanet transit-detection loop on public NASA/MAST data, seals every result into a
hash-addressed bundle, and anchors accepted bundles to Solana mainnet via SPL Memo
transactions as tamper-evident provenance. A live web dashboard streams the agents
working in real time.

Honesty boundary (never violate): this is a science-grade CLOSED-LOOP SELF-TEST.
It proves the machinery can recover known signals from noise. It makes NO claim of
discovering new planets. Every user-facing artifact must label which photometry tier
produced its data (`REAL photometry` vs `seeded stand-in`).

The $SDR token was launched separately on pump.fun. There is deliberately NO custom
token contract or Solana program in this repo -- on-chain we only use the standard
SPL Memo program.

## 2. The five seats

```
data -> data-fetch -> anomaly-scout -> sim-runner -> mission-critic -> reporter
```

- data-fetch: NASA Exoplanet Archive TAP query + light-curve resolution (4-tier chain, below).
- anomaly-scout: detrending + Box-Least-Squares transit search + odd/even alias resolution.
- sim-runner: injection-recovery confidence + ephemeris prediction.
- mission-critic: cross-match vs catalog, pixel-centroid vetting (VET), calibrated FAP, verdict.
- reporter: hash-sealed bundle + plain-English narration + SVG plots.

All seats talk to a shared RigStore (src/core/store.ts) -- the single source of truth
with an event bus; CLI, HTTP API and dashboard all read/subscribe to the same store.

An optional AI deliberation layer (src/ai/: llm.ts, discussion.ts, threads.ts,
deliberation.ts) lets up to two live LLM providers add labeled critic caveats on the
side; default mode is "grounded" (speaks only from computed numbers). Deliberation
receipts are hashed and can be anchored.

## 3. Light-curve data tiers (fixed priority chain)

1. Curated MAST registry (src/data/mastCurated.ts): hand-written host -> productUri list,
   anonymous Download/file, FITS-parsed (src/data/fits.ts).
2. TESS-SPOC public S3 (src/data/mastS3.ts, mastS3Pixels.ts): token-free anonymous pull of
   real PDCSAP `_lc.fits` by deterministic TIC+sector key. Gated by MAST_S3 var
   (code default off; production wrangler.toml sets "1" = always on).
3. Best-effort anonymous CAOM discovery (src/data/mastDiscover.ts): MAST_DISCOVER=1, default
   off; anonymous Cone returns {} without a token, so this tier is effectively dormant.
4. Seeded synthetic stand-in (src/data/synthetic.ts): reproducible light curve built from
   real catalog parameters, with realistic per-star red noise by default. Final fallback;
   guarantees deterministic offline runs.

Invariant: any external display must truthfully label lightCurveSource. The discriminator
is `/real photometry/i` on lc.source and BOTH branches must be implemented -- never
hardcode "seeded stand-in" in any card/copy (this bug happened once).

## 4. Runtime architecture: two hosts, strict parity

The same pipeline runs on two hosts and they must stay at parity:

- Node (local/dev): src/api/server.ts (Hono + @hono/node-server) serves the JSON API,
  SSE feed (/api/events), static dashboard under web/, and POST /api/run driving the same
  Orchestrator (src/orchestrator/pipeline.ts) on a shared RigStore with snapshot restore
  from out/state/rig.json. Artifacts via src/node/artifact-store.ts (filesystem).
- Cloudflare Workers (production): src/cf/worker.ts (edge Hono app) + RigStateDO durable
  object (src/cf/rig-state.do.ts, authoritative state + real-time fan-out) + RigRunWorkflow
  (src/cf/workflow.ts, durable per-seat steps) + R2 artifacts (src/cf/artifact-store.ts,
  bucket space-data-rig-artifacts) + Static Assets (./web served assets-first, zero Worker
  CPU for static files). Env typing in src/cf/env.ts.

RULE: any change to one side (routes, gating logic, data tiers, cap semantics) must be
mirrored on the other side, line by line. Shared logic should live in runtime-agnostic
modules (e.g. src/observe/rpcProxy.ts, src/observe/paymentPolicy.ts) imported by both.

Web dashboard: web/index.html + web/app.js + web/styles.css + web/live.js + web/space.js
+ web/vendor/three.js. The in-page burn helper is web/vendor/solana-burn.js, an esbuild
bundle of src/observe/browserBurn.ts (rebuild: `npm run web:bundle`; NEVER edit the
bundle by hand).

openrig/ directory: OpenRig integration assets (rig.yaml, agents, Dockerfile,
docker-compose, CULTURE.md).

## 5. Repository layout

- src/core/       RigStore, types, auth (ADMIN_TOKEN bearer, constant-time), anchor-verify,
                  stats-definitions.ts (what each public counter counts -- one predicate both
                  runtimes and the X digest call), ports.
- src/data/       catalog TAP, MAST tiers, FITS parsers, TGLC, TOI archive, Gaia dilution, synthetic.
- src/detect/     detrend, BLS, alias resolver hooks, transit fit (exact limb-darkened), ephemeris,
                  per-sector robust depth, significance/calibrated FAP, vetting discriminators,
                  shapeCoherence (in-transit median-vs-mean spike test + foldedBoxDepth per-sector joint-confirm;
                  research-only, never gates), SVG plots.
- src/sim/        exactTransit, transitModel, redNoise, injectInto, injectionRecovery, roc, confidence.
- src/critic/     review.ts (mission-critic verdicts, centroid vetting gate).
- src/candidate/  candidateRecord, dedup, falsePositive, prioritize, snapshot (blind-mode chain),
                  corroboration (applyLayerFilters L1-L4 + partitionBySystematic + corroborateByPeriod;
                  p22 applies L3 by default, collapsing multi-host shared-ephemeris groups out of the
                  emitted candidates; research-only).
- src/review/     externalReview.ts -- reusable library to independently audit a THIRD-PARTY
                  candidate claim (research-only; never gates, accepts, or anchors).
- src/claims/     claimReview.ts (p91) -- the pure decision layer that audits a public astronomy CLAIM's
                  STRUCTURE (subject/recency/attribution/band/corroboration) against resolved Crossref/arXiv
                  records. Distinct from externalReview: no ephemeris to re-fold, so it checks the claim, not
                  the sky. safeToGate is false by construction; research-only, never gates/anchors/claims.
- src/ai/         llm.ts, discussion.ts, threads.ts, deliberation.ts (side-channel LLM layer).
- src/orchestrator/ pipeline.ts, run.ts (CLI), regressionBaseline.ts.
- src/reporter/   narrate.ts (plain-English sentences, seat roles).
- src/bundle/     bundle.ts (canonical key-sorted JSON manifest -> SHA-256; verifyBundle).
- src/solana/     anchor-core.ts (endpointList, tx plumbing), anchor.ts (anchorBundleHash,
                  anchorDeliberationHash, anchorObservationHash, verifyObserveAnchor, ledger,
                  explorerUrl, loadLocalEnv).
- src/observe/    the paid "Named Observation" feature: observation.ts (record shape),
                  dedication.ts (content policy), paymentPolicy.ts ($SDR burn policy +
                  resolveAnchorDailyCap), x402.ts (402 shapes), connection.ts (single place
                  that reads the chain, raw JSON-RPC getTransaction jsonParsed), burnVerify.ts,
                  observeApi.ts (computeObservation/commissionObservation), evidence.ts,
                  rpcProxy.ts (browser read-only RPC proxy), browserBurn.ts (in-page Phantom burn).
- src/seats/      seat definitions.
- src/survey/     rotation.ts -- which targets a rotating survey pass takes (selectRotationWindow over one
                  pool, selectMixedWindow when a pass is split between known hosts and blind TOI candidates).
                  The `surveyPass` counter on /api/state counts passes CLAIMED by this scheduler, not
                  completed ones; see src/core/stats-definitions.ts.
- src/deploy/     deployGuard.ts (refuses to upload a tree HEAD does not describe) and
                  deployWindow.ts (GO/WAIT/UNKNOWN for uploading onto a cron-driven survey,
                  from the live claimed-run state plus measured cadence; the stale threshold is
                  the DO's own isStaleClaim). Both pure, both pinned by tests/.
- src/figures/    the geometry and wording of published summary figures as pure functions over a
                  measurement record: anchorCountsFigure.ts, m4MilestoneFigure.ts (M4 panel over
                  p88/p89/p90/p91 plus the live counters and the measured cadence). No number is a
                  literal in these files -- the CLI captures the record, the tests rebuild the
                  committed SVG from it and require byte equality, and a missing field throws rather
                  than drawing a zero.
- src/api/        Node server. src/cf/: Workers side. src/node/: Node adapters.
- scripts/        p0..p30 experiment scripts (see section 6; p26 corroboration-ROC + p27 shape-coherence
                  measure the Stage-4 FP lever on real FFI; p28 corroboration-proof is a positive control on
                  KNOWN planets showing the blind per-sector path is under-powered for a real discovery)
                  + verify-observe.ts + p2-anchor.ts
                  + wallet-import.ts + validate-curated.ts + bls_astropy_check.py (dev-only)
                  + devlog-archive.ts (writes a devlog/ entry from the exact bytes that were dispatched)
                  + verify-xpost-shell.sh (see section 12; the only check on the x-post workflow's shell).
- tests/          the suite, run via `npm test` -> `tsx scripts/run-tests.ts`, which DISCOVERS every
                  `tests/*.test.ts`. There is no hand-maintained list to update; a new file in that directory
                  with that suffix runs automatically.
- devlog/         long-form operator summaries that were actually pushed to the public feed, archived with
                  their dispatch evidence (run id, posted tweet id, job-log line, pre-flight result) so a
                  long-form post can be audited against the commits it describes. See devlog/README.md.
- web/            dashboard.
- out/            local artifacts, state snapshot, fee keypair (gitignored), commit-message
                  drafts (cm-*.txt).
- state/          additional local state.
- wrangler.toml   production descriptor (every switch documented inline).
- README.md       1100+ lines; full science narrative and measured results.
- CHANGELOG.md    v0.1.0 release notes.
- GOVERNANCE.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE (MIT).
- .github/workflows/ci.yml: on push/PR to main -> npm ci, typecheck:all, npm test.
- .github/workflows/x-post.yml: CI-only (NO push trigger) -- `schedule` plus the `workflow_dispatch` wake the
                  Worker's cron sends twice an hour. Posts every tier a window can report; see section 12.

## 6. Science program (scripts p0..p25) and key measured results

Each `npm run pN:*` script is a self-contained experiment; results are narrated in README.md.
Headline measured facts (keep quoting them with their measurement basis):

- ROC (p1:roc): at 200 ppm noise, 15-day baseline, SNR>=7: completeness 68%, FAR 0%, purity 100%.
  minSnr=7 is data-justified. empiricalFap() maps candidate SNR to noise-ensemble FAP.
- Real-sky completeness (p1:real-completeness): injection into ACTUAL TESS photometry.
- Uncertainty (p1:uncertainty): statistical error bars under-cover; ~68% coverage only after
  an empirical inflation factor.
- Exact limb-darkened fit (p9): beats the crude box depth. But the limb-darkening floor is
  NOT removable (p13: fitting u1 lowers rms, true-depth error unchanged -- shape degeneracy).
- Long periods (p12/p14): per-sector robust median beats one stitched long fold
  (24.9% vs 34.7% median depth error, 18 planets). Depth accuracy is limited by phase
  coherence, not data volume. Ephemeris refinement before the long fold did NOT work (measured).
- Vetting calibration (p2:vet-calibrate): 14 confirmed planets all <= 0.57 arcsec centroid
  shift; critic rejects at > 2.0 arcsec (~3.5x margin). odd/even + secondary-eclipse
  discriminators are computed but NEVER gate (they misfire on real single-sector data).
- Blind/discovery mode (p5/p6/p7): blind re-detection of UNCONFIRMED candidates with the
  claim's ephemeris withheld; survey-scale operating characteristics measured. Stage-4
  candidate-chain validation (p23) measured that the FAP gate alone does not kill coherent
  systematics. Attribution always stays with the original claim author.
- p18 regressionBaseline: frozen baseline guarding byte-level reproducibility.
- BLS cross-validated against astropy (p2:bls-astropy, dev-only, needs Python).

## 7. Named Observation (paid feature, Phase 24/25) -- full flow

Users pay to commission a personalized, named observation of a real star. Price: exactly
10,000 $SDR (Token-2022 mint FvSE99EkoiTY8Wv34V2RpWVNxnrLe7o9gyKnd4HddtjQ, decimals 6,
so 1e10 raw units), burned (not transferred) via x402-style flow. The rig NEVER receives
$SDR: payTo is the System Program sentinel; value is destroyed.

Flow: web form -> FREE compute preview (GET/POST /api/observe, no spend, content gated by
dedication policy BEFORE any burn) -> in-page Phantom burn of exactly 10,000 $SDR
(web/vendor/solana-burn.js from src/observe/browserBurn.ts) -> POST /api/observe/commission
with X-PAYMENT header -> server re-reads the burn from chain (verifyBurnBySignature via
src/observe/connection.ts: isBurn, Token-2022 program, exact mint, exact amount, payer,
finalized) -> replay guard (one burn sig = one observation, observations/by-sig/<sig>.json)
-> idempotency (same envelopeHash replays prior receipt, no second spend) -> seal record +
anchor memo `sdr:observe:1` on Solana mainnet (gated by OBSERVE_ANCHOR + daily cap) ->
R2 artifacts observations/<hash>/{record,anchor}.json.

Evidence: GET /api/observe/evidence (?hash= or ?sig=) re-derives the envelope hash and
re-verifies the on-chain anchor; web Verify panel; CLI `npm run p25:observe-evidence`.
Offline PoC: `npm run p24:named-observation`. One-key gate: `npm run verify:observe`
(rebuilds bundle, typecheck:all, npm test, ASCII check, secret scan, p24 --commission).

Timing semantics (answer to a common user question): in live mode the observation is
sealed AND anchored immediately after the burn verifies -- there is NO waiting period.
The 28-day observation cycle is unrelated to anchoring; the pipeline uses already-archived
TESS-SPOC photometry.

## 8. Autonomous research loop (production)

Hourly cron (wrangler [triggers] crons=["0 * * * *"]) -> worker scheduled handler:
AUTO_RESEARCH="1" launches an autonomous run of AUTO_RESEARCH_TARGETS=8 targets
(Tmag <= AUTO_RESEARCH_TMAG=10, TIC-bearing so real S3 photometry); skipped when a run
is busy. AUTO_ANCHOR="live" + AUTO_ANCHOR_DAILY_CAP="100": only verdict=accepted findings
are anchored, DO autoAnchorBudgeted caps per UTC day, idempotent signature reuse.
~5000 lamports per memo. Pause spending without code change: AUTO_ANCHOR="off" + deploy.

## 9. Money paths, wallets, kill switches (READ BEFORE ANY DEPLOY)

Fee wallet (mainnet): HtFLWx4gHsnGSgT4uPa5PXZbhsuVZGCNCGN2sc1YHujK
= pubkey of out/anchor-keypair.json = Worker secret SOLANA_KEYPAIR. It pays all memo
anchor fees. Last measured balance: 0.09926 SOL (~19,852 anchors). It receives SOL, never
$SDR. The private key exists ONLY in out/anchor-keypair.json (gitignored) and the Worker
secret -- never log, print, commit, or upload it.

Switches (all in wrangler.toml [vars], documented inline there):
- OBSERVE_ANCHOR: off | dry | live (paid named-observation anchoring). Now "live".
- OBSERVE_ANCHOR_DAILY_CAP: "unlimited" (current, operator decision 2026-10-12) | number.
  resolveAnchorDailyCap semantics (src/observe/paymentPolicy.ts, shared by DO + Node):
  ONLY "unlimited"/"none"/"*" -> Infinity; positive integer -> that cap; 0/blank/garbage
  -> 0 which means ANCHOR NOTHING (safe stop). 0 is deliberately NOT unlimited.
- AUTO_ANCHOR: off | dry | live; AUTO_ANCHOR_DAILY_CAP="100" (independent concern).
- AUTO_RESEARCH: "1"/"0". MAST_S3: "1" real photometry tier. VET: "1" centroid vetting
  (code default is ON; VET="0" is the explicit opt-out). PERSECTOR: "1" per-sector depth.
- ADMIN_TOKEN (secret): gates mutating endpoints; unset = open.

Changing any money-path switch or deploying requires EXPLICIT operator go-ahead.

## 10. Operations runbook

Local: `npm run orchestrator` (CLI pipeline), `npm start` or `npm run api` (dashboard +
API + SSE on :8787), `npx wrangler dev` (edge simulation).
Verify gate before any commit: `npm run typecheck:all` (Node + Worker tsconfigs) AND
`npm test` (104 files / 798 tests as of 2026-10-18 after the M4 capture, none skipped -- the count only grows, so
trust the run over any number quoted in a document, this one included).
For observe changes also `npm run verify:observe`.
Deploy: `npm run cf:deploy:sha` (refuses a dirty tree; re-sets GIT_SHA from HEAD first).
BEFORE deploying, ask the rig: `npm run deploy:window` (rule in `src/deploy/deployWindow.ts`,
tested by `tests/deploy-window.test.ts`) prints GO/WAIT/UNKNOWN from the live claimed-run
state plus the MEASURED cadence, and exits 0 only on GO. Measured on 2026-10-18 over 24
recorded passes: the cron fires every 15 minutes, a full 8-target pass writes over a median
of 260 s (164-307 s) and the median idle gap between passes is ~2400 s -- so the survey holds
roughly a fifth of each slot, NOT the "45 minutes with seconds of gap" figure that circulated
in earlier plans. Never upload while a claim is live: a pass straddling two versions leaves
/health.gitSha able to name only one of them. After deploy, probe production:
GET /health (200), POST /api/observe/commission without payment (402, zero spend),
POST /api/rpc getHealth (200). Custom-domain 404 right after deploy = edge propagation
lag; check the workers.dev hostname first, retest in ~40 s.
Commit identity (repo has no local git config): 
`git -c user.name="Space Data Rig" -c user.email="bot@spacedatarig.app" commit -F out/<msg-file>.txt`
with `Co-authored-by: Space Data Rig <dev@spacedatarig.app>` in the message file.
CI: GitHub Actions on every push (Node 22, npm ci, typecheck:all, npm test). Verify via
the Actions web page when the anonymous API is rate-limited.

## 11. Hard rules (project red lines)

1. Conversations with the owner are in Chinese. Everything written INTO files (code,
   comments, README, scripts, commit messages, docs) is pure English ASCII -- no
   exceptions, verified by the ASCII gate.
2. Data honesty: never claim new-planet discoveries; always label the photometry tier;
   never fabricate numbers; report measured results with their basis.
3. Measure before gate: no threshold or gate ships without an empirical calibration script.
4. Secrets (SOLANA_KEYPAIR, RPC keys, LLM API keys, ADMIN_TOKEN) never appear in tracked
   files, logs, bundles, or anchors. Run the secret scan before every commit.
5. Money-path changes and deploys only on explicit operator instruction.
6. Public communications (tweets/devlogs): full text inside one copy-pasteable plain code
   block (no mixed headings/bold/asides inside), no time-implying words, numbers carry
   their measurement basis, no private-key talk, images generated fresh and attached
   separately outside the block, all proof links tested before publishing. Devlog-style
   "plain updates" are the default for progress write-ups, not marketing tone.

## 12. Known pitfalls (do not regress)

- Public mainnet RPC returns HTTP 403 to browser requests carrying a non-allowlisted
  Origin; @solana/web3.js v3 wraps it as opaque "Solana error #8100002". ALWAYS decode
  the base64 context in the error message first when triaging. Fix in place: same-origin
  read-only POST /api/rpc proxy (src/observe/rpcProxy.ts; allowlist of read methods only;
  sendTransaction and batch refused; 8 KiB body cap; endpoint failover; private SOLANA_RPC
  stays server-side). The wallet signs and submits the burn itself.
- Phantom signAndSendTransaction string path: send the FULL UNSIGNED WIRE
  bs58(tx.serialize({requireAllSignatures:false, verifySignatures:false})); the documented
  bare serializeMessage() form makes Phantom report "Transaction message version 2
  deserialization is not supported". browserBurn.ts tries unsigned-wire first and only
  falls back to bare-message on deserialization-class errors.
- web3.js here is v3.0.2 (@solana/web3.js kit): sign()/serialize() are ASYNC,
  serializeMessage() is sync, PublicKey.findProgramAddress is async, toBytes() not toBuffer.
- kit error #3610000: crypto primitives need a secure context -- Node-side E2E of the
  browser bundle is impossible; validate in a real browser over HTTPS (browser subagent +
  in-page evaluate + stub wallet works). Node 24 ESM cannot import https: URLs; fetch then
  import a data: URL if ever needed.
- cap=0 semantics: count(0) >= cap(0) is TRUE -> nothing anchors. "Cancel the cap" must
  be the literal "unlimited" sentinel, never 0.
- PowerShell 5.1: no && (use ;), no ?? / ternary; ASCII checks must be byte-level or
  [regex]::IsMatch per line -- (... -match ...).Count silently overcounts; Select -First N
  in a pipe can truncate exit codes.
- tsc --noEmit does not check tests/; the `npm test` runner (scripts/run-tests.ts) DISCOVERS
  every tests/*.test.ts automatically (with a FLOOR guard that fails loudly if discovery breaks),
  so a new test file needs NO registration. Do not reintroduce a hand-maintained file list.
- ExoFOP RA is sexagesimal HOURS, not degrees -- `parseRa` must multiply by 15. Getting this
  wrong squeezed every host into a 0-24 deg RA band; it was invisible in production (no `src/`
  import) but silently wrong in the Gaia-census research reports (P59/P81/P82/P84/P85), which
  is why those numbers are split by whether they use only pixel offsets or the Gaia neighbour
  field. The x15 is load-bearing, not cosmetic.
- A fixed bug that was never RE-RUN, or a re-run report never PUBLISHED, is the same failure
  class as an unfixed bug. Reports now stamp generatedAt+gitSha+input sha256
  (scripts/report-freshness.ts) and p86 refuses/RED-marks stale ones before publishing. After
  touching a checkpoint or a report's inputs, RE-RUN the downstream report(s) AND rebuild
  web/reports (npm run p86:report-library) before saying a figure is current.
- ANY content hash used for provenance must be computed on EOL-NORMALISED bytes, never on raw
  working-tree bytes. This repo pins `* text=auto eol=lf`, but a Windows checkout with
  core.autocrlf=true still materialises tracked text files as CRLF, so a stamp recorded by CI
  (LF) did not match the same file locally (CRLF) and p86 refused to publish a report whose
  inputs had not changed at all -- `git show HEAD:<path>` was byte-identical. See
  normalizeEol/sha256File in scripts/report-freshness.ts; binary is left untouched (NUL in the
  leading 8 KiB, git's own test). Corollary: a report whose rows are only partly ordered is
  byte-unstable, which silently invalidates every stamp that records it -- fetchConfirmedPlanets
  therefore tie-breaks sy_tmag on pl_name then pl_orbper, with plain code-unit comparison (NOT
  localeCompare, which depends on host ICU data).
- NEVER amend or rebase a commit that carries a built web/reports/ artifact without rebuilding
  it afterwards. index.json records builtAtGitSha; rewriting the commit leaves that field naming
  a SHA that was never pushed (merge-base --is-ancestor exits 1). tests/report-freshness.test.ts
  fails on exactly that. Rebuild, then commit as a NEW commit -- the field legitimately trails
  HEAD by one, which shaNote documents.
- A background terminal left in PowerShell continuation mode (`>>`) keeps whatever was typed as
  pending input and can flush it later, executing commands nobody just issued. This silently
  re-ran scripts/p89-multiepoch-di.ts and overwrote committed reports/p89-multiepoch-di.{json,md}
  with different parameters mid-session. ALWAYS run `git status --porcelain` immediately before
  committing, add files EXPLICITLY by path (never `git add -A`), and treat any report file you did
  not just regenerate as an incident to investigate rather than as your own work.
- A verification flag must say what was actually CHECKED, not merely that a record exists. The
  freshness gate's `stamped` meant "has a generatedAt timestamp", so reports carrying a timestamp
  and zero input checksums (p88, p89 -- their generators grew buildStamp AFTER those artifacts were
  written) were published inside a "6 stamped" count that read as "6 machine-checked". The honest
  reason string was computed by evaluateAgainst and then dropped, because only hard-stale reports
  got a banner. `verified` now means "at least one recorded checksum was re-hashed and matched"
  (4 of 48). When adding any provenance/health flag, ask which of the two it is, and never let a
  reason string be computed and discarded: if the gate knows something the reader does not, publish
  it -- as a soft note when it is not a failure, so honesty does not become a false-positive machine.
- A cursor shared by two tiers that fire under DIFFERENT conditions starves the rarer tier. The X
  digest anchored both the science window and the build-note window to the newest tweet of any kind.
  The dev tier is reached only when a window has NO science, so every science post silently advanced
  the cursor past commits the dev tier had never reported -- a five-commit push yielded one build
  note covering one commit, and two shipped fixes were never announced. Give each tier its own
  cursor (the dev tier now reads the newest BUILD NOTE off the feed, via an exported
  `BUILD_NOTE_HEADLINES` list it matches by membership, since `pick()` rotates the wording). Two
  related traps: a stream carrying more than one value must be LABELLED, not parsed with
  `grep -Eo <ISO> | tail -1`; and if you must recognise your own past output, keep the strings it
  can produce in ONE exported place and assert the matcher accepts every one of them.
  Removing the one-post cap then MIRRORED the same defect onto science: once a single run can post
  several items, a build note posted late in that run becomes the newest tweet and pushes the
  science cursor past the instant the science data was fetched. A cursor must be anchored to the
  newest post OF ITS OWN KIND, not the newest post -- hence a third cursor, `last_science`
  (`newestScienceAt`, skipping build notes AND heartbeats). When a batch loop can fail partway,
  also order it so the unsent remainder stays AHEAD of the cursor: the posting loop breaks on
  failure and the batches are oldest-first, so an aborted run under-reports and self-heals next
  window instead of permanently dropping the newest work. Widening a window is the safe direction
  (re-scanning reports nothing twice), narrowing it is the dangerous one.
- A self-imposed volume cap is silent data loss, not a safety measure. The X path carried four
  independent rations -- one post per window, the build note composed only when the science tier
  was empty, `head -5` on the commit backlog, and a filter discarding every `docs:` subject -- and
  each one dropped reportable work without logging that it had. None was required by the platform
  or by an honesty red line; they were guesses about not looking like spam. Distinguish FEED
  PROTECTIONS (byte-identical dedupe, a generous runaway ceiling that leaves the remainder ahead of
  the cursors, a delay between posts so a backlog cannot trip rate limits) from RATIONS (anything
  that decides reportable content is not worth reporting), keep only the former, put every number
  in `env`, and pin the absence of the latter with a test that greps the workflow -- otherwise a
  future tidy-up reinstates `head -5` and nobody notices.
- A content guard plus a break-on-failure batch loop is a permanent stall, not a skipped item.
  `post-x-text.ts` refuses (exit non-zero) any final text tripping `overclaimViolations`, and the
  x-post loop breaks on failure so the cursors -- read back off the feed -- cannot advance past an
  unsent item. Both are right alone. Together, one commit subject containing a stem (`first`,
  `novel`, `confirm`, `discover`, `unprecedented`, `landmark`, `historic`) makes its whole batch
  unpostable FOREVER: every window re-composes it, is refused, and the backlog never clears. Note
  `\bfirst\b` matches inside a hyphenated `oldest-first`, so ordinary phrasing is enough. Fix at the
  COMPOSER, not by weakening the guard: `classifySubject` drops the offending bullet and
  `rejectedDevSubjects` makes `main()` log each drop with its reason, so the feed's silence about a
  commit stays explainable. Two general rules follow. (1) When you add a hard-fail guard, ask what
  happens to a batch that can NEVER satisfy it -- the failure must be escapable. (2) Never relax a
  guard to let your own text through: the guard refused an authored summary for saying
  "oldest-first" and "the first failure", and the correct response was to rewrite the summary.
  Run authored text through the real guard BEFORE dispatching it, not after a
  `completed/failure` run: `npm run x:post -- --text-file <path> --max-len 25000`
  in an environment with no `X_*` credentials performs the full ASCII + length +
  over-claim validation and prints `DRY RUN` without sending anything. It is the
  same code path the workflow uses, so it cannot disagree with production.
- The x-post workflow's shell path is CI-only and no test covers it, so a green `npm test` proves
  nothing about it -- that blind spot is how the four rations above shipped. A MIRROR of the logic
  is not enough either: it passes while the real file is broken. `bash scripts/verify-xpost-shell.sh`
  now extracts the actual `run:` block from `.github/workflows/x-post.yml` with awk and EXECUTES it
  with `npm run x:post` and `curl` stubbed (the stubs must be `export -f`'d -- the block runs in a
  child bash), then asserts nothing reached X, every recorded item is non-empty ASCII within the
  ceiling, both cursors and the backlog count were echoed, and the script reached its summary line.
  After deploying, still read the NEXT scheduled run's job log: the cursors are logged on every run
  precisely so they can be verified from a run where some tier never fires.
- Any fixed-decimal render of a measured quantity is a claim about its precision, so the number must be
  rendered from the resolution the METHOD had, not from a format string. The BLS in `src/detect/bls.ts`
  returns `P = 1/(fMin + k*df)`: a node of a discrete trial grid with no continuous fit anywhere in the
  path, and node spacing grows as `dP = P^2 * df`. `toFixed(2)` therefore meant hundredths of a day were
  honest at P=2 d and fiction at P=16 d, where one step is ~1.2 d -- and the feed had already published
  "P=16.00d" for exactly that case. Two rules follow. (1) Carry the resolution with the value at the
  point of measurement (`periodResolutionDays`) and render through one place, `src/core/periodFormat.ts`
  (uncertainty to one significant figure, value matched to it, PDG convention); when a record predates
  the field, fall back to the resolution the SHORTEST plausible baseline would have given, so the
  fallback can only ever under-claim. (2) The `k=0` node IS the long-period boundary of the search, so
  a peak there is the search running out of range, not a measurement -- keep the boundary flag
  (`atSearchBoundary`) and say "at least N days (the search limit)". Record such a fact as an
  INFORMATIONAL NON-GATING check: `scienceProjection()` drops checks named `/non-gating|post-hoc/i`, so
  the bundle keeps its commitment, the content address and every already-anchored science are unchanged,
  and no verdict semantics move without a calibration run.
- When a pipeline refines a measurement, EVERY number derived from the old one has to move with it -- or the
  refinement must be refused. Two traps of the same kind fired together in src/cf/workflow.ts, and the record
  itself proved it: (1) the per-sector depth fit assigned `candidate.depthFrac` and left `depthPpt` holding the
  box depth, although the type documents them as the same quantity in different units, so 84 of 90 published
  records carried a self-contradiction and the anchored bundle inherited it; (2) `snr` is `depth/sigma*sqrt(nIn)`,
  computed from the BOX depth, so after the replacement the quoted significance described a depth the record no
  longer showed. KELT-24 b published 38 ppm beside an SNR of 252.5/40 points, which needs 0.96 ppm of per-point
  scatter -- under TESS's photon floor -- while 6100 ppm (the surviving box depth) needs a normal 153 ppm. Rules
  that generalise: never store a value in two units and update one of them (make a single writer own the pair);
  when a second estimator replaces the first, keep both and label which one is published; and sanity-bound the
  adoption -- an estimate that disagrees with the measurement it is refining by more than a stated factor is
  measuring something else, so refuse it and keep the value the verdict was gated on. Decide this in a pure
  module (src/detect/depthAdoption.ts) the tests can drive, not inline in a Durable-Object workflow that Node
  cannot load. Fix FORWARD only: historical anchored bundles keep their inconsistency, because re-deriving a
  published field would change content addresses that are already committed, and a disclosed stale record beats
  a silently re-priced one.
- A log-grep auditor is unsound once the log contains the audited content, and a job log does. The first
  `scripts/xpost-health.ts` reported "DRY RUN in production -- credentials missing" for a run that had in
  fact posted, because the summary it pushed contained the words "prints DRY RUN" and the workflow echoes
  whole post bodies into the log. Anchor every status signal to the emitting tool's own prefix
  (`^x:post: OK posted`, `^tier manifest:`), after stripping the timestamp, and treat a failure-looking signal
  that contradicts positive evidence from the same run as content, not status -- then pin BOTH directions
  with fixtures, or the next "tidy" will unanchor it again. The corollary for the data model: counts that
  include already-handled work are not stalls. `build-note backlog: N` counts subjects in the window
  including ones the feed already announced, so the sound test is the RESIDUAL against
  `alreadyReported`, not `N > 0`.
- The same trap in a checksum gate: `verified` in scripts/report-freshness.ts was computed from whether a sha256
  had been RECORDED, while the published definition it printed said the gate "re-hashed" it -- so three of the
  four reports the site called machine-verified were checkable only on the workstation that generated them,
  because their stamps hash `out/scaled/*.jsonl`, a gitignored path present on no other checkout. A gate must
  measure its own act, not the presence of a promise to perform it: require an actual comparison against bytes
  that exist (`rehashed`), require that the bytes are ones a stranger can obtain (`reproducible`, via
  `gitTrackedPaths()`), and expose the shortfall (`unverifiableInputs`, `untrackedInputs`) instead of rounding a
  partial check up to a clean one. Expect the honest count to FALL when you write this correctly; that fall is
  the finding.
- Which tiers POSTED is not which tiers were ATTEMPTED, and a log that records only the former cannot tell
  "nothing honest to report" from "the tier never ran" -- the same blind spot that let a 22-hour survey
  freeze pass green CI. Emit an explicit per-tier manifest on EVERY run (`tier manifest: ledger [...] blind
  [...] ...`, `not-attempted` when the file is absent) and assert its presence and its full tier list in
  `scripts/verify-xpost-shell.sh`, so absence of evidence becomes evidence that can be tested for.
- The run-mutex + rotation-cursor path (src/cf/run-mutex.ts) is STATEFUL and lives in a
  Durable Object that imports `cloudflare:workers`, so it CANNOT be loaded by the Node test
  runner -- that is exactly how a 22-hour survey freeze slipped through a green CI. The decisions
  are extracted to run-mutex.ts so tests/run-mutex.test.ts drives the PRODUCTION logic; keep new
  claim/advance/finish behaviour there, not inline in the DO.
- Durable Object RPC return types arrive with & Disposable -- do not cast them away.
- After esbuild changes to browserBurn.ts, ALWAYS `npm run web:bundle` and commit the
  regenerated web/vendor/solana-burn.js (deployed bundle must match local byte-for-byte).
- wrangler deploy can fail on "Trigger configuration only partially updated" (fetch
  failed) while the code itself deployed fine -- retry once and confirm.

- CAPPING a bad substitution is not fixing it. The depth guard limited the per-sector fit to 5x of the detector's
  box depth and then, measured on the live rig, 10 findings had adopted a refinement and 7 still quoted the SNR the
  box had produced -- a record whose published depth and quoted significance describe two different transits, just
  closer together than before. `snr` is `depth/sigma*sqrt(nIn)`; sigma and nIn are properties of the fold, so
  REPLACING a depth silently re-prices the significance and must re-price it in the same step (one helper, no
  call-site assignments). Never declare a defect class closed without re-measuring it against production output.
- Keep the gate in the units it was calibrated in. `detectionSnr` (the box statistic) is what the >= 7 floor and the
  empirical FAP ensemble must read, because both are distributions produced by running BLS on null light curves; the
  published `snr` describes the published depth. Feeding a shape fit's re-priced SNR to a box-statistic threshold is
  a unit mismatch, and on the live set it would have pushed 3 records under the floor -- a verdict-semantics change
  that needs its own calibration study, not a side effect of a formatting fix.
- A "no comparison possible" branch must adopt NOTHING. With a non-positive box depth (BLS power is
  `Swy^2/(Sw(1-Sw))`, sign-blind, so a bump can win the period grid while `depth` keeps the sign) the first version
  of the guard published the fitted positive depth and left `depthSource` saying `bls-box`: an anti-transit was
  described to the public as a 46 ppm dip. Absence of a comparator is not evidence that substitution is safe.
- An auditor whose rules anchor on a tool's own status line must strip the npm runner wrapper (`<script-id> stderr:`)
  first. The un-stripped anchor never matched, the field it fed stayed null, and the backlog rule could therefore not
  fire in EITHER direction -- printing both "no stall" and "not a stall" while measuring nothing. Write log parsers
  against a line copied out of a real job log, never against a remembered one.

- Test the layer that WRITES the sentence, not only the layer that posts it. The posting guard rejects discovery-grade
  stems by regex, and `src/reporter/narrate.ts` still produced "N confirmed" in an unwired function plus "the star's
  brightness dips by about -105 parts per million ... the fingerprint of a planet crossing the star" for a candidate
  whose box landed on a brightening. Numbers get audited; prose gets assumed. tests/narrate.test.ts now scans every
  narrated string across verdicts and both depth branches -- keep that scan green when adding wording.
- Commit what an auditor needs, do NOT content-address it. Adding the scatter / box depth / search statistic to the
  bundle manifest made the published depth+SNR pair checkable from the committed file; letting those fields into
  `scienceProjection` would have given identical published science different scienceHashes and broken the anchor dedup
  (the audit-3 P0-B double-fee bug). New diagnostic fields therefore go in `PROVENANCE_ONLY_CANDIDATE_KEYS`.
  Rule for future fields: if it describes HOW a number was produced, commit it and exclude it; if it IS a published
  number, put it in the address and expect re-anchoring.
- A negative result from a search is only valid inside the scope you actually searched. Reading "no tests matched
  `tests/*.ts`" as "this module is untested" was wrong: the workspace root is ABOVE the repository, so the glob never
  looked in the right directory, and an existing 5-test file was overwritten before `git restore` undid it. Scope the
  claim ("found none under <absolute path>") or run the check a second way before concluding absence.
- A "+/-" is a COVERAGE claim, not a median. The measured median absolute depth error is 33.0% and the radius that
  covers 68% of the rows is 48.0%; publishing the median as the error bar under-states it by construction. Check
  BEFORE inventing one too: p9 already answered this (README, "Can we make the error bar honest?", k = 3.2 inflation
  to reach 68% coverage), and this pass built a third recipe before finding it. The tail here is far heavier than a
  normal one (95% needs 104.4% where 68% needs 48.0%, a ratio of 2.17 against the 1.96 a Gaussian would give), so
  never double the quoted bar and call the result a 95% interval.
- Any surface that renders a MEASURED number must render its uncertainty from one rule with every other surface.
  The period case proves the cost of splitting them: `src/core/periodFormat.ts` banned fixed decimals in the narration
  while `web/app.js` kept printing `.toFixed(3)` on three cards, and the depth got the same treatment in reverse
  (integer ppm plus three-decimal percent). Where a browser mirror is unavoidable (no `allowJs`), pin it: a parity
  sweep over the real input ranges, equal constants asserted in both languages, structural assertions that the call
  sites exist, and a test that re-derives the cited statistic from the committed data (tests/depth-honesty.test.ts).
- A replay/regeneration mode must take its SAMPLE DESCRIPTION from the stored run metadata, never from the CLI
  defaults. `--from-json` first rewrote the report header to `P in [0.8, 15] d` for rows gathered with `[0.8, 8] d`, then
  persisted that into the next JSON -- one regeneration cycle silently corrupted the provenance of the sample. Read
  every parameter you print from the stored meta, and label the output as a replay so a reader can tell a re-analysis
  from a fresh observation.
- A committed report is not a published report. `reports/<slug>.md` is the record; `web/reports/<slug>.html` (built
  by `npm run p86:report-library`, committed, served by the site) is what a reader opens. They are generated apart,
  so a new study can be announced and linked while its URL 404s -- which is how this round's own post found it.
  tests/report-library.test.ts now fails if any `reports/*.md` lacks a page, or the index and the pages disagree. When
  you commit a report, run the generator in the same commit; expect a code change to cost an OLD report its
  `verified` mark (p41 lost it when bls.ts changed) and treat that as the gate working, not as a regression to undo.
- `/health.gitSha` is only a proof if the deploy refused a dirty tree. wrangler uploads the FILES ON DISK while the
  script sets GIT_SHA from `rev-parse HEAD`; between commits those name different things, and an automated
  gap-catcher deploy uploaded uncommitted work while /health certified the last commit (2026-10-18, 09:19Z-10:38Z:
  seven records were narrated by code no CI run had seen). The script printed a warning -- warnings that change
  nothing are how this class survives. `src/deploy/deployGuard.ts::deployDecision()` now REFUSES any uncommitted
  path before the secret write and before the upload; `--allow-dirty` exists for a deliberate emergency and logs the
  lie explicitly. Never deploy from a watcher while you are mid-edit: commit first, or do not deploy.
- An unmeasured cadence belief turns every deploy into a gamble. The plan asserted passes
  take ~45 minutes with only seconds of idle; the measurement (`npm run deploy:window`) says
  ~260 s per full pass inside a 15-minute cron with ~2400 s of idle between passes. Both
  failure modes come from believing the number instead of taking it: shipping inside a live
  pass, or waiting for a narrow hole that does not exist and leaving production stale. Take
  the verdict from the tool, and treat UNKNOWN (site unreachable) as "do not deploy", never
  as "probably fine".
- A convention written only in prose is a convention that lapses. GOVERNANCE.md says commits
  are co-signed and this file documented the trailer to use -- and two commits were pushed
  without it, with every gate green, because nothing looked. `tests/commit-co-sign.test.ts`
  now checks the HEAD commit for the co-sign trailer and the labelled author identity, so the
  next omission fails `npm test` before it can be pushed. The two commits were NOT rewritten
  (published history is what the ledger and devlog cite); the deviation is recorded here and
  in CHANGELOG instead.
- Detect a stale deploy by testing what production WRITES, not what it reports. The mismatch above was found only
  because a live record's sentence did not match any committed renderer. When you verify a deploy, compare a
  rendered artifact against the code that should have produced it; the self-report is the thing being audited, not
  the evidence.
- A count is a claim about a question, and one field can only answer one. `stats.bundlesAnchored` (7) counted findings
  whose CURRENT bundle still matches a chain commitment, while the tile under it said "on-chain", which asks how many
  commitments exist (18, from `/api/ledger`). They differ because a bundle hash folds the run timestamp: re-derive a
  sealed record and it leaves the first count without leaving the chain. If two questions are visible to a reader, both
  need a field and a label -- and put the definition where the code is read (src/core/state-types.ts), not in a chat log.
  The seventh pass found the same class in the rotation counters: `blindCandidates` counted every blind row INCLUDING
  critic-rejected noise while the digest counted only survivors (board 47, feed 26), so the population is now split
  into `blindHeld`/`blindCandidates` behind one predicate `isHeldBlindCandidate` (src/core/stats-definitions.ts) that
  the DO SQL, the Node mirror and the digest all call -- a hand-written copy of the filter in any surface is the bug
  waiting to reappear. `surveyPass` is passes CLAIMED (not completed) and `distinctHosts` is hosts with a RECORDED
  RESULT (not targets analysed); the board renders both truths.
- Touching a report's hashed INPUT obligates a RE-RUN of that report, not just a code fix. The freshness gate
  (scripts/report-freshness.ts) re-hashes each report's recorded `inputs` before p86 publishes the site, so editing a
  load-bearing source a report depends on makes that report STALE and blocks the publish with a non-zero exit -- by
  design. When you change a file listed in a report's inputs (e.g. `src/detect/bls.ts` for p41, which had been sitting
  stale since the depth-honesty fix), re-run that study so it records the new hash, THEN build the library; skipping
  this leaves a stale report blocking every subsequent deploy.
- An append-only ledger keyed by finding id is NOT append-only. Both ledger writers stored the newest attempt over the
  row (`INSERT OR REPLACE`, and `{...prior, ...next}` on the fs side), so a failed re-anchor erased the signature and
  explorer URL of a commitment still live on mainnet, and the total fell on an RPC hiccup. `mergeLedgerRow`
  (src/core/anchor-verify.ts, used by BOTH runtimes) refuses to demote a landed row; the failed attempt lands in
  `lastAttempt*`. When you add a counter over a keyed-mutable table, check what the write path can destroy, not only
  what the read path filters.
- A "single source of truth" with no call site is just a second source, and the reader never sees it. The seventh pass
  wrote the counter definitions into `PUBLIC_STAT_DEFINITIONS` and then typed the same sentences by hand into
  `web/index.html` tooltips, so the module documented as authoritative had zero callers while the prose on the page was
  the copy that could drift. Fix pattern: publish the definition on the payload (`DashboardState.statDefinitions`,
  filled from the constant by both runtimes) and have the browser render from it, so the markup carries no copy -- and
  let a server that sends none produce no tooltip rather than an unverified one.
- Dead code plus a stale comment is how a fixed bug comes back. `RigStateDO.advanceSurveyPass()` had no callers, and the
  comment above it described the tail-side cursor advance -- the exact control flow whose absence caused the 22-hour
  survey freeze (audit-6). Anyone "restoring" it would reintroduce the incident with plausible documentation beside it.
  The DO cannot be imported into the Node test runner, so the guard is textual: `tests/run-mutex.test.ts` asserts no
  pass-advance RPC exists, that `decideAdvance` has one production call site inside `decideStart`, and that every
  `surveyPass` write is inside the atomic claim. Where a runtime boundary blocks the import, assert on the source text
  rather than leaving the wiring untested -- that is what made the freeze survivable in the first place.
- The repository map drifts silently, because nothing reads it while working. HANDOFF section 5 was missing
  `src/figures/` and `src/survey/` for weeks. `tests/repo-hygiene.test.ts` now compares the layout against the actual
  `src/` directories in both directions: a room that exists and is unmapped fails, and a mapped room that no longer
  exists fails too.
- A gate can also fail because the environment cannot answer. `tests/handoff-freshness.test.ts` checks that every
  commit sha section 13 names is reachable from HEAD; it passed locally and went red in CI, because `actions/checkout`
  defaults to `fetch-depth: 1` and in a shallow clone every real ancestor reads as unreachable. Two changes, neither of
  them a relaxed assertion: `.github/workflows/ci.yml` fetches full history (`fetch-depth: 0`), and the test now fails
  with "this checkout is shallow, so commit reachability is unknowable here" rather than accusing a real commit of
  being invented. When a check depends on the environment (history depth, an external file, a network path), make it
  name the missing precondition -- and never let an unavailable answer be reported as a passing one, which is how
  `existsSync("out/probe-*.fits")` quietly skipped six MAST gates for months.
- A summary that nobody rebuilds is a stale page waiting to happen (round-26, R26-3a/b). `web/research.json` is written
  by `scripts/p38-research-bundle.ts` from `reports/*.json`, linked from the feed post as "Numbers + data", and rendered
  by `web/app.js` as a metric card -- yet no workflow rebuilt it and no test compared it to its sources, so it published
  a superseded compute exponent and an addressable-veto block for six days after the reports behind it moved. If you
  add a derived public asset, wire its rebuild into `freshness-regen.yml` AND add a currency test that rebuilds into a
  scratch path and diffs; `tests/research-bundle-currency.test.ts` is the template, including the discipline that the
  gate and its positive control must not read the same file (when the stale asset was installed as the committed one,
  the control went red because it had nothing left to compare).
- A drill that spawns a real script with cwd at this checkout inherits this repository's history (round-26, R26-11).
  `tests/x-post-preflight.test.ts` builds a throwaway git repo for the pre-flight's window checks but launches the
  extracted workflow step from the suite's own directory, so every `git log` inside the step read the real repo: the
  commit that refreshed `web/research.json` flipped the F13 empty-window verdict for a reason unrelated to the gate, and
  the suite had been green purely because no recent commit touched that path inside the synthetic window. Set
  `GIT_DIR`/`GIT_WORK_TREE` to the fixture explicitly (cwd may stay, when the step refers to repo-relative script
  paths), and treat "it passed for weeks" as no evidence of hermeticity. CONSEQUENCE FOR THE PUSH RITUAL (round-26,
  R26-13): gates are run against a tree, but a history-reading test changes meaning when the commit lands. CI was red on
  `e97c4fd` for exactly this reason -- locally the suite had been green at 1011/0 with HEAD still on the pre-refresh
  commit. When a commit touches a path that a window or freshness check inspects, run `npm test` AFTER committing, with
  that commit as HEAD, before pushing.
- A gate that reads the FIRST LINE of a markdown bullet is blind to anything the writer places on a later line, and will
  accuse a compliant author of non-compliance (round-26, R26-16). The R25-11 handoff check demanded the Production
  bullet carry `awaiting deploy`, but scoped its search to the single line matching `- Production:` and matched the
  phrase case-sensitively -- so a disclosure written one line down, next to the version id it qualifies (exactly where a
  careful writer puts it), failed for a formatting reason rather than for the silence the check exists to catch. When a
  check scans structured prose, scope it to the whole block the prose occupies and match case-insensitively; prove the
  widened scope still fires with `scripts/audit/mutate26-handoff-marker.mjs`, which strips EVERY case variant (a
  single-occurrence replace would delete the bullet's historical mention of the marker and leave the live one, so the
  drill would report success about nothing).
- A positive control anchored to a fixed POSITION in git history decays silently as new commits land on top of it
  (round-26, R26-17). The research-bundle currency test's control read "the second-newest revision of
  `web/research.json`" and asserted the diff names `compute.exponentP`; that held the day it was written, then the
  round's own refresh and the fleet's refresh both landed after it, so the slot pointed at an already-refreshed bundle
  and the control became a no-op -- the gate passed for a whole merge while believing it had teeth, and only a rebased
  HEAD re-running the suite exposed it. Anchor a control to the FACT it demonstrates (walk the log for the revision that
  still carries the old figure; assert the shipped one has moved past it), never to where that fact happened to sit. The
  same discipline as "a gate and its positive control must not read the same file", extended to history.
- A classifier that decides by SUBSTRING MENTION over-claims, and an over-claim in the "this needs network" direction
  hides work that could be done offline (round-26, R26-20). `unattested-blockers26.mjs` marks a generator
  `network-needed=true` if its source contains `fetch`/`http`/a fetcher module name anywhere -- including a URL in a
  comment or an import that is never called on the path that runs. Do not accept that as evidence: detect the CALL SITE
  (`fetch(`, an awaited live client), as `scripts/audit/net-census-audit26.mjs` does. Here the measurement happened to
  agree with the regex (all 32 really fetch), but the value is in the method -- and in the same sweep, the derived public
  assets in `web/` must each answer "is there a test that rebuilds you from committed inputs and byte-compares?" Only the
  offline-rebuildable ones are gateable without a runner: `research.json` and `replay-manifest.json` now are;
  `candidates.json`/`observe-stars.json` need a networked p22/p24 run and are named as such rather than left implied.
- A per-module test that pins an invariant in the GENERATING code does not prove the invariant holds in the SHIPPED
  bytes (round-26, R26-21). `discoveryClaim` and `safeToGate` -- the two red lines -- are asserted false across many unit
  tests of the functions that build them, yet nothing read the committed `reports/*.json` and `web/*.json` artifacts as a
  corpus, which is what the site actually serves. The same artifact-vs-source gap that let `research.json` publish a dead
  figure for six days applies to the honesty invariants too. Scan the corpus, and scan it RECURSIVELY: a nested
  `foo.discoveryClaim=true` is the same breach and a top-level key lookup misses it. Prove the scan is not a tautology by
  asserting the fields appear at all, then tampering a real artifact (`scripts/audit/mutate26-redline.mjs`) and requiring
  the corpus case to name the offending file.
- A published list and the files it points at must be kept a bijection, especially when a merge -- not a clean build --
  can assemble the shipped state (round-26, R26-22). `web/app.js` maps each `web/reports/index.json` row's `slug` to
  `/reports/<slug>.html`; only p90's page was pinned, so a row whose fragment was never built (or merged away) is a
  visitor-facing 404, and an orphan fragment is dead bytes on the CDN. `freshness-regen` publishes index and fragments
  with `-X ours`, so the committed pairing is a possible merge product, not guaranteed by p86 having run cleanly.
  `tests/report-library-bijection.test.ts` asserts both directions from the tree (hermetic -- CI runs it without network).
  The live probe `scripts/audit/live-link-integrity26.mjs` confirms it against the edge but only CONCLUDES when the
  network answers; when it times out, say "unreachable", never "clean" and never "broken" -- a transient connect failure
  is not evidence either way.
- A tool must be run before it is trusted, and held to the honesty rule it itself documents (round-26, R26-23). The live
  probe above shipped with two defects its own prose forbade: no request timeout (a single stalled edge connection froze
  the run forever) and `status=0` from a timeout counted as BROKEN -- at concurrency 6 it accused 14 rows of 404s that
  were transient network faults, the exact false accusation the tool's contract warns against. Fixed by bounding every
  request (`AbortSignal.timeout`), catching the top-level index read, dropping concurrency and retrying once, and
  splitting three honest buckets: BROKEN (exit 1, a real non-200/non-HTML response), INCONCLUSIVE (exit 2, unreachable
  after retry -- neither a pass nor a defect), OK. The lesson generalizes: the gap between a check's stated discipline
  and its implementation is invisible until you run it against the failure it claims to handle.
- "It fails loudly" is not the same as "it fails legibly" -- and only re-running the tool tells you which (round-26,
  R26-25). Sweeping the fleet (R26-24) cleared `live-readback26` because it had a timeout, but executing it showed the
  timeout surfaced as an uncaught `DOMException` stack trace at exit 1: a reader cannot tell "the network is down" from
  "the tool crashed" from "the served bytes disagreed," and a non-zero exit code fired for a transient failure violates
  the round's own rule that such a failure is not a defect. The fix is the same three-bucket shape as R26-23: bound the
  request generously enough that a slow-but-live large payload is not wrongly declared unreachable (the mirror image of a
  false 404), catch per request, and reserve exit 2 for a clean "UNREACHABLE ... NOT a pass and NOT a defect." A negative
  sweep verdict (R26-24: "sound, has a timeout") is a claim about the tool's code path, not about its observable output --
  confirm the output too. The same lens caught `ci-watch26` (R26-26): it set a timeout but only mapped a bad HTTP *status*
  to a legible error, so a *thrown* fetch still crashed with a stack trace. "Has a timeout" and "fails legibly on a
  timeout" are independent properties; audit each network tool for both, and record which ones already pass so the next
  reader does not re-sweep them.
- A capability claimed in prose must be traced to the field the production caller actually sets (round-26, R26-27). A
  public reply describing the candidate gate named common-mode subtraction and a "systematics-inclusive null" as checks
  that run before something is called a candidate. Both modules exist, are tested, and `review.ts` will gate on
  `systematicsFap` if supplied -- but the live workflow builds the gating `vetting` object with only `fap` (per-star
  `calibratedFap`) and `centroidShiftArcsec`, never `systematicsFap`, and never subtracts common mode from the real
  curve. The gap between "a module exists and could gate" and "the money path feeds it" is the deployed-but-inert class
  reached through writing instead of code. The committed docs were already right; the un-posted draft was the only wrong
  artifact. Before publishing any "the pipeline does X" statement, read the assignment sites in `src/cf/workflow.ts`,
  not the list of modules under `src/detect/`.
- A blocker stated as "needs X" is often "needs X AND Y" -- check the other half before spending the scarce resource
  (round-26, R26-29). The 33 unattested rows were framed as "waiting on a networked fleet run." They also need their
  generator to call `buildStamp`, and none of the 33 do -- so a networked re-run alone would STILL emit unattested rows,
  burning the scarce runner for nothing. `scripts/audit/stamping-plan26.mjs` reads the authoritative unattested set from
  `index.json`, maps each to its generator, and extracts the committed DATA inputs it reads (excluding its own output,
  which is circular). Beware the tempting shortcut: stamping only the generator's own source flips a row to `verified`
  while checking nothing but "the code file did not change" -- the hollow false-comfort report-freshness.ts warns about.
  Only 7 of the 33 have a real committed upstream input to stamp meaningfully; the other 26 are pure-network and need a
  provenance design, not a code-only stamp. Name them; do not paper over them.
- A tool's own output is a CLAIM, not a fact -- verify it against the read site before acting on it (round-26, R26-31).
  `stamping-plan26.mjs` printed "10 determinable" and a ready `buildStamp([...])` line each; trusting that verbatim would
  have wired circular stamps into p33/p39 (they WRITE the files the scan called inputs, they never read them) and edited
  the wrong p81 script (a bare `pNN` prefix matched `p81-round-figure` before `p81-triceratops-lite`, which already
  stamped). Both bugs were invisible until I checked whether each named input was actually `readFileSync`'d. The general
  form: a static scan of "which files does X touch" cannot tell a read from a write or resolve an ambiguous id -- confirm
  the specific read site before spending the (scarce) action it was planning.
- A green test is not a working test -- mutate it before believing it guards anything (round-26, R26-31). The first
  `generator-stamp-wiring.test.ts` passed 3/3 but was vacuous: it grepped the whole file for the input path, and the real
  read line makes that substring present regardless of what the stamp actually names. Pointing a stamp at the WRONG file
  still passed. Only rewriting it to parse the `buildStamp([...])` argument list and re-running the mutation (2 failures)
  made it bite. When you add a guard, apply the exact defect it is meant to catch and watch it fail; a guard that survives
  its own mutation is decoration.
- A commit is "just docs" only for paths nothing reads -- re-run the suite at the HEAD of any commit that touches a
  test-inspected directory (round-26, R26-34). `devlog/*.md` and `reports/*.json` are read by tests (`devlog-archive.test.ts`,
  the freshness gate), yet the R26-32 milestone archive was committed on a `docs`-looking commit after `npm test` had only
  been run at the PRIOR tree. The archive then failed `devlog-archive.test.ts`'s citation gate in CI. R26-13 says: if the
  commit touches a path a freshness/window/test check inspects, run `npm test` with THAT commit as HEAD before pushing --
  "it's only a ledger file" is exactly how a red commit reaches main while local looks green.
- `verified` is not `reproducible` for a network-data generator -- run it and diff before attesting, and probe the host the
  CODE actually uses (round-26, R26-35). A generator can name a real committed input yet still be undetermined by it: p35
  hashes the committed p33 catalog + source, but its result is set by the SPOC light curves it FETCHES, so a faithful
  re-run moved its numbers while the stamp would still read `verified` -- provenance that pins the wrong bytes. Only
  attest a generator whose output byte-reproduces (p56 did; p35 did not). And when you test "is the data source up,"
  curl the exact host in the source (`mastS3.ts` uses `stpubdata.s3.amazonaws.com`, HTTP 200) -- not a plausible sibling
  (`aws-oss.mast.stsci.edu`), which is how R26-32 wrongly declared the six generators S3-blocked when they were reachable
  all along. The honest signal is a byte-diff after a real run, never the input list alone.
- A `buildStamp` over a generator's own source + a code module is not provenance of its *result* (round-26, R26-40). p52
  stamps `scripts/p52-negative-class.ts` + `src/data/vizierEb.ts`, but its verdict is decided by the live GCVS/ExoFOP lists
  it fetches; a faithful re-run fetched 0 rows where the committed artifact had 944, so the numbers moved while a stamp on
  the code would still read `verified`. Same class as the R26-35 own-source trap, one level subtler: the stamp covers code,
  not the external bytes. Network-determined generators (p35, p52) stay honestly unattested until a design hashes the
  fetched payload bytes themselves into the stamp -- attesting them with a code-only stamp would manufacture false comfort.
- The freshness gate must not let a CODE-ONLY stamp read as `verified` (round-26, R26-41). `verified` originally required only
  that a re-hashed input be tracked+present+matching -- so a network-photometry report stamping its own `.ts` (p41/p88/p92) passed
  forever, because re-hashing code cannot reveal a stale DATA input. `compareInputs` now also counts `reproducibleData` (tracked,
  matching inputs that are NOT source), and `verified` gates on that. Re-hashing your own source is the weakest possible
  provenance -- if a report has no committed data input it is honestly `unattested`, not `verified`. Keep the independent
  `scripts/audit/freshness-recheck.mjs` mirroring this rule WITHOUT importing the gate, so a future regression in either is caught
  by disagreement. NOTE: a Windows checkout materialises some tracked files CRLF; `sha256File` normalises EOL so stamps are
  platform-stable, and `.gitattributes eol=lf` normalises on commit -- but a `Set-Content` rewrite of a source file can reintroduce
  CRLF into the working tree, so byte-check (`buf.includes(13)`) before assuming a file is clean.

## 13. Current state (as of 2026-10-28)

SNAPSHOT, NOT HISTORY. The leading bullets below are a measurement of the rig, taken at the timestamps named in them,
and `tests/handoff-freshness.test.ts` holds this section to its date: the as-of date may not trail the newest dated
CHANGELOG entry, every commit sha named here must be reachable from HEAD, and the production bullet must name the
revision it was built from -- because the next reader treats this block as live fact, as it should. The research
bullets that follow are dated observations from earlier passes, quoted as history with `reports/*.md` as their
authority; they are deliberately not restated here.

- Git: round 26 has progressed well past increment 1 (the bullet below is a dated 2026-10-27 snapshot, kept as history).
  As of 2026-10-28 the served report library reads `total 56 / stamped 34 / verified 32 / fullyVerified 32 / unattested 22 /
  stale []` -- see the Production bullet for the deployed revision. R26-55, R26-56, R26-57, R26-58, R26-59 and R26-60 lifted six more rows
  (`p71` the audit positive control, its subject `p65` the external-candidate audit, `p45` the false-positive-probability
  characterisation, `p46` the multi-year coherence study, `p51` the crowding-stratified veto re-validation, and `p81` the TRICERATOPS-grade
  external-candidate upgrade) the disciplined way:
  the two-clause screen (R26-53 exact-persistence + R26-54 not-a-DATA-input-to-verified) flagged each eligible, zero drift was measured
  before editing, and their frozen rows replay the published figures offline. The attestation frontier of the seven R26-31-wired
  generators is closed: five reproduce on fixed committed inputs and are machine-verified (`p56`, `p69`, `p62`, `p67`, `p73`);
  two are network-determined and honestly stay unattested because a faithful re-run does not byte-reproduce (`p35`, `p52`,
  R26-40). R26-41 then hardened the freshness gate itself: a report now reads `verified` only when at least one re-hashed
  tracked input is a DATA file, not source code, which demoted three code-only rows (`p41`, `p88`, `p92`) and corrected the
  published machine-checked count DOWN from 27 to 24 -- the honest figure at the time. R26-47/48 then corrected the record
  that "sources are unreachable" (they are reachable) and found the frozen-fixture provenance pattern already ships (p75/p90)
  and byte-reproduces offline; R26-49 APPLIED it to p41 -- froze its 29 per-host measurements into `reports/fixtures/p41-frozen-rows.json`
  (derived from the committed rows, not a re-fetch, so zero numbers moved) and gave it an offline-replay default that re-DERIVES the
  completeness from those frozen measurements -- so p41 is honestly machine-verified again and the count rose 24 -> 25 (independently
  rechecked, and read back live). R26-50 applied the same recipe to p88 (froze its per-candidate 2x2 rows, replay re-DERIVES metrics/verdict
  via the repo's own vetoMetrics/acceptVetoTool, zero drift proven first), lifting it too -- the count rose 25 -> 26. The independent recheck
  mirrors the rule without importing the gate and reproduces 26/26. Still open: TWO rows are served `stamped && !verified`, reached by two
  distinct mechanisms, and R26-51 measured that NEITHER is liftable by a zero-drift freeze. `p92-scrambled-fa` is code-only
  (`reproducible=4, reproducibleData=0`) and persists only the aggregate sweep+summary, not the per-TCE measurements a non-circular freeze
  needs. `p89-multiepoch-di` is the other shape -- a `generatedAt` with NO recorded inputs at all (its generator grew the `buildStamp` wiring
  after the 2026-10-17 artifact and was never re-run; the gate already documents this case in `report-freshness.ts`), and rebuilding its
  `VetoCase[]` from the committed per-target rows reproduces every boolean-derived figure and the AUC exactly but DRIFTS the full-precision
  `population.maxOffsetArcsec` (the artifact keeps only `maxOff.toFixed(2)`: min 3.845e-14 -> 0, p50 46.205418415641816 -> 46.21), so a
  faithful offline freeze is not available either. Lifting either would require a drift-inducing live re-measure -- a different, more invasive
  increment, deliberately not forced; the honest count stays 26 rather than being padded by relabeling a re-measured population.
  Both demoted rows are nonetheless served HONESTLY: `p86`'s `else if (!verdict.verified)` branch attaches an amber `PROVENANCE_NOTE` to each,
  naming its distinct reason, and R26-52 pinned that reader-facing disclosure with `tests/p86-provenance-note.test.ts` (3 cases) -- the first
  end-to-end run of that branch (report-freshness.test.ts drives only the pure verdict; p86-stale-alarm.test.ts runs the real script only for the
  STALE branch), mutation-checked so a future branch reorder cannot silently drop the note while still writing `verified=false`.
  R26-53 turned "which generators can still be lifted?" into a measured RULE, not a guess: a frozen-fixture replay is zero-drift only when the
  committed artifact persists the EXACT values its published aggregate consumes. p41 (integer recovery counts) and p88 (boolean 2x2 rows, and no
  continuous score because `periodMatched=0`) satisfy this and lifted cleanly; the PSF double-difference family does NOT -- p57/p58/p89 compute
  their `blendOffsetArcsec`/`planetOffsetArcsec` quantiles and `psf.auc` from the RAW per-target offset but persist only `offset.toFixed(2/3)`, so
  a replay reconstructs the rounded value and the float aggregate drifts (measured: p58 `psf.auc` 0.6937500000000001 -> 0.690625,
  `blendOffsetArcsec.p50` 23.478713763747773 -> 23.479; p57 the same shape). Those three share one blocker class and can only be lifted by a
  drift-inducing live re-measure -- deliberately not forced to pad the count. So the honest `verified` stays 26; the remaining candidates worth a
  careful per-generator build are those persisting exact integer/boolean per-target measurements, NOT the float-offset 2x2s; 3 rows still lack a
  `reproduce` command (p85 over a gitignored checkpoint, plus the two CI-harness crosscheck reports). R26-54 added a SECOND, orthogonal clause by
  ATTEMPTING the lift on p60 and reverting it: p60 satisfies clause (a) -- its rows are full-precision and every figure (re-find counts, liftPp,
  Wilson CIs, mean SNRs, verdict) re-derives byte-identical offline -- yet it is NOT safely liftable, because its committed report is a tracked DATA
  input to four verified downstream reports (p62/p67/p69/p73), and rewriting p60's bytes (provenance only, numbers unchanged) cascades all four
  HARD-STALE (verified 26 -> 23, p86 refused); refreshing them means re-running live-network generators, the drift-inducing path the rule forbids
  (p62 reproduced today; p67 did not terminate and was stopped). So the honest lift rule has TWO clauses -- (a) the artifact persists the exact
  values its aggregate consumes, AND (b) it is not itself a stamp-input to other verified reports refreshable only by live re-measure -- and
  `verified` stays 26. The tree was reverted byte-clean; nothing from the p60 attempt shipped. R26-55 then USED both clauses as a PRE-FILTER and
  lifted `p71` -- the first generator that passes BOTH (its 14 rows persist the critic BLIND/CORROBORATED verdict as exact enum strings that every
  published figure counts over, and it has ZERO downstream consumers): zero drift was measured before editing, the frozen rows replay the summary
  offline, and `verified` honestly rose 26 -> 27, now live in production (`GET /reports/index.json` reads `verified 27 / fullyVerified 27 /
  stale []`, independent recheck reproduces 27/27). R26-56 applied the identical screen and lifted `p65` next (the same
  enum/boolean row shape -- criticVerdict + passesCurrentGate, ZERO consumers): verified rose 27 -> 28, and p65 plus its
  positive control p71 are now machine-verified together. R26-57 then lifted `p45` -- the first case whose published figures are FLOAT quantiles
  (P(FP) min/p50/p90/max), not just counts: it re-derives byte-identically because the rows store `pFalsePositive` at FULL precision and the
  quantile is a deterministic `sort + Math.floor(f*len)` index, and p45 likewise has ZERO consumers. verified rose 28 -> 29. This refines clause
  (a): the discriminator is "the artifact persists the exact value the aggregate consumes", regardless of type -- the p57/p58/p89 blockers (R26-53)
  failed not for being floats but for storing only `toFixed(3)`, whereas p45/p60 store the raw float and reproduce it. R26-58 then lifted `p46`
  (multi-year coherence): its published median is `q(sorted,0.5)` -- an integer-index selection that returns a STORED full-precision value -- plus
  boolean/threshold counts and a verdict, all pure functions of 6 rows, and p46 too has ZERO consumers; verified rose 29 -> 30. R26-59 then lifted
  `p51` (crowding-stratified veto re-validation) -- the most COMPOSITE aggregate of the family: a per-bin stratified[] table of medians and counts
  plus totals and crowdingOfSample, every median a `q(sorted,f)` integer-index selection over the 24 rows' FULL-precision stored values and every count
  a pure threshold filter, all re-deriving byte-identically; the one field that is NOT a function of the rows -- the live VizieR negative-class probe
  (`negativeClass.vizierEb`) -- is frozen VERBATIM in the fixture rather than recomputed, and p51 has no top-level verdict (console-only) so its field
  set is preserved exactly. verified rose 30 -> 31. R26-60 then lifted `p81` (TRICERATOPS-grade external-candidate upgrade) -- whose committed
  artifact predated the `buildStamp` wiring (the old p89 shape, served `stamped=false`): its 20 rows store each per-candidate grade and EVERY
  published figure (`totals` + the `verdict` string) is a pure `.filter(...).length` count over stored booleans/enums (validated/disp/tricGrade/
  censusDetermined/inconsistent/aliasLevel), the rounded floats being display-only -- the same shape as p71/p65; its only consumer p38 reads just
  `totals` (byte-preserved), so no cascade. verified rose 31 -> 32. The six clean lifts (p71/p65/p45/p46/p51/p81) confirm the screen is reliable, not lucky.
- Git: round 26 (2026-10-27, increment 1) rotates from the gate to the half of the corpus the gate cannot see. Round-25
  closed with `unattested: 39` and the explanation "their generators mostly need network"; the census in
  `scripts/audit/unattested-census26.mjs` (5 offline / 34 network / 39 accounted for, exits non-zero on an unclassified
  row) shows the offline 5 were blocked by something else entirely -- their generators wrote no stamp at all, and p79
  declared `inputs` as bare path strings, the shape the gate documents as unhashable. All five (`p34`, `p54`, `p63`,
  `p68`, `p79`) now call `buildStamp` over what they actually read plus their own source. Re-running them: four are
  byte-identical apart from the stamp, and p34 moves almost every published figure because its input catalog had grown
  33 -> 204 curves -- p 2.936 -> 2.873, R^2 0.837 -> 0.788, doubling cost factor 7.655 -> 7.326 -- with no alarm
  anywhere, since an unstamped row is never compared to anything. Library after the rebuild: 56 rows / 22 stamped / 21
  verified / 21 fully verified / 0 stale, unattested 39 -> 34, re-derived independently by the round-25 recheck with
  `findings=0`. **The finding worth handing over:** following p34's numbers outward found `web/research.json` -- the
  asset the digest links publicly as "Numbers + data", whose `compute` block `web/app.js` renders as a metric card --
  last built 2026-10-20 and never re-checked, so it still published the old exponent AND an `addressable` veto block
  (`caught 2 of 13, AUC 0.742`) that the re-measured, stamped `reports/p59-offtarget-subset.json` no longer supports
  (its own counts are 0/0). Live read-back confirms the stale bundle is what visitors get. Rebuilt AND gated in the same
  round (R26-8/9), plus p91's stamp, which sits under a third key (`stamp`) that no
  reader looks at (R25-7's "both shapes" was itself an undercount) and two rows published with no JSON artifact at all
  (R26-6). What has since closed inside the round: the bundle currency gate (`tests/research-bundle-currency.test.ts`)
  -- and its own positive control, which had decayed to a no-op when the fleet merged a second refresh and was re-anchored
  to content rather than a history position (R26-17); the hermeticity fix to the feed pre-flight drill (R26-11, plus R26-13
  -- CI was red on the first increment and the cause is now reproducible on demand); the reproduce-command ratchet
  (R26-15), whose prune direction then fired on reality when the fleet's live re-run gave p91 a command and it was dropped
  from the exemption list (R26-18); and the handoff gate's own marker-scope bug (R26-16). p91's third-key stamp, whose
  writer fix let the networked fleet do a LIVE re-run, is now fully closed -- the fleet re-published as `5e4d683` (p91
  `mode: live`, `verified=true`, `reproducible=3`, and its markdown now carries the reproduce command), and this was
  deployed and read back from the live endpoint as version `6a9958fa`, gitSha `c93a43c` (see the Production bullet), where
  the served library reads `stamped 23 / verified 22 / fullyVerified 22 / unattested 33 / stale []`. Still open, in priority
  order: 32 generators that write no stamp at all -- the same five-line edit each, then a run on the fleet this round
  extended; the THREE report rows still without a `reproduce` command (named and reasoned in
  `tests/report-reproduce-command.test.ts`: p85 over a gitignored checkpoint, and the two CI-harness crosscheck reports --
  p91 has since been pruned from that list); p89/p33/p39 when MAST answers; and the `absent=2` observation in the recheck,
  which stays a disclosed hole rather than a red CI.
- Git: rounds 22-25 (all 2026-10-26) are CI-only work on the FEED and the REPORTING gate, not the rig: 22 added the empty-window
  pre-flight + the `node_modules` cache + the cursor hint; 23 ranked the committed reports and published the
  vetting-is-the-wall result; 24 audited 22's own gate and found it had skipped NOTHING in ten live runs (the hint
  recorded what a run read, never what it posted) and that the single window it did prove empty had FAILED the job
  (GitHub runs `run:` blocks under `bash -e`, so the designed exit 42 aborted the step before `skip=1` was written).
  Ten defects closed -- F1 inclusive-boundary agreement with the composer, F3 the hint lag, F4 a future-dated cursor
  is untrusted, F5 an override run no longer shadows a good hint with an empty cache entry, F11 git argv arrays
  instead of a shell string (the quoted `:!` pathspecs were inert under cmd.exe), F13 the `bash -e` abort, F16 the
  sender's silent truncation of an over-ceiling post (now a refusal), F17 -- a regression F3 itself introduced,
  where advancing `last_post` with the window cursors capped the pre-flight's silence watchdog at the cadence so a
  heartbeat could never come due -- and F18, where the feed's own log auditor could not see a skip and the obvious
  detector for it matched GitHub's echo of the step's source rather than its output, and F19's runaway-ceiling
  warning, which promised deferred items stay reportable when the cursor in fact leaves them behind -- with
  `tests/x-post-preflight.test.ts` (17 cases) plus 3 new `tests/post-x-text-guard.test.ts` cases and 6 new
  `tests/xpost-health.test.ts` cases loading that path for
  the first time; the fetch-to-post cursor gap was
  MEASURED (13 posting runs, 0 items lost) and deliberately left alone. 25 left the feed for the report-freshness gate:
  recomputed the stamped verdicts independently of the module under audit (all agreements held, 0 stale -- so round-23's
  public citation of p82/p84/p85/p93 as verified stands), then found that p86's publish-time half had never been
  executed by anything: `--allow-stale`, which the only CI caller passes by design, was known to keep marking reports
  red only because the committed artifact happened to show it. `tests/p86-stale-alarm.test.ts` now runs the real
  script against a throwaway repo and tampers a tracked input, so the alarm is heard rather than assumed. The first
  draft of that paragraph said "all 15 stamped verdicts, 15/15": the recheck itself could only read the nested `meta`
  stamp shape and had silently skipped the two flat-shaped rows it was sent to investigate (R25-7, corrected in the same
  round -- the tool now resolves both shapes, accounts for all 56 index rows in named buckets, compares its own buckets
  to the published counts, and exits 1 on any disagreement, gated by `tests/freshness-recheck-gate.test.ts`). R25-5
  moved three measurement scripts that the ledgers promised but `out/` had swallowed onto tracked paths under
  `scripts/audit/` and added `tests/ledger-artifacts-tracked.test.ts` to keep them there; R25-6 found the site's
  `provenance unverified` badge was written fail-OPEN (`=== false`, so an absent key rendered clean) and made the mark
  something a row must earn, tested by executing the predicates lifted from `web/app.js` over the real published index;
  R25-8 re-ran p88 end to end with its own recorded arguments -- identical published numbers, new stamp -- taking the
  library to 16 verified / 16 fully verified of 56. Commits: `12fedbf` (R25-1..R25-5), `8aad1dd` (R25-6..R25-8, then
  DEPLOYED as version f1a50e51 and live-verified, R25-10), and a follow-up for R25-9 (measured, declined) and R25-11
  (the handoff tree check). The round's feed post went out once through `x-post.yml` `workflow_dispatch`
  (HTTP 204 at 2026-10-26T13:59:34.822Z, run 40335501130, posted id 2114718667191816270, 5584 chars of pure ASCII),
  archived byte-exact in `devlog/2026-10-26-round25-audit-of-the-checker.md` with an evidence header recording the two
  guard refusals (both fixed in the text, never in the guard), the 404 found by checking a link instead of assuming it,
  and the rejected first figure whose "1 stamped" band was drawn a third of the bar wide.
  Round-21 (2026-10-26) ships
  the three round-20 deploy-gated defects -- the anchor SPEND GATE (refuse 409 on a NEW
  commitment when the current verdict is not accepted or the label-conflict flag is live, on BOTH runtimes, after the two
  no-spend idempotence guards), the read-only `GET /api/anchor-health` aggregate (pure `src/core/anchor-health.ts`), the
  served `dataTier` + `labelConflictStatus` projection fields, and the stand-in-aware critic wording -- stacked on the
  round-20 tip 32c59d2 (which, like rounds 18/19/20 before it, was scripts/tests/docs only and redeployed nothing). The revision PRODUCTION still runs is 336840b -- the seventeenth-round READ-SIDE hardening of the disclosure kernel
  (decode TOI candidate numbers `.01` -> b so designator parsing covers 103 of 103 rows and the label-conflict predicate can FIRE
  on the 34 of 103 rows (33.0%, up from 27.2%) whose label AND NASA cross-match name both decode to a designator -- the other 65
  rows carry no comparison name to contradict, so round-17's public "sees the whole catalog" was an over-claim corrected in round
  18 (see the eighteenth-round bullet below) -- keep
  binary star-component letters in `hostKeyOf`, publish a `designatorKind` to disambiguate a null designator, render the conflict
  on the board card, and prove served == kernel with an offline wiring test), stacked on the sixteenth-round RECORD/ACCOUNTING
  disclosure layer `c70593e` (signal-identity kernel, label-conflict fields, honest host counting), the fifteenth-round query
  hardening `bf12a62`, the fourteenth-round interface hardening `8dd1748`, the thirteenth-round console hardening `bb16fd7`, and
  the console slice that first shipped coherent at `d6825a8`. Round 17 is read-side only, exactly like round 16: no stored row,
  manifest byte, `bundleHash` or `scienceHash` moved, and the two things that could change the evaluation (a mint-time suppression
  guard, a seat-identity-free content address) stay calibration-gated -- see the seventeenth-round bullet below. Round 16 confirmed
  all four Round-15 fixes LIVE by the auditor's own hand, then moved
  BELOW the interface into the bookkeeping: one physical candidate is minted as one record PER TOI-table seat label, a row's
  label can contradict its OWN `crossmatch.knownPlanetName`, and the contradiction was already paid for and frozen into
  immutable chain commitments. We re-measured every figure off production before touching code (103 rows = 91 signals = 90 host
  stars, 12 duplicate rows; accepted 18 -> 15/15; 5 label conflicts of which 3 accepted; ledger 20 -> 17; the HR 858 trio's
  three distinct `scienceHash`es). What SHIPPED is disclosure + counting only (response projections + read-path); the mint-time
  suppression guard and any `scienceHash` re-derivation are calibration-gated research decisions, NOT silent edits -- see the
  sixteenth-round bullet below. This line is about the revision measured below, not a standing claim about the tip --
  `git log` is the authority there.
- Production: wrangler version 75a43010-459e-4018-893f-cf04f3cf2e44, gitSha bdff1680d64c37295d4dceabffa46e00130ea7ff
  (deployed 2026-10-28 by R26-60 through `npm run cf:deploy:sha`, which uploads the Worker bundle from `src/` and the
  static assets from `web/`; `GET /health` read back returned `deployVersion 75a43010-459e-4018-893f-cf04f3cf2e44` and
  `gitSha bdff168`), `codeVersion space-data-rig@0.2.0`. HEAD (this section's ledger commit, made after the deploy)
  differs from the deployed revision bdff168 only in `HANDOFF.md` -- no `src/` and no `web/` path -- so the served
  `src/` and `web/` trees equal HEAD's by construction, the condition `tests/handoff-freshness.test.ts` enforces.
  **WHAT THIS SHIPS:** the R26-41 hardened freshness gate PLUS the
  R26-49/R26-50/R26-55/R26-56/R26-57/R26-58/R26-59/R26-60 frozen-fixture lifts of p41, p88, p71, p65, p45, p46, p51 and p81 -- each report now re-DERIVES
  its published figures from committed frozen measurement rows (`reports/fixtures/p41-frozen-rows.json`, `reports/fixtures/p88-frozen-cases.json`,
  `reports/fixtures/p71-frozen-rows.json`, `reports/fixtures/p65-frozen-outcomes.json`, `reports/fixtures/p45-frozen-rows.json`,
  `reports/fixtures/p46-frozen-rows.json`, `reports/fixtures/p51-frozen-rows.json`, `reports/fixtures/p81-frozen-rows.json`), so each stamp carries a real DATA input and all eight are honestly machine-verified again.
  Live read-back of `GET /reports/index.json`: 56 rows, `freshness {stamped 34, verified 32, fullyVerified 32, unattested 22,
  stale []}`; `p41-longbaseline`, `p88-independent-corroboration`, `p71-audit-positive-control`, `p65-external-audit`, `p45-fp-probability`, `p46-coherence`, `p51-crowding-stratified` and `p81-triceratops-lite` each serve
  `verified=true / reproducibleData=1` with
  their rendered HTML fragments WITHOUT the amber provenance banner, while the still-code-only row (`p92-scrambled-fa`)
  keeps `verified=false / reproducibleData=0` and still serves the banner (the R26-41 correction intact; p92 stays demoted
  honestly because its report persists only the aggregate, so a zero-drift freeze is not available for it). The independent
  freshness-recheck reproduces `verified=32/32`. `discoveryClaim`/`safeToGate` remain false in every report. This is the
  honest count RISING 24 -> 25 -> 26 -> 27 -> 28 -> 29 -> 30 -> 31 -> 32, earned by pinning the measurement behind the numbers (zero drift, no coupling
  cascade, independently rechecked), not by loosening the gate; the earlier downward correction 27 -> 24 (R26-41) still
  stands for what was genuinely checkable at that point.
  Earlier production: version dbaff271-53ff-45a1-ad5c-a1185162ba9a, gitSha adef4666e82088e95ec2e5f14e20b8ddebd504ac
  (deployed 2026-10-28 by R26-59 -- the seventh frozen-fixture lift, p51, serving `freshness {stamped 33, verified 31,
  fullyVerified 31, unattested 23, stale []}`); and before that version 8095cf08-7c09-4ae8-b0f1-17404b5edf40, gitSha 8c7f2ca10d2eaee3974447da7c9e7d12dc970ac8
  (deployed 2026-10-28 by R26-58 -- the sixth frozen-fixture lift, p46, serving `freshness {stamped 32, verified 30,
  fullyVerified 30, unattested 24, stale []}`); and before that version 197ccc8b-3137-47dd-a6b8-add150b3b2ca, gitSha c5a8dd7efb5abf867fe2fc2e2499a54a7f406420
  (deployed 2026-10-28 by R26-57 -- the fifth frozen-fixture lift, p45, serving `freshness {stamped 31, verified 29,
  fullyVerified 29, unattested 25, stale []}`); and before that version feb61d91-b417-46f9-8f99-a4589ac45d60, gitSha 8d4fc3c5f5217700c2621edb56056f59259b6d2d
  (deployed 2026-10-28 by R26-56 -- the fourth frozen-fixture lift, p65, serving `freshness {stamped 30, verified 28,
  fullyVerified 28, unattested 26, stale []}`); and before that version 4e52cfb2-715e-4cda-b70e-90cc3152ca2d, gitSha 0fc90f80790edd2d7149a1468532d60d9e51623f
  (deployed 2026-10-28 by R26-55 -- the third frozen-fixture lift, p71, serving `freshness {stamped 29, verified 27,
  fullyVerified 27, unattested 27, stale []}`); and before that version 0e7e16ca-a5f7-4a37-9b9a-eaf1d8601f87, gitSha 44a8deb2d95cb4351ae3b472da7bd8207927d960
  (deployed 2026-10-28 by R26-50 -- the second frozen-fixture lift, p88, serving `freshness {stamped 28, verified 26,
  fullyVerified 26, unattested 28, stale []}`); and before that version 21b6f04a-7387-45ce-b194-6bf03f740c63, gitSha bfe38ded2ca1502f1837d92cf36d8ddc6210753a
  (deployed 2026-10-28 by R26-49 -- the first frozen-fixture lift, p41, serving `freshness {stamped 28, verified 25,
  fullyVerified 25, unattested 28, stale []}`); and before that version b1b479a6-551d-4fe7-9c8b-f51d02c88a96, gitSha
  20457a3fecd77f29349858b949d6f6d90d4e3ade
  (deployed 2026-10-28 by R26-41 -- the hardened freshness gate + rebuilt library that demoted the three code-only rows
  `p41`/`p88`/`p92` and served `freshness {stamped 28, verified 24, fullyVerified 24, unattested 28, stale []}`);
  and before that version 6a9958fa-1620-488c-87ba-8e111bab585e, gitSha c93a43c490b46b07285a55389318c3facbcf1b0a
  (deployed 2026-10-27 by round-26 increment 3; the initial `cf:deploy:sha` correctly REFUSED on an untracked scratch file in
  `scripts/`, which was removed and the tree redeployed clean rather than overridden with `--allow-dirty`; served library then
  read `{stamped 23, verified 22, fullyVerified 22, unattested 33, stale []}` and `p91-claim-provenance` `verified=true
  reproducible=3`); and before that version 556fede6-b5ef-495d-82d5-8c5fc10dac77, gitSha e97c4fde57d0d146b16620a484b58a80c44ad1c8
  (deployed 2026-10-27T01:09:35.384Z by round-26 -- the `web/research.json` refresh that shipped the p34-corrected
  exponent and retired the stale addressable-veto block; its first attempt failed on an expired Cloudflare auth token and
  the retry after two reachability probes succeeded, R26-10); and before that version f1a50e51-104c-4838-86cb-f9827c426cd2,
  gitSha 8aad1dd2edf3996c0347440b3dcbcd58d295adaa.
  **ROUND-25 R25-10, the reason this is a deploy at all:** rounds 22-25 touched no
  `src/` file, but round-25 changed two SERVED assets (`web/app.js`, `web/reports/index.json` + fragments), and no
  workflow in this repository deploys -- so a committed-and-green asset fix is not public. Before acting the live site
  still served the 2026-10-23 library (`verified: 15`, p88 unverified) from the previous version b0d9ed9f-114e-4c03-9bbe-266bd0bdf4ac /
  gitSha ab0ce34c67345d6d9515e52192aacfdd62aee045 (deploy d3960018-cec5-4f19-8dfd-acc414cff344,
  created 2026-10-26T02:15:58Z, read off `wrangler deployments list`), which was the newest `src/` commit -- so the
  upload carried identical Worker code and identical vars (`AUTO_ANCHOR=live`, `OBSERVE_ANCHOR=live` unchanged in
  `wrangler.toml` since) and only the assets moved. The gitSha/codeVersion pair is re-read from `GET /health` rather
  than trusted from wrangler's exit line. **ROUND-24 CORRECTION (F15), kept as history:** at that time this bullet named version
  `2327eda2-7043-42f3-9485-72fa3bf309ce` / gitSha `336840b` and said the round-21 Worker change "deploys AFTER the
  round-21 commit, recorded once `GET /health` confirms it". Both named values were the 2026-10-23T09:26 deploy -- two
  deploys behind reality -- and the confirmation never got written back. `tests/handoff-freshness.test.ts` still cannot
  check the live endpoint (CI has no network), but round-25 closed the half of the class that can be checked offline: the
  named revision's `src/` and `web/` trees must equal HEAD's, or the bullet has to carry the marker `awaiting deploy`
  (R25-11). Rounds 22/23/24 changed no `src/` file and needed no deploy (a workflow, a script, tests and docs -- all
  CI-only); round-25 changed served assets and DID deploy, so `8aad1dd` is current at this snapshot; the per-row figures quoted below are the ROUND-17 DEPLOY-TIME verification (103 rows / 90 hosts /
  kinds `{58,41,none:4}`) and live has since drifted to 104 records / 91 hosts (re-measured 2026-10-24T08:04Z) as the rig
  keeps minting -- a dated proof, not a live promise. Re-verified live at the round-17 snapshot: `deploy:window`
  cleared GO only after the pass `run-20261023-091528` held the run mutex to 09:25:04Z (a ~9.6 min mutex-finish span
  overrun, the intermittent defect recorded below), leaving 269 s of idle before the 09:30 claim -- over the 120 s budget
  -- and `GET /health` returns exactly that sha and `codeVersion space-data-rig@0.2.0`. Triggers: schedule `*/15 * * * *`,
  workflow `rig-run`, custom domain spacedatarig.app. The seventeenth-round read-side hardening is LIVE and behaviourally
  confirmed against real production rows (all 23 assertions in the post-deploy probe passed): every one of the 103 served
  findings carries the five disclosure fields (`requestedDesignator` + `requestedDesignatorKind` + `detectedDesignator` +
  `detectedDesignatorKind` + `labelConflictsWithKnown`), and the flag is now set on exactly 7 rows -- the round-16 five
  (HD 110067 b, HD 25463 c, HR 858 d, HR 858 c, HD 260655 c) PLUS `TOI-6054.02` and `TOI-4443 c`, which the letter-only
  predicate had dropped and which the candidate-number decode recovered (both `needs-more-data`, neither anchored); the
  served flag equals BOTH our kernel recompute AND an independent neutral comparator with 0 mismatch on all 103 rows;
  `requestedDesignatorKind` spans `{candidate-number: 58, planet-letter: 41, none: 4}`; `GET /api/state/summary` still
  reports `distinctHosts: 90` with `distinctRecords: 103` (the `hostKeyOf` star-component fix is LATENT -- today's catalog
  carries only A components, so 90 is unchanged and a neutral component-preserving recomputation agrees with 0 cross-star
  collisions); and `verify-onchain` on `F-HD-260655-c` returns `labelMatchesKnownPlanet: false` with requested `c` /
  detected `b` while its on-chain memo `bundleHash` and `ledgerScienceHash` (`d00fe82d...`) read byte-equal to the committed
  ledger fixture (`ledgerBundleMatch: true`) -- the hardening added no hash input. The same response reports
  `anchoredScienceDrift: true` for the CURRENT bundle hash: a pre-existing re-derivation state the endpoint has always
  published honestly (README "bundleHash drifts by design"), NOT introduced here -- no file under `src/bundle/`,
  `src/solana/`, `src/candidate/dedup.ts` or the mint path (`src/cf/workflow.ts`, `src/seats/seats.ts`) is in the deployed
  commit. The served `app.js` (118,857 B raw / 117,070 B after newline normalisation) is BYTE-IDENTICAL to the committed
  file and now renders the `labelConflictNote` on a conflicting card (reading the SERVED flag, not re-decoding it in the
  browser); `findings-query-ui.js` was not touched this round. The v0.2 console stays LIVE:
  `GET /api/findings?verdict=accepted&sort=depth&limit=3` serves `total 103 / matched 18 / hasMore true`,
  `web/candidates.json` serves schema `sdr-candidates/2` with every `discoveryClaim` false, and `GET /api/state/summary`
  answers 200 on the edge.
- Switches live, read off the deploy's own binding list: AUTO_RESEARCH=1, AUTO_RESEARCH_TARGETS=8,
  AUTO_RESEARCH_TMAG=10, AUTO_RESEARCH_ROTATION=1, AUTO_RESEARCH_POOL=120, AUTO_ANCHOR=live (cap 100/day),
  OBSERVE_ANCHOR=live (cap unlimited), MAST_S3=1, VET=1, PERSECTOR=1, DISCUSSION_MODE=grounded,
  CODE_VERSION=space-data-rig@0.2.0, SOLANA_RPC_FALLBACKS=api.mainnet-beta.solana.com.
- Public counters, re-read live 2026-10-26T10:05Z by the round-24 audit (`GET /api/state/summary`; the ~84x lighter
  projection the twelfth-round
  D4 asked for, carrying the same `stats`/`statDefinitions`): surveyPass 741 CLAIMED (710 at the 01:44Z round-21 read --
  the survey loop is running), distinctHosts 91 host STARS (audit-16
  re-based from the old label count; the raw-label count is the separate distinctRecords 104), blindHeld 29 over
  blindCandidates 53 assessed, findingsAccepted 18 / findingsRejected 30 / findingsReview 56, bundlesAnchored 0
  published-bytes, ledgerAnchored 23 chain commitments (UNCHANGED since 2026-10-23 evening -- three days with no new anchor),
  tasksDone 92 with tasksQueued 9 and tasksFailed 8 (a per-window bookkeeping that moves between pulls; re-read it live).
  ROUND-20 CORRECTION -- the round-17..19 snapshots said "nothing new anchored since 2026-10-20"; that was true when
  written and is now SUPERSEDED: three new real-fee anchors landed 2026-10-23 evening (F-AU-Mic-b 15:56:01Z, F-TOI-480-b
  16:02:26Z, F-HD-110067-b 18:03:39Z, each with a real mainnet `signature` + `slot`), moving ledgerAnchored 20 -> 23.
  Science-hash dedup still spends no SECOND fee on identical content -- proven live 2026-10-24T01:31:18Z (`Skipped anchor
  for F-HD-260655-c: identical science already anchored as F-HD-260655-b`, then `Auto-anchor ... spent=false`), which is
  the withdrawal of the round-4 "dedup is dead code" claim. F-HD-110067-b is BOTH anchored AND `labelConflictsWithKnown:true`
  today -- the live proof for the round-21 anchor-gate work (Defect 2 in the twentieth-round bullet). The v0.2 P0 query
  makes the 104-row catalog
  filterable server-side (`/api/findings` with a filter returns matched/hasMore; since `8dd1748` an unknown-but-supplied
  filter also returns `ignored:[...]`, and since `bf12a62` a clamped paging value returns `clamped:[...]` and a numeric
  `tic` matches the host number only, not a TESS cadence suffix). The repo report library was rebuilt this round by the
  CI invocation itself (`npm run p86:report-library -- --allow-stale`) and then DEPLOYED, so what the public receives now
  matches the repository:
  reports 56 with `stale: []`, `stamped: 17`, `verified: 16`, `fullyVerified: 16`, and -- the fourteenth-round N6 --
  `unattested: 39` as a first-class published count so the 39 unstamped reports no longer read as verified-current. The
  +1 is p88, re-run end to end with its own recorded arguments: every published number identical, only the timestamp and
  the three input checksums new (round-25 R25-8). p89 is the one row still `stamped` but input-less, and its generator
  needs the MAST API, which this workstation could not reach. Live proof rather than a tool's exit line (R25-10):
  `/health` `gitSha=8aad1dd2edf3...`, `deployVersion=f1a50e51-104c-4838-86cb-f9827c426cd2`, `/reports/index.json`
  carrying the 16/16 counts, served `app.js` containing the earned-badge predicate.

- Tests: 132 files / 1019 tests as this snapshot was re-taken 2026-10-27. Round-26 added
  `tests/generator-stamped-reports.test.ts` (+4), which is the pin behind R26-2: for each of the five generators that
  could run offline it requires the SOURCE to call `buildStamp`, the ARTIFACT to record a non-null checksum for every
  input with every input tracked and still matching the bytes on disk, and the built INDEX to call the row `verified`
  rather than merely `stamped` -- so neither deleting the wiring nor hand-editing a stamp into JSON survives.
  `tests/research-bundle-currency.test.ts` (+3) is the pin behind R26-8/9: it runs the real bundler with its new
  `--out=` into `out/` and requires byte equality with committed `web/research.json` once the bundle's own
  `generatedAt` is stripped from both sides, holds the previous committed revision of that asset as a positive control
  (it must differ, and must name `compute.exponentP`), and refuses an `--out` that escapes the working directory.
  Round-26 also made `tests/x-post-preflight.test.ts` hermetic (+2 cases, 17 -> 19): the step block used to run with
  cwd at this checkout, so the pre-flight's `git log` read the suite's own repository instead of the fixture, and the
  commit that refreshed `web/research.json` flipped the F13 empty-window verdict for a reason unrelated to the gate
  (R26-11). `GIT_DIR`/`GIT_WORK_TREE` now point at the fixture, and the research milestone -- previously never driven
  through the step -- has one in-window and one out-of-window case.
  `tests/report-reproduce-command.test.ts` (+3) is R26-15: `web/reports/index.json` publishes a `reproduce` command per
  row (scraped by `scripts/report-md.ts` from the report's markdown), and 6 of 56 rows had none while five of them read
  `verified` -- freshness and repeatability are different promises. It ratchets both ways (no unexcused row may lack a
  command; no excused row may keep its excuse after being fixed), the commands are emitted by the GENERATORS (p68, p90,
  p91), and `scripts/audit/mutate26-reproduce-test.mjs` proves each direction fires and restores the index byte-exact.
  `scripts/audit/ci-watch26.mjs` and `scripts/audit/diagnose26-preflight.mjs` are this round's CI tools: the first reads
  check runs and workflow runs as API objects because github.com HTML does not load here, the second reproduces the
  exact failure CI hit on `e97c4fd` by removing the pre-flight drill's `GIT_DIR`/`GIT_WORK_TREE` lines and putting them
  back.
  `scripts/audit/mutate26-stamp-test.mjs` proves the first file fires: dropping p79's `buildStamp` call turns 2 of 4 red (the source
  check and the self-referential checksum), corrupting one recorded checksum turns 1 red and names the stale input, and
  the drill restores both files and re-runs to 4/4; the drill's own limit is recorded in R26-12 (the index-level case did
  not fail on the corrupted artifact, because the index predates the corruption). Round-25 added
  `tests/p86-stale-alarm.test.ts`
  (+4), the first file in the suite to EXECUTE `scripts/p86-report-library.ts`: it builds a throwaway git repo holding one
  stamped report over one tracked input, runs the real script, and asserts the alarm -- exit 1 plus `refusing to publish
  1 stale report` on a tampered input, and that `--allow-stale` keeps the red banner and the `freshness.stale` entry while
  returning 0. Everything known about the gate before that was static (the committed index.json is internally consistent)
  or pure-function (compareInputs), which cannot show the publish path works. Round-25 also added
  `tests/ledger-artifacts-tracked.test.ts` (+3), which stops these very ledgers from promising a kept tool that lives on
  an ignored path -- the failure it catches is in the Residual/Findings table as R25-5, and it failed on its own first
  run. Round-25 also added `tests/web-report-badges.test.ts` (+3), which executes the three honesty badges the site
  actually draws (`web/app.js`, predicates lifted out of the served file rather than restated) after R25-6 found one of
  them fail-OPEN on a missing `verified` key, and `tests/freshness-recheck-gate.test.ts` (+4), which gates the
  independent recheck itself -- both over this checkout's real `index.json` and over throwaway repos holding
  deliberately mis-stamped ones -- after R25-7 found that tool could not read the flat stamp shape and so had skipped
  exactly the rows it was written to audit. Round-25 also grew `tests/handoff-freshness.test.ts` by one check (+1), the
  offline half of R25-11: the revision this bullet names as production must have HEAD's `src/` and `web/` trees, or say
  `awaiting deploy` -- because a green CI on a commit that nothing deploys is not a public fact. Round-24 added ONE new file,
  `tests/x-post-preflight.test.ts` (+17), which drives the real pre-flight CLI against a fixture rig on 127.0.0.1 and a
  throwaway git repo AND extracts the workflow's own step shell to run it under `bash -eo pipefail` -- the F13 case is
  the first time anything in `npm test` has loaded the gate that can suppress a post; the count also carries the
  +2 F13 step cases and the +3 F17 hint-block cases (one of which pipes the shipped shell's cursor file back into the
  shipped CLI, because the defect lived in that seam), plus +3 in `tests/post-x-text-guard.test.ts` for the F16
  length ceiling. Note the file count is 125 where the round-21 snapshot said 123, i.e. that figure was already
  one behind `scripts/run-tests.ts`'s own discovery -- measured, not inherited. Round-21 added
  `tests/anchor-health.test.ts` (+9): the pure aggregate pinned on hand-built rows, then MEASURED with the production
  helpers over the captured live fixtures before being pinned (20 anchored / 0 match / 2 nmd / 1 rejected / 3 conflict /
  3 stand-in / 4 unverifiable-letter / 0 missing), the three-state `labelConflict.status`, the tier round-trip through
  both narrate tags, the stand-in wording (by-construction clause in, evidence clause out, score/checks untouched,
  real-photometry reason byte-identical), and structural wiring for the spend gate + both served fields + both
  `/api/anchor-health` routes on both runtimes; rounds 18/19/20 before it added guard + accounting
  assertions to EXISTING files, no new file -- round-20 +3 to `tests/post-x-text-guard.test.ts` for the coverage-net
  escapes/contrastive, rounds 18/19 the money-narrowing + coverage catches; the seventeenth round added no new FILE but +3 assertions to the
  two files round-16 introduced: `tests/signal-identity.test.ts` gained a `candidateNumberToLetter` block, a
  `designatorKindOf` block, the binary-star `hostKeyOf` cases, and a STRUCTURAL wiring test proving BOTH `findingView`s serve
  the disclosure from ONE kernel call and the board reads the served flag without re-decoding it; and it FLIPPED the two
  expectations round-16 had frozen on the blind spot -- `labelDesignatorOf("TOI-2016.01")` now asserts `=== "b"` (was
  `=== null`) and `tests/live-catalog-accounting.test.ts` now asserts `conflicts.length === 7` (was 5), so the gate encodes
  the decoded truth instead of defending the miss. Round-16 had added `tests/signal-identity.test.ts` -- the
  pure kernel pinned on hand-built edges -- and `tests/live-catalog-accounting.test.ts`, which drives the PRODUCTION
  functions over the captured served bytes and pins 103 rows / 91 signals / 90 hosts / 12 duplicate rows, accepted 18 ->
  15/15, the label conflicts (now 7, of which 3 accepted) by name, ledger 20 -> 17, the trio's three distinct science hashes,
  and `computeStats` reading 90/103; the round-15 echo "parity" source-regex test was renamed a STRUCTURAL wiring check; the
  fifteenth round had earlier grown `tests/finding-query.test.ts`
  with the T1 cadence + zero-pad behaviour in BOTH directions, the T2 `dir`-active sort, the T3 `clamped` echo, the T4 DESC
  default and an edge+Node echo-parity assertion; `npm test` 965 pass / 0 fail on this full-history Windows checkout).
  CAVEAT the fifteenth audit rightly flagged: on a `.git`-less, FITS-un-prefetched tarball the SAME suite reads ~945 pass /
  8 skip / 3 env-fail (the round-20 auditor measured 942 / 3 / 8 on the round-19 `2ebcd59` tarball at 953 total; round-20's
  +3 are pure/offline so they pass there too, giving 945) -- the skips are the `existsSync("out/probe-*.fits")` MAST gates, the 3 fails are `git merge-base`
  ancestry checks needing full history -- so a bare "N/N" misleads; CI checks out with full history + runs the FITS prefetch
  and is green on `336840b`, as it runs `npm run test:coverage` whose 90/78 floors it clears (this snapshot: all-files
  96.09 / 83.43 / 91.49, `signal-identity.ts` 100 / 94.87 / 100); trust the run over any number
  written in a document, including this one).

- Sixteenth-round audit (2026-10-23) moved from the interface to the RECORD/ACCOUNTING layer, and its numbers were
  re-measured by us off production before any code moved: the 103 published rows are 91 recovered signals over 90 host
  stars (12 pure duplicate rows; accepted 18 -> 15/15), 5 rows carry a label that contradicts their OWN
  `crossmatch.knownPlanetName` (3 accepted: HR 858 d/c vs b, HD 260655 c vs b), and the 20 chain commitments cover only
  17 candidates -- one physical candidate was paid for up to three times, and the HR 858 trio's three `scienceHash`es
  differ, so no hash-level dedup can fire structurally today. WHAT SHIPPED is disclosure and counting only, all of it
  response-projection or read-path: `src/core/signal-identity.ts` as the single shared predicate source
  (`hostKeyOf`/`signalKeyOf`/`labelConflict`/`groupBySignal`), `requestedDesignator`/`labelConflictsWithKnown` on every
  served finding, `labelMatchesKnownPlanet` on `verify-onchain`, `distinctHosts` re-based to host STARS (90) with
  `distinctRecords` (103) beside it, the `.01` terminology corrected (ExoFOP candidate planet number, not "cadence"),
  `identifierRuns` routed through `hostKeyOf` (the narrow TOI-only regex is gone), and the accounting pinned on captured
  served bytes (`tests/fixtures/live-catalog.json`/`live-ledger.json` + `tests/live-catalog-accounting.test.ts`,
  re-capture via `npm run fixtures:capture-catalog`). No stored row, manifest byte, `bundleHash` or `scienceHash` moved;
  no money path was touched. CALIBRATION-GATED NEXT STEPS (red line 3 -- measure before gate; these change which
  records EXIST and therefore what gets anchored, so they are research decisions, not edits waiting to be typed):
  (1) a MINT-TIME suppression guard -- before `recordFinding`/auto-anchor, check `signalKeyOf` against existing rows
  and refuse (or flag) a second record of one signal; it must first be calibrated by measuring the false-merge rate on
  real data (what share of same-(host, period@1e-9, ppm, snr@1e-6) pairs are genuinely different planets -- the
  `collapseCoincident` cross-host-shared-ephemeris rule is the cautionary precedent that a "coincident" signature can
  be systematic, not planetary). (2) a `scienceProjection` re-derivation that removes the seat-identity leakage
  (per-seat `ephemeris`/`recoveryConfidence`/`aliasMultiple` ride in today's hash, which is why one candidate hashes
  three ways) -- but that CHANGES anchored semantics for existing commitments, so it needs its own measured design
  note and a re-anchor policy agreed BEFORE hashing; verify-onchain already reports both hash lineages honestly beside
  the new `labelMatchesKnownPlanet`. The audit's own ranking says the evaluation only changes with FEWER duplicate
  rows minted, which is exactly why these two sit behind a calibration gate rather than behind a flag day.

- Seventeenth-round audit (2026-10-23) accepted the sixteenth round's bookkeeping as fixed (host count 90 with both counts
  published, `.01` terminology corrected, our own numbers committed back as the regression baseline rather than argued) and
  then found that the newly written decision kernel could only SEE 27.2% of the catalog: `labelDesignatorOf` /
  `knownDesignatorOf` returned `null` on a `.NN` candidate number, so `labelConflict` needed BOTH sides to be a trailing planet
  letter -- reachable on 28/103 rows, `requestedDesignator` null on 62, and 5 conflicts flagged where a decode-aware comparator
  (`.01` -> b, `.02` -> c, star component kept) flags 7. The two dropped rows (`TOI-6054.02`'s label vs its own `.01`
  crossmatch; `TOI-4443 c`'s label vs its own `.01` crossmatch) are both `needs-more-data` and NEITHER is anchored, so this was
  a disclosure-coverage and GATE-DIRECTION defect, not dirty data hidden on the chain -- and the gate had FROZEN the blind spot
  as the passing answer (`signal-identity.test.ts` asserted `labelDesignatorOf("TOI-2016.01") === null`,
  `live-catalog-accounting.test.ts` asserted `conflicts.length === 5`), so the commit that corrected the predicate would have
  reddened CI. This is the lesson recorded here: a fix that also hardens the WRONG expectation into a gate is worse than no fix,
  because it turns the next correction into a regression. WHAT SHIPPED is read-side only, none of it touching a hash input: a
  pure `candidateNumberToLetter()` (`.01` -> b ... `.25` -> z, `>= 26` -> null) wired into both designator readers with BOTH
  frozen expectations FLIPPED to the decoded truth (`=== "b"`, `=== 7`); a `designatorKindOf()` publishing
  `requestedDesignatorKind` / `detectedDesignatorKind` (`planet-letter` / `candidate-number` / `none`) so a null designator is
  no longer ambiguous (Legacy 4); `hostKeyOf` fixed to strip a trailing single letter ONLY when a planet designator still
  follows it, so a binary star's component letter survives (`HD 202772 A b` -> `hd 202772 a`) -- LATENT, since today's catalog
  carries only A components and live `distinctHosts` stays exactly 90 (a neutral component-preserving recomputation agrees, 0
  cross-star collisions); the conflict rendered on the board card (`web/app.js` `labelConflictNote`, reading the SERVED flag,
  never re-decoding in the browser) so a human sees what the API returns (Legacy 1); an offline STRUCTURAL wiring test proving
  served == kernel BY CONSTRUCTION, chosen over a risky fixture re-capture that would drift the 103/91/90 hard counts against a
  production re-minting every 15 min (Legacy 2); and a CI `node --check web/*.js` syntax gate, since `web/` sat outside `lint`
  and both tsconfigs (Legacy 3b). TWO things were deliberately NOT changed and are stated plainly: `freshness-regen.yml`'s
  unconditional `--allow-stale` is INTENTIONAL (one offline upstream must not block publishing the other three reports --
  Legacy 3a), and a daily-capture HARD-FAIL on any fixture/production `(targetId, verdict, ppm)` divergence was DEFERRED because
  production legally re-mints every 15 min, so a hard count-diff gate would cry wolf on growth and scheduled workflows here are
  fragile (the X-post lesson -- Legacy 5). No stored row, manifest byte, `bundleHash` or `scienceHash` moved; no money path was
  touched; `ledgerAnchored` stays exactly 20 [ROUND-20: aged -- live re-measured 23 @ 2026-10-24T07:02Z] and blind-toi accepted stays 0. The SAME two calibration-gated research decisions
  from round-16 remain the only things that can move the evaluation, and neither was touched this round: (1) the mint-time
  duplicate-suppression guard (behind a measured false-merge rate) and (2) the seat-identity-free `scienceProjection`
  re-derivation (behind a re-anchor policy agreed BEFORE hashing). Deployed at version `2327eda2` (`gitSha 336840b`) in an idle
  GO window and re-measured live: all 23 post-deploy assertions passed, including 7 flagged rows (served == kernel == an
  independent neutral comparator, 0 mismatch on all 103 rows) and `verify-onchain` on `F-HD-260655-c` still
  `labelMatchesKnownPlanet: false` with its `ledgerScienceHash` byte-equal to the committed fixture.

- Eighteenth-round audit (2026-10-23) re-derived the round-17 Defect-1 fix from THREE independent angles at once -- our kernel,
  `/api/findings`, `/api/state`, plus a neutral comparator that knows no ExoFOP convention beyond `.NN` -- with ZERO mismatch
  (`.01 -> b` live, conflicts exactly 7 on all three, the gate direction corrected in the SAME commit as the kernel, and the
  wiring + `node --check` gates proven live by injecting an ESM syntax error and watching exit 1). It then caught the first
  PUBLIC-number miss in sixteen rounds, and it is ours: the round-17 post (id `2113577794491896133`) said the predicate "reads
  the whole catalog" and the devlog header said reach went "to all 103", conflating PARSER coverage with PREDICATE reach.
  Designator parsing genuinely spans 103/103 and `requestedDesignator` is non-null on 99/103 (4 unnamed rows correctly `none`),
  but `labelConflict` can only FIRE where BOTH sides decode a designator AND the row carries a NASA `crossmatch.knownPlanetName`
  to contradict -- re-measured on the committed fixture AND live, that is 34 of 103 rows (33.0%), ceiling 38 (the rows with a
  comparison name), 65 rows with nothing to contradict. So 27.2% -> 33.0%, NOT -> 100%. WHAT SHIPPED is guard hardening + docs
  with NO Worker deploy (scripts/tests/docs only; `src/core/signal-identity.ts` changed by a DOC-COMMENT alone, compiling to
  byte-identical runtime, so the served bundle is unchanged): (1) a FOURTH public net `feedCoverageViolations()` on the send path
  (`scripts/post-x-text.ts`) that refuses a coverage/capability totality claim carrying no denominator -- the class ALL THREE
  prior nets (over-claim / time / money) missed, and the sentence this repo writes most; deliberately narrow, so an honest "every
  candidate is UNCONFIRMED" still passes (an over-refusing guard is its own failure); (2) `FEED_SPEND_WORDS` widened from a
  word-list toward a rule (`\$\w`, burn, fee, spend, lamports, rent, payout) after 8 of 19 probes evaded the old enum -- `$SDR`,
  burn/burned, fee, spend, lamports, rent, payout, this system's own currency vocabulary; (3) the THIRD, wider time-word copy in
  `tests/science-digest.test.ts` DELETED so send + archive + composer share ONE `FEED_TIME_WORDS`/`FEED_SPEND_WORDS` (the extra
  phrases folded into the single exec-layer rule), closing the mismatch that ran in the direction which had let the round-17
  violation through; (4) the `hostKeyOf` COMPONENT ASYMMETRY -- a label carrying a stellar component the crossmatch name lacks
  ("HD 202772 A c" vs known "HD 202772 b") yields different host keys, SUPPRESSING a real conflict AND blocking the `signalKeyOf`
  merge -- DOCUMENTED as a cost in the `labelConflict` comment and PINNED by a positive test, NOT code-fixed (0 live rows carry
  it, so a fix is a verified no-op, and the false-merge it prevents is the worse failure; any future mint guard deduping on
  `signalKeyOf` must confront it). TWO forensic caveats recorded, neither a code change: the "18 accepted are all revalidations"
  claim is positively provable on 17/18 -- `F-WASP-121-b` predates the origin projection and carries neither `origin` nor
  `recoveryTrials`, so its status is INFERRED from the `seats.ts:165` blind-toi cap (an accepted row can never be blind-toi) plus
  its own `crossmatch.knownPlanetName === "WASP-121 b"`, red line 2 still holding at blind-toi accepted 0; and the `hashScience`
  leak is LAYERED, not closed -- the CURRENT code collapses the HR-858 trio to ONE hash `f6eb9cc6ac17` (distinct 1/3, green in
  `live-data-regression.test.ts`), but the ANCHORED trio on `/api/ledger` stays three DISTINCT pre-audit-4 hashes
  (`4ec80a3a32`/`e154b8b1a7`/`66a8db3f1c`, 4-field memos sealed on-chain, immutable), so as a dedup key against the STORED ledger
  it remains separated (`findAnchoredScience` matches stored values, not a recompute); reconciling storage to code would
  RE-ANCHOR three immutable commitments = a second fee = the money path = calibration-gated, untouched. The round-17 violation
  post (id `2113575468452454508`, carried "today's") is now marked superseded-by id `2113577794491896133` with a disposal line in
  its devlog header -- RECORDED, not deleted [ROUND-20: the X API v2 DOES expose `DELETE /2/tweets/:id`; not
  implementing a delete path is this repo's immutable-archive POLICY, not a platform limit -- see the twentieth-round bullet].
  Suite 944 -> 950 pass / 0 fail locally (+6: the 8-probe spend test, three coverage-net tests, two hostKey-asymmetry tests);
  `typecheck:all` + `eslint --max-warnings 0` clean. No stored row, manifest byte, `bundleHash`, `scienceHash`, verdict gate,
  anchor semantic or money path moved; `ledgerAnchored` stays exactly 20 [ROUND-20: aged -- live re-measured 23 @ 2026-10-24T07:02Z]. The SAME two calibration-gated research decisions -- a
  mint-time duplicate-suppression guard and a seat-identity-free content address -- remain the only things that move the
  evaluation, and neither was touched again this round.

- Nineteenth-round audit (2026-10-23) turned the round-18 lesson back on round-18. Round-18 had added a FOURTH public net
  (coverage/capability) and widened the money rule from an enum toward a rule, and its own note warned that "an over-refusing
  guard is its own failure"; this pass re-derived the reach figures first (reachable 34/103 = 33.0%, ceiling 38, no-comparison 65,
  `requestedDesignator` non-null 99/103, kinds `{candidate-number:58, planet-letter:41, none:4}`, conflicts 7, hosts 90, signals
  91, accepted 18 / with-origin 17 / blind-toi-accepted 0 -- ALL byte-identical to round-18, so no regression), then probed the two
  freshly-changed nets for exactly that over-refusal failure and FOUND IT TWICE. (1) The money widening had added a bare
  `\bburn\w*\b` and a bare `\bsol\b`, which measured as FALSE hits on honest prose -- `MCMC burn-in` / `CCD burn-in` / `a burn-in
  period` (a methods staple) and `Sol` / `per sol` / `the Sun (Sol)` (the Sun, a Martian day). (2) The coverage net's verb+totality
  alternative fired on ANY object, so it refused TRUE processing statements that are not reach claims at all -- `reads the whole
  light curve` / `scans every sector` / `covers the full sector`. BOTH fixed by NARROWING in `scripts/science-digest.ts` (scripts/tests
  only, NO Worker deploy, no served-bundle change): `burn` is now `\bburn(?:ed|ing|s)?\b(?!-)` (a hyphenated compound is not a token
  burn), `sol` now needs a VALUE context (`\d+(?:\.\d+)? sol` or `sol token|coin|price|balance`), and the coverage totality now must
  govern a REACH noun (`catalog(ue)`/`dataset`/`row`/`finding`/`record`). The discipline that makes a narrowing safe is that every
  one is paired with a re-proof the CATCHES survive: all 10 currency probes (`$SDR`/`burn`/`burned`/`fee`/`spend`/`lamports`/`rent`/
  `payout`/`wallet`/`seed phrase`) still REFUSE each `/wallet\/spend/i`, and all 6 catalog-reach catches (`reads the whole catalog`,
  `sees all rows`, `covers every finding`, `spans the entire dataset`, `decodes the complete catalog`, the shipped round-17 sentence)
  still REFUSE. TWO things are stated plainly rather than chased: the citation surname `Burns 2019` still trips the money rule --
  rare in feed prose and safer to refuse than to loosen a MONEY guard for, so PINNED as a deliberate residual; and the
  denominator-bearing false totality (`reach went from 28 of 103 to all 103`) still slips the coverage net, because a regex cannot
  reliably separate a false "to all N" from a true "across all N rows" and the form that actually SHIPPED (bare "reads the whole
  catalog") IS caught -- left a DOCUMENTED limit, not guessed at. Suite 950 -> 953 pass / 0 fail (+3 regression tests in
  `post-x-text-guard.test.ts`); `typecheck:all` + `eslint --max-warnings 0` + `node --check web/*.js` (6/6) clean, zero non-ASCII,
  zero secret hits, and send+archive+composer still share ONE `FEED_TIME_WORDS`/`FEED_SPEND_WORDS`/`feedCoverageViolations`. No
  stored row, manifest byte, `bundleHash`, `scienceHash`, verdict gate, anchor semantic or money path moved; `ledgerAnchored` stays
  exactly 20 [ROUND-20: aged -- live re-measured 23 @ 2026-10-24T07:02Z], blind-toi accepted 0, every `discoveryClaim` false. The SAME two calibration-gated research decisions remain the only
  things that move the evaluation, and neither was touched again this round.

- Twentieth-round audit (2026-10-24, external, re-measured live at 07:02Z on `2ebcd59`; scripts/tests/docs only, NO Worker
  deploy). The auditor OPENED by withdrawing two of its OWN older claims, which we re-confirmed first-hand rather than on trust:
  (a) "a planet label leaks into the `scienceHash` content address" is FALSE now -- `scienceProjection` (`src/bundle/bundle.ts`)
  carries no `targetId`/`findingId`, so HR 858 b/c/d all recompute to ONE `currentScienceHash` `4ec80a3a32...` (HD 260655 b/c to
  `400a5557ce9c`) and the three DISTINCT `/api/ledger` hashes are SEALED history under an older projection; (b) "`scienceHash` dedup
  is dead code" is FALSE now -- the 2026-10-24T01:31:18Z stream shows `Skipped anchor for F-HD-260655-c: identical science already
  anchored as F-HD-260655-b -- no new fee spent` then `Auto-anchor ... spent=false` (correct idempotence). Ledger field note so it
  is not repeated: rows carry `signature`/`slot`/`memo`, NOT `solanaTx`; all 23 have a real mainnet signature + slot.
  - FIXED this round (Defect 1, the headline): `/api/state` `ledgerAnchored` re-measured **23** (three new real-fee anchors
    2026-10-23 evening -- F-AU-Mic-b 15:56:01Z, F-TOI-480-b 16:02:26Z slot 460503654, F-HD-110067-b 18:03:39Z), yet 18 places still
    said 20 AND `tests/live-catalog-accounting.test.ts:89` had named "the wider predicate moved no anchor" an INVARIANT sourced from
    a FROZEN fixture -- falsified in production, because F-HD-110067-b is BOTH anchored AND `labelConflictsWithKnown:true` today, and
    CI stayed green because it reads the fixture. The test's ASSERTIONS are unchanged (the fixture really is 20 rows / 3 distinct
    stored hashes); its header + messages are RE-SCOPED to CAPTURE-not-live-invariant (7/7 pass). A CENTRAL CORRECTION (CHANGELOG
    round-20 section, README:85, RESPONSE:442) supersedes every prior "exactly 20" as a live figure; short markers annotate the
    present-tense instances. This is the round-17 lesson ("a frozen wrong expectation as a gate is worse than no fix") recurring on
    the MONEY path, except the wrong expectation came from a production MOVE, not a predicate blind spot.
  - FIXED this round (Defect 4): the coverage net was still a phrase-matcher (3 of 25 samples escaped: `reads the catalog in full`,
    `parses the entire input`, `handles everything`). `scripts/science-digest.ts` recomposed `COVERAGE_TOTALITY` from shared
    fragments (verbs +parses/handles/processes, nouns +input; postpositive + bare-object + standalone branches) and added
    `COVERAGE_CONTRASTIVE` (the `from N of M to all M` form, checked WITHOUT the denom gate). +3 tests, `post-x-text-guard.test.ts`
    14/14. RESIDUAL documented: a totality beside an UNRELATED denominator still passes (regex cannot do semantic co-reference).
  - FIXED this round (Defect 6): "recorded, not deleted" was written as an external limit; X API v2 DOES expose
    `DELETE /2/tweets/:id` and this repo simply does not implement it (immutable-archive POLICY). Corrected the round-18 devlog META
    (outside the immutable fence) + the HANDOFF line to say POLICY, not platform limit.
  - Discipline adopted (Defect 7): the round-18 correction post's "re-tested on live production" aged within hours (103 -> 104 served
    rows, ceiling 38 -> 39, none 4 -> 5, so reach 34/104 = **32.7%**; numerator 34 + conflicts 7 held, the DENOMINATOR moved). Pushed
    bytes are immutable and NOT re-stamped; every future figure states "as of the capture <UTC>" in the body, never open-ended "on
    live production".
  - ROUND-21 STAGED WORK (Defects 2/3/5 -- MEASURED, need a Worker change, deliberately NOT touched this round so there is no
    "changed but not shipped" gap):
    * Defect 2 (anchor gate blind): `src/cf/rig-state.do.ts:630-725` `anchorFinding` gates only on `bundleHash`-exists +
      `scienceHash`-idempotence -- NOT `verdict`, NOT `labelConflictsWithKnown`, NOT tier. The auto path (`src/cf/workflow.ts:628`)
      requires `verdict==="accepted"`, but a row NEW in content AND `labelConflictsWithKnown:true` would auto-spend a permanent
      commitment with no gate between. MINIMAL FIX: in the new-spend branch of `anchorFinding`, refuse (or require human confirm) when
      `labelConflictsWithKnown===true`; add a READ-ONLY aggregate endpoint. Measured 23 anchored by today's state: 5 needs-more-data,
      1 rejected (F-HD-63433-d), 4 conflicting, 3 stand-in, 0/23 `bundleHash`-match (designed; disclosed per-card in `web/app.js`).
    * Defect 3 (tier is prose): `src/data/dataTier.ts::isRealPhotometry` has ONE consumer (`src/reporter/narrate.ts:111` headline
      prefix), no gate, and NO served tier field (all 20 served fields enumerated, none a tier). 4 stand-in rows; GJ 1214 b +
      HD 189733 b are `accepted` AND on-chain, and their `verdictReason` ("...on evidence alone, without using any truth period")
      CONTRADICTS their headline (`[stand-in synthetic curve]`) + README:187 ("by construction, not evidence of a find"). FIX: a served
      `tier` field + an aggregate stand-in/on-chain disclosure.
    * Defect 5 (unverifiable on-chain ids): F-AU-Mic-b, F-HD-63433-d (`det=null`), F-GJ-1214-b, F-HAT-P-11-b, F-HD-189733-b
      (`req=null`) -- the label-conflict predicate structurally cannot run on any of the five. Same root as Defect 2; the aggregate
      endpoint should name them.
  - Close: Suite 953 -> 956 pass / 0 fail locally (+3); on a `.git`-less, FITS-un-prefetched tarball the auditor read 942 pass /
    3 env-fail / 8 skip (the known ancestry + `out/probe-*.fits` guards), CI green. `typecheck:all` + `eslint --max-warnings 0` +
    `node --check web/*.js` (6/6) clean, zero non-ASCII, zero secret hits. No stored row, manifest byte, `bundleHash`, `scienceHash`,
    verdict gate or anchor semantic moved. `ledgerAnchored` **23** as-of 2026-10-24T07:02Z (NOT a frozen 20), blind-toi accepted 0,
    every `discoveryClaim` false.

MUTEX-FINISH DEFECT OBSERVED 2026-10-19 -- REAPPEARED 2026-10-22, STILL NOT PROVEN FIXED (keep observing). At that snapshot
two consecutive autonomous passes finished their work and then held the run mutex until the 30-minute stale takeover
released it:

- `run-20261019-001518`: claimed 00:15:18Z, last event 00:19:24Z (6 rows written), still `running=true` when the slot
  was taken over at 00:45:18Z -- 30 minutes of occupancy for 4 minutes of work.
- `run-20261019-004518`: claimed 00:45:18Z, last event 00:47:44Z (3 rows), still `running=true` at 01:15Z.

By contrast `run-20261018-161518` did release cleanly (claimed 16:15:18Z, finished 16:32:31Z, 17 minutes), so the tail
path is intermittently not running rather than always broken. Consequences that are already visible: the survey is
running roughly one pass per 30-45 minutes against a `*/15` cron, so half the scheduled passes are refused with 409 by
a claim that is doing nothing; and `deploy:window` reports WAIT for most of that time, which is what made this deploy
wait two hours. This is the same family as audit-6 (a stateful progress path whose release depends on a tail step that
may never execute), but on the FINISH half of the mutex rather than the advance half -- `decideFinish`'s zombie guard
cannot help if `finishRun` is never called. Do not "fix" it by shortening `STALE_RUN_MS`: that re-opens the mutex to a
genuinely slow pass and lets two passes write concurrently. Start by finding out where the workflow stops -- per-target
steps that are still running, a step that throws and skips the tail, or a Workflow instance that never resumes -- and
make the answer observable before changing the timeout semantics.

UPDATE, measured 2026-10-20: the freeze has NOT been reproduced since. `GET /api/state` now reports surveyPass 216 (up
from 99 at the 10-19 snapshot), so the survey has been finishing and advancing continuously across roughly the last
32 hours. That makes the defect dormant, not resolved -- no code fix landed, and the dependency is structural (the
finish tail must actually run). The observability step above still stands as the next action if it reappears.

UPDATE, measured 2026-10-22: it REAPPEARED while this v0.2 deploy was waiting on a GO window. `deploy:window` held WAIT
for ~35 minutes across two consecutive autonomous passes that far outran the measured full-pass span (median 238 s): the
pass claimed at 15:15:21Z was still `running=true` at 15:28Z, and the one claimed at 15:30:45Z at 15:49Z -- each finishing
its finding work quickly (surveyPass advanced 421 -> 422 -> 423) yet holding the mutex. The GO finally cleared the instant
the second released (previous pass finished 15:49:51Z, 565 s of idle to the 16:00 claim) and the deploy went in that window.
So the defect is live again and intermittent, not dormant -- the survey is still effectively one pass per ~15-30 minutes
against a `*/15` cron, and deploys must catch the release boundary rather than assume a per-cron idle gap. The structural
next action named above (make WHERE the workflow stops observable before touching `STALE_RUN_MS`) still stands, now with a
fresh reproduction to instrument against.

UPDATE, measured 2026-10-23 (thirteenth-round deploy `bb16fd7`): a MILDER recurrence. The pass `run-20261022-170048`
claimed 17:00:49Z and was still `running=true` when first probed well past the measured median full-pass span (234 s),
but it released on its own at 17:07:26Z -- a ~397 s occupancy for the finding work, i.e. a span overrun but NOT a stall
to the 30-minute stale takeover. `deploy:window` therefore cleared GO at 287 s of idle before the 17:15 claim and the
upload landed inside that gap. So the defect's severity ranges from "span overrun that still releases before the
boundary" (this pass) to "held until stale takeover, minutes-long WAIT" (10-19 and 10-22) -- intermittency confirmed,
root cause (finish tail not reliably running) still open, and the observability-first next action stands.

- L3 (multi-host shared-ephemeris collapse) is now APPLIED in p22 by default (was flag-only): emitted candidate rows
  exclude collapsed systematics; web/candidates.json regenerated (7 independent groups -> 5 rows, 2 collapsed),
  summary carries systematicCollapsed/emittedCandidates/l3Applied. Research-only code (worker not imported), but the
  regenerated static snapshot + board banner WERE deployed (user-authorized) as version 9ff60199; board serves 5 rows,
  l3Applied true, discoveryClaim-true count 0 (verified by cache-busting probe).
- p28 corroboration-proof (positive control on 10 KNOWN planets, up to 4 real SPOC sectors each, blind per-sector BLS):
  STRICT cross-sector corroboration fired 0/10 (single-sector period resolution too coarse to match epochs) -> the
  board's L4 flag is inert for blind detections; period-only fired 3/10 but matched truth 1/3; only 3/10 known planets
  got >=2 significant blind hits. Honest finding: the blind per-sector public-FFI path is UNDER-POWERED for a real
  discovery (often cannot re-find known planets); a genuine claim needs a JOINT multi-sector coherent period search
  + deeper/longer data. Measure-only, nothing gated/anchored/claimed.
- p29 joint-search (positive control for the JOINT method p28 called for: stitch sectors -> one BLS period ->
  per-sector foldedBoxDepth confirmation): the joint fit recovers the true period to 0.01-0.05% and >=2 sectors
  confirm a matching dip for 7/10 known planets -- the corroboration ENGINE is now PROVEN on ground truth. Remaining
  bottleneck is period SELECTION not sensitivity: stitched BLS picks the system's strongest signal (a real but
  different planet in multi-planet systems; sometimes a P/2 or 2P alias), so naive per-queried-planet match is 1/10.
  Next lever before a novel hunt: alias/harmonic disambiguation (src/sim odd-even resolver) + per-planet scoring.
  Measure-only, nothing gated/anchored/claimed.
- p30 joint-alias (did p29's to-do: resolvePeriodAlias on the stitched curve + score PER HOST SYSTEM; added 3
  offline aliasResolver cases): OVERTURNS p29's optimism. Resolver changed period 0/10 (stitched BLS peaks are
  not clean odd/even P/2 aliases; sector gaps leave too few epochs); even per-system the recovered period matched
  a known planet of the host on only 2/10, system-corroboration 1/10; most raw periods 12-100% off. Since p12
  shows the planets ARE in the data, the failure is that single blind BLS on a stitched baseline locks the WRONG
  period. CONVERGENT conclusion p26-p30: this public-data blind pipeline is NOT discovery-grade (cannot reliably
  re-find known planets); a real claim needs a stronger detector (iterative multi-signature / TLS / bright-shallow
  selection) -- nothing less earns relaxing the honesty guardrails. Measure-only, nothing gated/anchored/claimed.
- p31 common-mode (the source-level FP attack the p23/p26 chain pointed to but never built): within each sector,
  subtract the robust per-cadence median fractional deviation across the whole stellar ensemble BEFORE BLS
  (src/detect/commonMode.ts, research-only, worker not imported). Targets the COHERENT instrumental systematics
  that calibratedFap's per-star null cannot touch and that L3 only clusters AFTER detection. MEASURED on real
  TGLC sector-1 FFI quiet stars (null arm) + injected planets (seed 7), across ensemble size N (FULL subtraction):
    N=40 : false-alarm 42.5% -> 27.5% (-35%); injected completeness 8.3% -> 6.7% (DROPS); purity 70.2% -> 74.4%
    N=120: false-alarm 51.7% -> 30.0% (-42%); completeness 8.5% -> 10.1% (RISES); purity 66.3% -> 80.2%
    N=240: false-alarm 47.5% -> 28.2% (-41%); completeness 7.7% ->  9.7% (RISES); purity 66.2% -> 80.5%
  Honest reading: the FP cut is robust at every N (-35 to -42%) and is the FIRST lever here to move the false-alarm
  number materially (vs the empirical-FAP gate's 25% -> 23%). Completeness crosses over between N=40 and N=120
  exactly as template-estimation noise SE ~ sigma/sqrt(N) predicts: a too-small ensemble stamps its own estimation
  noise onto every star, a large one both cleans the coherent systematics AND unmasks shallow dips (10000 ppm
  recovery 5.7% -> 9.8% at N=240; long 8 d periods 3.8% -> 6.2%). At N>=120 FULL dominates a spike-gated variant
  on all three axes, so the default runs a >=120-star per-sector ensemble. This does NOT overturn the p26-p30
  "not discovery-grade" verdict (that is a period-SELECTION / single-baseline limit, orthogonal to systematics
  removal); it is a real, measured gain in candidate PURITY (~66% -> ~80%) and shallow-signal completeness.
  Measure-only, nothing gated/anchored/claimed/deployed.
- p32 iterative multi-signal extraction (the p30-named detector upgrade, src/detect/iterative.ts, research-only,
  worker not imported): find the strongest transit, resolve its half/third-period alias, refine the period on a
  dense local grid (the coarse BLS grid smears narrow transits and under-states their depth), MASK its in-transit
  cadences, re-run BLS on the residual, repeat. Phase 1 (catalog positive control: 12 multi-planet hosts, 29 known
  in-range planets, real stitched public SPOC sectors, production gate SNR>=7 & depth>=200 ppm): single-pass 1/29
  vs iterative 1/29, delta +0, 0/12 hosts improved -- the second, shallower/longer-period planet falls below the
  gate on underpowered public few-sector curves, so the limit is DATA POWER, not the algorithm. Phase 2 (real-noise
  injection positive control on those same curves: 3.3 d@2500 ppm + 8.1 d@1800 ppm injected multiplicatively):
  iterative recovers BOTH on 5/6 curves (10/12 injected transits) while single-pass is capped at one period per
  star (5/12) -- mask-and-refind is sound on REAL noise, confirming Phase 1's null is a data-power limit.
  Converges with p26-p31: not discovery-grade on public few-sector data; deeper baselines / more compute (Track C)
  is the lever. Measure-only, nothing gated/anchored/claimed/deployed.
- p33 large-scale reproducible completeness/purity ROC (Track C first increment; research script + published artifacts
  reports/p33-scale-roc.md and reports/p33-catalog.json; no new src/ module so no new unit tests -- it imports the
  already-tested iterative.ts + injectInto.ts): scales the two-arm injection-recovery design to a seeded sample of real
  hosts and METERS compute. NULL arm (detector on the real curve as-is, every gated signal classified against the
  CONFIRMED catalog) over 33 usable public TESS-SPOC curves (7 coverage misses of 40 sampled, counted honestly): 29
  gated detections, 12 TP / 17 FP, blind FP rate 51.5%, purity 41.4%. Purity is a LOWER bound (the null arm matches
  only CONFIRMED planets, so a genuine unconfirmed planet/TOI counts FP) but it is the FIRST scale measurement of
  Problem 1's blind FP rate on real curves. INJECT arm (P=3 d injected across a depth grid on the same real noise):
  completeness 42.4% @300 ppm -> 54.5% @500 -> 69.7% @1000 -> 78.8% @2000 -> 81.8% @4000, plateauing at ~82% (honest
  ~18% of curves never recover even a deep injection: the host's own signal or the sector-gap window function
  dominates). Compute MEASURED: mean 27.86 s/curve (null+6 injects) => ~3.98 s/single-star detection => ~1.11 CPU-h per
  1000 stars (detection only, excl. download). Method note: an earlier maxSignals=1 variant was BIASED (a host's own
  real planet outranked the injected one, so deep injections were scored as misses and null FPs undercounted); the fix
  keeps ALL gated signals (maxSignals=3) and matches the injection with ANY of them. Measure-only, nothing
  gated/anchored/claimed/deployed.
- p34 measured compute/cost model (research script scripts/p34-cost-model.ts + artifacts reports/p34-cost-model.md
  and .json; no new src/ module so no new unit tests): re-fits a power law from the committed p33 catalog each run
  (nothing hardcoded). Detector cost ~ k * nPoints^p with p = 2.94 (near-cubic, R^2 = 0.84, N = 33) -- BLS on a fine
  period grid is superlinear and iterative mask-and-refind re-runs it per signal. Practical upshot for Track C: the
  completeness lever (deeper baselines => more points) is priced ~nPoints^2.94, so doubling the baseline costs ~7.7x.
  Detection-only CPU-hours (download/parse excluded, flagged as the other bottleneck): a 20000-star 2-sector catalog
  ~22 CPU-h, 4-sector ~169 CPU-h; embarrassingly parallel across stars, so a 64-way CI matrix gives ~0.3 h / ~2.6 h
  wall-clock. Quotes CPU-h only, invents no provider price. This is the compute spec Problem 3 asked for and the
  sizing basis for the thousands-star scale-out. Measure-only, nothing gated/anchored/claimed/deployed.
- p35 PDM independent cross-check (src/detect/pdm.ts, research-only, worker not imported; +5 offline unit tests;
  research script scripts/p35-pdm-crosscheck.ts + artifacts reports/p35-pdm-crosscheck.md and .json): Problem 3's
  "independent validation" attacked at the METHOD level -- Phase Dispersion Minimization (Stellingwerf 1978) is a
  non-parametric period finder sharing NO machinery with the box-fit family (minimizes the within-bin variance theta
  of the phase fold; never fits a box or a transit model). Run on the SAME seeded 33 real TESS-SPOC curves as p33:
  NULL cross-check: 18 curves had both a gated BLS period and a finite PDM minimum; agreement (same period or
  harmonic, tol 2%) 9/18 = 50.0%. Where they differ, PDM's global theta minimum usually locks the dominant stellar
  rotation/activity period -- the expected behavior of a general period finder on a real variable star. INDEPENDENT
  completeness (PDM alone recovers a P=3 d injection, same depth grid/seed): 24.2% @300 ppm -> 51.5% @1000 -> 78.8%
  @8000, uniformly BELOW the detrended box-fit detector's 42.4/69.7/81.8% on the same stars. The gap is the honest
  finding: it quantifies why transit pipelines use a detrended box-fit search rather than raw PDM, while agreement
  cases (e.g. KELT-9: PDM 1.48 d theta 0.12 vs gated BLS 1.48 d) show two independent estimators converge on strong
  real signals. Wording note: docs now say "the iterative detector under the production gate" for iterativeBls
  (research-only module; "production" refers to the gate thresholds, not worker wiring). Measure-only, nothing
  gated/anchored/claimed/deployed.
- p36 cross-pipeline harness (Track C c1b; scripts/p36-export-fixtures.ts + scripts/cross_pipeline.py +
  .github/workflows/crosscheck-python.yml + committed fixtures tests/fixtures/spoc-curves/): independence at the
  IMPLEMENTATION level -- the same real photometry re-analyzed by a pure-Python stack sharing no code with this
  repo (batman injection + wotan biweight detrend + astropy BoxLeastSquares, optional transitls). The dev
  environment has NO Python interpreter, so the split is deliberate: TS exports byte-identical CSV fixtures
  (first 16 seeded hosts of the p33/p35 sample -> 12 usable real TESS-SPOC curves, 4 coverage misses, uniform
  stride subsample to <=2500 pts, manifest carries known CONFIRMED periods), and the pinned CI workflow runs the
  Python harness on push-touching-paths / workflow_dispatch, uploading reports/crosscheck/ as an artifact. NULL
  arm (wotan+BLS TP/FP vs known planets, p33's lower-bound purity semantics) + INJECT arm (batman P=3 d across
  [300..8000] ppm -> wotan -> astropy BLS). Every method independently guarded: a missing/failed package degrades
  only that cell. Honest boundary: the cross-pipeline NUMBERS are produced in CI and read from the workflow
  artifact (measure-before-gate -- never asserted in docs before the run); fixtures are subsampled so they are not
  1:1 comparable with p33's full-resolution completeness. The Python script could NOT be executed locally (no
  interpreter); its first real execution is the CI run of the commit that adds it. Measure-only, nothing
  gated/anchored/claimed/deployed.
  Follow-ups already landed: (a) the first CI run of the harness FAILED at pip install -- the pins used non-existent
  PyPI distribution names; fixed in eb0693f after verifying every version against the PyPI JSON API (batman's dist
  name is batman-package, TLS ships as transitleastsquares; the re-run of eb0693f completed SUCCESS, the Python
  stack really executed). (b) Anonymous artifact/log download requires auth (401/403), so the workflow now also
  PUBLISHES reports/crosscheck/ back into the repo via GITHUB_TOKEN (contents:write, same mechanism release.yml
  already uses); the publish commit cannot re-trigger the workflow (paths filter excludes reports/). NOTE FOR
  SUCCESSORS: after a publish-back commit lands, `git pull --rebase` locally before the next push.
- Recent Stage-4 commits: 65d4b8d (p26 corroboration-ROC: multi-host coincidence collapse L3 cuts the
  coherent FP ~63% at zero planet cost; same-host cross-sector L4 is gated by multi-sector coverage) ->
  fa8f9c6 (p27 shape-coherence: honest NEGATIVE, per-curve median-vs-mean spike test gives no separation,
  re-establishing repeatability as the only lever). All research-only: worker not touched, nothing gated.
- Recent observe commits: cfe56b4 (request() path) -> 5da5ef9 (/api/rpc proxy, real fix
  for #8100002) -> 00da5a7 (full unsigned wire for Phantom) -> 1d42b18 (cap unlimited).
- Production probes all pass: no-payment commission -> 402 (zero spend), forged sig -> 402,
  compute -> 200, /api/rpc -> 200 with real chain data. Owner confirmed the full Phantom
  flow works end to end ("ok").
- Honest boundary: as of this writing NO real user has completed a real paid burn on
  production; the first real spend on the observe path happens at the first real order.
  Fee-wallet SOL balance is the operator's to watch (optional next step: a balance watchdog).

## 14. Suggested onboarding order for the successor

1. Read this file, then README.md (full science narrative), then wrangler.toml comments.
2. npm ci; npm run typecheck:all; npm test -- confirm 260 green locally.
3. npm start; open the dashboard; watch one run stream.
4. npm run verify:observe; skim src/observe/*.ts in the order listed in section 5.
5. Only then consider deploys -- and never without explicit operator go-ahead.
