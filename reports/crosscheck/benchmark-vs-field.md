# Benchmark vs the field: LEO-Vetter on the committed real-curve fixtures

External tool: LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280), import OK v1.2.0
Stellar parameters: NASA Exoplanet Archive pscomppars TAP (https://exoplanetarchive.ipac.caltech.edu/TAP/sync) (committed by scripts/p94-stellar-params.ts).
flux_err: per-curve constant = 1.4826*MAD of the wotan-detrended flux (fixtures keep only time+flux); this only scales MES, not the shape tests.

## Injected planets -> LEO-Vetter Planet-Candidate completeness (3.0 d batman transit)

| depth (ppm) | PC / injected | completeness |
|---|---|---|
| 1000 | 9/12 | 0.75 |
| 2000 | 10/12 | 0.833 |
| 4000 | 11/12 | 0.917 |
| 8000 | 10/12 | 0.833 |

## Injected equal-brightness eclipsing binaries -> LEO-Vetter false-positive flag

- FP-flagged: 11/12 (rate 0.917)

Side-by-side reading (our OWN pipeline on the same kind of real data): p92 measures injected-planet
completeness vs the BLS-SNR joint objective, and p93 reports the flux-posterior rejection of the
eclipsing-binary family. This file is the FIELD reference numbers on byte-identical fixtures; the
comparison is descriptive, nothing here gates or claims. discoveryClaim false.

