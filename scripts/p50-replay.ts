// P50: end-to-end DETERMINISTIC REPLAY on real public S3 bytes (validation roadmap, priority 6).
//
// We download the raw TESS-SPOC FITS bytes for one real target from the public S3 bucket, run the FULL
// deterministic detection chain (parse -> canonical data hash -> iterativeBls under the production gate ->
// recovered candidate), and fold ONLY the reproducible ingredients into a replay record
// (src/sim/replay.ts). Then we prove determinism two ways:
//   (1) IN-PROCESS: run the whole chain N times on the same bytes and confirm the replay hash is identical
//       every time (the chain is a pure function of its inputs -- no hidden randomness or wall-clock).
//   (2) RE-DOWNLOAD: fetch the bytes again from the archive and confirm the byte SHA-256, the data hash,
//       and the replay hash all match (public input provenance is stable, so an auditor re-fetching the
//       same S3 key reproduces our exact number).
// The emitted replay manifest is self-describing (S3 key, byte sha, params, candidate, replay hash) so a
// third party can feed the same bytes through the same code and independently recompute the hash. Research
// probe: no worker import, no verdict/bundle hash/money path, nothing anchored/claimed/deployed.
//
// Run:  npm run p50:replay  [-- --repeats 3 --tmag 10 --sector 1]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { computeDataHash } from "../src/seats/seats.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { sha256Bytes } from "../src/bundle/bundle.ts";
import { buildReplayRecord, replayHash, verifyReplay, type ReplayInput } from "../src/sim/replay.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const repeats = Math.max(2, parseInt(arg("repeats", "3"), 10));
const tmagCap = Number(arg("tmag", "10"));
const sectorPref = Number(arg("sector", "1"));
const CODE_VERSION = "p50-replay";
const PARAMS = { minPeriodDays: 1, maxPeriodDays: 15, maxSignals: 3 };

/** Run the deterministic chain on raw bytes and return the data hash, candidate, and replay hash. */
async function runChain(bytes: Uint8Array, name: string): Promise<{ dataHash: string; candidate: ReplayInput["candidate"]; lc: LightCurve }> {
  const lc = fitsToLightCurve(bytes, name);
  const dataHash = await computeDataHash(lc);
  const it = iterativeBls(lc, PARAMS);
  const s = it.signals[0];
  const candidate: ReplayInput["candidate"] = s
    ? {
        periodDays: +s.periodDays.toFixed(6),
        epochBjd: +s.epochBjd.toFixed(6),
        durationHours: +(s.durationDays * 24).toFixed(6),
        depthFrac: +s.depth.toFixed(8),
        snr: +s.snr.toFixed(6),
        verdict: classifyDepthRegime(s.depthPpm).planetPlausible ? "candidate" : "below-threshold",
      }
    : { periodDays: 0, epochBjd: 0, durationHours: 0, depthFrac: 0, snr: 0, verdict: "no-signal" };
  return { dataHash, candidate, lc };
}

