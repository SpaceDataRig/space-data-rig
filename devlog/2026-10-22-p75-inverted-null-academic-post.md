# P75 single-shot academic post (2026-10-22)

What was posted (verbatim below): the inverted-null false-alarm result P75 -- the AR(1)-calibrated
significance gate false-alarms on 148/200 (74%) of planet-free null curves while a model-free
block-bootstrap reference false-alarms on 64/200 (32%), disagreeing on 86 curves. Cited numbers are read
from the committed, freshness-stamped report `reports/p75-inverted-fp.json` (gitSha
`c7f29b67369e53858761f4d0dff77a79eb338617`); this is a methodology result, not a planet discovery.

## Dispatch evidence

- Preflight (local, same code path as CI): `npm run x:post -- --text-file out/_p75_tweet_en.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=1045/25000`, English-only,
  over-claim guard passed.
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000` -> HTTP `204` ACCEPTED.
- Actions run **39713105905** (event=workflow_dispatch) -> `completed/success`.
- Job step "Compose every reportable item in the window and post each one" -> `success`.
- Job log line: `x:post: OK posted (id 2113101143656276029).` -- posted id: `2113101143656276029`

## Proof links

- measurement commit: https://github.com/SpaceDataRig/space-data-rig/commit/a0e25e3f2def8ffaccf9242621bf0eb2ae466fa1
- frozen + freshness-stamped commit: https://github.com/SpaceDataRig/space-data-rig/commit/c7f29b67369e53858761f4d0dff77a79eb338617
- CI run on current main: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39564279427
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/39713105905

## Note on an aborted probe

An earlier accidental `workflow_dispatch` with a placeholder string (run 39712786509) was CANCELLED before its
post step ran (that step shows `skipped`), so it posted nothing. The archive text below is the intended final post.

## Text as pushed

```
The result from our TESS rig I would cite as science, measured on public data: on 200 planet-free null light curves (real TESS-SPOC photometry reflected about its median, every catalogued planet masked with its exact ephemeris, single sector), the AR(1)-calibrated significance gate false-alarms on 148/200 (74%), while a model-free block-bootstrap reference false-alarms on 64/200 (32%); the two verdicts disagree on 86 curves. A "calibrated" noise gate can run far more optimistic than nominal under real correlated noise. Report with offline replay and input hashes: https://github.com/SpaceDataRig/space-data-rig/blob/main/reports/p75-inverted-fp.json - more at https://spacedatarig.app

Proof links:
measurement commit: https://github.com/SpaceDataRig/space-data-rig/commit/a0e25e3f2def8ffaccf9242621bf0eb2ae466fa1
frozen + freshness-stamped commit: https://github.com/SpaceDataRig/space-data-rig/commit/c7f29b67369e53858761f4d0dff77a79eb338617
CI run on current main: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39564279427
```
