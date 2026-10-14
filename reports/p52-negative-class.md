# P52 can we build a labelled NEGATIVE class from public data? (true-veto acceptance feasibility)

Reproduce: `npm run p52:negative-class -- --hosts 12 --cone-radius-arcsec 21 --list-rows 3000`

P51 measured the veto tools on crowded-field POSITIVES (confirmed planets). A reviewer's standard goes
further: to accept a veto you must also show it CATCHES real blends, which needs a labelled NEGATIVE class
-- real off-target eclipsing binaries at known positions. This script measures whether such a class is
constructible from token-free public sources, using the reusable access in `src/data/vizierEb.ts`.

| source / method | result |
|---|---|
| ExoFOP-TESS per-candidate dispositions | **NOT reachable** (REST 404 / token-gated) -- the authoritative blend/EB labels are behind access |
| VizieR GCVS list (positions + periods) | works: 9000 variables, 944 eclipsing binaries parsed |
| VizieR GCVS cone around 12 crowded hosts (21") | 0 real EBs landed in an aperture; 12/12 cones returned empty |
| client cross-match of the 944-EB list vs hosts | 0 within 21" |
| usable labelled negatives | **0** |
| true-veto trials on real blends | 0 |

Honest conclusion: a rigorous true-veto acceptance test is **NOT constructible from token-free public data in this pass**. The GCVS catalogue is bright-star-only and its anonymous cone endpoint returned empty even for guaranteed matches (a control on Algol), so real EBs essentially never fall inside a specific TESS ~21" host aperture; and the one source that DOES label per-candidate blends (ExoFOP-TESS) is token-gated. This is exactly the blocker the reviewer's standard runs into: without a labelled negative class we can measure a veto's over-kill but never its catch-rate. The veto tools therefore remain **un-acceptable** (not proven safe), `safeToGate: false`. The concrete unlock is an ExoFOP-TESS API token (or a dedicated blend/FP catalogue with TIC + offset), after which `src/data/vizierEb.ts` and this script extend to the full 2x2.

Research-only audit artifact; no verdict/bundle-hash/money-path change; nothing anchored, claimed, or
deployed. `discoveryClaim: false`.
