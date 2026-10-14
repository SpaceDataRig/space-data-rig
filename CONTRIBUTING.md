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

## From measurement to production: the certification gate

Every new science idea enters as **research-only code** and stays there until it earns a gate.
Nothing that changes a verdict, the bundle hash, or the money path (anchoring) is wired in
without passing, in order:

1. **Pure, tested module.** The logic lives in `src/detect/`, `src/sim/`, `src/candidate/` or
   `src/data/` with offline unit tests added to the explicit list in `package.json` `"test"`.
2. **Positive control on known planets -- zero false rejects.** Before a discriminator may
   *reject* anything, calibrate it on confirmed planets (which by definition must be kept) and
   show it wrongly kills NONE. See `scripts/p53-*`, `scripts/p2-vet-calibrate.ts`. A single
   false reject disqualifies the gate ("measure before you gate").
3. **Vetoes also need the labelled negative class.** A tool that *rejects* candidates must clear
   the full 2x2 -- catch-rate on real blends/false positives AND a zero false-veto rate on known
   planets -- via `src/candidate/vetoAcceptance.ts` (`acceptVetoTool`), fed labelled data
   (`src/data/toiDispositions.ts`, token-free public ExoFOP dispositions; `scripts/p57-*`/`p58-*`/`p59-*`).
   Being safe on positives alone is NOT enough to certify veto power.
4. **Opt-in seam, inert by default.** When it graduates, wire it as *present-only*: it acts when
   supplied, and when absent the output is byte-for-byte unchanged (it can only make a decision
   stricter, never silently flip one). Keep it behind an env switch that defaults OFF.
5. **Operator authorization to enable in production.** Flipping a calibrated discriminator into
   the live critic / `AUTO_RESEARCH` / anchoring path -- and any `wrangler deploy` -- requires
   explicit maintainer authorization and a fresh idle-window check; it is a separate, deliberate
   act from landing the research code.

If a step's measurement shows little or no gain (e.g. a discriminator whose AUC lift is ~0 after
common-mode subtraction, `scripts/p42-*`), the honest outcome is to keep it inert and document
that -- not to ship it as production FP control.

## Adding a measurement (the `pXX` scripts)

Measurements are how we check ourselves and how outside contributors add value without touching
the pipeline. The pattern every `scripts/pNN-*.ts` follows:

- **Public, token-free data only** where possible (NASA Archive, MAST, the token-free TESS-SPOC
  S3 bucket, Gaia DR3, the public ExoFOP TOI table). Where a source genuinely needs a token,
  read it from an env var and emit an honest `AWAITING-TOKEN`/skip, never a fabricated number.
- **Register it**: add a `"pNN:name": "tsx scripts/pNN-*.ts"` entry to `package.json` scripts, and a
  repro line to the inventory in [RESEARCH.md](RESEARCH.md) (section "Reproducibility").
- **Write `reports/pNN-*.md` + `.json`** so the result is a committed, citable artifact; the report
  text must be internally consistent with its own numbers (a headline that contradicts a table is
  a bug). Distill public-facing numbers into `web/research.json` via `scripts/p38-research-bundle.ts`
  (which re-derives ONLY committed report values -- it runs no new analysis).
- **Independent cross-checks welcome**: a second algorithm (PDM, `scripts/p35-*`), a separate
  stack (wotan + astropy BLS, `scripts/p36-*` / the `crosscheck-python` CI job), or a replay
  manifest (`scripts/p55-*`) that lets anyone recompute a result without our code.
- **Negative results are gold.** `p41`, `p44`, `p46`, `p52`, `p60` are all published "it does NOT
  help / NOT safe to gate" measurements. Report what you measured, not what you hoped.

Gate a measurement PR with the same checks CI runs: `npm run typecheck:all` (covers `scripts/`),
`npm test` for any new pure module (add it to the explicit test list), byte-level ASCII-only, and a
secret scan -- and confirm a research script changed no `src/cf/` / verdict / money-path file.

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
