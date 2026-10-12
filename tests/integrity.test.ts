// Integrity tests for the audit fixes (issue #4): local verification must FAIL, never self-compare,
// when HASH.txt is missing, and a corrupt keypair file must never be silently overwritten. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactStore } from "../src/core/ports.ts";
import type { Finding } from "../src/core/types.ts";
import type { BundleRecord, LedgerEntry } from "../src/core/state-types.ts";
import { RigStore } from "../src/core/store.ts";
import { anchorStampIsValid } from "../src/core/anchor-verify.ts";
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

// ---- issue #2: bundle-hash drift (anchor stamp must not leak across a changed hash) ----

const findingAt = (bundleHash: string, solanaTx?: string): Finding =>
  ({ id: "F-drift", targetId: "HR 858 c", createdAt: "2026-01-01T00:00:00.000Z", verdict: "accepted", verdictReason: "", bundleHash, solanaTx }) as unknown as Finding;

test("a re-run with the SAME bundle hash keeps the on-chain anchor stamp", () => {
  const store = new RigStore();
  store.addFinding(findingAt("hashA", "sigA"));
  const again = store.addFinding(findingAt("hashA", undefined));
  assert.equal(again.solanaTx, "sigA", "same bundle -> still anchored, keep the tx");
});

test("a re-run with a DIFFERENT bundle hash does NOT inherit the stale anchor", () => {
  const store = new RigStore();
  store.addFinding(findingAt("hashA", "sigA"));
  const rerun = store.addFinding(findingAt("hashB", undefined));
  assert.equal(rerun.bundleHash, "hashB");
  assert.equal(rerun.solanaTx, undefined, "a new bundle must not claim the prior run's on-chain anchor");
});

test("addBundle likewise refuses to carry a tx across a changed hash", () => {
  const store = new RigStore();
  store.addBundle({ findingId: "F-drift", hash: "hA", createdAt: "2026-01-01T00:00:00.000Z", solanaTx: "sigA" } as unknown as BundleRecord);
  const same = store.addBundle({ findingId: "F-drift", hash: "hA", createdAt: "2026-01-01T00:00:00.000Z" } as unknown as BundleRecord);
  assert.equal(same.solanaTx, "sigA", "same hash -> inherit");
  const changed = store.addBundle({ findingId: "F-drift", hash: "hB", createdAt: "2026-01-01T00:00:00.000Z" } as unknown as BundleRecord);
  assert.equal(changed.solanaTx, undefined, "changed hash -> no stale anchor");
});

// ---- the ledger cross-check rule (the residual drift hole the audit found live on HAT-P-11-b) ----

const led = (findingId: string, bundleHash: string, signature: string, status: LedgerEntry["status"] = "anchored"): LedgerEntry =>
  ({ findingId, bundleHash, signature, status } as LedgerEntry);

const fnd = (id: string, bundleHash: string, solanaTx?: string): Finding =>
  ({ id, targetId: id, createdAt: "2026-01-01T00:00:00.000Z", verdict: "accepted", verdictReason: "", bundleHash, solanaTx }) as unknown as Finding;

test("anchorStampIsValid requires an anchored ledger entry matching BOTH the tx and the current hash", () => {
  assert.equal(anchorStampIsValid(led("F", "hA", "sigA"), "hA", "sigA"), true);
  assert.equal(anchorStampIsValid(led("F", "hA", "sigA"), "hB", "sigA"), false, "bundle hash drifted from what the tx anchored");
  assert.equal(anchorStampIsValid(led("F", "hA", "sigB"), "hA", "sigA"), false, "stamp tx differs from ledger tx");
  assert.equal(anchorStampIsValid(led("F", "hA", "sigA", "failed"), "hA", "sigA"), false, "a failed ledger row proves nothing");
  assert.equal(anchorStampIsValid(undefined, "hA", "sigA"), false, "no ledger entry at all");
  assert.equal(anchorStampIsValid(led("F", "hA", "sigA"), "hA", undefined), false, "nothing stamped");
});

test("reconcileAnchorStamps drops a drifted stamp but keeps a ledger-confirmed one (no spend)", () => {
  const store = new RigStore();
  store.addFinding(fnd("F-ok", "hashA", "sigA"));
  store.addFinding(fnd("F-bad", "hashB", "sigA")); // current hash B, but sigA sealed hash A
  store.addBundle({ findingId: "F-bad", hash: "hashB", createdAt: "2026-01-01T00:00:00.000Z", solanaTx: "sigA" } as unknown as BundleRecord);
  const ledger = [led("F-ok", "hashA", "sigA"), led("F-bad", "hashA", "sigA")];
  const r = store.reconcileAnchorStamps(ledger);
  assert.equal(store.getFinding("F-ok")!.solanaTx, "sigA", "valid anchor is preserved");
  assert.equal(store.getFinding("F-bad")!.solanaTx, undefined, "drifted stamp is cleared");
  assert.equal(store.listBundles().find((b) => b.findingId === "F-bad")!.solanaTx, undefined, "bundle stamp cleared too");
  assert.equal(r.clearedFindings, 1);
  assert.equal(r.clearedBundles, 1);
});
