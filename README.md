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
built from real catalog parameters (now carrying realistic per-star red, time-correlated noise
by default rather than idealized white noise) -- and every bundle and card labels which tier produced
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
AWS account**. The code defaults are OFF (a stock deploy changes nothing until an operator
opts in). **This live deployment is opted in (aggressive tier)**: `wrangler.toml` ships
`MAST_S3=1`, `AUTO_RESEARCH=1` (an autonomous run on the every-hour cron, 8 targets), and
`AUTO_ANCHOR=live` with `AUTO_ANCHOR_DAILY_CAP=100`, so accepted findings are sealed on Solana
mainnet at a cost bounded to 100 memos/day (about 0.0005 SOL/day). Set `AUTO_ANCHOR=off` (or
`AUTO_RESEARCH=0`) and redeploy to pause spending.

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

## Scientific-rigness upgrades (self-validating, gated)

Beyond the autonomous loop, the analysis core carries additive primitives that raise it from a
demo to defensible science. Each is pure, deterministic and fully unit-tested. They began OFF the
default (synthetic) run path so the reproducible bundle hash stayed frozen; the honesty-critical
ones (red-noise stand-in, per-candidate calibrated significance, the blind critic, pixel vetting)
have since been promoted to ON BY DEFAULT -- detailed in the subsections below. That changes the
stand-in bundle hash to reflect realistic correlated noise, but the hash stays fully deterministic
and reproducible run to run (same seed => same bytes => same hash):

- **Exact limb-darkened transit model** (`src/sim/exactTransit.ts`). Quadratic limb darkening,
  computed as a deterministic 1-D radial integral of the occulted intensity. With no limb
  darkening it reproduces the analytic circle-circle overlap area to better than 2e-3 across
  the whole transit chord and gives exactly p^2 at central transit -- validated against an
  independent closed form, not a reference dataset. The geometric model in `transitModel.ts`
  still backs the deterministic injection so existing hashes stay stable.
- **Calibrated false-alarm probability** (`src/detect/fap.ts`). Turns the heuristic BLS SNR
  into a real significance level via a phase-scrambling null: each point's time is jittered
  by +-P/3, which destroys a transit's phase coherence while leaving the noise distribution
  intact; FAP is the fraction of surrogates whose BLS max-power reaches the observed power.
  An injected planet scores at the surrogate floor (0 exceedances) where pure noise scores
  ~0.19. (A naive circular time-shift was rejected -- it preserves the transits and gave a
  false planet a spuriously low FAP; the regression tests caught it.)
- **Pixel-level false-positive vetting** (`src/data/mastS3Pixels.ts`, wired into the critic via
  `reviewCandidate(vetting)`). For REAL SPOC photometry the critic downloads the 14x14 target-pixel
  cube and measures the in-transit photocenter displacement against the candidate's own ephemeris;
  a large shift means the dip is not on the target star (a blend / background eclipsing binary) and
  downgrades the verdict to rejected. This is now ON BY DEFAULT (`VET="0"` opts out): letting a large
  photocenter shift through by default would stake blends on the money path. The synthetic stand-in
  path has no pixels, so it is unaffected either way, and with vetting absent the review is
  byte-for-byte identical (a test asserts empty-vetting == no-vetting).

On pi Men c the real in-transit photocenter shift is 0.10 arcsec -- correctly judged on-target.
The reject threshold is EMPIRICALLY CALIBRATED, not guessed: `npm run p2:vet-calibrate` measures
the shift for confirmed planets (which genuinely transit their hosts, so must cluster near zero).
Across 14 confirmed planets the shift maxes out at 0.57 arcsec, so the critic rejects at >2.0
arcsec -- ~3.5x above every true planet yet far below the multi-arcsec signature of a background
EB / blend, so the gate only ever REMOVES accepts, never adds them. Pixel vetting is ON BY DEFAULT
in the code (`VET="0"` opts out) and kept explicitly `VET=1` in the autonomous deployment: blends
are vetoed before they can be anchored. The only residual cost is operational -- each vetted target
pulls a ~5 MB target-pixel file, so a full sweep runs slower.

