// READ-ONLY on-chain memo verification -- runtime-agnostic, dependency-free, spends nothing.
//
// WHY THIS EXISTS (audit point #4). The public /verify route re-hashes the bundle it serves and compares it to
// the HASH.txt sitting beside it -- a self-consistency check that needs no trust in OUR database, but also never
// touches the chain. The README had grown a sentence implying anyone could "re-read the memo on-chain and check
// the science", which was true of the ANCHOR WRITE path's hash but not surfaced anywhere a reader could click:
// nothing took a findingId, re-read its sealed Solana transaction, DECODED the memo fields, and compared the
// scienceHash the chain actually carries against the science we publish TODAY. The third-round audit caught that
// scienceHash was computed but never reached the chain; we later fixed the WRITE, but the READ-back stayed a
// script for us (scripts/anchor-memo-decode.ts) rather than an endpoint for everyone. This closes that gap: the
// same decode is now reachable over HTTP and reports anchored-science DRIFT explicitly.
//
// WHAT "DRIFT" MEANS HERE, stated precisely. Two hashes ride in the memo:
//   sdr:1|<findingId>|<bundleHash>[|<scienceHash>]
// bundleHash is a TIMESTAMPED COMMITMENT (it binds the analysis to the moment it ran), so any re-derivation
// changes it -- a stale bundleHash on-chain is expected and is NOT the thing we flag. scienceHash is a CONTENT
// ADDRESS of the blind science; it is supposed to survive re-runs and change only when the science itself
// changes. So `anchoredScienceDrift` is true exactly when the chain sealed a scienceHash AND that differs from the
// scienceHash of the bundle we are serving now -- i.e. the on-chain anchor no longer proves the conclusion a
// reader is being shown. A historical 3-field memo carries no scienceHash at all: that is `legacyMemo` (the
// comparison is simply unavailable), deliberately kept DISTINCT from drift so we never claim the chain contradicts
// us when it never said.
//
// THE ONE INVARIANT THAT MAKES THE ANSWER TRUSTWORTHY: when the chain cannot be read, `chainReadable` is false
// and every comparison comes back null/false -- the caller must NOT present an unverified anchor as verified.
// Nothing here imports node:fs or @solana/web3.js; the RPC is a plain fetch of getTransaction in `jsonParsed`
// encoding (the SPL Memo renders as ix.parsed == the memo string), so the identical code runs on Node, on
// Workers, and offline against an injected mock fetch.

/** SPL Memo program id (standard; matches anchor-core.MEMO_PROGRAM_ID's base58 form). */
export const MEMO_PROGRAM_ID_STR = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Science-bundle memo schema. Deliberately duplicated from anchor-core so this module stays free of web3.js. */
export const SCIENCE_MEMO_PREFIX = "sdr:1";

/** Minimal fetch shape so tests inject a stub and both runtimes' global fetch satisfies it. */
export type MemoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A memo decoded into its pipe-delimited fields. bundleHash is always position 2; scienceHash is the optional 4th. */
export interface MemoFields {
  prefix: string;
  findingId: string;
  bundleHash: string;
  scienceHash?: string;
}

/** Parse a memo string into fields. Returns null for anything that is not at least prefix|id|bundleHash. */
export function parseMemo(memo: string): MemoFields | null {
  const parts = memo.split("|");
  if (parts.length < 3) return null;
  const [prefix, findingId, bundleHash, scienceHash] = parts;
  if (!prefix || !bundleHash) return null;
  return { prefix, findingId, bundleHash, scienceHash: scienceHash ? scienceHash : undefined };
}

/** One jsonParsed instruction, narrowed to just the fields the memo decode touches (no `any` reaching consumers). */
interface ParsedMemoInstruction {
  program?: string;
  programId?: string;
  parsed?: unknown;
}

/** Read the memo string out of an spl-memo instruction's `parsed`, which jsonParsed renders as a bare string or,
 *  in older shapes, nests under {info} / {info.memo}. Any-free: unknown is narrowed by typeof checks. */
