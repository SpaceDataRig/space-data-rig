// CHAIN READ ADAPTER for the named-observation payment path (the thin network layer, runtime-agnostic).
//
// burnVerify.ts decides money safety from an ALREADY-FETCHED jsonParsed transaction, so it can be unit-tested
// offline with a fabricated payload. This file is the ONLY place that actually talks to an RPC for that read:
// it builds a `TxGetter` (the interface commissionObservation depends on) that walks the ordered endpoint list
// (private RPC first, public mainnet fallback) and returns the first provider that has the transaction.
//
// WHY raw JSON-RPC fetch instead of `new Connection(...).getTransaction(...)`: the web3.js Connection helper
// returns DECODED objects (PublicKey/Buffer), NOT the `parsed`/`info` shape burnVerify reads. Only the RPC
// `encoding: "jsonParsed"` response carries `instruction.parsed.{type,info}` we need to prove it is a real
// Token-2022 Burn of the right mint/amount. So we call the RPC method directly. `fetch` is a global on BOTH
// Workers and Node 18+, so this module is dependency-free and shared by the edge (DO) and Node runtimes.

import { endpointList } from "../solana/anchor-core.ts";
import type { RpcTransactionLike, TxGetter } from "./burnVerify.ts";

/** JSON-RPC POST. Returns `result`, or null on HTTP failure. */
async function rpcResult<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: T };
  return (j?.result as T) ?? null;
}

/**
 * Raw RPC getTransaction with jsonParsed -- the only form that exposes `parsed` burn instructions.
 *
 * `getTransaction` at commitment=finalized only returns a rooted transaction, but many public
 * providers OMIT `confirmationStatus` on that method (the field is specified on
 * getSignatureStatuses). burnVerify requires the literal string "finalized", so a real
 * Token-2022 burn of 10,000 $SDR was being rejected as "not finalized" by an RPC shape
 * quirk. Copy the status from getSignatureStatuses when missing. If that endpoint is
 * silent too, a non-null getTransaction(commitment=finalized) is still a finalized tx.
 */
async function rpcGetTransaction(url: string, signature: string): Promise<RpcTransactionLike | null> {
  const tx = await rpcResult<RpcTransactionLike | null>(url, "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" },
  ]);
  if (!tx) return null;
  if (tx.confirmationStatus === "finalized") return tx;
  const st = await rpcResult<{ value?: Array<{ confirmationStatus?: string } | null> }>(
    url,
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  const fromStatus = st?.value?.[0]?.confirmationStatus;
  tx.confirmationStatus = fromStatus ?? "finalized";
  return tx;
}

/**
 * A TxGetter that tries each endpoint in order and returns the first that has the transaction (finalized).
 * A signature none of them knows about resolves to null -> burnVerify reports "not found / not finalized".
 * Errors on one provider (rate limit, outage) fall through to the next, mirroring the anchor failover.
 */
export function txGetterFor(primary?: string, privateRpc?: string, fallbacksCsv?: string): TxGetter {
  const endpoints = endpointList(primary, privateRpc, fallbacksCsv);
  return {
    async getTransaction(signature: string): Promise<RpcTransactionLike | null> {
      for (const url of endpoints) {
        try {
          const tx = await rpcGetTransaction(url, signature);
          if (tx) return tx;
        } catch {
          /* provider outage / rate limit: fall through to the next endpoint */
        }
      }
      return null;
    },
  };
}

/** Build the ordered endpoint list (used again by the evidence verifier). */
export function observeEndpoints(primary?: string, privateRpc?: string, fallbacksCsv?: string): string[] {
  return endpointList(primary, privateRpc, fallbacksCsv);
}
