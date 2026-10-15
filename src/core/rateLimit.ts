// Coarse rate limiting for the STATE-CHANGING endpoints (audit finding #8: /api/run and /api/anchor/*
// were open when ADMIN_TOKEN is unset and had no throttle, while the production instance spends real SOL).
//
// WHAT THIS IS. A per-isolate fixed-window counter, keyed by client identity, used as an abuse BRAKE on the
// mutation routes -- it is deliberately simple and fail-open: if the limiter ever throws or misbehaves we let
// the request through rather than lock out the owner. It is NOT a precise distributed quota (each Cloudflare
// isolate keeps its own counters, and a global limit belongs at the edge/DO layer); it is the cheap first line
// that turns "anyone can hammer /api/run and burn compute + SOL" into "a single client can't".
//
// Pure + runtime-agnostic (no node: APIs, no Clock), matching src/core/auth.ts, so it runs identically on Node
// and the Workers edge and is unit-testable offline. It gates BEFORE authorization, so unauthenticated floods
// are throttled too; it never changes a verdict, a bundle hash, or the money logic itself.

export interface RateWindow {
  limit: number; // max requests per window
  windowMs: number; // fixed window length in ms
}

export interface RateDecision {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, nowMs?: number): RateDecision;
  reset(): void; // for tests / operational reset
}

/**
 * A fixed-window limiter. Counts requests per key per window; over the limit -> not ok with a retryAfter.
 * `nowMs` is injectable so tests are deterministic; defaults to Date.now(). Old windows are overwritten on
 * the next request for a key, and a periodic prune keeps the map from growing without bound.
 */
export function createFixedWindowLimiter(w: RateWindow, maxKeys = 5000): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string, nowMs?: number): RateDecision {
      const now = nowMs ?? Date.now();
      try {
        const cur = hits.get(key);
        if (!cur || cur.resetAt <= now) {
          hits.set(key, { count: 1, resetAt: now + w.windowMs });
          if (hits.size > maxKeys) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
          return { ok: true, remaining: Math.max(0, w.limit - 1), retryAfterMs: 0 };
        }
        if (cur.count >= w.limit) return { ok: false, remaining: 0, retryAfterMs: Math.max(0, cur.resetAt - now) };
        cur.count += 1;
        return { ok: true, remaining: Math.max(0, w.limit - cur.count), retryAfterMs: 0 };
      } catch {
        // Fail-open: a limiter bug must never deny the operator their own run/anchor.
        return { ok: true, remaining: w.limit, retryAfterMs: 0 };
      }
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * Extract a client key from request headers. On Cloudflare `cf-connecting-ip` is the authenticated real
 * client IP (spoof-proof); we fall back through forwarding hints and finally a shared "anon" bucket so the
 * limiter always has something to key on rather than throwing.
 */
export function clientRateKey(headers: { get(name: string): string | null }): string {
  return (
    headers.get("cf-connecting-ip") ||
    (headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    headers.get("x-real-ip") ||
    "anon"
  );
}
