// Anchor reproducible finding bundles on Solana mainnet.
//
//   npm run anchor                       # anchor all accepted findings
//   npm run anchor -- --dry-run          # build memos, send nothing (offline)
//   npm run anchor -- --all              # include watchlist/rejected too
//   npm run anchor -- --finding F-pi-Men-c
//   npm run anchor -- --verify           # re-read chain, confirm hashes are on-chain
//   npm run anchor -- --keypair out/funded-id.json   # use an already-funded wallet
//
// Reads the pipeline snapshot (out/state/rig.json), writes each bundle hash into
// an SPL Memo transaction, then updates the finding's solanaTx and the local
// ledger (out/ledger.json). The ledger works even when the chain is unreachable
// (entries stay "pending"/"failed"), so the dashboard always shows true state.

import { resolve } from "node:path";
import { RigStore } from "../src/core/store.ts";
import {
  anchorBundleHash,
  verifyAnchor,
  upsertLedger,
  readLedger,
  explorerUrl,
  buildMemo,
  type LedgerEntry,
} from "../src/solana/anchor.ts";

interface Args {
  dryRun: boolean;
  verify: boolean;
  all: boolean;
  finding?: string;
  rpc?: string;
  keypair?: string;
  snapshot: string;
  ledger: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    verify: false,
    all: false,
    snapshot: resolve("out/state/rig.json"),
    ledger: resolve("out/ledger.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case "--dry-run": a.dryRun = true; break;
      case "--verify": a.verify = true; break;
      case "--all": a.all = true; break;
      case "--finding": a.finding = argv[++i]; break;
      case "--rpc": a.rpc = argv[++i]; break;
      case "--keypair": a.keypair = resolve(argv[++i]); break;
      case "--snapshot": a.snapshot = resolve(argv[++i]); break;
      case "--ledger": a.ledger = resolve(argv[++i]); break;
      case "-h":
      case "--help":
        console.log("Usage: npm run anchor -- [--dry-run] [--verify] [--all] [--finding ID] [--rpc URL] [--keypair PATH] [--snapshot PATH] [--ledger PATH]");
        process.exit(0);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("\n=== Space Data Rig :: P2 Solana mainnet anchoring ===\n");

  const store = new RigStore();
  const loaded = store.load(args.snapshot);
  if (!loaded) {
    console.log(`No snapshot at ${args.snapshot}. Run 'npm run orchestrator' first.\n`);
    return;
  }
  console.log(`Loaded snapshot ${args.snapshot} (run ${store.runId}).`);

  let findings = store.listFindings();
  if (args.finding) findings = findings.filter((f) => f.id === args.finding);
  else if (!args.all) findings = findings.filter((f) => f.verdict === "accepted");

  const withHash = findings.filter((f) => f.bundleHash);
  if (!withHash.length) {
    console.log("No findings with a bundle hash to anchor.\n");
    return;
  }
  console.log(`${withHash.length} finding(s) to ${args.verify ? "verify" : args.dryRun ? "preview (dry-run)" : "anchor"}.\n`);

  let nOk = 0;
  for (const f of withHash) {
    const hash = f.bundleHash!;
    if (args.verify) {
      if (!f.solanaTx) {
        console.log(`[skip ] ${f.id.padEnd(16)} not anchored yet (no signature).`);
        continue;
      }
      const v = await verifyAnchor(f.solanaTx, hash, args.rpc);
      console.log(`[${v.ok ? " OK  " : "FAIL "}] ${f.id.padEnd(16)} memo on-chain matches hash: ${v.memoMatches}${v.error ? " (" + v.error + ")" : ""}`);
      if (v.ok) nOk++;
      continue;
    }

    const res = await anchorBundleHash(f.id, hash, { rpcUrl: args.rpc, keypairPath: args.keypair, dryRun: args.dryRun });
    if (args.dryRun) {
      console.log(`[dry  ] ${f.id.padEnd(16)} memo="${res.memo}"`);
      nOk++;
      continue;
    }

    const entry: LedgerEntry = {
      findingId: f.id,
      bundleHash: hash,
      memo: res.memo,
      status: res.ok ? "anchored" : "failed",
      signature: res.signature,
      slot: res.slot,
      publicKey: res.publicKey,
      explorerUrl: res.signature ? explorerUrl(res.signature) : undefined,
      error: res.error,
      anchoredAt: res.ok ? new Date().toISOString() : undefined,
    };
    upsertLedger(args.ledger, entry);
    if (res.ok && res.signature) {
      store.updateFinding(f.id, { solanaTx: res.signature });
      store.updateBundle(f.id, { solanaTx: res.signature });
      nOk++;
      console.log(`[anchr] ${f.id.padEnd(16)} tx=${res.signature.slice(0, 20)}... slot=${res.slot}`);
      console.log(`        ${entry.explorerUrl}`);
    } else {
      console.log(`[fail ] ${f.id.padEnd(16)} ${res.error ?? "unknown error"}`);
      console.log(`        (bundle hash is still valid off-chain: ${hash.slice(0, 16)}...)`);
    }
  }

  if (!args.dryRun && !args.verify) store.save(args.snapshot);

  const ledger = readLedger(args.ledger);
  const anchored = ledger.filter((e) => e.status === "anchored").length;
  console.log(`\nDone: ${nOk} succeeded. Ledger ${args.ledger} has ${anchored}/${ledger.length} anchored.`);
  if (args.dryRun) console.log(`(dry-run: example memo -> ${buildMemo(withHash[0].id, withHash[0].bundleHash!)})`);
  console.log("");
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
