// Runtime-agnostic rig state types.
//
// These describe the *shape* of the rig's shared state (seats, bundles, stats, the
// full dashboard payload, the active-run bookkeeping and the on-chain ledger row).
// They live here -- free of node:fs and @cloudflare/workers-types -- so BOTH the Node
// RigStore (src/core/store.ts) and the Cloudflare RigStateDO can share one definition,
// which is what keeps the SSE/WebSocket message shapes identical across runtimes.

import type { Finding, RigEvent, SeatName, Task } from "./types.ts";

/** Live status of one seat, surfaced in the frontend topology view. */
export interface SeatState {
  name: SeatName;
  status: "idle" | "running" | "done" | "error";
  lastMessage?: string;
  lastActiveAt?: string;
  processed: number;
}

/** A reproducible analysis bundle once packaged (see src/bundle/bundle.ts). */
export interface BundleRecord {
  findingId: string;
  hash: string; // SHA-256 over the canonical bundle payload
  files: string[]; // relative artifact paths
  createdAt: string;
  solanaTx?: string; // filled in by the anchoring step
}

/** Aggregate counters the frontend header shows. */
export interface RigStats {
  tasksQueued: number;
  tasksDone: number;
  tasksFailed: number;
  findingsAccepted: number;
  findingsRejected: number;
  findingsReview: number;
  /**
   * Findings whose CURRENTLY PUBLISHED bundle carries a confirmed on-chain stamp -- read it as "the bytes you
   * can download from this rig now are the bytes a chain commitment covers", which is the property a provenance
   * claim needs. It is NOT a count of how many results were ever anchored: a bundle hash folds the run's
   * timestamp, so any re-derivation produces a new hash that the chain has never seen, and the stale stamp is
   * then dropped by the integrity sweep rather than inherited. Those findings leave this number while their
   * commitment stays on chain, so this figure can fall without anything being un-anchored.
   * (audit-6: this and `ledgerAnchored` were one field, labelled as the other.)
   */
  bundlesAnchored: number;
  /**
   * Chain commitments recorded in the ledger: rows with status `anchored` and a signature. Unlike
   * `bundlesAnchored` this survives a re-derivation -- it answers "how many results has this rig put on
   * chain", including bundles that have since been superseded. One row per finding (the ledger is keyed by
   * finding id), so it is a finding count, not a transaction count.
   */
  ledgerAnchored: number;
  /**
   * Rotating survey passes CLAIMED, not completed. The cursor advances when a run TAKES the slot
   * (src/cf/run-mutex.ts, the audit-6 fix for the 22-hour freeze), so a pass that hangs after claiming still
   * counts and can never be counted twice. Reading this as "N finished surveys" overstates it.
   */
  surveyPass: number;
  /**
   * Distinct hosts among RECORDED RESULTS of any verdict -- accepted, watchlist and rejected alike. Not the
   * number of targets analysed (that is `tasksDone`): it grows only when a look becomes a row.
   * (audit-7: the board called this "distinct targets", which read as survey breadth.)
   */
  distinctHosts: number;
  /** Blind TOI rows ASSESSED: every blind recovery, including ones the critic later rejected. Never anchored. */
  blindCandidates: number;
  /**
   * The subset still HELD for human follow-up -- assessed minus critic-rejected. This is the population the X
   * digest quotes, so the board and the feed now count one phrase one way (src/core/stats-definitions.ts).
   */
  blindHeld: number;
}

/** Fully serializable rig state; this is what snapshot/restore persist. */
export interface RigSnapshot {
  version: number;
  savedAt: string;
  runId: string;
  tasks: Task[];
  findings: Finding[];
  seats: SeatState[];
  bundles: BundleRecord[];
  events: RigEvent[];
  stats: RigStats;
}

/** Outcome tallies for an active/finished run. */
export interface ActiveRunSummary {
  targets: number;
  accepted: number;
  review: number;
  rejected: number;
  bundles: number;
  catalogSource: string;
  /** audit-5: how many of this run's targets were UNCONFIRMED blind-TOI candidates (display only). */
  toiCount?: number;
}

/** Bookkeeping for the currently running (or last) pipeline run. */
export interface ActiveRun {
  runId: string;
  startedAt: string;
  running: boolean;
  finishedAt?: string;
  error?: string;
  summary?: ActiveRunSummary;
}

/** One on-chain provenance ledger row (mainnet anchor status). */
export interface LedgerEntry {
  findingId: string;
  bundleHash: string;
  /** stable content address (audit-10 #1): the dedup key that lets an identical-science re-run
   *  be recognised as already-anchored instead of spending a second mainnet fee (audit-3 P0-B). */
  scienceHash?: string;
  memo?: string;
  status: "anchored" | "failed";
  signature?: string;
  slot?: number;
  publicKey?: string;
  explorerUrl?: string;
  error?: string;
  anchoredAt?: string;
  /**
   * A failed re-anchor attempt against a finding whose earlier anchor SUCCEEDED. The ledger keeps one row per
   * finding, so writing the failure into `status`/`error` here would delete the evidence of a commitment that is
   * still on chain -- see `mergeLedgerRow` in src/core/anchor-verify.ts. The prior row is therefore kept and the
   * lost attempt is recorded beside it, in fields a reader cannot mistake for the row's state.
   */
  lastAttemptError?: string;
  lastAttemptBundleHash?: string;
  lastAttemptAt?: string;
}

/** Full dashboard payload the frontend renders (GET /api/state + WS "state" pulses). */
export interface DashboardState {
  runId: string;
  codeVersion?: string;
  activeRun: ActiveRun | null;
  seats: SeatState[];
  findings: Finding[];
  bundles: BundleRecord[];
  events: RigEvent[];
  stats: RigStats;
}

export const SEAT_ORDER: SeatName[] = [
  "data-fetch",
  "anomaly-scout",
  "sim-runner",
  "mission-critic",
  "reporter",
];

/** Create the default idle seat roster (fresh run / cold start). */
export function defaultSeats(): SeatState[] {
  return SEAT_ORDER.map((name) => ({ name, status: "idle" as const, processed: 0 }));
}
