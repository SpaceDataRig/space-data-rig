// RigStateDO: the authoritative, stateful home of the rig on the edge.
//
// This Durable Object replaces the in-memory RigStore + EventEmitter of the Node
// server. It owns the SQLite-backed state (seats / tasks / findings / bundles /
// ledger / events / run meta) and fans every seat event out over WebSocket
// (Hibernation API) to all connected dashboards. It is the SINGLE writer: the
// Workflow submits results here via DO RPC, and the read endpoints (GET /api/state,
// /api/findings, /api/ledger, ...) query it. The Workflow never writes R2 state or
// SQLite directly -- it goes through these methods, so there is no double-write.
//
// Message shapes are byte-compatible with the Node SSE feed (hello/log/state) so the
// frontend's event handling is unchanged (see web/live.js, milestone E).
//
// Cold start: if SQLite is empty, hydrate from the R2 snapshot (state/rig.json);
// every target completion the Workflow calls saveSnapshot() to checkpoint back to R2.
//
// Storage note: SQLite is enabled by the [[migrations]] new_sqlite_classes entry in
// wrangler.toml, so `ctx.storage.sql` is available without a runtime opt-in call.

import { DurableObject } from "cloudflare:workers";
import type { Finding, RigEvent, SeatName, Task } from "../core/types.ts";
import {
  SEAT_ORDER,
  defaultSeats,
  type ActiveRun,
  type BundleRecord,
  type DashboardState,
  type LedgerEntry,
  type RigSnapshot,
  type RigStats,
  type SeatState,
} from "../core/state-types.ts";
import { R2ArtifactStore } from "./artifact-store.ts";
import type { Env } from "./env.ts";
import type { RunParams } from "./run-types.ts";
import {
  anchorOnEndpoints,
  anchorMemoOnEndpoints,
  buildMemo,
  buildDeliberationMemo,
  endpointList,
  explorerUrl,
  keypairFromSecretJson,
  type AnchorCoreResult,
} from "../solana/anchor-core.ts";

const SNAPSHOT_VERSION = 1;
const MAX_EVENTS = 1000; // ring buffer cap so state stays bounded
const SNAPSHOT_KEY = "state/rig.json";

type Json = Record<string, unknown>;

