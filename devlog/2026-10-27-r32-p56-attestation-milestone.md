# Milestone dispatch evidence (R26-32)

- Commit: `c888151` "R26-32: p56 wired, run and attested -- the row flipped to verified"
- CI (`ci.yml`, event=push, run 40496087223): checks=completed/success
- Live site self-proof: `GET /health` gitSha=`c888151`, deployVersion=`f60acd16-1166-48af-a026-ea2b709d2cab`
- Served index at publish: `/reports/index.json` freshness `{stamped 24, verified 23, fullyVerified 23, unattested 32, total 56, stale []}`; row `p56-real-selection` = stamped/verified/fresh true.
- Guard (pre-dispatch, same code as production): `npm run x:post -- --text-file out/milestone26-r32-en.txt --max-len 25000` -> `DRY RUN` exit 0, `length=1341/25000`, English-only, ASCII + over-claim clean.
- Dispatch: `POST actions/workflows/x-post.yml/dispatches` (ref main, inputs.text=<this copy>, maxlen=25000) -> HTTP 204 accepted. Actions-scope token fetched via `git credential fill`, held in memory only, never printed or written.
- Run: `run=40497903118` event=workflow_dispatch head=c888151 completed/success; job `122167930986` (digest) all steps success incl "Compose every reportable item in the window and post each one".
- Posted: job log line `x:post: OK posted (id 2115046017368228119).`
- Tweet id: 2115046017368228119
- The archived body below is the EXACT bytes dispatched (from out/milestone26-r32-en.txt), not a re-typed copy.

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
