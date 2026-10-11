# Space Data Rig

An OpenRig-style, five-seat AI team that runs a **fully reproducible transit-detection
loop**: it pulls real confirmed-planet parameters from the NASA Exoplanet Archive, resolves
each target's light curve (real MAST TESS photometry where curated -- or, with the opt-in
token-free tier, real TESS-SPOC photometry pulled autonomously from a public S3 bucket --
otherwise a seeded synthetic stand-in), hunts the injected transit with a deterministic
Box-Least-Squares (BLS) search, quantifies recovery confidence with injection-recovery
simulation, has a critic seat cross-match candidates against the catalog, and packages
every verdict into a **hash-sealed reproducible bundle** anchored on **Solana mainnet**
as tamper-evident provenance.

**What this is, plainly -- and what it is not.** This is a science-grade *closed-loop
self-test*: the pipeline proves it can recover a known signal from noise, and it is **not**
claiming to discover new planets. The data-fetch seat resolves each target's light curve
through a fixed priority chain -- (1) a curated registry of REAL MAST TESS products
(anonymous `Download/file`, FITS-parsed), (2) an opt-in token-free tier that autonomously
pulls REAL TESS-SPOC PDCSAP photometry from the public AWS `stpubdata` S3 bucket by
deterministically constructing a TIC-sharded key (no MAST token, no AWS account), (3) an
optional best-effort anonymous CAOM discovery pass, then (4) a seeded synthetic stand-in
built from real catalog parameters -- and every bundle and card labels which tier produced
its photons (`REAL photometry` vs `seeded stand-in`). Tiers (2) and (3) are OFF by default,
so a stock run is fully deterministic on the stand-in and its bundle hash never changes;
enabling them (Worker var `MAST_S3=1`, which also narrows autonomous target selection to
TIC-bearing rows) lets any SPOC-covered target run on real starlight -- verified end to end
at the Cloudflare edge, where an autonomous pass fetched REAL photometry for live-selected
planets (e.g. pi Men c, HR 858 b) and the BLS seat independently recovered the catalog
period. A "recovery at the true period" on the stand-in path is by construction, not
evidence of a find. The critic is explicit about this too: it reports "recovers the catalog
transits" only on the real open-loop path and "recovers the injected signal" otherwise. What
*is* unconditionally real: the live NASA TAP catalog query, the detrending/BLS/alias math,
the injection-recovery statistics, the bundle hashing, and the on-chain anchoring -- all of
it auditable end to end.

Everything is streamed live to a **web dashboard**, so anyone can watch the agents work,
read a plain-English explanation of each verdict, inspect the plots, verify a bundle
hash, and see it land on-chain.

This repository is the **science engine + provenance layer**. The token is launched
separately on pump.fun; there is deliberately **no custom token contract or Solana
program here** - on-chain we only need an immutable, publicly verifiable record, which
the standard SPL Memo program provides.

---

## Why this exists

Most "AI agent on-chain" demos are theater: agents chat, a token exists, and nothing
verifiable happens. Space Data Rig is built to be the opposite:

- **It does real work, on synthetic data.** The detection pipeline is genuine BLS +
  detrending + alias resolution math; the data it runs on is a seeded light curve built
  from real catalog parameters. Recovering HD 189733 b at its true period therefore
  validates the *machinery*, and does not constitute a planet detection.
- **It is honest about uncertainty.** Every signal is replayed through fresh simulated
  noise; the fraction of times the pipeline recovers it is reported as a *recovery
  confidence*, and a critic seat can reject or watchlist a weak signal.
- **It is reproducible.** The same inputs always produce the same bundle hash
  (SHA-256 over a canonical, key-sorted JSON manifest).
- **It is independently auditable.** The bundle hash is written to Solana mainnet inside
  an SPL Memo transaction; anyone can re-read the chain and confirm the memo matches,
  with no trust in our database.
- **It is understandable.** The reporter seat translates every finding into a sentence a
  non-specialist gets, without dropping the real numbers.

---

## Architecture: the five seats

