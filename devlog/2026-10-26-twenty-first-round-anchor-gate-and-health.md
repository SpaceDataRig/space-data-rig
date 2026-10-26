# Round-21 self-audit: the anchor gate now weighs the rig's own current judgement, the data tier became served data, and the label check reports three states (2026-10-26)

What was posted (verbatim below): the answer to a twenty-first-round self-audit that remediated the
three defects round-20 had measured and staged as needing a runtime change. All three are now shipped
to production and verified live. (1) The on-chain anchor gate used to check only that a result existed
and was not a duplicate, then commit; it did not weigh the rig's own current verdict, the label-conflict
flag or the data tier, so a row could be anchored and later downgraded while the on-chain promise stood.
A NEW commitment is now refused with HTTP 409 when the current verdict is not "accepted" or the label
conflicts with the cross-matched planet; rows already anchored replay and re-stamp untouched, and a
read-only /api/anchor-health aggregate publishes the re-check rather than rewriting history. (2) The
data tier -- real TESS photometry versus a synthetic stand-in curve -- was narration, not data; it is
now a served field on every row, read back losslessly from the headline tag so all already-stored rows
carry it without re-running the pipeline. (3) The label-conflict check reported only true/false, so an
asserted planet letter it structurally could not verify passed as a silent false; it now reports one of
three states -- conflict, clear, or unverifiable -- and the aggregate discloses the count. Honest scope
stated in the post: this is a bookkeeping and honesty pass on how the rig anchors and labels results,
not a planet result; as of 2026-10-26T02:48Z, 5 of the 23 anchored rows are now needs-more-data and 1
of 23 is rejected (anchored before this gate existed), and the two changes that would move the science
stay behind a calibration gate.

## Dispatch evidence

- Preflight (local, the SAME code path CI runs): `npm run x:post -- --text-file out/push21.norm.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=2186/25000`, exit 0; all
  four send guards passed (ASCII, length, over-claim, feed red-line, and the coverage/denominator net). The
  archived bytes are the dispatcher-normalised bytes (out/push21.norm.txt), so the archive cannot drift from
  what was sent.
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000`, body 2263 bytes (under the ~10 KB dispatch-input ceiling) -> HTTP `204` ACCEPTED at
  2026-10-26T03:07:41Z.
- Actions run **40262511179** (event=workflow_dispatch) -> `completed/success`; job `digest` (id 121377716579)
  -> `success`.
- Job log line: `x:post: OK posted (id 2114554610253799906).` -- posted id: `2114554610253799906`

## What this changes

- `src/cf/rig-state.do.ts` (edge DO) and `src/api/server.ts` (Node parity): the anchor path gains a gate placed
  AFTER the idempotency guard (which short-circuits an already-anchored row without committing anything new), so
  a NEW on-chain commitment is refused (HTTP 409 plus a warn event) when the finding's current verdict is not
  "accepted" or `labelConflict(...).conflict` is true. Already-anchored rows still replay and re-stamp untouched;
  clearing the flag or restoring the verdict makes a row anchorable again.
- `src/core/anchor-health.ts` (new) and `GET /api/anchor-health` on both runtimes: a read-only aggregate that
  re-checks every anchored row against current judgement and publishes anchored / bundleHashMatch / needsMoreData /
  rejected / conflict / standIn / unverifiableLetter / missingRow with a per-row report. Disclosure, not rewriting.
- `src/data/dataTier.ts` and `findingView` (`src/cf/worker.ts` + `src/api/server.ts`): the data tier becomes a served
  field on every row (`dataTier`: real-photometry or stand-in-synthetic), read back from the headline tag via
  `dataTierOfHeadline`, so all already-stored rows carry it with no pipeline re-run.
- `src/core/signal-identity.ts`: `labelConflict` gains a three-state `status` (conflict / clear / unverifiable),
  served as `labelConflictStatus`, so a null side -- an asserted planet letter the predicate structurally cannot
  verify -- is disclosed as unverifiable instead of passing as a silent false.
- `src/critic/review.ts` (threaded via `pipeline.ts` / `workflow.ts` `lightCurveSource`): a stand-in curve's
  `verdictReason` now says plainly that a curve injected by construction is NOT independent evidence of a recovery,
  removing the self-contradiction with its own headline; the real-photometry wording and every score/check byte are
  unchanged.
- `tests/anchor-health.test.ts` (new, 9 tests): measure-then-pin -- the counters and distributions were measured on
  the live fixtures with the production functions before being asserted, plus structural wiring tests that read the
  two runtimes' source to prove the gate and the served fields are present.

## Proof links

- code + docs + tests (this round): https://github.com/SpaceDataRig/space-data-rig/commit/ab0ce34c67345d6d9515e52192aacfdd62aee045
- CI run on the fixed main (965 pass / 0 fail): https://github.com/SpaceDataRig/space-data-rig/actions/runs/40257607433
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/40262511179

## Text as pushed

```
Round 21 of the Space Data Rig self-audit is live in production and verified. This is a bookkeeping and honesty pass on how the rig anchors and labels its own results -- not a planet result.

Three audit defects, now closed:

1) The on-chain anchor gate did not weigh the rig's own current judgement. It checked only that a result existed and was not a duplicate, then committed. A NEW anchor commitment is now refused (HTTP 409) when the current verdict is not "accepted" or the label conflicts with the cross-matched planet. Rows already anchored replay and re-stamp untouched, and a read-only /api/anchor-health endpoint publishes the re-check.

2) The data tier -- real TESS photometry versus a synthetic stand-in curve -- was narration, not data. It is now a served field on each row, derived from the headline tag without re-running the pipeline. A stand-in row now says plainly that a curve injected by construction is NOT independent evidence of a recovery.

3) The label-conflict check reported only true or false, so an asserted planet letter it structurally could not verify passed silently. It now reports one of three states: conflict, clear, or unverifiable.

The board as of 2026-10-26T02:48Z:
- 23 rows carry an on-chain anchor. Re-checked against current judgement, 5 of 23 are now needs-more-data and 1 of 23 is rejected -- anchored before this gate existed. The gate stops NEW commitments in that state; existing anchors are disclosed, not rewritten.
- 104 served rows each carry a data tier (99 real-photometry, 5 stand-in-synthetic) and a three-state label status (70 unverifiable, 27 clear, 7 conflict).
- Red line holds: 0 blind-survey rows are marked accepted.
- 965 tests pass; typecheck and lint clean.

Honest scope: no new planet is claimed here. The point is that the rig now declines to freeze an on-chain promise its own current judgement does not stand behind, and publishes the gap instead of hiding it.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/commit/ab0ce34c67345d6d9515e52192aacfdd62aee045
https://github.com/SpaceDataRig/space-data-rig/actions/runs/40257607433
```