Two more discriminators are implemented (`src/detect/vetting.ts`: odd/even transit-depth
symmetry and the phase-0.5 secondary-eclipse ratio) and are computed on every real run, but they
are logged as DIAGNOSTICS ONLY and deliberately do NOT gate the verdict. Calibration on the same
14 confirmed planets showed why: the odd/even asymmetry hits 100-200% for genuine planets, because
a single TESS sector with a catalog ephemeris accumulates enough phase error that alternate
transits drift in and out of the fold window. A metric that fails on known-good planets cannot be
used to reject candidates (it would silently drop true positives). The clean synthetic unit tests
pass, which is exactly the trap: a statistic that works on idealized data but not on real
single-sector photometry must be calibrated on REAL data before it is allowed to decide anything.
Only the centroid shift -- which is per-cadence and immune to ephemeris phase error -- gates today.

We then built the robust version we had sketched as future work: `oddEvenRefined` measures each
transit at its OWN center (a local search around every predicted epoch) instead of folding all
points into fixed windows, so accumulated phase error cancels. Re-running the calibration
(`npm run p2:vet-calibrate`) on the same 14 confirmed planets compares the two directly: the fixed
window still peaks at 200% asymmetry and mis-labels the active-star planets HD 63433 c/d, whereas
the refit correctly declines to judge ("n/d") on their sparse single-sector coverage. The production
light-curve diagnostic now reports the honest refit number rather than the inflated one.
Being disciplined about it, though, the refit is STILL not promoted to a gate: it only reaches a
confident verdict on 2 of 14 real planets, and one of those -- confirmed planet HR 858 b -- reads
69% asymmetry, so any 0.5-0.7 rejection cut would drop a known-true planet. A statistic that
occasionally fails a real planet cannot sit on the money-spending path, so the refit ships as a
diagnostic (a strictly more truthful one) and the centroid remains the only light-curve-adjacent
rejection. Multi-sector or TESS-wide ephemerides would give the refit enough well-phased events to
become gate-worthy; that data is out of scope for a single-sector pull.

### Measured operating characteristics (completeness / purity)

The detector's operating point is now quantified rather than asserted. `src/sim/roc.ts` runs a
seeded injection-recovery sweep: known planets give COMPLETENESS (period matches truth AND the
BLS SNR clears the threshold); ZERO-INJECTION pure-noise curves (same sampling, planet radius p=0,
so no dip anywhere) give the FALSE-ALARM RATE. Reproduce with `npm run p1:roc` (e.g.
`-- --inj 60 --noise 60 --baseline 15 --cadence 300 --seed 20260011`). A representative run
(TESS-like 200 ppm noise, 15-day baseline):

```
threshold(SNR)  completeness  false-alarm-rate  purity  TP/FP
        5          68.3%          10.0%   87.2%  41/6
        7          68.3%           0.0%  100.0%  41/0
        9          66.7%           0.0%  100.0%  40/0
       11          61.7%           0.0%  100.0%  37/0
```

Two things this makes defensible: (1) the `minSnr=7` decision cut is now DATA-JUSTIFIED -- noise
peaks topped out at SNR 5.7, so SNR>=7 threw 0/60 false alarms (the SNR>=5 cut would let 10% of
empty fields cry wolf); and (2) the ~68% completeness ceiling is the honest physical limit of
period-vs-baseline coverage (periods up to 12 days on a 15-day baseline) and sub-noise shallow
injections, not a silent failure. These are synthetic TESS-like benchmark figures; the real-sky
complement -- completeness measured by injecting into ACTUAL TESS data -- is below.

### Real-sky completeness (injected into ACTUAL TESS photometry)

A survey's completeness must be quoted on its own data, not only synthetic noise. `src/sim/injectInto.ts`
`injectTransitInto(lc, {period, depth})` multiplies a physical transit onto a REAL light curve
(noise color, cadence and data gaps untouched), and `npm run p1:real-completeness` runs the same
detector on many real TESS-SPOC light curves and records recovery by depth and period. Measured
(12 real hosts, 3 trials each, SNR>=7):

