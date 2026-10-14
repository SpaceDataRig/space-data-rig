# P49 formal blind test of the detector on real photometry

Reproduce: `npm run p49:blind-test -- --stars 30 --maxsectors 2 --inject-frac 0.5 --seed 7`

A seeded coin planted one synthetic planet (random period/depth from a documented prior, logged in a
sealed answer key the detector never saw) on some real TESS-SPOC curves and left the rest null; the
production gated detector then ran on every curve and its detections were scored against the key.

**30 curves** (13 injected, 17 null), **30 gated detections**

| metric | value |
|---|---|
| TP / FP / FN / TN | 10 / 20 / 3 / 8 |
| recall (planted recovered) | 76.9% [49.7%, 91.8%] |
| precision (detections real) | 33.3% [19.2%, 51.2%] |
| FP rate per null curve | 0.76 |
| accepted under a 2-sector bar | 0 |
| false-accepts under a 2-sector bar | 0 |

Honest reading: precision is a LOWER bound (a detection that is the host's own real-but-uncatalogued
planet counts as FP). The decisive safety number is false-accepts: on our single stitched baseline every
detection has corroboratedSectors=1, so under a 2-sector corroboration bar 0 are accepted and
0 are false-accepts -- the pipeline refuses to auto-accept any single-sector signal, which
is exactly why it makes no discovery claim. Positive control only; nothing gated, anchored, claimed, or
deployed. `discoveryClaim: false`.
