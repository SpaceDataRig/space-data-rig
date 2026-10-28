# Dispatch evidence -- R26-49 milestone "verified count rose 24 -> 25" (English)

This section records the raw facts of the single dispatch that posted the English
milestone copy verbatim. The archived tweet bytes were produced by `scripts/devlog-archive.ts`
from `out/milestone29-lift-en.txt` -- the exact bytes that were sent -- never retyped.

- Workflow: `.github/workflows/x-post.yml` via `workflow_dispatch` (inputs.text override, maxlen 25000)
- Dispatch accepted: HTTP `204` (accepted, no body)
- Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40658734590 (status completed, conclusion success, head e70c170)
- Job: 122716122063 "digest" -> step "Compose every reportable item in the window and post each one" success
- Job log send line: `x:post: OK posted (id 2115363634045952379).`
- posted id: `2115363634045952379`
- Pre-check (local, same code path as the workflow): `npm run x:post -- --text-file out/milestone29-lift-en.txt --max-len 25000` printed DRY RUN and exited 0 -- full ASCII + length + over-claim validation, no credentials present, so it could not disagree with the workflow verdict.
- Source revision: commit bfe38de (R26-49 lift), ledger e70c170; deployed version 21b6f04a, gitSha bfe38de. Served library verified 25 / fullyVerified 25 / unattested 28 / stale [].
- The numbers quoted (24 -> 25, 25 of 56) are read from the committed, gate-verified `web/reports/index.json`, not asserted; the copy makes no new-planet claim and is measure-only.

## Text as pushed

```
Provenance update: we raised our own machine-verified report count, from 24 to 25.

We had lowered that count to 24, because a report reads machine-verified only when at least one re-hashed input is a data file, not just source code. One report -- a single-versus-multi-sector completeness study -- had lost that mark for exactly that reason.

Rather than move the rule, we pinned the measurement behind its numbers: the per-star recovery results are now a committed, checksummed data file, and the report rebuilds its completeness table from those frozen measurements, offline, byte-for-byte, with no figure moved. An independent checker that shares no code with the gate reproduces the same result: 25 of 56 rows machine-verified.

This is a completeness study on real TESS light curves; every figure stays measure-only, nothing is gated. The honest count went up because the provenance got stronger, not because the bar was lowered.

Repo: https://github.com/SpaceDataRig/space-data-rig
Site: https://spacedatarig.app

Proof links:
commit: https://github.com/SpaceDataRig/space-data-rig/commit/bfe38ded2ca1502f1837d92cf36d8ddc6210753a
CI: https://github.com/SpaceDataRig/space-data-rig/actions/runs/40656940761
```