```
depth(ppm)   300   500   1000  2000  4000  8000
recovered    61.8% 72.9% 82.6% 84.7% 84.7% 88.2%
period        1.5d    3d    5d    8d
recovered     97.2% 89.8% 84.7% 44.9%
```

This is the honest, data-grounded operating characteristic: completeness rises monotonically with
planet size (62% at 300 ppm to 88% at 8000 ppm) and FALLS with orbital period -- an 8-day planet only
gets ~3 transits in a ~27-day sector, so it is intrinsically harder to catch than a 1.5-day one (97%).
The ~88% ceiling (not 100%) is real: active red-noise hosts, data gaps and period aliases cost us the
rest, exactly as the noise-color and ROC studies predicted. The core (`injectInto.ts`) is unit-tested
offline (deep injection recovered; depthFrac 0 is a point-for-point no-op; deterministic; completeness
monotone in depth); the script itself needs network and is not in CI.

### Per-detection parameter uncertainty (bootstrap error bars)

A point period with no error bar is not a measurement. `src/detect/uncertainty.ts` `bootstrapUncertainty`
runs a **circular block bootstrap** on the REAL light curve -- subtract a box model at the fitted
parameters, resample the residuals in contiguous blocks (preserving each star's own red-noise color, so
quiet stars get tighter bars than active ones at the same SNR), refit, and take the 16/50/84 percentiles.
`npm run p1:uncertainty` demonstrates it on real hosts: e.g. WASP-189 b `P=2.7266 +/- 0.004 d` against the
catalog 2.724 (bracketed), while the active star HD 63433 shows a much wider interval -- honest, noise-driven
error bars.

We state its limit plainly: the bootstrap conditions on the peak BLS found, so its interval captures
MEASUREMENT scatter, not ALIAS selection. On pi Men c the detector locked the 3.14 d half-period harmonic
(here) and the bootstrap reported a tiny error around the ALIAS -- a narrow interval is not proof the
period is the true one. Alias disambiguation is a separate concern (the significance/odd-even diagnostics,
the exact-transit shape fit, and multi-sector phase coverage). Shipping an error bar that overstates
confidence would be worse than no error bar, so we document exactly what it does and does not cover.

Because the noise ensemble IS the surrogate, the false-alarm-rate column is itself an empirical
false-alarm probability: `empiricalFap(noiseSnr, snr)` maps any single candidate's BLS SNR to the
fraction of planet-free curves that reached it (a Laplace-corrected, resolution-floored value) with
no per-candidate resampling. This gives each detection a calibrated significance, not just a
heuristic SNR label.

#### This operating point assumes WHITE noise -- red noise moves it (honest caveat)

The table above uses uncorrelated Gaussian scatter. Real TESS PDCSAP light curves carry
time-CORRELATED ("red") residual-systematic noise. `src/sim/redNoise.ts` adds a stationary AR(1)
noise process (lag-1 autocorrelation `rho`) on top of the same real transit geometry, and
`runRoc({ rho })` runs the whole benchmark under it (`rho=0` reproduces the white table byte-for-byte).
`npm run p1:roc` now also prints a red-noise comparison. Reproduce with
`npm run p1:roc -- --inj 80 --noise 80 --baseline 12 --cadence 200 --noise-ppm 300 --rho 0.5`:

```
threshold   white comp / FAR      red comp / FAR
SNR>=5      57.5% / 15.0%         55.0% / 46.3%
SNR>=7      55.0% /  0.0%         55.0% / 30.0%
SNR>=9      50.0% /  0.0%         52.5% /  0.0%
max false-alarm SNR:  5.90 (white)  ->  8.91 (red)
```

