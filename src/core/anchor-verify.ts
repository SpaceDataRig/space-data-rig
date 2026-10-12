// Anchor-stamp validity: the single rule for "is this on-chain tx real proof for THIS bundle?".
//
// A finding/bundle carries a `solanaTx` string, but that string is only MEANINGFUL provenance if the
// append-only ledger records an `anchored` entry whose signature is exactly that tx AND whose bundle
// hash equals the bundle the card currently displays. Anything else (a tx that sealed an earlier, now
// superseded hash; a stamp inherited across a hash change; a stamp that never made it into the ledger)
// must NOT be presented as "sealed/tamper-proof" for the current result -- that is the hash-drift bug
// the third-party audit caught on HR 858 c, which we later also found live on HAT-P-11-b.
//
// This lives in core (runtime-agnostic, no fs/node: imports) so the Cloudflare RigStateDO, the Node
// RigStore, and the offline tests all apply the exact same rule.

import type { LedgerEntry } from "./state-types.ts";

/** Index ledger entries by findingId so validity checks are O(1). */
export function indexLedgerByFinding(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) m.set(e.findingId, e);
  return m;
}

/**
 * True only when `solanaTx` corresponds to a ledger entry that is `anchored` and covers EXACTLY
 * `bundleHash`. A null/absent tx, a missing ledger entry, a failed entry, or an entry whose recorded
 * hash differs from the displayed bundle all return false -- the stamp does not prove the current data.
 */
export function anchorStampIsValid(entry: LedgerEntry | undefined, bundleHash: string | undefined, solanaTx: string | undefined): boolean {
  if (!solanaTx || !bundleHash) return false;
  if (!entry || entry.status !== "anchored") return false;
  return entry.signature === solanaTx && entry.bundleHash === bundleHash;
}
