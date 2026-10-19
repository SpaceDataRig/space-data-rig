# P93 flux-level false-positive taxonomy validation ROC

Reproduce: `npm run p93:fp-taxonomy -- --perClassTrials 4 --prior 0.5 --minSnr 7`

RAVEN / TRICERATOPS / LEO-Vetter validate by collapsing discriminants into a single planet posterior cut at
> 0.99. The rig now has a labelled FP generator (falsePositiveTaxonomy.ts) and a combiner (validationPosterior.ts).
On **12 committed byte-exact real SPOC fixtures** we inject the labelled FP family, run the repo's own
secondary-eclipse and odd/even discriminants at the injected ephemeris, and tally the posterior decision per
class. This is the FLUX-ONLY arm: blend FPP and pixel centroid are deliberately off.

| class | n | validated | uncertain | rejected | mean secondary/primary |
|---|---|---|---|---|---|
| planet | 48 | 48 | 0 | 0 | 0.00 |
| EB | 48 | 0 | 0 | 48 | 0.60 |
| HEB | 48 | 0 | 1 | 47 | 0.50 |
| BEB | 48 | 0 | 0 | 48 | 0.70 |
| NEB | 48 | 0 | 0 | 48 | 0.65 |
| HTP | 48 | 48 | 0 | 0 | 0.00 |
| NTP | 48 | 48 | 0 | 0 | 0.00 |

**Positive control (planet) kept:** 48/48 | **EB-family rejected via its secondary:** 191/192 | **Blended planets (HTP/NTP) mis-validated (flux-degenerate):** 96/96.

**VERDICT: FLUX-POSTERIOR-PARTIAL: the combiner keeps a true planet (validated 48/48) and rejects the eclipsing-binary family via its secondary (rejected 191/192), but leaves blended PLANETS (HTP/NTP) mis-validated (96/96) -- exactly the flux degeneracy that only pixel/centroid vetting can break, and which P53/P58/P89 measure as not yet safe to gate. A flux posterior is a real but PARTIAL vetting step; it is not, and cannot be, a complete FP solution.**

Conditioned on the correct ephemeris so it measures FP-discrimination, not detection/alias error. Nothing is
wired into the critic or the money path; discoveryClaim and safeToGate stay false.
