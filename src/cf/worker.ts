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
import { RateLimitDO } from "./rate-limit.do.ts";
import { RigRunWorkflow } from "./workflow.ts";
import { R2ArtifactStore } from "./artifact-store.ts";
import { verifyBundle } from "../bundle/bundle.ts";
import { isAdminAuthorized, ADMIN_UNAUTHORIZED } from "../core/auth.ts";
import { createFixedWindowLimiter, clientRateKey, type RateDecision, type RateLimiter } from "../core/rateLimit.ts";
import { seatRole } from "../reporter/narrate.ts";
import { buildDiscussion } from "../ai/discussion.ts";
import { threadsFor } from "../ai/threads.ts";
import { buildDeliberationReceipt, hashDeliberation, persistDeliberation, verifyDeliberation } from "../ai/deliberation.ts";
import { explorerUrl, endpointList, verifyOnEndpoints, OBSERVE_MEMO_PREFIX } from "../solana/anchor-core.ts";
import { computeObservation } from "../observe/observeApi.ts";
import { buildPaymentRequired, buildPaymentResponse } from "../observe/x402.ts";
import { buildObservationEvidence } from "../observe/evidence.ts";
import { handleBrowserRpcProxy } from "../observe/rpcProxy.ts";
import type { LlmCred } from "../ai/llm.ts";
import type { Finding } from "../core/types.ts";
import type { SeatState } from "../core/state-types.ts";
import type { DashboardState, LedgerEntry } from "../core/state-types.ts";

export { RigStateDO, RigRunWorkflow, RateLimitDO };

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
// audit-6 P2: also self-prove WHICH deployment is live. codeVersion alone stayed at the package version for
// five rounds, so "did my deploy land" needed a byte-compare of static assets; deployVersion (Workers version
// metadata id) changes on every upload and gitSha (secret, set at deploy time) maps it to a commit.
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "space-data-rig",
    runtime: "cloudflare-worker",
    codeVersion: c.env.CODE_VERSION ?? "unknown",
    deployVersion: c.env.CF_VERSION_METADATA?.id ?? "unknown",
    gitSha: c.env.GIT_SHA ?? "unknown",
  }),
);