```
        +-------------+     +---------------+     +------------+     +---------------+     +----------+
 data ->| data-fetch  | --> | anomaly-scout | --> | sim-runner | --> | mission-critic| --> | reporter |
        +-------------+     +---------------+     +------------+     +---------------+     +----------+
        pull real NASA       BLS transit search    injection-recovery  cross-match vs        bundle + hash
        catalog + build      + odd/even alias      confidence +        known planets +       + plain-English
        observable light     resolution +          ephemeris           verdict + score       narration +
        curve + provenance   detrending            prediction                                SVG plots
        hash
                                             |
                                             v
                                   +-------------------+
                                   |     RigStore      |   shared state + event bus
                                   | tasks / findings  |   (snapshot + restore)
                                   | seats / bundles   |
                                   | events / stats    |
                                   +-------------------+
                                        |          |
                          +-------------+          +--------------+
                          v                                         v
                 +-----------------+                       +----------------+
                 | HTTP API + SSE  |  <-- subscribe -->    | Solana mainnet |
                 | web dashboard   |                       | memo anchoring |
                 +-----------------+                       +----------------+
```

Every seat talks to the shared `RigStore` instead of to each other. The store is the
single source of truth: the CLI, the HTTP API and the live dashboard all read from and
subscribe to the *same* store instance, so a run started anywhere streams everywhere.

| Seat | What it really does |
|------|---------------------|
| **data-fetch** | Queries the NASA Exoplanet Archive TAP service for bright transiting systems, resolves each target's light curve through the curated -> token-free TESS-SPOC public-S3 -> (optional) CAOM-discovery -> seeded-synthetic priority chain (the two real tiers are off by default, so a stock run stays deterministic), and records a SHA-256 provenance hash of the source data. Falls back to a bundled real-value catalog if the network is unavailable. |
| **anomaly-scout** | Detrends the light curve, runs a Box-Least-Squares period search, resolves odd/even epoch aliases, and emits a transit candidate (period, epoch, depth, duration, SNR). |
| **sim-runner** | Replays the detected signal through N fresh noise realizations (injection-recovery Monte Carlo) to estimate how reliably it is recovered, and predicts the next transit times (a falsifiable ephemeris). |
| **mission-critic** | Cross-matches the candidate period against the known-planet catalog (including harmonics), applies physical sanity checks, and issues a verdict (`accepted` / `needs-more-data` / `rejected`) plus a 0-100 composite score. |
| **reporter** | Writes the plain-English narration, renders the SVG plots (time series, folded phase curve, BLS periodogram), assembles the reproducible bundle manifest, and computes its SHA-256 hash. |

---

## The AI deliberation layer (two models, on the side)

Beyond the five deterministic seats, an **optional** large-model layer adds a plain-language
deliberation over each finding. It never touches the science pipeline, the bundle manifest, or
the bundle hash, and it degrades to a grounded (model-free) transcript when no API key is set.

- **Two reviewers, two lenses.** DeepSeek acts as the *statistical critic*; Grok (xAI) acts as
  the *adversarial red-team*. `llm.ts` speaks plain OpenAI-compatible Chat Completions, so each
  provider carries its own base URL + model.
- **Two-round cross-examination.** In round 1 each model gives its lens critique; when two or
  more answer, round 2 shows each model the other's opening and asks it to concede, defend, or
  rebut in one labeled sentence -- so the AIs genuinely argue instead of delivering parallel
  monologues. A model that fails is dropped individually; both rounds run concurrently.
- **Sealed + anchored.** The transcript's model turns are sealed as a tamper-evident
  *deliberation receipt* (`deliberations/<id>/receipt.json` + `HASH.txt`) whose hash anyone can
  recompute via `/api/discussion/:id/receipt/verify`, and -- on demand -- anchor on Solana
  mainnet under a separate `sdr:delib:1|<id>|<hash>` memo. That is integrity for AI
  *commentary*, deliberately kept apart from the reproducible science bundle.

Because model output is non-reproducible, this layer is a dashboard/audit feature only: the
deterministic run and its bundle hash are computed entirely offline and never depend on a
model response.

---

## Production deployment (Cloudflare Workers)

