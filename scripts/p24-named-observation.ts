// P24 -- NAMED OBSERVATION, OFFLINE PROOF OF CONCEPT (named-observation feature, Phase A).
//
// Demonstrates the WHOLE commissioned-observation loop end to end WITHOUT touching money or the chain:
//   pick a star (TIC) + a dedication  ->  sanitize the dedication  ->  pull REAL TESS-SPOC photometry  ->
//   run the SAME blind deterministic detection  ->  seal an observation envelope that binds the dedication
//   to the science result  ->  print the sdr:observe:1 memo that WOULD be anchored (DRY RUN).
//
// It proves the central promise: paying cannot buy a different answer. The science verdict comes from the
// blind gate on real photometry; the dedication is only ever committed to in a SEPARATE envelope hash. A
// null result ("no transit detected") is produced and sealed exactly like a positive one.
//
// NO payment is processed, NO transaction is submitted, NOTHING is anchored or deployed here. This is a
// research/demo harness. Run:  npm run p24:named-observation -- --tic=... --sectors=1,14 --dedication="..."
//
// The bundleHash below is a PoC stand-in computed over a compact result object; the live feature anchors the
// PRODUCTION bundle's real hash. That difference is printed explicitly so nothing is over-claimed.

import { fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { bls } from "../src/detect/bls.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { canonicalJson, sha256Hex } from "../src/bundle/bundle.ts";
import { sanitizeDedication } from "../src/observe/dedication.ts";
import {
  OBSERVATION_SCHEMA,
  observeEnvelopeHash,
  validateObservation,
  type ObservationRecord,
} from "../src/observe/observation.ts";
import { OBSERVATION_COST_RAW, SDR_MINT, TOKEN_2022_PROGRAM_ID, X402_NETWORK } from "../src/observe/paymentPolicy.ts";
import { commissionObservation } from "../src/observe/observeApi.ts";
import type { TxGetter, RpcTransactionLike } from "../src/observe/burnVerify.ts";
import { anchorObservationHash } from "../src/solana/anchor.ts";
import { buildObserveMemo } from "../src/solana/anchor-core.ts";

function arg(name: string, def = ""): string {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
}

// A fabricated jsonParsed transaction carrying a valid 10,000 $SDR Token-2022 burn, returned by a fake TxGetter.
// This lets the PoC exercise the REAL commission path (verify -> compute -> seal -> preview anchor) with NO chain
// read and NO money: verifyBurnBySignature is fed our invented tx instead of the network.
function fabricatedBurnConnection(): TxGetter {
  const PAYER = "WALLET11111111111111111111111111111111111111";
  const tx: RpcTransactionLike = {
    confirmationStatus: "finalized",
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }], instructions: [{ programId: TOKEN_2022_PROGRAM_ID, parsed: { type: "burn", info: { mint: SDR_MINT, amount: OBSERVATION_COST_RAW.toString(), authority: PAYER } } }] } },
    meta: { err: null, innerInstructions: [] },
  };
  return { async getTransaction(): Promise<RpcTransactionLike | null> { return tx; } };
}

// The commission path, driven end to end with a FABRICATED burn (no chain, no money): the server-side logic is
// exactly production's -- verify the burn from the (invented) tx, run the SAME blind pipeline, seal a paid record,
// then preview the sdr:observe:1 memo the DO would anchor under OBSERVE_ANCHOR. computeObservation still fetches
// REAL public photometry, so this touches the network for DATA only, never the chain and never a wallet.
async function runCommission(tic: number, sector: number | null, dedication: string): Promise<void> {
  console.log(`[p24] COMMISSION mode (fabricated burn -- NO chain, NO money): verifying 10,000 $SDR, then running the pipeline...`);
  const out = await commissionObservation(
    { tic, sector, dedication, payment: { x402Version: 1, scheme: "exact", network: X402_NETWORK, payload: { signature: "FABRICATED-BURN-SIGNATURE" } } },
    { connection: fabricatedBurnConnection() },
  );
  if (!out.ok) {
    console.log(`[p24] commission did NOT complete (server policy/data): ${out.error}${out.errors ? ` -- ${out.errors.join("; ")}` : ""}`);
    console.log(`[p24] (a rejection here is the money-safety gate working: no seal, no anchor, nothing spent.)`);
    console.log(`\nVERDICT: COMMISSION-REJECTED`);
    return;
  }
  console.log(`[p24] verdict: ${out.record.science.verdict}; status: ${out.record.status}; payment.verified: ${out.record.payment.verified}; discoveryClaim: ${out.record.discoveryClaim}`);
  const preview = await anchorObservationHash(out.record.observationId, out.envelopeHash, { dryRun: true });
  console.log(`[p24] DRY-RUN observe memo that WOULD anchor (no SOL spent): ${preview.memo}`);
  console.log(`\nVERDICT: COMMISSION-POC-OK`);
}

