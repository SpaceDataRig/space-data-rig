# P50 end-to-end deterministic replay on real public bytes

Reproduce: `npm run p50:replay -- --repeats 3 --tmag 10 --sector 1`

We fetched the raw TESS-SPOC FITS bytes for one real target from the public S3 bucket, ran the full
detection chain (parse -> canonical data hash -> iterativeBls under the production gate -> recovered
candidate), and folded only the reproducible ingredients into a replay record (src/sim/replay.ts).

Target: **HD 39091** (TIC 261136679, sector 1), `mast/hlsp/tess-spoc/s0001/target/0000/0002/6113/6679/hlsp_tess-spoc_tess_phot_0000000261136679-s0001_tess_v1_lc.fits`, 164160 bytes.

| determinism check | result |
|---|---|
| replay hash | `98ea2ad067e5b1eb8e55da49ad109208f90acd2c12dd9e0e385dcd3ef4dc0e44` |
| 3 in-process runs identical | YES |
| re-download byte SHA-256 matches | YES |
| re-download replay hash matches | YES |
| independent recompute verifies | YES |

Recovered candidate: `{"periodDays":6.270623,"epochBjd":2458325.491626,"durationHours":2.267088,"depthFrac":0.00027452,"snr":24.481645,"verdict":"candidate"}`.

The detection chain is a pure function of its public inputs: the same S3 bytes produce the same replay hash every time, in-process and after a fresh download. An auditor with the S3 key and this record can recompute the exact number independently -- the basis for third-party verification.

Research-only audit artifact; no verdict/bundle-hash/money-path change; nothing anchored, claimed, or
deployed. `discoveryClaim: false`.
