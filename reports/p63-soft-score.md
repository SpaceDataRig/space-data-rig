# P63 soft blend-likelihood score (continuous, not a veto) and its published false-kill rate

Reproduce: `npm run p63:soft-score` (pure offline re-derivation from reports/p61-llm-hypothesis.json; adds
no new measurement). P57-P59 showed the pixel/dilution tools false-kill known planets, so they are turned
into a continuous 0..1 blend-likelihood (src/candidate/softScore.ts) that the critic may use ONLY as a
bounded ranking weight -- never a gate.

On **28** labelled targets (16 confirmed planets, 12 labelled blends) with a determined
continuous signal: mean blend-likelihood 0.39 (planets) vs 0.50 (blends).

| threshold | false-veto (known planets flagged) | blend catch [95% Wilson CI] |
|---|---|---|
| 0.25 | 11/16 = 69% | 9/12 = 75% [47, 91] |
| 0.40 | 9/16 = 56% | 9/12 = 75% [47, 91] |
| 0.50 | 8/16 = 50% | 9/12 = 75% [47, 91] |
| 0.60 | 2/16 = 13% | 5/12 = 42% [19, 68] |
| 0.75 | 2/16 = 13% | 4/12 = 33% [14, 61] |

**VERDICT: ADVISORY-ONLY: at threshold 0.5, the continuous blend-likelihood flags 50% of KNOWN planets (8/16) and catches 75% of labelled blends. A non-zero false-kill rate is exactly why this is a score, not a gate.**

The soft score is wired into the critic as an optional `blendScore` that can only downweight the ranking
score (never flip the verdict or reject), so the money path is untouched. safeToGate false, discoveryClaim
false; nothing here is gated, anchored, or deployed.
