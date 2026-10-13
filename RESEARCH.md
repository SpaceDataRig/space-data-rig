# Detecting and independently validating exoplanet transits on public TESS data: methods, measurements, and honest limits

**Space Data Rig - research report**
Status: measurement study. Every number below is reproducible from committed artifacts; nothing here is an
anchored, peer-reviewed, or discovery claim.

---

## TL;DR

We built a multi-agent pipeline that searches NASA TESS photometry for exoplanet transits and then tries hard to
disprove itself. This report is what the self-criticism measured:

- On **33 real host stars** (public TESS-SPOC light curves), our detector recovers **42% of 300 ppm** injected
  transits rising to **82% at 4000 ppm**, and its blind detections are **41% "pure"** against the confirmed-planet
  catalog - a deliberately conservative **lower bound** (an unconfirmed planet counts as a false positive).
- Two **fully independent re-implementations** - a non-parametric period finder (PDM) and a separate Python stack
  (wotan + astropy BLS) sharing zero code with ours - reproduce the same qualitative picture, which is the point of
  an independent check.
- A source-level **common-mode filter** cuts the coherent instrumental false-alarm rate by **35-42%** and raises
  candidate purity from **~66% to ~80%** on real full-frame-image data - the first lever we found to move the
  false-alarm number materially.
- We **measured** the compute cost of scaling: detector time grows as **~(number of points)^2.94**, so a
  20,000-star, 2-sector catalog is ~22 CPU-hours - embarrassingly parallel, ~0.3 h wall-clock on a 64-way matrix.

The honest headline: on public few-sector TESS data the binding limit is **data power**, not cleverness. We can
characterize exactly how good the search is and where it breaks; a genuine novel detection needs deeper baselines
(more sectors per star), which is a compute problem we have now sized.

---

## 1. What the system is

A TESS light curve is a star's brightness sampled every ~2 minutes for ~27 days. A planet crossing its star
(a transit) dims the star by a few hundred to a few thousand parts-per-million, once per orbit. Finding that dip
amid stellar variability, instrumental systematics, and gaps is the task.

The pipeline runs as cooperating agents:

- **anomaly-scout** - detrend + Box-Least-Squares (BLS) transit search + odd/even alias resolution;
- **sim-runner** - injection-recovery confidence + ephemeris prediction;
- **mission-critic** - cross-match against the confirmed-planet catalog, pixel-centroid vetting, calibrated
  false-alarm probability, and a verdict.

The detector itself is `src/detect/iterative.ts`: find the strongest transit, resolve its half/third-period alias,
refine the period on a dense local grid, mask its in-transit points, and repeat (mask-and-refind). Everything here
is a **research instrument**: it measures and reports. It does not, and structurally cannot, emit a discovery claim
(`discoveryClaim` is hard-wired false in the candidate record).

## 2. Scope and honesty (read once, applies everywhere)

- **"Real" means real public data** - TESS-SPOC PDCSAP light curves and TESS full-frame-image photometry from
  NASA's public MAST/S3 archives. Where a number comes from a synthetic or stand-in source, we say so.
- **Purity is a lower bound.** A detection counts as a true positive only if it matches a *confirmed* catalog
  planet of that host. A genuine planet that is not yet confirmed counts as a false positive, so the true purity is
  >= what we report. This is intentional: we would rather under-claim than over-claim.
- **Measure-before-gate.** No number is promoted into a claim until it is measured from a reproducible run.

---

## 3. Completeness and purity at scale (P33)

The core characterization: how deep does a transit have to be before we reliably find it, and when we do find
something, how often is it real?

**Design.** For each of a deterministic, seeded sample of confirmed-planet host stars we run two arms on the SAME
real light curve:

- **NULL arm** - run the gated detector on the curve as-is; classify every detection against the confirmed catalog
  (true vs false positive). This measures blind purity and the false-alarm rate.
- **INJECT arm** - inject one synthetic transit at P = 3 d at each depth in `[300, 500, 1000, 2000, 4000, 8000]`
  ppm into the real curve (real noise, cadence, and gaps preserved) and ask whether the detector recovers the
  injected period (alias-tolerant, 2% match). This measures completeness on real noise.

**Result** (40 hosts sampled, **33 with usable public curves**, 7 coverage misses counted honestly):