The conclusion is uncomfortable but real: **correlated noise attacks PURITY, not completeness**
(completeness barely drops) -- the white-noise "SNR>=7 => 0% false alarms" claim is OPTIMISTIC.
Under AR(1) rho=0.5 the same cut lets ~30% of planet-free fields cry wolf, and you need SNR>=9 to
push the red-noise false-alarm rate back to ~0%. We do **NOT** silently raise the production
`minSnr` on the strength of a synthetic rho, for the same reason we refused to ship the odd/even
discriminator un-calibrated: a gate on the money-spending path must be set from a measurement on
REAL data. The correct next step is to ESTIMATE rho directly from real SPOC PDCSAP residuals
(light-curve autocorrelation), then choose the cut so the RED-noise false-alarm rate -- not the white
one -- is at the level we publish. This caveat is a feature: the benchmark is sensitive to its own
noise assumption. RESOLVED BELOW: that next step shipped -- `estimateRho` measures the real noise
color, the synthetic stand-in now injects per-star red noise by default, and every candidate is
graded against a null of its OWN noise color, so the published operating point is no longer
white-noise-conditional.

#### We then MEASURED the real noise color (`src/sim/redNoise.ts` `estimateRho`, `npm run p1:rho`)

Rather than leave rho as a guess, we measure the residual lag-1 autocorrelation directly from REAL,
token-free TESS-SPOC PDCSAP light curves: moving-median detrend, MAD outlier rejection, then the
lag-1 autocorrelation of the residuals. The measurement unit is the STAR, not the planet --
multi-planet hosts share one light curve and are de-duplicated so a single busy star cannot bias the
distribution. Over 16 distinct bright hosts:

```
rho of real PDCSAP residuals:  min=-0.06  median=-0.00  p90=0.63  max=0.63  (mean 0.09)
```

This resolves the caveat with data and tells a genuine astrophysical story:
- The **median host is essentially WHITE** (rho ~ 0.0). SPOC's own detrending removes most correlation,
  so for quiet, old stars the white-noise FAR is a FAIR description and SNR>=7 is defensible.
- The **tail is strongly red** (rho ~ 0.63) -- and the two worst are exactly the young, magnetically
  ACTIVE stars in the sample (AU Mic ~24 Myr and HD 63433 ~20-30 Myr), whose real variability the
  estimator correctly flags. There the white-noise FAR IS optimistic and the red-noise cut (SNR>=~9)
  applies.

So noise color varies **star-to-star**, and one global SNR threshold is provably imperfect. The
principled follow-up is **per-candidate**: estimate rho from each target's own light curve and map
its SNR to an empirical false-alarm rate computed under THAT noise color. We record the measured
distribution rather than silently re-tuning the global cut -- the same discipline applied throughout
(money-path thresholds come from real measurements, and honest limitations are published, not hidden).

#### We then BUILT it: per-candidate calibrated significance, shipped ON

`src/detect/significance.ts` `calibratedFap(lc, snr, period)` does exactly what the measurement
prescribes: it estimates the target's OWN noise color (rho) and residual scatter, generates
planet-free nulls matched to them (`makeRedNoiseLightCurve`, depthFrac 0), and reports the empirical
false-alarm probability of the candidate's BLS SNR. It is deterministic (fixed seeds, pure functions
of the input flux) -- the same guarantee the pixel vetting relies on for the money path. It is now on
the DEFAULT path for EVERY candidate, not just real photometry: both the edge (`src/cf/workflow.ts`)
and Node (`src/orchestrator/pipeline.ts`) feed `vetting.fap` into the critic, so a candidate is
rejected when its calibrated FAP exceeds the threshold. Real SPOC photometry keeps the certified
full-resolution null ensemble (nNull 120) byte-for-byte; the synthetic/stand-in default uses a
bin-averaging cost guard (`maxPoints 2500, nNull 60`) so the ensemble completes deterministically in
~3s inside one workflow step. A subtlety that guard exposed, and we fixed: box-averaging crushes the
measured rho (a true 0.5 host reads ~0.05 after 8x binning), which made the null ensemble too WHITE
and leaked the false-accept rate to ~13%; estimating rho at NATIVE cadence and binning each null the
same way as the observed curve brought it back to the nominal ~5%. This is LIVE, not behind a flag.