function parsedMemoString(p: unknown): string {
  if (typeof p === "string") return p;
  if (p && typeof p === "object") {
    const info = (p as { info?: unknown }).info;
    if (typeof info === "string") return info;
    if (info && typeof info === "object") {
      const memo = (info as { memo?: unknown }).memo;
      if (typeof memo === "string") return memo;
    }
  }
  return "";
}

/**
 * Pull the memo string for our prefix out of a jsonParsed getTransaction result. jsonParsed renders an SPL Memo
 * as ix.parsed == the memo STRING directly; older shapes nest it under {info}/{info.memo}. Returns the FIRST memo
 * whose parsed prefix equals `prefix` (exact field match, so a "sdr:1" probe never accidentally grabs a
 * "sdr:delib:1"/"sdr:observe:1" record that merely shares the leading characters).
 */
export function extractMemoFromTx(txResult: unknown, prefix: string = SCIENCE_MEMO_PREFIX): string | undefined {
  const instrs = (txResult as { transaction?: { message?: { instructions?: ParsedMemoInstruction[] } } })?.transaction?.message?.instructions;
  if (!Array.isArray(instrs)) return undefined;
  for (const ix of instrs) {
    const isMemo = ix?.program === "spl-memo" || ix?.programId === MEMO_PROGRAM_ID_STR;
    if (!isMemo) continue;
    const memo = parsedMemoString(ix?.parsed);
    if (!memo) continue;
    const fields = parseMemo(memo);
    if (fields && fields.prefix === prefix) return memo;
  }
  return undefined;
}

/** Result of re-reading the chain for one signature (before any comparison against our own data). */
export interface ChainMemoRead {
  /** True only when an RPC endpoint actually answered. False => nothing here may be presented as verified. */
  chainReadable: boolean;
  /** True when a tx was found AND an spl-memo with the expected prefix was decoded from it. */
  memoDecoded: boolean;
  memo?: string;
  fields?: MemoFields;
  /** Host-only label of the endpoint that answered (private RPCs embed keys in the path; never leak those). */
  viaEndpoint?: string;
  error?: string;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-endpoint";
  }
}

/**
 * Re-read a sealed transaction from the chain and decode its memo, walking the ordered endpoint list until one
 * answers. Trusts nothing local. Never throws: every failure surfaces as a plain ChainMemoRead.
 *
 * `result === null` from a reachable endpoint (tx not yet indexed by THAT provider) is a MISS on that endpoint, not
 * a transport failure: we record it and keep walking, and only report chainReadable=true + memoDecoded=false when
 * some endpoint was reachable yet no matching memo was found anywhere.
 */
