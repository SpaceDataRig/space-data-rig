# Devlog

Long-form operator summaries of what changed in the rig, kept in the repository.

Each entry here is the exact text that was pushed to the public feed through the
`x-post.yml` `workflow_dispatch` override (`inputs.text`), which short-circuits every
digest tier and posts the supplied text verbatim. They are archived here so the feed's
long-form posts are auditable against the commits they describe, and so a successor can
see that a stage summary is published rather than only described in conversation.

Red lines these texts are held to before dispatch, checked locally first:

- pure ASCII (`scripts/post-x-text.ts` refuses any other byte);
- no wallet / private key / seed phrase / spend wording;
- no time-implying wording ("today", "recently", "this week", ...) -- the feed has no
  dated context, so a relative time reads as a claim about a window nobody can see;
- no discovery over-claim: every candidate is UNCONFIRMED and posted for human follow-up;
- numbers carry their basis and their denominator;
- a Proof block links the full-SHA commit and the Actions run that verifies it, and both
  links are fetched before publishing.

An entry is written by `scripts/devlog-archive.ts` from the same bytes that were handed to
the dispatcher, never re-typed: a re-typed copy drifts, and a drifted archive is worse than
no archive because it looks authoritative. The script refuses a text containing a code fence,
which would truncate the block silently, or a non-ASCII byte, which the sender would never
have transmitted. `tests/devlog-archive.test.ts` runs that script over fixtures and then
asserts the red lines above over every entry already committed here.

| date | file | subject |
| --- | --- | --- |
| 2026-10-18 | [2026-10-18-report-freshness-and-starved-tier.md](2026-10-18-report-freshness-and-starved-tier.md) | the freshness gate counted a timestamp as verification; the build-note tier was starved by the science tier |
| 2026-10-18 | [2026-10-18-posting-volume-unrationed.md](2026-10-18-posting-volume-unrationed.md) | four self-imposed posting rations removed, and the science-cursor defect that removing them exposed |
| 2026-10-18 | [2026-10-18-byte-exact-devlog-archive.md](2026-10-18-byte-exact-devlog-archive.md) | the pushed summaries archived byte-exact, two stale handoff claims corrected, and authored text now pre-flighted through the real guard |
