// P55: publish a self-contained, third-party-verifiable REPLAY MANIFEST for the finding that P50
// proved deterministic (roadmap priority 5). P50 showed the detection chain is a pure function of its
// public inputs; this turns that proof into a single JSON artifact anyone can audit WITHOUT our code:
// fetch the named public S3 object, check its SHA-256, run the documented detector + params, and
// compare the replay hash. The manifest is derived entirely from the committed reports/p50-replay.json
// (no new measurement), and we cross-check that the manifest's replay hash equals the hash P50 already
// committed -- so the published artifact provably reproduces the audited number. Pure provenance: it
// gates nothing and changes no verdict / bundle hash / money path.
//
// Usage:
//   npm run p55:replay-manifest
import { readFileSync, writeFileSync } from "node:fs";
import { buildReplayManifest, verifyManifest, type ReplayRecord } from "../src/sim/replay.ts";

interface P50 {
  target: { name: string; tic: number; sector: number; s3Key: string; byteSha256: string; byteLength: number };
  replayRecord: ReplayRecord;
  replayHash: string;
  allDeterministic: boolean;
}

async function main() {
  const p50 = JSON.parse(readFileSync("reports/p50-replay.json", "utf8")) as P50;
  if (!p50.allDeterministic) {
    console.error("P50 did not certify determinism; refusing to publish a manifest from it.");
    process.exitCode = 1;
    return;
  }
  const manifest = await buildReplayManifest(
    { name: p50.target.name, tic: p50.target.tic, sector: p50.target.sector },
    { bucket: "stpubdata", key: p50.target.s3Key, expectedByteSha256: p50.target.byteSha256, byteLength: p50.target.byteLength },
    p50.replayRecord,
  );

  const selfConsistent = await verifyManifest(manifest);
  const matchesCommitted = manifest.replayHash === p50.replayHash;
  console.log(`P55 replay manifest for ${p50.target.name} (TIC ${p50.target.tic}, sector ${p50.target.sector})`);
  console.log(`  manifest replayHash : ${manifest.replayHash}`);
  console.log(`  P50 committed hash  : ${p50.replayHash}`);
  console.log(`  self-consistent     : ${selfConsistent}`);
  console.log(`  matches P50         : ${matchesCommitted}`);
  console.log(`  fetch URL           : ${manifest.retrieval.url}`);
  console.log(`  VERDICT: ${selfConsistent && matchesCommitted ? "P55-MANIFEST-VERIFIED" : "P55-MANIFEST-MISMATCH"}`);

  writeFileSync("web/replay-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log("\nwrote web/replay-manifest.json");
  if (!(selfConsistent && matchesCommitted)) process.exitCode = 1;
}

main().catch((e) => {
  console.error("p55 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
