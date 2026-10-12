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
  resolveAnchorDailyCap,
  type BurnPaymentFacts,
} from "../src/observe/paymentPolicy.ts";
import { buildPaymentRequired, parsePaymentEnvelope, buildPaymentResponse, parsePaymentSignature, X402_VERSION } from "../src/observe/x402.ts";
import { verifyBurnTx, verifyBurnBySignature, type RpcTransactionLike } from "../src/observe/burnVerify.ts";
import { validateObservation, observeEnvelopeHash, OBSERVATION_SCHEMA, type ObservationRecord } from "../src/observe/observation.ts";
import { computeObservation, commissionObservation } from "../src/observe/observeApi.ts";
import { handleBrowserRpcProxy, RPC_READ_ALLOWLIST, type RpcFetch } from "../src/observe/rpcProxy.ts";

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

// ---- server-side compute: policy is enforced BEFORE any network is touched ----

test("computeObservation rejects a non-positive / non-integer tic with 400, no fetch", async () => {
  const r = await computeObservation({ tic: 0, dedication: "for dad" });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
});

test("computeObservation rejects a bad dedication server-side with 400 + reasons, no fetch", async () => {
  const r = await computeObservation({ tic: 123456, dedication: "click http://evil.io now" });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
  assert.ok((r as { errors?: string[] }).errors && (r as { errors: string[] }).errors.length > 0);
});

// ---- on-chain burn verifier (fabricated RPC transactions, no chain) ----

const PAYER = "WALLET11111111111111111111111111111111111111";
function burnIx(mint: string, amount: string, programId: string): Record<string, unknown> {
  return { programId, parsed: { type: "burn", info: { mint, amount, authority: PAYER } } };
}
function rpcTx(over: Partial<{ instructions: Record<string, unknown>[]; inner: Record<string, unknown>[]; confirmationStatus: string; err: unknown }> = {}): RpcTransactionLike {
  return {
    confirmationStatus: over.confirmationStatus ?? "finalized",
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }], instructions: over.instructions ?? [burnIx(SDR_MINT, "10000000000", TOKEN_2022_PROGRAM_ID)] } },
    meta: { err: over.err ?? null, innerInstructions: (over.inner ?? []).map((ix) => ({ instructions: [ix] })) },
  };
}

test("burnVerify: a finalized $SDR Token-2022 burn of exactly 1e10 passes", () => {
  assert.equal(verifyBurnTx(rpcTx()).check.ok, true);
});

test("burnVerify: wrong amount / wrong mint / wrong program / not-finalized / errored all rejected", () => {
  assert.equal(verifyBurnTx(rpcTx({ instructions: [burnIx(SDR_MINT, "9999999999", TOKEN_2022_PROGRAM_ID)] })).check.ok, false);
  assert.equal(verifyBurnTx(rpcTx({ instructions: [burnIx("OTHERmint111111111111111111111111111111111111", "10000000000", TOKEN_2022_PROGRAM_ID)] })).check.ok, false);
  assert.equal(verifyBurnTx(rpcTx({ instructions: [burnIx(SDR_MINT, "10000000000", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")] })).check.ok, false);
  assert.equal(verifyBurnTx(rpcTx({ confirmationStatus: "confirmed" })).check.ok, false);
  assert.equal(verifyBurnTx(rpcTx({ err: { InstructionError: [0, "Custom"] } })).check.ok, false);
});

test("burnVerify: a burn hidden in inner instructions is still found", () => {
  const tx = rpcTx({ instructions: [{ programId: "11111111111111111111111111111111", parsed: { type: "initialize" } }] });
  tx.meta!.innerInstructions = [{ instructions: [burnIx(SDR_MINT, "10000000000", TOKEN_2022_PROGRAM_ID)] }];
  assert.equal(verifyBurnTx(tx).check.ok, true);
});

test("burnVerify: signature lookup handles not-found and success", async () => {
  const notFound = { getTransaction: async () => null };
  assert.equal((await verifyBurnBySignature(notFound, "SIG")).check.ok, false);
  const found = { getTransaction: async () => rpcTx() };
  assert.equal((await verifyBurnBySignature(found, "SIG")).check.ok, true);
  assert.equal((await verifyBurnBySignature(found, "")).check.ok, false);
});

// ---- x402 payment-signature envelope ----

test("parsePaymentSignature: accepts payload.signature, rejects missing / wrong scheme", () => {
  assert.equal(parsePaymentSignature({ scheme: "exact", payload: { signature: "SIGabc" } }).ok, true);
  assert.equal(parsePaymentSignature({ scheme: "exact", payload: { transaction: "SER" } }).ok, true); // tx treated as sig handle
  assert.equal(parsePaymentSignature({ payload: {} }).ok, false);
  assert.equal(parsePaymentSignature({ scheme: "transfer", payload: { signature: "x" } }).ok, false);
  assert.equal(parsePaymentSignature(null).ok, false);
});

// ---- commission gating: money-safety branches return BEFORE any network compute ----

const COMMISSION_INPUT = { tic: 25155310, sector: 4, dedication: "for my father, who loved the night sky" };

test("commissionObservation: no payment -> 402 (payment required); compute never runs", async () => {
  const r = await commissionObservation(COMMISSION_INPUT, { connection: { getTransaction: async () => null } });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 402);
});

test("commissionObservation: malformed payment envelope -> 400", async () => {
  const r = await commissionObservation({ ...COMMISSION_INPUT, payment: { scheme: "exact", payload: {} } }, { connection: { getTransaction: async () => null } });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
});

test("commissionObservation: a signature that is NOT a qualifying $SDR burn -> 402, and the search is never run", async () => {
  // wrong amount (1 base unit, not 1e10) -> verifyBurnBySignature ok:false -> rejected BEFORE compute.
  const badTx = rpcTx({ instructions: [burnIx(SDR_MINT, "1", TOKEN_2022_PROGRAM_ID)] });
  const conn = { getTransaction: async () => badTx };
  const r = await commissionObservation({ ...COMMISSION_INPUT, payment: { scheme: "exact", payload: { signature: "SIG" } } }, { connection: conn });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 402);
});

test("commissionObservation: a not-yet-finalized / not-found burn signature -> 402", async () => {
  const conn = { getTransaction: async () => null }; // signature unknown to every endpoint
  const r = await commissionObservation({ ...COMMISSION_INPUT, payment: { scheme: "exact", payload: { signature: "UNKNOWN" } } }, { connection: conn });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 402);
});

// ---- browser RPC proxy (read-only chain reads for the in-page burn helper) -----------------
// Load-bearing money-path boundary: the proxy exists only because public RPCs 403 browser Origins; it must
// NEVER relay writes (sendTransaction especially), must cap shapes to single JSON-RPC objects, and must fall
// over from a failing endpoint to the next. All offline -- fetch is injected.

function stubFetch(replies: Record<string, { ok: boolean; status: number; json?: unknown } | "throw">) {
  const seen: { url: string; body: string }[] = [];
  const f: RpcFetch = async (url, init) => {
    seen.push({ url, body: init.body });
    const r = replies[url];
    if (!r || r === "throw") throw new Error("unreachable");
    return { ok: r.ok, status: r.status, json: async () => r.json };
  };
  return { f, seen };
}

test("rpc proxy: write methods (sendTransaction) are refused without touching any endpoint", async () => {
  const { f, seen } = stubFetch({});
  const out = await handleBrowserRpcProxy(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["abc"] }), ["https://rpc.example"], f);
  assert.equal(out.status, 403);
  assert.equal(seen.length, 0);
  assert.equal(RPC_READ_ALLOWLIST.has("sendTransaction"), false);
});

test("rpc proxy: an allowlisted read is forwarded and the JSON-RPC reply passes through verbatim", async () => {
  const reply = { jsonrpc: "2.0", id: 7, result: { contextSlot: 1, value: { blockhash: "BH", lastValidBlockHeight: 2 } } };
  const { f, seen } = stubFetch({ "https://rpc.example": { ok: true, status: 200, json: reply } });
  const out = await handleBrowserRpcProxy(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }), ["https://rpc.example"], f);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, reply);
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /"method":"getLatestBlockhash"/); // params preserved
});

