# P84 centroid per-contaminant F-test diagnosis (audit-10 #4: chase the 2/6, don't add a lever)

Reproduce: `npm run p84:centroid-diagnosis -- --alpha 0.001` (reads the P82 centroid checkpoint; run `npm run p82:scaled -- --probe centroid` first).

Provenance: this diagnosis is re-derived on every run from the checkpoint's content-addressed sha256 (see meta),
so it always matches the current P82 sweep -- here, the corrected host coordinates after the ExoFOP RA-unit fix.

The scaled centroid result (P82) was asymmetric: known planets false-reject 2/55, but labelled blends caught
0/59. This splits the WHY into (A) COVERAGE -- did the target-pixel-cube even yield >=2 localisable sector
offsets? -- and (B) POWER -- among the localisable ones, does the F-test align the offset cloud with the target
or with any Gaia-viable contaminant? High pTarget AND high bestNeighbourP on REAL blends means the offsets
match neither, which points at our pixel baseline (WCS / centroid precision / sector alignment), not the test.

### Known planets (positive control)

- rows 108; localisable (>=2 sector offsets) 55 (51%); NOT localisable 53 (nUsed 0: 29 = 27% coverage loss)
- among localisable: median viable neighbours 2; median pTarget 0.511; median bestNeighbourP 0.0045
- caught 0; false-reject 2; pTarget<alpha 2; bestNeighbourP<alpha 22

### Labelled blends (the catch target)

- rows 392; localisable (>=2 sector offsets) 59 (15%); NOT localisable 333 (nUsed 0: 276 = 70% coverage loss)
- among localisable: median viable neighbours 8; median pTarget 0.505; median bestNeighbourP 0.0611
- caught 0; false-reject 0; pTarget<alpha 0; bestNeighbourP<alpha 10

**VERDICT: PIXEL-BASELINE-BOUND: real blends fail two ways at once -- (A) 70% of blend targets never yield >=2 localisable sector offsets (target-pixel-cube coverage collapse), and (B) among the 59 measurable blends the F-test catches 0 because the offset cloud matches NEITHER the target (median pTarget 0.505) NOR any viable contaminant (median bestNeighbourP 0.0611), both far above alpha 0.001. Meanwhile known planets false-reject only 2/55. The F-test statistic is fine; OUR per-sector centroid localisation (WCS / centroid precision / sector alignment) is too noisy/biased to move a real blend off-target -- the audit's suspected branch. Fixing the pixel baseline has chain-wide payoff (P44/P53/P57/P59), not just this gate. Measures only.**

eumemic reference for context: 0/565 known planets wrongly rejected, 127/175 (73%) off-source blends caught
(38% within 15 arcsec). Our planet false-reject rate is compatible; our blend catch-rate is not, and this
diagnosis attributes it to the pixel-baseline/coverage path. Measures only; gates nothing; discoveryClaim false.
