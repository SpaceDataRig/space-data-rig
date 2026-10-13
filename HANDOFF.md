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
- scripts/        p0..p30 experiment scripts (see section 6; p26 corroboration-ROC + p27 shape-coherence
                  measure the Stage-4 FP lever on real FFI; p28 corroboration-proof is a positive control on
                  KNOWN planets showing the blind per-sector path is under-powered for a real discovery)
                  + verify-observe.ts + p2-anchor.ts
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

- Git: at time of writing HEAD == origin/main == 288e01a (Track B: iterative detector + p32 two-phase measurement);
  the Track-C p33 commit that carries this handoff update lands immediately after it (see git log for its exact hash).
- Production: wrangler version 9ff60199-c77c-44a0-b26b-4c6551953b34, spacedatarig.app (L3 collapse live on the board).
- Switches live: OBSERVE_ANCHOR=live, OBSERVE_ANCHOR_DAILY_CAP=unlimited, AUTO_RESEARCH=1,
  AUTO_ANCHOR=live (cap 100/day), MAST_S3=1, VET=1, PERSECTOR=1.
- Tests: 255/255 green (corroboration +6 then +3 period-only, shapeCoherence +3 then +3 foldedBoxDepth, aliasResolver +3, L3 partition +1, snapshot L3-fields +1, commonMode +6, iterative +5 vs the old 224).
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
2. npm ci; npm run typecheck:all; npm test -- confirm 255 green locally.
3. npm start; open the dashboard; watch one run stream.
4. npm run verify:observe; skim src/observe/*.ts in the order listed in section 5.
5. Only then consider deploys -- and never without explicit operator go-ahead.
