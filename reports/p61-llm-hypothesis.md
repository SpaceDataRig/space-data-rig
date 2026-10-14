# P61 an LLM-chosen test, scored as a 2x2 on ground-truth classes (closed loop @ scale)

Reproduce: `npm run p61:llm-hypothesis -- --pos 24 --neg 24 --deep --no-llm`  (models: none -> deterministic 2x2)

Both classes come from ONE token-free public source (the ExoFOP TOI table): **24 confirmed planets (positives)**
and **18 FP/EB dispositions (labelled blends)**. Each menu test is run on real photometry and scored as a
full 2x2 via `src/candidate/vetoAcceptance` (catch-rate on blends, false-veto on known planets, acceptVetoTool).
Pixel (PSF double-difference) and Gaia-dilution tests are ACTIVE (--deep).

| test | catch-rate on labelled blends | 95% Wilson CI | false-veto on known planets | safe to gate? |
|---|---|---|---|---|
| bls-snr | 0% | [0, 18] | 0% | false |
| odd-even-depth | 44% | [25, 66] | 21% | false |
| secondary-eclipse | 28% | [12, 51] | 4% | false |
| shape-coherence | 0% | [0, 18] | 4% | false |
| psf-localize | 11% | [3, 33] | 4% | false |
| gaia-dilution | 50% | [29, 71] | 46% | false |

LLM layer OFF -- this is the deterministic per-test 2x2.

Gateable via the loop: NONE. No test met the zero-false-veto + power-above-chance bar, so none is gate-worthy here -- every one is a diagnostic score only.

An LLM idea becomes a result only when the deterministic measurement agrees; a TEST becomes gate-worthy only when
its 2x2 shows zero false-vetoes AND real power. Nothing is wired into a verdict / bundle / money path (safeToGate
false, discoveryClaim false).
