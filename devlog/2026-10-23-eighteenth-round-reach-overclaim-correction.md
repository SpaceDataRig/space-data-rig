# Round-18 public reach over-claim correction (2026-10-23)

What was posted (verbatim below): a correction, on the same public feed, of the round-17 claim that the
label-conflict check "reads the whole catalog". The verifiable figure is that designator parsing covers
103 of 103 rows while the label-conflict predicate can FIRE on only 34 of 103 rows (33.0%, up from 27.2%);
the ceiling is 38 rows (those carrying any NASA comparison name) and the other 65 rows have no comparison
name, so the predicate has nothing to contradict there. This is a wording correction, not a planet claim,
and nothing on-chain moved (anchored ledger still 20, blind-toi accepted still 0).

## Dispatch evidence

- Preflight (local, the SAME code path CI runs): `npm run x:post -- --text-file out/en18.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=2357/25000`; all four
  send guards passed (ASCII, length, over-claim, feed red-line, and the new coverage/denominator net).
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000`, body 2469 bytes (under the ~10 KB dispatch-input ceiling) -> HTTP `204` ACCEPTED at
  2026-10-23T14:20:49Z.
- Actions run **39968839678** (event=workflow_dispatch) -> `completed/success`.
- Job step "Compose every reportable item in the window and post each one" -> `success`.
- Job log line: `x:post: OK posted (id 2113636839479451966).` -- posted id: `2113636839479451966`

## What this corrects

- Round-17 public post id `2113577794491896133` wrote that the predicate "reads the whole catalog"; that
  overstated its reach about threefold. The corrected, re-measured figure is 34 of 103 rows (33.0%).
- Round-17 first-attempt post id `2113575468452454508` tripped the send guard on a relative-time word and was
  re-posted as `2113577794491896133`; the first attempt is recorded here as SUPERSEDED-BY `2113577794491896133`.
  It is recorded, not deleted. ROUND-20 CORRECTION -- the reason is a POLICY choice, not a platform limit: the X API
  v2 DOES expose `DELETE /2/tweets/:id`; `scripts/post-x-text.ts` simply implements a POST path only, and this repo
  deliberately does not add a delete path (immutable-archive discipline: record + annotate, never silently erase our
  own public error). So removal is possible in principle and would be a stated operator decision, not an external
  constraint the repo cannot meet. The earlier "not something this repo can do" wording conflated the two.

## Proof links

- code fix (fourth guard + widened rule + shared source): https://github.com/SpaceDataRig/space-data-rig/commit/6ec8f07da05b6ac8153903c158fd4cbcb78743a3
- ledger correction (three books + round-17 devlog note): https://github.com/SpaceDataRig/space-data-rig/commit/c7bc41a4a23b913b5a74992158a1cb071a0cd123
- CI run on the corrected main: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39966605048
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/39968839678

## Text as pushed

```
An eighteenth-round external audit of our TESS transit research rig caught a public-number mistake that is ours, and we are correcting it on the same feed.

Last round we posted that a labeling check "reads the whole catalog" once we taught it to decode a TOI candidate number (.01 -> b); that overstated its reach about threefold, and the verifiable figure is 34 of 103 rows (33.0%).

The precise picture, re-measured on the committed catalog and on live production:
- Designator parsing does cover 103 of 103 rows: 99 of 103 carry a planet designator, and the 4 unnamed stars (such as GJ 1214 and HAT-P-11) correctly carry none.
- The label-conflict predicate can fire on only 34 of 103 rows (33.0%) -- those whose own label AND whose NASA cross-match name both decode to a planet letter. The ceiling is 38 rows, the ones carrying any NASA comparison name; the other 65 rows have no comparison name, so the predicate has nothing to contradict there.
- So reach moved from 27.2% to 33.0%, not to 100%. The conflict count it produces is 7, independently reproduced from three angles with zero mismatch.

Why it slipped past us: our three send-time guards each block one forbidden class -- over-claim wording, relative-time wording, and on-chain-value wording -- and a capability sentence like the one above is none of those, so it cleared all three. We added a fourth guard that refuses a coverage or capability claim carrying no denominator, and widened the third from a short word list to a pattern so it now catches the chain's own vocabulary that used to slip through. One shared rule now guards sending, archiving, and composing; before, a wider third copy lived only inside a test.

This is a wording correction, not a planet claim, and nothing on-chain moved: the anchored ledger is still 20 commitments, blind-toi accepted is still 0, and no verdict, hash, or anchor rule changed. The two things that could actually move the science -- minting fewer duplicate rows, and a seat-identity-free content address -- stay behind a calibration gate, and we say so plainly rather than implying they are done.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/commit/c7bc41a4a23b913b5a74992158a1cb071a0cd123
https://github.com/SpaceDataRig/space-data-rig/actions/runs/39966605048
```
