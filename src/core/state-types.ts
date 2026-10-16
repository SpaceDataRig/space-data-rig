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
  bundlesAnchored: number;
  /** audit-5: how many rotating survey passes the autonomous cron has completed (from DO meta). */
  surveyPass: number;
  /** distinct target hosts recorded so far -- the honest measure of catalog breadth/rotation. */
  distinctHosts: number;
  /** rows tagged origin="blind-toi": UNCONFIRMED candidates recovered blind, never anchored. */
  blindCandidates: number;
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
