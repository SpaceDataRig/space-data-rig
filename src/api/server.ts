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
import { PUBLIC_STAT_DEFINITIONS } from "../core/stats-definitions.ts";
import { summarizeState } from "../core/state-summary.ts";
import { parseFindingQuery, queryFindings } from "../core/finding-query.ts";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/pipeline.ts";
import { getFallbackCatalog } from "../data/exoplanetArchive.ts";
import { seatRole } from "../reporter/narrate.ts";
import { verifyBundle, hashManifest, hashScience } from "../bundle/bundle.ts";
import { isAdminAuthorized, ADMIN_UNAUTHORIZED } from "../core/auth.ts";
import { FsArtifactStore } from "../node/artifact-store.ts";
import { readCodeVersion } from "../node/code-version.ts";
import { computeObservation, commissionObservation } from "../observe/observeApi.ts";
import { resolveAnchorDailyCap } from "../observe/paymentPolicy.ts";
import { txGetterFor } from "../observe/connection.ts";
import { buildPaymentRequired, buildPaymentResponse } from "../observe/x402.ts";
import { buildObservationEvidence } from "../observe/evidence.ts";
import { handleBrowserRpcProxy } from "../observe/rpcProxy.ts";
import { endpointList } from "../solana/anchor-core.ts";
import { readChainMemo, compareAnchor, type MemoFetch } from "../solana/memoVerify.ts";
import type { ObservationRecord } from "../observe/observation.ts";
import { discussionMode, llmProviderLabel } from "../ai/llm.ts";
import { threadsFor, buildDiscussion } from "../ai/discussion.ts";
import { buildDeliberationReceipt, hashDeliberation, persistDeliberation, verifyDeliberation } from "../ai/deliberation.ts";
import {
  anchorBundleHash,
  anchorDeliberationHash,
  anchorObservationHash,
  verifyObserveAnchor,
  upsertLedger,
  readLedger,
  explorerUrl,
  loadLocalEnv,
  type LedgerEntry,
} from "../solana/anchor.ts";
import type { Finding } from "../core/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(REPO_ROOT, "out");
const WEB_DIR = resolve(REPO_ROOT, "web");
const STATE_PATH = resolve(OUT_DIR, "state", "rig.json");
const LEDGER_PATH = resolve(OUT_DIR, "ledger.json");

// Artifact reader for the bundle endpoints. Same key layout as the Workers R2 store,
// so manifest/verify/artifact logic is runtime-agnostic (Node fs here, R2 on the edge).
const artifacts = new FsArtifactStore(OUT_DIR);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0"; // bind all interfaces so Docker health checks reach us
const codeVersion = readCodeVersion(resolve(REPO_ROOT, "package.json"));

// Hydrate process.env from the repo-root .env before anything reads it (Solana RPC,
// DEEPSEEK/GROK chat keys), so the local Node runtime behaves like the edge does with
// its wrangler bindings. Idempotent and never overrides real environment variables.
loadLocalEnv();

// Honest descriptor of the discussion engine, read once and reused by the API.
const ai = { mode: discussionMode(), provider: llmProviderLabel() };

// ---- shared rig state ------------------------------------------------------

const store = new RigStore();
const snapshotLoaded = store.load(STATE_PATH);

// The two anchor counts answer different questions (see src/core/state-types.ts), and the store cannot read the
// fs ledger itself -- so every surface this server renders passes the live rows. Read per request rather than
// once at boot: anchoring happens while the server is running, and a cached copy would report a stale total.
const ledgerRows = (): LedgerEntry[] => readLedger(LEDGER_PATH);

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
// Same-origin only: the dashboard is served by this very process, so no other browser
// origin needs (or should get) credentialed access to the state-mutating endpoints --
// a wildcard CORS here makes a local mainnet anchor click from any malicious page easy.
const LOCAL_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
app.use("/api/*", cors({ origin: (origin) => (origin && LOCAL_ORIGINS.has(origin) ? origin : undefined) }));

