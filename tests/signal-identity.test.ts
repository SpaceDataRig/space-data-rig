// audit-16: the SIGNAL IDENTITY kernel is pure, so its behaviour is testable on hand-built rows here; the same
// predicates are then driven over CAPTURED PRODUCTION bytes by tests/live-catalog-accounting.test.ts -- both halves
// matter: synthetic rows pin the rules, real rows pin the population (round-14/15 proved a synthetic-only gate
// silently covers part of the set).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostKeyOf, labelDesignatorOf, knownDesignatorOf, signalKeyOf, labelConflict, groupBySignal, candidateNumberToLetter, designatorKindOf } from "../src/core/signal-identity.ts";

test("hostKeyOf reduces every naming scheme to the STAR, stripping candidate numbers AND designators", () => {
  assert.equal(hostKeyOf("HR 858 d"), "hr 858");
  assert.equal(hostKeyOf("TOI-1821.01"), "toi-1821");
  assert.equal(hostKeyOf("TOI-4443 c"), "toi-4443");
  assert.equal(hostKeyOf("TOI-2016.01 b"), "toi-2016", "compound: both a candidate number AND a planet letter");
  assert.equal(hostKeyOf("KELT-9 b"), "kelt-9");
  assert.equal(hostKeyOf("HAT-P-11"), "hat-p-11", "hyphenated names keep their digits -- the 11 is part of the star name here");
  assert.equal(hostKeyOf("tic 2228"), "tic 2228");
  assert.equal(hostKeyOf("HD 260655 b"), "hd 260655");
  // audit-17 defect 2: a stellar COMPONENT letter is part of the star's identity, not a planet designator, so it is
  // KEPT -- the two components of a binary are different stars and must never share a host key.
  assert.equal(hostKeyOf("HD 202772 A b"), "hd 202772 a", "only the planet letter is stripped; the component survives");
  assert.equal(hostKeyOf("HD 202772 B b"), "hd 202772 b");
  assert.notEqual(hostKeyOf("HD 202772 A b"), hostKeyOf("HD 202772 B b"), "binary components A and B are distinct hosts");
  assert.equal(hostKeyOf("DS Tuc A b"), "ds tuc a");
  // the D1 pairs reduce to ONE key:
  assert.equal(hostKeyOf("TOI-4443.01"), hostKeyOf("TOI-4443 c"), "the two label FORMS of one seat collapse to one host");
});

test("designator extraction reads the requested letter from a label and the detected letter from a crossmatch", () => {
  assert.equal(labelDesignatorOf("HR 858 d"), "d");
  // audit-17 defect 1: a candidate NUMBER is a decodable claim, not "no claim". Refusing to decode it is what let
  // TOI-6054.02 (whose own crossmatch says TOI-6054.01) sail through as labelConflictsWithKnown:false.
  assert.equal(labelDesignatorOf("TOI-2016.01"), "b", "candidate .01 decodes to planet b by the ExoFOP convention");
  assert.equal(labelDesignatorOf("TOI-6054.02"), "c", "candidate .02 decodes to planet c");
  assert.equal(knownDesignatorOf("HD 260655 b"), "b");
  assert.equal(knownDesignatorOf("TOI-4443.01"), "b", "the detected side decodes candidate numbers on the same rule");
});

test("candidateNumberToLetter maps the ExoFOP index and refuses to invent a letter past z", () => {
  assert.equal(candidateNumberToLetter("01"), "b");
  assert.equal(candidateNumberToLetter("02"), "c");
  assert.equal(candidateNumberToLetter("25"), "z");
  assert.equal(candidateNumberToLetter("26"), null, "no single-letter planet designator exists beyond z -> undecodable, not a wrong letter");
  assert.equal(candidateNumberToLetter("00"), null, "candidate indices are 1-based");
});

test("designatorKindOf separates a literal letter, a decoded candidate number, and no claim at all (Legacy 4)", () => {
  assert.equal(designatorKindOf("HR 858 d"), "planet-letter");
  assert.equal(designatorKindOf("TOI-2016.01"), "candidate-number");
  assert.equal(designatorKindOf("TIC 2228"), "none");
  // the ambiguity the audit named: a null requestedDesignator now says WHY via the kind.
  assert.equal(labelDesignatorOf("TIC 2228"), null);
  assert.equal(designatorKindOf("TIC 2228"), "none", "null + kind 'none' = genuinely no claim, distinct from a decoded number");
});