// Live feed: hand the browser's WebSocket upgrade straight to the Durable Object,
// which accepts it for Hibernation and streams hello/log/state frames. web/live.js
// speaks this WS at the edge and transparently falls back to the Node SSE feed.
app.get("/api/events", (c) => {
  // Gate the upgrade HERE (audit-4). The old code ALWAYS built a synthetic `Upgrade: websocket` Request, so a
  // plain GET (curl, a scanner, a browser prefetch) made the DO call acceptWebSocket() with no actual pending
  // socket -- that throws and surfaced as a Worker exception (HTTP 500) on every non-WS hit, and it meant the
  // DO's own correct 426 branch was unreachable. Answer 426 directly; the DO keeps its 426 as defence-in-depth.
  if ((c.req.header("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return c.json({ error: "this endpoint requires a WebSocket upgrade", upgrade: "websocket", hint: "connect with a WebSocket client; a plain GET is not a live-feed subscription" }, 426);
  }
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

// Name an Observation: run the SAME blind, deterministic pipeline on a user-chosen star and return the real,
// reproducible result + the sealed observation envelope + the sdr:observe:1 memo that WOULD anchor. This only
// reads public photometry + computes (no payment, no SOL spend, no on-chain write); it never touches the
// findings ledger, any existing bundleHash, or the money path. Payment gates the ANCHOR, not the compute.
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

// Commission a NAMED OBSERVATION (the PAID path). The x402 handshake: an unpaid call returns 402 with an
// X-PAYMENT-REQUIRED challenge (burn exactly 10,000 $SDR). A retry carrying X-PAYMENT (a base64 envelope holding
// the SIGNATURE of the burn the client already submitted) is verified FROM THE CHAIN by the DO -- never trusting
// the client -- then the SAME blind deterministic search runs and, under the OBSERVE_ANCHOR gate, the envelope
// hash is anchored on mainnet (sdr:observe:1). Payment gates the anchor only; it never changes the verdict.
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

  const res = await rigStub(c.env).observeCommission({ tic, sector, dedication, xPaymentB64: xPayment });

  if (!res.ok) {
    if (res.status === 402) {
      const challenge = buildPaymentRequired({ resource: "/api/observe/commission", description: "Commission a named observation: burn exactly 10,000 $SDR.", error: res.error });
      return c.json({ error: res.error }, 402, { "X-PAYMENT-REQUIRED": btoa(JSON.stringify(challenge)) });
    }
    return c.json({ error: res.error, errors: res.errors }, res.status as 400);
  }

  const burnSig = res.paymentSignature ?? "";
  const receipt = buildPaymentResponse(burnSig, burnSig ? explorerUrl(burnSig) : "", new Date().toISOString());
  return c.json(
    { record: res.record, memo: res.memo, envelopeHash: res.envelopeHash, anchored: res.anchored, alreadyAnchored: res.alreadyAnchored, dryRun: res.dryRun, capReached: res.capReached, signature: res.signature, slot: res.slot, explorerUrl: res.explorerUrl, science: res.science },
    200,
    { "X-PAYMENT-RESPONSE": btoa(JSON.stringify(receipt)) },
  );
});

// Independently verify a sealed named observation from its envelope hash (?hash=) or the burn signature that
// commissioned it (?sig=): re-derives the envelope hash from the stored dedication + bundle hash (tamper-evidence)
// and checks the sdr:observe:1 anchor on-chain. Read-only -- never touches the ledger, never spends.
app.get("/api/observe/evidence", async (c) => {
  const hash = c.req.query("hash") || undefined;
  const sig = c.req.query("sig") || undefined;
  const endpoints = endpointList(undefined, c.env.SOLANA_RPC, c.env.SOLANA_RPC_FALLBACKS);
  const ev = await buildObservationEvidence(artifacts(c.env), { hash, sig }, (anchorSig, envelopeHash) =>
    verifyOnEndpoints(endpoints, anchorSig, envelopeHash, OBSERVE_MEMO_PREFIX));
  return c.json(ev, ev.status as 200 | 404 | 500);
});

// Read-only Solana RPC proxy for the in-page burn helper. Public mainnet RPCs answer browser requests
// carrying an unknown Origin with 403 (web3.js v3 surfaces that as the opaque SolanaError #8100002), so the
// frontend reads the chain through here instead: server-to-server has no Origin, and the operator's private
// RPC (env SOLANA_RPC, fallbacks after) is used WITHOUT its URL or key ever reaching the browser. Only
// allowlisted READ methods are forwarded (sendTransaction is deliberately not among them -- the wallet signs
// and submits the burn itself); see src/observe/rpcProxy.ts for the full boundary.
app.post("/api/rpc", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.json({ error: "request body too large" }, 413);
  const endpoints = endpointList(undefined, c.env.SOLANA_RPC, c.env.SOLANA_RPC_FALLBACKS);
  const out = await handleBrowserRpcProxy(raw, endpoints, (url, init) => fetch(url, init));
  if (out.status !== 200) return c.json({ error: out.error }, out.status as 400);
  return c.json(out.json as Record<string, unknown>);
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

// Abuse brake on the state-changing endpoints (audit #8, counters moved to a DO for #7). The count lives
// in RateLimitDO so the limit is GLOBAL across isolates (one instance per namespace), not per-isolate as
// before. It gates BEFORE auth, throttling even unauthenticated floods. FAIL-OPEN end to end: if the DO
// call throws or returns anything unexpected we fall back to a local counter, so a limiter fault never
// denies the operator their own run/anchor. This changes no verdict, bundle hash, or money logic.
const RUN_RATE = { limit: 10, windowMs: 60_000 };
const ANCHOR_RATE = { limit: 30, windowMs: 60_000 };
// Local per-isolate fallbacks, used only when the shared DO is unreachable.
const runFallback = createFixedWindowLimiter(RUN_RATE);
const anchorFallback = createFixedWindowLimiter(ANCHOR_RATE);

async function rateCheck(
  env: Env,
  namespace: "run" | "anchor",
  key: string,
  cfg: { limit: number; windowMs: number },
  fallback: RateLimiter,
): Promise<RateDecision> {
  try {
    const stub = env.RIG_RATELIMIT.get(env.RIG_RATELIMIT.idFromName(namespace));
    const res = await stub.fetch("https://rate-limit/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace, key, limit: cfg.limit, windowMs: cfg.windowMs }),
    });
    if (!res.ok) return fallback.check(key);
    const d = (await res.json()) as RateDecision;
    return d && typeof d.ok === "boolean" ? d : fallback.check(key);
  } catch {
    return fallback.check(key); // fail-open: DO unreachable -> local counter, never deny the operator
  }
}

// Kick off a durable pipeline run. The DO claims the single-run slot (409 when busy,
// mirroring the Node guard), then a Workflow instance is created with the authoritative
// runId and returns immediately -- progress streams to the browser over the DO WebSocket.
app.post("/api/run", async (c) => {
  const _rl = await rateCheck(c.env, "run", clientRateKey(c.req.raw.headers), RUN_RATE, runFallback);
  if (!_rl.ok) return c.json({ error: "rate-limited: too many run requests, slow down", retryAfterSec: Math.max(1, Math.ceil(_rl.retryAfterMs / 1000)) }, 429);
  if (!isAdminAuthorized(c.req.header("authorization"), c.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
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
    await rigStub(c.env).finishRun(runId, { error: `workflow could not be created: ${msg}` }).catch(() => {});
    return c.json({ error: "failed to start workflow", detail: msg }, 500);
  }

  return c.json({ ok: true, started: true, runId, targets, offline, resume, confidenceTrials });
});

// Anchor one finding's bundle hash on Solana mainnet (or a dry-run memo preview).
// The transaction is built + submitted INSIDE the DO (serialised fee-payer, wall-clock
// I/O); this route just relays the outcome and maps it to an HTTP status.
app.post("/api/anchor/:id", async (c) => {
  const _rl = await rateCheck(c.env, "anchor", clientRateKey(c.req.raw.headers), ANCHOR_RATE, anchorFallback);
  if (!_rl.ok) return c.json({ error: "rate-limited: too many anchor requests, slow down", retryAfterSec: Math.max(1, Math.ceil(_rl.retryAfterMs / 1000)) }, 429);
  if (!isAdminAuthorized(c.req.header("authorization"), c.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
  const id = safeName(c.req.param("id") ?? "");
  if (!id) return c.json({ error: "finding not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);
  const res = await rigStub(c.env).anchorFinding(id, { dryRun });
  return c.json(res, res.httpStatus as 200 | 400 | 404 | 500);
});

// Anchor the sealed DELIBERATION receipt on Solana mainnet with a SEPARATE memo schema
// (sdr:delib:1|<id>|<hash>). This never touches the science bundle ledger. Idempotent per
// (finding, deliberationHash): a prior successful tx is replayed without spending fees
// again. dryRun previews the memo without touching the chain or the keypair.
app.post("/api/anchor/:id/deliberation", async (c) => {
  const _rl = await rateCheck(c.env, "anchor", clientRateKey(c.req.raw.headers), ANCHOR_RATE, anchorFallback);
  if (!_rl.ok) return c.json({ error: "rate-limited: too many anchor requests, slow down", retryAfterSec: Math.max(1, Math.ceil(_rl.retryAfterMs / 1000)) }, 429);
  if (!isAdminAuthorized(c.req.header("authorization"), c.env.ADMIN_TOKEN)) return c.json(ADMIN_UNAUTHORIZED, 401);
  const id = safeName(c.req.param("id") ?? "");
  if (!id) return c.json({ error: "finding not found" }, 404);
  const store = artifacts(c.env);
  const deliberationHash = (await store.getText(`deliberations/${id}/HASH.txt`))?.trim() ?? "";
  if (!deliberationHash)
    return c.json({ error: "no sealed deliberation for this finding (open the thread to seal it first)" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dryRun = Boolean(body.dryRun);

  // Idempotency guard: reuse a prior successful anchor of the SAME hash (no repeat spend).
  if (!dryRun) {
    const priorText = await store.getText(`deliberations/${id}/anchor.json`);
    if (priorText) {
      try {
        const prior = JSON.parse(priorText) as { signature?: string; deliberationHash?: string; slot?: number; memo?: string };
        if (prior.signature && prior.deliberationHash === deliberationHash) {
          return c.json({ ok: true, alreadyAnchored: true, deliberationHash, memo: prior.memo, signature: prior.signature, slot: prior.slot, explorerUrl: explorerUrl(prior.signature), httpStatus: 200 });
        }
      } catch { /* corrupt/old record: fall through and re-anchor */ }
    }
  }

  const res = await rigStub(c.env).anchorDeliberation(id, deliberationHash, { dryRun });
  const status = res.httpStatus as 200 | 400 | 404 | 500;
  if (!dryRun && res.ok && res.signature) {
    const record = { findingId: id, deliberationHash, memo: res.memo, signature: res.signature, slot: res.slot, explorerUrl: explorerUrl(res.signature), anchoredAt: new Date().toISOString() };
    await store.put(`deliberations/${id}/anchor.json`, JSON.stringify(record, null, 2), "application/json").catch(() => { /* persistence is best-effort */ });
    return c.json({ ...res, deliberationHash, explorerUrl: record.explorerUrl }, status);
  }
  return c.json({ ...res, deliberationHash }, status);
});

// Read back any existing on-chain deliberation anchor for one finding (for the UI chip).
app.get("/api/discussion/:id/anchor", async (c) => {
  const id = safeName(c.req.param("id") ?? "");
  const text = id ? await artifacts(c.env).getText(`deliberations/${id}/anchor.json`) : null;
  if (text == null) return c.json({ anchored: false });
  return c.json({ anchored: true, ...(JSON.parse(text) as Record<string, unknown>) });
});

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Cron entrypoint for autonomous research. Inert unless the AUTO_RESEARCH
   * Worker var is exactly "1", so shipping the [triggers] crons block changes
   * nothing on its own. When enabled it launches a modest autonomous run on the
   * same DO-serialized slot the dashboard uses (skipping the tick if a run is
   * already going). On-chain spending is STILL gated separately by AUTO_ANCHOR
   * inside the workflow, so enabling the schedule never costs SOL by itself.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Reliable X-post trigger. GitHub throttles the x-post workflow's own `on.schedule` (observed 2-5h
    // gaps), so the digest could fall silent even though THIS cron fires on time. Twice an hour, if a
    // dispatch token is configured, wake x-post.yml; it reads its own windows off the feed (one cursor per
    // tier: science, build note, silence) and de-duplicates against what is already posted, so an extra
    // wake never double-posts. Runs before the AUTO_RESEARCH guard (posting must not depend on research
    // being on), is inert without the secret, and swallows failures -- the workflow's own schedule remains
    // a backup.
    const wakeMinute = new Date(controller.scheduledTime).getUTCMinutes();
    if (env.GH_XPOST_DISPATCH_TOKEN && (wakeMinute === 0 || wakeMinute === 30)) {
      try {
        await fetch("https://api.github.com/repos/SpaceDataRig/space-data-rig/actions/workflows/x-post.yml/dispatches", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GH_XPOST_DISPATCH_TOKEN}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
            "user-agent": "space-data-rig",
          },
          body: JSON.stringify({ ref: "main", inputs: {} }),
        });
      } catch {
        /* best-effort wake; the workflow's own `on.schedule` remains a backup */
      }
    }
    if (env.AUTO_RESEARCH !== "1") return;
    const targets = clampInt(env.AUTO_RESEARCH_TARGETS, 1, 8, 3);
    const maxTmag = clampFloat(env.AUTO_RESEARCH_TMAG, 0, 20, 10);
    const params: RunParams = {
      runId: RigStateDO.makeRunId(),
      targets,
      confidenceTrials: 8,
      maxTmag,
      stageDelayMs: 0,
      offline: false,
      resume: false,
      autonomous: true,
      // audit-5: the autonomous cron rotates through a broad real pool (known + unconfirmed TOI) so the
      // catalog grows across passes. AUTO_RESEARCH_ROTATION gates it; off => historical top-N selection.
      rotation: env.AUTO_RESEARCH_ROTATION === "1",
      pool: clampInt(env.AUTO_RESEARCH_POOL, 8, 400, 120),
    };
    const claimed = await rigStub(env).startRunIfIdle(params);
    if (!claimed.ok) return; // a run is already in progress -- skip this tick
    const runId = claimed.runId;
    try {
      await env.RIG_RUN.create({ params: { ...params, runId } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await rigStub(env).finishRun(runId, { error: `autonomous workflow could not be created: ${msg}` }).catch(() => {});
    }
  },
};
