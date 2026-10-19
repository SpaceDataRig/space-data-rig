# Dispatch + live evidence for the audit-response milestone post

## The post
- Composed: the external-audit response milestone (public surface refreshed to P82-P96, flagship reports made recomputable from committed bytes, withdrawn figure numbers purged and guarded, the P39 headline corrected, two short papers authored).
- Guard: local `npm run x:post -- --text-file out/_tw_en.txt --max-len 25000` printed DRY RUN, exit 0 (ASCII + length + over-claim all pass; same code the workflow uses). length=1703/25000.
- Dispatch: `POST .../workflows/x-post.yml/dispatches` ref=main, inputs.text=<these bytes>, inputs.maxlen=25000 -> dispatch accepted: HTTP `204`.
- Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39227462322 (event=workflow_dispatch) -> `completed / success`, job `digest` (117977140569) success.
- Job log send line: `x:post: OK posted (id 2112107937934020709).`
- posted id: `2112107937934020709`.
- Feed link: https://x.com/i/web/status/2112107937934020709

## The shipped work this post reports (all committed, CI-green, deployed, live-verified)
- fbe8dd1: p38 re-derives P82-P96 into web/research.json; RESEARCH.md P39 headline restated to N=200 61.0%->16.0% with the 3/17 (~18%) completeness cost; p82-scaled-digest commits the row-level checkpoints + per-row sha256 and repoints p82/p84/p85 to the tracked fixtures; tests/scaled-reproducibility.test.ts (3/3); p86 reports the flagship trio fully verified, 0 stale.
- 54f7d74: the audit10 / response / v011 / p82-results / close / deploy / p82-audit10 figures purged of withdrawn numbers and made report-driven; tests/figure-no-retracted.test.ts added; all figures regenerated.
- c81c89e: papers/P85-coverage-wall.md and papers/P90-depth-systematics.md.

## Deploy verification
- `npm run cf:deploy:sha` -> version 3ddbf2a3-eef1-4077-9bdf-7177e1622158, DEPLOY_EXIT=0.
- https://spacedatarig.app/health -> ok=true, gitSha=54f7d74 (== HEAD at deploy).
- Live verified with cache-busting: /research.json generatedAt 2026-10-19 carrying scaledValidationP82P91 + validationBuildP92P96; report pages p82/p84/p85 + p96 all 200; the v011 / response / p82-audit10 / deploy figures served 200 with zero withdrawn tokens and the corrected 2/55 / 0/59 values.

## Honesty
- Research-only milestone; every gate stays off the verdict / bundle-hash / money path.
- The P75 sample-size scale-up and the lightkurve/wotan benchmark arm were attempted but not completed: the NASA archive and SPOC fetch path was unreachable from this environment for the full session, so no scaled external number is quoted. The committed P75 result stays at its measured n=16 and the harness ships ready to re-run; nothing was fabricated to fill the gap.

## Text as pushed

```
Space Data Rig update: an external audit caught three ways the recent work was not reaching readers, and all three are now closed and live.

The public record had been frozen while the science kept moving. The dashboard bundle behind every cited number only ran to P81; it now re-derives P82 through P96 straight from the committed reports, so the homepage and the feed show the real current state.

The flagship scaled results could be checked on only one machine. The large-run checkpoints are now committed with a per-row sha256 digest, and a test re-derives the headline from those bytes on every run, so anyone can reproduce P82/P84/P85: blind recall 86.2% and accepted precision 42.2% over 425 real curves, external validation KP 186/234 and CP 103/179, the centroid F-test at 2/55 known-planet false rejects and 0/59 blends caught.

Withdrawn numbers were still printed on some figures after a right-ascension unit bug was fixed. Those posters are corrected to the re-run values and now read straight from the reports; a new guard test forbids any retired figure value from reappearing. The P39 headline is restated at its current scale: false positives fall 61.0% to 16.0% across 200 curves, and the interesting part is the price, only 3 of 17 injected planets survive at that cut.

Two short papers distill the hard ceilings into citable form: the coverage wall, why single-pixel TESS cannot resolve blends at any threshold, and the depth systematics, where both depth estimators under-read by the same sign and the honest error bar on a published depth is the 48% one-sigma radius rather than the 33% median.

Measurements and their basis, and now the bytes to reproduce them. spacedatarig.app
```
