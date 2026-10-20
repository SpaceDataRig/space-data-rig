// Offline behaviour tests for the read-only on-chain memo verifier (audit #4).
//
// memoVerify.ts is deliberately dependency-free (no node:fs, no @solana/web3.js), so the whole path -- re-reading a
// transaction, decoding the SPL Memo, and comparing BOTH the bundleHash and the scienceHash against what we serve --
// can be exercised against an injected mock fetch with NO network and NO keypair. The property that matters most and
// is pinned here: an anchor the chain cannot be read is NEVER reported as verified, and a legacy 3-field memo is
// reported as "cannot compare", not as "drift" -- we do not claim the chain contradicts us when it never said.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseMemo,
  extractMemoFromTx,
  readChainMemo,
  compareAnchor,
  SCIENCE_MEMO_PREFIX,
  type MemoFields,
  type ChainMemoRead
} from "../src/solana/memoVerify.ts";

// A jsonParsed getTransaction result carrying one SPL Memo whose `parsed` is the memo string (the live render shape).
function txWithMemo(memo: string): unknown {
  return { transaction: { message: { instructions: [{ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo }] } } };
}

// A fetch stub: replays one canned response per endpoint in call order. `resp` is either { ok, status, json } or a throw.
type Step = { ok?: boolean; status?: number; result?: unknown; error?: { message?: string }; throwFor?: string };
function mockFetch(
  steps: Step[]
): (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  let i = 0;
  return async () => {
    const s = steps[Math.min(i, steps.length - 1)];
    i++;
    if (s.throwFor) throw new Error(s.throwFor);
    return {
      ok: s.ok,
      status: s.status ?? (s.ok ? 200 : 500),
      json: async () => ({ jsonrpc: "2.0", id: 1, ...(s.error ? { error: s.error } : {}), result: s.result ?? null })
    };
  };
}

const BH = "b".repeat(64);
const SH = "s".repeat(64);

test("parseMemo: 3-field legacy carries no scienceHash; 4-field does; too-short is null", () => {
  const three = parseMemo(`sdr:1|F-ABC|${BH}`);
  assert.ok(three);
  assert.equal(three!.prefix, "sdr:1");
  assert.equal(three!.findingId, "F-ABC");
  assert.equal(three!.bundleHash, BH);
  assert.equal(three!.scienceHash, undefined);

  const four = parseMemo(`sdr:1|F-ABC|${BH}|${SH}`);
  assert.equal(four!.scienceHash, SH);

  assert.equal(parseMemo("sdr:1|F-ABC"), null, "two fields is not a complete anchor");
  assert.equal(parseMemo("|x|"), null, "empty bundleHash is rejected");
});

test("extractMemoFromTx: matches the science prefix only, ignores delib/observe memos and non-memo instructions", () => {
  const sci = `sdr:1|F-1|${BH}|${SH}`;
  assert.equal(extractMemoFromTx(txWithMemo(sci)), sci);

  // A tx whose only memo is a deliberation receipt must NOT satisfy a science-prefix read.
  const delib = { transaction: { message: { instructions: [{ program: "spl-memo", parsed: "sdr:delib:1|F-1|abc" }] } } };
  assert.equal(extractMemoFromTx(delib, SCIENCE_MEMO_PREFIX), undefined);

  // Older shape: memo nested under parsed.info.memo.
  const nested = { transaction: { message: { instructions: [{ program: "spl-memo", parsed: { info: { memo: sci } } }] } } };
  assert.equal(extractMemoFromTx(nested), sci);

  // A non-memo instruction (system program) is skipped.
  const mixed = {
    transaction: {
      message: {
        instructions: [
          { program: "system", parsed: { type: "transfer" } },
          { program: "spl-memo", parsed: sci }
        ]
      }
    }
  };
  assert.equal(extractMemoFromTx(mixed), sci);

  assert.equal(extractMemoFromTx({}), undefined, "shape without instructions is handled");
});

test("readChainMemo: happy path decodes fields and marks the chain readable", async () => {
  const read = await readChainMemo({
    endpoints: ["https://rpc.example"],
    signature: "SIG",
    fetchImpl: mockFetch([{ ok: true, result: txWithMemo(`sdr:1|F-1|${BH}|${SH}`) }])
  });
  assert.equal(read.chainReadable, true);
  assert.equal(read.memoDecoded, true);
  assert.equal(read.fields?.bundleHash, BH);
  assert.equal(read.fields?.scienceHash, SH);
  assert.equal(read.viaEndpoint, "rpc.example");
});

test("readChainMemo: walks to a later endpoint when the first has the tx not indexed yet", async () => {
  const read = await readChainMemo({
    endpoints: ["https://a.example", "https://b.example"],
    signature: "SIG",
    fetchImpl: mockFetch([
      { ok: true, result: null },
      { ok: true, result: txWithMemo(`sdr:1|F-1|${BH}`) }
    ])
  });
  assert.equal(read.chainReadable, true);
  assert.equal(read.memoDecoded, true);
  assert.equal(read.viaEndpoint, "b.example", "reports which endpoint actually answered");
});

