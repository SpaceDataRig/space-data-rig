// P25 -- OBSERVATION EVIDENCE, LOCAL VERIFIER CLI (named-observation feature, the trustless check).
//
// Re-proves a sealed, commissioned observation WITHOUT trusting our storage or the front-end: it re-reads the
// stored record, RE-COMPUTES the envelope hash from the dedication + science bundle hash (any edit to either is
// caught), then verifies the sdr:observe:1 anchor straight from Solana mainnet. Prints a plain PASS/FAIL evidence
// table. Reads the record from the local fs store (out/observations/...); point it at the edge store by hitting
// /api/observe/evidence instead if you are verifying a production record.
//
// Run:  npm run p25:observe-evidence -- --hash=<64-hex envelope hash>
//       npm run p25:observe-evidence -- --sig=<burn tx signature>
//       (add --rpc=<url> to pin a specific RPC; otherwise uses .env SOLANA_RPC then public mainnet)
// Exit code: 0 = authentic, 1 = failed/missing. Safe to use in the one-click gate.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "../src/node/artifact-store.ts";
import { verifyObserveAnchor, loadLocalEnv } from "../src/solana/anchor.ts";
import { buildObservationEvidence } from "../src/observe/evidence.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(REPO_ROOT, "out");

function arg(name: string, def = ""): string {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const hash = arg("hash");
  const sig = arg("sig");
  if (!hash && !sig) {
    console.log(`[p25] usage: --hash=<envelope hash>  or  --sig=<burn tx signature>`);
    console.log(`\nVERDICT: BAD-ARGS`);
    process.exit(1);
  }
  const store = new FsArtifactStore(OUT_DIR);
  const verify = async (anchorSignature: string, envelopeHash: string) => verifyObserveAnchor(anchorSignature, envelopeHash);
  const ev = await buildObservationEvidence(store, { hash: hash || undefined, sig: sig || undefined }, verify);

  console.log(`[p25] envelope hash : ${ev.envelopeHash ?? "(unresolved)"}`);
  if (ev.status !== 200) {
    console.log(`[p25] ${ev.reason ?? "no evidence"}`);
    console.log(`\nVERDICT: NO-EVIDENCE`);
    process.exit(1);
  }

  const rec = (ev.record ?? {}) as Record<string, unknown>;
  const sci = (rec.science ?? {}) as Record<string, unknown>;
  console.log(`[p25] dedication    : "${String(rec.dedication ?? "")}"`);
  console.log(`[p25] verdict       : ${String(sci.verdict ?? "?")} (discovery claim: ${rec.discoveryClaim === false ? "false" : "UNEXPECTED"})`);
  console.log(`[p25] integrity     : ${ev.integrityMatches ? "OK - recomputed envelope hash matches" : "FAIL - recomputed hash differs (record was tampered or bundleHash moved)"}`);
  if (ev.verify) {
    const v = ev.verify;
    console.log(`[p25] on-chain      : ${v.ok ? "VERIFIED - memo hash matches" : v.found ? "MISMATCH - found but memo does not match" : "not found on any RPC yet"}`);
  } else {
    console.log(`[p25] on-chain      : (no anchor signature on record - sealed off-chain only)`);
  }
  if (ev.explorerUrl) console.log(`[p25] explorer      : ${ev.explorerUrl}`);

  const pass = !!ev.ok;
  console.log(`\nVERDICT: ${pass ? "OBSERVATION-AUTHENTIC" : "OBSERVATION-FAILED"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`[p25] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
