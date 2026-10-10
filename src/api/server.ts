// Space Data Rig :: HTTP API + SSE event stream.
//
// This is the live window into the rig. It serves:
//   - a JSON API the dashboard reads (state, findings, bundles, ledger)
//   - an SSE feed (/api/events) that streams seat events the instant they happen
//   - the static dashboard under web/ (index.html, app.js, styles.css)
//   - POST /api/run to drive the SAME Orchestrator the CLI uses, on the SAME
//     shared RigStore, so a run started from the browser streams live to every
//     connected client.
//
// The server is stateless beyond the store: on boot it loads the last snapshot
// (out/state/rig.json) so a restart shows the previous run's findings, and every
// mutating action (run, anchor) re-saves that snapshot. No database required.

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RigStore } from "../core/store.ts";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/pipeline.ts";
import { getFallbackCatalog } from "../data/exoplanetArchive.ts";
import { seatRole } from "../reporter/narrate.ts";
import { verifyBundle } from "../bundle/bundle.ts";
import { FsArtifactStore } from "../node/artifact-store.ts";
import { readCodeVersion } from "../node/code-version.ts";
import { discussionMode, llmProviderLabel } from "../ai/llm.ts";
import { threadsFor, buildDiscussion } from "../ai/discussion.ts";
import {
  anchorBundleHash,
  upsertLedger,
  readLedger,
  explorerUrl,
  type LedgerEntry,
} from "../solana/anchor.ts";
import type { Finding } from "../core/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(REPO_ROOT, "out");
const WEB_DIR = resolve(REPO_ROOT, "web");
const STATE_PATH = resolve(OUT_DIR, "state", "rig.json");
const BUNDLES_DIR = resolve(OUT_DIR, "bundles");
const LEDGER_PATH = resolve(OUT_DIR, "ledger.json");

// Artifact reader for the bundle endpoints. Same key layout as the Workers R2 store,
// so manifest/verify/artifact logic is runtime-agnostic (Node fs here, R2 on the edge).
const artifacts = new FsArtifactStore(OUT_DIR);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0"; // bind all interfaces so Docker health checks reach us
const codeVersion = readCodeVersion(resolve(REPO_ROOT, "package.json"));

// Honest descriptor of the discussion engine, read once and reused by the API.
const ai = { mode: discussionMode(), provider: llmProviderLabel() };

// ---- shared rig state ------------------------------------------------------

const store = new RigStore();
const snapshotLoaded = store.load(STATE_PATH);

interface ActiveRun {
  runId: string;
  startedAt: string;
  running: boolean;
  finishedAt?: string;
  error?: string;
  summary?: { targets: number; accepted: number; review: number; rejected: number; bundles: number; catalogSource: string };
}
let activeRun: ActiveRun | null = null;

// ---- helpers ---------------------------------------------------------------

/** Reject path-traversal in user-supplied names (finding ids, artifact files). */
function safeName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, "");
  return clean.includes("..") ? "" : clean;
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** A finding plus a couple of derived fields the board renders directly. */
function findingView(f: Finding) {
  return { ...f, depthPpm: Math.round(f.candidate.depthFrac * 1e6) };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(c: Context, rel: string): Response | Promise<Response> {
  const p = resolve(WEB_DIR, rel);
  if (!p.startsWith(WEB_DIR) || !existsSync(p)) return c.notFound();
  const ext = p.slice(p.lastIndexOf("."));
  const type = MIME[ext] ?? "application/octet-stream";
  return c.body(readFileSync(p, "utf8"), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
}

// ---- app -------------------------------------------------------------------

const app = new Hono();
app.use("/api/*", cors());

// Liveness / readiness probe (used by docker-compose + rig.yaml services.wait_for).
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "space-data-rig-api",
    codeVersion,
    runId: store.runId,
    snapshotLoaded,
    running: activeRun?.running ?? false,
    uptimeSec: Math.round(process.uptime()),
    ai,
  }),
);

// Full dashboard payload: one call gives the frontend everything to render.
app.get("/api/state", (c) =>
  c.json({
    runId: store.runId,
    codeVersion,
    snapshotLoaded,
    activeRun,
    stats: store.computeStats(),
    seats: store.listSeats().map((s) => ({ ...s, role: seatRole(s.name) })),
    findings: store.listFindings().map(findingView),
    bundles: store.listBundles(),
    events: store.recentEvents(150),
    ai,
  }),
);

app.get("/api/run/status", (c) => c.json({ activeRun }));

// Multi-seat war-room threads. Grounded by default (composed from each finding's real
// numbers); the mode field tells the UI whether a live chat model is wired in.
app.get("/api/discussion", (c) => c.json({ ...ai, threads: threadsFor(store.listFindings()) }));

