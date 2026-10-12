// Integrity tests for the audit fixes (issue #4): local verification must FAIL, never self-compare,
// when HASH.txt is missing, and a corrupt keypair file must never be silently overwritten. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactStore } from "../src/core/ports.ts";
import type { Finding } from "../src/core/types.ts";
import { composeBundle, persistBundle, verifyBundle } from "../src/bundle/bundle.ts";
import { getOrCreateKeypair } from "../src/solana/anchor.ts";

/** In-memory ArtifactStore (bytes-backed) with a delete, so we can simulate a missing HASH.txt. */
class MemStore implements ArtifactStore {
  private m = new Map<string, Uint8Array>();
  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.m.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.m.get(key) ?? null;
  }
  async getText(key: string): Promise<string | null> {
    const v = this.m.get(key);
    return v == null ? null : new TextDecoder().decode(v);
  }
  async exists(key: string): Promise<boolean> {
    return this.m.has(key);
  }
  del(key: string): void {
    this.m.delete(key);
  }
}

const minimalFinding = (): unknown => ({
  id: "F-int",
  targetId: "STAR INT",
  createdAt: "2026-10-10T00:00:00.000Z",
  verdict: "accepted",
  verdictReason: "integrity test",
  recoveryConfidence: 90,
  candidate: { periodDays: 3.2, epochBjd: 2000.5, durationHours: 2.1, depthPpt: 5, depthFrac: 0.005, snr: 12, power: 30, nPointsInTransit: 6 },
  crossmatch: null,
});

async function seededBundle(store: MemStore) {
  const artifacts = [{ name: "folded.svg", bytes: new TextEncoder().encode("<svg>x</svg>") }];
  const composed = await composeBundle({ finding: minimalFinding() as Finding, runId: "r1", codeVersion: "v1", artifacts });
  await persistBundle(store, composed, artifacts);
  return composed;
}

test("verifyBundle passes for an untouched bundle", async () => {
  const store = new MemStore();
  await seededBundle(store);
  const v = await verifyBundle(store, "F-int");
  assert.equal(v.ok, true);
  assert.equal(v.hashMatches, true);
  assert.equal(v.hashMissing, false);
});

test("verifyBundle FAILS when HASH.txt is deleted (no self-compare)", async () => {
  const store = new MemStore();
  await seededBundle(store);
  store.del("bundles/F-int/HASH.txt");
  const v = await verifyBundle(store, "F-int");
  assert.equal(v.hashMissing, true);
  assert.equal(v.hashMatches, false);
  assert.equal(v.ok, false, "a missing HASH.txt must never be treated as a pass");
});

test("verifyBundle FAILS when the manifest is edited but HASH.txt is left intact", async () => {
  const store = new MemStore();
  await seededBundle(store);
  const key = "bundles/F-int/manifest.json";
  const doc = JSON.parse((await store.getText(key)) as string);
  doc.verdictReason = "silently rewritten";
  await store.put(key, JSON.stringify(doc, null, 2));
  const v = await verifyBundle(store, "F-int");
  assert.equal(v.hashMatches, false);
  assert.equal(v.ok, false);
});

test("verifyBundle detects a tampered artifact byte", async () => {
  const store = new MemStore();
  await seededBundle(store);
  await store.put("bundles/F-int/folded.svg", new TextEncoder().encode("<svg>TAMPERED</svg>"));
  const v = await verifyBundle(store, "F-int");
  assert.equal(v.hashMatches, true, "manifest itself is unchanged");
  assert.equal(v.artifactsOk, false);
  assert.deepEqual(v.mismatched, ["folded.svg"]);
  assert.equal(v.ok, false);
});

test("getOrCreateKeypair refuses to overwrite a corrupt keypair file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdr-key-"));
  const p = join(dir, "keypair.json");
  const corrupt = "{ this is not valid json ]";
  writeFileSync(p, corrupt, "utf8");
  await assert.rejects(() => getOrCreateKeypair(p), /refusing to overwrite/);
  assert.equal(readFileSync(p, "utf8"), corrupt, "the corrupt file must be left untouched, not replaced by an empty wallet");
  rmSync(dir, { recursive: true, force: true });
});

test("getOrCreateKeypair creates a keypair only when the file is genuinely absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdr-key2-"));
  const p = join(dir, "keypair.json");
  assert.equal(existsSync(p), false);
  const kp = await getOrCreateKeypair(p);
  assert.ok(kp);
  assert.equal(existsSync(p), true);
  rmSync(dir, { recursive: true, force: true });
});
