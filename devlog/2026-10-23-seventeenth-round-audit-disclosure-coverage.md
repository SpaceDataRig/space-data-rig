# Seventeenth-round external audit -- disclosure-coverage and gate-direction fix, deployed (2026-10-23)

English long-form summary dispatched to the public feed for this batch, then archived here
byte-for-byte. The rig closed a seventeenth-round external audit and deployed; this post reports
the measurable deltas and states the standing limits honestly. The round's lesson is about gate
direction: a fix that also hardens the wrong expectation into a gate is worse than no fix,
because it makes the next correction look like a regression.

## Dispatch evidence

- Dispatch accepted: HTTP `204` (POST .../workflows/x-post.yml/dispatches ref=main, inputs.text=<these bytes>, inputs.maxlen=25000).
- Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39939093398 (event=workflow_dispatch, conclusion: success, head_sha 821a980).
- Job-log send line: `x:post: OK posted (id 2113577794491896133).` (2026-10-23T10:26:29Z).
- posted id: `2113577794491896133`.
- Pre-flight guard (`npm run x:post -- --text-file out/en17.txt --max-len 25000`, no local keys): DRY RUN, length=3227/25000, zero non-ASCII, zero over-claim violations. A separate re-check (out/redline17.ts) ran the exact TIME_WORDS and SPEND_WORDS regexes from tests/devlog-archive.test.ts plus overclaimViolations from scripts/science-digest.ts over the normalised bytes: zero hits on all three, so the text is provably both postable and archivable before dispatch.
- Deploy self-proof: `/health` gitSha == 336840b1bc5463641a1db1fc2c5d74785fe68128 (the deployed code commit), wrangler version 2327eda2-7043-42f3-9485-72fa3bf309ce; CI run for that commit https://github.com/SpaceDataRig/space-data-rig/actions/runs/39928134966 conclusion: success.
- Superseded first attempt (honest record): an earlier dispatch of this same summary (run 39937991755, posted id 2113575468452454508) went out carrying the time-window token "today's" in one sentence ("today's catalog holds only A components"). That token is forbidden by this repo's own feed red lines (devlog/README.md, and the TIME_WORDS guard in tests/devlog-archive.test.ts), but the send-time guard in scripts/post-x-text.ts checks ASCII, length and over-claim only -- it did not yet check time-implying words -- so the local DRY RUN passed and the post went out. The text could not be archived byte-for-byte without failing `npm test`, and an archive must never drift from the feed, so the sentence was corrected to "the catalog currently holds only A components", re-dispatched, and the corrected bytes below are what this entry archives. No number, claim, hedge or proof link changed between the two posts; the only diff is that one time-window token. The send guard is being hardened to enforce the time-word and spend-word red lines it already documents, so this cannot recur.

## Commits in the batch (audit items)

- 336840b -- read-side hardening: decode a TOI candidate number to its planet letter (.01 -> b ... .25 -> z) in labelDesignatorOf / knownDesignatorOf; add a designatorKind field (planet-letter / candidate-number / none) to disambiguate a null designator; keep a binary star's component letter in hostKeyOf; render the label conflict on the board card (web/app.js + styles.css); add an offline wiring test proving the served value equals the kernel value by construction; add a CI syntax gate over the browser files; flip both frozen test expectations to the decoded truth (conflicts 5 -> 7), so the gate encodes the correction instead of defending the miss; and relabel README's snapshot counts as-of the committed capture rather than present tense.
- 821a980 -- docs only: record the round in CHANGELOG, RESPONSE-TO-AUDIT (including the :459 Concern-7-vs-Verification-5 reconciliation) and HANDOFF section 13.
- Deployed as wrangler version 2327eda2; the two on-chain hashes and the 20-row anchored ledger are unmoved.

## Measured deltas (live, from a fetch after deploy -- out/verify17.ts, 23 assertions, all passing)

- Predicate reach: the label-conflict check went from readable on 28 of 103 rows (27.2%) to all 103; requestedDesignator is no longer null on those 62 rows -- the designator kinds now span candidate-number 58, planet-letter 41, none 4.
- Conflicts: 5 -> 7. The two recovered rows are TOI-6054.02 (self-label .02, crossmatch TOI-6054.01) and TOI-4443 c (self-label c, crossmatch TOI-4443.01); both are needs-more-data and neither is in the 20 anchored ledger rows, so no on-chain promise changed.
- Parity: the served flag equals our kernel recompute and an independent neutral comparator with zero mismatch across all 103 rows, on both the Node server and the edge worker.
- Host key: now keeps the binary component letter; this is latent, not a corrected count -- the catalog currently holds only A components, so distinctHosts stays exactly 90 over 103 records, and a neutral component-preserving recompute agrees with zero cross-star collisions.
- verify-onchain for F-HD-260655-c still returns labelMatchesKnownPlanet:false (c vs b) and ledgerBundleMatch:true, with the anchored science hash byte-equal to the committed ledger.
- Suite: 940 tests green at the round-17 deploy (was 937); the adjacent send-guard commit adds four CLI guard tests, bringing the suite to 944. Lint exit 0; typecheck:all clean on both projects.