| quantity | value |
|---|---|
| gated null detections | 29 / 33 curves |
| true positives | 12 |
| false positives | 17 |
| blind false-positive rate | 51.5% of null curves |
| purity (lower bound) | **41.4%** |
| completeness @ 300 ppm | 42.4% |
| completeness @ 1000 ppm | 69.7% |
| completeness @ 4000 ppm | **81.8%** (plateau ~82%) |

The completeness curve **plateaus near 82%**: ~18% of curves never recover even a very deep injected transit,
because the host's own real signal or the sector-gap window function dominates the period search. That is a physical
property of short-baseline data, not a bug.

Reproduce: `npm run p33:scale-roc -- --stars 40 --maxsectors 2 --period 3 --seed 7`
(artifacts: `reports/p33-scale-roc.md`, `reports/p33-catalog.json`).

---

## 4. Independent validation: does another codebase agree? (P35, P36)

A detector that only agrees with itself proves nothing. We attacked independence at two levels.

### 4a. Method-level - PDM (an algorithm with no shared machinery)

Phase Dispersion Minimization (Stellingwerf 1978) finds periods by minimizing the within-bin scatter of the phase
fold; it never fits a box or a transit model, so it shares no code path with BLS.

- On the same 33 real curves, PDM and the gated BLS both returned a period on **18** curves; they **agree on 9/18
  (50%)**. Where they differ, PDM's global minimum usually locks the star's dominant **rotation/activity** period -
  the expected behavior of a general period finder on a real variable star, and precisely why transit pipelines use
  a detrended box-fit search rather than raw PDM.
- PDM-alone completeness is **uniformly below** the box-fit detector (24% vs 42% at 300 ppm; 79% vs 82% at 8000
  ppm) - an honest, quantified reason for the standard design choice.

### 4b. Implementation-level - a separate Python stack

We re-analyzed the same kind of real photometry with an entirely different toolchain (**batman** injection +
**wotan** biweight detrending + **astropy** `BoxLeastSquares`), sharing zero code with the TypeScript pipeline, run
in CI on byte-identical committed fixtures (12 real curves, subsampled to <= 2500 points).

- NULL arm: 12/12 curves yielded a detection; **7 true / 5 false positives -> purity 58.3%** (same lower-bound
  semantics).
- INJECT arm (detrended recovery): **50% @ 300 ppm rising to 100% @ 4000 ppm**.

Two independent stacks landing in the same region - and the *differences* being explainable (subsampled fixtures,
fixed injection geometry, detrending applied where the TS arm used the raw stitched curve) - is the value of the
exercise.

Reproduce: `npm run p35:pdm-crosscheck`; the Python harness runs in the `crosscheck-python` CI workflow and
publishes `reports/crosscheck/cross-pipeline.{md,json}` back into the repo.

![Independent validation on real TESS photometry](web/results-figure.svg)

---

## 5. Attacking false positives at the source (P31, common-mode)

Most blind false positives on full-frame-image data are not random noise - they are **coherent instrumental
systematics** that hit many stars in a sector simultaneously. Per-star significance tests cannot see them (they are
not star-specific), and post-hoc clustering only groups them *after* detection.

**Idea.** Within a sector, subtract the robust per-cadence median fractional deviation across the whole ensemble of
stars *before* the transit search. A planet is incoherent across stars (it dims one star); an instrumental glitch is
common to all of them, so the ensemble median estimates the glitch.

**Measured on real TESS full-frame-image quiet stars** (null arm) + injected planets, across ensemble size N:

| ensemble N | false-alarm rate | purity | shallow completeness |
|---|---|---|---|
| 40  | 42.5% -> 27.5% (**-35%**) | 70.2% -> 74.4% | 8.3% -> 6.7% (drops) |
| 120 | 51.7% -> 30.0% (**-42%**) | 66.3% -> **80.2%** | 8.5% -> 10.1% (rises) |
| 240 | 47.5% -> 28.2% (**-41%**) | 66.2% -> **80.5%** | 7.7% -> 9.7% (rises) |

The false-alarm cut is **robust at every N** and is the first lever here to move that number materially. Completeness
crosses over between N=40 and N=120 exactly as template-estimation noise (~1/sqrt(N)) predicts: a too-small ensemble
stamps its own estimation noise onto every star; a large one both cleans the systematics *and* unmasks shallow dips.
At N >= 120 the full subtraction wins on all three axes, so the default uses a >=120-star ensemble.

