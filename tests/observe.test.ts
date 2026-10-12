// Named-observation contract layer: dedication sanitizer, burn-payment policy, x402 wire shapes, and the
// observation envelope validator. Offline + deterministic; no chain, no network. The load-bearing tests: a
// record that claims a discovery is REJECTED, a payment that is not the EXACT $SDR burn is REJECTED, and the
// dedication length is measured in Unicode code points (not UTF-16 units).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDedication, codePointLength, DEDICATION_MAX_CODEPOINTS } from "../src/observe/dedication.ts";
import {
  evaluateBurnPayment,
  OBSERVATION_COST_RAW,
  SDR_MINT,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  X402_NETWORK,
  type BurnPaymentFacts,
} from "../src/observe/paymentPolicy.ts";
import { buildPaymentRequired, parsePaymentEnvelope, buildPaymentResponse, X402_VERSION } from "../src/observe/x402.ts";
import { validateObservation, observeEnvelopeHash, OBSERVATION_SCHEMA, type ObservationRecord } from "../src/observe/observation.ts";

// ---- dedication -----------------------------------------------------------

test("dedication: normal text is accepted and trimmed", () => {
  const r = sanitizeDedication("  for my father, March 2019  ");
  assert.equal(r.ok, true);
  assert.equal((r as { value: string }).value, "for my father, March 2019");
});

test("dedication: length is counted in CODE POINTS, not UTF-16 units", () => {
  assert.equal(DEDICATION_MAX_CODEPOINTS, 160);
  // 160 emoji = 160 code points but 320 UTF-16 units; must PASS the 160 cap.
  const face = "\u{1F600}";
  const ok160 = sanitizeDedication(face.repeat(160));
  assert.equal(ok160.ok, true);
  assert.equal(codePointLength(face.repeat(160)), 160);
  // 161 code points must FAIL.
  const bad161 = sanitizeDedication(face.repeat(161));
  assert.equal(bad161.ok, false);
});

test("dedication: non-Latin names are allowed", () => {
  const r = sanitizeDedication("\u4E2D\u6587\u540D \u00C9lodie \u042E\u0440\u0438\u0439");
  assert.equal(r.ok, true);
});

test("dedication: links, domains and angle brackets are rejected", () => {
  assert.equal(sanitizeDedication("visit http://evil.example").ok, false);
  assert.equal(sanitizeDedication("see www.spam.example").ok, false);
  assert.equal(sanitizeDedication("buy now mysite.com").ok, false);
  assert.equal(sanitizeDedication("<script>alert(1)</script>").ok, false);
});

test("dedication: control chars collapse, invisible format chars removed, empty rejected", () => {
  const cleaned = sanitizeDedication("a\u{200B}b\nc\td");
  assert.equal(cleaned.ok, true);
  // zero-width space is REMOVED (a+b join); newline/tab collapse to a single space.
  assert.equal((cleaned as { value: string }).value, "ab c d");
  assert.equal(sanitizeDedication("   \n\t  ").ok, false);
  assert.equal(sanitizeDedication(123 as unknown).ok, false);
});

// ---- burn payment policy --------------------------------------------------

function burn(over: Partial<BurnPaymentFacts> = {}): BurnPaymentFacts {
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    mint: SDR_MINT,
    amountRaw: OBSERVATION_COST_RAW,
    isBurn: true,
    payer: "SomePayerPubkey",
    finalized: true,
    ...over,
  };
}

test("policy constant: cost is exactly 10000 * 10^6 base units", () => {
  assert.equal(OBSERVATION_COST_RAW, 10_000_000_000n);
});

test("payment: a correct finalized $SDR burn passes", () => {
  assert.equal(evaluateBurnPayment(burn()).ok, true);
});

test("payment: amount must be EXACTLY the cost (off-by-one rejected)", () => {
  assert.equal(evaluateBurnPayment(burn({ amountRaw: OBSERVATION_COST_RAW - 1n })).ok, false);
  assert.equal(evaluateBurnPayment(burn({ amountRaw: OBSERVATION_COST_RAW + 1n })).ok, false);
});