async function main(): Promise<void> {
  const ticRaw = parseInt(arg("tic"), 10);
  const sectors = arg("sectors", "1,2,3").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  const dedicationRaw = arg("dedication");
  const id = arg("id", `OBS-${Number.isFinite(ticRaw) ? ticRaw : "unknown"}`);

  if (!Number.isFinite(ticRaw) || ticRaw <= 0) {
    console.log(`[p24] usage: --tic=<TIC> [--sectors=1,2,3] --dedication="<text>" [--id=OBS-...]`);
    console.log(`[p24] VERDICT: BAD-ARGS`);
    return;
  }

  // STEP 1: gate the dedication BEFORE anything else (mirrors the live rule: content is checked before a
  // burn is ever accepted, because a burn is irreversible and cannot be refunded).
  const ded = sanitizeDedication(dedicationRaw);
  if (!ded.ok) {
    console.log(`[p24] dedication REJECTED by policy (nothing run, nothing charged):`);
    for (const e of ded.errors) console.log(`[p24]   - ${e}`);
    console.log(`\nVERDICT: DEDICATION-REJECTED`);
    return;
  }
  console.log(`[p24] dedication accepted (sanitized): "${ded.value}"`);

  // --commission: run the REAL paid pipeline against a fabricated burn (no chain, no money) and exit.
  // Accept both a bare --commission flag and --commission=1 (arg() only matches the key=value form).
  if (process.argv.includes("--commission") || arg("commission") !== "") {
    await runCommission(ticRaw, sectors[0] ?? null, ded.value);
    return;
  }

  // STEP 2: pull REAL photometry for this star from the token-free TESS-SPOC public bucket.
  const targetId = `TIC ${ticRaw}`;
  console.log(`[p24] fetching real TESS-SPOC photometry for ${targetId} across sectors [${sectors.join(",")}]...`);
  const lc = await fetchSpocLightCurve(ticRaw, sectors, targetId);
  if (!lc || !lc.points.length) {
    // The honest coverage constraint: TESS may simply not have a usable SPOC observation of this star.
    console.log(`[p24] no usable SPOC observation for ${targetId} in the given sectors.`);
    console.log(`[p24] (This is a first-class outcome: you can only NAME a search TESS actually made.)`);
    console.log(`\nVERDICT: NO-USABLE-DATA`);
    return;
  }
  const spanDays = lc.points[lc.points.length - 1].time - lc.points[0].time;
  console.log(`[p24] got ${lc.points.length} real points over ${spanDays.toFixed(1)} d. source: ${lc.source ?? "TESS-SPOC"}`);

  // STEP 3: run the SAME blind, deterministic detection gate the pipeline uses. Paying changes nothing here.
  const det = bls(lc);
  const depthPpm = det.depth * 1e6;
  const regime = classifyDepthRegime(depthPpm);
  const significant = det.snr >= 7 && regime.planetPlausible && depthPpm >= 200;
  const verdict = significant ? "candidate-significant" : "no-transit";
  console.log(`[p24] blind detection: SNR=${det.snr.toFixed(2)} period=${det.periodDays.toFixed(4)}d depth=${depthPpm.toFixed(0)}ppm regime=${regime.regime}`);
  console.log(`[p24] verdict (blind gate, independent of any payment): ${verdict}`);

  // STEP 4: seal a compact science result (PoC stand-in for the production bundle) + its hash.
  const scienceResult = {
    target: targetId,
    sectors,
    points: lc.points.length,
    spanDays: Math.round(spanDays * 100) / 100,
    periodDays: det.periodDays,
    depthPpm,
    snr: det.snr,
    verdict,
    discoveryClaim: false,
  };
  const bundleHash = await sha256Hex(canonicalJson(scienceResult));
  console.log(`[p24] PoC science-result hash (production anchors the REAL bundle hash): ${bundleHash}`);

  // STEP 5: build the observation ENVELOPE -- dedication + payment POLICY + the science hash -- and validate
  // it at the trust boundary. Payment is shown as the required price, NOT verified (no burn happened here).
  const record: ObservationRecord = {
    schema: OBSERVATION_SCHEMA,
    observationId: id,
    createdAt: new Date().toISOString(),
    tic: ticRaw,
    sector: sectors[0] ?? null,
    dedication: ded.value,
    payment: {
      network: X402_NETWORK,
      mint: SDR_MINT,
      amountRaw: OBSERVATION_COST_RAW.toString(),
      scheme: "burn",
      txSignature: null,
      verified: false,
    },
    science: { bundleHash, verdict },
    anchor: { memo: null, signature: null },
    status: "awaiting-payment",
    discoveryClaim: false,
  };
  const v = validateObservation(record);
  if (!v.ok) {
    console.log(`[p24] observation envelope FAILED validation (this must never happen):`);
    for (const e of v.errors) console.log(`[p24]   - ${e}`);
    console.log(`\nVERDICT: ENVELOPE-INVALID`);
    return;
  }
  console.log(`[p24] observation envelope validated (discoveryClaim=false enforced, payment policy exact).`);

  // STEP 6: compute the envelope hash binding dedication<->result + preview the memo that WOULD be anchored.
  const envelopeHash = await observeEnvelopeHash(ded.value, bundleHash);
  const memo = buildObserveMemo(id, envelopeHash);
  console.log(`\n[p24] ===== DRY RUN (NOT paid, NOT anchored, NOT deployed) =====`);
  console.log(`[p24] sealed record preview:`);
  console.log(`        "We honestly watched ${targetId} for ${spanDays.toFixed(0)} days. ${
    significant ? "A blind-search signal passed the gate (still an unconfirmed candidate, not a discovery)." : "No transit was detected."
  } Verified. Dedication: '${ded.value}'. [DRY RUN]"`);
  console.log(`[p24] sdr:observe:1 memo that WOULD go on-chain: ${memo}`);
  console.log(`\nVERDICT: NAMED-OBSERVATION-POC-OK`);
}

main().catch((e) => {
  console.error(`[p24] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
