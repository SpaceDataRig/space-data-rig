// x402 HTTP-402 payment-gate wire shapes for the named-observation endpoint (pure builders/parsers).
//
// x402 is the "HTTP 402 Payment Required" standard for paid APIs: the server answers an unpaid request with
// a 402 carrying an `X-PAYMENT-REQUIRED` descriptor; the client signs a payment and retries with an
// `X-PAYMENT` header; the server verifies and, on success, answers with an `X-PAYMENT-RESPONSE`. We speak the
// standard SHAPE for client compatibility, but because $SDR is a custom Token-2022 mint being BURNED (not
// USDC paid to a merchant), hosted x402 facilitators cannot verify it -- so verification is self-hosted (see
// paymentPolicy.ts + the Phase B network layer). This module only builds the JSON objects and parses the
// client's envelope; base64 header encoding/decoding is the HTTP route's job (both Workers and Node expose
// atob/btoa), keeping this file dependency-free and unit-testable.
//
// PURE + OFFLINE. No network, no worker import.

import {
  OBSERVATION_COST_RAW,
  SDR_DECIMALS,
  SDR_MINT,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  X402_NETWORK,
} from "./paymentPolicy.ts";

export const X402_VERSION = 1;

/** One payment option in the `accepts` list. Typed to our exact/burn scheme. */
export interface X402Accept {
  scheme: "exact";
  network: typeof X402_NETWORK;
  /** atomic base units as a decimal string; x402 mandates a string to survive JSON float limits */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  /** System Program address => "no merchant"; the payment is a burn, not a transfer to a person. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** the SPL mint the payment is denominated in ($SDR) */
  asset: string;
  /** our custom, self-verified extensions documenting the burn semantics */
  extra: {
    mint: string;
    decimals: number;
    tokenProgram: string;
    burn: true;
    exact: true;
  };
}

export interface PaymentRequiredChallenge {
  x402Version: number;
  error?: string;
  accepts: X402Accept[];
}

export interface BuildChallengeInput {
  resource: string;
  description: string;
  timeoutSeconds?: number;
  error?: string;
}

/** Build the `X-PAYMENT-REQUIRED` object. The caller base64-encodes it into the response header. */
export function buildPaymentRequired(input: BuildChallengeInput): PaymentRequiredChallenge {
  const accept: X402Accept = {
    scheme: "exact",
    network: X402_NETWORK,
    maxAmountRequired: OBSERVATION_COST_RAW.toString(),
    resource: input.resource,
    description: input.description,
    mimeType: "application/json",
    payTo: SYSTEM_PROGRAM_ID,
    maxTimeoutSeconds: input.timeoutSeconds ?? 120,
    asset: SDR_MINT,
    extra: {
      mint: SDR_MINT,
      decimals: SDR_DECIMALS,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      burn: true,
      exact: true,
    },
  };
  const challenge: PaymentRequiredChallenge = { x402Version: X402_VERSION, accepts: [accept] };
  if (input.error) challenge.error = input.error;
  return challenge;
}

/** The client's `X-PAYMENT` envelope after base64-decode + JSON.parse (payload kept opaque here). */
export interface X402PaymentEnvelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { transaction: string };
}

export type PaymentParseResult =
  | { ok: true; payment: X402PaymentEnvelope }
  | { ok: false; errors: string[] };

/**
 * Parse + shape-check a decoded X-PAYMENT body. This validates the ENVELOPE only (version/scheme/network and
 * that a non-empty serialized transaction is present); the transaction is decoded and checked against the
 * burn policy in the network layer, never here.
 */
export function parsePaymentEnvelope(obj: unknown): PaymentParseResult {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: ["payment body is not an object"] };
  const p = obj as Record<string, unknown>;
  if (p.x402Version !== X402_VERSION) errors.push(`x402Version must be ${X402_VERSION}`);
  if (p.scheme !== "exact") errors.push(`scheme must be "exact"`);
  if (p.network !== X402_NETWORK) errors.push(`network must be "${X402_NETWORK}"`);
  const payload = p.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    errors.push("payload object missing");
  } else if (typeof payload.transaction !== "string" || payload.transaction.length === 0) {
    errors.push("payload.transaction must be a non-empty serialized transaction");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    payment: {
      x402Version: p.x402Version as number,
      scheme: p.scheme as string,
      network: p.network as string,
      payload: { transaction: (payload as { transaction: string }).transaction },
    },
  };
}

/**
 * Extract the on-chain burn SIGNATURE from a decoded X-PAYMENT body. Our commission flow has the client send
 * the signature of the burn it already submitted (the server then re-reads + verifies it from the chain via
 * burnVerify), which avoids shipping a Solana SDK to the browser and never trusts the client's claim. Accepts
 * payload.signature (preferred) or payload.transaction (a serialized tx) whose value we treat as the sig.
 */
export function parsePaymentSignature(obj: unknown): { ok: true; signature: string } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) return { ok: false, error: "payment body is not an object" };
  const p = obj as Record<string, unknown>;
  if (p.scheme != null && p.scheme !== "exact") return { ok: false, error: 'scheme must be "exact"' };
  const payload = p.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return { ok: false, error: "payload object missing" };
  const sig = typeof payload.signature === "string" ? payload.signature : typeof payload.transaction === "string" ? payload.transaction : "";
  if (!sig.trim()) return { ok: false, error: "payload.signature (or payload.transaction) must be a non-empty string" };
  return { ok: true, signature: sig.trim() };
}

/** The `X-PAYMENT-RESPONSE` value returned on a successful, verified payment. */
export interface PaymentResponseHeader {
  success: true;
  network: typeof X402_NETWORK;
  transaction: string; // the on-chain signature of the burn tx
  blockExplorer: string;
  paidAt: string; // ISO timestamp
}

export function buildPaymentResponse(txSignature: string, blockExplorer: string, paidAt: string): PaymentResponseHeader {
  return { success: true, network: X402_NETWORK, transaction: txSignature, blockExplorer, paidAt };
}
