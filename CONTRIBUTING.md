# Contributing to Space Data Rig

Thanks for your interest! Space Data Rig is an autonomous five-seat AI science
pipeline: it pulls real target data from the NASA Exoplanet Archive, runs a
deterministic transit-detection pipeline (BLS search, injection-recovery
confidence), lets AI seats deliberate and vote on every candidate, packages the
result into a reproducible bundle, and anchors the bundle hash on Solana mainnet.

## Ground rules

- **Reproducibility is the product.** Any change that alters detection output,
  bundle contents, or manifest hashing must be justified and cross-checked.
  The canonical JSON + SHA-256 manifest hash must stay byte-identical between
  the Node runtime and the Cloudflare Workers runtime.
- **Honesty in labeling.** Catalog parameters are live NASA data. Light curves come
  from a fixed priority chain -- curated real MAST products, then token-free real
  TESS-SPOC photometry, then an optional CAOM discovery pass, then a seeded synthetic
  stand-in. Every result records which tier it came from. Never present a synthetic
  stand-in as an actual observation -- keep the provenance label truthful.
- **English only.** All code, comments, docs and config must be English.
- **Never commit secrets.** Keys, keypairs, funded RPC URLs and `.env` contents
  must never enter git. Runtime state (`out/`, `state/`, `.wrangler/`) stays out
  of the repository too.

## Development setup

```bash
npm install
npm run orchestrator -- --offline --targets 2   # deterministic local run, no network
npm run api                                     # Node dashboard at http://127.0.0.1:8787
npm run cf:dev                                  # Cloudflare Workers dev (needs wrangler login)
```

Before opening a pull request, make the same checks CI runs:

```bash
npm run typecheck:all   # Node + Worker typecheck gates
npm test                # core invariant test suite
```

## Where to start

- `src/core/` and `src/seats/` -- runtime-agnostic pipeline; the safest place to
  add science logic (covered by tests).
- `src/detect/`, `src/sim/` -- detection math; every PR here needs a numerical
  rationale or regression test.
- `src/cf/` -- Cloudflare Workers/Durable Object/Workflow runtime adapters.
- `src/api/`, `src/node/` -- Node runtime adapters.
- `openrig/` -- the OpenRig rig definition (RigSpec 0.2, five AgentSpec seats).

Keep runtime-specific code out of the shared core: the core must run on both
Node and Workers, so no `node:fs`, no `process.env` reads at module scope.

## Reporting issues

Please include the exact command, the runtime (Node vs Workers), and the run id
(`run-YYYYMMDD-HHMMSS`) when relevant. Bundle hashes make findings reproducible
-- share them freely.

## Security issues

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.

## Contributor identity and AI collaboration

We keep authorship honest. This project is maintained by one human owner together with an
autonomous AI coding agent; agent-authored commits run through an explicitly-labelled
automated identity. If your pull request was written with an AI assistant, say so in the
description or with a `Co-authored-by:` trailer. We do **not** create additional accounts
or fake contributors -- real people who contribute commit under their own accounts, and
that is the pluralism we want.

## Starter tasks (good first issue)

Looking for a way in? These are scoped, verifiable first contributions. We file them as
issues labelled `good first issue`; pick one and comment to claim it.

- Add an offline regression test for an uncovered pure function in `src/detect/` or `src/sim/`.
- Tighten a doc/comment where the wording is stronger than what the code proves.
- Improve a dashboard label so the real-vs-stand-in provenance is clearer to a non-expert.
- Report the CI status / test count in the PR checklist template, or fix a broken link.
- Propose (with a measured rationale) a `good first issue` for an area you know well.

## Independent review is the point

The rig exists to be checked. Use the **Independent review** issue template to (a) ask us to
run our pipeline on your candidate, or (b) dispute/reproduce one of our results. Anything we
report is reproducible from public data plus a hash-sealed bundle, so verify us rather than
trust us.
