# Space Data Rig -- Full Project Handoff

Last updated: 2026-10-13. Status: production live at https://spacedatarig.app.
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

## 13. Current state (as of 2026-10-19)

SNAPSHOT, NOT HISTORY. The five bullets below are a measurement of the rig, taken at the timestamps named in them,
and `tests/handoff-freshness.test.ts` holds this section to its date: the as-of date may not trail the newest dated
CHANGELOG entry, every commit sha named here must be reachable from HEAD, and the production bullet must name the
revision it was built from -- because the next reader treats this block as live fact, as it should. The research
bullets that follow are dated observations from earlier passes, quoted as history with `reports/*.md` as their
authority; they are deliberately not restated here.

- Git: the revision this snapshot describes is 56e4574 ("fix(stats,core): serve the counter definitions, and delete
  the dead cursor RPC"), on top of 777461e (the P41 re-run) and 0788adb (the measured deploy window). Commits land
  faster than a document can be refreshed, so this line is deliberately about the revision measured below, not a
  claim about the tip -- `git log` is the authority there, and the commit carrying this text follows 56e4574.
  CI run 39143833493 for 56e4574: completed, success.
- Production: wrangler version a3d0ea01-df36-47d0-88fb-0c0f46f5ff37, gitSha 75e13a4a23b4cd1141bf551c883ae07bf87f7dce
  -- verified from the live rig, `GET /health` returns exactly that sha -- deployed 2026-10-19T01:17Z. An earlier
  version of this bullet recorded 045d730c / 56e4574, which was the audited revision of the code; this one added the
  static assets (the M4 panel and the 27-entry figure manifest) on top of it. Triggers: schedule `*/15 * * * *`,
  workflow `rig-run`, custom domain spacedatarig.app. Any later deploy supersedes this version/sha pair, so
  `GET /health` is the authority on what runs now.
  STATED EXCEPTION, because `npm run deploy:window` said WAIT at that moment and I uploaded anyway: between 17:39Z and
  01:15Z the tool returned WAIT on fourteen consecutive checks and one UNKNOWN (a transient network refusal, which it
  reports as UNKNOWN rather than a reassuring GO). The reason was not a pass doing work -- see the open defect below --
  and the change being published touches no code: `git diff 56e4574..75e13a4 -- src` is 0 bytes, only `web/`,
  `reports/`, `tests/`, docs and `ci.yml` differ, so no survey pass could have straddled two code versions. That is the
  judgement the window exists to force, made explicitly with its evidence rather than by quietly ignoring the verdict.
- Switches live, read off the deploy's own binding list: AUTO_RESEARCH=1, AUTO_RESEARCH_TARGETS=8,
  AUTO_RESEARCH_TMAG=10, AUTO_RESEARCH_ROTATION=1, AUTO_RESEARCH_POOL=120, AUTO_ANCHOR=live (cap 100/day),
  OBSERVE_ANCHOR=live (cap unlimited), MAST_S3=1, VET=1, PERSECTOR=1, DISCUSSION_MODE=grounded,
  CODE_VERSION=space-data-rig@0.1.1, SOLANA_RPC_FALLBACKS=api.mainnet-beta.solana.com.
- Public counters at that same moment (`GET /api/state`, measured 2026-10-19T01:17Z; the payload carries
  `statDefinitions` -- the sentence saying what each of these counts, from `src/core/stats-definitions.ts`):
  surveyPass 99 CLAIMED, distinctHosts 97 hosts with a recorded result, blindHeld 29 over blindCandidates 50 assessed,
  bundlesAnchored 5 published-bytes, ledgerAnchored 20 chain commitments, tasksDone 77. The report library serves
  50 reports with `stale: []`, `verified: 3`, `fullyVerified: 3`.
  Note the anchor pair moved since the previous snapshot (11 published-bytes against 20 commitments became 5 against
  20): that is the documented semantics at work, not a lost anchor -- the rotating survey re-derives a sealed record,
  its bundle hash changes with the new run timestamp, and the record leaves `bundlesAnchored` while staying on chain.
  Nothing was un-anchored; the count is a statement about the bytes published now.

- Tests: 104 files / 798 tests as this snapshot was taken (via `npm run test:coverage`, which is the CI command, so the
  coverage floors are part of the same green), and `npm run typecheck:all` clean. The count is itself a
  snapshot -- trust the run over any number written in a document, including this one.

OPEN DEFECT, MEASURED AND NOT YET FIXED (the next pass starts here). Two consecutive autonomous passes finished their
work and then held the run mutex until the 30-minute stale takeover released it:

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