This does **not** overturn the "not discovery-grade on public data" verdict (that is a period-selection /
single-baseline limit, orthogonal to systematics), but it is a real, measured gain in candidate purity.

Reproduce: `npm run p31:common-mode-fp` (module `src/detect/commonMode.ts`).

---

## 6. Multi-planet systems (P32, iterative extraction)

Can the detector pull *more than one* planet out of a single star?

- **Positive control on real catalog systems** (12 multi-planet hosts, 29 known in-range planets): single-pass vs
  iterative both score **1/29**, 0/12 hosts improved. The second, shallower/longer-period planet falls below the
  detection gate on underpowered public few-sector curves - so the limit is **data power, not the algorithm**.
- **Real-noise injection control** (two planets injected: 3.3 d @ 2500 ppm + 8.1 d @ 1800 ppm): the iterative
  mask-and-refind recovers **both** on 5/6 curves (10/12 injected transits), while a single-pass detector is capped
  at one period per star (5/12). The algorithm is sound on real noise; the public data is just too thin to show it
  on known systems.

Reproduce: `npm run p32:iterative` (module `src/detect/iterative.ts`).

---

## 7. What scaling costs (P34, measured compute model)

Rather than guess, we fit a power law to the measured per-star wall-clock from the P33 catalog (re-fit every run,
nothing hardcoded):

- detector time ~ k * (points)^p with **p = 2.94** (R^2 = 0.84, N = 33). BLS on a fine period grid is superlinear,
  and mask-and-refind re-runs it per signal.
- Practical consequence: the lever that *raises* completeness (deeper baselines = more sectors = more points) is
  priced at ~(points)^2.9, so **doubling the baseline costs ~7.7x**.
- Detection-only sizing (download/parse excluded, flagged as the other real bottleneck):

| survey | 2 sectors | 4 sectors |
|---|---|---|
| 1,000 stars | 1.1 CPU-h | 8.5 CPU-h |
| 5,000 stars | 5.5 CPU-h | 42.3 CPU-h |
| 20,000 stars | **22 CPU-h** | 169 CPU-h |

Detection is embarrassingly parallel across stars, so a 64-way CI matrix turns the 20,000-star / 2-sector catalog into
~0.3 h wall-clock. This is the compute spec that sizes the thousands-star scale-out.

Reproduce: `npm run p34:cost-model` (artifacts `reports/p34-cost-model.{md,json}`).

---

## 8. Honest limitations

- **Baselines are short.** Public few-sector TESS-SPOC curves give ~27-54 days per star; long-period and shallow
  planets are coverage-limited, and the ~82% completeness plateau is a property of that data, not a fixable bug.
- **Purity is a floor, not a ceiling.** Unconfirmed planets count as false positives, so reported purity understates
  reality by an unknown amount.
- **The cross-pipeline fixtures are subsampled** (<= 2500 points) so their completeness is not 1:1 comparable with
  the full-resolution P33 numbers; the raw-vs-detrended columns are labeled accordingly.
- **No discovery is claimed.** These are characterizations of a search's operating point plus independent checks of
  it. Confirmation requires follow-up data this pipeline does not generate.

## 9. Reproducibility

Everything is deterministic given a seed and the public archives:

```
npm ci
npm run typecheck:all        # Node + worker targets
npm test                     # 260 unit tests
npm run p33:scale-roc        # completeness/purity at scale  -> reports/p33-*
npm run p35:pdm-crosscheck   # independent period finder     -> reports/p35-*
npm run p34:cost-model       # compute model from p33        -> reports/p34-*
npm run p37:figure           # this report's figure          -> web/results-figure.svg
```

The Python cross-pipeline harness runs in the `crosscheck-python` CI workflow and publishes its measured report back
into `reports/crosscheck/`. A `scale-roc` CI workflow re-runs the completeness/purity sweep at a larger sample and
publishes the report back, so the numbers in this document can be regenerated by anyone.

---

*Data: NASA TESS Archive / MAST (public; TESS-SPOC products, CC BY 4.0, Caldwell et al. 2020). Software: MIT.
This report summarizes measurements, not detections.*
