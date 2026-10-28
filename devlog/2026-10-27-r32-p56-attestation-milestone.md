# 2026-10-27 -- a wired report generator ran for real and the served row flipped to verified

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override.

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40497903118
- posted id: `2115046017368228119`
- job log: `x:post: OK posted (id 2115046017368228119).`
- head at dispatch: `c888151a68d57d0a8d570de96fbbc4fa7f941db9`
- CI for that head: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40496087223 `completed/success`
- pre-flight through the REAL guard before dispatching, not after a failed run:
  `npm run x:post -- --text-file out/milestone26-r32-en.txt --max-len 25000` printed
  `DRY RUN (no X credentials in the environment; nothing was sent to X)` and `length=1341/25000`
- Actions-scope token fetched via `git credential fill`, held in memory only, never printed or written.

## What this milestone is

`p56` (per-target selection function over 18 real TIC hosts from the NASA Exoplanet Archive and Gaia DR3) is the
first of the R26-31 generators whose write-side `buildStamp` wiring was proven end-to-end by an actual run once
exoplanet-archive + Gaia TAP became reachable while MAST/SPOC-S3/tesscut stayed down. The regenerated report `.md`
came out byte-identical to the committed one -- only the `.json` gained the stamp -- so the run added provenance
without moving any number. The served index moved from `verified 22, unattested 33` to `verified 23, unattested 32`,
`stale=[]`; `/health` read back gitSha `c888151`, deployVersion `f60acd16-1166-48af-a026-ea2b709d2cab`.

## Text as pushed

```
Provenance update: one more report in the public research library is now machine-checked from end to end.

The rig publishes 56 research reports. Each one should be re-hashed against the exact inputs it read, so a reader can tell a stale number from a fresh one automatically, not on trust. The per-target detection selection function (P56) is built from real NASA Exoplanet Archive stellar radii and masses, and real Gaia DR3 neighbour stars inside a 21 arcsec aperture, measured over 18 host stars. It now carries a cryptographic stamp of the files it read and the code that produced it.

What changed when we wired the stamp and ran the generator again: the report's own numbers came out byte for byte identical to the version already published. So this step added provenance; it did not move any result. In the served index the machine-verified count went from 22 to 23, and the count of rows with no stamp yet fell from 33 to 32. Seven generators are now coded to stamp themselves, and the remaining six are wired and ready, each waiting only on the TESS SPOC data mirror becoming reachable again.

Every figure above is read from the served index on the live site, not asserted.

Proof links:
Repo: https://github.com/SpaceDataRig/space-data-rig
Site: https://spacedatarig.app
Reports index: https://spacedatarig.app/reports/index.json
```
