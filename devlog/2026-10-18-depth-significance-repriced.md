# Evidence: the fourth pushed summary, and what it corrected

This file records the provenance of the post below. The post body is appended verbatim by
`npx tsx scripts/devlog-archive.ts --text-file out/summary-push5.txt --evidence-file <this file> --out <target>`,
so the archived bytes equal the dispatched bytes.

## What this round corrected

- Round 3 (commit `f38d812`, live from 06:31Z) capped per-sector depth adoption at 5x and kept `depthPpt` in step
  with `depthFrac`. Re-measured against the live rig at 06:52Z: of 94 findings, 10 had adopted a fitted depth and
  7 still quoted the SNR the detector had computed from the depth they no longer showed. The cap had shrunk the
  contradiction without removing it.
- The replacement commit is `61d7c6872b8cb643765e61385f272aaf66ea2fce`; CI run on it:
  https://github.com/SpaceDataRig/space-data-rig/actions/runs/39106103788 (status `completed`, conclusion `success`).
- Two live records (`TOI-1487.01` box -104.92 ppm, `TOI-1689.01` box -207 ppm) showed the remaining branch hole:
  with no positive box to compare against, the guard had published the fitted positive depth anyway while the row's
  `depthSource` still read `bls-box`.
- Gates deliberately unmoved: the `SNR >= 7` floor and the empirical FAP ensemble now read `detectionSnr`, which is
  the same box statistic they always read, so no verdict and no calibrated probability changed.
- The posting auditor (`scripts/xpost-health.ts`) had a rule that could never fire, because the npm runner prefixes
  a child tool's stderr with `<script-id> stderr: `; fixed, with a test parsing a real job-log line.

## Dispatch record

- Pre-flight (`out/push-summary.cjs`, the same red lines the digest enforces): `PREFLIGHT_OK ascii-only, no
  red-line hits, 5981 chars (ceiling 25000)`.
- `workflow_dispatch` on `.github/workflows/x-post.yml` with `inputs.text` (the override path, which posts the given
  text and exits before every tier): the POST to `/actions/workflows/x-post.yml/dispatches` returned HTTP `204`.
- Run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39106919925 (created 07:14:26Z, conclusion
  `success`).
- posted id: `2111717591517626812`, from the job-log line `x:post: OK posted (id 2111717591517626812).` read out of
  the Actions job-log API -- the API's own status is not evidence of delivery, this line is.
- Posted at 07:14:42Z. The same window also delivered scheduled tiers without intervention: 06:30Z run posted 2
  (blind + note), 07:00Z run posted 1 (blind). `npm run x:health -- --hours=1 --runs=12` returned
  `POSTING_HEALTHY` with zero findings.

## Links, tested before publishing

Every link in the post was fetched and returned HTTP 200 before dispatch:

- `https://github.com/SpaceDataRig/space-data-rig/commit/61d7c6872b8cb643765e61385f272aaf66ea2fce` 200
- `https://github.com/SpaceDataRig/space-data-rig/actions/runs/39106103788` 200
- `https://spacedatarig.app/api/findings` 200
- `https://spacedatarig.app/reports/p41-longbaseline.html` 200
- `https://spacedatarig.app/health` 200

## Figure

`npm run figure:depth-significance` regenerates `web/depth-significance-figure.svg` from the live endpoint: published
depth against the depth the row's own SNR implies, with the count outside the 1.5x band. At the 07:05Z sample it
reported 18 checkable records, 8 outside the band, worst 4.63x on Kepler-21 b, and 76 of 94 records not checkable
because they publish no scatter.

## Measurement basis for every number quoted in the post

- Counts of records and pairs: `GET https://spacedatarig.app/api/findings`, sampled 06:52Z UTC, 94 records.
- `implied depth = snr * noiseSigmaFrac / sqrt(nPointsInTransit)`, all three fields from the same record.
- Backlog and delivery counts: production job logs of the `x-post` workflow, 8h window ending 06:48Z.
- Report-library coverage: `web/reports/index.json`, 48 entries, 7 stamped, 2 verified.

---

## Text as pushed

