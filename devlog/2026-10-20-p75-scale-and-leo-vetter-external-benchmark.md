# Dispatch + live evidence for the P75-scale / LEO-Vetter milestone post

## The post
- Composed: the sample-size and external-reference milestone -- the production AR(1) significance gate measured at N=200 real planet-free TESS curves (148/200 = 74% empirical false-alarm vs 64/200 = 32% model-free), and the field's published vetter LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280) now run on our byte-identical committed fixtures (planet-candidate completeness 0.75 -> 0.92 over a 1000 -> 4000 ppm grid; equal-brightness EB false-positive flag 11/12).
- Guard: local `npm run x:post -- --text-file out/_tw_en.txt --max-len 25000` printed the text and exited 0 (ASCII + length + over-claim all pass; same code the workflow uses). length=950/25000.
- Dispatch: `POST .../workflows/x-post.yml/dispatches` ref=main, inputs.text=<these bytes>, inputs.maxlen=25000 -> dispatch accepted: HTTP `204`.
- Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39360310230 (event=workflow_dispatch) -> `completed / success`, job `digest` (118424713582) success.
- Job log send line: `x:post: OK posted (id 2112373776113340495).`
- posted id: `2112373776113340495`.
- Feed link: https://x.com/i/web/status/2112373776113340495

## The shipped work this post reports (all committed, CI-green, deployed, live-verified)
- 48eda35: add inverted-fp-scale.yml -- a dispatch-only CI job that runs the seeded P75 inverted-curve script at targets=200 where MAST/archive/S3 are reachable (the laptop sandbox could not resolve coordinate->sector, so the scale run had to move to CI rather than stay at n=16 or be fabricated).
- 4541121 (bot, run 39352387266): publish the CI-measured P75 report at N=200 -- AR(1) 148/200 = 74%, model-free block 64/200 = 32%, 86 flips, mean FAP delta 0.187, verdict GATE-OPTIMISTIC-ON-REAL-NOISE, discoveryClaim false (the n=16 75%/31% result reproduced at 12x sample size).
- 55dec68: propagate the scaled numbers into the public surface -- web/inverted-fp-figure.svg, web/research.json (P38 invertedFapP75 block), served report fragments.
- ae154a6: add the dedicated leo-vetter.yml job -- decouple the external-vetter arm from the ~40-75 min cross_pipeline detection arm that had twice consumed the whole job timeout before the benchmark could execute.
- f89e624 (bot, run 39358761689): publish the measured LEO-Vetter benchmark-vs-field report -- import OK v1.2.0, the numbers above, research only.
- b367e09: RESEARCH.md section 4c and section 33 corrected so the public gap statement matches the now-measured benchmark (DAVE/TAP-TPM/Drisser and survey-scale remain the open gaps).

## Deploy verification
- `npm run cf:deploy:sha` -> version c2aabf9c-a36d-4523-81ff-07c15b6a1c9e, DEPLOY_EXIT=0, safe window (activeRun.running false before deploy).
- https://spacedatarig.app/health -> gitSha b367e09 (== HEAD at deploy), version c2aabf9c.
- Live verified with cache-busting: /research.json generatedAt 2026-10-20 carrying invertedFapP75 ar1Fp 148 / blockFp 64 / n 200 / verdict GATE-OPTIMISTIC-ON-REAL-NOISE.
- Full offline gate on the landing HEAD: typecheck:all 0, npm test 840/840, staged non-ASCII 0, secret patterns 0.

## Text as pushed

```
Quantifying a pipeline's limits, now at sample size and against the field's own reference vetter.

On 200 real planet-free TESS light curves (curve inverted, catalogued transits masked, so only pure noise remains), the production AR(1) significance gate signs off 148/200 = 74% of noise bumps as significant at FAP<0.05, versus 64/200 = 32% for a model-free block bootstrap on the same dips (nominal bar is 5%). Measured only; the gate threshold is unchanged.

Separately, the field's published vetter LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280) now runs on our byte-identical committed fixtures: planet-candidate completeness 0.75 -> 0.92 across a 1000 -> 4000 ppm depth grid, and an equal-brightness eclipsing-binary false-positive flag rate of 11/12.

Every number here is CI-measured, recomputable from committed data, and research-only.
Repo: https://github.com/SpaceDataRig/space-data-rig
Live surface: https://spacedatarig.app/research.json
```