Calibrating it caught a **latent landmine before it could fire**: the critic's old default FAP
gate was 0.01, but the smallest FAP a null ensemble can report is its resolution floor
`1/(nNull+1)` = 0.012 at nNull=80. A gate BELOW the floor would reject EVERY candidate -- real
planets included, since a 100%-certain signal still measures at the floor. We raised nNull to 120
(floor 0.008) and set the threshold from real data.

Safety certification (`npm run p1:fap-calibrate`, the mandatory measure-before-you-gate step): on **19
known planets that clear the production SNR>=7 cut**, every calibrated FAP sits at the floor (0.0083)
against the 0.05 threshold -- **zero false rejections**. (A couple of test planets like TOI-2128 score
high FAP only because BLS finds nothing for them at all, SNR<0 -- they are already declined upstream
and never reach the gate.) The threshold 0.05 keeps ~4x margin over the floor while still rejecting
genuinely insignificant peaks, and it is stricter and better-founded than the old fixed SNR label
because it adapts to each host's measured noise color. This is the operating principle the whole
project runs on: don't assert reliability, MEASURE it; and never wire a rejection gate without first
proving on known-good data that it doesn't kill real discoveries.

One subtler statistical question we probed rather than assumed: on the FULL-resolution real-photometry
path the observed SNR is the maximum of the WIDE detection search (0.8-16 d) while the null ensemble is
searched over a narrow window around the candidate period, and a wide-grid maximum is in principle
inflated relative to a narrow-grid one (a look-elsewhere effect). `npm run p2:fap-grid` compares the two
null choices on identical full-resolution red-noise curves. Measured, the two FAPs agree closely and the
choice flips NO accept/reject decision: planet-free 3/8 vs 3/8 at FAP<=0.05 -- and every one of those
carries SNR<7, so the production minSnr=7 floor rejects it anyway -- and planets 4/4 vs 4/4. Widening the
null grid to the detection grid would cost ~9x the edge compute for zero decision benefit, so the narrow
null stays and the probe ships as a permanent regression check. The load-bearing false-positive
protection on the money path is not this FAP nuance but the minSnr floor plus the blind critic's
direct-catalog-match requirement, which is why an empty field can never be staked.

### Blind / discovery mode (independent re-detection of UNCONFIRMED candidates)

Everything above re-validates planets we already KNOW. To show the pipeline can stand on its own,
`src/data/toiArchive.ts` (`npm run p5:blind`) sources **candidate transits that are not yet
confirmed** -- the NASA Archive `toi` table (TESS Objects of Interest), minus any host that already
appears in the confirmed catalog -- pulls the same token-free TESS-SPOC photometry, runs
`detectTransit` **BLIND** (the whole period grid, with the TOI's reported ephemeris deliberately
WITHHELD from detection), and only afterwards cross-matches the period we recovered against the TOI
reference. Independent recovery is evidence the signal is real in the downlinked pixels, not a
restatement of the discovery pipeline's own answer.

A real run (8 brightest unconfirmed candidates, SNR>=7) independently blind-recovered **5 of 8**:

```
TOI-1773.01  TOI P=0.7365d -> ours 0.7362d  SNR 44.5   CANDIDATE (blind recovery)
TOI-1025.01  TOI P=9.6838d -> ours 9.7442d  SNR 140.6  CANDIDATE (blind recovery)
TOI-1978.01  TOI P=6.0810d -> ours 6.0866d  SNR 121.7  CANDIDATE (blind recovery)
TOI-2011.01  TOI P=11.5778d -> ours 11.390d SNR 15.1   CANDIDATE (blind recovery)
TOI-1469.02  TOI P=6.7650d -> ours 6.7772d  SNR 11.4   CANDIDATE (blind recovery)
-- the 3 misses are honest: TOI-1469.01 locked its brighter same-star sibling, and TOI-1487.01 /
   TOI-2011.02 (23-28 d periods) fall below single-sector completeness, exactly as measured above.
```