// Liveness / readiness probe (used by docker-compose + rig.yaml services.wait_for).
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "space-data-rig-api",
    codeVersion,
    // audit-6 P2 parity with the Worker probe: echo the deployed commit when the operator exports it.
    gitSha: process.env.GIT_SHA ?? "unknown",
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
    stats: store.computeStats(ledgerRows()),
    // Same constant the Durable Object publishes, so the local server and the edge cannot describe their counters
    // differently -- and neither one describes them from prose typed into the markup.
    statDefinitions: PUBLIC_STAT_DEFINITIONS,
    seats: store.listSeats().map((s) => ({ ...s, role: seatRole(s.name) })),
    findings: store.listFindings().map(findingView),
    bundles: store.listBundles(),
    events: store.recentEvents(150),
    ai,
  }),
);

// Audit-12 D4 parity: the same aggregate-only projection the edge serves, built from the same rows. A verifier
// pointed at either runtime gets identical populations, and neither one can fork the definitions (single source:
// src/core/stats-definitions.ts, shared by both).
app.get("/api/state/summary", (c) =>
  c.json(
    summarizeState(
      {
        runId: store.runId,
        codeVersion,
        activeRun,
        seats: store.listSeats(),
        findings: store.listFindings(),
        bundles: store.listBundles(),
        events: store.recentEvents(150),
        stats: store.computeStats(ledgerRows()),
        statDefinitions: PUBLIC_STAT_DEFINITIONS,
      } as Parameters<typeof summarizeState>[0],
      new Date().toISOString(),
    ),
  ),
);

app.get("/api/run/status", (c) => c.json({ activeRun }));

// Multi-seat war-room threads. Grounded by default (composed from each finding's real
// numbers); the mode field tells the UI whether a live chat model is wired in.
app.get("/api/discussion", (c) => c.json({ ...ai, threads: threadsFor(store.listFindings()) }));

// Single thread, enriched live when a chat key is present (adds a real critic caveat).
// The model cross-examination is also sealed as a tamper-evident receipt in its own
// namespace (never the science bundle); grounded threads produce no receipt.
app.get("/api/discussion/:id", async (c) => {
  const id = safeName(c.req.param("id"));
  const f = id ? store.getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  const turns = await buildDiscussion(f);
  let deliberationHash: string | undefined;
  if (turns.some((t) => t.model)) {
    const receipt = buildDeliberationReceipt({ findingId: f.id, targetId: f.targetId, bundleHash: f.bundleHash, turns });
    deliberationHash = await hashDeliberation(receipt);
    await persistDeliberation(artifacts, receipt, deliberationHash).catch(() => { /* seal is best-effort */ });
  }
  return c.json({ findingId: f.id, targetId: f.targetId, verdict: f.verdict, ...ai, turns, deliberationHash });
});

// Read back the sealed deliberation receipt for one finding.
app.get("/api/discussion/:id/receipt", async (c) => {
  const id = safeName(c.req.param("id"));
  const text = id ? await artifacts.getText(`deliberations/${id}/receipt.json`) : null;
  if (text == null) return c.json({ error: "deliberation not found" }, 404);
  return c.json(JSON.parse(text));
});

