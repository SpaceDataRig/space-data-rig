# P65 external-candidate audit: submit a third-party claim, run the full critic + gates, report pass/fail

Reproduce: `npm run p65:external-audit` (or `-- --claim-file yourClaim.json` with a CandidateClaim).

OFFLINE REPLAY: figures re-DERIVED from `reports/fixtures/p65-frozen-outcomes.json` (a committed snapshot of the live audit outcomes, taken 2026-10-14T17:25:29Z); `--live` re-audits.

This is the community / external audit ENTRY (research mode, NOT on-chain): it runs the independent audit
(novelty, Gaia dilution/blend, geometry, our OWN blind re-detection + power rank, a detectability floor) AND
the deterministic mission-critic with the current gates, fed a continuous soft blend-likelihood + calibrated
FAP. It reports whether the claim passes the accepted-only money gate -- without ever anchoring or claiming.

| claim | corroborated | novel | geometry | blend tier | soft score | FAP | critic verdict | passes gate |
|---|---|---|---|---|---|---|---|---|
| Aakanksha | false | true | true | low | 0.02 | 1.000 | rejected | false |
| Orbit | false | true | true | low | 0.00 | 0.115 | rejected | false |

Result: 0/2 pass the accepted-only gate. A novel /
unconfirmed external claim honestly caps at needs-more-data -- the critic runs BLIND (catalog = []) so we never
auto-accept or stake an outside candidate. A non-detection by our detector reflects our sensitivity (the
detectability floor), not a refutation. This entry NEVER writes a verdict to the money path, anchors, or
claims a discovery (discoveryClaim false, anchored false, safeToGate false).