One codebase runs on two runtimes: a **Node** server (`npm run api`) and a **Cloudflare
Workers** edge deployment (`npm run cf:deploy`) live at **https://spacedatarig.app**. On the
edge a Durable Object (`rig-state.do.ts`) owns the shared state, the anchoring ledger, and the
WebSocket fan-out; a Workflow (`rig-run`) executes a run; R2 stores bundles and deliberation
receipts; and the fee-payer keypair lives in the `SOLANA_KEYPAIR` Worker secret. The
runtime-agnostic core (detection, simulation, critic, reporter, bundle hashing, the Solana memo
path, and the deliberation seal) is shared verbatim across both, so Node and edge stay at
parity.

---

## Autonomous research loop (token-free, opt-in)

The rig can select, fetch and analyze real targets by itself -- with **no MAST token and no
AWS account**. The whole loop is gated OFF by default, so deploying it changes nothing until an
operator opts in.

- **Real data, autonomously.** With the Worker var `MAST_S3=1`, target selection keeps only
  planets that carry a TESS Input Catalog id, and the data-fetch seat constructs a
  deterministic TIC-sharded key into the public `stpubdata` S3 bucket to pull REAL TESS-SPOC
  PDCSAP photometry (a public reimplementation of the official `aws s3 ls --no-sign-request`
  access). If a target is not in the SPOC program the tier 404s and the run falls through to
  the synthetic stand-in -- it never fabricates data.
- **On a schedule.** A `[triggers] crons` entry plus a `scheduled` handler in `worker.ts` can
  launch an autonomous run unattended, but only when `AUTO_RESEARCH=1` (default `0`, so the
  cron is inert). It reuses the same single-run mutex as the dashboard, skipping a tick if a
  run is already going.
- **Budget-gated on-chain sealing.** Autonomous runs may anchor an *accepted* finding, but
  only through the DO budget gate: `AUTO_ANCHOR` is `off` by default (spend nothing), `dry`
  previews the memo, and `live` spends real SOL only while a per-UTC-day cap
  (`AUTO_ANCHOR_DAILY_CAP`, default `0`) leaves room, and never repeats an already-anchored
  hash. On-chain anchoring therefore stays an explicit, cost-capped operator decision.

Try the chain without a token: `npm run p4:autonomous` (add `-- --targets 12 --tmag 9.5`, or a
known SPOC star with `-- --tic 1024880 --sector 4`).

---

## Quickstart

Requires **Node.js 22 or 24** (ESM, run via `tsx`). No database, no build step.

```bash
npm install

# 1) run the science pipeline (real NASA data by default; --offline uses the bundled catalog)
npm run orchestrator -- --targets 4 --delay 250
npm run orchestrator -- --offline            # deterministic, no network
npm run orchestrator -- --resume             # continue from the last snapshot

# 2) serve the live dashboard + HTTP API + SSE
npm run api                                  # http://127.0.0.1:8787/

# 3) anchor accepted bundles on Solana mainnet
npm run anchor -- --dry-run                  # preview memos, send nothing
npm run anchor                               # anchor all accepted findings
npm run anchor -- --verify                   # re-read the chain, confirm hashes
```

Artifacts are written under `out/`:

```
out/
  state/rig.json          the snapshot (checkpoint / restore point)
  findings/*.svg          plot gallery
  bundles/<findingId>/    manifest.json + HASH.txt + the three SVGs
  ledger.json             local mirror of on-chain anchoring state
  anchor-keypair.json     auto-generated throwaway mainnet fee-payer keypair
```

---

## The live dashboard

`npm run api` then open **http://127.0.0.1:8787/**. The page is served by the same Hono
server as the API (no separate frontend host) and updates over a single Server-Sent
Events connection:

- **Stats strip** - confirmed / watchlist / rejected / on-chain / targets done.
- **The team** - a live topology of the five seats with per-seat status and last message,
  so you can see exactly which agent is working.
- **Run controls** - start a run from the browser (targets, stage delay, recovery trials,
  offline, resume). Progress streams in real time.