// Independent audit of the deliberation receipt (recompute + compare).
app.get("/api/discussion/:id/receipt/verify", async (c) => {
  const id = safeName(c.req.param("id"));
  if (!id || !(await artifacts.exists(`deliberations/${id}/receipt.json`))) return c.json({ error: "deliberation not found" }, 404);
  try {
    return c.json({ findingId: id, ...(await verifyDeliberation(artifacts, id)) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/findings", (c) => {
  const findings = store.listFindings();
  const q = parseFindingQuery(c.req.query());
  const r = queryFindings(findings, q);
  return c.json({ findings: r.rows.map(findingView), query: q, total: r.total, matched: r.matched, limit: r.limit, offset: r.offset, hasMore: r.hasMore });
});

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

// Read-only ON-CHAIN verification (audit #4): re-read this finding's sealed Solana transaction, decode the memo
// fields, and compare BOTH the bundleHash and the scienceHash the chain actually carries against the bundle this
// server reads right now. Mirrors the Worker route exactly (shared memoVerify core). GET only; reads the chain,
// spends nothing, needs no key; reports chainReadable:false rather than claiming a match it cannot check.
app.get("/api/bundles/:id/verify-onchain", async (c) => {
  const id = safeName(c.req.param("id"));
  if (!id) return c.json({ error: "bundle not found" }, 404);
  const text = await artifacts.getText(`bundles/${id}/manifest.json`);
  if (text == null) return c.json({ error: "bundle not found" }, 404);
  try {
    const manifest = JSON.parse(text) as Parameters<typeof hashManifest>[0];
    const currentBundleHash = await hashManifest(manifest);
    const currentScienceHash = await hashScience(manifest);
    const entry = readLedger(LEDGER_PATH).find((e) => e.findingId === id);
    if (!entry || entry.status !== "anchored" || !entry.signature) {
      return c.json({ findingId: id, anchored: false, chainReadable: false, verifiable: false, reason: "no anchored ledger row with a signature for this finding" });
    }
    const endpoints = endpointList(undefined, process.env.SOLANA_RPC, process.env.SOLANA_RPC_FALLBACKS);
    const fetchImpl: MemoFetch = (url, init) => fetch(url, init);
    const read = await readChainMemo({ endpoints, signature: entry.signature, fetchImpl });
    const cmp = compareAnchor(read, { findingId: id, ledgerBundleHash: entry.bundleHash, currentBundleHash, currentScienceHash });
    return c.json({ findingId: id, anchored: true, signature: entry.signature, explorerUrl: explorerUrl(entry.signature), ledgerScienceHash: entry.scienceHash, currentBundleHash, currentScienceHash, ...cmp });
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

// Name an Observation (parity with the edge /api/observe): run the same blind, deterministic pipeline on a
// user-chosen star and return the real result + sealed envelope + the sdr:observe:1 memo that WOULD anchor.
// Read public photometry + compute only -- no payment, no SOL spend, no on-chain write, no money path.
app.post("/api/observe", async (c) => {
  let body: { tic?: unknown; sector?: unknown; dedication?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const tic = typeof body.tic === "number" ? body.tic : parseInt(String(body.tic), 10);
  const sectorRaw = body.sector;
  const sector = sectorRaw == null || sectorRaw === "" ? null : typeof sectorRaw === "number" ? sectorRaw : parseInt(String(sectorRaw), 10);
  const dedication = typeof body.dedication === "string" ? body.dedication : "";
  const out = await computeObservation({ tic, sector, dedication });
  if (!out.ok) return c.json({ error: out.error, errors: out.errors }, out.status as 400);
  return c.json({ record: out.record, memo: out.memo, envelopeHash: out.envelopeHash, science: out.science });
});

// ---- named-observation commissioning (PAID path, parity with the edge) ---------------------------------
// Node-side base64 (server is Node-only): avoids relying on atob/btoa typings and mirrors the x402 headers.
const b64Decode = (s: string): unknown => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const b64Encode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

// Commission a NAMED OBSERVATION. x402 handshake identical in shape to the edge: unpaid -> 402 + X-PAYMENT-REQUIRED
// (burn exactly 10,000 $SDR); with X-PAYMENT (a burn tx SIGNATURE) the burn is re-read FROM THE CHAIN and verified
// (never trusting the client), the SAME deterministic search runs, and the envelope hash anchors on mainnet under
// the OBSERVE_ANCHOR gate. Idempotent by envelopeHash; one burn signature commissions at most one observation.
app.post("/api/observe/commission", async (c) => {
  const xPayment = c.req.header("X-PAYMENT") ?? null;
  let body: { tic?: unknown; sector?: unknown; dedication?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const tic = typeof body.tic === "number" ? body.tic : parseInt(String(body.tic), 10);
  const sectorRaw = body.sector;
  const sector = sectorRaw == null || sectorRaw === "" ? null : typeof sectorRaw === "number" ? sectorRaw : parseInt(String(sectorRaw), 10);
  const dedication = typeof body.dedication === "string" ? body.dedication : "";

  let payment: unknown = null;
  if (xPayment) {
    try {
      payment = b64Decode(xPayment);
    } catch {
      return c.json({ error: "X-PAYMENT is not valid base64-encoded JSON" }, 400);
    }
  }

  const connection = txGetterFor(undefined, process.env.SOLANA_RPC, process.env.SOLANA_RPC_FALLBACKS);
  const out = await commissionObservation({ tic, sector, dedication, payment }, { connection });
  if (!out.ok) {
    if (out.status === 402) {
      const challenge = buildPaymentRequired({ resource: "/api/observe/commission", description: "Commission a named observation: burn exactly 10,000 $SDR.", error: out.error });
      return c.json({ error: out.error }, 402, { "X-PAYMENT-REQUIRED": b64Encode(challenge) });
    }
    return c.json({ error: out.error, errors: out.errors }, out.status as 400);
  }

  const obsId = out.record.observationId;
  const envelopeHash = out.envelopeHash;
  const burnSig = out.paymentSignature;

  // replay guard: one 10,000 $SDR burn commissions exactly one observation.
  if (await artifacts.exists(`observations/by-sig/${burnSig}.json`)) {
    return c.json({ error: "payment already used: each 10,000 $SDR burn commissions exactly one observation" }, 402);
  }

  // idempotency: the same envelopeHash already anchored -> replay the prior receipt (no second spend).
  const priorText = await artifacts.getText(`observations/${envelopeHash}/anchor.json`);
  if (priorText) {
    try {
      const prior = JSON.parse(priorText) as { signature?: string; envelopeHash?: string; memo?: string; slot?: number; explorerUrl?: string };
      if (prior.signature && prior.envelopeHash === envelopeHash) {
        await artifacts.put(`observations/by-sig/${burnSig}.json`, JSON.stringify({ envelopeHash, usedAt: new Date().toISOString() }));
        const receipt = buildPaymentResponse(burnSig, explorerUrl(burnSig), new Date().toISOString());
        return c.json({ record: out.record, memo: prior.memo ?? out.memo, envelopeHash, anchored: true, alreadyAnchored: true, signature: prior.signature, slot: prior.slot, explorerUrl: prior.explorerUrl, science: out.science }, 200, { "X-PAYMENT-RESPONSE": b64Encode(receipt) });
      }
    } catch {
      /* corrupt prior record: fall through and (re)anchor */
    }
  }

  const mode = (process.env.OBSERVE_ANCHOR ?? "off").toLowerCase();
  let anchored = false;
  let dryRun = false;
  let capReached = false;
  let memo = out.memo;
  let signature: string | undefined;
  let slot: number | undefined;
  let anchorExplorer: string | undefined;

  if (mode === "dry") {
    const r = await anchorObservationHash(obsId, envelopeHash, { dryRun: true });
    dryRun = true;
    memo = r.memo;
  } else if (mode === "live") {
    const cap = resolveAnchorDailyCap(process.env.OBSERVE_ANCHOR_DAILY_CAP);
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = "observations/anchor-day.json";
    let count = 0;
    const dayText = await artifacts.getText(dayPath);
    if (dayText) {
      try {
        const rec = JSON.parse(dayText) as { day?: string; count?: number };
        if (rec.day === day) count = rec.count ?? 0;
      } catch {
        /* unreadable counter => fresh day */
      }
    }
    if (count >= cap) {
      capReached = true;
    } else {
      store.emitEvent("reporter", "info", `Anchoring named observation ${obsId} on Solana mainnet...`);
      const r = await anchorObservationHash(obsId, envelopeHash, {});
      if (r.ok && r.signature) {
        anchored = true;
        signature = r.signature;
        slot = r.slot;
        anchorExplorer = explorerUrl(r.signature);
        memo = r.memo;
        await artifacts.put(dayPath, JSON.stringify({ day, count: count + 1 }));
        await artifacts.put(
          `observations/${envelopeHash}/anchor.json`,
          JSON.stringify({ obsId, envelopeHash, memo, signature, slot, explorerUrl: anchorExplorer, burnSig, anchoredAt: new Date().toISOString() }, null, 2),
        );
      }
    }
  }

  const finalRecord: ObservationRecord = { ...out.record };
  if (anchored) {
    finalRecord.status = "anchored";
    finalRecord.anchor = { memo, signature: signature ?? null };
  }
  await artifacts.put(`observations/${envelopeHash}/record.json`, JSON.stringify({ record: finalRecord, science: out.science, paymentSignature: burnSig }, null, 2));
  await artifacts.put(`observations/by-sig/${burnSig}.json`, JSON.stringify({ envelopeHash, usedAt: new Date().toISOString() }));

  const receipt = buildPaymentResponse(burnSig, explorerUrl(burnSig), new Date().toISOString());
  return c.json({ record: finalRecord, memo, envelopeHash, anchored, dryRun, capReached, signature, slot, explorerUrl: anchorExplorer, science: out.science }, 200, { "X-PAYMENT-RESPONSE": b64Encode(receipt) });
});

// Independently verify a sealed named observation from its envelope hash (?hash=) or the burn signature that
// commissioned it (?sig=): re-derive the envelope hash from the stored dedication + bundle hash (tamper-evidence)
// and check the sdr:observe:1 anchor on-chain. Read-only -- never touches the ledger, never spends.
app.get("/api/observe/evidence", async (c) => {
  const hash = c.req.query("hash") || undefined;
  const sig = c.req.query("sig") || undefined;
  const ev = await buildObservationEvidence(artifacts, { hash, sig }, (anchorSig, envelopeHash) => verifyObserveAnchor(anchorSig, envelopeHash));
  return c.json(ev, ev.status as 200 | 404 | 500);
});

// Read-only Solana RPC proxy for the in-page burn helper (parity with the edge /api/rpc). Public mainnet RPCs
// 403 browser requests carrying an unknown Origin; server-to-server has no Origin, and SOLANA_RPC (private,
// then fallbacks) is used without its URL or key reaching the browser. Allowlisted READ methods only --
// sendTransaction is refused; the wallet signs and submits the burn itself. See src/observe/rpcProxy.ts.
app.post("/api/rpc", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.json({ error: "request body too large" }, 413);
  const endpoints = endpointList(undefined, process.env.SOLANA_RPC, process.env.SOLANA_RPC_FALLBACKS);
  const out = await handleBrowserRpcProxy(raw, endpoints, (url, init) => fetch(url, init));
  if (out.status !== 200) return c.json({ error: out.error }, out.status as 400);
  return c.json(out.json as Record<string, unknown>);
});

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
          data: JSON.stringify({ runId: store.runId, stats: store.computeStats(ledgerRows()), seats: store.listSeats(), activeRun }),
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
  if (!isAdminAuthorized(c.req.header("authorization"), process.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
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
  if (!isAdminAuthorized(c.req.header("authorization"), process.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
  const id = safeName(c.req.param("id"));
  const f = id ? store.getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  if (!f.bundleHash) return c.json({ error: "finding has no bundle hash yet (run the reporter first)" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);
  // RPC endpoint and fee-payer keypair come from SERVER-SIDE configuration only
  // (.env / defaults). Request bodies must never select endpoints (SSRF) or keypair
  // paths (arbitrary file read).

  // Idempotency guard (mirrors the edge DO): the same bundle hash anchors at most once;
  // repeat calls return the existing receipt instead of paying mainnet fees again.
  const prior = readLedger(LEDGER_PATH).find((e) => e.findingId === f.id);
  if (!dryRun && prior?.status === "anchored" && prior.signature && prior.bundleHash === f.bundleHash) {
    if (f.solanaTx !== prior.signature) {
      store.updateFinding(f.id, { solanaTx: prior.signature });
      store.updateBundle(f.id, { solanaTx: prior.signature });
      store.save(STATE_PATH, ledgerRows());
    }
    return c.json({ ok: true, memo: prior.memo, signature: prior.signature, slot: prior.slot, explorerUrl: prior.explorerUrl, alreadyAnchored: true });
  }

  store.emitEvent("reporter", "info", `Anchoring ${f.id} on Solana mainnet${dryRun ? " (dry-run)" : ""}...`);
  const res = await anchorBundleHash(f.id, f.bundleHash, { dryRun });

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
    // `upsertLedger` returns the ledger as it now stands, including whatever `mergeLedgerRow` kept -- so the
    // snapshot is written against the rows that are really on disk, not a re-read or an empty default.
    const nextLedger = upsertLedger(LEDGER_PATH, entry);
    if (res.ok && res.signature) {
      store.updateFinding(f.id, { solanaTx: res.signature });
      store.updateBundle(f.id, { solanaTx: res.signature });
      store.save(STATE_PATH, nextLedger);
    }
  }

  if (dryRun) store.emitEvent("reporter", "info", `Dry-run memo for ${f.id}: ${res.memo}`);
  else if (res.ok && res.signature) store.emitEvent("reporter", "result", `Anchored ${f.id} on mainnet: tx ${res.signature.slice(0, 16)}... (slot ${res.slot}). ${explorerUrl(res.signature)}`);
  else store.emitEvent("reporter", "warn", `Anchor failed for ${f.id}: ${res.error ?? "unknown"} -- the bundle hash is still valid off-chain.`);

  return c.json(res);
});

// Anchor the sealed DELIBERATION receipt on Solana mainnet with a SEPARATE memo schema
// (sdr:delib:1|<id>|<hash>). Never touches the science bundle ledger. Idempotent per
// (finding, deliberationHash): replays a prior tx without spending mainnet fees again.
// dryRun previews the memo without touching the chain or the keypair.
app.post("/api/anchor/:id/deliberation", async (c) => {
  if (!isAdminAuthorized(c.req.header("authorization"), process.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
  const id = safeName(c.req.param("id"));
  const deliberationHash = id ? (await artifacts.getText(`deliberations/${id}/HASH.txt`))?.trim() ?? "" : "";
  if (!id || !deliberationHash)
    return c.json({ error: "no sealed deliberation for this finding (open the thread to seal it first)" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);

  // Idempotency guard (mirrors the edge route): reuse a prior successful anchor of the SAME hash.
  if (!dryRun) {
    const priorText = await artifacts.getText(`deliberations/${id}/anchor.json`);
    if (priorText) {
      try {
        const prior = JSON.parse(priorText) as { signature?: string; deliberationHash?: string; slot?: number; memo?: string; explorerUrl?: string };
        if (prior.signature && prior.deliberationHash === deliberationHash)
          return c.json({ ok: true, alreadyAnchored: true, deliberationHash, memo: prior.memo, signature: prior.signature, slot: prior.slot, explorerUrl: prior.explorerUrl ?? explorerUrl(prior.signature) });
      } catch { /* corrupt/old record: fall through and re-anchor */ }
    }
  }

  store.emitEvent("reporter", "info", `Anchoring deliberation for ${id}${dryRun ? " (dry-run)" : ""}...`);
  const res = await anchorDeliberationHash(id, deliberationHash, { dryRun });

  if (!dryRun && res.ok && res.signature) {
    const record = { findingId: id, deliberationHash, memo: res.memo, signature: res.signature, slot: res.slot, explorerUrl: explorerUrl(res.signature), anchoredAt: new Date().toISOString() };
    await artifacts.put(`deliberations/${id}/anchor.json`, JSON.stringify(record, null, 2)).catch(() => { /* persistence is best-effort */ });
    store.emitEvent("reporter", "result", `Anchored deliberation for ${id}: tx ${res.signature.slice(0, 16)}... (slot ${res.slot}). ${record.explorerUrl}`);
    return c.json({ ...res, deliberationHash, explorerUrl: record.explorerUrl });
  }
  if (dryRun) store.emitEvent("reporter", "info", `Dry-run deliberation memo for ${id}: ${res.memo}`);
  else if (!res.ok) store.emitEvent("reporter", "warn", `Deliberation anchor failed for ${id}: ${res.error ?? "unknown"} -- the receipt hash is still valid off-chain.`);
  return c.json({ ...res, deliberationHash });
});

// Read back any existing on-chain deliberation anchor for one finding (for the UI chip).
app.get("/api/discussion/:id/anchor", async (c) => {
  const id = safeName(c.req.param("id"));
  const text = id ? await artifacts.getText(`deliberations/${id}/anchor.json`) : null;
  if (text == null) return c.json({ anchored: false });
  return c.json({ anchored: true, ...(JSON.parse(text) as Record<string, unknown>) });
});

// ---- static dashboard ------------------------------------------------------

app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/", (c) => serveStatic(c, "index.html"));
app.get("/index.html", (c) => serveStatic(c, "index.html"));
app.get("/app.js", (c) => serveStatic(c, "app.js"));
app.get("/styles.css", (c) => serveStatic(c, "styles.css"));
app.get("/space.js", (c) => serveStatic(c, "space.js"));
app.get("/live.js", (c) => serveStatic(c, "live.js"));
// The split browser ES modules app.js imports. The edge serves these automatically from the ./web asset
// pipeline (assets-first); the Node server's static routes are an explicit allowlist, so each must be named here
// too -- otherwise the local dashboard's app.js fails to load its import chain and the whole board is blank.
// Parity per HANDOFF section 4 (a route present on one host must exist on the other).
app.get("/relabel.js", (c) => serveStatic(c, "relabel.js"));
app.get("/honest-precision.js", (c) => serveStatic(c, "honest-precision.js"));
app.get("/findings-query-ui.js", (c) => serveStatic(c, "findings-query-ui.js"));
app.get("/vendor/three.js", (c) => serveStatic(c, "vendor/three.js"));
// Serve the remaining static dashboard assets the browser fetches, so the local Node server
// matches what the Cloudflare worker serves from web/ as static assets (edge parity).
app.get("/vendor/solana-burn.js", (c) => serveStatic(c, "vendor/solana-burn.js"));
app.get("/candidates.json", (c) => serveStatic(c, "candidates.json"));
app.get("/observe-stars.json", (c) => serveStatic(c, "observe-stars.json"));
app.get("/research.json", (c) => serveStatic(c, "research.json"));
app.get("/results-figure.svg", (c) => serveStatic(c, "results-figure.svg"));
app.get("/transit-example.svg", (c) => serveStatic(c, "transit-example.svg"));

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
console.log(`  findings     : ${store.listFindings().length}  bundles: ${store.listBundles().length}  anchored now: ${store.computeStats(ledgerRows()).bundlesAnchored}  commitments on chain: ${store.computeStats(ledgerRows()).ledgerAnchored}`);

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const addr = info.address === "0.0.0.0" || info.address === "::" ? "127.0.0.1" : info.address;
  console.log(`\n  dashboard    : http://${addr}:${info.port}/`);
  console.log(`  health       : http://${addr}:${info.port}/health`);
  console.log(`  live events  : http://${addr}:${info.port}/api/events  (SSE)`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
