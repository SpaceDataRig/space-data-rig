# P51 crowding-stratified acceptance re-validation of the blend-veto tools

Reproduce: `npm run p51:crowding -- --targets 24 --tmag 12 --pixcap 8 --aperture 21`

OFFLINE REPLAY: figures re-DERIVED from `reports/fixtures/p51-frozen-rows.json` (a committed snapshot of the live measurements, taken 2026-10-14T04:46:10Z); `--live` re-measures.

A reviewer's correct objection: *a synthetic-data pass is not enough for a veto tool; acceptance testing
also needs localization on confirmed planets AND performance in crowded fields where blends matter.* Our
P45 (blended-EB P(FP)) had only ever been characterised on bright, isolated hosts -- the regime where
blends do NOT happen. This script re-tests the veto tools with the sample deliberately pushed toward
the galactic disc (lowest |b| first) and reports every metric STRATIFIED BY CROWDING.

**Crowding of the 24-planet sample** (Gaia neighbours in the 21" aperture):

| crowding bin | n | median \|b\| | P(FP) median | P(FP)>0.5 | localized | offset median (arcsec) | offset max | confirmed-planet false-kills |
|---|---|---|---|---|---|---|---|---|
| isolated | 3 | 4.9 | 0.020 | 0 | 1 | 20.3 | 20.3 | 1 |
| moderate | 6 | 4.4 | 0.020 | 0 | 2 | 23.9 | 23.9 | 1 |
| crowded | 15 | 4.6 | 0.020 | 0 | 5 | 14.7 | 22.4 | 2 |

**What this measures.** 15/24 hosts are crowded and 7 planets were localized on real pixels in crowded/moderate fields -- the regime P45 never touched.
The difference-image gate wrongly vetoed 4 confirmed planets even on this sample -- it is NOT safe to gate.
P(FP) stays prior-dependent: a Gaia neighbour existing is not evidence it is an eclipsing binary, so
crowding raises the *count of candidate contaminants* but not a validated discrimination.

## The missing piece: a labelled NEGATIVE class

A veto's true power can only be measured against real off-target blends/EBs (labelled negatives); with
only confirmed planets (positives) you can measure over-kill, never catch-rate. Reachability probed:

- **ExoFOP-TESS** (per-candidate community dispositions): NOT anonymously reachable -- REST paths 404,
  the documented API needs a registered token. This is the source that would label "this candidate is a
  blend/EB", so a token (or an export) is the concrete blocker to the full acceptance test.
- **VizieR General Catalogue of Variable Stars (B/gcvs)**: REACHABLE anonymously -- 160 labelled variable-star rows returned (e.g. 1 | T And | x | 00 22 23.15).
  These give real eclipsing binaries at known positions -- a token-free positional negative class to test
  whether a localization veto fires on a genuine off-target blend. Wiring a per-candidate cone cross-match
  and building the full 2x2 (true-veto vs false-veto) on those pixels is now UNBLOCKED but not run here.

Honest status: the reviewer's requirement is now MEASURED (crowding-stratified localization + P(FP)),
and both veto tools remain `safeToGate: false`. The crowded-field localization is done; the crowded-field
TRUE-VETO power test needs the labelled negative class, whose reachability is established above.
`discoveryClaim: false`; research-only, nothing gated/anchored/deployed.