async function main(): Promise<void> {
  console.log(`P50 end-to-end deterministic replay: fetch real SPOC bytes, run the chain ${repeats}x in-process + 1 re-download, assert identical replay hash.`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 400 })).planets
    .filter((p) => p.tic != null && Number.isFinite(p.tic));

  // find the first host with a usable public SPOC curve in the preferred sector (else scan a few)
  let target: { tic: number; sector: number; name: string; bytes: Uint8Array } | null = null;
  for (const p of planets) {
    for (const s of [sectorPref, sectorPref + 1, sectorPref + 27]) {
      try {
        const bytes = await fetchSpocBytes(resolveSpocKey(p.tic!, s, "lc"), { timeoutMs: 20000 });
        if (!bytes) continue;
        const lc = fitsToLightCurve(bytes, p.hostname ?? `TIC ${p.tic}`);
        if (lc.points.length < 200) continue;
        target = { tic: p.tic!, sector: s, name: p.hostname ?? `TIC ${p.tic}`, bytes };
        break;
      } catch { /* try next */ }
    }
    if (target) break;
  }
  if (!target) {
    console.log(`\nNo usable public SPOC curve fetched (network/coverage).`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }
  const s3Key = resolveSpocKey(target.tic, target.sector, "lc");
  const byteHash = await sha256Bytes(target.bytes);
  console.log(`  target: ${target.name} (TIC ${target.tic}, sector ${target.sector}); key=${s3Key}; bytes=${target.bytes.length}; sha256=${byteHash.slice(0, 16)}...`);

  // (1) in-process repeats
  const hashes: string[] = [];
  let firstRecord: ReplayInput | null = null;
  for (let r = 0; r < repeats; r++) {
    const { dataHash, candidate } = await runChain(target.bytes, target.name);
    const record = buildReplayRecord({ dataHash, codeVersion: CODE_VERSION, algorithm: "iterativeBls", params: PARAMS, candidate });
    hashes.push(await replayHash(record));
    if (!firstRecord) firstRecord = { dataHash, codeVersion: CODE_VERSION, algorithm: "iterativeBls", params: PARAMS, candidate };
  }
  const inProcessStable = hashes.every((h) => h === hashes[0]);

  // (2) re-download the same S3 key and replay
  const bytes2 = await fetchSpocBytes(s3Key, { timeoutMs: 20000 });
  let reDownloadMatch = false;
  let byteHash2 = "";
  let replayHash2 = "";
  if (bytes2) {
    byteHash2 = await sha256Bytes(bytes2);
    const { dataHash, candidate } = await runChain(bytes2, target.name);
    const rec2 = buildReplayRecord({ dataHash, codeVersion: CODE_VERSION, algorithm: "iterativeBls", params: PARAMS, candidate });
    replayHash2 = await replayHash(rec2);
    reDownloadMatch = byteHash2 === byteHash && replayHash2 === hashes[0];
  }

  const replayRecord = buildReplayRecord(firstRecord!);
  const ok = await verifyReplay(replayRecord, hashes[0]);

  console.log(`\n=== P50 REPLAY SUMMARY ===`);
  console.log(`  replay hash (run 1)          : ${hashes[0].slice(0, 16)}...`);
  console.log(`  in-process ${repeats}x identical : ${inProcessStable ? "YES" : "NO"}`);
  console.log(`  re-download byte sha match   : ${byteHash2 === byteHash ? "YES" : "NO"}`);
  console.log(`  re-download replay hash match: ${reDownloadMatch ? "YES" : "NO"}`);
  console.log(`  independent recompute ok     : ${ok ? "YES" : "NO"}`);
  console.log(`  recovered candidate          : ${JSON.stringify(firstRecord!.candidate)}`);

  const allDeterministic = inProcessStable && reDownloadMatch && ok;
  const json = {
    meta: {
      generatedBy: "scripts/p50-replay.ts",
      protocol: "end-to-end deterministic replay from raw public S3 bytes",
      chain: "fetchSpocBytes -> fitsToLightCurve -> computeDataHash -> iterativeBls(production gate) -> replay record",
      repeats,
    },
    target: { name: target.name, tic: target.tic, sector: target.sector, s3Key, byteSha256: byteHash, byteLength: target.bytes.length },
    replayRecord,
    replayHash: hashes[0],
    inProcessStable,
    reDownloadByteShaMatch: byteHash2 === byteHash,
    reDownloadReplayHashMatch: reDownloadMatch,
    independentRecomputeOk: ok,
    allDeterministic: allDeterministic,
    discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p50-replay.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P50 end-to-end deterministic replay on real public bytes",
    "",
    `Reproduce: \`npm run p50:replay -- --repeats ${repeats} --tmag ${tmagCap} --sector ${sectorPref}\``,
    "",
    "We fetched the raw TESS-SPOC FITS bytes for one real target from the public S3 bucket, ran the full",
    "detection chain (parse -> canonical data hash -> iterativeBls under the production gate -> recovered",
    "candidate), and folded only the reproducible ingredients into a replay record (src/sim/replay.ts).",
    "",
    `Target: **${target.name}** (TIC ${target.tic}, sector ${target.sector}), \`${s3Key}\`, ${target.bytes.length} bytes.`,
    "",
    "| determinism check | result |",
    "|---|---|",
    `| replay hash | \`${hashes[0]}\` |`,
    `| ${repeats} in-process runs identical | ${inProcessStable ? "YES" : "NO"} |`,
    `| re-download byte SHA-256 matches | ${byteHash2 === byteHash ? "YES" : "NO"} |`,
    `| re-download replay hash matches | ${reDownloadMatch ? "YES" : "NO"} |`,
    `| independent recompute verifies | ${ok ? "YES" : "NO"} |`,
    "",
    `Recovered candidate: \`${JSON.stringify(firstRecord!.candidate)}\`.`,
    "",
    allDeterministic
      ? "The detection chain is a pure function of its public inputs: the same S3 bytes produce the same" +
        " replay hash every time, in-process and after a fresh download. An auditor with the S3 key and this" +
        " record can recompute the exact number independently -- the basis for third-party verification."
      : "Determinism did NOT fully hold on this run; investigate before trusting replay (reported honestly).",
    "",
    "Research-only audit artifact; no verdict/bundle-hash/money-path change; nothing anchored, claimed, or",
    "deployed. `discoveryClaim: false`.",
    "",
  ];
  writeFileSync("reports/p50-replay.md", md.join("\n"));
  console.log("\nwrote reports/p50-replay.md and reports/p50-replay.json");
  console.log(`\nVERDICT: ${allDeterministic ? "P50-REPLAY-DETERMINISTIC" : "P50-REPLAY-NONDETERMINISTIC"}`);
}

main().catch((e) => {
  console.error("p50 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 1;
});