export async function readChainMemo(opts: {
  endpoints: string[];
  signature: string;
  prefix?: string;
  fetchImpl: MemoFetch;
  timeoutMs?: number;
}): Promise<ChainMemoRead> {
  const prefix = opts.prefix ?? SCIENCE_MEMO_PREFIX;
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (opts.endpoints.length === 0) return { chainReadable: false, memoDecoded: false, error: "no RPC endpoint configured" };
  if (!opts.signature) return { chainReadable: false, memoDecoded: false, error: "no signature to look up" };

  let reachedOne = false;
  let lastError = "";
  for (const url of opts.endpoints) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [opts.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
    });
    try {
      const res = await withTimeout(
        opts.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        }),
        timeoutMs
      );
      reachedOne = true;
      if (!res.ok) {
        lastError = `${hostLabel(url)}: RPC HTTP ${res.status}`;
        continue;
      }
      const j = (await res.json()) as { error?: { message?: string }; result?: unknown };
      if (j?.error) {
        lastError = `${hostLabel(url)}: RPC error ${j.error.message ?? "unknown"}`;
        continue;
      }
      if (!j?.result) {
        lastError = `${hostLabel(url)}: transaction not indexed on this provider`;
        continue;
      }
      const memo = extractMemoFromTx(j.result, prefix);
      if (!memo) {
        lastError = `${hostLabel(url)}: no ${prefix} memo instruction found in the transaction`;
        continue;
      }
      const fields = parseMemo(memo) ?? undefined;
      return { chainReadable: true, memoDecoded: true, memo, fields, viaEndpoint: hostLabel(url) };
    } catch (e) {
      lastError = `${hostLabel(url)}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  // A provider answered but nothing matched => the chain IS readable, we just cannot confirm the memo (memoDecoded false).
  // No provider answered => chainReadable false; the caller must not claim anything.
  return { chainReadable: reachedOne, memoDecoded: false, error: lastError || "no endpoint produced a matching memo" };
}

/** Structured comparison of a chain read against the values OUR served bundle + ledger currently assert. */
export interface AnchorComparison {
  /** The chain was reachable and a matching memo was decoded -- only then are the matches below meaningful. */
  verifiable: boolean;
  chainReadable: boolean;
  memoDecoded: boolean;
  memo?: string;
  onChain?: MemoFields;
  /** on-chain bundleHash == the bundleHash our LEDGER claims we sealed for this signature (ledger integrity). */
  ledgerBundleMatch: boolean;
  /** on-chain bundleHash == the bundleHash of the manifest we serve NOW (the anchor-stamp invariant). */
  anchorCoversCurrentBundle: boolean;
  /** on-chain memo carries a scienceHash field at all (a legacy 3-field memo does not). */
  scienceCompareAvailable: boolean;
  legacyMemo: boolean;
  /** on-chain scienceHash == the scienceHash of the bundle we serve NOW. Undefined when not comparable. */
  scienceHashMatch?: boolean;
  /** DEFINITE drift: the chain sealed a different scienceHash than the science we serve now. */
  anchoredScienceDrift: boolean;
  /** on-chain findingId == the id being looked up (a memo for a different finding would be a mismatch). */
  findingIdMatch: boolean;
  viaEndpoint?: string;
  error?: string;
}

/**
 * Compare a ChainMemoRead against expected values computed by the caller from live data. Pure and total: an
 * unreadable/undecoded chain read yields an all-false comparison with verifiable=false, so a caller can never
 * accidentally render an unverifiable anchor as a match.
 */
export function compareAnchor(
  read: ChainMemoRead,
  expected: {
    findingId: string;
    ledgerBundleHash?: string;
    currentBundleHash?: string;
    currentScienceHash?: string;
  }
): AnchorComparison {
  const base: AnchorComparison = {
    verifiable: false,
    chainReadable: read.chainReadable,
    memoDecoded: read.memoDecoded,
    memo: read.memo,
    onChain: read.fields,
    ledgerBundleMatch: false,
    anchorCoversCurrentBundle: false,
    scienceCompareAvailable: false,
    legacyMemo: false,
    scienceHashMatch: undefined,
    anchoredScienceDrift: false,
    findingIdMatch: false,
    viaEndpoint: read.viaEndpoint,
    error: read.error
  };
  if (!read.memoDecoded || !read.fields) return base;
  const f = read.fields;

  const findingIdMatch = f.findingId === expected.findingId;
  const ledgerBundleMatch = expected.ledgerBundleHash != null && f.bundleHash === expected.ledgerBundleHash;
  const anchorCoversCurrentBundle = expected.currentBundleHash != null && f.bundleHash === expected.currentBundleHash;
  const scienceCompareAvailable = f.scienceHash != null;
  const legacyMemo = f.scienceHash == null;
  const scienceHashMatch = scienceCompareAvailable && expected.currentScienceHash != null ? f.scienceHash === expected.currentScienceHash : undefined;
  // Drift only when BOTH sides carry a scienceHash and they differ -- a legacy memo (no field) is "unknown", not drift.
  const anchoredScienceDrift = scienceHashMatch === false;

  return {
    ...base,
    verifiable: true,
    findingIdMatch,
    ledgerBundleMatch,
    anchorCoversCurrentBundle,
    scienceCompareAvailable,
    legacyMemo,
    scienceHashMatch,
    anchoredScienceDrift
  };
}

/** Race a promise against a timeout so one hung RPC cannot pin a Worker request open. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`rpc timeout after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
