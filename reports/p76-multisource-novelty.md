# P76 multi-source novelty: does adding ExoFOP TOI/CTOI shrink P48's apparent novelty?

Reproduce: `npm run p76:multisource-novelty` (reads `web/candidates.json`; queries the Archive `toi`+`pscomppars`
AND the token-free ExoFOP-TESS public TOI/CTOI table).

P48 checked only two Archive tables and flagged that it missed ExoFOP/CTOIs. This adds the ExoFOP table --
which carries candidate TOIs and community FP/EB labels -- so a candidate is 'novel' only if NOTHING is
announced across all three. More catalogs can only make novelty harder; we measure exactly how much.

| TIC | our P (d) | depth (ppm) | corrob. sectors | novel (Archive only) | novel (Archive + ExoFOP) | ExoFOP FP/EB on host |
|---|---|---|---|---|---|---|
| 43450939 | 8.424 | 4298 | 1 | yes | yes | no |
| 139091019 | 10.131 | 62671 | 1 | yes | yes | no |
| 139068135 | 4.795 | 9499 | 1 | yes | yes | no |
| 316781502 | 2.410 | 1965 | 1 | yes | yes | no |

**Archive-only novel (P48): 4/4. After adding ExoFOP: 4/4 (shrink 0).**
ExoFOP FP/EB on the same host: 0/4.

**VERDICT: NO-EXTRA-SHRINK: the ExoFOP TOI/CTOI table announced none of the 4 Archive-novel candidates, so all 4/4 stay unannounced across Archive + ExoFOP -- but that is a statement about the catalogs, not a planet claim.**

Honest reading: `novel` is a statement about the CATALOGS, not nature. Every remaining candidate is deep and
single-sector with 0 corroborating hosts -- the TESS pipelines flagged NO credible transit there, which is
evidence AGAINST a planet, not for an undiscovered one. This covers Archive + ExoFOP; SPOC TCE and the
peer-reviewed literature are NOT covered. Research-only; nothing gated, anchored, claimed, or deployed.
`discoveryClaim: false`.