// Single thread, enriched live when a chat key is present (adds a real critic caveat).
app.get("/api/discussion/:id", async (c) => {
  const id = safeName(c.req.param("id"));
  const f = id ? store.getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  return c.json({ findingId: f.id, targetId: f.targetId, verdict: f.verdict, ...ai, turns: await buildDiscussion(f) });
});

app.get("/api/findings", (c) => c.json({ findings: store.listFindings().map(findingView) }));

app.get("/api/findings/:id", (c) => {
  const id = safeName(c.req.param("id"));
  const f = id ? store.getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  return c.json(findingView(f));
});

app.get("/api/bundles", (c) => c.json({ bundles: store.listBundles() }));

app.get("/api/bundles/:id/manifest", async (c) => {
  const id = safeName(c.req.param("id"));
  if (!id) return c.json({ error: "bundle not found" }, 404);
  const text = await artifacts.getText(`bundles/${id}/manifest.json`);
  if (text == null) return c.json({ error: "bundle not found" }, 404);
  return c.json(JSON.parse(text) as Record<string, unknown>);
});

// Independent audit: recompute the hash + re-hash every artifact from the store.
app.get("/api/bundles/:id/verify", async (c) => {
  const id = safeName(c.req.param("id"));
  if (!id || !(await artifacts.exists(`bundles/${id}/manifest.json`))) return c.json({ error: "bundle not found" }, 404);
  try {
    return c.json({ findingId: id, ...(await verifyBundle(artifacts, id)) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

const ARTIFACT_ALLOW = new Set(["folded.svg", "periodogram.svg", "timeseries.svg"]);
app.get("/api/bundles/:id/artifact/:name", async (c) => {
  const id = safeName(c.req.param("id"));
  const name = c.req.param("name");
  if (!id || !ARTIFACT_ALLOW.has(name)) return c.json({ error: "artifact not allowed" }, 400);
  const text = await artifacts.getText(`bundles/${id}/${name}`);
  if (text == null) return c.json({ error: "artifact not found" }, 404);
  return c.body(text, 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});

// On-chain provenance ledger (works even when every RPC is unreachable).
app.get("/api/ledger", (c) => c.json({ ledger: readLedger(LEDGER_PATH) }));

// Live event feed. Sends a small backlog, then streams every new seat event and
// a compact state pulse on each mutation, with a keep-alive ping.
app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ runId: store.runId, codeVersion, ts: new Date().toISOString() }) });
    for (const ev of store.recentEvents(80)) {
      await stream.writeSSE({ event: "log", id: ev.ts, data: JSON.stringify(ev) });
    }
    const pushState = () =>
      stream
        .writeSSE({
          event: "state",
          data: JSON.stringify({ runId: store.runId, stats: store.computeStats(), seats: store.listSeats(), activeRun }),
        })
        .catch(() => {});

    const unsubEvent = store.subscribe((ev) => {
      stream.writeSSE({ event: "log", id: ev.ts, data: JSON.stringify(ev) }).catch(() => {});
    });
    const unsubChange = store.onChange(() => {
      pushState();
    });

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      unsubEvent();
      unsubChange();
    });

    await pushState();
    while (!aborted) {
      await stream.sleep(15000);
      if (aborted) break;
      await stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {
        aborted = true;
      });
    }
  }),
);

// Kick off a pipeline run on the shared store. Returns immediately; progress
// arrives over SSE. Only one run at a time.
app.post("/api/run", async (c) => {
  if (activeRun?.running) return c.json({ error: "a run is already in progress", runId: activeRun.runId }, 409);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const targets = clampInt(body.targets, 1, 50, 4);
  const stageDelayMs = clampInt(body.delay ?? body.stageDelayMs, 0, 5000, 300);
  const confidenceTrials = clampInt(body.confidence ?? body.confidenceTrials, 1, 64, 8);
  const maxTmag = clampFloat(body.tmag ?? body.maxTmag, 0, 20, 11);
  const resume = Boolean(body.resume);
  const offline = Boolean(body.offline);

  if (!resume) store.runId = RigStore.makeRunId();
  const catalog = offline
    ? getFallbackCatalog({ maxTmag, limit: Math.max(40, targets * 6), minPeriodDays: 1, maxPeriodDays: 14 })
    : undefined;

  const opts: OrchestratorOptions = {
    maxTargets: targets,
    stageDelayMs,
    confidenceTrials,
    maxTmag,
    resume,
    catalog,
    outDir: OUT_DIR,
    snapshotPath: STATE_PATH,
  };

  const orch = new Orchestrator(store, opts);
  activeRun = { runId: store.runId, startedAt: new Date().toISOString(), running: true };
  store.emitEvent("data-fetch", "info", `Run ${store.runId} started from the dashboard: ${targets} target${targets === 1 ? "" : "s"}, ${offline ? "offline catalog" : "live NASA archive"}${resume ? ", resuming" : ""}.`);

  orch
    .run()
    .then((summary) => {
      activeRun = {
        runId: summary.runId,
        startedAt: activeRun?.startedAt ?? new Date().toISOString(),
        running: false,
        finishedAt: new Date().toISOString(),
        summary: {
          targets: summary.targets,
          accepted: summary.accepted,
          review: summary.review,
          rejected: summary.rejected,
          bundles: summary.bundles,
          catalogSource: summary.catalogSource,
        },
      };
      store.emitEvent("reporter", "result", `Run ${summary.runId} complete: ${summary.accepted} confirmed, ${summary.review} watchlist, ${summary.rejected} rejected, ${summary.bundles} bundles anchored-ready.`);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      activeRun = { runId: store.runId, startedAt: activeRun?.startedAt ?? new Date().toISOString(), running: false, finishedAt: new Date().toISOString(), error: msg };
      store.emitEvent("reporter", "error", `Run failed: ${msg}`);
    });

  return c.json({ ok: true, started: true, runId: store.runId, targets, offline, resume, confidenceTrials });
});