test("labelConflict flags exactly the D1 self-contradiction: same star, different planet designator", () => {
  const conflict = labelConflict("HR 858 d", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" });
  assert.equal(conflict.conflict, true, "a card titled d whose own crossmatch says b is a contradiction");
  assert.deepEqual([conflict.requested, conflict.detected], ["d", "b"]);
  assert.deepEqual([conflict.requestedKind, conflict.detectedKind], ["planet-letter", "planet-letter"]);
  assert.equal(labelConflict("HR 858 b", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" }).conflict, false, "agreement is not a conflict");
  // audit-17 defect 1: a candidate NUMBER now decodes, so these two live rows are caught instead of sailing through.
  const c1 = labelConflict("TOI-6054.02", { matchedKnownPlanet: true, knownPlanetName: "TOI-6054.01" });
  assert.equal(c1.conflict, true, "label claims candidate .02 (=c) but its own crossmatch says .01 (=b)");
  assert.deepEqual([c1.requested, c1.detected, c1.requestedKind, c1.detectedKind], ["c", "b", "candidate-number", "candidate-number"]);
  const c2 = labelConflict("TOI-4443 c", { matchedKnownPlanet: true, knownPlanetName: "TOI-4443.01" });
  assert.equal(c2.conflict, true, "label claims planet c but its own crossmatch says candidate .01 (=b)");
  assert.deepEqual([c2.requested, c2.detected, c2.requestedKind, c2.detectedKind], ["c", "b", "planet-letter", "candidate-number"]);
  assert.equal(labelConflict("TOI-2016.01", { matchedKnownPlanet: true, knownPlanetName: "TOI-2016 b" }).conflict, false, ".01 decodes to b, which AGREES with the crossmatched b -> no conflict");
  // audit-17 defect 2: two different stars of a binary are NOT a self-contradiction, even with different letters.
  assert.equal(labelConflict("HD 202772 A c", { matchedKnownPlanet: true, knownPlanetName: "HD 202772 B b" }).conflict, false, "component A and component B are different stars -> not same-host");
  assert.equal(labelConflict("DS Tuc A b", { matchedKnownPlanet: true, knownPlanetName: "DS Tuc B c" }).conflict, false);
  assert.equal(labelConflict("WASP-12 b", { matchedKnownPlanet: true, knownPlanetName: "KEPLER-12 b" }).conflict, false, "different stars: crossmatch noise, not a same-host label conflict");
  assert.equal(labelConflict("HR 858 d", undefined).conflict, false, "no crossmatch at all -> nothing to contradict");
});

test("signalKeyOf merges one physical candidate across labels and separates distinct planets of one host", () => {
  const a = signalKeyOf("HR 858 d", 3.587214258080734, 103e-6, 11.637689);
  const b = signalKeyOf("HR 858 b", 3.587214258080734, 103e-6, 11.637689);
  assert.equal(a, b, "same star, same period/depth/snr -> one signal regardless of the seat label");
  assert.notEqual(signalKeyOf("TOI-1469.01", 2.1, 500e-6, 9), signalKeyOf("TOI-1469.02", 2.4, 500e-6, 9), "a genuinely different period is a different signal");
  assert.notEqual(signalKeyOf("HR 858 b", 3.587214258080734, 103e-6, 11.637689), signalKeyOf("HR 858 c", 4.5, 103e-6, 11.6), "different measured numbers stay distinct");
});

test("groupBySignal collapses the duplicate-label rows and leaves unique signals alone", () => {
  const rows = [
    { targetId: "HR 858 b", candidate: { periodDays: 3.587214258080734, depthFrac: 103e-6, snr: 11.637689 } },
    { targetId: "HR 858 c", candidate: { periodDays: 3.587214258080734, depthFrac: 103e-6, snr: 11.637689 } },
    { targetId: "HR 858 d", candidate: { periodDays: 3.587214258080734, depthFrac: 103e-6, snr: 11.637689 } },
    { targetId: "TOI-9999.01", candidate: { periodDays: 1.5, depthFrac: 400e-6, snr: 20 } },
  ];
  const groups = [...groupBySignal(rows).values()];
  assert.equal(groups.length, 2, "three seat labels over one recovered signal collapse to one group");
  assert.equal(groups.find((g) => g.length === 3)?.[0].targetId, "HR 858 b", "the first-minted label leads the group");
});

// ---- round-18 audit defect 4/5: the COST of keeping the component letter, pinned as a positive test ----------
// audit-17 defect 2 made hostKeyOf keep a stellar component ("HD 202772 A b" -> "hd 202772 a") so the two stars of
// a binary can never be falsely merged. That benefit has a price the round-17 note claimed but never tested, and
// the audit is right that an unpriced trade is a latent bug: the strip is UNCONDITIONAL (it removes one trailing
// letter whether or not a planet designator follows), and same-host is decided by string equality of the two keys.
// So when the LABEL carries a component but the crossmatched name does NOT, the two host keys differ and a real
// designator disagreement is SUPPRESSED -- and signalKeyOf, keyed on the same host, will not merge the two either.
// These assertions pin that behaviour EXACTLY as measured on the live catalog before pinning, so it is a known,
// tested trade rather than a surprise, and so any future change to it -- e.g. the deferred mint guard reusing
// signalKey -- has to confront it deliberately. It is LATENT, not live: the served catalog holds 0 bare-component
// labels and 0 asymmetric-component rows (measured), so no served count changes today; the code is intentionally NOT
// altered (a no-op on live data is not worth a deploy), only documented and tested.
test("hostKeyOf strips a trailing letter UNCONDITIONALLY, so a BARE component loses it (the documented cost)", () => {
  assert.equal(hostKeyOf("HD 202772 A b"), "hd 202772 a", "component KEPT when a planet letter follows it");
  assert.equal(hostKeyOf("HD 202772 A"), "hd 202772", "BARE component: the A is stripped (prose says 'kept'; code strips one trailing letter)");
  assert.equal(hostKeyOf("HD 202772 A"), hostKeyOf("HD 202772 B"), "so two BARE components collide -- latent, 0 live rows carry a bare component");
});

test("component asymmetry SUPPRESSES a real label conflict and blocks the signal merge (cost of the component-preserving key)", () => {
  // The label says component A, planet c; the crossmatched known name says planet b with NO component. The designators
  // genuinely differ (c vs b), yet conflict is false purely because the host keys differ ("hd 202772 a" vs "hd 202772").
  const asym = labelConflict("HD 202772 A c", { matchedKnownPlanet: true, knownPlanetName: "HD 202772 b" });
  assert.equal(asym.conflict, false, "SUPPRESSED: sameHost is false because only one side carries the component letter");
  assert.deepEqual([asym.requested, asym.detected], ["c", "b"], "the designators still disagree -- the suppression is in sameHost, not in the decode");
  assert.notEqual(hostKeyOf("HD 202772 A c"), hostKeyOf("HD 202772 b"), "hd 202772 a != hd 202772");
  // The same host key feeds signalKeyOf, so the two rows are NOT merged despite identical period/depth/snr.
  assert.notEqual(
    signalKeyOf("HD 202772 A c", 3.5, 500e-6, 12),
    signalKeyOf("HD 202772 b", 3.5, 500e-6, 12),
    "NOT merged: if a future mint guard dedups on signalKey, this asymmetry would let a duplicate through -- pinned so it is a decision, not an accident",
  );
  // Control: when BOTH sides carry the same component, the conflict IS caught -- the suppression is asymmetric, not a
  // blanket disable, which is exactly why the asymmetric case above is the dangerous one.
  assert.equal(
    labelConflict("HD 202772 A c", { matchedKnownPlanet: true, knownPlanetName: "HD 202772 A b" }).conflict,
    true,
    "same component on both sides -> same host -> c vs b IS flagged",
  );
});

// audit-17 Legacy 2 -- the committed fixture (tests/fixtures/live-catalog.json) was captured BEFORE the disclosure
// fields existed, so it cannot compare the kernel's verdict to the value a handler actually SERVES; without a guard,
// "the projection drifted from the kernel" would pass CI silently -- the exact blind spot the seventeenth audit named.
// Both handlers serve `labelConflictsWithKnown: lc.conflict` from a SINGLE labelConflict(f.targetId, f.crossmatch)
// call, so served == kernel BY CONSTRUCTION; this asserts that construction holds on BOTH runtimes (a handler that
// dropped a field, or re-decoded a designator itself, would fork the rule and fail here). The deployed bytes are then
// re-checked against the same kernel live (HANDOFF verify step), so this offline gate and the live probe bracket the
// served value from both sides -- no fixture re-capture needed to catch a wiring/served divergence.
test("audit-17 wiring (structural): BOTH findingViews serve all five disclosure fields from ONE kernel call, and the board renders the served flag without re-decoding", () => {
  const worker = readFileSync(resolve(process.cwd(), "src", "cf", "worker.ts"), "utf8");
  const node = readFileSync(resolve(process.cwd(), "src", "api", "server.ts"), "utf8");
  for (const [name, src] of [["worker.ts", worker], ["server.ts", node]] as const) {
    assert.match(src, /labelConflict\(f\.targetId, f\.crossmatch\)/, `${name} derives the disclosure from the shared kernel, once`);
    assert.match(src, /requestedDesignator: lc\.requested/, `${name} serves requestedDesignator from the kernel result`);
    assert.match(src, /requestedDesignatorKind: lc\.requestedKind/, `${name} serves requestedDesignatorKind (Legacy 4 disambiguation)`);
    assert.match(src, /detectedDesignator: lc\.detected/, `${name} serves detectedDesignator`);
    assert.match(src, /detectedDesignatorKind: lc\.detectedKind/, `${name} serves detectedDesignatorKind`);
    assert.match(src, /labelConflictsWithKnown: lc\.conflict/, `${name} serves the flag AS lc.conflict -- served == kernel by construction`);
  }
  // Legacy 1 wiring: the board RENDERS the served flag and must NOT reimplement the decode/conflict rule in the browser,
  // so the card can never fork from the API it mirrors.
  const app = readFileSync(resolve(process.cwd(), "web", "app.js"), "utf8");
  assert.match(app, /if \(!f\.labelConflictsWithKnown\) return "";/, "the card gates on the SERVED conflict flag");
  assert.match(app, /label-conflict-note/, "the card prints the conflict where a human reader sees it");
  assert.doesNotMatch(app, /candidateNumberToLetter/, "the browser must NOT reimplement the candidate-number decode; it reads the served designator");
});

