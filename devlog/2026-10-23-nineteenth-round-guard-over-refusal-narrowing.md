# Round-19 self-audit: narrowing two over-refusing feed guards (2026-10-23)

What was posted (verbatim below): a self-audit of the round-18 feed-guard hardening. The round-18 note
warned that "an over-refusing guard is its own failure"; this pass re-derived the label-conflict reach with
zero regression (34 of 103 rows, 33.0%; ceiling 38; 65 rows with no comparison name; 7 conflicts; 90 hosts;
91 signals; accepted 18 / with-origin 17 / blind-toi 0) and then found the two nets round-18 had just changed
over-refusing honest prose: the money rule blocked a hyphenated "burn-in" methods term and astronomy prose
(the Sun, a Martian day), and the coverage rule blocked true light-curve / sector processing statements that
were never reach claims. Both are fixed by NARROWING, and every catch is re-proved to survive (10 money-word
probes, 6 catalog-reach probes, all still refused). This is a guard-tuning note, not a planet claim, and
nothing on-chain moved (anchored ledger still 20, blind-toi accepted still 0).

## Dispatch evidence

- Preflight (local, the SAME code path CI runs): `npm run x:post -- --text-file out/en19.txt --max-len 25000`
  -> `DRY RUN (no X credentials in the environment; nothing was sent to X)`, `length=1351/25000`; all four
  send guards passed (ASCII, length, over-claim, feed red-line, and the coverage/denominator net). The post is
  ABOUT those guards and still clears them, which is the point.
- Dispatch: `POST /actions/workflows/x-post.yml/dispatches` on `ref=main`, `inputs.text` = the bytes below,
  `inputs.maxlen=25000`, body 1443 bytes (under the ~10 KB dispatch-input ceiling) -> HTTP `204` ACCEPTED at
  2026-10-23T15:41:59Z.
- Actions run **39980507202** (event=workflow_dispatch) -> `completed/success`.
- Job log line: `x:post: OK posted (id 2113657284282679371).` -- posted id: `2113657284282679371`

## What this changes

- `scripts/science-digest.ts`: `FEED_SPEND_WORDS` narrowed (burn matches only the token-burn forms and not a
  hyphenated compound; sol requires a value context) and `COVERAGE_TOTALITY` narrowed (the verb+totality
  alternative must now govern a reach noun). The denominator gate is unchanged; the "went from N of M to all
  M" hole stays a documented limit, not a guess. Accepted residual, pinned: the citation surname "Burns 2019"
  still trips the money rule.
- `tests/post-x-text-guard.test.ts`: +3 regression tests pinning both narrowings AND the surviving catches.

## Proof links

- code fix + ledgers (this round): https://github.com/SpaceDataRig/space-data-rig/commit/5f3bb57b19d351ed414ccf6c97af40f7710bbd7f
- CI run on the fixed main: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39978546780
- posted run (this dispatch): https://github.com/SpaceDataRig/space-data-rig/actions/runs/39980507202

## Text as pushed

```
Round-19 self-audit of the rig's public-feed guards.

We began by re-deriving the label-conflict reach from the committed catalog through the kernel: it can fire on 34 of 103 rows (33.0%), ceiling 38, with 65 rows carrying no comparison name; 7 conflicts, 90 distinct hosts, 91 distinct signals. Every figure is byte-identical to the prior round, so nothing regressed.

Then we probed the two guards the prior round had just widened, specifically for over-refusal, and found two:
- the money-word rule was blocking honest methods prose (a hyphenated burn-in term) and astronomy prose (the Sun, a Martian day);
- the coverage rule was blocking true processing statements about a light curve or a sector that were never reach claims at all.

Both are fixed by narrowing, not reverting. The discipline that makes a narrowing safe: every one is paired with a re-proof that the catches survive. All 10 money-word probes and all 6 catalog-reach probes are still refused, exactly as they must be. The suite went from 950 to 953 pass, 0 fail. Scripts and tests only, so no Worker deploy and no served-bundle change; no anchored ledger row, hash, or verdict gate moved.

Proof links:
commit https://github.com/SpaceDataRig/space-data-rig/commit/5f3bb57b19d351ed414ccf6c97af40f7710bbd7f
CI https://github.com/SpaceDataRig/space-data-rig/actions/runs/39978546780
```
