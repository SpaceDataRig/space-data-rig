# Twelfth-round audit remediation, deployed and posted (2026-10-22)

What was posted (verbatim below): the integrity lesson from our own twelfth-round external audit -- a
published report could be re-stamped and re-verified as fresh even after its written sentence stopped
matching the numbers beneath it, because the freshness gate checked bytes against inputs and never prose
against data. The fix interpolates every count in that report from its own JSON and pins each number to the
row that produced it; a new ~3.9 KB summary endpoint lets an outside reader re-check the headline counts
without pulling the full ~325 KB state. Both sizes were measured live on spacedatarig.app after deploy. This
is a reproducibility fix, not a planet claim. Concept figure: ./prose-vs-data-consistency-lock.png.

## Dispatch evidence

- Preflight (local, same code path as CI): `npm run x:post -- --text-file out/en.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=751/25000`, English-only,
  over-claim guard passed (no affirmative discover/confirm/first/novel stem).
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000` -> HTTP `204` ACCEPTED.
- Actions run **39733498687** (event=workflow_dispatch) -> `completed/success`.
- Job "digest" step -> `success`.
- Job log line: `x:post: OK posted (id 2113153984806662277).` -- posted id: `2113153984806662277`

## Proof links

- deployed revision (the live `/health` gitSha): https://github.com/SpaceDataRig/space-data-rig/commit/25317d530552eb7477a8bacd95f292bf78ffe085
- CI run on the deployed commit: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39730949619
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/39733498687

## Text as pushed

```
We audited our own research pipeline and found a real integrity gap: a published report could be re-stamped and re-verified as fresh even after its written sentence stopped matching the numbers underneath it. The freshness gate checked bytes against inputs, but never prose against data.

What we changed: every count in that report now comes from its own JSON, and a test pins each number in the sentence to the exact row that produced it. We also added a small summary endpoint (~3.9 KB) so an outside reader can re-check the headline counts without pulling the full ~325 KB state. Both sizes were measured on the live site. 883 tests green.

This is not a planet claim. It is about keeping published numbers true to their sources.

spacedatarig.app
```
