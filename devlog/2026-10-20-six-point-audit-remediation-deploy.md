# Six-point external audit -- remediation batch and deploy (2026-10-20)

English long-form summary dispatched to the public feed for this batch, then archived here
byte-for-byte. The rig closed a six-point external audit and deployed; this post reports the
measurable deltas and states the standing limits honestly.

## Dispatch evidence

- Dispatch accepted: HTTP `204` (POST .../workflows/x-post.yml/dispatches ref=main, inputs.text=<these bytes>, inputs.maxlen=25000).
- Actions run: https://github.com/SpaceDataRig/space-data-rig/actions/runs/39371685864 (event=workflow_dispatch, conclusion: success, head_sha 963ccf4).
- Job-log send line: `x:post: OK posted (id 2112406103032287631).` (2026-10-20T04:50:36Z).
- posted id: `2112406103032287631`.
- Pre-flight guard (`npm run x:post -- --text-file out/en.txt --max-len 25000`, no local keys): DRY RUN, length=1429/25000, zero non-ASCII, zero over-claim violations.
- Deploy self-proof: `/health` gitSha == HEAD 963ccf4443a8fc7ef6c8a7cafa228127fe4a5d5b; CI run for that commit https://github.com/SpaceDataRig/space-data-rig/actions/runs/39370783015 conclusion: success.

## Commits in the batch (audit items)

- #1 fe0c268 -- purge the withdrawn coverage-loss figure; both posters report-driven.
- #6 724cfc1 -- candidate countdown projected live from the ephemeris.
- #5 b1fd728 -- degenerate fits no longer "physically-consistent"; harmonics +x4/+x1/4; SNR optima marked indicative.
- #3 b4f1518 -- freshness gate coverage widened (stamped 8->12 of 54, verified 6->8); ExoFOP timeout 45s->180s; P76 relabeled point-in-time.
- #4 f31b87a -- README on-chain/memo claim bounded to what it proves.
- #2 was already live from the prior batch (verified: no false provenance banner).
- figure f64f70e + gallery manifest 963ccf4.

## Measured deltas (as published, from committed reports + a live fetch after deploy)

- report-library freshness: stamped 8 -> 12 of 54; machine-verified 6 -> 8. p59 and p90 now correctly flagged STALE (their tracked source inputs changed; shipped marked-red, not silent).
- P76 multi-source novelty: research.json + app.js render it as a point-in-time snapshot, stamped=false, not continuously re-verified.
- the withdrawn coverage-loss figure: live fetch of both posters returns no match.
- app.js no longer reads the baked day-count; the countdown is projected from epoch + period.

## What was NOT done here (honest gaps)

- p92 and p76 committed reports were not regenerated: their MAST/S3 and ExoFOP legs are not reproducible in this environment; only the generators were wired to stamp on a future networked run.
- the crossmatch tri-state lookup (hit / published-but-off-slice / failed-lookup) remains deferred: it would move the content address and cannot be live-calibrated here.
- no production verdict threshold, gate meaning, bundle field, or anchored address was changed.

## Verbatim posted text

The block below is the exact text handed to the dispatcher (normalised CRLF -> LF, trailing newlines trimmed -- the same normalisation `post-x-text.ts` applies before sending).

## Text as pushed

```
Six-point external audit of our TESS transit research rig -- closed item by item and deployed.

- A withdrawn coverage-loss figure is gone from both posters; a live fetch after deploy returns no match.
- The provenance gate now machine-re-hashes 8 of 54 reports as verified (was 6), and 12 of 54 carry a re-hashable stamp.
- The P76 multi-source check is relabeled a point-in-time snapshot: its ExoFOP table is a ~3.8 MB pull a throttled mirror cannot re-fetch, so it is no longer printed on the home page as a live number.
- README's on-chain wording is bounded to what it proves: a memo is freely re-readable, but a bundle hash is timestamped and each re-seal moves it, so the verify endpoint checks the served bytes, not the chain.
- Degenerate fits are no longer described as physically consistent; the alias harmonic set widened with x4 and x1/4.
- The candidate countdown is projected from each ephemeris rather than read from a frozen day count.

Two reports ship marked STALE rather than silent: their tracked inputs changed and they need a re-run with network access. Every number here is re-derived from committed reports, and none of it widens a gate or backs a claim.

repo: github.com/SpaceDataRig/space-data-rig
site: spacedatarig.app

Proof links:
https://github.com/SpaceDataRig/space-data-rig/actions/runs/39370783015
https://github.com/SpaceDataRig/space-data-rig/commit/963ccf4443a8fc7ef6c8a7cafa228127fe4a5d5b
```
