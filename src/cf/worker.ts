// Space Data Rig :: Cloudflare Workers edge entrypoint.
//
// Hono routing over the edge bindings. Static frontend files are served by the
// asset pipeline (see wrangler.toml [assets]); only unmatched routes -- /health,
// /api/*, and the /api/events WebSocket upgrade -- reach this Worker, mirroring the
// explicit static routes the Node server uses.
//
// The Durable Object and Workflow classes are re-exported here so wrangler can find
// them in the module graph by their `class_name` (RigStateDO / RigRunWorkflow).

import { Hono } from "hono";
import type { Env } from "./env.ts";
import type { RunParams } from "./run-types.ts";
import { RigStateDO } from "./rig-state.do.ts";
import { RigRunWorkflow } from "./workflow.ts";
import { R2ArtifactStore } from "./artifact-store.ts";
import { verifyBundle } from "../bundle/bundle.ts";
import { seatRole } from "../reporter/narrate.ts";
import { buildDiscussion } from "../ai/discussion.ts";
import { threadsFor } from "../ai/threads.ts";
import { buildDeliberationReceipt, hashDeliberation, persistDeliberation, verifyDeliberation } from "../ai/deliberation.ts";
import type { LlmCred } from "../ai/llm.ts";
import type { Finding } from "../core/types.ts";
import type { SeatState } from "../core/state-types.ts";
import type { BundleRecord, DashboardState, LedgerEntry } from "../core/state-types.ts";

export { RigStateDO, RigRunWorkflow };

const app = new Hono<{ Bindings: Env }>();

// A stable id for the single rig instance: one dashboard, one authoritative DO.
function rigStub(env: Env) {
  return env.RIG_STATE.get(env.RIG_STATE.idFromName("rig-state"));
}

// Bundle artifacts live in R2 under keys identical to the Node fs layout, so the
// read/verify code paths (persistBundle / verifyBundle) work unchanged at the edge.
function artifacts(env: Env): R2ArtifactStore {
  return new R2ArtifactStore(env.RIG_ARTIFACTS);
}

// Only these three SVG names are served from an artifact request; the store path
// is always bundles/<safeName(id)>/<name>, so path traversal is impossible here too.
const ARTIFACT_ALLOW = new Set(["folded.svg", "periodogram.svg", "timeseries.svg"]);

/** Reject path-traversal in user-supplied finding ids (mirrors the Node server). */
function safeName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, "");
  return clean.includes("..") ? "" : clean;
}

/** A finding plus the derived depth the board renders directly (parity with Node). */
function findingView(f: Finding) {
  return { ...f, depthPpm: Math.round(f.candidate.depthFrac * 1e6) };
}

// Honest descriptor of the discussion engine, built from env bindings only.
// ai/llm.ts IS bundled (via the /api/discussion path), but the Worker never relies on
// its process.env fallback -- nodejs_compat v1 cannot see secrets there -- so
// credentials are always injected explicitly through LlmCred from c.env.
const DS_BASE = "https://api.deepseek.com/v1";
const GROK_BASE = "https://api.x.ai/v1";

/**
 * Every configured chat model, primary (DeepSeek/OpenAI) first then Grok, as explicit
 * creds with per-provider defaults already resolved -- the edge must not fall through to
 * the DeepSeek defaults when a Grok entry omits base/model. Key-less entries are dropped.
 */
function llmProviders(env: Env): LlmCred[] {
  const out: LlmCred[] = [];
  const dsKey = env.OPENAI_API_KEY ?? env.DEEPSEEK_API_KEY;
  if (dsKey) {
    const model = env.OPENAI_MODEL ?? env.DISCUSSION_MODEL ?? "deepseek-chat";
    out.push({ key: dsKey, baseUrl: (env.OPENAI_BASE_URL ?? DS_BASE).replace(/\/+$/, ""), model, name: model });
  }
  const grokKey = env.GROK_API_KEY ?? env.XAI_API_KEY;
  if (grokKey) {
    const model = env.GROK_MODEL ?? "grok-4.7";
    out.push({ key: grokKey, baseUrl: (env.GROK_BASE_URL ?? GROK_BASE).replace(/\/+$/, ""), model, name: model });
  }
  return out;
}

