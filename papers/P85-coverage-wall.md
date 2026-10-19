# The Coverage Wall: why a faithful per-contaminant centroid F-test catches zero blends on single-pixel TESS photometry

Short paper, P85 (with P84 as the diagnostic and P82 as the sample). Research only. Every number here is read
from a committed, machine-recomputable checkpoint; nothing is gated, anchored, claimed, or deployed, and
`discoveryClaim` is false throughout. Reproduce commands are at the end.

## Abstract

We reproduce, faithfully, the per-contaminant multi-sector centroid F-test used by a real TESS follow-up pipeline
(the "eumemic" method), on a 500-target sample of public TESS-SPOC photometry, and report what it can and cannot do
when the resolving information is absent from the data. On 114 targets that localise at least two sectors the
statistic behaves exactly as its authors calibrated: a low known-planet false-reject rate (2 of 55, 3.6%, against
their 0 of 565). But it catches 0 of 59 labelled blends. We show this is not a threshold problem and not a
re-implementation bug: it is a coverage ceiling. 386 of 500 targets (77%) never localise a cross-sector centroid
offset at all from aperture photometry on a single TESS pixel, so for those targets there is no test to run. Widening
the sample narrows error bars; it does not lift the ceiling. The actionable conclusion is a boundary, not a tuning:
blended and multi-source-per-pixel scenes are out of scope for an aperture-photometry baseline, and recovering them
requires a photometric-method change (PSF fitting, or at minimum aperture correction with neighbour subtraction).

## Method

Statistic (`src/detect/centroidFtest.ts`), implemented as the authors describe it:

    F = n(n-1) |m - s|^2 / RSS,  with a 1"/axis scatter floor, df = (2, 2(n-1)), closed-form p.

For each target the test is run twice: for the target position s = (0,0), and for every catalogue neighbour bright
enough to cause the observed dip (`neighbourCanCauseDip`: a total eclipse of the neighbour, diluted by the host, must
still reach the observed depth). A blend is "caught" only when the target is rejected AND some contaminant's offset
fits the measured mean. Three methodological choices, made explicit where the authors' documentation left them open:

- which star "explains" the offset: the max-p neighbour among bright-enough contaminants (a per-contaminant reading),
  not a joint or min-p test;
- scatter floor: the 1"/axis floor is applied to the residual scatter AFTER subtracting the mean offset
  (per-axis minimum SS = (n-1) * floor^2);
- brightness gate: the neighbour-must-cause-the-dip test above.

The engine is the scaled harness (P82, `scripts/p82-scaled-validation.ts`), which fetches real SPOC sectors and Gaia
neighbourhoods concurrently and writes one resumable row per target; this paper reads those rows offline from a
committed checkpoint (`scripts/p85-contaminant-fit.ts`).

## Results

Coverage (the honest ceiling), over the 500-target checkpoint:

- testable, at least two localised sectors: 114 / 500 (22.8%);
- never localised, pixel-baseline bound: 386 / 500 (77.2%).

Headline at the run threshold (alpha = 0.001):

- known-planet false-reject: 2 / 55 (3.6%); the authors report 0 / 565 at p < 0.001, so our calibration arm agrees;
- blend caught: 0 / 59 (0.0%);
- among the testable blends that do have a bright-enough neighbour, a neighbour offset explains the mean in 49 / 52
  (94.2%) -- the statistic is not broken where it can run; it simply cannot run where the baseline gives it nothing.

Sensitivity to the significance threshold (same rows, same reference):

| alpha  | planet false-reject | blend caught | contaminant fits / viable |
|--------|--------------------:|-------------:|--------------------------:|
| 0.0001 | 0 / 55              | 0 / 59       | 50 / 52                   |
| 0.001  | 2 / 55              | 0 / 59       | 49 / 52                   |
| 0.01   | 5 / 55              | 1 / 59       | 43 / 52                   |

Relaxing alpha 100x recovers exactly one blend and pays for it in five known-planet false rejects: the wrong trade,
and direct evidence that no cut on this statistic recovers the capability.

## Why zero: the coverage decomposition (P84)

The zero blend-catch is two independent failures, and only the first is about the statistic:

- Coverage: about 70% of blend targets never yield two or more localisable sector offsets -- the target-pixel cube
  collapses -- so the F-test has no input;
- Power: among the 59 measurable blends, the F-test finds no single contaminant whose offset beats the target's,
  because a blend inside one pixel moves the aperture centroid by an amount comparable to the star-to-star scatter
  the baseline cannot resolve.

The first is a property of the photometric baseline, not of the method or its threshold.

## Provenance and self-correction (a number we retracted)

These numbers were re-measured. An earlier run of the same pipeline reported "caught 0/56" and "a neighbour explains
the mean in 54/56". An external dependency (the ExoFOP host-coordinate parser) had read sexagesimal right-ascension
hours as degrees, compressing every host into a 0-24 deg RA band so Gaia neighbourhood queries looked in the wrong
sky. After the fix the Gaia-derived quantities were re-run: caught 0/56 -> 0/59, neighbour-explains-the-mean 54/56 ->
49/52, known-planet false-reject 1/53 -> 2/55 (the pixel-offset arms moved only slightly; the Gaia-census arms moved
because they had never been trustworthy). That the inflated 54/56 dropped to 49/52 confirms the diagnosis: in a wrong
random field you can nearly always find a directionally-close star. The corrected figures above are what the
committed checkpoint reproduces.

## Reproducibility

The 500-target centroid checkpoint is committed at `tests/fixtures/scaled/centroid.jsonl` with a per-row sha256 digest
(`tests/fixtures/scaled/digest.json`), and `tests/scaled-reproducibility.test.ts` re-derives this paper's headline
counts from those committed bytes on every CI run. Any checkout can therefore reproduce 2/55, 0/59 and 49/52 without
the original multi-hour network pull. `scripts/p85-contaminant-fit.ts` stamps the committed checkpoint as its input,
so the published report is machine-verified, not merely timestamped.

## Limitations

- n = 500 targets is large for the coverage statement but the testable blend denominator is only 59; the 0/59 carries a
  Wilson upper bound near 6%, so "zero catches" is a ceiling measurement, not proof of impossibility at the population
  level.
- The F-test is reproduced as the authors describe it, from public photometry; a genuinely PSF-fitted or
  aperture-corrected photometric pipeline is a different instrument and out of scope here.
- Everything is first-order. No candidate in this paper is validated, gated, or claimed as a discovery.

## What would lift the ceiling

More sectors do not help if each is a single pixel. The resolving information needed -- a sub-pixel companion
displacement -- is only produced by a different photometric method: PSF fitting, or aperture correction with
neighbour subtraction. That is a science-layer rebuild, not a configuration change, and until it exists the correct
engineering stance is to treat any blended system as unsupported rather than to lower a threshold and pretend.

## Reproduce

    npm run p82:digest                         # rebuild the committed checkpoints + digest
    npm run p84:centroid-diagnosis             # coverage-vs-power decomposition
    npm run p85:contaminant-fit                # this paper's report
    node --import tsx --test tests/scaled-reproducibility.test.ts

Measure-only: safeToGate false, discoveryClaim false. Full data: reports/p85-contaminant-fit.{md,json},
reports/p84-centroid-diagnosis.{md,json}, tests/fixtures/scaled/.
