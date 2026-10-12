// FFI BLIND-SEARCH YIELD PROBE (discovery roadmap, Stage 1).
//
// WHAT THIS IS. A bounded, read-only survey that enumerates real TGLC full-frame-image light curves
// from the token-free public S3 bucket, runs the SAME blind detector the rig uses (bls) on each, and
// reports what a blind search actually turns up on un-targeted stars. This is the first end-to-end
// step of the discovery pivot: it measures DETECTION YIELD, not discoveries.
//
// HONEST FRAMING (hard rules):
//   - Nothing here is a discovery claim. Deep periodic signals in FFI data are dominated by eclipsing
//     binaries; a raw BLS peak is a CANDIDATE at best and most are false positives. Stage 2 vetting is
//     what separates them; this script only shows the pipeline can ingest and search real FFI data.
//   - No novelty check, no verdict, no anchoring, no money path. It does not import the worker and
//     cannot touch a bundle hash. It is research infrastructure, like p5/p7/p17.
//   - Network + runtime bound: it lists one sector, takes at most --limit curves, and degrades per-file
//     (a download or parse failure is skipped, not fatal).
//
// Run:  npm run p19:ffi-blind  [-- --sector 1 --limit 12]
//       (re-run from a clean network; behind a proxy that blocks AWS this yields no data, not "no signals")

import { tglcBytesToLightCurve } from "../src/data/tglc.ts";
import { bls } from "../src/detect/bls.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-ffi-blind)";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** Recursive (no-delimiter) anonymous ListObjectsV2 -> object keys under a prefix. */
async function s3Keys(prefix: string, maxKeys = 1000): Promise<string[]> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status} for ${prefix}`);
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]);
}

async function download(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

interface Row {
  gaiaid: string;
  nCadences: number;
  periodDays: number;
  snr: number;
  depthPpm: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const sector = parseInt(arg("sector", "1"), 10);
  const limit = Math.max(1, parseInt(arg("limit", "12"), 10));
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  const prefix = `mast/hlsp/tglc/${sectStr}/`;
  console.log(`[p19] FFI blind-search yield probe: sector ${sectStr}, cap ${limit} curves (token-free TGLC)`);

  let keys: string[];
  try {
    keys = (await s3Keys(prefix)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit);
  } catch (e) {
    console.log(`[p19] listing failed (network? re-run from a clean edge): ${e instanceof Error ? e.message : e}`);
    console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
    return;
  }
  if (!keys.length) {
    console.log(`[p19] no TGLC _llc.fits keys listed under ${prefix}.`);
    console.log(`\nVERDICT: NO-DATA`);
    return;
  }
  console.log(`[p19] listed ${keys.length} light curves; searching each blind...`);

  const rows: Row[] = [];
  let parsed = 0;
  let failed = 0;
  for (const key of keys) {
    const m = key.match(/gaiaid-(\d+)/);
    const gaiaid = m ? m[1] : key.split("/").pop() ?? key;
    try {
      const bytes = await download(key);
      if (!bytes) { failed++; continue; }
      const lc = tglcBytesToLightCurve(bytes, `Gaia ${gaiaid}`);
      if (!lc) { failed++; continue; }
      parsed++;
      const r = bls(lc);
      rows.push({ gaiaid, nCadences: lc.points.length, periodDays: r.periodDays, snr: r.snr, depthPpm: r.depth * 1e6 });
    } catch (e) {
      failed++;
      console.log(`  [skip] ${gaiaid}: ${e instanceof Error ? e.message : e}`);
    }
  }

  rows.sort((a, b) => b.snr - a.snr);
  console.log(`\n[p19] parsed ${parsed} curves, ${failed} unusable. Top blind detections by SNR:`);
  console.log("  gaiaid                cad   period(d)     SNR   depth(ppm)");
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.gaiaid.padEnd(21)} ${String(r.nCadences).padStart(4)} ${r.periodDays.toFixed(4).padStart(10)} ${r.snr.toFixed(1).padStart(8)} ${r.depthPpm.toFixed(0).padStart(11)}`);
  }

  const depths = rows.map((r) => r.depthPpm);
  const ebLike = rows.filter((r) => r.depthPpm > 50000).length; // >5% deep: stellar-scale, almost certainly EB
  const planetLike = rows.filter((r) => r.depthPpm >= 200 && r.depthPpm <= 30000 && r.snr >= 7).length; // transit-shaped ppm range
  console.log(`\n[p19] summary: median depth ${median(depths).toFixed(0)} ppm; ${ebLike} deep(>5%, EB-like); ${planetLike} in the planet-depth band (200-30000 ppm, SNR>=7).`);
  console.log(`[p19] NOTE: raw BLS peaks are CANDIDATES, not discoveries; FFI is EB-dominated and Stage 2 vetting + a novelty check decide what survives. No claim made.`);
  console.log(`\nVERDICT: ${parsed > 0 ? "BLIND-SEARCH-RAN" : "NO-USEFUL-DATA"}`);
}

main().catch((e) => {
  console.error(`[p19] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
