# Dispatch + live evidence for this milestone post

## The post
- Composed: authority-roadmap milestone covering P92-P96 (statistical-validation build).
- Guard: local `npm run x:post -- --text-file out/_tw_en.txt --max-len 25000` printed DRY RUN, exit 0 (ASCII + length + over-claim all pass; same code the workflow uses). length=1861/25000.
- Dispatch: `POST .../workflows/x-post.yml/dispatches` ref=main, inputs.text=<these bytes>, inputs.maxlen=25000 -> HTTP 204 (accepted).
- Workflow run: 39215259577 (event=workflow_dispatch) -> completed/success; job 117937509927 (digest).
- Job log send line: `x:post: OK posted (id 2112081282067018229).`
- Posted tweet id: 2112081282067018229.
- Feed link: https://x.com/i/web/status/2112081282067018229

## The shipped work this post reports (all committed, CI-green, deployed)
- P92 scrambled false-alarm null + joint C/R gate: commit 801472f (CI run 39204696920 success).
- P93 labelled false-positive taxonomy + flux-validation ROC: commit 20f1aea.
- P94 / P1 LEO-Vetter benchmark harness + real committed stellar params: commit b1de5a5 (main CI run 39209483848 success; crosscheck run 39209483887).
- P95 bounded unified catalogue + known-planet recovery + operating point: commit b60d6c1.
- P96 occurrence-rate kernel + real selection integral S=0.0995: commit 422e58e.

## Deploy verification
- `npm run cf:deploy:sha` -> version ccd7bb78-19e9-4096-8bfb-fea483c3611e, DEPLOY_EXIT=0.
- https://spacedatarig.app/health -> ok=true, gitSha=422e58e067629472d8288a9d1be2b5160e5d2d1a (== local HEAD).
- Live report pages verified 200: /reports/p92-scrambled-fa.html, /reports/p93-fp-taxonomy.html, /reports/p95-unified-catalog.html, /reports/p96-occurrence-kernel.html.

## Honesty
- Research-only milestone; no planet is claimed. Every gate stays off the verdict / bundle-hash / money path.
- The external LEO-Vetter RESULT numbers were NOT published at post time (the CI benchmark run was still executing), so the post cites only the harness landing + committed measurements, and quotes no un-published external figure.

## Text as pushed

```
Space Data Rig update: the rig carries the statistical-validation machinery that real exoplanet vetting uses, measured on real TESS-SPOC photometry, research-only and claiming no world.

What landed, each a committed and reproducible measurement:

A labelled false-positive taxonomy generator plus a flux-validation posterior (p93): a clean injected planet validated 48 of 48; the eclipsing-binary family rejected by its secondary 191 of 192; blended planets correctly left flux-degenerate, a limit only pixels can break.

A candidate-level scrambled false-alarm null scored with the completeness/reliability objective sqrt((1-C)^2+(1-R_FA)^2) (p92): joint optimum at BLS SNR>=22 with completeness 88.0% and false-alarm reliability 78.6% over 10 real curves.

A bounded unified catalogue (p95): 12 real hosts carrying NASA-archive stellar parameters, blind recovery of their own known planets 8 of 12, and the same joint objective minimized at BLS SNR>=15 (completeness 98.3%, reliability 89.4%). The 8-of-12 is reported as measured, not smoothed: a single blind peak on multi-planet hosts lands on one companion, unlike a mature multi-year vetter.

An occurrence-rate kernel and a measured selection integral (p96): S=0.0995 over periods 1 to 9.5 days, plus a forward-model consistency check against the published 1.10 +- 0.16 planets-per-star rate that flags the sample bias rather than hiding it. No inverted rate is claimed.

The field's own vetter, LEO-Vetter (Kunimoto and others 2025), is wired into CI against the same fixtures, and real stellar parameters are committed for every test host, closing the gap where our vetting had only ever been scored against our own re-implementations.

Every gate stays research-only: nothing here feeds the verdict, the bundle hash, or any on-chain path. Measurements and their basis, nothing more.

spacedatarig.app
```
