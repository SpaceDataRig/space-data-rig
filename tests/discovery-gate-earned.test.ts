// R31: the earned discovery gate must be non-vacuous in BOTH directions. It is the mechanism that lets a discovery
// claim be EARNED rather than toggled -- so the failure modes we must rule out are (a) a gate that always says "none"
// (a door that can never open -- the claim can never be earned, defeating the point), and (b) a gate that opens too
// easily (a claim fireable without prospective validation or human sign-off -- crossing the red line). These tests
// pin the middle: today (no prospective run, nothing signed) every candidate is denied the claim, AND a fully-earned
// synthetic candidate reaches announcement with the claim permitted, AND each missing prerequisite drops it a tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDiscoveryGate, wilsonLowerBound, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";

// Load the REAL frozen protocol the gate keys on -- not a copy -- so the test proves the shipped criteria, not a
// fixture that could be softer than what the site implies.
const PROTOCOL: DiscoveryProtocol = JSON.parse(readFileSync(resolve(process.cwd(), "discovery-protocol.json"), "utf8"));

// A candidate that clears every per-candidate corroboration + significance bar. Prospective/signoff left off by design.
function earnedNomination(): CandidateEvidence {
  return {
    novelty: { inConfirmed: false, inToi: false, confirmedScanned: 5000, toiScanned: 4000 },
    corroboration: {
      crossSectorEphemerisCoherentSectors: 2,
      catalogDuplicate: false,
      gaiaBlendRuledOut: true,
      psfOrDiffImagingClear: true,
      harmonicAliasFpp: 0.002,
      oddEvenAsymmetryFrac: 0.05,
    },
    significance: { snr: 12, ar1FalseAlarmProb: 0.0001 },
    prospective: null,
    signoff: null,
  };
}

test("the gate is keyed to a pre-registered protocol (a non-frozen criteria set must deny everything)", () => {
  const c = earnedNomination();
  const thawed = { ...PROTOCOL, status: "DRAFT-not-frozen" };
  const r = evaluateDiscoveryGate(c, thawed);
  assert.equal(r.tier, "none", "an un-frozen protocol must not let any claim be earned (criteria could move after results)");
  assert.ok(r.unmet.some((u) => /pre-registered/i.test(u)));
});

test("TODAY nothing is claimable: an all-bars-passing candidate WITHOUT prospective validation is only a nomination, never a claim", () => {
  const r = evaluateDiscoveryGate(earnedNomination(), PROTOCOL);
  assert.equal(r.tier, "nomination", "corroboration+significance pass, so it earns nomination...");
  assert.equal(r.discoveryClaimAllowed, false, "...but NOT a discovery claim: no prospective validation, no sign-off");
  assert.ok(r.unmet.some((u) => /prospective/i.test(u)), "the reason must name the missing prospective validation");
  assert.ok(r.unmet.some((u) => /sign-off/i.test(u)), "the reason must name the missing human sign-off");
});

test("each failed corroboration/significance bar drops an otherwise-earned candidate to 'none' (no claim without every bar)", () => {
  const mutations: Array<[string, (c: CandidateEvidence) => void]> = [
    ["blend not ruled out", (c) => { c.corroboration.gaiaBlendRuledOut = false; }],
    ["instrumental not cleared", (c) => { c.corroboration.psfOrDiffImagingClear = false; }],
    ["only one coherent sector", (c) => { c.corroboration.crossSectorEphemerisCoherentSectors = 1; }],
    ["harmonic alias too high", (c) => { c.corroboration.harmonicAliasFpp = 0.5; }],
    ["odd/even shape inconsistent", (c) => { c.corroboration.oddEvenAsymmetryFrac = 0.9; }],
    ["below SNR floor", (c) => { c.significance.snr = 3; }],
    ["AR1 FAR too high", (c) => { c.significance.ar1FalseAlarmProb = 0.2; }],
    ["already known (not novel)", (c) => { c.novelty.inToi = true; }],
    ["novelty scan unavailable", (c) => { c.novelty.confirmedScanned = -1; }],
  ];
  for (const [name, apply] of mutations) {
    const c = earnedNomination();
    apply(c);
    const r = evaluateDiscoveryGate(c, PROTOCOL);
    assert.equal(r.tier, "none", `mutation "${name}" must deny even the nomination tier`);
    assert.equal(r.discoveryClaimAllowed, false, name);
  }
});

test("a fully-earned candidate -- every bar + prospective precision above the floor + a human sign-off -- reaches announcement", () => {
  const c = earnedNomination();
  c.prospective = { validated: true, precisionWilsonLowerBound: 0.97, expectedFalseClaims: 0.1 };
  c.signoff = { humanApproved: true, reviewer: "science-lead@example" };
  const r = evaluateDiscoveryGate(c, PROTOCOL);
  assert.equal(r.tier, "announcement", r.unmet.join("; "));
  // Even here the automated path is forbidden; discoveryClaim is only ever set by the signed human writer.
  assert.equal(r.discoveryClaimAllowed, false, "automated writers may never set the claim, even at announcement (protocol.release)");
});

test("announcement is withheld when the prospective run does not clear the floor, or no human signed", () => {
  const lowPrecision = earnedNomination();
  lowPrecision.prospective = { validated: true, precisionWilsonLowerBound: 0.61, expectedFalseClaims: 0 }; // p99's actual held-out
  lowPrecision.signoff = { humanApproved: true, reviewer: "x@y" };
  const r1 = evaluateDiscoveryGate(lowPrecision, PROTOCOL);
  assert.equal(r1.tier, "nomination", "0.61 precision is below the floor -> nomination only, no announcement");
  assert.ok(r1.unmet.some((u) => /precision/i.test(u)));

  const signedOffMissing = earnedNomination();
  signedOffMissing.prospective = { validated: true, precisionWilsonLowerBound: 0.98, expectedFalseClaims: 0.0 };
  const r2 = evaluateDiscoveryGate(signedOffMissing, PROTOCOL);
  assert.equal(r2.tier, "nomination", "prospective clears but no human sign-off -> not announcement");
  assert.ok(r2.unmet.some((u) => /sign-off/i.test(u)));
});

test("wilsonLowerBound is monotone and sane (the precision floor the gate keys on is computed correctly)", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(100, 100) > 0.95, "a perfect sample of 100 clears the 0.95 floor");
  assert.ok(wilsonLowerBound(61, 100) < 0.65 && wilsonLowerBound(61, 100) > 0.5, "a coin-flip sample stays low");
  assert.ok(wilsonLowerBound(95, 100) < 95 / 100, "the lower bound is strictly below the point estimate");
});
