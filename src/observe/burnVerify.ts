// ON-CHAIN BURN VERIFIER (named-observation payment, Phase B -- the money-safety core).
//
// The user pays by BURNING exactly 10,000 $SDR (a Token-2022 Burn) from their own wallet and hands us the
// transaction SIGNATURE. Rather than trust the client's word (or hand-decode raw bytes), we RE-READ the
// transaction from the chain (getTransaction, jsonParsed, finalized) and derive the facts ourselves, then
// apply the same hard policy as everywhere else (paymentPolicy.evaluateBurnPayment): correct Token-2022
// program, mint == $SDR, amount EXACTLY 1e10, it really is a Burn (not a transfer), and it finalized with no
// error. Anything else is rejected and the observation is never run or anchored.
//
// The pure extract+verify functions take an already-fetched transaction object so the whole decision is unit-
// testable offline with a fabricated RPC payload -- the money rules must be provable without touching the
// chain. verifyBurnBySignature is the thin network wrapper the route calls.

import { evaluateBurnPayment, SDR_MINT, type BurnPaymentFacts, type PaymentCheck } from "./paymentPolicy.ts";

/** Minimal structural view of a getTransaction(jsonParsed) result -- fields we actually read. */
export interface RpcTransactionLike {
  confirmationStatus?: string;
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey?: string; signer?: boolean }>;
      instructions?: Array<Record<string, unknown>>;
    };
  };
  meta?: {
    err?: unknown;
    innerInstructions?: Array<{ instructions?: Array<Record<string, unknown>> }>;
  };
}

interface ParsedBurn {
  programId: string;
  mint: string;
  amountRaw: string;
  authority: string;
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>) : null;
}

/**
 * Find a Token-2022 Burn of $SDR in a jsonParsed transaction (top-level or inner instructions). Returns the
 * first matching burn's facts, or null if the tx contains no such burn instruction.
 */
function findSdrBurn(tx: RpcTransactionLike): ParsedBurn | null {
  const msg = tx.transaction?.message;
  const top = Array.isArray(msg?.instructions) ? msg!.instructions : [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((ii) => (Array.isArray(ii.instructions) ? ii.instructions : []));
  for (const ix of [...top, ...inner]) {
    const parsed = asRecord(ix?.parsed);
    const info = parsed ? asRecord(parsed.info) : null;
    if (parsed?.type === "burn" && info && typeof info.mint === "string" && info.mint === SDR_MINT) {
      return {
        programId: typeof ix.programId === "string" ? ix.programId : "",
        mint: info.mint,
        amountRaw: String(info.amount ?? ""),
        authority: typeof info.authority === "string" ? info.authority : "",
      };
    }
  }
  return null;
}

/** Derive the policy-relevant facts of a payment from an already-fetched RPC transaction. Pure. */
export function extractBurnFacts(tx: RpcTransactionLike): BurnPaymentFacts {
  const burn = findSdrBurn(tx);
  const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey ?? "";
  const err = tx.meta?.err;
  const succeeded = err == null; // null (or absent) means the tx executed without an on-chain error
  return {
    programId: burn?.programId ?? "",
    mint: burn?.mint ?? "",
    amountRaw: burn?.amountRaw ?? "0",
    isBurn: burn != null,
    payer: burn ? feePayer || burn.authority : "",
    finalized: succeeded && tx.confirmationStatus === "finalized",
  };
}

/** Apply the burn policy to a fetched transaction. Pure + offline-testable. */
export function verifyBurnTx(tx: RpcTransactionLike): { check: PaymentCheck; facts: BurnPaymentFacts } {
  const facts = extractBurnFacts(tx);
  return { check: evaluateBurnPayment(facts), facts };
}

/** The subset of a Solana Connection we need; keeps this testable with a fake. */
export interface TxGetter {
  getTransaction(signature: string, opts: unknown): Promise<RpcTransactionLike | null>;
}

/**
 * Fetch the burn transaction by signature at `finalized` commitment and verify it. A signature that is not
 * found, not finalized, or not a qualifying $SDR burn returns ok:false with a reason. The caller must treat
 * ok:false as "do not run, do not anchor, do not spend".
 */
export async function verifyBurnBySignature(conn: TxGetter, signature: string): Promise<{ check: PaymentCheck; facts: BurnPaymentFacts | null }> {
  if (!signature) return { check: { ok: false, reason: "no payment signature supplied" }, facts: null };
  let tx: RpcTransactionLike | null = null;
  try {
    tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
  } catch {
    return { check: { ok: false, reason: "could not read the payment transaction from the chain" }, facts: null };
  }
  if (!tx) return { check: { ok: false, reason: "payment transaction not found (or not yet finalized)" }, facts: null };
  const { check, facts } = verifyBurnTx(tx);
  return { check, facts };
}
