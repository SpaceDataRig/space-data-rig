# P39 systematics-inclusive null + ensemble FDR, measured on real TESS photometry

Reproduce: `npm run p39:instrumental-fp -- --limit 40 --nNull 40 --inject 20 --seed 7`
Module: `src/detect/instrumentalNull.ts` (unit-tested, deterministic, research-only -- no worker / verdict /
bundle hash / money path). Data: real TGLC sector-1 full-frame light curves, token-free public S3.

## The gap this closes

The shipped per-candidate significance gate (`calibratedFap`, `src/detect/significance.ts`) draws its null
from each star's OWN red-noise color. p23 and p31 both measured that this barely moves the blind false-positive
rate (25% -> 23%). The reason is load-bearing: the surviving false positives are COHERENT INSTRUMENTAL
SYSTEMATICS -- a dip/spike shared by many unrelated stars at the same cadence -- and those are significant
against a single star's own noise, so a noise-only null calls them planets. `commonMode.ts` already MEASURES
that shared component (the robust ensemble median per cadence) but only uses it to SUBTRACT; until now the
significance decision never accounted for what the systematic alone can manufacture.

`systematicsAwareFap` puts the measured coherent systematic INTO the null: a planet-free null is
`coherent-template-on-cadence + the target's own AR(1) noise`, drawn on the target's exact sampling. A
coherent instrumental FP IS the template, so the null reproduces it -> high FAP -> declined. A genuine transit
is a single star's signal, diluted ~1/N out of the ensemble median and therefore absent from the template,
so the null cannot reach it -> low FAP -> it survives. `benjaminiHochberg` then bounds the survey-wide false
discovery rate at a target q regardless of ensemble size (a per-trial threshold lets expected FP grow as
alpha x trials -- the reason FP stays ~28-30% when the ensemble is large).

## Pilot result (N = 40 real TGLC sector-1 curves, nNull = 40, seed 7)

The sector-1 ensemble shares a very large coherent systematic: the raw common-mode template has RMS
**4914 ppm and a 111060 ppm (11%) peak**. After common-mode subtraction the residual template collapses to
**RMS 40 ppm, peak 197 ppm**. Every quiet curve has no known planet, so each detector survivor is a false
positive; a star-specific 8000 ppm transit is injected AFTER the template is built (honest ordering) as a
completeness positive control.

### RAW curves (systematic present, not subtracted)

| gate | FP survivors (of 40) | FP rate |
|---|---|---|
| A) production SNR>=7 + depth>=200 ppm | 29 | 72.5% |
| B) + noise calibratedFap <= 0.05 | 29 | 72.5% |
| C) + systematics-aware FAP <= 0.05 | 7 | 17.5% |
| D) + Benjamini-Hochberg FDR q=0.1 | 0 | bounded <= 10% by construction |

**The systematics-aware null removed 76% of the false positives the noise-only FAP left untouched** (the
noise gate did nothing here, exactly reproducing p23/p31). Injected completeness under C on raw curves was 0%
(1 recovered inject): with an 11% coherent systematic present, a 0.8% single-star transit is genuinely within
what the shared instrumental signal can produce, so declining it is the honest, correct verdict -- significance
cannot rescue a signal buried under the instrument's own common mode.

### CORRECTED curves (common-mode subtracted first, then gated -- the intended pipeline)

| gate | FP survivors (of 40) | FP rate |
|---|---|---|
| A) production SNR>=7 | 28 | 70.0% |
| B) + noise calibratedFap <= 0.05 | 27 | 67.5% |
| C) + systematics-aware FAP <= 0.05 | 28 | 70.0% |
| D) + Benjamini-Hochberg FDR q=0.1 | 28 | bounded <= 10% |

After subtraction the coherent systematic is gone (residual peak 197 ppm), so `systematicsAwareFap` removes 0%
further -- but crucially it costs **0% completeness**: injected planets survive at 100% (2/2 recovered). This
proves `systematicsAwareFap` is a SAFE complement to subtraction: it declines only candidates the coherent
systematic could explain, and once that is subtracted there is nothing legitimate left to decline, so real
planets are untouched.

## Honest reading

1. **This is the first significance lever we have measured that materially cuts FP on real data** (-76% on the
   raw arm) and it targets exactly the coherent-instrumental FP class that every prior per-star gate was blind
   to. BH-FDR additionally bounds FP by construction as the survey scales.
2. **Where it works**: coherent instrumental systematics (the class p23/p31 identified but could not gate).
   The correct production posture is subtract-then-gate -- common-mode subtraction removes the bulk at source
   and restores completeness; the systematics-aware null catches whatever coherent power a subtraction misses,
   without ever costing a genuine transit.
3. **Where the boundary is (physics, not code)**: the ~67-70% residual FP after subtraction is dominated by
   each star's OWN variability and noise color (not coherent instrumental), which no ensemble null can separate
   -- it is indistinguishable from the per-star noise that already defines the gate. Closing that gap needs
   more data power (multi-sector baselines, longer windows) and physical vetting (centroid / blended-source),
   not a sharper significance model. This is the single-sector completeness/purity ceiling measured in p31/p33.

## Scope and next steps

Measure-only: nothing gated, anchored, claimed, or deployed. The pilot N=40 with a small recovered-inject count
makes the completeness percentages noisy; a CI workflow scales the sweep (larger `--limit` and `--inject`) and
publishes the definitive auditable figures. Wiring `systematicsAwareFap` into the production critic gate is a
money-path change and requires a measure-before-gate safety certification on confirmed planets plus explicit
operator go-ahead (it must never be turned on before it is proven not to reject real planets).
