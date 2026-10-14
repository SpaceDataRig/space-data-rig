# P48 novelty disposition of the candidate board vs the NASA Exoplanet Archive

Reproduce: `npm run p48:novelty-check` (reads `web/candidates.json`; queries the Archive `toi` + `pscomppars` tables).

For each live board candidate we ask a narrow, checkable question: has anyone ALREADY announced a transit
signal at or near this position (within 30"), and does any announcement share our period?
A control query against a known TOI field runs first; only if it returns do we trust any 0-hit.

| TIC | our P (d) | depth (ppm) | corrob. sectors | shared-eph hosts | announced nearby? | same period? |
|---|---|---|---|---|---|---|
| 43450939 | 8.424 | 4298 | 1 | 1 | NO | no |
| 139068135 | 4.795 | 9499 | 1 | 1 | NO | no |
| 316781499 | 0.608 | 2415 | 1 | 1 | NO | no |
| 43450945 | 0.779 | 5380 | 1 | 1 | NO | no |
| 316781502 | 2.410 | 1965 | 1 | 1 | NO | no |

**5/5** candidates sit at a location with no announcement in these catalogs, and
**0/5** match an already-announced period.

Honest reading (this is the whole point): `novelLocation` is a statement about the CATALOGS, not about nature.
Every one of these is deep (EB/blend-like ppm), single-sector (corroboratedSectors=1), and the board reports
corroboratedHosts=0 overall -- the TESS pipeline itself flagged NO TOI within 30" of any of them,
which is evidence AGAINST a credible planet here, not for an undiscovered one. (The board separately collapsed
2 multi-host systematic groups BEFORE emitting these 5, so these are survivors -- but survivors of a blind
single-sector search at these depths are still dominated by false positives per our own purity measurements,
and none of our vetting gates (P44/P45/P46) is safe to clear an individual candidate.) We therefore report
ZERO credible novel planet candidates. This check does NOT cover ExoFOP-TESS or the peer-reviewed literature.
Research-only; nothing gated, anchored, claimed, or deployed. `discoveryClaim: false`.
