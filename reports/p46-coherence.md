# P46 multi-year O-C coherence characterised on real known planets

Reproduce: `npm run p46:coherence -- --hosts 6 --maxsectors 3 --tmag 11`
Data: real TESS-SPOC multi-sector stitched light curves of confirmed planets. Module: `src/detect/multiYearCoherence.ts`.
OFFLINE REPLAY: figures re-DERIVED from `reports/fixtures/p46-frozen-rows.json` (a committed snapshot of the live measurements, taken 2026-10-14T02:14:45Z); `--live` re-measures.

Measured on **6** host systems with >=2 usable sectors:

- **(a) positive control (mixed):** a known planet's TRUE period scores coherence median **0.74**, but only 3/6 clear 0.5. It recognises clean, isolated signals yet collapses on multi-planet systems where the stitched curve mixes several orbits (e.g. HD 63433 true period scores 0.14).
- **(b) selection (no gain):** the raw stitched-BLS peak matched a known planet of the host 4/6; ranking method candidates (peak, half, double, alias-resolved) by coherence matched only 3/6 -- coherence did NOT beat the raw peak, because it promotes harmonic aliases (raw/2 or 2x) to top coherence, exactly the limitation the module states.

**VERDICT: P46-COHERENCE-NO-SELECTION-GAIN.**

Honest reading: O-C coherence is a valid Keplerian-consistency test on a CLEAN single signal, but on real
multi-sector data it neither reliably recognises every true planet (multi-planet contamination) nor fixes
the p29/p30 period-selection bottleneck -- a harmonic alias and a *different real planet* are both linear in
O-C, so coherence ranks them high too. The lever for multi-planet systems is iterative multi-signal
extraction (src/detect/iterative.ts), which coherence can then confirm signal-by-signal; using coherence as
a standalone period-selector is not supported. Research-only; not gated, anchored, claimed, or deployed.
`safeToGate: false`.