// Anchor one finding's bundle hash on Solana mainnet (or dry-run preview).
app.post("/api/anchor/:id", async (c) => {
  const id = safeName(c.req.param("id"));
  const f = id ? store.getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  if (!f.bundleHash) return c.json({ error: "finding has no bundle hash yet (run the reporter first)" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);
  const rpc = typeof body.rpc === "string" ? body.rpc : undefined;
  const keypairPath = typeof body.keypair === "string" ? resolve(body.keypair) : undefined;

  store.emitEvent("reporter", "info", `Anchoring ${f.id} on Solana mainnet${dryRun ? " (dry-run)" : ""}...`);
  const res = await anchorBundleHash(f.id, f.bundleHash, { rpcUrl: rpc, keypairPath, dryRun });

  if (!dryRun) {
    const entry: LedgerEntry = {
      findingId: f.id,
      bundleHash: f.bundleHash,
      memo: res.memo,
      status: res.ok ? "anchored" : "failed",
      signature: res.signature,
      slot: res.slot,
      publicKey: res.publicKey,
      explorerUrl: res.signature ? explorerUrl(res.signature) : undefined,
      error: res.error,
      anchoredAt: res.ok ? new Date().toISOString() : undefined,
    };
    upsertLedger(LEDGER_PATH, entry);
    if (res.ok && res.signature) {
      store.updateFinding(f.id, { solanaTx: res.signature });
      store.updateBundle(f.id, { solanaTx: res.signature });
      store.save(STATE_PATH);
    }
  }

  if (dryRun) store.emitEvent("reporter", "info", `Dry-run memo for ${f.id}: ${res.memo}`);
  else if (res.ok && res.signature) store.emitEvent("reporter", "result", `Anchored ${f.id} on mainnet: tx ${res.signature.slice(0, 16)}... (slot ${res.slot}). ${explorerUrl(res.signature)}`);
  else store.emitEvent("reporter", "warn", `Anchor failed for ${f.id}: ${res.error ?? "unknown"} -- the bundle hash is still valid off-chain.`);

  return c.json(res);
});

// ---- static dashboard ------------------------------------------------------

app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/", (c) => serveStatic(c, "index.html"));
app.get("/index.html", (c) => serveStatic(c, "index.html"));
app.get("/app.js", (c) => serveStatic(c, "app.js"));
app.get("/styles.css", (c) => serveStatic(c, "styles.css"));
app.get("/space.js", (c) => serveStatic(c, "space.js"));
app.get("/live.js", (c) => serveStatic(c, "live.js"));
app.get("/vendor/three.js", (c) => serveStatic(c, "vendor/three.js"));

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[api:error]", err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

// ---- boot ------------------------------------------------------------------

console.log("\n=== Space Data Rig :: P2 API + dashboard ===\n");
console.log(`  code version : ${codeVersion}`);
console.log(`  snapshot     : ${snapshotLoaded ? STATE_PATH + " (loaded)" : "none yet (start a run)"}`);
console.log(`  run id       : ${store.runId}`);
console.log(`  findings     : ${store.listFindings().length}  bundles: ${store.listBundles().length}  anchored: ${store.computeStats().bundlesAnchored}`);

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const addr = info.address === "0.0.0.0" || info.address === "::" ? "127.0.0.1" : info.address;
  console.log(`\n  dashboard    : http://${addr}:${info.port}/`);
  console.log(`  health       : http://${addr}:${info.port}/health`);
  console.log(`  live events  : http://${addr}:${info.port}/api/events  (SSE)`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
