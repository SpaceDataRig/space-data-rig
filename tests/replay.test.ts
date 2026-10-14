// Offline tests for the deterministic replay record (priority 6). Pure hashing of a canonical,
// deterministic-only record; the real end-to-end run on S3 bytes is the script, not tested here (CI has
// no network). The property under test: identical inputs -> identical hash, and any change to a
// deterministic field changes it, independent of key order.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReplayRecord, replayHash, verifyReplay, buildReplayManifest, verifyManifest, REPLAY_MANIFEST_SCHEMA, type ReplayInput } from "../src/sim/replay.ts";

const base: ReplayInput = {
  dataHash: "abc123",
  codeVersion: "v0.1.0",
  algorithm: "iterativeBls",
  params: { minPeriodDays: 1, maxPeriodDays: 15, maxSignals: 3, seed: 7 },
  candidate: { periodDays: 3.585, epochBjd: 2458340.1, durationHours: 2.1, depthFrac: 0.0042, snr: 18.3, verdict: "candidate" },
};

test("buildReplayRecord keeps ONLY deterministic fields", () => {
  const r = buildReplayRecord({ ...base, ...({ createdAt: "now", runId: "r1" } as object) } as ReplayInput);
  assert.deepEqual(Object.keys(r).sort(), ["algorithm", "candidate", "codeVersion", "dataHash", "params", "schema"]);
  assert.equal((r as unknown as Record<string, unknown>).createdAt, undefined);
  assert.equal((r as unknown as Record<string, unknown>).runId, undefined);
});

test("the same inputs produce the same replay hash", async () => {
  const h1 = await replayHash(buildReplayRecord(base));
  const h2 = await replayHash(buildReplayRecord(base));
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("hash is independent of parameter key order", async () => {
  const reordered: ReplayInput = {
    ...base,
    params: { seed: 7, maxSignals: 3, maxPeriodDays: 15, minPeriodDays: 1 },
  };
  assert.equal(await replayHash(buildReplayRecord(base)), await replayHash(buildReplayRecord(reordered)));
});

test("changing any deterministic field changes the hash", async () => {
  const h0 = await replayHash(buildReplayRecord(base));
  const variants: ReplayInput[] = [
    { ...base, dataHash: "different" },
    { ...base, codeVersion: "v0.2.0" },
    { ...base, params: { ...base.params, seed: 8 } },
    { ...base, candidate: { ...base.candidate, snr: 18.4 } },
    { ...base, candidate: { ...base.candidate, verdict: "rejected" } },
  ];
  for (const v of variants) {
    assert.notEqual(await replayHash(buildReplayRecord(v)), h0, `variant should change hash: ${JSON.stringify(v)}`);
  }
});

test("verifyReplay confirms a match and rejects a tamper", async () => {
  const record = buildReplayRecord(base);
  const hash = await replayHash(record);
  assert.equal(await verifyReplay(record, hash), true);
  const tampered = { ...record, candidate: { ...record.candidate, snr: 999 } };
  assert.equal(await verifyReplay(tampered, hash), false);
});

test("buildReplayManifest is self-contained and internally consistent", async () => {
  const record = buildReplayRecord(base);
  const m = await buildReplayManifest(
    { name: "HD 39091", tic: 261136679, sector: 1 },
    { bucket: "stpubdata", key: "mast/hlsp/tess-spoc/x.fits", expectedByteSha256: "beef", byteLength: 164160 },
    record,
  );
  assert.equal(m.schema, REPLAY_MANIFEST_SCHEMA);
  assert.equal(m.discoveryClaim, false);
  assert.equal(m.replayHash, await replayHash(record), "manifest hash = record hash");
  assert.equal(m.retrieval.url, "https://stpubdata.s3.amazonaws.com/mast/hlsp/tess-spoc/x.fits", "url derived from bucket+key");
  assert.equal(m.verifySteps.length, 5);
  assert.ok(m.verifySteps.every((s) => !/undefined|\[object/.test(s)), "no placeholder leakage in steps");
  assert.equal(await verifyManifest(m), true, "manifest verifies against itself");
});

test("verifyManifest rejects a tampered record", async () => {
  const record = buildReplayRecord(base);
  const m = await buildReplayManifest(
    { name: "X", tic: 1, sector: 1 },
    { bucket: "b", key: "k", expectedByteSha256: "aa", byteLength: 10 },
    record,
  );
  const tampered = { ...m, record: { ...m.record, candidate: { ...m.record.candidate, snr: 1 } } };
  assert.equal(await verifyManifest(tampered), false, "record changed but replayHash stale -> invalid");
});
