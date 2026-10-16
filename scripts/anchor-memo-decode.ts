// audit-3 live end-to-end verifier (READ-ONLY, no token, no spend).
//
// The third-round audit caught that scienceHash was computed but never reached the chain, and decoded
// on-chain memos to prove it. This is the mirror-image tool: pull the public /api/ledger, re-read each
// anchor's ACTUAL Solana-mainnet transaction (jsonParsed), decode the SPL Memo instruction string, and
// report the real field count the chain carries -- independent of what our own database claims.
//
// It proves two things separately: (1) the decode path works against the live chain (baseline: pre-deploy
// anchors show 3 fields), and (2) once a post-deploy anchor exists, it shows 4 fields (sdr:1|id|bundleHash|scienceHash).
// Also cross-checks memo position 2 against the ledger's bundleHash (the anchor-stamp invariant).
//
// Usage: npm run p9:decode-memo            (decode the most recent anchored rows)
//        npm run p9:decode-memo -- --limit 8
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LEDGER_URL = process.env.RIG_LEDGER_URL || "https://spacedatarig.app/api/ledger";
const RPC = process.env.SOLANA_RPC_READONLY || "https://api.mainnet-beta.solana.com";

interface LedgerRow { findingId: string; bundleHash: string; status: string; signature?: string; memo?: string; anchoredAt?: string }

// Pull the memo string out of a jsonParsed transaction (the SPL Memo instruction, parsed type "string").
function extractMemo(txResult: any): { memo: string; found: boolean; err?: string } {
  const instrs: any[] = txResult?.transaction?.message?.instructions ?? [];
  for (const ix of instrs) {
    const isMemo = ix?.program === "spl-memo" || ix?.programId === MEMO_PROGRAM;
    if (!isMemo) continue;
    // jsonParsed renders an SPL Memo as ix.parsed == the memo STRING directly; older shapes use {info}/{info.memo}.
    const p = ix?.parsed;
    const memo = typeof p === "string" ? p : (typeof p?.info === "string" ? p.info : (typeof p?.info?.memo === "string" ? p.info.memo : ""));
    if (memo) return { memo, found: true };
  }
  return { memo: "", found: false, err: "no spl-memo instruction found" };
}

async function fetchMemo(sig: string): Promise<{ memo: string; found: boolean; err?: string }> {
  const body = { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] };
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; space-data-rig anchor-memo-decode)" }, body: JSON.stringify(body) });
  if (!r.ok) return { memo: "", found: false, err: `RPC HTTP ${r.status}` };
  const j: any = await r.json();
  if (j?.error) return { memo: "", found: false, err: `RPC error: ${j.error.message ?? "unknown"}` };
  if (!j?.result) return { memo: "", found: false, err: "tx not yet visible on this RPC (try again or a different endpoint)" };
  return extractMemo(j.result);
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 5;
  const res = await fetch(LEDGER_URL, { headers: { "user-agent": "Mozilla/5.0 (compatible; space-data-rig anchor-memo-decode)" } });
  if (!res.ok) { console.error(`ledger HTTP ${res.status}`); process.exitCode = 1; return; }
  const ledger = ((await res.json()).ledger as LedgerRow[]).filter((e) => e.status === "anchored" && e.signature);
  // Sort by anchoredAt descending ourselves (do not rely on the endpoint's ordering) so the NEWEST
  // anchors -- where a post-deploy 4-field memo would first appear -- are always at the front.
  const recent = ledger
    .slice()
    .sort((a, b) => (b.anchoredAt ?? "").localeCompare(a.anchoredAt ?? ""))
    .slice(0, limit);
  console.log(`decoding ${recent.length} most-recent anchored rows from the live chain via ${RPC}`);
  console.log("(READ-ONLY: re-reads mainnet memos, spends nothing, needs no admin token)\n");
  let four = 0, three = 0, errs = 0;
  for (const e of recent) {
    const { memo, found, err } = await fetchMemo(e.signature!);
    if (!found) { errs++; console.log(`  ${e.findingId.padEnd(18)} DECODE-ERR  ${err}`); continue; }
    const fields = memo.split("|").length;
    const hasSci = fields >= 4;
    const pos2ok = memo.split("|")[2] === e.bundleHash; // anchor-stamp invariant: position 2 is the bundleHash
    if (hasSci) four++; else three++;
    const tag = hasSci ? "4-FIELD (scienceHash on-chain)" : "3-field (legacy)";
    console.log(`  ${e.findingId.padEnd(18)} ${String(fields)} fields  ${tag}  bundleHash@2=${pos2ok ? "match" : "MISMATCH"}  anchoredAt=${e.anchoredAt ?? "?"}`);
    console.log(`      ${memo.slice(0, 96)}${memo.length > 96 ? "..." : ""}`);
  }
  console.log(`\nSUMMARY: ${four} four-field, ${three} three-field, ${errs} decode-errors (of ${recent.length} recent).`);
  if (errs === recent.length) { console.error("all decodes failed -- likely a public-RPC rate limit; re-run or set SOLANA_RPC_READONLY."); process.exitCode = 2; }
}

main().catch((e) => { console.error(`[anchor-memo-decode] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
