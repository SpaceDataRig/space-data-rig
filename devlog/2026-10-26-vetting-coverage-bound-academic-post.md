# Vetting-is-the-wall academic post (2026-10-26)

What was posted (verbatim below): the measured negative result that vetting, not detection, is the binding
constraint of this rig. Flux-only validation keeps true planets 48/48 and rejects the eclipsing-binary family
191/192 but mis-validates blended planets 96/96 (P93); the pixel-level per-contaminant centroid F-test is
coverage-bound (114/500 targets localisable, 0/59 labelled blends caught, 2/55 known-planet false rejects at
alpha 0.001; P84/P85); and the 425-curve blind run that frames it measures 86.2% recall with 42.2% accepted
precision (P82). Every cited figure is read from committed reports whose recorded input sha256 the freshness
gate re-hashes and reports as verified. This is a methodology result, not a planet claim.

## Dispatch evidence

- Preflight (local, same code path as CI): `npm run x:post -- --text-file out/push23.norm.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=3168/25000`, exit code 0,
  non-ASCII bytes 0 (out/guard23.log).
- Link check before dispatch (out/link23.log): the two freeze commits
  419b4219620420aa5c2410b33641148c6fe73c62 and b1fd7287306c2c9a59bb0fb3110da98f8a165b71 both answered HTTP 200
  via the authenticated API; the four cited report blobs exist at exactly those refs (HTTP 200, sizes
  2225/2383/1839/135133). The public github.com HTML pages were unreachable from this sandbox (connect timeout
  and ECONNRESET), so the authenticated API answers are the reachability evidence for those URLs; the live site
  answered 200 and its served reports index reports freshness verified=15, stale=[].
- Dispatch: POST /actions/workflows/x-post.yml/dispatches on ref=main with inputs.text = the bytes below and
  inputs.maxlen=25000 -> HTTP `204` ACCEPTED at 2026-10-26T08:32:13.880Z (request body 3237 bytes). Dispatched
  exactly once; no retry, no second dispatch.
- Actions run 40292935756 (event=workflow_dispatch) -> completed/success; job "digest" success; step "Compose
  every reportable item in the window and post each one" = success; the node_modules cache restored, so the
  Install step was skipped.
- Job log line: `x:post: OK posted (id 2114636247310139865).` -- posted id: `2114636247310139865`

## Proof links

- P82/P84/P85 frozen at: https://github.com/SpaceDataRig/space-data-rig/commit/419b4219620420aa5c2410b33641148c6fe73c62
- P93 frozen at: https://github.com/SpaceDataRig/space-data-rig/commit/b1fd7287306c2c9a59bb0fb3110da98f8a165b71
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/40292935756

## Illustration note

The accompanying figure (a FLUX ONLY panel and a PIXEL F-TEST coverage funnel over a real-shape transit light
curve, generated for this post) is delivered in the conversation only. It is NOT uploaded to X: the feed is
text-only by construction.

## Text as pushed

```
What our TESS rig holds that is worth an astronomer's attention is a measured negative result about vetting, not a planet.

Detection, for scale (P82: 425 real multi-sector SPOC curves, 181 injected and 244 null): recall 86.2% CI [80.4, 90.5], raw precision 14.4% CI [12.4, 16.6]. Under the two-sector corroboration bar the same run accepts 329 candidates, recovers 139/181 injections (76.8%) and carries 190 false accepts, so accepted precision is 42.2%. Precision is a lower bound: a genuine but uncatalogued transit sitting in a null curve is counted as a false accept. Corroboration is necessary; it is not sufficient.

Vetting in flux only (P93: 12 byte-exact real SPOC fixtures, a labelled false-positive family injected at 4 trials per class, posterior cut 0.99): true planets kept 48/48, the eclipsing-binary family rejected 191/192, blended planets mis-validated 96/96. A blended planet and a planet are degenerate in flux, so no flux-only posterior can separate them.

The pixel remedy, measured instead of assumed (P84/P85: per-contaminant centroid F-test, eumemic-style, 500 targets, alpha 0.001): only 114/500 targets (22.8%) ever yield two or more localisable sector offsets, and 70% of blend rows never localise at all (276/392). Among the 59 labelled blends that are measurable the test catches 0, while it false-rejects 2/55 known planets. Loosening to alpha 0.01 buys 1/59 blends and raises known-planet false rejects to 5/55. The offsets match neither the target (median pTarget 0.505) nor any viable neighbour (median bestNeighbourP 0.0611), both far above alpha, so the statistic behaves as calibrated and our per-sector centroid localisation (WCS, centroid precision, sector alignment) is what limits the power.

Context from a published reference we did not run (eumemic/exoplanets): 0/565 known planets wrongly rejected and 127/175 (73%) off-source blends caught. Our planet false-reject rate is compatible with that; our blend catch rate is not.

Honest scope: each figure is re-derived from a committed report whose recorded input sha256 the freshness gate re-hashes and reports as verified, and none of it is wired into a gate (safeToGate false throughout) or offered as a planet claim (discoveryClaim false). Hosts are bright catalogued planet-bearing stars, so these are detector and vetting efficiency on real photometry, not a survey selection function. P79 (the TCE/DAVE-style comparison harness) stays out of the cited set on purpose: its report names input paths but records no checksums, so the gate cannot re-hash it and the published library lists it as unattested.

Reports at the commits that froze them:
https://github.com/SpaceDataRig/space-data-rig/blob/419b4219620420aa5c2410b33641148c6fe73c62/reports/p82-scaled.json
https://github.com/SpaceDataRig/space-data-rig/blob/419b4219620420aa5c2410b33641148c6fe73c62/reports/p84-centroid-diagnosis.json
https://github.com/SpaceDataRig/space-data-rig/blob/419b4219620420aa5c2410b33641148c6fe73c62/reports/p85-contaminant-fit.json
https://github.com/SpaceDataRig/space-data-rig/blob/b1fd7287306c2c9a59bb0fb3110da98f8a165b71/reports/p93-fp-taxonomy.json
More: https://spacedatarig.app
```