## What was NOT done here (honest gaps)

- The two things the auditor says could actually move the evaluation -- minting fewer duplicate rows, and a seat-identity-free content address -- stay behind a calibration gate, unchanged; both touch the bundle path and were deliberately not attempted this round.
- No production verdict threshold, gate meaning, bundle field, science hash or anchored address was changed; this was a read-side disclosure fix only.
- README's snapshot counts (103 rows / 91 signals / 90 hosts / 12 duplicates) are no longer present-tense -- 336840b relabeled them as-of the committed capture (2026-10-23T05:42Z), with the re-measure command and an explicit not-a-live-promise note. What is still deferred is the automation the auditor recommended (their round-10 p48 gesture): no CI job runs a daily capture and hard-fails when the fixture and production disagree on the (targetId, verdict, ppm) projection, and README is not interpolated from that source, so the counts stay hand-maintained between captures.
- freshness-regen.yml still runs p86 with --allow-stale unconditionally (judged intentional: the stale branch cannot fire in CI); lint still covers src / tests / scripts, with the browser files guarded by the new syntax check rather than full eslint.

## Verbatim posted text

The block below is the exact text handed to the dispatcher (normalised CRLF -> LF, trailing
newlines trimmed -- the same normalisation `post-x-text.ts` applies before sending). It is the
corrected re-dispatch, byte-identical to posted id 2113577794491896133.

## Text as pushed

```
Seventeenth-round external audit of our TESS transit research rig -- closed item by item and deployed.

The auditor credited last round's bookkeeping, then found a sharper problem: the disclosure predicate we had just written could only see 27.2% of the catalog, and a test had frozen that blind spot as the expected answer -- so the commit that corrected the predicate would have turned our own CI red. That is the lesson: a fix that also hardens the wrong expectation into a gate is worse than no fix, because it makes the next correction look like a regression.

The gap: the label-conflict check compared a planet letter against a planet letter and returned "no claim to compare" on a TOI candidate number such as .01 or .02. It was reachable on 28 of 103 rows; 62 rows carried a null designator; 5 conflicts were flagged where a decode-aware reading of the same bytes finds 7.

What we changed, read-side only -- no stored row, no bundle hash, no anchored bytes moved:
- The predicate now decodes a candidate number to its planet letter (.01 -> b ... .25 -> z), so it reads the whole catalog. Both frozen test expectations were flipped to the decoded truth (5 -> 7), so the gate now encodes the correction instead of defending the miss.
- A designator-kind field removes the ambiguity of a null designator ("no claim" versus "an undecoded number"); live the kinds span candidate-number 58, planet-letter 41, none 4.
- The host key keeps a binary star's component letter, so two different stars can never be merged into one host. This is latent, not a corrected count: the catalog currently holds only A components, so the live host count stays exactly 90.
- The conflict is now rendered on the board card itself, reading the served value, so a human sees the same fact the API returns.
- An offline wiring test proves the served value IS the kernel value by construction -- chosen over re-capturing a live fixture, which would drift against a catalog that regrows every 15 minutes.
- The browser files sit outside our linter, so CI now runs a syntax check over them; a served file can no longer ship a parse error silently.

Re-measured live after deploy: all 23 post-deploy assertions passed on real production rows. Seven rows now carry the flag (two of them recovered from the blind spot, both still needs-more-data, and neither is anchored); the served flag equals our kernel recompute and an independent neutral comparator with zero mismatch across all 103 rows; the host count reads 90 over 103 records; and the verify endpoint still returns its anchored science hash byte-equal to the committed ledger, with the two on-chain hashes unmoved. 940 tests green.

This is a disclosure-coverage and gate-direction fix, not a planet claim. The two things that could actually move the evaluation -- minting fewer duplicate rows, and a seat-identity-free content address -- stay behind a calibration gate, unchanged, and we say so plainly rather than implying they are done.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/actions/runs/39928134966
https://github.com/SpaceDataRig/space-data-rig/commit/336840b1bc5463641a1db1fc2c5d74785fe68128
```
