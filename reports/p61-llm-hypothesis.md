# P61 an LLM-proposed hypothesis, settled by a deterministic measurement (closed loop)

Reproduce: `npm run p61:llm-hypothesis`  (models: deepseek-chat, grok-4.7)

On **8** known planets with a strong pipeline detection, the rig does two things:
1. **Deterministic audit** -- run every vetting test on the real light curve (always available, reproducible):

| test | planet-consistent | blend-tagged | inconclusive/undetermined |
|---|---|---|---|
| bls-snr | 7/8 | 0 | 1 |
| odd-even-depth | 3/8 | 5 | 0 |
| secondary-eclipse | 8/8 | 0 | 0 |
| shape-coherence | 7/8 | 0 | 1 |

2. **The loop** -- each model proposes a falsifiable hypothesis and picks the decisive test; the rig measures it.
Valid proposals 11/16; a model's prediction MATCHED the measurement 3 time(s), diverged 8 time(s). Models chose: odd-even-depth x10, shape-coherence x1. Divergences are dominated by any test the positive-control flags as a known-planet false-reject -- so the loop is auditing the TEST, not proving the model wrong.

Positive control: odd-even-depth (5 blend-tagged on known planets) tagged a known planet as blend -- confirming these are DIAGNOSTIC scores, never a gate.

**Verdict LOOP-RAN.** An idea becomes a research result here only when a deterministic measurement agrees with it; even then it is a candidate clue, not a claim. Nothing is gated (safeToGate false), no verdict/bundle/money path is touched.