test("rpc proxy: a failing primary endpoint falls over to the next configured one", async () => {
  const reply = { jsonrpc: "2.0", id: 1, result: { value: { uiAmount: "1" } } };
  const { f, seen } = stubFetch({
    "https://primary.example": { ok: false, status: 429 },
    "https://fallback.example": { ok: true, status: 200, json: reply },
  });
  const out = await handleBrowserRpcProxy(JSON.stringify({ method: "getTokenAccountBalance", params: ["ATA"] }), ["https://primary.example", "https://fallback.example"], f);
  assert.equal(out.status, 200);
  assert.equal(seen.length, 2);
});

test("rpc proxy: batches and non-JSON bodies are refused (single request objects only)", async () => {
  const { f } = stubFetch({});
  const batch = await handleBrowserRpcProxy(JSON.stringify([{ method: "getSlot" }, { method: "getSlot" }]), ["https://rpc.example"], f);
  assert.equal(batch.status, 400);
  const junk = await handleBrowserRpcProxy("not json", ["https://rpc.example"], f);
  assert.equal(junk.status, 400);
  const everyFail = await handleBrowserRpcProxy(JSON.stringify({ method: "getSlot" }), ["https://down.example"], f);
  assert.equal(everyFail.status, 502);
  const none = await handleBrowserRpcProxy(JSON.stringify({ method: "getSlot" }), [], f);
  assert.equal(none.status, 503);
});

// ---- daily anchor cap resolution (shared by DO + Node; drives OBSERVE_ANCHOR_DAILY_CAP) -----
// The load-bearing asymmetry: "unlimited" removes the ceiling, but 0/blank is the SAFE stop (anchor NOTHING),
// never a silent synonym for unlimited -- canceling the cap must be an explicit act.
test("resolveAnchorDailyCap: explicit unlimited vs numeric budget vs safe-zero stop", () => {
  const INF = Number.POSITIVE_INFINITY;
  assert.equal(resolveAnchorDailyCap("unlimited"), INF);
  assert.equal(resolveAnchorDailyCap("UNLIMITED"), INF);
  assert.equal(resolveAnchorDailyCap("  none  "), INF);
  assert.equal(resolveAnchorDailyCap("*"), INF);
  assert.equal(resolveAnchorDailyCap("5"), 5);
  assert.equal(resolveAnchorDailyCap("100"), 100);
  // the kill-switch family all collapse to 0 (anchor nothing), NOT to unlimited:
  assert.equal(resolveAnchorDailyCap("0"), 0);
  assert.equal(resolveAnchorDailyCap(""), 0);
  assert.equal(resolveAnchorDailyCap("   "), 0);
  assert.equal(resolveAnchorDailyCap(undefined), 0);
  assert.equal(resolveAnchorDailyCap(null), 0);
  assert.equal(resolveAnchorDailyCap("garbage"), 0);
  assert.equal(resolveAnchorDailyCap("-3"), 0);
  // and the caller guard is count(0) >= cap(0) === true => nothing anchored when cap is 0.
  assert.ok(0 >= resolveAnchorDailyCap("0"));
  assert.ok(!(0 >= resolveAnchorDailyCap("unlimited")));
});
