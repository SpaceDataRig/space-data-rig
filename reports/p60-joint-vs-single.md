# P60 joint multi-sector search vs the single-sector path: a head-to-head re-find test

Reproduce: `npm run p60:joint-vs-single -- --targets 20 --maxsectors 4 --tmag 11 --minsnr 7 --tol 5`
On **20** confirmed planets that have >= 2 usable real TESS-SPOC sectors, both arms run the same
production-like detector (BLS + SNR>=7 + period within 5% of catalog truth): the SINGLE arm
takes the best independent sector, the JOINT arm folds the stitched long baseline. Positive control on
known planets -- this measures whether the joint upgrade actually re-finds more, the prerequisite to
ever leaning on it for novel targets.

| arm | re-find | 95% Wilson CI | mean SNR |
|---|---|---|---|
| single-sector (best) | 6/20 = 30.0% | [15, 52] | 23.0 |
| joint (stitched) | 6/20 = 30.0% | [15, 52] | 19.6 |

Joint corroborated (re-find + >=2 sectors confirm at the joint ephemeris): 4/20.
Lift JOINT - SINGLE = +0.0 pp; joint-only re-finds 1, single-only 1.

**VERDICT: NO-JOINT-ADVANTAGE.** The joint path does not clearly beat the single path on this sample; there is NO justification to lean on it for a discovery claim.

Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.