function aiDescriptor(env: Env): { mode: string; provider: string } {
  const providers = llmProviders(env);
  if (providers.length === 0) return { mode: "grounded", provider: "grounded (data-driven)" };
  return { mode: "live-llm", provider: providers.map((p) => `${p.model} @ ${p.baseUrl}`).join(", ") };
}

// Run-parameter clamps, mirrored byte-for-byte from the Node server's POST /api/run
// so a browser request produces the same bounded RunParams on either runtime.
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

// Liveness / readiness probe (parity with the Node server's /health).
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "space-data-rig",
    runtime: "cloudflare-worker",
    codeVersion: c.env.CODE_VERSION ?? "unknown",
  }),
);

// Live feed: hand the browser's WebSocket upgrade straight to the Durable Object,
// which accepts it for Hibernation and streams hello/log/state frames. web/live.js
// speaks this WS at the edge and transparently falls back to the Node SSE feed.
app.get("/api/events", (c) => {
  const url = new URL(c.req.url);
  const headers: Record<string, string> = { Upgrade: "websocket" };
  const protocol = c.req.header("Sec-WebSocket-Protocol");
  if (protocol) headers["Sec-WebSocket-Protocol"] = protocol;
  return rigStub(c.env).fetch(new Request(`${url.origin}/events`, { headers }));
});

// Full dashboard payload for the initial render (before the live stream takes over).
app.get("/api/state", async (c) => {
  const st: DashboardState = await rigStub(c.env).getState();
  return c.json({
    ...st,
    seats: st.seats.map((s: SeatState) => ({ ...s, role: seatRole(s.name) })),
    findings: st.findings.map(findingView),
    ai: aiDescriptor(c.env),
  });
});

app.get("/api/findings", async (c) => {
  const findings: Finding[] = await rigStub(c.env).listFindingsPublic();
  return c.json({ findings: findings.map(findingView) });
});

app.get("/api/findings/:id", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const f: Finding | undefined = id ? await rigStub(c.env).getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  return c.json(findingView(f));
});

app.get("/api/ledger", async (c) => {
  const ledger: LedgerEntry[] = await rigStub(c.env).listLedger();
  return c.json({ ledger });
});

// Multi-seat war-room threads. The LIST is grounded and instant -- composed from each
// finding's real numbers by the pure threadsFor builder, with NO model call, exactly like
// the Node server's /api/discussion. Running the live cross-examination here (one model
// call, or a two-round debate, per finding) would make boot latency scale with the number
// of findings and stall the frontend's live connection; the model debate lives only on the
// on-demand /api/discussion/:id below, which the UI calls for the single thread it shows.
app.get("/api/discussion", async (c) => {
  const findings: Finding[] = await rigStub(c.env).listFindingsPublic();
  return c.json({ ...aiDescriptor(c.env), threads: threadsFor(findings) });
});

// Credentials for the live debate, injected explicitly from c.env (the edge cannot read
// secrets via process.env under nodejs_compat v1). Used only by the on-demand /:id thread.
function llmCred(env: Env): LlmCred[] {
  return llmProviders(env);
}

app.get("/api/discussion/:id", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const f: Finding | undefined = id ? await rigStub(c.env).getFinding(id) : undefined;
  if (!f) return c.json({ error: "finding not found" }, 404);
  const turns = await buildDiscussion(f, llmCred(c.env));
  // Seal the model cross-examination as a tamper-evident receipt (its own namespace,
  // never the science bundle). Skipped entirely when no model actually spoke, so a
  // grounded thread produces no receipt and the response carries no deliberationHash.
  let deliberationHash: string | undefined;
  if (turns.some((t) => t.model)) {
    const receipt = buildDeliberationReceipt({ findingId: f.id, targetId: f.targetId, bundleHash: f.bundleHash, turns });
    deliberationHash = await hashDeliberation(receipt);
    await persistDeliberation(artifacts(c.env), receipt, deliberationHash).catch(() => { /* seal is best-effort */ });
  }
  return c.json({ findingId: f.id, targetId: f.targetId, verdict: f.verdict, ...aiDescriptor(c.env), turns, deliberationHash });
});

// Read back the sealed deliberation receipt for one finding (integrity-only record).
app.get("/api/discussion/:id/receipt", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const text = id ? await artifacts(c.env).getText(`deliberations/${id}/receipt.json`) : null;
  if (text == null) return c.json({ error: "deliberation not found" }, 404);
  return c.json(JSON.parse(text) as Record<string, unknown>);
});

