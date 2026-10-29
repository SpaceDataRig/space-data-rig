# Devlog evidence header (three-research-axes milestone)

Milestone: three research axes (p97 de-blending, p98 red-noise systematics, p99 prospective held-out blind
validation) shipped to the live feed; verified report library grew 33 to 36.

Dispatch: workflow_dispatch on x-post.yml (ref main, inputs.text + maxlen 25000 short-circuit), accepted with HTTP `204`.

Pre-check: the local over-claim/ASCII/length guard ran first as `npm run x:post -- --text-file out/tweet-axes-milestone-en.txt
--max-len 25000` and printed DRY RUN (no local X credentials, nothing sent), length 1571/25000, no refusal.

Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40876068366 (conclusion success; job 123455082617 success).
Job log send line: `x:post: OK posted (id 2115787448047259935).`
posted id: `2115787448047259935`

Numbers cited are committed and freshness-gate machine-verified (independent recheck 36/36, findings=0; full suite
1035/0; CI https://github.com/SpaceDataRig/space-data-rig/actions/runs/40874290848 success). "verified" means the
provenance checksum re-hashes and matches on a clean checkout, not a scientific confirmation. No new planet claimed.

## Text as pushed

```
Three research axes shipped on the TESS transit rig, each a reproducible, freshness-verified report (script + JSON + markdown).

1) De-blending: on real light curves we subtract a nearby star's contaminating light using a Gaia brightness-weighted factor. A controlled depth-recovery sweep shows the correction flattens the dilution bias (spread ~98 ppm corrected vs ~908 ppm uncorrected) on injected planets.

2) Red noise: modeling each star's correlated noise with an AR(1) null, instead of a white-noise or resampling assumption, cuts the false-alarm rate on strongly red pools from ~30% to ~0% at matched recall, lifting per-candidate precision ~77% to ~100%.

3) Prospective blind test: split a sealed-label pool, tune one threshold on the training half only, then apply it once to a held-out 26% with zero re-tuning. The held-out result diverges from the tuned one (26 false-accepts past a 5% bar) -- plain evidence that scoring on the whole sample flattered our own numbers. Survivors cross-checked against a literature match and a Gaia neighbor test land at 11/66.

The verified report library grew 33 to 36; an independent freshness recheck reproduces 36/36 with zero findings; full test suite 1035/0.

Repo: https://github.com/SpaceDataRig/space-data-rig
Site: https://spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/commit/5ca88a7e0b739de0b98251239ca394feeb189ac6
https://github.com/SpaceDataRig/space-data-rig/commit/4462caf265e1640089f94c525d11f2580a539ec1
https://github.com/SpaceDataRig/space-data-rig/actions/runs/40874290848
```
