# P81 TRICERATOPS-grade upgrade of the P80 external-candidate validation (audit finding 9, gap 3)

Reproduce: `npm run p81:triceratops-lite -- --kp 10 --cp 10 --aperture 21 --centroid 1`

P80 confirmed external (ExoFOP) claims via a BLIND, non-circular per-sector corroboration match, but its
residual risks -- blends and period aliasing (P78: 2-sector precision ~47%) -- were only bounded statistically.
Here each already-validated candidate gets three discriminants from data the detector never saw: a real Gaia
neighbour census -> dilution + blend EB false-positive probability, harmonic-alias accounting, and the
multi-sector centroid F-test (faithful to eumemic) run on the pixel cubes at the recovered ephemeris.
Empirical false-coincidence base folded in from P78: 53%.

| host (TIC) | TOI | disp | P (d) | depth ppm | dilution | nNb | blend FPP | corrected depth | alias peaks | centroid on-target | alias risk | TRIC-grade |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256364928 | 4470.01 | KP | 2.21857 | 25854 | 1 | 0 | 0 | 25854 | 0 | yes | low | YES |
| 420814525 | 5972.01 | KP | 3.52475 | 17803 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 286923464 | 1271.01 | KP | 6.13498 | 3860 | 0.0009 | 4 | 0.000542 | 4389951 (!) | 0 | n/a | high | - |
| 69679391 | 1151.01 | KP | 3.4741 | 15748 | 1 | 0 | 0 | 15748 | 0 | yes | low | YES |
| 255930614 | 2024.01 | KP | 2.87588 | 3152 | 1 | 0 | 0 | 3152 | 0 | n/a | high | - |
| 349827430 | 1148.01 | KP | 5.55149 | 9493 | 0.7544 | 5 | 0.0254 | 12584 | 0 | n/a | high | - |
| 371443216 | 1924.01 | KP | 2.82407 | 8970 | 1 | 0 | 0 | 8970 | 0 | n/a | high | - |
| 354619337 | 5821.01 | KP | 2.14251 | 7961 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 367366318 | 1682.01 | KP | 2.73477 | 9209 | 0.0053 | 1 | 0.000278 | 1751435 (!) | 0 | yes | low | - |
| 97735908 | 4612.01 | KP | 4.11379 | 5739 | 1 | 0 | 0 | 5739 | 0 | n/a | high | - |
| 375506058 | 1431.01 | CP | 2.65023 | 6449 | 0.3146 | 4 | 0.00227 | 20497 | 0 | yes | moderate | - |
| 290131778 | 123.01 | CP | 3.30889 | 4736 | 1 | 0 | 0 | 4736 | 0 | n/a | high | - |
| 283621618 | 5806.01 | CP | 3.18565 | 4750 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 164173105 | 1417.01 | CP | 3.07264 | 10471 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 83092282 | 622.01 | CP | 6.40253 | 3815 | undetermined | 0 | undetermined | undetermined | 0 | n/a | high | - |
| 372264750 | 1355.01 | CP | 2.17027 | 5157 | 0.003 | 11 | 0.00274 | 1693869 (!) | 0 | yes | moderate | - |
| 335630746 | 778.01 | CP | 4.63362 | 7660 | 1 | 0 | 0 | 7660 | 0 | n/a | high | - |
| 408310006 | 576.01 | CP | 5.44354 | 3219 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 395171208 | 1333.01 | CP | 4.72019 | 6710 | undetermined | 0 | undetermined | undetermined | 0 | n/a | n/a | - |
| 354469661 | 1580.01 | KP | 4.79477 | 6864 | 0.006 | 5 | 0.00271 | 1134835 (!) | 0 | n/a | high | - |

**CP (uncertain external): 5 validated, 0 reach TRICERATOPS-grade (blendFPP<1e-3 + centroid not off-target + low alias, inconsistent depth excluded).**

**Blend census determined for 13/14 validated candidates; 1 undetermined (Gaia unavailable, shown as `undetermined` rather than `NaN`, and not counted in any rate).**
**Blend contradictions (4) -- the de-diluted depth exceeds the 10% physical cap, so the Gaia census and the observed depth are mutually inconsistent (an unresolved blend, NOT a clean planet). These are excluded from grading and reported as evidence:**
- host 286923464 (KP TOI 1271.01): observed 3860 ppm at dilution 0.0009 -> corrected 4389951 ppm = 439.0% of the star.
- host 367366318 (KP TOI 1682.01): observed 9209 ppm at dilution 0.0053 -> corrected 1751435 ppm = 175.1% of the star.
- host 372264750 (CP TOI 1355.01): observed 5157 ppm at dilution 0.003 -> corrected 1693869 ppm = 169.4% of the star.
- host 354469661 (KP TOI 1580.01): observed 6864 ppm at dilution 0.006 -> corrected 1134835 ppm = 113.5% of the star.


**VERDICT: GRADED: 14 blind validations carried forward; blend census DETERMINED for 13/14 (1 undetermined: Gaia unavailable). Among them 4 show a de-diluted depth over the 10% physical cap -- the census and the observed depth contradict each other, which is itself unresolved-blend evidence -- so they are EXCLUDED from grading. For the 5 still-uncertain EXTERNAL (CP) candidates, blend-FPP + harmonic-alias + multi-sector centroid F-test now quantify the residual risk P78 only bounded statistically; 0 reach TRICERATOPS-grade (and KP controls 2). First-order checks, NOT discoveries or full TRICERATOPS; safeToGate false.**

First-order, not full TRICERATOPS (no space-to-ground tables / limb darkening / radius posteriors); a low
alias-risk grade is a stronger CHECK supporting an external candidate, not a validated FPP or a discovery.
Measures only; gates nothing, anchors nothing. discoveryClaim false, safeToGate false.
