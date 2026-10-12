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

- src/core/       RigStore, types, auth (ADMIN_TOKEN bearer, constant-time), anchor-verify, ports.
- src/data/       catalog TAP, MAST tiers, FITS parsers, TGLC, TOI archive, Gaia dilution, synthetic.
- src/detect/     detrend, BLS, alias resolver hooks, transit fit (exact limb-darkened), ephemeris,
                  per-sector robust depth, significance/calibrated FAP, vetting discriminators,
                  shapeCoherence (in-transit median-vs-mean spike test; research-only, never gates), SVG plots.
- src/sim/        exactTransit, transitModel, redNoise, injectInto, injectionRecovery, roc, confidence.
- src/critic/     review.ts (mission-critic verdicts, centroid vetting gate).
- src/candidate/  candidateRecord, dedup, falsePositive, prioritize, snapshot (blind-mode chain),
                  corroboration (applyLayerFilters L1-L4 + partitionBySystematic; p22 applies L3 by default,
                  collapsing multi-host shared-ephemeris groups out of the emitted candidates; research-only).
- src/review/     externalReview.ts -- reusable library to independently audit a THIRD-PARTY
                  candidate claim (research-only; never gates, accepts, or anchors).
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
- src/api/        Node server. src/cf/: Workers side. src/node/: Node adapters.
- scripts/        p0..p27 experiment scripts (see section 6; p26 corroboration-ROC + p27 shape-coherence
                  measure the Stage-4 FP lever on real FFI) + verify-observe.ts + p2-anchor.ts
                  + wallet-import.ts + validate-curated.ts + bls_astropy_check.py (dev-only).
- tests/          43 test files, run via `npm test` (node --import tsx --test, explicit list in
                  package.json -- NEW TEST FILES MUST BE ADDED TO THAT LIST).
- web/            dashboard.
- out/            local artifacts, state snapshot, fee keypair (gitignored), commit-message
                  drafts (cm-*.txt).
- state/          additional local state.
- wrangler.toml   production descriptor (every switch documented inline).
- README.md       1100+ lines; full science narrative and measured results.
- CHANGELOG.md    v0.1.0 release notes.
- GOVERNANCE.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE (MIT).
- .github/workflows/ci.yml: on push/PR to main -> npm ci, typecheck:all, npm test.

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
`npm test` (233 tests currently). For observe changes also `npm run verify:observe`.
Deploy: `npx wrangler deploy`. BEFORE deploying, poll until no active run
(activeRun.running == false) -- never redeploy mid-run. After deploy, probe production:
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
- tsc --noEmit does not check tests/; new test files must be appended to the `npm test`
  file list in package.json.
- Durable Object RPC return types arrive with & Disposable -- do not cast them away.
- After esbuild changes to browserBurn.ts, ALWAYS `npm run web:bundle` and commit the
  regenerated web/vendor/solana-burn.js (deployed bundle must match local byte-for-byte).
- wrangler deploy can fail on "Trigger configuration only partially updated" (fetch
  failed) while the code itself deployed fine -- retry once and confirm.

## 13. Current state (as of 2026-10-13)

- Git: HEAD == origin/main == fa8f9c6 (working tree clean apart from this handoff update).
- Production: wrangler version e43b9a5a-492b-4f82-a617-35b05a7fa483, spacedatarig.app.
- Switches live: OBSERVE_ANCHOR=live, OBSERVE_ANCHOR_DAILY_CAP=unlimited, AUTO_RESEARCH=1,
  AUTO_ANCHOR=live (cap 100/day), MAST_S3=1, VET=1, PERSECTOR=1.
- Tests: 235/235 green (corroboration +6, shapeCoherence +3, L3 partition +1, snapshot L3-fields +1 vs the old 224).
- L3 (multi-host shared-ephemeris collapse) is now APPLIED in p22 by default (was flag-only): emitted candidate rows
  exclude collapsed systematics; web/candidates.json regenerated (7 independent groups -> 5 rows, 2 collapsed),
  summary carries systematicCollapsed/emittedCandidates/l3Applied. Still research-only, worker not imported, NOT deployed.
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
2. npm ci; npm run typecheck:all; npm test -- confirm 233 green locally.
3. npm start; open the dashboard; watch one run stream.
4. npm run verify:observe; skim src/observe/*.ts in the order listed in section 5.
5. Only then consider deploys -- and never without explicit operator go-ahead.
