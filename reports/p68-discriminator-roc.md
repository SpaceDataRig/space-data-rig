# P68 discriminator ROC: does ANY threshold reject blends without killing known planets?

Reproduce: `npm run p68:discriminator-roc`

P61 collapsed each vetting tool to a binary at one hard-coded cut. This study sweeps the FULL continuous
threshold for every discriminator on the committed P61 per-target metrics
(24 known planets + 18 labelled FP/EB blends, run --deep), giving a Mann-Whitney AUC and the best
blend catch-rate subject to a zero / 5% / 10% known-planet false-kill budget. A tool is gate-worthy only
if some cut catches blends above chance while killing ZERO known planets.

| discriminator | blends | planets | AUC | best catch @ 0% kill | best catch @ <=5% kill | gate-worthy |
|---|---|---|---|---|---|---|
| odd-even-depth | 17 | 20 | 0.65 | 6% (1/17) | 18% | false |
| secondary-eclipse | 17 | 24 | 0.62 | 6% (1/17) | 35% | false |
| shape-coherence | 16 | 21 | 0.69 | n/a | 0% | false |
| gaia-dilution | 9 | 11 | 0.47 | n/a | n/a | false |
| psf-localize | 5 | 9 | 0.67 | 20% (1/5) | 20% | false |

Best separator: shape-coherence (AUC 0.69). Gateable via any threshold: NONE.

**VERDICT: NO-GATE-CONFIRMED: no continuous discriminator clears the blends-from-planets corner (best AUC 0.69 on shape-coherence); at every threshold that catches blends above chance it false-kills known planets -- the light-curve/pixel tools CANNOT self-validate candidates, only rank them.**

Offline re-derivation of already-published continuous metrics; discovery claims stay structurally false;
nothing here is gated, anchored, or deployed.
