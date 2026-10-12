// RigStore: the shared state + event bus for the whole rig.
//
// Every seat talks to the store instead of to each other:
//   - seats emit RigEvents (the live feed the frontend streams over SSE)
//   - the orchestrator mutates Task/Finding state as work flows through
//   - snapshot()/restore() implement OpenRig-style checkpointing so a long
//     multi-sector run can be interrupted and resumed deterministically.
//
// Persistence is plain JSON on disk (out/state/rig.json). No DB dependency,
// which keeps the rig runnable anywhere Node runs (and trivially inspectable).

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding, RigEvent, SeatName, Task } from "./types.ts";
import {
  SEAT_ORDER,
  type BundleRecord,
  type RigSnapshot,
  type RigStats,
  type SeatState,
} from "./state-types.ts";

// Canonical state shapes live in the runtime-agnostic ./state-types.ts (shared with
// the Cloudflare RigStateDO). Re-exported here so existing import sites are unchanged.
export type { SeatState, BundleRecord, RigSnapshot, RigStats } from "./state-types.ts";
export { SEAT_ORDER } from "./state-types.ts";

const SNAPSHOT_VERSION = 1;
const MAX_EVENTS = 1000; // ring buffer cap so the JSON stays bounded

type StoreListener = (ev: RigEvent) => void;

export class RigStore {
  private emitter = new EventEmitter();
  private tasks = new Map<string, Task>();
  private findings = new Map<string, Finding>();
  private seats = new Map<SeatName, SeatState>();
  private bundles = new Map<string, BundleRecord>();
  private events: RigEvent[] = [];
  runId: string;

  constructor(runId = RigStore.makeRunId()) {
    this.runId = runId;
    for (const name of SEAT_ORDER) {
      this.seats.set(name, { name, status: "idle", processed: 0 });
    }
    // High listener count is fine: SSE clients each attach one.
    this.emitter.setMaxListeners(0);
  }

