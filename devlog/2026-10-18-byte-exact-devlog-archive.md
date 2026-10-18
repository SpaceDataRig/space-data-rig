# 2026-10-18 -- the pushed summaries are archived in the repository, byte for byte

Pushed to the public feed through the `x-post.yml` `workflow_dispatch` override.

- dispatch accepted: HTTP `204`
- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39095607827
- posted id: `2111668846809522350`
- job log: `posting override (maxlen=25000): Space Data Rig: what the feed published is now archived in the repository, byte for byte.`
  then `x:post: OK posted (id 2111668846809522350)`
- head at dispatch: `d33140845f1cde99a085aab3ab618fe1c8eb0ec2`
- CI for that head: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39094987353 `completed/success`
- pre-flight through the REAL guard before dispatching, not after a failed run:
  `npm run x:post -- --text-file out/summary-push3.txt --max-len 25000` printed
  `DRY RUN (no X credentials in the environment; nothing was sent to X)` and `length=3888/25000`
- dispatcher pre-flight: `PREFLIGHT_OK ascii-only, no red-line hits, 3888 chars (ceiling 25000)`

## The un-rationing proved itself in the same window

A separate run fired by the Worker's own cron 26 seconds earlier, at head `d3314084`, posted TWO items in
one run -- which the code before commit `c9684ff44b7d9f70944174488c8229095300746a` could not do, because it
capped every window at one post and composed a build note only when the science tier had nothing to say:

- run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39095577800
- `posting 2 composed item(s); runaway ceiling 25, delay 5s between posts`
- item 1, science tier, from `out/posts/02-blind.txt`: `Its blind sweep of real TESS photometry turned up 1 new UNCONFIRMED transit candidate (e.g. TOI-1962.01, P=1.77d).`
  then `x:post: OK posted (id 2111668756908790082)`
- item 2, build-note tier, from `out/posts/10-note.txt`: `Under the hood, what changed in how Space Data Rig runs:`
  then `x:post: OK posted (id 2111668780724027403)`
- the build note's bullet was the `docs(devlog):` commit itself. Under the old filter every `docs:` subject was
  discarded outright, so documentation never counted as reportable work.

Both tiers reported, oldest item first, five seconds apart, in one run. That is the behaviour the operator
asked for: no self-imposed ration, post what the window can report.

## Note on what this entry claims

This is the third summary pushed to the feed. The text below says "Two long-form summaries were pushed", which
was accurate when it was composed; this entry is the third and records itself in this header rather than
editing the pushed bytes, because the archived text must stay identical to what the feed holds.

## Text as pushed

```
Space Data Rig: what the feed published is now archived in the repository, byte for byte.

1. Two long-form summaries were pushed to the public feed through the posting workflow's dispatch override, which publishes exactly the text it is given. The only record of their wording was the feed itself. devlog/ now holds each one together with the evidence that it actually went out: the HTTP 204 from the dispatch, the Actions run, the posted tweet id, the job-log line showing the send, and the pre-flight result.

2. The archived text is written by a script from the SAME BYTES handed to the dispatcher, not re-typed. A re-typed copy drifts -- a softened number, a dropped hedge -- and a drifted archive is worse than no archive, because it looks authoritative. The script normalises CRLF to LF the way the dispatcher does, since on a Windows checkout the working copy is CRLF while the bytes that were sent are LF.

3. It refuses to write two kinds of archive. Text containing a code fence, because the fence would terminate the block early and silently truncate the record. And text containing a non-ASCII byte, because the sender refuses non-ASCII and would never have transmitted it -- such an archive would be recording a post that could not have happened.

4. The tests run that script for real over fixtures, then assert the send path's own red lines over every entry already committed: pure ASCII, no carriage returns, no time-implying wording, no spend wording, no affirmative over-claim, and dispatch evidence present. The archive therefore cannot grow into a record of things that were never said.

5. One entry records that a claim was deliberately held back from it -- the claim that the posting limits had been removed. At the moment that summary was composed, the change had not been made. Publishing it then would have been a false statement about the rig, so the claim waited for the commit that made it true.

6. Two stale statements in the handoff document were corrected rather than left for a successor to trip over. The test command runs a runner that finds every file under tests/ by itself, so there was no hand-maintained list in package.json to update, which is what the document claimed. And the layout section now names the posting workflow, because a workflow with no push trigger that publishes publicly is precisely what a layout section should name. A count of test files was deleted outright instead of refreshed: a number that goes stale on every commit is worse than the fact that matters, which is that the runner finds those files by itself.

7. Authoring discipline changed after a refusal. The over-claim guard rejected a summary of mine because two of its sentences carried an affirmative stem, one of them an ordinal used inside a hyphenated compound where the word boundary still matches. The correct response was to rewrite the summary, not to weaken the guard. Authored text now goes through the real guard locally BEFORE dispatch, in an environment with no X credentials, which performs the full ASCII, length and over-claim validation and prints DRY RUN without sending anything. It is the same code path the workflow uses, so it cannot disagree with production. Previously the only way to learn of a refusal was a failed run.

Test suite 625 of 625 passing, up from 618. Lint and typecheck clean. Shell harness green.

Nothing here is a new planet. Every candidate this rig produces is UNCONFIRMED and is posted for human follow-up. Reports computed from stand-in data are labelled as such at the source.

Proof:
github.com/SpaceDataRig/space-data-rig/commit/d33140845f1cde99a085aab3ab618fe1c8eb0ec2
github.com/SpaceDataRig/space-data-rig/actions/runs/39094987353
github.com/SpaceDataRig/space-data-rig/actions/runs/39093551244
github.com/SpaceDataRig/space-data-rig/actions/runs/39092378180
Live rig and its sealed analyses: spacedatarig.app
```
