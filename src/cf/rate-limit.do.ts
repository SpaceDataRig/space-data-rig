// RateLimitDO (audit-10 #7 residual): a Durable Object that owns the fixed-window abuse-brake counters
// for the state-changing routes (/api/run, /api/anchor/*). The previous limiter lived in the Worker
// isolate, so each Cloudflare isolate kept its OWN counters -- a global limit only makes sense when the
// count is shared, and a Durable Object is exactly that: one instance per name, single-writer semantics.
//
// WHAT THIS IS. A cheap abuse BRAKE, not a precise quota. It is deliberately FAIL-OPEN: if the DO call
// throws, times out, or returns anything unexpected, the caller lets the request through rather than lock
// out the operator. It gates BEFORE authorization (so unauthenticated floods are throttled too) and changes
// NO verdict, bundle hash, or money logic -- it only sheds excess load. The counting math is the SAME pure
// createFixedWindowLimiter from src/core/rateLimit.ts (already unit-tested); this DO just gives it one
// shared home instead of one copy per isolate.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { createFixedWindowLimiter, type RateDecision, type RateLimiter } from "../core/rateLimit.ts";

interface CheckRequest {
  namespace: string; // "run" | "anchor" -- one DO instance per namespace isolates their counters
  key: string; // client identity (cf-connecting-ip), the per-client bucket within the namespace
  limit: number; // max requests per window
  windowMs: number; // fixed window length in ms
}

export class RateLimitDO extends DurableObject<Env> {
  // One limiter per (namespace, limit, windowMs) combo. The DO instance is already namespaced (the
  // caller routes by idFromName(namespace)), so in practice this map holds a single entry per instance;
  // keying by config keeps it correct if the operator ever tunes the window without a redeploy.
  private readonly limiters = new Map<string, RateLimiter>();

  private limiterFor(limit: number, windowMs: number): RateLimiter {
    const ck = `${limit}|${windowMs}`;
    let l = this.limiters.get(ck);
    if (!l) {
      l = createFixedWindowLimiter({ limit, windowMs });
      this.limiters.set(ck, l);
    }
    return l;
  }

  async fetch(request: Request): Promise<Response> {
    // Fail-open is the CALLER's contract, but a malformed request here must never 500 into a deny: we
    // answer with an explicit "allow" so the worker path treats ok:true as pass-through.
    let body: Partial<CheckRequest>;
    try {
      body = (await request.json()) as Partial<CheckRequest>;
    } catch {
      return Response.json({ ok: true, remaining: 0, retryAfterMs: 0 } satisfies RateDecision);
    }
    const { key, limit, windowMs } = body;
    if (typeof key !== "string" || !Number.isFinite(limit) || !Number.isFinite(windowMs) || (limit as number) < 1 || (windowMs as number) < 1) {
      return Response.json({ ok: true, remaining: 0, retryAfterMs: 0 } satisfies RateDecision);
    }
    const decision = this.limiterFor(limit as number, windowMs as number).check(key);
    return Response.json(decision satisfies RateDecision);
  }
}
