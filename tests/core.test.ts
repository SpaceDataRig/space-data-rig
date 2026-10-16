// Regression tests for Space Data Rig core invariants: canonical hashing,
// on-chain memo shape, RPC endpoint hygiene, and ephemeris math.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Hex, hashManifest, hashScience, type BundleManifest } from "../src/bundle/bundle.ts";
import {
  DEFAULT_RPC,
  MEMO_PREFIX,
  DELIB_MEMO_PREFIX,
  OBSERVE_MEMO_PREFIX,
  buildMemo,
  buildDeliberationMemo,
  buildObserveMemo,
  findAnchoredScience,
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

test("buildMemo appends a scienceHash as a 4th field without disturbing the bundleHash position", () => {
  const hash = "f".repeat(64);
  const sci = "e".repeat(64);
  const memo = buildMemo("F-HR-858-b", hash, sci);
  assert.equal(memo, `${MEMO_PREFIX}|F-HR-858-b|${hash}|${sci}`);
  assert.equal(memo.split("|")[2], hash); // on-chain verify matches on the bundleHash at position 2
  assert.ok(memo.includes(hash)); // substring check is unaffected by the appended field
});

test("Node and Worker anchor paths produce the SAME memo shape for a given scienceHash (audit-3 defect A)", async () => {
  // The on-chain tx memo is built by anchorOnEndpoints (shared by both runtimes); the Node
  // adapter's dryRun preview exercises the exact wiring that previously dropped scienceHash.
  const { anchorBundleHash } = await import("../src/solana/anchor.ts");
  const hash = "f".repeat(64);
  const sci = "a".repeat(64);
  const withSci = await anchorBundleHash("F-HR-858-b", hash, { dryRun: true, scienceHash: sci });
  assert.equal(withSci.memo, buildMemo("F-HR-858-b", hash, sci)); // Node forwards scienceHash end-to-end
  assert.equal(withSci.memo.split("|").length, 4);
  const without = await anchorBundleHash("F-HR-858-b", hash, { dryRun: true });
  assert.equal(without.memo, buildMemo("F-HR-858-b", hash)); // omitted -> classic 3-field, unchanged
  assert.equal(without.memo.split("|").length, 3);
});

test("findAnchoredScience dedups on the content address across findings, never on bundleHash/timestamp (audit-3 P0-B)", () => {
  const sh = "a".repeat(64);
  const rows = [
    { findingId: "F-HR-858-b", status: "failed", signature: undefined, scienceHash: sh },
    { findingId: "F-HR-858-c", status: "anchored", signature: "sigC", scienceHash: sh },
  ];
  assert.equal(findAnchoredScience(rows, sh)?.findingId, "F-HR-858-c"); // cross-finding match on same scienceHash
  assert.equal(findAnchoredScience(rows, sh)?.signature, "sigC");
  assert.equal(findAnchoredScience(rows, undefined), null); // no content address -> anchor normally
  assert.equal(findAnchoredScience(rows, "b".repeat(64)), null); // different science -> not a dupe
  // a failed row, even with the right scienceHash, is not a committed anchor
  assert.equal(findAnchoredScience([{ findingId: "X", status: "failed", signature: "sigX", scienceHash: sh }], sh), null);
  // legacy rows with no scienceHash never match (bundleHash/timestamp is not the dedup key)
  assert.equal(findAnchoredScience([{ findingId: "Y", status: "anchored", signature: "sigY" }], sh), null);
});

test("hashScience is content-addressed (stable across createdAt/runId) while bundleHash is a timestamped commitment", async () => {
  const base = {
    schema: "space-data-rig/bundle@1", findingId: "F-1", targetId: "T", createdAt: "2020-01-01T00:00:00Z", runId: "run-A",
    codeVersion: "v1", candidate: { periodDays: 3, epochBjd: 2459000, durationHours: 2, depthPpt: 1, depthFrac: 0.001, snr: 12, power: 1, nPointsInTransit: 5 },
    verdict: "detected", verdictReason: "r", crossmatch: {}, artifacts: [],
  } as unknown as BundleManifest;
  const later = { ...base, createdAt: "2026-05-05T00:00:00Z", runId: "run-B" };
  assert.equal(await hashScience(base), await hashScience(later)); // identical science -> identical content address
  assert.notEqual(await hashManifest(base), await hashManifest(later)); // but the timestamped bundle hashes differ
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

test("buildObserveMemo uses a third distinct prefix so it never collides with bundle or deliberation memos", () => {
  const hash = "c".repeat(64);
  const memo = buildObserveMemo("OBS-0001", hash);
  assert.equal(memo, `${OBSERVE_MEMO_PREFIX}|OBS-0001|${hash}`);
  assert.equal(memo.split("|").length, 3);
  assert.ok(!memo.startsWith(MEMO_PREFIX + "|"));
  assert.ok(!memo.startsWith(DELIB_MEMO_PREFIX + "|"));
  assert.ok(memo.startsWith(OBSERVE_MEMO_PREFIX + "|"));
  assert.notEqual(OBSERVE_MEMO_PREFIX, DELIB_MEMO_PREFIX);
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
