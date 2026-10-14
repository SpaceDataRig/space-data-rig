# P56 a real, per-target selection function (measured dilution + stellar parameters)

Reproduce: `npm run p56:real-selection -- --hosts 18 --tmag 11 --aperture 21`
Data: NASA Exoplanet Archive stellar radius/mass + Gaia DR3 aperture neighbours (both token-free),
combined with the committed P47 completeness grid via `src/sim/selectionFunction.ts`.

For **18** real hosts, at the reference period bin 1-2 d (observed 50%
depth 300 ppm):

| quantity | min | p50 | max |
|---|---|---|---|
| dilution factor | 0.996 | 1.000 | 1.000 |
| true-depth inflation (1/dilution) | 1.00x | 1.00x | 1.00x |
| geometric transit probability | 0.132 | 0.207 | 0.386 |

0/18 hosts have a measurable contaminant (dilution < 0.99). Even the most-inflated host
(TOI-2128, dilution 0.996) raises the true 50% depth only from 300 to 301 ppm --
negligible. The honest finding is that this BRIGHT confirmed-planet sample is dilution-clean (neighbour
counts reach into the teens but the companions are faint, so the flux-weighted dilution stays ~1); the
selection function here is dominated by the geometric transit probability (which spans
0.13-0.39 across real stellar radii/masses) and by completeness. The dilution
window would bite in crowded / faint fields, which the archive's confirmed sample under-represents.

**This is a measured selection function, not an occurrence rate.** P47 hosts are bright
planet-bearing stars (this is detector efficiency, not an unbiased survey selection), and there are
no detections to divide by. It is the honest denominator PRECURSOR for eta_earth; producing a rate
needs an unbiased target sample + a labelled negative class (P52). discoveryClaim: false.
