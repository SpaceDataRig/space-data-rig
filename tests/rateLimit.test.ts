// Offline tests for the fixed-window rate limiter used on the state-changing endpoints (audit #8).
// `nowMs` is injectable so the window behaviour is deterministic with no real clock.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createFixedWindowLimiter, clientRateKey } from "../src/core/rateLimit.ts";

function hdr(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

test("allows up to the limit within a window, then blocks with a positive retryAfter", () => {
  const rl = createFixedWindowLimiter({ limit: 3, windowMs: 1000 });
  const t = 10_000;
  assert.deepEqual(rl.check("ip", t), { ok: true, remaining: 2, retryAfterMs: 0 });
  assert.equal(rl.check("ip", t + 1).ok, true);
  assert.equal(rl.check("ip", t + 2).remaining, 0);
  const blocked = rl.check("ip", t + 3);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
});

test("the window resets after windowMs elapses", () => {
  const rl = createFixedWindowLimiter({ limit: 2, windowMs: 1000 });
  const t = 50_000;
  rl.check("k", t);
  rl.check("k", t + 10);
  assert.equal(rl.check("k", t + 20).ok, false); // 3rd in the first window -> blocked
  assert.equal(rl.check("k", t + 1001).ok, true); // new window -> allowed again
});

test("different keys are counted independently", () => {
  const rl = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
  const t = 0;
  assert.equal(rl.check("a", t).ok, true);
  assert.equal(rl.check("a", t + 1).ok, false);
  assert.equal(rl.check("b", t + 1).ok, true); // b unaffected by a's window
});

test("reset() clears all counters", () => {
  const rl = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
  rl.check("x", 0);
  assert.equal(rl.check("x", 1).ok, false);
  rl.reset();
  assert.equal(rl.check("x", 1).ok, true);
});

test("clientRateKey prefers cf-connecting-ip, then first x-forwarded-for hop, then x-real-ip, else anon", () => {
  assert.equal(clientRateKey(hdr({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })), "1.2.3.4");
  assert.equal(clientRateKey(hdr({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" })), "5.6.7.8");
  assert.equal(clientRateKey(hdr({ "x-real-ip": "11.11.11.11" })), "11.11.11.11");
  assert.equal(clientRateKey(hdr({})), "anon");
});
