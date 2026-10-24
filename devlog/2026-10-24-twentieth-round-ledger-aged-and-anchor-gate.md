# Round-20 external audit: the on-chain ledger aged 20 -> 23 while a test had frozen "20 and moved no anchor" (2026-10-24)

What was posted (verbatim below): the answer to a twentieth-round external audit. The audit opened by
withdrawing two of its own older claims -- the science content-address no longer folds in a per-planet label
(three seats for HR 858 b/c/d recompute to one content hash), and same-content de-duplication is live and
correct (an identical result offered again is skipped, not re-anchored; event logged 2026-10-24T01:31Z). Both
withdrawals were re-checked directly against the code and the chain, not taken on trust. Its heaviest new
finding: the live anchored ledger had aged from 20 to 23 while 18 places in the docs still read 20, and one
test had frozen "the wider predicate moved no anchor" as an invariant off a fixed snapshot -- production had
moved past it (one anchored row is also flagged as a label conflict), yet CI stayed green because it reads the
snapshot. This round fixed that class centrally, recomposed the still-phrase-matching coverage guard, corrected
a "recorded, not deleted" note that read a policy choice as a platform limit, and measured-and-staged the three
findings that need a runtime change behind a calibration gate. Scripts, tests and docs only: no Worker
redeploy, so nothing is "changed but not live". Honest scope stated in the post: the label-conflict check can
fire on 34 of 104 rows (32.7% as of 2026-10-24T07:02Z) -- the numerator held while the served-row denominator
moved 103 -> 104.

## Dispatch evidence

- Preflight (local, the SAME code path CI runs): `npm run x:post -- --text-file out/push20.norm.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=2961/25000`, exit 0; all
  four send guards passed (ASCII, length, over-claim, feed red-line, and the coverage/denominator net widened
  this very round). The archived bytes are the dispatcher-normalised bytes, so the archive cannot drift from
  what was sent.
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000`, body 3042 bytes (under the ~10 KB dispatch-input ceiling) -> HTTP `204` ACCEPTED at
  2026-10-24T08:30:41Z.
- Actions run **40078327141** (event=workflow_dispatch) -> `completed/success`; job `digest` (id 120826417755)
  -> `success`.
- Job log line: `x:post: OK posted (id 2113911143919911272).` -- posted id: `2113911143919911272`

## What this changes

- `CHANGELOG.md`: a twentieth-round CENTRAL CORRECTION supersedes every stale "exactly 20" ledger count at once
  (live re-measured 23 as of 2026-10-24T07:02Z), instead of re-typing 18 dated snapshots; the round-19 close
  line carries a short aged-marker pointing at it.
- `README.md`, `RESPONSE-TO-AUDIT.md`, `HANDOFF.md`: the counts read as present-tense were re-scoped to "as of
  the capture"; HANDOFF section 13 (the live snapshot a successor reads first) was re-measured and refreshed
  (surveyPass 565, distinctHosts 91, distinctRecords 104, ledgerAnchored 23, tasksDone 97), and its Git /
  Production bullets now say plainly that rounds 18/19/20 redeployed nothing and the per-row figures are the
  round-17 deploy-time verification while live has drifted to 104 records / 91 hosts.
- `tests/live-catalog-accounting.test.ts`: the frozen "moved no anchor" assertion is re-scoped to pin a capture,
  not a live promise, so the invariant no longer claims something production has already falsified.
- `scripts/science-digest.ts`: `COVERAGE_TOTALITY` recomposed to catch the three plain rewordings that slipped
  the phrase matcher (a bare "in full" / "entire input" / "everything"), and `COVERAGE_CONTRASTIVE` added so the
  exact earlier over-claim form ("went from N of M to all M") is caught even when it carries a denominator.
- `tests/post-x-text-guard.test.ts`: +3 regression tests pinning the recomposed coverage net and the surviving
  catches.
- `devlog/2026-10-23-eighteenth-round-reach-overclaim-correction.md`: the "recorded, not deleted" line now says
  removal is a POLICY choice (X API v2 does expose `DELETE /2/tweets/:id`; this repo implements a POST path only
  and deliberately adds no delete path), not a platform limit.
- Measured and staged for round-21, no runtime change shipped (each written up in HANDOFF with file:line and a
  minimal fix): the anchor gate (`rig-state.do.ts` anchorFinding) does not weigh verdict / label-conflict / data
  tier before committing; the data tier (`dataTier.ts`, consumed only by `narrate.ts`) is narration, not a served
  field, and two accepted stand-in rows are on-chain while their reasoning text contradicts their headline; five
  anchored identifiers assert a planet letter the label-conflict check structurally cannot verify.

## Proof links

- code + docs + tests (this round): https://github.com/SpaceDataRig/space-data-rig/commit/5bc183d8bb8d99c4e9b58a188f0fcaa364589d28
- CI run on the fixed main (956 pass / 0 fail): https://github.com/SpaceDataRig/space-data-rig/actions/runs/40077214929
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/40078327141

## Text as pushed

```
A twentieth-round external audit of our TESS transit research rig is answered in the repo. It did something worth copying: it opened by withdrawing two of its own older claims, because the code and the chain had moved past them.

Both withdrawals re-checked directly, not on trust:
- The science content-address no longer folds in a per-planet label. Three seats for one star (HR 858 b/c/d) recompute to a single content hash; the three distinct values sealed on-chain are history from an older projection.
- Same-content de-duplication is live and correct: an identical result offered a second time is skipped, not re-anchored (event logged 2026-10-24T01:31Z).

Fixed this round -- scripts, tests and docs only, no worker redeploy, so nothing is "changed but not live":
- The anchored-result count had aged. The live ledger re-measured 23 as of 2026-10-24T07:02Z, while 18 places in the docs still read 20, and one test had frozen "no anchor moved" as an invariant off a fixed snapshot. Production had moved past it: one anchored row is also flagged as a label conflict. The test is re-scoped to say it pins a capture, not a live promise, and one central correction supersedes the stale counts.
- The send-side coverage guard was still matching phrases, so three plain rewordings slipped it. Recomposed; the exact earlier over-claim form is caught even when it carries a number. Three new regression tests.
- "Recorded, not deleted" was written as though the platform forbade removal. It does not: deletion is a real API path this repo chooses not to implement, so a corrected post stays up and annotated. That is a policy, and it reads as one.

Measured and staged for the next round, with no runtime change shipped yet:
- The on-chain anchor gate checks that a result exists and is not a duplicate, but does not weigh the verdict, the label-conflict flag or the data tier before it commits. A row can be anchored, then later downgraded. The minimal fix is written up.
- The data tier (real photometry versus a synthetic stand-in curve) is narration, not a served field; two accepted stand-in rows are on-chain while their own reasoning text contradicts their headline.
- Five anchored identifiers assert a planet letter that the label-conflict check structurally cannot verify.

Honest scope: the label-conflict check can fire on 34 of 104 rows (32.7% as of 2026-10-24T07:02Z). The served-row count went from 103 to 104, so the denominator moved while the numerator held. This is a bookkeeping and honesty pass, not a planet result. The two changes that would move the science -- minting fewer duplicate rows, and a seat-identity-free content address -- stay behind a calibration gate, and we say so plainly.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/commit/5bc183d8bb8d99c4e9b58a188f0fcaa364589d28
https://github.com/SpaceDataRig/space-data-rig/actions/runs/40077214929
```