// Independent audit: recompute the receipt hash from storage and compare to HASH.txt.
app.get("/api/discussion/:id/receipt/verify", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const store = artifacts(c.env);
  if (!id || !(await store.exists(`deliberations/${id}/receipt.json`))) return c.json({ error: "deliberation not found" }, 404);
  try {
    return c.json({ findingId: id, ...(await verifyDeliberation(store, id)) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Bundle manifest read (R2), verify (R2 + Web Crypto rehash), and SVG streaming.
// Same key layout as the Node server's fs store, so no runtime branches below.
app.get("/api/bundles/:id/manifest", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  if (!id) return c.json({ error: "bundle not found" }, 404);
  const text = await artifacts(c.env).getText(`bundles/${id}/manifest.json`);
  if (text == null) return c.json({ error: "bundle not found" }, 404);
  return c.json(JSON.parse(text) as Record<string, unknown>);
});

app.get("/api/bundles/:id/verify", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const store = artifacts(c.env);
  if (!id || !(await store.exists(`bundles/${id}/manifest.json`))) return c.json({ error: "bundle not found" }, 404);
  try {
    return c.json({ findingId: id, ...(await verifyBundle(store, id)) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/bundles/:id/artifact/:name", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const name = c.req.param("name") ?? "";
  if (!id || !ARTIFACT_ALLOW.has(name)) return c.json({ error: "artifact not allowed" }, 400);
  const text = await artifacts(c.env).getText(`bundles/${id}/${name}`);
  if (text == null) return c.json({ error: "artifact not found" }, 404);
  return c.body(text, 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});

// Kick off a durable pipeline run. The DO claims the single-run slot (409 when busy,
// mirroring the Node guard), then a Workflow instance is created with the authoritative
// runId and returns immediately -- progress streams to the browser over the DO WebSocket.
app.post("/api/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // Public endpoint: keep the clamps tight. Every target is a durable workflow branch and
  // every confidence trial is a full BLS sweep inside one step's CPU budget.
  const targets = clampInt(body.targets, 1, 24, 4);
  const stageDelayMs = clampInt(body.delay ?? body.stageDelayMs, 0, 5000, 300);
  const confidenceTrials = clampInt(body.confidence ?? body.confidenceTrials, 1, 16, 8);
  const maxTmag = clampFloat(body.tmag ?? body.maxTmag, 0, 20, 11);
  const resume = Boolean(body.resume);
  const offline = Boolean(body.offline);

  const params: RunParams = {
    runId: RigStateDO.makeRunId(),
    targets,
    confidenceTrials,
    maxTmag,
    stageDelayMs,
    offline,
    resume,
  };

  // Claim the run slot first (this also fixes the authoritative runId for resume).
  const claimed = await rigStub(c.env).startRunIfIdle(params);
  if (!claimed.ok) {
    return c.json({ error: "a run is already in progress", runId: claimed.runId }, 409);
  }
  const runId = claimed.runId;

  // Launch a fresh Workflow instance (auto id) carrying the authoritative runId in its
  // params. A resume reuses the DO's runId so it reads/writes the SAME R2 state keys, but
  // must NOT reuse the instance id (that would collide with the already-existing prior
  // instance and throw); completed targets are skipped by the workflow via taskStatus.
  try {
    await c.env.RIG_RUN.create({ params: { ...params, runId } });
  } catch (e) {
    // Never leave the run slot claimed if the instance could not even be created:
    // release the mutex so the next request is not stuck behind a phantom run (409).
    const msg = e instanceof Error ? e.message : String(e);
    await rigStub(c.env).finishRun({ error: `workflow could not be created: ${msg}` }).catch(() => {});
    return c.json({ error: "failed to start workflow", detail: msg }, 500);
  }

  return c.json({ ok: true, started: true, runId, targets, offline, resume, confidenceTrials });
});

// Anchor one finding's bundle hash on Solana mainnet (or a dry-run memo preview).
// The transaction is built + submitted INSIDE the DO (serialised fee-payer, wall-clock
// I/O); this route just relays the outcome and maps it to an HTTP status.
app.post("/api/anchor/:id", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  if (!id) return c.json({ error: "finding not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);
  const res = await rigStub(c.env).anchorFinding(id, { dryRun });
  return c.json(res, res.httpStatus as 200 | 400 | 404 | 500);
});

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