- **Findings board** - cards ranked by critic score, each with the verdict badge, the
  headline, the hard numbers (period, depth in ppm, SNR, duration, recovery confidence,
  known-planet match), the plain-English explainer, the bundle hash, and the on-chain tx.
  Buttons let you open the **plots**, **verify** the bundle, and **anchor** it on mainnet.
- **Live feed** - the raw seat event stream.
- **On-chain ledger** - every anchoring attempt with its status and explorer link.

---

## HTTP API

Base URL `http://127.0.0.1:8787` (override with `PORT` / `HOST`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness/readiness probe (used by docker-compose + rig.yaml) |
| GET | `/api/state` | full dashboard payload: stats, seats, findings, bundles, events |
| GET | `/api/run/status` | current/last run state (Node) |
| GET | `/api/findings` | all findings (newest first) |
| GET | `/api/findings/:id` | one finding |
| GET | `/api/bundles` | bundle records |
| GET | `/api/bundles/:id/manifest` | the reproducible bundle manifest JSON |
| GET | `/api/bundles/:id/verify` | recompute the hash + re-hash artifacts |
| GET | `/api/bundles/:id/artifact/:name` | serve `folded.svg` / `periodogram.svg` / `timeseries.svg` |
| GET | `/api/ledger` | anchoring ledger (bundle anchors) |
| GET | `/api/discussion` | grounded deliberation threads for all findings (fast, no LLM) |
| GET | `/api/discussion/:id` | on-demand two-model cross-examination; seals the receipt and returns `deliberationHash` |
| GET | `/api/discussion/:id/receipt` | the sealed deliberation receipt JSON |
| GET | `/api/discussion/:id/receipt/verify` | recompute the receipt hash and compare (tamper check) |
| GET | `/api/discussion/:id/anchor` | read back any on-chain deliberation anchor |
| GET | `/api/events` | live event stream (**SSE** on Node; **WebSocket-first** with SSE fallback on the edge) |
| POST | `/api/run` | start a run `{ targets, delay, confidence, tmag, offline, resume }` (Orchestrator on Node; triggers the `rig-run` Workflow on the edge) |
| POST | `/api/anchor/:id` | anchor one finding's bundle hash on mainnet `{ dryRun }` (memo `sdr:1\|...`) |
| POST | `/api/anchor/:id/deliberation` | anchor the sealed deliberation receipt `{ dryRun }` (memo `sdr:delib:1\|...`, idempotent, separate from the bundle ledger) |

`POST /api/run` returns immediately and streams progress over SSE; only one run at a
time (a second call returns HTTP 409).

---

## Reproducibility and on-chain provenance

**Bundle hash.** The reporter writes a `manifest.json` capturing the recovered science,
the verdict and its individual checks, the recovery confidence, the predicted ephemeris,
data provenance (catalog source + light-curve hash), and a SHA-256 of every artifact.
The bundle hash is `SHA-256(canonicalJson(manifest))`, where `canonicalJson` sorts object
keys recursively and strips insignificant whitespace - so logically-equal manifests hash
identically across machines and runs.

**Anchoring.** `npm run anchor` writes each accepted bundle hash to Solana **mainnet** in
an SPL Memo instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) using the compact
record `sdr:1|<findingId>|<bundleHash>`. No custom program or token is involved. The
non-reproducible AI deliberation is anchored separately, on demand, under its own
`sdr:delib:1|<findingId>|<deliberationHash>` memo -- a distinct schema so an auditor can never
confuse AI commentary with the reproducible science bundle, and it never touches the bundle
ledger or the bundle hash.

**RPC failover.** Endpoints are tried in order: the private RPC in `SOLANA_RPC` (a local,
untracked `.env`, e.g. an Alchemy mainnet endpoint) first, then `SOLANA_RPC_FALLBACKS`,
then the public mainnet RPC - the first provider that answers wins, so a rate-limited or
down endpoint falls back transparently. Copy `.env.example` to `.env` to configure it.

