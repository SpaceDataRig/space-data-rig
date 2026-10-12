// PAYMENT POLICY for a commissioned named observation (x402 + SPL burn).
//
// The user pays by BURNING exactly 10000 $SDR -- a Token-2022 `Burn` of the project mint from their own
// associated token account, which permanently reduces total supply (mint/freeze authority are null, so the
// burn is irreversible and the token cannot be re-minted or clawed back). No tokens are sent to any person;
// the x402 `payTo` field is set to the System Program address purely as a "no merchant" sentinel, because
// the x402 wire format requires a recipient slot.
//
// This module holds the POLICY (the numbers + a pure evaluator). The transaction DECODING (turning a signed
// Solana tx into `BurnPaymentFacts`) and the on-chain CONFIRMATION live in the network layer (Phase B);
// keeping the decision logic here makes it unit-testable offline with no chain access, which is the whole
// point -- the money-path rules must be provable without spending anything.
//
// PURE + OFFLINE. No network, no worker import.

/** The $SDR mint (verified live on mainnet): a Token-2022 mint, 6 decimals, no mint/freeze authority. */
export const SDR_MINT = "FvSE99EkoiTY8Wv34V2RpWVNxnrLe7o9gyKnd4HddtjQ";
/** Token-2022 program (NOT the legacy SPL Token program). Transfers/burns must name this program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** System Program address -- used as the x402 `payTo` "no merchant / this is a burn" sentinel. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** x402 network identifier for the cluster we operate on. */
export const X402_NETWORK = "solana-mainnet";
/** Token decimals (verified on-chain). */
export const SDR_DECIMALS = 6;
/** Human-facing price of one observation. */
export const OBSERVATION_COST_TOKENS = 10000;
/** The same price in atomic base units: 10000 * 10^6. Exact-match requirement (no over/under-payment). */
export const OBSERVATION_COST_RAW = 10_000n * 10n ** BigInt(SDR_DECIMALS); // 10000000000n

/**
 * A normalized description of a payment, produced by the (Phase B) transaction decoder + RPC confirmation.
 * This is deliberately a plain data shape so the policy below can be tested with fabricated facts.
 */
export interface BurnPaymentFacts {
  /** the token program the burn instruction targeted */
  programId: string;
  /** the mint that was burned */
  mint: string;
  /** burned amount in atomic base units (string|number|bigint; compared as BigInt) */
  amountRaw: string | number | bigint;
  /** true only when the decoded tx actually contains a Token-2022 Burn (not a transfer to some address) */
  isBurn: boolean;
  /** the fee-payer / burn authority public key (for the ledger + replay index) */
  payer: string;
  /** true only once the transaction is confirmed `finalized` on-chain (a submitted-but-failed tx is false) */
  finalized: boolean;
}

export interface PaymentCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Evaluate a decoded burn payment against the observation policy. Every rule is a hard equality -- the
 * amount must be EXACTLY the cost, the mint must be $SDR, the program must be Token-2022, it must be a real
 * burn (not a transfer), and it must be finalized. On the first violation we return the reason; the caller
 * must treat any non-ok result as "do not run the observation, do not spend rig compute/SOL".
 */
export function evaluateBurnPayment(f: BurnPaymentFacts): PaymentCheck {
  if (!f.isBurn) return { ok: false, reason: "payment is not a burn instruction" };
  if (f.programId !== TOKEN_2022_PROGRAM_ID) return { ok: false, reason: "wrong token program (expected Token-2022)" };
  if (f.mint !== SDR_MINT) return { ok: false, reason: "wrong mint (expected $SDR)" };
  let amount: bigint;
  try {
    amount = BigInt(f.amountRaw);
  } catch {
    return { ok: false, reason: "unparseable burn amount" };
  }
  if (amount !== OBSERVATION_COST_RAW) {
    return { ok: false, reason: `burn amount ${amount} != required exactly ${OBSERVATION_COST_RAW}` };
  }
  if (!f.payer) return { ok: false, reason: "missing burn payer/authority" };
  if (!f.finalized) return { ok: false, reason: "payment transaction is not finalized on-chain" };
  return { ok: true };
}

/**
 * Resolve the OBSERVE_ANCHOR_DAILY_CAP / AUTO_ANCHOR_DAILY_CAP Worker var into a per-UTC-day anchor budget.
 * A single shared parser keeps the Durable Object and the Node server EXACTLY in agreement (parity) and makes
 * the edge cases UNAMBIGUOUS from one tested place instead of two inline copies:
 *   - a plain non-negative integer  -> that many anchors per day (e.g. "5").
 *   - "unlimited" / "none" / "*"     -> Number.POSITIVE_INFINITY: anchor EVERY validly-paid observation, no
 *                                       daily ceiling (the operator's explicit opt-in; the real throttle is
 *                                       that each anchor still requires its own verified $SDR burn).
 *   - unset, "", "0", or unparseable -> 0, which the callers treat as "seal but anchor NOTHING". NOTE the
 *                                       deliberate asymmetry: 0 is the SAFE kill switch (spend nothing), NOT a
 *                                       synonym for unlimited -- canceling the cap is an explicit act, never an
 *                                       accident of a blank/mis-typed value.
 */
export function resolveAnchorDailyCap(raw: string | undefined | null): number {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "unlimited" || s === "none" || s === "*") return Number.POSITIVE_INFINITY;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