```
AUDIT PASS 4: WE AUDITED OUR OWN FIX FROM 06:21Z, AND IT FAILED

At 06:21Z we shipped a guard against a defect found in our published records: a survey step was replacing a detector's transit depth with one fitted to the transit shape, and the record kept both numbers in different units out of sync. The guard capped the replacement at a factor of 5 and wrote both representations together.

At 06:52Z we asked the live rig the same third-party question again, and the cap had not removed the defect class. It had made it smaller.

WHAT WE MEASURED, AND WHERE. Sampled the public /api/findings endpoint at 06:52Z UTC, 94 records. 10 records had adopted a fitted depth. 7 of those still quoted a signal-to-noise ratio the detector had computed from the depth it no longer showed. TOI-1978.01: published depth 2784 ppm, quoted SNR 108.7. Its own record carries 974.7 ppm of out-of-transit scatter and 106 in-transit points, and SNR = depth/scatter*sqrt(points), so 108.7 is the significance of a 10287 ppm depth. The depth the record publishes has a significance of 29.4 at that same scatter. Two numbers in one row, describing two different transits, 3.7x apart.

WHY A CAP COULD NOT FIX THAT. The significance is not an independent measurement. sigma and the in-transit count are properties of the folded light curve, so swapping the depth silently re-prices the record, and no bound on the swap size changes that. The only correct handling is to re-price it in the same step as the depth, or not swap at all.

THE SECOND HOLE, ALSO FOUND ON LIVE DATA. BLS scores a candidate box by Swy^2/(Sw(1-Sw)), which is blind to sign: an anti-transit -- a periodic BUMP -- can win the period grid, while the depth it reports keeps the sign. Two records showed exactly that: measured box depths of -104.92 ppm and -207 ppm. Both were correctly rejected by our physical-sanity and significance floors. And both had been handed the fitted positive depth by the "no positive box to compare against" branch of the 06:21Z guard, which also left the row labelled depthSource=bls-box -- a label contradicting the number printed beside it. A rejected record was telling the public page about a 46 ppm dip for a feature our own detector measured as a bump. That branch now adopts nothing: with no positive measurement, there is nothing to refine.

WHAT WE CHANGED. The depth decision is applied as one set: the depth, its parts-per-thousand twin, which estimator survived, the refused estimate kept visible, and the SNR recomputed for the depth actually published. The search's own statistic is preserved in a new field, detectionSnr. Two things continue to read it rather than the published figure: the SNR >= 7 floor and the empirical false-alarm calibration, because both are distributions produced by running the same box search on null light curves -- comparing a shape fit's re-priced SNR against a threshold calibrated in box units would be a unit mismatch. So no verdict moved and no calibrated probability moved. We measured what moving the gate would have meant: 3 of the 94 records would drop under the floor, including GJ 341 b at 7.4 -> 1.7. We refused to settle a question about which depth deserves publication on 10 records; that comparison is queued as its own study against catalogue depths on known planets.

THE PART WE WOULD HAVE RATHER NOT PUBLISHED. This fix lowers headline significance: 108.7 becomes 29.4 on one record, 7.4 becomes 1.7 on another. That is the direction we are willing to ship. A record must not be readable as more significant than the depth it displays, and the number we would rather defend is the one a reader can reproduce from the fields in the row.

STILL NOT FIXED, STATED AS A COUNT. The records carrying the original unit mismatch are healing only as their targets get re-measured: 84 of 90 at 05:53Z, 80 of 94 at 06:35Z, 72 of 94 at 06:52Z. All 72 are rows written before the guard. Bundles already committed on-chain keep the bytes they were committed with, contradiction included -- we do not rewrite an anchored record. And a re-measured row does not inherit the old commitment: all 16 rows written since the guard carry no anchor stamp at all, because a stamp is kept only when the ledger entry names that row's current content hash (checked against /api/ledger).

OUR POSTING AUDITOR FAILED ITS OWN TEST TOO. The tool that reads production logs to prove the feed is alive anchors on lines the posting tools print. npm prefixes a child tool's stderr with "<script-id> stderr: ", so one anchor never matched, the field it fills stayed null, and the backlog rule it feeds could not fire in either direction -- it was reporting "no stall" and "not a stall" for the same reason: it measured nothing. Heartbeat was also being flagged as missing even though it is a fallback that must not run when another tier had content. Both fixed, with a test that parses a line copied out of a real job log instead of a remembered one. Evidence from the 8h window ending 06:48Z: 23 runs, 19 posts carrying a printed tweet id, tiers note=6 and blind=4, no frozen backlog and no unreported residual; 2 findings remain, both the same historical refused override.

NEXT. The comparison this fix cannot make for itself: both depth estimators against catalogue depths on known planets, to establish which one should be published and with what significance. Then the report library, where 2 of 48 pages can currently be machine-verified by anyone on a clean checkout.

Proof:
- Commit (full SHA): https://github.com/SpaceDataRig/space-data-rig/commit/61d7c6872b8cb643765e61385f272aaf66ea2fce
- CI run on that commit: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39106103788
- Live records the counts were read from: https://spacedatarig.app/api/findings
- Long-baseline report, one of the 2 pages reproducible from a clean checkout: https://spacedatarig.app/reports/p41-longbaseline.html
- Deployed revision self-report: https://spacedatarig.app/health
```
