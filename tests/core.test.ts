// Regression tests for Space Data Rig core invariants: canonical hashing,
// on-chain memo shape, RPC endpoint hygiene, and ephemeris math.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Hex } from "../src/bundle/bundle.ts";
import {
  DEFAULT_RPC,
  MEMO_PREFIX,
  DELIB_MEMO_PREFIX,
  buildMemo,
  buildDeliberationMemo,
  endpointList,
  explorerUrl,
  isDevnetRpc,
} from "../src/solana/anchor-core.ts";
import { predictEphemeris } from "../src/sim/confidence.ts";
import { RigStore } from "../src/core/store.ts";
import { FsArtifactStore } from "../src/node/artifact-store.ts";
import type { Finding } from "../src/core/types.ts";
import type { BundleRecord } from "../src/core/state-types.ts";

// ---- canonical JSON + hashing (the cross-runtime bundle integrity backbone) ----

test("canonicalJson is key-order independent", () => {
  const a = { b: 1, a: { z: [1, 2], y: "s" } };
  const b = { a: { y: "s", z: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test("canonicalJson sorts keys at every depth and keeps array order", () => {
  assert.equal(canonicalJson({ b: { d: 1, c: 2 }, a: [3, 1, 2] }), '{"a":[3,1,2],"b":{"c":2,"d":1}}');
});

test("sha256Hex matches the NIST test vector for 'abc'", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// ---- solana anchor core (memo shape + endpoint handling) ----

test("buildMemo emits the versioned three-field pipe format", () => {
  const hash = "f".repeat(64);
  const memo = buildMemo("F-HR-858-b", hash);
  assert.equal(memo, `${MEMO_PREFIX}|F-HR-858-b|${hash}`);
  assert.equal(memo.split("|").length, 3);
});

test("buildDeliberationMemo uses a distinct prefix so it never collides with the science bundle memo", () => {
  const hash = "a".repeat(64);
  const memo = buildDeliberationMemo("F-HR-858-b", hash);
  assert.equal(memo, `${DELIB_MEMO_PREFIX}|F-HR-858-b|${hash}`);
  assert.equal(memo.split("|").length, 3);
  // The deliberation memo must be tellable apart from the bundle memo for the same id/hash.
  assert.notEqual(DELIB_MEMO_PREFIX, MEMO_PREFIX);
  assert.ok(!memo.startsWith(MEMO_PREFIX + "|"));
  assert.ok(memo.startsWith(DELIB_MEMO_PREFIX + "|"));
});

test("explorerUrl targets mainnet", () => {
  assert.match(explorerUrl("SIG123"), /explorer\.solana\.com\/tx\/SIG123\?cluster=mainnet$/);
});

test("isDevnetRpc only flags devnet endpoints", () => {
  assert.equal(isDevnetRpc("https://api.devnet.solana.com"), true);
  assert.equal(isDevnetRpc(DEFAULT_RPC), false);
});

test("endpointList orders primary -> private -> fallbacks -> public, de-duplicated", () => {
  const list = endpointList(
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3,https://a.example/1",
    ["https://d.example/4", "https://d.example/4"],
  );
  assert.deepEqual(list, [
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3",
    "https://d.example/4",
  ]);
});

test("endpointList falls back to the public default when given nothing", () => {
  assert.deepEqual(endpointList(), [DEFAULT_RPC]);
});

// ---- ephemeris (deterministic transit prediction) ----

test("predictEphemeris returns consecutive transit epochs from t0", () => {
  assert.deepEqual(predictEphemeris(100, 3, 3), [100, 103, 106]);
  assert.deepEqual(predictEphemeris(100, 3, 2, 104), [106, 109]);
  assert.deepEqual(predictEphemeris(100, 0, 3), []);
  assert.deepEqual(predictEphemeris(Number.NaN, 3, 3), []);
});

// ---- anchor-stamp preservation across deterministic re-runs ----

test("re-adding a finding/bundle keeps the solanaTx anchor stamp (Node store)", () => {
  const s = new RigStore();
  const sealed = { id: "F-TEST", createdAt: "2026-01-01T00:00:00.000Z", solanaTx: "SIG_ABC" } as unknown as Finding;
  const rerun = { id: "F-TEST", createdAt: "2026-01-02T00:00:00.000Z" } as unknown as Finding;
  s.addFinding(sealed);
  s.addFinding(rerun);
  assert.equal(s.getFinding("F-TEST")?.solanaTx, "SIG_ABC");

  const sealedB = { findingId: "F-TEST", createdAt: "2026-01-01T00:00:00.000Z", solanaTx: "SIG_ABC" } as unknown as BundleRecord;
  const rerunB = { findingId: "F-TEST", createdAt: "2026-01-02T00:00:00.000Z" } as unknown as BundleRecord;
  s.addBundle(sealedB);
  s.addBundle(rerunB);
  assert.equal(s.listBundles().find((b) => b.findingId === "F-TEST")?.solanaTx, "SIG_ABC");
});

// ---- artifact store root containment ----

test("FsArtifactStore refuses keys that would escape its root", async () => {
  const st = new FsArtifactStore("/tmp/sdr-test-root");
  // Writes must fail loudly; reads resolve safely to nothing (get swallows misses).
  await assert.rejects(() => st.put("../escape.txt", "x"), /escapes store root/);
  assert.equal(await st.getText("a/../../escape.txt"), null);
});
