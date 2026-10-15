# P80 external-candidate independent validation (audit finding 9, gap 3)

Reproduce: `npm run p80:external-validation -- --kp 10 --cp 10 --sectors 4 --min-depth 3000 --tol 0.02 --min-corr 2`

Closes the structural gap behind the old 0/2: P65 audits an outside claim while running the detector
blind on an empty catalog, so it can never self-corroborate. Here we build an INDEPENDENT validation
path: the detector never sees the claim's ephemeris, searches 1-13 d blind SECTOR BY SECTOR on the claim's
own real SPOC sectors, corroborates a period across independent sectors, and confirms an ExoFOP claim only
when that blind detection matches its period. KP rows are positive controls; CP rows are still-uncertain
EXTERNAL candidates -- a genuine validation attempt, not a self-check.

| disposition | tested | independently validated |
|---|---|---|
| KP (confirmed-planet control) | 11 | 9 |
| CP (candidate, uncertain external) | 9 | 5 |

| host (TIC) | TOI | disp | claim P (d) | sectors | maxCorr | recovered P (d) | off % | validated |
|---|---|---|---|---|---|---|---|---|
| 256364928 | 4470.01 | KP | 2.21857 | 2 | 2 | 2.21857 | 0 | YES |
| 420814525 | 5972.01 | KP | 3.52475 | 0 | 0 | - | - | no |
| 286923464 | 1271.01 | KP | 6.13498 | 4 | 3 | 6.12912 | 0.096 | YES |
| 69679391 | 1151.01 | KP | 3.4741 | 4 | 4 | 3.47488 | 0.022 | YES |
| 255930614 | 2024.01 | KP | 2.87588 | 4 | 4 | 2.87607 | 0.007 | YES |
| 349827430 | 1148.01 | KP | 5.55149 | 4 | 2 | 5.55629 | 0.086 | YES |
| 371443216 | 1924.01 | KP | 2.82407 | 4 | 4 | 2.82412 | 0.002 | YES |
| 354619337 | 5821.01 | KP | 2.14251 | 1 | 1 | - | - | no |
| 367366318 | 1682.01 | KP | 2.73477 | 4 | 4 | 2.73435 | 0.015 | YES |
| 97735908 | 4612.01 | KP | 4.11379 | 4 | 4 | 4.11343 | 0.009 | YES |
| 375506058 | 1431.01 | CP | 2.65023 | 4 | 4 | 2.65051 | 0.01 | YES |
| 290131778 | 123.01 | CP | 3.30889 | 3 | 3 | 3.30897 | 0.002 | YES |
| 283621618 | 5806.01 | CP | 3.18565 | 1 | 1 | - | - | no |
| 164173105 | 1417.01 | CP | 3.07264 | 2 | 0 | - | - | no |
| 83092282 | 622.01 | CP | 6.40253 | 4 | 3 | 6.40425 | 0.027 | YES |
| 372264750 | 1355.01 | CP | 2.17027 | 4 | 4 | 2.17167 | 0.065 | YES |
| 335630746 | 778.01 | CP | 4.63362 | 3 | 3 | 4.63269 | 0.02 | YES |
| 408310006 | 576.01 | CP | 5.44354 | 3 | 2 | - | - | no |
| 395171208 | 1333.01 | CP | 4.72019 | 3 | 1 | - | - | no |
| 354469661 | 1580.01 | KP | 4.79477 | 2 | 2 | 4.79741 | 0.055 | YES |

**VERDICT: CAPABILITY-DEMONSTRATED: blind, catalog-never-fed per-sector detection independently reproduced 5/9 still-uncertain CP candidates (and 9/11 KP controls). First independent external validations for this project -- a first CHECK supporting a candidate, not a discovery nor TRICERATOPS-grade validation. safeToGate stays false.**

Residual alias risk: period-only corroboration admits aliases (P78: 2-sector accepted precision ~47%), so a
CP 'confirmation' is a first independent CHECK, not a discovery nor a TRICERATOPS-grade validation. Measures
only; gates nothing, anchors nothing, claims nothing. discoveryClaim false, safeToGate false.
