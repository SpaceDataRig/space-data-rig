# Space Data Rig

An OpenRig-style, five-seat AI team that does **real, reproducible astronomy**: it pulls
public NASA/MAST exoplanet data, hunts for planetary transits with a deterministic
Box-Least-Squares (BLS) search, proves each signal with injection-recovery simulation,
has a critic seat cross-match it against the known-planet catalog, and packages every
accepted result into a **hash-sealed reproducible bundle** that is anchored on **Solana
mainnet** as tamper-evident provenance.

Everything is streamed live to a **trader-friendly web dashboard**, so anyone can watch
the agents work, read a plain-English explanation of each discovery, inspect the actual
plots, verify a bundle hash, and see it land on-chain.

This repository is the **science engine + provenance layer**. The token is launched
separately on pump.fun; there is deliberately **no custom token contract or Solana
program here** - on-chain we only need an immutable, publicly verifiable record, which
the standard SPL Memo program provides.

---

## Why this exists

Most "AI agent on-chain" demos are theater: agents chat, a token exists, and nothing
verifiable happens. Space Data Rig is built to be the opposite:

- **It does real work.** The detection pipeline recovers known planets (HD 189733 b,
  WASP-121 b, HAT-P-11 b, pi Men c, the HR 858 system, ...) from real catalog parameters
  at their true periods.
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
| **data-fetch** | Queries the NASA Exoplanet Archive TAP service for bright transiting systems, builds a physical, observable light curve from real planet/star parameters, and records a SHA-256 provenance hash of the source data. Falls back to a bundled real-value catalog if the network is unavailable. |
| **anomaly-scout** | Detrends the light curve, runs a Box-Least-Squares period search, resolves odd/even epoch aliases, and emits a transit candidate (period, epoch, depth, duration, SNR). |
| **sim-runner** | Replays the detected signal through N fresh noise realizations (injection-recovery Monte Carlo) to estimate how reliably it is recovered, and predicts the next transit times (a falsifiable ephemeris). |
| **mission-critic** | Cross-matches the candidate period against the known-planet catalog (including harmonics), applies physical sanity checks, and issues a verdict (`accepted` / `needs-more-data` / `rejected`) plus a 0-100 composite score. |
| **reporter** | Writes the plain-English narration, renders the SVG plots (time series, folded phase curve, BLS periodogram), assembles the reproducible bundle manifest, and computes its SHA-256 hash. |

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
| GET | `/api/run/status` | current/last run state |
| GET | `/api/findings` | all findings (newest first) |
| GET | `/api/findings/:id` | one finding |
| GET | `/api/bundles` | bundle records |
| GET | `/api/bundles/:id/manifest` | the reproducible bundle manifest JSON |
| GET | `/api/bundles/:id/verify` | recompute the hash + re-hash artifacts on disk |
| GET | `/api/bundles/:id/artifact/:name` | serve `folded.svg` / `periodogram.svg` / `timeseries.svg` |
| GET | `/api/ledger` | local anchoring ledger |
| GET | `/api/events` | **SSE** live event stream (hello, log, state, ping) |
| POST | `/api/run` | start a pipeline run on the shared store `{ targets, delay, confidence, tmag, offline, resume }` |
| POST | `/api/anchor/:id` | anchor one finding's bundle hash on mainnet `{ dryRun, rpc, keypair }` |

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
record `sdr:1|<findingId>|<bundleHash>`. No custom program or token is involved.

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
  core/         types.ts (domain model), store.ts (RigStore event bus + snapshot/restore)
  data/         exoplanetArchive.ts (NASA TAP client + fallback), synthetic.ts (light-curve builder)
  detect/       bls.ts, detrend.ts, aliasResolver logic, pipeline.ts, svgPlot.ts
  sim/          transitModel.ts, injectionRecovery.ts, confidence.ts (recovery + ephemeris)
  critic/       review.ts (cross-match + verdict + score)
  reporter/     narrate.ts (plain-English narration)
  bundle/       bundle.ts (canonical JSON + SHA-256 manifest + verify)
  orchestrator/ pipeline.ts (the 5-seat Orchestrator), run.ts (CLI driver)
  solana/       anchor.ts (mainnet SPL Memo anchoring + RPC failover + ledger)
  api/          server.ts (Hono HTTP API + SSE + static dashboard)
scripts/        p0-benchmark.ts, p0-archive.ts, p0-detect.ts, p2-anchor.ts
web/            index.html, styles.css, app.js (the dashboard)
openrig/        rig.yaml, CULTURE.md, Dockerfile, docker-compose.yaml, agents/*
```

npm scripts: `p0:benchmark`, `p0:archive`, `p0:detect`, `orchestrator`, `api`, `start`,
`anchor`, `typecheck`.

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
