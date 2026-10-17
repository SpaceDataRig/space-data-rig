# P59 the veto's catch-rate on the localization-addressable subset (not the lower bound)

Reproduce: `npm run p59:offtarget-subset -- --aperture 21 --min-sep 1.5`
P57/P58 reported the PSF veto's blend catch-rate over ALL FP/EB labels, and flagged it was a
LOWER bound because that class mixes off-target blends (which localization is built to catch) with
on-target eclipsing binaries (which it legitimately cannot). P59 splits the negatives on a Gaia
resolved-contaminant test: keep only cases with a companion star resolved >= 1.5" inside
the ~21" aperture -- the regime where a displaced source is physically possible -- and measure there.

Of 16 negatives with a catalog position, **13** had a resolved contaminant
(localization-addressable) and 3 had none (on-target / unresolved, excluded from the denominator).

**Refined catch-rate on the addressable subset: 2/13.** 2x2 {"trueVeto":2,"missedBlend":11,"falseVeto":1,"trueKeep":19}.
- veto power (addressable): 15% (95% CI 0.04-0.42)
- false-veto rate: 5% (unchanged -- a known planet wrongly killed; the disqualifier)
- ROC AUC on the addressable set: 0.742 vs P59's recompute of the all-negatives set 0.691 (P58 reported 0.694 before the offsets were rounded into this report)

Removing the on-target eclipsing binaries (which localization cannot separate) sharpens the
discrimination -- AUC rises -- but the catch-rate stays low: of the 13 addressable
negatives most carried a resolved companion several arcsec off the host and were still NOT vetoed,
and the single catch's offset did not coincide with the known companion's position. So even in the
regime a localization veto is built for, this PSF method is weak and its off-target flags do not
reliably land on the real contaminant -- a cleaner confirmation that it is not a usable blend-finder.

**VERDICT (addressable subset): safeToGate = false.** 1 real planet(s) wrongly vetoed (max 0) -- measure-before-gate disqualifies the gate

## Honest limits

A Gaia companion proves a resolved contaminant EXISTS, not that the dip came from it; unresolved
(< 1.5") blends and true on-target EBs are excluded, so this rate is the sensitivity in the
localization-addressable regime ONLY -- the number the reviewer asked for, but on a small subset and
with that proxy assumption. It does not change the standing conclusion: the false-veto rate is the
hard gate, and a single genuine known-planet kill keeps the veto research-only. Nothing gated;
discoveryClaim false.
