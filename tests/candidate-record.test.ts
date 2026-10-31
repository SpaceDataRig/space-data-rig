// R33: candidateRecord had NO test coverage before this round even though it is the typed candidate contract the
// discovery pipeline is meant to emit. This suite pins (a) its long-standing honesty invariants (discoveryClaim is
// structurally false; assertHonest refuses a flipped claim or an unearned "high" tier) and (b) the new earned-gate
// wiring: a self-emitted record can NEVER earn a discovery claim, because the gate keys on evidence a record does
// not carry (harmonic-alias FPP, PSF/diff-imaging, prospective precision, human sign-off) and those stay unmet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCandidateRecord,
  assertHonest,
  formatFollowupCard,
  type BuildInput,
  type CandidateRecord,
} from "../src/candidate/candidateRecord.ts";
import type { DiscoveryProtocol } from "../src/discover/discoveryGate.ts";

const PROTOCOL: DiscoveryProtocol = JSON.parse(readFileSync(resolve(process.cwd(), "discovery-protocol.json"), "utf8"));

function baseInput(over: Partial<BuildInput> = {}): BuildInput {
  return {
    host: { tic: 123456789, ra: 12.34, dec: -5.67, tmag: 9.8 },
    detection: { periodDays: 3.5123, epochBjd: 2459000.5, durationHours: 2.1, depthPpm: 4200, snr: 14.5, nSectors: 3, nPointsInTransit: 24 },
    novelty: { inConfirmed: false, inToi: false, confirmedScanned: 5200, toiScanned: 4100 },
    significance: { fap: 1e-6, rho: 0.31 },
    vetting: { blend: { tier: "low" } as never, geometry: { consistent: true } as never, centroidOffsetArcsec: 0.2, oddEvenAsymmetryFrac: 0.04 },
    nextTransitsBjd: [2459100.1, 2459103.6],
    dataTier: "real",
    catalogSource: { confirmed: "nasa-archive", toi: "exofop-toi", asOfUtc: "2026-01-01T00:00:00Z" },
    nowIso: "2026-01-01T00:00:00Z",
    ...over,
  };
}

test("a record carries no discovery assessment when no protocol is supplied", () => {
  const r = buildCandidateRecord(baseInput());
  assert.equal(r.discovery, undefined);
  assert.equal(r.discoveryClaim, false);
});

test("with the frozen protocol, every self-emitted record is denied a discovery claim", () => {
  const r = buildCandidateRecord(baseInput({ discoveryProtocol: PROTOCOL }));
  assert.ok(r.discovery, "discovery assessment should be present when a protocol is passed");
  // The claim is structurally false regardless of the gate tier.
  assert.equal(r.discoveryClaim, false);
  // A record can never reach "announcement": it lacks prospective validation + human sign-off + alias/PSF measurement.
  assert.notEqual(r.discovery!.tier, "announcement");
  assert.ok(r.discovery!.unmet.length > 0, "unmet reason trail must be non-empty and auditable");
});

test("even an unusually clean, novel, multi-sector record stays tier=none (records cannot self-earn)", () => {
  const clean = baseInput({
    discoveryProtocol: PROTOCOL,
    detection: { periodDays: 4.2, epochBjd: 2459000.5, durationHours: 2.0, depthPpm: 3500, snr: 22, nSectors: 4, nPointsInTransit: 30 },
    vetting: { blend: { tier: "low" } as never, geometry: { consistent: true } as never, centroidOffsetArcsec: 0.1, oddEvenAsymmetryFrac: 0.01 },
    significance: { fap: 1e-9, rho: 0.1 },
  });
  const r = buildCandidateRecord(clean);
  assert.equal(r.discovery!.tier, "none");
  assert.equal(r.discoveryClaim, false);
  // The binding reasons are precisely the things a record does not measure at emit time.
  const blob = r.discovery!.unmet.join(" | ").toLowerCase();
  assert.ok(blob.includes("alias") || blob.includes("prospective") || blob.includes("sign"), `expected prospective/signoff/alias in: ${blob}`);
});

test("a non-novel record reports the already-known bar unmet", () => {
  const r = buildCandidateRecord(baseInput({ discoveryProtocol: PROTOCOL, novelty: { inConfirmed: false, inToi: true, confirmedScanned: 5200, toiScanned: 4100 } }));
  assert.equal(r.discovery!.tier, "none");
  assert.ok(r.discovery!.unmet.some((u) => /known|novel|duplicate/i.test(u)), `expected a novelty/known reason: ${r.discovery!.unmet.join("; ")}`);
});

test("assertHonest rejects a flipped discoveryClaim", () => {
  const r = buildCandidateRecord(baseInput());
  const tampered = { ...r, discoveryClaim: true } as unknown as CandidateRecord;
  assert.throws(() => assertHonest(tampered), /discovery claim/);
});

test("assertHonest rejects a high tier granted to a non-novel signal", () => {
  // A genuinely clean record earns tier=high under the confidence classifier.
  const strong = buildCandidateRecord(baseInput({ thresholds: { minSnr: 7, maxFap: 0.05, centroidHighMaxArcsec: 1.0 } }));
  assert.equal(strong.tier, "high");
  // Forcing high on something that is actually in the confirmed catalog must be rejected.
  const bad = { ...strong, novelty: { inConfirmed: true, inToi: false, confirmedScanned: 5200, toiScanned: 4100 } } as CandidateRecord;
  assert.throws(() => assertHonest(bad), /non-novel|novel/i);
});

test("buildCandidateRecord is deterministic for fixed input", () => {
  const a = buildCandidateRecord(baseInput({ discoveryProtocol: PROTOCOL, bundleHash: "x".repeat(64) }));
  const b = buildCandidateRecord(baseInput({ discoveryProtocol: PROTOCOL, bundleHash: "x".repeat(64) }));
  assert.deepEqual(a, b);
});

test("the follow-up card surfaces the gate tier in plain ASCII", () => {
  const r = buildCandidateRecord(baseInput({ discoveryProtocol: PROTOCOL }));
  const card = formatFollowupCard(r);
  assert.match(card, /Earned-discovery gate: tier=none \(claim=false\)/);
  for (const ch of card) assert.ok(ch.charCodeAt(0) < 128, `non-ASCII char ${ch.charCodeAt(0)} in card`);
});