The safety boundary is deliberate and load-bearing: **blind mode is a research probe, not an
announcement machine.** Nothing it finds is anchored, posted, spent on, or claimed as a discovery --
a hit is printed as `CANDIDATE (blind recovery, review)` for a human to follow up. Auto-anchoring an
unconfirmed candidate would put an unverified judgement on the provenance money-path and over-claim,
which is precisely what this project refuses to do. The rig reports what it can independently
recover and stops short of calling it a planet. (A `num(null)->0` coercion bug the offline schema
fixture caught: TAP nulls must map to NaN or candidates with no period silently pass as valid.)

This blind posture is now the DEFAULT critic, not a special probe mode. `reviewCandidate` decides
every verdict from evidence alone -- BLS SNR, the calibrated FAP, physical plausibility, transit
coverage, alias checks, injection-recovery confidence and (on real pixels) the centroid shift -- and
the known/injected truth period is consulted only AFTERWARDS, as a non-gating post-hoc note that can
never move the verdict. An `accepted` blind verdict requires ALL of: no hard-fail, no low-confidence
flag, at least 3 observed transits, a clean alias check, and a DIRECT catalog match (recovered
harmonic === 1). A harmonic or odd/even alias, a candidate with no catalog row to match, or any alias
ambiguity is capped at `needs-more-data` rather than accepted. Recovery gating -- scoring a candidate
by whether it matched the known truth period -- still exists but is now an explicit opt-in
(`RECOVERY_GATING=1`) reserved for benchmark self-tests, never the production path, so the money-path
verdict can never be flattered by peeking at the answer key.

### Survey-scale blind operating characteristics (`npm run p6:survey`)

To quote completeness/purity under the FULL blind critic -- not just raw period recovery -- `p6:survey`
runs a deterministic, fully OFFLINE synthetic survey: it injects known planets into per-star red-noise
light curves and, in parallel, generates planet-free red-noise curves, then pushes every target through
the same scout -> simulate -> calibratedFap -> critique path the production seats use
(`recoveryGating:false`, truth recorded post-hoc only). Injected periods are kept in the confirmable
regime (>= 3 transits over the baseline). Reproduce with `npm run p6:survey` (default 40 planets +
40 noise curves, ~3 min). A representative run:

```
planets (N=40)   accepted 35   needs-more-data 5   rejected 0
                 raw period recovery 36/40 = 90.0%   blind completeness 35/40 = 87.5%
noise   (N=40)   accepted 0    needs-more-data 1   rejected 39
                 4 curves threw a raw SNR>=7 peak, 1 of those cleared FAP<=0.05 -- yet 0 accepted
                 false-accept rate 0/40 = 0.0%   purity 100.0%
```

Two honest readings. (1) The 5 planet misses are all DIAGNOSED, not silent: three recovered the
half-period (harmonic x2) instead of the fundamental, one locked a wrong period with no catalog match,
and one recovered the TRUE period yet was still capped at `needs-more-data` by the odd-even alias gate
(x3). That last case is the entire gap between raw recovery (90.0%) and completeness (87.5%) -- the
honesty gates would rather decline a correct-but-ambiguous period than accept it. (2) On the money
path the survey proves the load-bearing invariant: four planet-free curves produced a tempting
SNR>=7 peak and one even passed its calibrated FAP, yet ZERO were accepted, because a blind accept
demands a DIRECT catalog match (harmonic 1) and an empty field has no catalog row to match -- so
accepted-only auto-anchoring can never stake a planet-free star. Purity stays 100% by construction,
not by tuning.

### BLS cross-validation against astropy (`npm run p2:bls-astropy`, dev-only)

Our BLS is a self-contained, deterministic implementation of the same box-least-squares statistic
astropy ships as `astropy.timeseries.BoxLeastSquares`. `p2:bls-astropy` proves they agree rather than
asserting it. The TS half ALWAYS runs: it builds three fixed-seed light curves (two white-noise, one
AR(1) rho=0.5 red-noise active star), self-checks that OUR BLS recovers each injected period to within
one grid step, and writes the curves plus our grid to `out/bls-astropy-fixtures.json`. The Python half
(`scripts/bls_astropy_check.py`) then runs astropy's BoxLeastSquares on the SAME fixtures and compares
best period (1% astropy-vs-ours, 2% vs truth -- one grid step) and transit depth (25%). It is dev-only
and FAILS SAFE: if Python, numpy or astropy is missing it prints an honest SKIP and exits 0, so CI and
a stock `npm install` are unaffected. On a machine that has astropy, `npm run p2:bls-astropy` runs both
halves and prints an aligned per-case PASS/FAIL table.