  static makeRunId(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // ---- event bus -----------------------------------------------------------

  /** Emit a seat event: appended to the log, broadcast to subscribers. */
  emitEvent(seat: SeatName, level: RigEvent["level"], message: string, data?: Record<string, unknown>): RigEvent {
    const ev: RigEvent = { ts: new Date().toISOString(), seat, level, message, data };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emitter.emit("event", ev);
    return ev;
  }

  /** Subscribe to the live event stream (used by the SSE endpoint). */
  subscribe(listener: StoreListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Subscribe to state mutations (task/finding/seat/bundle) for reactive UIs. */
  onChange(listener: () => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  private touch(): void {
    this.emitter.emit("change");
  }

  // ---- seats ---------------------------------------------------------------

  setSeatStatus(seat: SeatName, status: SeatState["status"], lastMessage?: string): void {
    const s = this.seats.get(seat);
    if (!s) return;
    s.status = status;
    s.lastActiveAt = new Date().toISOString();
    if (lastMessage != null) s.lastMessage = lastMessage;
    this.touch();
  }

  markSeatProcessed(seat: SeatName): void {
    const s = this.seats.get(seat);
    if (!s) return;
    s.processed += 1;
    this.touch();
  }

  getSeat(seat: SeatName): SeatState | undefined {
    return this.seats.get(seat);
  }

  listSeats(): SeatState[] {
    return SEAT_ORDER.map((n) => this.seats.get(n)!);
  }

  // ---- tasks ---------------------------------------------------------------

  addTask(task: Task): Task {
    this.tasks.set(task.id, task);
    this.touch();
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    Object.assign(t, patch);
    this.touch();
    return t;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  // ---- findings ------------------------------------------------------------

  addFinding(f: Finding): Finding {
    // Re-running a target must not drop its on-chain anchor stamp -- BUT only when the bundle is
    // actually the same one that was anchored. If a re-run changed the bundle hash, inheriting the old
    // solanaTx would advertise provenance for a bundle the chain never saw (the hash-drift bug). The
    // on-chain tx + ledger stay valid for the prior hash; the new bundle simply starts un-anchored.
    const prev = this.findings.get(f.id);
    const sameBundle = prev?.solanaTx != null && prev.bundleHash === f.bundleHash;
    const next = f.solanaTx == null && sameBundle ? { ...f, solanaTx: prev!.solanaTx } : f;
    this.findings.set(next.id, next);
    this.touch();
    return next;
  }

  updateFinding(id: string, patch: Partial<Finding>): Finding | undefined {
    const f = this.findings.get(id);
    if (!f) return undefined;
    Object.assign(f, patch);
    this.touch();
    return f;
  }

  getFinding(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  listFindings(): Finding[] {
    // newest first
    return [...this.findings.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ---- bundles -------------------------------------------------------------

  addBundle(b: BundleRecord): BundleRecord {
    // Same hash-guarded anchor preservation as addFinding: only carry the tx across when the bundle
    // hash is unchanged, so a re-run never points a stale anchor at a different bundle.
    const prev = this.bundles.get(b.findingId);
    const sameBundle = prev?.solanaTx != null && prev.hash === b.hash;
    const next = b.solanaTx == null && sameBundle ? { ...b, solanaTx: prev!.solanaTx } : b;
    this.bundles.set(next.findingId, next);
    this.touch();
    return next;
  }

  updateBundle(findingId: string, patch: Partial<BundleRecord>): BundleRecord | undefined {
    const b = this.bundles.get(findingId);
    if (!b) return undefined;
    Object.assign(b, patch);
    this.touch();
    return b;
  }

  listBundles(): BundleRecord[] {
    return [...this.bundles.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ---- events --------------------------------------------------------------

  recentEvents(limit = 200): RigEvent[] {
    return this.events.slice(-limit);
  }

  // ---- stats ---------------------------------------------------------------

  computeStats(): RigStats {
    const tasks = this.listTasks();
    const findings = this.listFindings();
    return {
      tasksQueued: tasks.filter((t) => t.status !== "done" && t.status !== "failed").length,
      tasksDone: tasks.filter((t) => t.status === "done").length,
      tasksFailed: tasks.filter((t) => t.status === "failed").length,
      findingsAccepted: findings.filter((f) => f.verdict === "accepted").length,
      findingsRejected: findings.filter((f) => f.verdict === "rejected").length,
      findingsReview: findings.filter((f) => f.verdict === "needs-more-data").length,
      bundlesAnchored: this.listBundles().filter((b) => b.solanaTx).length,
    };
  }

  // ---- snapshot / restore --------------------------------------------------

  /** Serialize the full rig state (OpenRig-style checkpoint). */
  snapshot(): RigSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      runId: this.runId,
      tasks: this.listTasks(),
      findings: this.listFindings(),
      seats: this.listSeats(),
      bundles: this.listBundles(),
      events: this.events.slice(-MAX_EVENTS),
      stats: this.computeStats(),
    };
  }

  /** Write a snapshot to disk. Creates parent dirs as needed. */
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }

  /** Load a snapshot into this store, replacing current state. */
  restore(snap: RigSnapshot): void {
    this.runId = snap.runId ?? this.runId;
    this.tasks.clear();
    this.findings.clear();
    this.bundles.clear();
    this.events = [...(snap.events ?? [])];
    for (const t of snap.tasks ?? []) this.tasks.set(t.id, t);
    for (const f of snap.findings ?? []) this.findings.set(f.id, f);
    for (const b of snap.bundles ?? []) this.bundles.set(b.findingId, b);
    for (const s of snap.seats ?? []) this.seats.set(s.name, { ...s });
    // ensure every seat exists even if the snapshot predates one
    for (const name of SEAT_ORDER) {
      if (!this.seats.has(name)) this.seats.set(name, { name, status: "idle", processed: 0 });
    }
    this.touch();
  }

  /** Load a snapshot from disk if present; returns true when restored. */
  load(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const snap = JSON.parse(readFileSync(path, "utf8")) as RigSnapshot;
      this.restore(snap);
      return true;
    } catch {
      return false;
    }
  }
}
