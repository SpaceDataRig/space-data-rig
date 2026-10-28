# P45 false-positive probability characterised on confirmed planets

Reproduce: `npm run p45:fp-probability -- --targets 16 --tmag 10 --aperture 21`
Data: real Gaia DR3 neighbours of confirmed planets. Module: `src/candidate/falsePositiveProbability.ts`.
OFFLINE REPLAY: figures re-DERIVED from `reports/fixtures/p45-frozen-rows.json` (a committed snapshot of the live Gaia measurements, taken 2026-10-14T01:31:54Z); `--live` re-measures.
Every row here is a REAL planet, so the honest question is how often the blended-EB prior wrongly
elevates P(FP).

Characterised **16** confirmed planets:

| P(FP) | min | p50 | p90 | max |
|---|---|---|---|---|
| across real planets | 0.020 | 0.020 | 0.020 | 0.042 |

- **1/16** real planets have at least one Gaia neighbour that *could* be a diluted blend.
- **0/16** real planets were pushed above P(FP) > 0.5 by that neighbour + a literature EB prior.

Honest conclusion: P(FP) here is a **prior-dependent ranking / triage** quantity, NOT a validation and NOT
safe to gate. A neighbour existing does not mean it is an eclipsing binary; these uncrowded bright hosts do
not exercise the crowded-field regime where the blended-EB impostor actually bites, so the discriminating test
is on blind / crowded candidates (future work). A discovery-grade version needs a measured EB depth function
and resolved-photometry contrast limits, not order-of-magnitude priors. `safeToGate: false`, `discoveryClaim: false`.