test("payment: not-a-burn / wrong mint / wrong program / unfinalized all rejected", () => {
  assert.equal(evaluateBurnPayment(burn({ isBurn: false })).ok, false);
  assert.equal(evaluateBurnPayment(burn({ mint: "WRONGmint1111111111111111111111111111111111" })).ok, false);
  assert.equal(evaluateBurnPayment(burn({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" })).ok, false);
  assert.equal(evaluateBurnPayment(burn({ finalized: false })).ok, false);
});

// ---- x402 wire shapes -----------------------------------------------------

test("x402 challenge: encodes the burn semantics correctly", () => {
  const c = buildPaymentRequired({ resource: "https://spacedatarig.app/api/observe", description: "Name an observation" });
  assert.equal(c.x402Version, X402_VERSION);
  const a = c.accepts[0];
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, X402_NETWORK);
  assert.equal(a.maxAmountRequired, "10000000000");
  assert.equal(a.payTo, SYSTEM_PROGRAM_ID); // no merchant
  assert.equal(a.asset, SDR_MINT);
  assert.equal(a.extra.burn, true);
  assert.equal(a.extra.tokenProgram, TOKEN_2022_PROGRAM_ID);
});

test("x402 payment envelope: valid parses, wrong scheme/network/missing-tx rejected", () => {
  const good = { x402Version: X402_VERSION, scheme: "exact", network: X402_NETWORK, payload: { transaction: "base64tx" } };
  assert.equal(parsePaymentEnvelope(good).ok, true);
  assert.equal(parsePaymentEnvelope({ ...good, scheme: "transfer" }).ok, false);
  assert.equal(parsePaymentEnvelope({ ...good, network: "eip155:1" }).ok, false);
  assert.equal(parsePaymentEnvelope({ ...good, payload: {} }).ok, false);
  assert.equal(parsePaymentEnvelope(null).ok, false);
});

test("x402 response: success header carries the burn signature", () => {
  const r = buildPaymentResponse("sig123", "https://explorer.solana.com/tx/sig123", "2026-10-12T00:00:00.000Z");
  assert.equal(r.success, true);
  assert.equal(r.transaction, "sig123");
});

// ---- observation envelope -------------------------------------------------

function rec(over: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    schema: OBSERVATION_SCHEMA,
    observationId: "OBS-0001",
    createdAt: "2026-10-12T09:00:00.000Z",
    tic: 139114989,
    sector: 1,
    dedication: "for my father, March 2019",
    payment: { network: X402_NETWORK, mint: SDR_MINT, amountRaw: OBSERVATION_COST_RAW.toString(), scheme: "burn", txSignature: null, verified: false },
    science: { bundleHash: null, verdict: null },
    anchor: { memo: null, signature: null },
    status: "awaiting-payment",
    discoveryClaim: false,
    ...over,
  };
}

test("observation: a well-formed record validates", () => {
  assert.equal(validateObservation(rec()).ok, true);
});

test("observation HONESTY INVARIANT: a discovery claim is rejected", () => {
  const bad = rec({ discoveryClaim: true as unknown as false });
  const v = validateObservation(bad);
  assert.equal(v.ok, false);
  assert.ok((v as { errors: string[] }).errors.some((e) => /discoveryClaim MUST be false/.test(e)));
});

test("observation: unsanitized dedication and wrong payment amount are rejected", () => {
  assert.equal(validateObservation(rec({ dedication: "  padded with spaces  " })).ok, false);
  assert.equal(validateObservation(rec({ dedication: "click http://x.io" })).ok, false);
  const p = { ...rec().payment, amountRaw: "1" };
  assert.equal(validateObservation(rec({ payment: p })).ok, false);
});

test("observation: sealed null-result record validates (a zero is a first-class outcome)", () => {
  const r = rec({
    payment: { network: X402_NETWORK, mint: SDR_MINT, amountRaw: OBSERVATION_COST_RAW.toString(), scheme: "burn", txSignature: "sig", verified: true },
    science: { bundleHash: "a".repeat(64), verdict: "no-transit" },
    status: "sealed",
  });
  assert.equal(validateObservation(r).ok, true);
});

test("observation: envelope hash is deterministic and binds the dedication", async () => {
  const bundleHash = "b".repeat(64);
  const h1 = await observeEnvelopeHash("for my father", bundleHash);
  const h1b = await observeEnvelopeHash("for my father", bundleHash);
  const h2 = await observeEnvelopeHash("a different name", bundleHash);
  assert.equal(h1, h1b); // deterministic
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, h2); // dedication is committed to
});
