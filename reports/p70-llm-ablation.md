# P70 LLM ablation: does the model change a decision, and is it a good hypothesis generator?

Reproduce: `npm run p70:llm-ablation -- --pos 5 --neg 5`  (models: deepseek-chat, grok-4.7)

**(1) Structural ablation.** The per-test 2x2 and every gate flag come only from `runHypothesisTest` (real
photometry); a model prediction is never an input. We verify this by recomputing each decision after the
models run -- identical, `decisionsChangedByLLM = 0`. So the LLM's decision value is zero by construction.

**(2) Informational value.** Given (1), the model can only propose a test + prediction. Scored against the
measurement on 5 planets + 3 blends: 5/6 determinable proposals agreed, and models called a labelled BLEND "planet" on 3/3 (under-flagging), while the deterministic light-curve tests caught 1/3.

| light-curve test | catch (labelled blends) | false-veto (known planets) | safe to gate |
|---|---|---|---|
| bls-snr | 0% | 0% | false |
| odd-even-depth | 33% | 40% | false |
| secondary-eclipse | 33% | 20% | false |
| shape-coherence | 0% | 0% | false |
| multisector-phase | 0% | 0% | false |

**VERDICT: LLM-DECISION-VALUE-ZERO: no gate outcome depends on the model (verified by recompute); the models under-flagged 3/3 labelled blends while the deterministic tests caught 1/3. The model is a hypothesis BROKER, not an arbiter; it stays advisory.**

The model is an advisory hypothesis broker, not an arbiter; nothing is wired into a verdict / bundle /
money path (safeToGate false, discoveryClaim false).
