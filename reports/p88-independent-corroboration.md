# P88 first true-veto 2x2 from an INDEPENDENT instrument (Gaia RV / astrometry)

Reproduce: `npm run p88:independent-corroboration -- --pos 8 --neg 10 --tmag 12`

Gaia (a different satellite) is asked, for 7 confirmed planets (must keep) and 10 labelled FP/EB blends (should veto): does its two-body orbit / RV series independently corroborate a stellar-mass companion on the candidate's period?

Independent Gaia data present for **6/17** hosts; an orbit on the candidate period for **0**.

| | labelled blend (should veto) | labelled planet (must keep) |
|---|---|---|
| Gaia corroborates an EB | 0 | 0 |
| Gaia does not | 10 | 7 |

- veto power (blends Gaia corroborates): 0.00 [0,0.2775401687666166] (LOWER bound -- most hosts have no Gaia orbit)
- false-veto (real planets Gaia brands an EB): 0 of 7 (0.000) -- any > 0 disqualifies
- AUC (orbit RV semi-amplitude, period-matched cases): n/a

**VERDICT: safeToGate = false.** zero false vetoes but veto power 0.00 (95% low 0.00) is below target 0.5 / not above chance 0.5 -- safe but under-powered

Independent-instrument corroboration is a genuine second opinion (not TESS re-reading its own pixels);
but at this coverage it can only EXCLUDE blends it has an orbit for, so its catch-rate is a lower bound and a
single false veto on a known planet keeps it out of the money/verdict path. research-only; discoveryClaim false;
nothing here is anchored, gated, or deployed.
