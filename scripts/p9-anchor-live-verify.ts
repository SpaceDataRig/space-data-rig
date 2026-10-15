// P9 live anchor verification (audit-10 #9): a real, KEYLESS integration test for the money-adjacent SEND
// path. The rig anchors bundle hashes on Solana mainnet, but the unit suite never touches the chain. This
// script re-reads the most recent anchors STRAIGHT FROM THE CHAIN with verifyOnEndpoints (which decodes the
// SPL memo and confirms it contains the expected bundle hash) -- a read-only proof that recent anchors really
// landed and still match. It uses NO fee payer, NO secret, and sends NOTHING: it can only read.
//
// It is deliberately NOT part of `npm test` (the unit suite must stay network-free and deterministic). It runs
// on a schedule via .github/workflows/anchor-verify.yml (and can be run manually). A FAIL means a recent
// on-chain anchor no longer verifies (memo mismatch, or not found on any endpoint) -- investigate the send
// path. discoveryClaim false; reads only, changes no verdict / bundle hash / ledger / money state.
//
// Usage: npm run p9:anchor-verify [-- --url https://spacedatarig.app/api/ledger --count 5 --rpc <optional keyless RPC>]

import { verifyOnEndpoints, endpointList, DEFAULT_RPC } from "../src/solana/anchor-core.ts";
import type { LedgerEntry } from "../src/core/state-types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

async function main(): Promise<void> {
  const ledgerUrl = arg("url", "https://spacedatarig.app/api/ledger");
  const count = Math.max(1, Math.round(Number(arg("count", "5"))));
  const rpc = arg("rpc", "").trim();
  // Read-only endpoint list: an optional operator keyless RPC first, else the public mainnet default.
  const endpoints = rpc ? [rpc, DEFAULT_RPC] : endpointList(undefined, undefined, undefined, [DEFAULT_RPC]);
  console.log(`P9 live anchor verification (READ-ONLY, keyless, no spend). ledger=${ledgerUrl} endpoints=${endpoints.length} count=${count}`);

  let ledger: LedgerEntry[];
  try {
    const res = await fetch(ledgerUrl, { headers: { accept: "application/json" } });
    if (!res.ok) { console.log(`VERDICT: INCONCLUSIVE-NETWORK -- ledger fetch returned ${res.status}`); process.exitCode = 2; return; }
    const data = (await res.json()) as { ledger?: LedgerEntry[] };
    ledger = Array.isArray(data.ledger) ? data.ledger : [];
  } catch (e) {
    console.log(`VERDICT: INCONCLUSIVE-NETWORK -- could not read the ledger: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 2; return;
  }

  const anchored = ledger.filter((e) => e.status === "anchored" && e.signature && e.bundleHash).slice(0, count);
  if (!anchored.length) {
    console.log(`VERDICT: NO-ANCHORS -- the ledger has no anchored entries to verify (${ledger.length} rows). Nothing to prove; not a failure.`);
    process.exitCode = 0; return;
  }

  let fails = 0;
  for (const e of anchored) {
    const v = await verifyOnEndpoints(endpoints, e.signature!, e.bundleHash!);
    const state = v.ok ? "OK" : v.found ? "MEMO-MISMATCH" : "NOT-FOUND";
    console.log(`  ${e.findingId.padEnd(18)} ${state.padEnd(14)} bundle ${e.bundleHash!.slice(0, 12)}...  sig ${e.signature!.slice(0, 14)}...`);
    if (!v.ok) fails++;
  }

  if (fails === 0) {
    console.log(`VERDICT: PASS -- ${anchored.length} most-recent mainnet anchors independently re-verified straight from the chain (read-only, keyless).`);
    process.exitCode = 0;
  } else {
    console.log(`VERDICT: FAIL -- ${fails}/${anchored.length} recent anchors did NOT verify on-chain (memo mismatch or not indexed on any endpoint). Investigate the anchor send path.`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`[p9] error: ${e instanceof Error ? e.message : e}`); console.log("VERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 2; });