export class RigStateDO extends DurableObject<Env> {
  private artifacts!: R2ArtifactStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.artifacts = new R2ArtifactStore(env.RIG_ARTIFACTS);
    // One-time, concurrency-blocked init: create tables, seed seats, keep-alive
    // auto-response, and hydrate from R2 if this is a cold, empty instance.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ensureSchema();
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      await this.hydrateIfEmpty();
    });
  }

  // ---- schema --------------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seats (
        name TEXT PRIMARY KEY, status TEXT NOT NULL, last_message TEXT,
        last_active_at TEXT, processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles (finding_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (finding_id TEXT PRIMARY KEY, anchored_at TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // seed the seat roster if missing (fresh instance)
    for (const s of defaultSeats()) {
      sql.exec(
        `INSERT OR IGNORE INTO seats (name, status, last_message, last_active_at, processed) VALUES (?, ?, NULL, NULL, 0)`,
        s.name,
        s.status,
      );
    }
    if ((await this.getMeta("runId")) == null) await this.setMeta("runId", RigStateDO.makeRunId());
  }

  // ---- cold-start hydration ------------------------------------------------

  private async hydrateIfEmpty(): Promise<void> {
    const hasEvents = this.ctx.storage
      .sql
      .exec(`SELECT 1 AS x FROM events LIMIT 1`)
      .toArray()
      .length > 0;
    const hasFindings = this.ctx.storage.sql.exec(`SELECT 1 AS x FROM findings LIMIT 1`).toArray().length > 0;
    if (hasEvents || hasFindings) return; // not empty -> already hydrated or fresh-and-clean
    const text = await this.artifacts.getText(SNAPSHOT_KEY);
    if (text == null) return; // nothing to restore yet
    try {
      const snap = JSON.parse(text) as RigSnapshot;
      await this.applySnapshot(snap);
    } catch {
      /* corrupt snapshot: start clean rather than crash the DO */
    }
  }

  private async applySnapshot(snap: RigSnapshot): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (snap.runId) await this.setMeta("runId", snap.runId);
    for (const t of snap.tasks ?? []) sql.exec(`INSERT OR REPLACE INTO tasks (id, status, data) VALUES (?, ?, ?)`, t.id, t.status, JSON.stringify(t));
    for (const f of snap.findings ?? [])
      sql.exec(`INSERT OR REPLACE INTO findings (id, created_at, data) VALUES (?, ?, ?)`, f.id, f.createdAt, JSON.stringify(this.stripFinding(f)));
    for (const b of snap.bundles ?? [])
      sql.exec(`INSERT OR REPLACE INTO bundles (finding_id, created_at, data) VALUES (?, ?, ?)`, b.findingId, b.createdAt, JSON.stringify(b));
    for (const s of snap.seats ?? [])
      sql.exec(
        `INSERT OR REPLACE INTO seats (name, status, last_message, last_active_at, processed) VALUES (?, ?, ?, ?, ?)`,
        s.name,
        s.status,
        s.lastMessage ?? null,
        s.lastActiveAt ?? null,
        s.processed,
      );
    for (const ev of snap.events ?? []) sql.exec(`INSERT INTO events (ts, data) VALUES (?, ?)`, ev.ts, JSON.stringify(ev));
    await this.trimEvents();
  }

  // ---- meta helpers --------------------------------------------------------

  private getMeta(k: string): string | null {
    const r = this.row<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k);
    return r ? r.v : null;
  }

  private async setMeta(k: string, v: string): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, v);
    await this.ctx.storage.sync();
  }

  private get activeRun(): ActiveRun | null {
    const raw = this.getMeta("activeRun");
    return raw ? (JSON.parse(raw) as ActiveRun) : null;
  }

  private set activeRun(a: ActiveRun | null) {
    if (a == null) this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'activeRun'`);
    else this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('activeRun', ?)`, JSON.stringify(a));
  }

  // ---- typed SQLite read helpers ------------------------------------------
  // SQLite rows arrive as SqlStorageValue; the generic on exec<T>() pins each
  // selected column to its precise type, so callers read string|number|null views.

  private all<T extends Record<string, SqlStorageValue>>(sql: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(sql, ...bindings).toArray();
  }

  private row<T extends Record<string, SqlStorageValue>>(sql: string, ...bindings: unknown[]): T | undefined {
    return this.ctx.storage.sql.exec<T>(sql, ...bindings).toArray()[0];
  }

  // ---- read views ----------------------------------------------------------

  private listSeats(): SeatState[] {
    const rows = this.all<{
      name: string;
      status: string;
      last_message: string | null;
      last_active_at: string | null;
      processed: number;
    }>(`SELECT name, status, last_message, last_active_at, processed FROM seats`);
    const byName = new Map(rows.map((r) => [r.name, r] as const));
    return SEAT_ORDER.map((name) => {
      const r = byName.get(name);
      return {
        name,
        status: (r?.status as SeatState["status"]) ?? "idle",
        lastMessage: r?.last_message ?? undefined,
        lastActiveAt: r?.last_active_at ?? undefined,
        processed: r?.processed ?? 0,
      };
    });
  }

  private listFindings(): Finding[] {
    return this.all<{ data: string }>(`SELECT data FROM findings ORDER BY created_at DESC`).map((r) => JSON.parse(r.data) as Finding);
  }

  private listBundles(): BundleRecord[] {
    return this.all<{ data: string }>(`SELECT data FROM bundles ORDER BY created_at DESC`).map((r) => JSON.parse(r.data) as BundleRecord);
  }

  private listEvents(limit: number): RigEvent[] {
    return this.all<{ data: string }>(`SELECT data FROM events ORDER BY seq DESC LIMIT ?`, limit)
      .reverse()
      .map((r) => JSON.parse(r.data) as RigEvent);
  }

  private computeStats(): RigStats {
    const scalar = (q: string, ...b: unknown[]): number => this.row<{ n: number }>(q, ...b)?.n ?? 0;
    return {
      tasksQueued: scalar(`SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done','failed')`),
      tasksDone: scalar(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'`),
      tasksFailed: scalar(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'failed'`),
      findingsAccepted: scalar(`SELECT COUNT(*) AS n FROM findings WHERE json_extract(data,'$.verdict') = 'accepted'`),
      findingsRejected: scalar(`SELECT COUNT(*) AS n FROM findings WHERE json_extract(data,'$.verdict') = 'rejected'`),
      findingsReview: scalar(`SELECT COUNT(*) AS n FROM findings WHERE json_extract(data,'$.verdict') = 'needs-more-data'`),
      bundlesAnchored: scalar(`SELECT COUNT(*) AS n FROM bundles WHERE json_extract(data,'$.solanaTx') IS NOT NULL`),
    };
  }

  /** Compact state the SSE/WS "state" pulse carries (parity with the Node feed). */
  private statePulse(): { runId: string; stats: RigStats; seats: SeatState[]; activeRun: ActiveRun | null } {
    return { runId: this.getMeta("runId") ?? "", stats: this.computeStats(), seats: this.listSeats(), activeRun: this.activeRun };
  }

  // ---- public read API (DO RPC, used by the Worker) ------------------------

  getState(): DashboardState {
    return {
      runId: this.getMeta("runId") ?? "",
      codeVersion: this.env.CODE_VERSION,
      activeRun: this.activeRun,
      seats: this.listSeats(),
      findings: this.listFindings(),
      bundles: this.listBundles(),
      events: this.listEvents(150),
      stats: this.computeStats(),
    };
  }

  listFindingsPublic(): Finding[] {
    return this.listFindings();
  }

  getFinding(id: string): Finding | undefined {
    const r = this.row<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, id);
    return r ? (JSON.parse(r.data) as Finding) : undefined;
  }

  listLedger(): LedgerEntry[] {
    return this.all<{ data: string }>(`SELECT data FROM ledger ORDER BY anchored_at DESC`).map((r) => JSON.parse(r.data) as LedgerEntry);
  }

  snapshot(): RigSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      runId: this.getMeta("runId") ?? "",
      tasks: this.all<{ data: string }>(`SELECT data FROM tasks ORDER BY id`).map((r) => JSON.parse(r.data) as Task),
      findings: this.listFindings(),
      seats: this.listSeats(),
      bundles: this.listBundles(),
      events: this.listEvents(MAX_EVENTS),
      stats: this.computeStats(),
    };
  }

  async saveSnapshot(): Promise<{ ok: boolean; key: string }> {
    await this.artifacts.put(SNAPSHOT_KEY, JSON.stringify(this.snapshot(), null, 2), "application/json");
    return { ok: true, key: SNAPSHOT_KEY };
  }

  // ---- run mutex -----------------------------------------------------------

  /**
   * Atomically claim the run slot. Returns { ok: false, code: 409 } when a run is
   * already in progress (mirrors the Node server's single-run guard). Otherwise
   * starts a fresh run (or resumes) and returns the runId to launch a Workflow with.
   */
  async startRunIfIdle(params: RunParams): Promise<{ ok: boolean; runId: string; code?: number }> {
    const current = this.activeRun;
    if (current?.running) {
      // A slot claimed by a Workflow that died before releasing it would lock every
      // future run (permanent 409). Treat a claim older than 30 minutes as stale and
      // allow takeover; live runs of that length are far outside any normal path.
      const started = Date.parse(current.startedAt);
      const stale = !Number.isFinite(started) || Date.now() - started > 30 * 60 * 1000;
      if (!stale) return { ok: false, runId: current.runId, code: 409 };
      await this.emitEvent("reporter", "warn", `Releasing stale run ${current.runId} (claimed over 30 minutes ago and never finished); starting a new run.`);
    }
    const runId = params.resume ? this.getMeta("runId") ?? params.runId : params.runId || RigStateDO.makeRunId();
    await this.setMeta("runId", runId);
    this.activeRun = { runId, startedAt: new Date().toISOString(), running: true };
    await this.ctx.storage.sync();
    await this.emitEvent(
      "data-fetch",
      "info",
      `Run ${runId} started from the dashboard: ${params.targets} target${params.targets === 1 ? "" : "s"}, ${params.offline ? "offline catalog" : "live NASA archive"}${params.resume ? ", resuming" : ""}.`,
    );
    return { ok: true, runId };
  }

  /** Release the run slot with a summary or an error (called by the Workflow tail). */
  async finishRun(result: { summary?: ActiveRun["summary"]; error?: string }): Promise<void> {
    const current = this.activeRun;
    const finished: ActiveRun = {
      runId: current?.runId ?? this.getMeta("runId") ?? "",
      startedAt: current?.startedAt ?? new Date().toISOString(),
      running: false,
      finishedAt: new Date().toISOString(),
      summary: result.summary,
      error: result.error,
    };
    this.activeRun = finished;
    await this.ctx.storage.sync();
    await this.broadcastState();
  }

  static makeRunId(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // ---- mutations (each broadcasts a state pulse) ---------------------------

  async emitEvent(seat: SeatName, level: RigEvent["level"], message: string, data?: Record<string, unknown>): Promise<RigEvent> {
    const ev: RigEvent = { ts: new Date().toISOString(), seat, level, message, data };
    this.ctx.storage.sql.exec(`INSERT INTO events (ts, data) VALUES (?, ?)`, ev.ts, JSON.stringify(ev));
    await this.trimEvents();
    this.broadcast({ event: "log", id: ev.ts, data: ev });
    return ev;
  }

  private async trimEvents(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?`, MAX_EVENTS);
    await this.ctx.storage.sync();
  }

  async setSeatStatus(seat: SeatName, status: SeatState["status"], lastMessage?: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE seats SET status = ?, last_active_at = ?, last_message = COALESCE(?, last_message) WHERE name = ?`,
      status,
      new Date().toISOString(),
      lastMessage ?? null,
      seat,
    );
    await this.ctx.storage.sync();
    await this.broadcastState();
  }

  async markSeatProcessed(seat: SeatName): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE seats SET processed = processed + 1 WHERE name = ?`, seat);
    await this.ctx.storage.sync();
    await this.broadcastState();
  }

  async addTask(task: Task): Promise<Task> {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO tasks (id, status, data) VALUES (?, ?, ?)`, task.id, task.status, JSON.stringify(task));
    await this.ctx.storage.sync();
    return task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
    const row = this.row<{ data: string }>(`SELECT data FROM tasks WHERE id = ?`, id);
    if (!row) return undefined;
    const next = { ...JSON.parse(row.data), ...patch } as Task;
    this.ctx.storage.sql.exec(`UPDATE tasks SET status = ?, data = ? WHERE id = ?`, next.status, JSON.stringify(next), id);
    await this.ctx.storage.sync();
    await this.broadcastState();
    return next;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const row = this.row<{ data: string }>(`SELECT data FROM tasks WHERE id = ?`, id);
    return row ? (JSON.parse(row.data) as Task) : undefined;
  }

  /**
   * Resume helper for the Workflow: returns just the task's status (empty string when
   * the task is unknown). A non-nullable return keeps the DO-RPC proxy type clean across
   * the network boundary, so callers never get an `undefined` union that collapses.
   */
  async taskStatus(id: string): Promise<string> {
    const r = this.row<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, id);
    return r?.status ?? "";
  }

  async recordFinding(finding: Finding): Promise<Finding> {
    // Finding ids are deterministic (F-<target>): a re-run must NOT silently un-anchor a previously
    // sealed finding. But the anchor stamp is only carried across when the bundle hash is UNCHANGED:
    // if a re-run produced a different bundle, inheriting the old solanaTx would advertise provenance
    // for a bundle the chain never anchored (the hash-drift bug). The on-chain tx + ledger stay valid
    // for the prior hash; the new bundle starts un-anchored and can be re-anchored on its own merits.
    const prev = this.row<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, finding.id);
    const prevFinding = prev ? (JSON.parse(prev.data) as Finding) : undefined;
    const prevTx = prevFinding?.solanaTx != null && prevFinding.bundleHash === finding.bundleHash ? prevFinding.solanaTx : undefined;
    const stored = this.stripFinding({ ...finding, solanaTx: finding.solanaTx ?? prevTx });
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO findings (id, created_at, data) VALUES (?, ?, ?)`, stored.id, stored.createdAt, JSON.stringify(stored));
    await this.ctx.storage.sync();
    await this.broadcastState();
    return stored;
  }

  async updateFinding(id: string, patch: Partial<Finding>): Promise<Finding | undefined> {
    const row = this.row<{ data: string }>(`SELECT data FROM findings WHERE id = ?`, id);
    if (!row) return undefined;
    const next = this.stripFinding({ ...JSON.parse(row.data), ...patch } as Finding);
    this.ctx.storage.sql.exec(`UPDATE findings SET created_at = ?, data = ? WHERE id = ?`, next.createdAt, JSON.stringify(next), id);
    await this.ctx.storage.sync();
    await this.broadcastState();
    return next;
  }

  async recordBundle(bundle: BundleRecord): Promise<BundleRecord> {
    // Same hash-guarded anchor preservation as recordFinding (deterministic finding ids).
    const prev = this.row<{ data: string }>(`SELECT data FROM bundles WHERE finding_id = ?`, bundle.findingId);
    const prevBundle = prev ? (JSON.parse(prev.data) as BundleRecord) : undefined;
    const prevTx = prevBundle?.solanaTx != null && prevBundle.hash === bundle.hash ? prevBundle.solanaTx : undefined;
    const stored = { ...bundle, solanaTx: bundle.solanaTx ?? prevTx };
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO bundles (finding_id, created_at, data) VALUES (?, ?, ?)`, stored.findingId, stored.createdAt, JSON.stringify(stored));
    await this.ctx.storage.sync();
    await this.broadcastState();
    return stored;
  }

  async updateBundle(findingId: string, patch: Partial<BundleRecord>): Promise<BundleRecord | undefined> {
    const row = this.row<{ data: string }>(`SELECT data FROM bundles WHERE finding_id = ?`, findingId);
    if (!row) return undefined;
    const next = { ...JSON.parse(row.data), ...patch } as BundleRecord;
    this.ctx.storage.sql.exec(`UPDATE bundles SET created_at = ?, data = ? WHERE finding_id = ?`, next.createdAt, JSON.stringify(next), findingId);
    await this.ctx.storage.sync();
    await this.broadcastState();
    return next;
  }

  async upsertLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ledger (finding_id, anchored_at, data) VALUES (?, ?, ?)`, entry.findingId, entry.anchoredAt ?? null, JSON.stringify(entry));
    await this.ctx.storage.sync();
    await this.broadcastState();
    return entry;
  }

  /**
   * Moderation tool: permanently drop every stored event whose payload contains
   * `match` (e.g. a secret that leaked into an error string before redaction).
   * Returns how many events were removed. Callers should saveSnapshot() afterwards
   * so the R2 checkpoint cannot re-hydrate the removed rows.
   */
  async redactEvents(match: string): Promise<number> {
    if (!match) return 0;
    const count = (): number => this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM events`)?.n ?? 0;
    const before = count();
    this.ctx.storage.sql.exec(`DELETE FROM events WHERE data LIKE ?`, `%${match}%`);
    await this.ctx.storage.sync();
    const removed = before - count();
    if (removed > 0) await this.broadcastState();
    return removed;
  }

  /**
   * Anchor one finding's bundle hash on Solana mainnet, executed INSIDE the DO: chain
   * I/O is wall-clock bound (not CPU), and serialising every submit through this single
   * instance means one fee-payer never races itself on blockhash reuse. The fee-payer
   * keypair comes from the `SOLANA_KEYPAIR` secret (a JSON byte array); endpoints come
   * from the private `SOLANA_RPC` + `SOLANA_RPC_FALLBACKS` vars. The outcome is written
   * to the SQLite ledger and, on success, stamped onto the finding + bundle (solanaTx).
   * Returns a plain serializable result the Worker maps straight to an HTTP response.
   */
  async anchorFinding(
    findingId: string,
    opts?: { dryRun?: boolean },
  ): Promise<{ ok: boolean; memo?: string; signature?: string; slot?: number; error?: string; httpStatus: number; dryRun?: boolean; alreadyAnchored?: boolean }> {
    const f = this.getFinding(findingId);
    if (!f) return { ok: false, httpStatus: 404, error: "finding not found" };
    if (!f.bundleHash) return { ok: false, httpStatus: 400, error: "finding has no bundle hash yet (run the reporter first)" };

    const memo = buildMemo(findingId, f.bundleHash);
    if (opts?.dryRun) return { ok: true, memo, dryRun: true, httpStatus: 200 };
    if (!this.env.SOLANA_KEYPAIR)
      return { ok: false, memo, httpStatus: 400, error: "no SOLANA_KEYPAIR secret configured on the Worker (set it with: wrangler secret put SOLANA_KEYPAIR)" };

    // Idempotency guard: the same bundle hash is anchored at most once -- repeat calls
    // (double clicks, retries, scripts) must never spend mainnet fees again. Return the
    // existing receipt and re-stamp the finding/bundle card in case an older re-run
    // cleared the solanaTx field before merge-preservation existed.
    const prior = this.row<{ data: string }>(`SELECT data FROM ledger WHERE finding_id = ?`, findingId);
    if (prior) {
      const e = JSON.parse(prior.data) as LedgerEntry;
      if (e.status === "anchored" && e.signature && e.bundleHash === f.bundleHash) {
        if (f.solanaTx !== e.signature) {
          await this.updateFinding(findingId, { solanaTx: e.signature });
          await this.updateBundle(findingId, { solanaTx: e.signature });
        }
        return { ok: true, memo, signature: e.signature, slot: e.slot, httpStatus: 200, alreadyAnchored: true };
      }
    }

    const endpoints = endpointList(undefined, this.env.SOLANA_RPC, this.env.SOLANA_RPC_FALLBACKS);
    await this.emitEvent("reporter", "info", `Anchoring ${findingId} on Solana mainnet...`);

    let res: AnchorCoreResult;
    try {
      const kp = await keypairFromSecretJson(this.env.SOLANA_KEYPAIR);
      res = await anchorOnEndpoints(endpoints, kp, findingId, f.bundleHash, { commitment: "confirmed" });
    } catch (e) {
      res = { ok: false, memo, error: e instanceof Error ? e.message : String(e) };
    }

    const entry: LedgerEntry = {
      findingId,
      bundleHash: f.bundleHash,
      memo,
      status: res.ok ? "anchored" : "failed",
      signature: res.signature,
      slot: res.slot,
      publicKey: res.publicKey,
      explorerUrl: res.signature ? explorerUrl(res.signature) : undefined,
      error: res.error,
      anchoredAt: res.ok ? new Date().toISOString() : undefined,
    };
    await this.upsertLedger(entry);

    if (res.ok && res.signature) {
      await this.updateFinding(findingId, { solanaTx: res.signature });
      await this.updateBundle(findingId, { solanaTx: res.signature });
    }
    await this.emitEvent(
      "reporter",
      res.ok ? "result" : "warn",
      res.ok && res.signature
        ? `Anchored ${findingId} on mainnet: tx ${res.signature.slice(0, 16)}... (slot ${res.slot}).`
        : `Anchor failed for ${findingId}: ${res.error ?? "unknown"} -- the bundle hash is still valid off-chain.`,
    );
    return { ok: res.ok, memo, signature: res.signature, slot: res.slot, error: res.error, httpStatus: 200 };
  }

  /**
   * Anchor a sealed DELIBERATION receipt hash on Solana mainnet using a SEPARATE memo
   * schema (sdr:delib:1|<id>|<hash>) -- deliberately distinct from the science bundle memo
   * and never written to the SQLite bundle ledger. Chain I/O runs inside the DO exactly
   * like anchorFinding (serialised fee-payer, wall-clock bound). The Worker route owns
   * idempotency + R2 persistence of the resulting tx; this method only builds/sends the
   * memo (or previews it on dryRun) and returns a plain serializable result.
   */
  async anchorDeliberation(
    findingId: string,
    deliberationHash: string,
    opts?: { dryRun?: boolean },
  ): Promise<{ ok: boolean; memo?: string; signature?: string; slot?: number; error?: string; httpStatus: number; dryRun?: boolean }> {
    if (!deliberationHash) return { ok: false, httpStatus: 400, error: "no deliberation hash to anchor (seal the receipt first)" };
    const memo = buildDeliberationMemo(findingId, deliberationHash);
    if (opts?.dryRun) return { ok: true, memo, dryRun: true, httpStatus: 200 };
    if (!this.env.SOLANA_KEYPAIR)
      return { ok: false, memo, httpStatus: 400, error: "no SOLANA_KEYPAIR secret configured on the Worker (set it with: wrangler secret put SOLANA_KEYPAIR)" };

    const endpoints = endpointList(undefined, this.env.SOLANA_RPC, this.env.SOLANA_RPC_FALLBACKS);
    await this.emitEvent("reporter", "info", `Anchoring deliberation for ${findingId} on Solana mainnet...`);

    let res: AnchorCoreResult;
    try {
      const kp = await keypairFromSecretJson(this.env.SOLANA_KEYPAIR);
      res = await anchorMemoOnEndpoints(endpoints, kp, memo, { commitment: "confirmed" });
    } catch (e) {
      res = { ok: false, memo, error: e instanceof Error ? e.message : String(e) };
    }

    await this.emitEvent(
      "reporter",
      res.ok ? "result" : "warn",
      res.ok && res.signature
        ? `Anchored deliberation for ${findingId}: tx ${res.signature.slice(0, 16)}... (slot ${res.slot}).`
        : `Deliberation anchor failed for ${findingId}: ${res.error ?? "unknown"} -- the receipt hash is still valid off-chain.`,
    );
    return { ok: res.ok, memo, signature: res.signature, slot: res.slot, error: res.error, httpStatus: 200 };
  }

  /**
   * Budget-gated auto-anchor for autonomous (cron) runs. Deliberately spends
   * NOTHING unless an operator opts in via Worker vars:
   *   AUTO_ANCHOR = "off" (default)   -> no-op, returns immediately.
   *   AUTO_ANCHOR = "dry"             -> previews the bundle memo (dryRun), no fee
   *                                       payer touched, no SOL spent.
   *   AUTO_ANCHOR = "live"            -> real mainnet anchor, but ONLY while the
   *                                       per-UTC-day count stays under
   *                                       AUTO_ANCHOR_DAILY_CAP (default 0, so even
   *                                       "live" spends nothing until a cap is set).
   * Idempotency (a hash already in the ledger is replayed without new spend) is
   * inherited from anchorFinding, so a re-run never double-pays.
   */
  async autoAnchorBudgeted(
    findingId: string,
  ): Promise<{ performed: boolean; mode: string; spentSol: boolean; reason: string; memo?: string; signature?: string; remainingDaily?: number }> {
    const mode = (this.env.AUTO_ANCHOR ?? "off").toLowerCase();
    if (mode !== "dry" && mode !== "live") {
      return { performed: false, mode: "off", spentSol: false, reason: "auto-anchor disabled (set AUTO_ANCHOR=dry|live to enable)" };
    }
    if (mode === "dry") {
      const r = await this.anchorFinding(findingId, { dryRun: true });
      return { performed: r.ok, mode, spentSol: false, reason: r.ok ? "dry-run preview (no fee payer touched)" : (r.error ?? "preview failed"), memo: r.memo };
    }

    // live mode: enforce the per-day budget BEFORE any spend.
    const cap = Math.max(0, parseInt(this.env.AUTO_ANCHOR_DAILY_CAP ?? "0", 10) || 0);
    const day = new Date().toISOString().slice(0, 10);
    const row = this.row<{ v: string }>(`SELECT v FROM meta WHERE k = 'autoAnchorDay'`);
    let count = 0;
    if (row) {
      try {
        const rec = JSON.parse(row.v) as { day?: string; count?: number };
        if (rec.day === day) count = rec.count ?? 0;
      } catch { /* treat an unreadable counter as 0 for a fresh day */ }
    }
    if (count >= cap) {
      await this.emitEvent("reporter", "warn", `Auto-anchor skipped for ${findingId}: daily live budget ${cap}/day exhausted (AUTO_ANCHOR_DAILY_CAP).`);
      return { performed: false, mode, spentSol: false, reason: `daily live-anchor budget exhausted (${cap}/day)`, remainingDaily: 0 };
    }

    const r = await this.anchorFinding(findingId, { dryRun: false });
    const newSpend = r.ok && !r.alreadyAnchored;
    if (newSpend) {
      this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('autoAnchorDay', ?)`, JSON.stringify({ day, count: count + 1 }));
      await this.ctx.storage.sync();
    }
    return {
      performed: r.ok,
      mode,
      spentSol: newSpend,
      reason: r.ok ? (r.alreadyAnchored ? "already anchored (idempotent, no new spend)" : "anchored on mainnet within budget") : (r.error ?? "anchor failed"),
      memo: r.memo,
      signature: r.signature,
      remainingDaily: Math.max(0, cap - (count + (newSpend ? 1 : 0))),
    };
  }

  // Drop the heavy per-fold sample from the persisted finding: it is deterministic
  // (regenerable by detectTransit) and would bloat SQLite rows + WS frames.
  private stripFinding(f: Finding): Finding {
    if (!f.candidate || f.candidate.folded == null) return f;
    const candidate = { ...f.candidate, folded: undefined };
    return { ...f, candidate };
  }

  // ---- WebSocket fan-out (Hibernation) -------------------------------------

  private broadcast(msg: Json): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* socket dropped between getWebSockets and send */
      }
    }
  }

  private async broadcastState(): Promise<void> {
    this.broadcast({ event: "state", data: this.statePulse() });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Live feed upgrade: create the pair, accept the server side for Hibernation,
    // and hand the client side back through the 101 response.
    if (url.pathname === "/events") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const state = this.getState();
      server.send(JSON.stringify({ event: "hello", data: { runId: state.runId, codeVersion: this.env.CODE_VERSION ?? "unknown", ts: new Date().toISOString() } }));
      for (const ev of this.listEvents(80)) server.send(JSON.stringify({ event: "log", id: ev.ts, data: ev }));
      server.send(JSON.stringify({ event: "state", data: this.statePulse() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Simple health probe for the DO (used by the worker /health within-check + debugging).
    if (url.pathname === "/ping") return Response.json({ ok: true, within: "RigStateDO", runId: this.getMeta("runId") });

    return new Response(`RigStateDO: unknown path ${url.pathname}`, { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // The client sends tiny control frames; "refresh" asks for a fresh state pulse.
    if (typeof message === "string" && message === "refresh") {
      try {
        ws.send(JSON.stringify({ event: "state", data: this.statePulse() }));
      } catch {
        /* ignore */
      }
    }
  }

  webSocketClose(): void {
    /* Hibernation reaps the socket automatically. */
  }

  webSocketError(): void {
    /* Hibernation reaps the socket automatically. */
  }
}