### Gaia dilution / blend diagnostics (`src/data/gaiaDilution.ts`, `npm run p3:gaia`)

The pixel centroid test rejects an off-target source. The complementary, also phase-INDEPENDENT
question is DILUTION: an unresolved faint companion inside the aperture adds constant light, so the
observed depth UNDERSTATES the host's true depth (and a diluted eclipsing binary on that companion
could mimic a shallow planet). `p3:gaia` queries the anonymous Gaia DR3 archive (`gea.esac.esa.int`
TAP; a read-only probe confirmed the endpoint, the COLUMNAR `{metadata,data}` JSON shape, and that
`distance` is a reserved ADQL word) and sums neighbour flux (G band as a documented TESS proxy)
within the aperture. On 10 confirmed-planet hosts the measured dilution factor was **~1.000
(min 0.999)** and **0/10 had more than 5% contaminating light** -- neighbours were +8 to +15 mag
fainter, even in the 27-source crowded field of TOI-5789 -- so these planets' depths are
trustworthy as-is.

Dilution ships as a **correction/diagnostic, not a rejection gate**, for two honest reasons: a real
planet can legitimately orbit a diluted star (unlike an off-target centroid, low dilution is not
proof of authenticity), and we decline to bolt a rate-limited third external service onto every
production run for a quantity that cannot decide a verdict. `gaiaDilution.ts`'s columnar parser and
aperture sum are unit-tested offline against a captured Gaia JSON fixture (which also caught the
same `Number(null)===0` coercion pitfall -- null magnitudes/coordinates must become NaN).


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
  data/         exoplanetArchive.ts (NASA TAP + fallback), synthetic.ts (red-noise stand-in builder),
                mast.ts + fits.ts (real TESS download + zero-dep FITS reader),
                mastCurated.ts (curated real-product registry), mastDiscover.ts (best-effort CAOM),
                mastS3.ts + mastS3Pixels.ts (token-free SPOC photometry + target-pixel cube),
                toiArchive.ts (blind unconfirmed-TOI source), gaiaDilution.ts (blend diagnostic)
  detect/       bls.ts, detrend.ts, pipeline.ts, svgPlot.ts, fap.ts (phase-scramble null),
                significance.ts (per-candidate calibrated FAP), vetting.ts (odd/even + secondary)
  sim/          transitModel.ts, exactTransit.ts (limb-darkened), injectionRecovery.ts, confidence.ts,
                aliasResolver.ts, redNoise.ts (AR(1) + estimateRho), roc.ts (completeness/purity),
                injectInto.ts (inject into real curves), uncertainty.ts (block bootstrap)
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
scripts/        p0-*.ts, p1-{roc,rho,fap-calibrate,real-completeness,uncertainty}.ts,
                p2-{vet-calibrate,anchor}.ts, p2-bls-astropy.ts + bls_astropy_check.py (astropy
                cross-check), p3-{discover,gaia-dilution}.ts, p4-autonomous.ts, p5-blind-probe.ts,
                p6-blind-survey.ts, validate-curated.ts (npm run mast:validate)
web/            index.html, styles.css, app.js, live.js (the dashboard)
openrig/        rig.yaml, CULTURE.md, Dockerfile, docker-compose.yaml, agents/*
```

npm scripts: `orchestrator`, `api`/`start`, `anchor`, `p0:benchmark`, `p0:archive`,
`p0:detect`, `p0:mast`, `p1:roc`, `p1:rho`, `p1:fap-calibrate`, `p1:real-completeness`,
`p1:uncertainty`, `p2:vet-calibrate`, `p2:bls-astropy`, `p3:discover`, `p3:gaia`,
`p4:autonomous`, `p5:blind`, `p6:survey`, `mast:validate`, `cf:dev`, `cf:deploy`, `test`,
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
