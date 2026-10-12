// Deliberation-receipt tests: the model cross-examination is sealed as an
// integrity-only artifact, separate from the science bundle. Covers receipt shape
// (grounded turns excluded, models de-duplicated), hash stability, a persist+verify
// round-trip, and tamper detection. No network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ArtifactStore } from "../src/core/ports.ts";
import type { DiscussionTurn } from "../src/ai/threads.ts";
import {
  DELIBERATION_SCHEMA,
  buildDeliberationReceipt,
  hashDeliberation,
  persistDeliberation,
  verifyDeliberation,
  deliberationKey,
} from "../src/ai/deliberation.ts";

/** In-memory ArtifactStore so the seal/verify round-trip runs offline. */
class MemStore implements ArtifactStore {
  private m = new Map<string, string>();
  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.m.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
  }
  async get(key: string): Promise<Uint8Array | null> {
    const v = this.m.get(key);
    return v == null ? null : new TextEncoder().encode(v);
  }
  async getText(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async exists(key: string): Promise<boolean> {
    return this.m.has(key);
  }
  del(key: string): void {
    this.m.delete(key);
  }
}

const turns = (): DiscussionTurn[] => [
  { seat: "data-fetch", ts: "t", tone: "brief", text: "grounded seat line (no model)" },
  { seat: "mission-critic", ts: "t", tone: "challenge", text: "[Statistical critic] confidence is low.", model: "deepseek-chat" },
  { seat: "mission-critic", ts: "t", tone: "hedge", text: "[Red-team reviewer] looks like an alias.", model: "grok-4.7" },
  { seat: "mission-critic", ts: "t", tone: "speak", text: "[Cross-exam - Statistical critic] concede the alias point.", model: "deepseek-chat" },
];

test("receipt keeps only model turns, de-duplicates models in appearance order", () => {
  const r = buildDeliberationReceipt({ findingId: "F-1", targetId: "STAR A", bundleHash: "abc123", turns: turns() });
  assert.equal(r.schema, DELIBERATION_SCHEMA);
  assert.equal(r.findingId, "F-1");
  assert.equal(r.bundleHash, "abc123");
  assert.deepEqual(r.models, ["deepseek-chat", "grok-4.7"]);
  assert.equal(r.turns.length, 3, "grounded turn must be excluded");
  assert.ok(r.turns.every((t) => t.model));
});

test("hash is a stable 64-hex digest regardless of construction order", async () => {
  const a = buildDeliberationReceipt({ findingId: "F-1", targetId: "STAR A", turns: turns(), generatedAt: "2026-10-10T00:00:00.000Z" });
  const b = buildDeliberationReceipt({ findingId: "F-1", targetId: "STAR A", turns: turns(), generatedAt: "2026-10-10T00:00:00.000Z" });
  const ha = await hashDeliberation(a);
  const hb = await hashDeliberation(b);
  assert.equal(ha, hb);
  assert.match(ha, /^[0-9a-f]{64}$/);
});

test("persist + verify round-trips and reports ok", async () => {
  const store = new MemStore();
  const r = buildDeliberationReceipt({ findingId: "F-2", targetId: "STAR B", turns: turns() });
  const h = await hashDeliberation(r);
  await persistDeliberation(store, r, h);
  assert.equal(await store.exists(`${deliberationKey("F-2")}/receipt.json`), true);
  const v = await verifyDeliberation(store, "F-2");
  assert.equal(v.ok, true);
  assert.equal(v.hashMatches, true);
  assert.equal(v.recomputedHash, h);
  assert.deepEqual(v.models, ["deepseek-chat", "grok-4.7"]);
  assert.equal(v.turns, 3);
});

test("tampering with the stored receipt is detected on verify", async () => {
  const store = new MemStore();
  const r = buildDeliberationReceipt({ findingId: "F-3", targetId: "STAR C", turns: turns() });
  await persistDeliberation(store, r, await hashDeliberation(r));
  // Rewrite one sealed line directly in storage, leaving HASH.txt untouched.
  const key = `${deliberationKey("F-3")}/receipt.json`;
  const doc = JSON.parse((await store.getText(key)) as string);
  doc.turns[0].text = "silently rewritten";
  await store.put(key, JSON.stringify(doc, null, 2));
  const v = await verifyDeliberation(store, "F-3");
  assert.equal(v.ok, false);
  assert.equal(v.hashMatches, false);
});

test("verify throws for a finding that was never sealed", async () => {
  const store = new MemStore();
  await assert.rejects(() => verifyDeliberation(store, "F-missing"), /deliberation not found/);
});

test("verifyDeliberation FAILS when HASH.txt is deleted (no self-compare)", async () => {
  const store = new MemStore();
  const r = buildDeliberationReceipt({ findingId: "F-4", targetId: "STAR D", turns: turns() });
  await persistDeliberation(store, r, await hashDeliberation(r));
  store.del(`${deliberationKey("F-4")}/HASH.txt`);
  const v = await verifyDeliberation(store, "F-4");
  assert.equal(v.storedHash, null);
  assert.equal(v.hashMatches, false);
  assert.equal(v.ok, false, "a missing HASH.txt must never be treated as a pass");
});