**Graceful by design.** If every RPC is unreachable, or the fee-payer is not funded with
real SOL, anchoring returns `{ ok:false, error }`, the local ledger marks the entry
`failed`/`pending`, and nothing crashes - the bundle hash remains fully valid and
verifiable off-chain. Mainnet has no faucet: point `--keypair <funded-id.json>` at a
wallet that already holds SOL, or fund the generated address:

```bash
npm run anchor -- --keypair out/anchor-keypair.json   # out/anchor-keypair.json must hold SOL
```

**Independent verification.** Anchoring is checkable without trusting this app:

```bash
npm run anchor -- --verify              # re-reads each tx and confirms the memo matches
curl http://127.0.0.1:8787/api/bundles/F-HD-189733-b/verify   # recomputes hash + artifacts
```

---

## OpenRig integration

`openrig/` is a self-contained OpenRig rig (RigSpec 0.2) that runs these five seats as a
real agent team (Claude Code + Codex runtimes) with the deterministic code containerized
as managed services. See **[openrig/README.md](openrig/README.md)** for launch,
validation, snapshot/restore, and bundling instructions. OpenRig requires WSL2 on
Windows (plus Node 22/24, tmux, and Docker for the services block).

---

## Project layout

```
src/
  core/         types.ts (domain model), store.ts (RigStore), ports.ts (IO ports), state-types.ts
  data/         exoplanetArchive.ts (NASA TAP + fallback), synthetic.ts (stand-in builder),
                mast.ts + fits.ts (real TESS download + zero-dep FITS reader),
                mastCurated.ts (curated real-product registry), mastDiscover.ts (best-effort CAOM)
  detect/       bls.ts, detrend.ts, pipeline.ts, svgPlot.ts
  sim/          transitModel.ts, injectionRecovery.ts, confidence.ts, aliasResolver.ts
  critic/       review.ts (cross-match + verdict + score)
  reporter/     narrate.ts (plain-English narration)
  bundle/       bundle.ts (canonical JSON + SHA-256 manifest + verify)
  ai/           llm.ts (multi-provider client), discussion.ts (two-round cross-examination),
                threads.ts (grounded threads), deliberation.ts (sealable receipt + hash)
  seats/        seats.ts (seat role wiring)
  orchestrator/ pipeline.ts (the 5-seat Orchestrator), run.ts (CLI driver)
  solana/       anchor-core.ts (runtime-agnostic memo + chain path), anchor.ts (Node adapter + ledger)
  node/         artifact-store.ts (fs ArtifactStore), code-version.ts
  cf/           worker.ts (edge Hono API), rig-state.do.ts (Durable Object), workflow.ts (rig-run
                Workflow), artifact-store.ts (R2), env.ts, run-types.ts
  api/          server.ts (Node Hono HTTP API + SSE + static dashboard)
scripts/        p0-*.ts, p2-anchor.ts, p3-discover.ts, validate-curated.ts (npm run mast:validate)
web/            index.html, styles.css, app.js, live.js (the dashboard)
openrig/        rig.yaml, CULTURE.md, Dockerfile, docker-compose.yaml, agents/*
```

npm scripts: `orchestrator`, `api`/`start`, `anchor`, `p0:benchmark`, `p0:archive`,
`p0:detect`, `p0:mast`, `p3:discover`, `mast:validate`, `cf:dev`, `cf:deploy`, `test`,
`typecheck`, `typecheck:worker`, `typecheck:all`.

---

## Design constraints

- **Solana mainnet by default.** Accepted bundles are sealed with an SPL Memo transaction on
  mainnet. The fee-payer keypair is operator-supplied (a Worker secret in production, a local
  file under `out/` for Node runs) and must hold real SOL -- mainnet has no faucet. Devnet
  endpoints are still supported; airdrops only fire when the RPC URL targets devnet.
- **No token contract here.** The token lives on pump.fun; this repo only anchors
  provenance via the standard SPL Memo program.
- **Deterministic and offline-capable.** With `--offline` the whole pipeline runs against
  a bundled real-value catalog and touches no network, which keeps it provable anywhere.
- **English-only code.** All source, comments, docs, and config are ASCII English with no
  non-Latin characters, so they render identically in the terminal, the JSON bundle, the
  browser, and on-chain.
