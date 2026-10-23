// audit-16: the SIGNAL IDENTITY kernel is pure, so its behaviour is testable on hand-built rows here; the same
// predicates are then driven over CAPTURED PRODUCTION bytes by tests/live-catalog-accounting.test.ts -- both halves
// matter: synthetic rows pin the rules, real rows pin the population (round-14/15 proved a synthetic-only gate
// silently covers part of the set).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostKeyOf, labelDesignatorOf, knownDesignatorOf, signalKeyOf, labelConflict, groupBySignal } from "../src/core/signal-identity.ts";

test("hostKeyOf reduces every naming scheme to the STAR, stripping candidate numbers AND designators", () => {
  assert.equal(hostKeyOf("HR 858 d"), "hr 858");
  assert.equal(hostKeyOf("TOI-1821.01"), "toi-1821");
  assert.equal(hostKeyOf("TOI-4443 c"), "toi-4443");
  assert.equal(hostKeyOf("TOI-2016.01 b"), "toi-2016", "compound: both a candidate number AND a planet letter");
  assert.equal(hostKeyOf("KELT-9 b"), "kelt-9");
  assert.equal(hostKeyOf("HAT-P-11"), "hat-p-11", "hyphenated names keep their digits -- the 11 is part of the star name here");
  assert.equal(hostKeyOf("tic 2228"), "tic 2228");
  assert.equal(hostKeyOf("HD 260655 b"), "hd 260655");
  // the D1 pairs reduce to ONE key:
  assert.equal(hostKeyOf("TOI-4443.01"), hostKeyOf("TOI-4443 c"), "the two label FORMS of one seat collapse to one host");
});

test("designator extraction reads the requested letter from a label and the detected letter from a crossmatch", () => {
  assert.equal(labelDesignatorOf("HR 858 d"), "d");
  assert.equal(labelDesignatorOf("TOI-2016.01"), null, "a candidate NUMBER is not a planet letter -- no claim to compare");
  assert.equal(knownDesignatorOf("HD 260655 b"), "b");
});

test("labelConflict flags exactly the D1 self-contradiction: same star, different planet letter", () => {
  const conflict = labelConflict("HR 858 d", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" });
  assert.equal(conflict.conflict, true, "a card titled d whose own crossmatch says b is a contradiction");
  assert.deepEqual([conflict.requested, conflict.detected], ["d", "b"]);
  assert.equal(labelConflict("HR 858 b", { matchedKnownPlanet: true, knownPlanetName: "HR 858 b" }).conflict, false, "agreement is not a conflict");
  assert.equal(labelConflict("TOI-2016.01", { matchedKnownPlanet: true, knownPlanetName: "TOI-2016 b" }).conflict, false, "no letter on the label -> no claimed disagreement");
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
