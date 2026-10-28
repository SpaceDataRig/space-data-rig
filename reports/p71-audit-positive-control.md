# P71 is the external-audit 'accepted' branch reachable, or is P65's 0/2 a dead gate?

Reproduce: `npm run p71:audit-positive-control -- --targets 14 --tmag 11`

OFFLINE REPLAY: figures re-DERIVED from `reports/fixtures/p71-frozen-rows.json` (a committed snapshot of the live critic outcomes, taken 2026-10-15T01:06:25Z); `--live` re-detects.

P65 capped 0/2 novel external claims at needs-more-data. Is that the intended BLIND guard (a novel
signal with no catalog cross-match can never be accepted -- src/critic/review.ts:282-296) or a broken,
unsatisfiable gate? This control scores the SAME detected candidate two ways on real known planets:
BLIND (catalog = [], what P65 feeds a novel claim) vs CORROBORATED (catalog = the archive).

| run | accepted | needs-more-data |
|---|---|---|
| BLIND (catalog=[]) | 0/14 | 14/14 |
| CORROBORATED (catalog=archive) | 8/14 | - |

Reachability example: **pi Men c** -- capped BLIND, but once its host is in the catalog
the re-detected fundamental period cross-matches and the critic returns ACCEPTED (evidence-driven;
the truth period was only a post-hoc non-gating check).

**VERDICT: ACCEPT-PATH-REACHABLE: the accept branch fires for a genuine known planet the instant its host is corroborated by the catalog (8/14 accepted CORROBORATED), yet the SAME detected signals all cap at needs-more-data BLIND (accepted 0/14). P65's "0/2 pass" is therefore the CORRECT blind-by-design outcome -- a novel external claim has no catalog match and is never auto-accepted -- NOT a broken or unsatisfiable gate. The money path stays protected exactly as intended.**

Positive control on KNOWN planets; claims no discovery; anchors nothing; touches no bundle / money path.
discoveryClaim false, safeToGate false.
