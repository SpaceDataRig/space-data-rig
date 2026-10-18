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

/**
 * True when a ledger row records a commitment that actually landed: status `anchored` AND a signature.
 *
 * THIS IS A DIFFERENT QUESTION FROM `anchorStampIsValid`, AND CONFLATING THE TWO WAS A REAL DEFECT. The stamp
 * check asks whether a signature still proves the bundle a reader is being shown NOW -- so a record that was
 * anchored and later re-derived (its bundle hash is a timestamped commitment, so any re-run changes it) fails
 * it. This predicate asks only whether the chain was ever told about this finding, which is the cumulative
 * count. Production showed 7 and 18 for the two at the same moment, and the dashboard labelled the first one
 * "on-chain", which reads as the second. Both numbers are true; only one of them was being told.
 *
 * A row written by a failed attempt (status "failed", or anchored with no signature because the RPC never
 * returned one) is not a commitment: counting it would inflate the total with something nobody can look up.
 *
 * GENERIC OVER THE ROW SHAPE ON PURPOSE. The Durable Object's ledger and the Node filesystem ledger declare
 * their own LedgerEntry (the fs one additionally allows a "pending" status that predates the DO). Both must apply
 * ONE rule, so the predicate takes the minimum it actually reads instead of either concrete type.
 */
export function isCommittedLedgerRow(entry: { status: string; signature?: string }): boolean {
  return entry.status === "anchored" && typeof entry.signature === "string" && entry.signature.length > 0;
}

/**
 * The SQL form of `isCommittedLedgerRow`, for the Durable Object's SQLite ledger table, where each row's JSON
 * lives in `data`. It is exported as text rather than inlined at the query site for one reason: `RigStateDO`
 * imports `cloudflare:workers` and cannot be loaded by the Node test runner, so the only way this predicate can
 * be checked outside a deploy is for the query to be data a test can read. tests/anchored-stats.test.ts pins the
 * two conditions named here against the JavaScript predicate above, so the two runtimes cannot drift.
 */
export const LEDGER_COMMITTED_SQL = `json_extract(data,'$.status') = 'anchored' AND json_extract(data,'$.signature') IS NOT NULL`;

/**
 * The row to persist when an anchor attempt arrives for a finding the ledger already holds.
 *
 * THE DEFECT: the ledger keeps ONE row per finding (Durable Object: `INSERT OR REPLACE ... PRIMARY KEY
 * finding_id`; Node: the fs ledger replaces the matching entry in place). The write path used to store whatever
 * the newest attempt produced, so a failed re-anchor of an already-anchored finding overwrote the signature, the
 * slot and the explorer URL of a commitment that is still live on mainnet. Two things then went wrong at once:
 * the public ledger lost evidence anybody could check, and `ledgerAnchored` -- the count of commitments --
 * silently fell, which is how the two-numbers confusion in `isCommittedLedgerRow` first became visible.
 *
 * THE RULE: an attempt that did not land cannot demote a row that did. A committed row stays committed, keeps
 * everything that proves it, and the failed attempt is recorded in the `lastAttempt*` fields, which describe the
 * attempt rather than the row. A successful re-anchor still replaces the hash and the signature -- that is a
 * genuinely newer commitment, not a downgrade.
 *
 * Like the predicate above it is generic, so the DO ledger and the fs ledger cannot drift apart from this rule.
 */
export interface LedgerRowLike {
  findingId: string;
  bundleHash: string;
  status: string;
  signature?: string;
  error?: string;
  lastAttemptError?: string;
  lastAttemptBundleHash?: string;
  lastAttemptAt?: string;
}

export function mergeLedgerRow<T extends LedgerRowLike>(prior: T | undefined, next: T, now: string): T {
  if (!prior) return next;
  if (isCommittedLedgerRow(prior) && !isCommittedLedgerRow(next)) {
    // `as T` rather than a widened return: the three fields are declared on the constraint, and the concrete
    // row type of whichever ledger is writing here is the type that must come back out of it.
    return { ...prior, lastAttemptError: next.error ?? "anchor attempt failed with no error text", lastAttemptBundleHash: next.bundleHash, lastAttemptAt: now } as T;
  }
  return { ...prior, ...next };
}