test("readChainMemo: every endpoint throwing means chainReadable:false -- nothing may be presented as verified", async () => {
  const read = await readChainMemo({
    endpoints: ["https://a.example", "https://b.example"],
    signature: "SIG",
    fetchImpl: mockFetch([{ throwFor: "socket hang up" }])
  });
  assert.equal(read.chainReadable, false);
  assert.equal(read.memoDecoded, false);
  assert.ok(read.error);
});

test("readChainMemo: reachable but no matching memo => readable true, decoded false", async () => {
  const read = await readChainMemo({
    endpoints: ["https://a.example"],
    signature: "SIG",
    fetchImpl: mockFetch([{ ok: true, result: { transaction: { message: { instructions: [] } } } }])
  });
  assert.equal(read.chainReadable, true);
  assert.equal(read.memoDecoded, false);
});

test("compareAnchor: full 4-field agreement => verifiable, all matches, no drift", () => {
  const read: ChainMemoRead = {
    chainReadable: true,
    memoDecoded: true,
    memo: `sdr:1|F-1|${BH}|${SH}`,
    fields: { prefix: "sdr:1", findingId: "F-1", bundleHash: BH, scienceHash: SH } as MemoFields
  };
  const cmp = compareAnchor(read, { findingId: "F-1", ledgerBundleHash: BH, currentBundleHash: BH, currentScienceHash: SH });
  assert.equal(cmp.verifiable, true);
  assert.equal(cmp.ledgerBundleMatch, true);
  assert.equal(cmp.anchorCoversCurrentBundle, true);
  assert.equal(cmp.findingIdMatch, true);
  assert.equal(cmp.scienceHashMatch, true);
  assert.equal(cmp.anchoredScienceDrift, false);
  assert.equal(cmp.legacyMemo, false);
});

test("compareAnchor: on-chain scienceHash differs from served science => explicit drift", () => {
  const SH2 = "t".repeat(64);
  const read: ChainMemoRead = { chainReadable: true, memoDecoded: true, fields: { prefix: "sdr:1", findingId: "F-1", bundleHash: BH, scienceHash: SH2 } };
  const cmp = compareAnchor(read, { findingId: "F-1", ledgerBundleHash: BH, currentBundleHash: BH, currentScienceHash: SH });
  assert.equal(cmp.verifiable, true);
  assert.equal(cmp.scienceCompareAvailable, true);
  assert.equal(cmp.scienceHashMatch, false);
  assert.equal(cmp.anchoredScienceDrift, true, "chain sealed different science than we publish now");
});

test("compareAnchor: legacy 3-field memo is 'cannot compare', never 'drift'", () => {
  const read: ChainMemoRead = { chainReadable: true, memoDecoded: true, fields: { prefix: "sdr:1", findingId: "F-1", bundleHash: BH } };
  const cmp = compareAnchor(read, { findingId: "F-1", ledgerBundleHash: BH, currentBundleHash: BH, currentScienceHash: SH });
  assert.equal(cmp.verifiable, true);
  assert.equal(cmp.legacyMemo, true);
  assert.equal(cmp.scienceCompareAvailable, false);
  assert.equal(cmp.scienceHashMatch, undefined, "no scienceHash on chain means the comparison is unavailable");
  assert.equal(cmp.anchoredScienceDrift, false, "absence of a field is not evidence the chain contradicts us");
});

test("compareAnchor: bundleHash moved (re-derived bundle) => anchor no longer covers the current bundle", () => {
  const BH2 = "c".repeat(64);
  const read: ChainMemoRead = { chainReadable: true, memoDecoded: true, fields: { prefix: "sdr:1", findingId: "F-1", bundleHash: BH, scienceHash: SH } };
  const cmp = compareAnchor(read, { findingId: "F-1", ledgerBundleHash: BH, currentBundleHash: BH2, currentScienceHash: SH });
  assert.equal(cmp.ledgerBundleMatch, true, "ledger told the truth about what it sealed");
  assert.equal(cmp.anchorCoversCurrentBundle, false, "but the served bundle is a newer commitment");
  assert.equal(cmp.anchoredScienceDrift, false, "same science content even though the timestamped hash moved");
});

test("compareAnchor: an unreadable chain read is total and all-false (verifiable never true)", () => {
  const read: ChainMemoRead = { chainReadable: false, memoDecoded: false, error: "no endpoint answered" };
  const cmp = compareAnchor(read, { findingId: "F-1", ledgerBundleHash: BH, currentBundleHash: BH, currentScienceHash: SH });
  assert.equal(cmp.verifiable, false);
  assert.equal(cmp.anchoredScienceDrift, false);
  assert.equal(cmp.scienceHashMatch, undefined);
  assert.equal(cmp.ledgerBundleMatch, false);
});
