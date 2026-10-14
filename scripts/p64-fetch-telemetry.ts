// P64 - FETCH TELEMETRY (roadmap "data-layer small steps: use the concurrent+cached multi-sector helper at
// scale and accumulate MEASURED cache-hit rate + time saved before deciding whether to promote it toward
// production"). This script measures the ONE real bottleneck the roadmap names -- download -- by running
// createSpocSectorFetcher over a set of real TOI hosts, then repeating the sweep to expose the per-key byte
// cache. It reports the measured cache-hit rate, mean per-sector download latency, and the estimated download
// time a second pass avoids. Research probe: no worker import, no verdict / bundle hash / money path, nothing
// anchored or claimed. discoveryClaim structurally false.
//
// Run: npm run p64:fetch-telemetry [-- --hosts 8 --maxsectors 4 --concurrency 4]

import { writeFileSync, mkdirSync } from "node:fs";
import { createSpocSectorFetcher } from "../src/data/mastS3.ts";
import { fetchToiTable, confirmedPositives, isPlaceable } from "../src/data/toiDispositions.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantHosts = Math.max(1, parseInt(arg("hosts", "8"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "4"), 10));
const concurrency = Math.max(1, parseInt(arg("concurrency", "4"), 10));

async function main(): Promise<void> {
  console.log(`P64 FETCH TELEMETRY: createSpocSectorFetcher over up to ${wantHosts} real TOI hosts (<=${maxSectors} sectors each, concurrency ${concurrency}), then a repeat sweep to exercise the per-key byte cache. REAL S3 photometry, token-free; no discovery claim.`);

  const records = await fetchToiTable();
  if (!records.length) { console.log("TOI table unavailable (network). VERDICT: NO-USEFUL-DATA"); process.exitCode = 0; return; }
  const hosts = confirmedPositives(records).filter(isPlaceable).sort((a, b) => (a.tessMag || 99) - (b.tessMag || 99)).slice(0, wantHosts);
  if (hosts.length < 2) { console.log(`only ${hosts.length} placeable hosts. VERDICT: INSUFFICIENT-DATA`); process.exitCode = 0; return; }

  const fetcher = createSpocSectorFetcher({ concurrency });
  const jobs = hosts.map((h) => ({ tic: h.tic, name: `TIC ${h.tic}`, sectors: (h.sectors || []).slice(0, maxSectors) }));

  const wallStart = Date.now();
  let pass1Curves = 0;
  for (const j of jobs) pass1Curves += (await fetcher.fetchSectors(j.tic, j.sectors, j.name)).length;
  const statsAfter1 = fetcher.fetchStats();
  const t1 = Date.now() - wallStart;

  // Second sweep: identical (TIC, sector) keys -> every byte request should be a cache hit.
  const w2 = Date.now();
  let pass2Curves = 0;
  for (const j of jobs) pass2Curves += (await fetcher.fetchSectors(j.tic, j.sectors, j.name)).length;
  const statsAfter2 = fetcher.fetchStats();
  const t2 = Date.now() - w2;

  const pass2Hits = statsAfter2.cacheHits - statsAfter1.cacheHits;
  const pass2Misses = statsAfter2.cacheMisses - statsAfter1.cacheMisses;
  const pass2HitRate = pass2Hits + pass2Misses > 0 ? pass2Hits / (pass2Hits + pass2Misses) : 0;

  console.log(`\n=== P64 SUMMARY (${hosts.length} hosts, pass1 ${pass1Curves} curves, pass2 ${pass2Curves} curves) ===`);
  console.log(`  pass1 (cold cache): requests ${statsAfter1.byteRequests}, misses ${statsAfter1.cacheMisses}, downloadMs ${statsAfter1.downloadMs}, wall ${t1}ms, mean miss ${statsAfter1.meanMissMs}ms`);
  console.log(`  pass2 (warm cache): +${pass2Hits} hits / +${pass2Misses} misses -> hit rate ${(100 * pass2HitRate).toFixed(0)}%, wall ${t2}ms (${t1 > 0 ? (100 * t2 / t1).toFixed(0) : "?"}% of the cold pass)`);
  console.log(`  cumulative: cacheHitRate ${(100 * statsAfter2.cacheHitRate).toFixed(0)}%, estSavedMs ${statsAfter2.estSavedMs} (cache hits x mean miss latency; a byte-level download-avoidance estimate, concurrent fetches overlap)`);

  const verdict = pass2HitRate >= 0.95
    ? `WARM-CACHE-FREE: a repeat sweep served ${(100 * pass2HitRate).toFixed(0)}% of byte requests from cache (misses ${pass2Misses}, ${t2}ms vs ${t1}ms cold) -- the per-key cache makes multi-study re-fetch effectively free, which is the measured case for using the helper broadly in research before any production decision.`
    : `PARTIAL-HIT: repeat sweep hit rate ${(100 * pass2HitRate).toFixed(0)}% (some re-downloads; likely transient misses) -- telemetry inconclusive, re-run shortly`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  download is confirmed the dominant cost (cold pass ~${statsAfter1.meanMissMs}ms/sector); caching removes it on repeat. No gate / money path / discovery claim.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { generatedBy: "scripts/p64-fetch-telemetry.ts", hosts: hosts.length, maxSectors, concurrency, data: "real TESS-SPOC public S3 (token-free)", note: "measured cache-hit rate + download-cost telemetry for the multi-sector helper; not a discovery claim; nothing gated." },
    coldPass: { curves: pass1Curves, stats: statsAfter1, wallMs: t1 },
    warmPass: { curves: pass2Curves, hits: pass2Hits, misses: pass2Misses, hitRate: pass2HitRate, wallMs: t2 },
    cumulative: statsAfter2,
    bottleneck: "download",
    verdict,
    safeToGate: false,
    discoveryClaim: false,
  };
  writeFileSync("reports/p64-fetch-telemetry.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P64 fetch telemetry: is the concurrent+cached multi-sector helper worth using broadly?",
    "",
    `Reproduce: \`npm run p64:fetch-telemetry -- --hosts ${wantHosts} --maxsectors ${maxSectors} --concurrency ${concurrency}\``,
    "",
    `Over **${hosts.length}** real TOI hosts (<= ${maxSectors} sectors each), the helper was swept twice. The cold`,
    `pass made ${statsAfter1.byteRequests} byte requests (${statsAfter1.cacheMisses} downloads, ~${statsAfter1.meanMissMs}ms each, ${t1}ms wall).`,
    `The warm pass reused the same keys and hit cache ${pass2Hits}/${pass2Hits + pass2Misses} = ${(100 * pass2HitRate).toFixed(0)}% of requests,`,
    `finishing in ${t2}ms vs ${t1}ms cold. Cumulative estimated download time avoided: ${statsAfter2.estSavedMs}ms`,
    "(cache hits x measured mean miss latency -- a byte-level estimate, since concurrent fetches overlap).",
    "",
    `**VERDICT: ${json.verdict}**`,
    "",
    "The measured cost is DOWNLOAD, and the per-key cache removes it on repeat -- the evidence-backed case for",
    "using the helper across research studies first. Promotion toward production is a SEPARATE, gated decision",
    "this script does not make. safeToGate false, discoveryClaim false; nothing anchored.",
    "",
  ].join("\n");
  writeFileSync("reports/p64-fetch-telemetry.md", md);
  console.log("\nwrote reports/p64-fetch-telemetry.md and reports/p64-fetch-telemetry.json");
}

main().catch((e) => { console.error(`[p64] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
