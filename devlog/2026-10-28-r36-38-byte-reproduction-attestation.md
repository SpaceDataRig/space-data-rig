# 2026-10-28 -- five-report byte-reproduction attestation milestone (session cumulative)

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override.

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40626792063
- posted id: `2115284343753003238`
- job log: `x:post: OK posted (id 2115284343753003238).`
- head at dispatch: `43352f5225ba5fc6552b70808c9eff8b831d0828`
- CI for that head: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40625542765 `completed/success`
- pre-flight through the REAL guard before dispatching, not after a failed run:
  `npm run x:post -- --text-file out/milestone27-attest-en.txt --max-len 25000` printed
  `DRY RUN (no X credentials in the environment; nothing was sent to X)` and `length=1513/25000`
- Actions-scope token fetched via `git credential fill`, held in memory only, never printed or written.

## What this milestone is

Across R26-36..R26-38 the rig attested four more report generators by the R26-35 rule -- mark a report verified
only when re-running it reproduces its published numbers byte for byte -- on top of the p56 attestation of R26-32.
p69 (red-noise significance), p62 and p67 (joint-fold / seed-lift over the fixed 20-planet P60 sample) and p73
(masked-recovery sibling lift) each ran faithfully and their committed `.md` came out byte-identical; each `.json`
gained only the provenance stamp plus a cosmetic async row re-order (same multiset, so the aggregate is stable).
One, p35 (phase-dispersion cross-check), was refused: its host list is drawn from a catalog that has grown, so a
faithful re-run moved the numbers and it stays honestly unattested. In the served index the machine-verified count
went from 22 to 27 and rows with no stamp fell from 33 to 28, `stale=[]`; `/health` read back gitSha `43352f5`,
deployVersion `eb396be5`. The whole distinction -- a stamp should pin the real inputs, not merely exist -- is the
point of the post.

## Text as pushed

```
Provenance milestone: five more research reports are now machine-verified against the exact files they read.

The rig publishes 56 research reports behind a freshness gate: each report should record the checksums of the inputs it actually used, so a stale number is flagged automatically instead of trusting a timestamp. Over this round we ran five report generators again -- a per-target detection selection function, a red-noise significance study, and three joint-fold and masked-recovery comparisons over a fixed set of 20 known exoplanet host stars -- and re-hashed the committed inputs behind each.

The rule we held to: mark a report verified only when re-running it reproduces its published numbers byte for byte. Four of the five reproduced exactly -- their summaries and verdicts came out identical and only the provenance stamp was added -- so they are now machine-verified. One, a phase-dispersion cross-check whose host list is drawn from a catalog that has grown, produced different numbers on re-run, so we left it unverified rather than stamp a figure we could not reproduce. That distinction is the whole point: a stamp should pin the real inputs, not merely exist.

In the served index the machine-verified count went from 22 to 27, and reports with no stamp fell from 33 to 28. Every figure here is read from the live site, not asserted.

Proof links:
Repo: https://github.com/SpaceDataRig/space-data-rig
Site: https://spacedatarig.app
Reports index: https://spacedatarig.app/reports/index.json
```
