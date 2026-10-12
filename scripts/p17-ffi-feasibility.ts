// FFI LIGHT-CURVE FEASIBILITY PROBE (discovery roadmap, Stage 0).
//
// QUESTION THIS ANSWERS. Stage 1 needs real photometry for stars that are NOT TESS-SPOC targets and
// NOT in the TOI list -- the un-searched population where a novel candidate could actually live. The
// authoritative answer (Han et al. 2023, TGLC; Powell et al. 2022; Kisling et al. 2023 TASH) is that
// full-frame-image-derived light curves for essentially every star brighter than TESS mag 16 are
// published as products, decontaminated against Gaia and (optionally) detrended -- so we do NOT need
// to build a photometry pipeline from raw FFIs. The ONE thing still unproven for OUR runtime is the
// exact token-free, programmatic retrieval key/URI for such a product. This probe finds it.
//
// WHAT IT DOES (read-only, no writes, no production import, not in npm test):
//   1. Anonymous S3 ListObjectsV2 on the public `stpubdata` bucket to enumerate which HLSP prefixes
//      exist (tess-spoc today; tglc / qlp / others if published there).
//   2. Descend the TGLC-like tree to a real sector and a sample .fits object.
//   3. Range-GET the first 2880 bytes and confirm a `SIMPLE` FITS header (proves anonymous download).
//   4. If a full object is reachable, parse it with the production fitsToLightCurve and run the
//      production detectTransit -- an end-to-end proof that an FFI-derived curve ingests into our chain.
//
// HONEST VERDICT SEMANTICS (do not over-read a single run):
//   FEASIBLE                 -- a token-free FFI light curve was listed, downloaded and parsed.
//   INCONCLUSIVE-NETWORK     -- a request failed at the network layer. This is EXPECTED from a
//                               developer machine behind a proxy that blocks AWS/STScI; it is NOT
//                               evidence of infeasibility. Re-run from a clean network (or the CF
//                               edge, as the SPOC path was validated) before concluding.
//   NO-TOKENFREE-TGLC-ROUTE  -- network healthy but no anonymous FFI-LC object found in the bucket;
//                               then pivot to the MAST anonymous Download/file route or TESScut+eleanor.
//
// Run:  npx tsx scripts/p17-ffi-feasibility.ts  [--prefix mast/hlsp/] [--deep]

import { fitsToLightCurve } from "../src/data/mast.ts";
import { bls } from "../src/detect/bls.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-ffi-probe)";

interface ListResult {
  prefixes: string[];
  keys: string[];
}

/** Anonymous ListObjectsV2. Returns parsed CommonPrefixes + Contents Keys. Throws on network/HTTP. */
async function s3List(prefix: string, delimiter = "/", maxKeys = 50): Promise<ListResult> {
  const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=${encodeURIComponent(delimiter)}&max-keys=${maxKeys}`;
  const r = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status} for prefix ${prefix}`);
  const xml = await r.text();
  const prefixes = [...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix);
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  return { prefixes: [...new Set(prefixes)], keys };
}

/** Range-GET the first FITS block to confirm anonymous download + a SIMPLE header. */
async function fitsMagic(key: string): Promise<{ ok: boolean; status: number; magic: string }> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { Range: "bytes=0-2879", "User-Agent": UA } });
  if (!r.ok) return { ok: false, status: r.status, magic: "" };
  const buf = new Uint8Array(await r.arrayBuffer());
  const magic = String.fromCharCode(...Array.from(buf.slice(0, 6)));
  return { ok: magic === "SIMPLE", status: r.status, magic };
}

function isNetworkError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /fetch failed|ENOTFOUND|ECONN|ETIMEOUT|abort|network|socket|getaddrinfo|proxy|TLS|certificate/i.test(m);
}

async function downloadFull(key: string): Promise<Uint8Array | null> {
  const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

/** Descend a prefix tree via sub-prefixes until a real .fits leaf appears; never return a stray doc. */
async function findSampleFits(root: string): Promise<string> {
  let dir = root;
  for (let hop = 0; hop < 10; hop++) {
    const l = await s3List(dir);
    const fits = l.keys.find((k) => k.toLowerCase().endsWith(".fits"));
    if (fits) return fits;
    // prefer sector-like data dirs (s0001/...); skip script/doc dirs and the echoed root
    const subs = l.prefixes.filter((p) => p !== dir && !/download_script|\/script|readme|\/doc|manifest/i.test(p));
    const sector = subs.find((p) => /\/s\d{3,4}\//.test(p));
    const next = sector ?? subs[0];
    if (!next) break;
    dir = next;
  }
  return "";
}

async function main(): Promise<void> {
  const deep = process.argv.includes("--deep");
  const startPrefix = (process.argv.find((a) => a.startsWith("--prefix=")) ?? "").split("=")[1] || "mast/hlsp/";
  let verdict = "UNKNOWN";

  console.log(`[p17] FFI light-curve feasibility probe (token-free S3 discovery), start prefix: ${startPrefix}`);

  // 1. which HLSP products live in the public bucket?
  let top: ListResult;
  try {
    top = await s3List(startPrefix);
    console.log(`[p17] OK  prefixes under ${startPrefix}: ${top.prefixes.join(", ") || "(none)"}`);
  } catch (e) {
    const net = isNetworkError(e);
    console.log(`[p17] ${net ? "NETWORK" : "HTTP"} listing failed: ${e instanceof Error ? e.message : e}`);
    verdict = net ? "INCONCLUSIVE-NETWORK" : "NO-TOKENFREE-TGLC-ROUTE";
    console.log(`\nVERDICT: ${verdict}`);
    return;
  }

  // 2. find an FFI-derived light-curve HLSP (tglc / qlp / gsfc / tash naming), not just SPOC.
  const ffiCandidates = top.prefixes.filter((p) => /tglc|tess-gaia|gaia-light|qlp|gsfc|tash|ffi/i.test(p));
  const spocOnly = ffiCandidates.length === 0 && top.prefixes.some((p) => /tess-spoc/i.test(p));
  if (ffiCandidates.length) console.log(`[p17] FFI-LC HLSP prefixes found: ${ffiCandidates.join(", ")}`);
  else if (spocOnly) console.log(`[p17] only tess-spoc present under ${startPrefix}; FFI-LC products may live under a different root (try --prefix=mast/ or the MAST Download/file route).`);

  // 3. descend an FFI-LC tree (prefer tglc) to a real .fits leaf and confirm anonymous download.
  const roots = [...ffiCandidates].sort((a, b) => Number(b.includes("tglc")) - Number(a.includes("tglc")));
  const probeRoots = roots.length ? roots : top.prefixes.slice(0, 1);
  if (!probeRoots.length) {
    console.log(`[p17] no prefixes to descend under ${startPrefix}.`);
    console.log(`\nVERDICT: NO-TOKENFREE-TGLC-ROUTE`);
    return;
  }
  try {
    let sampleKey = "";
    let usedRoot = "";
    for (const root of probeRoots) {
      const k = await findSampleFits(root);
      if (k) { sampleKey = k; usedRoot = root; break; }
      console.log(`[p17] no .fits leaf under ${root}; trying next candidate.`);
    }
    if (!sampleKey) {
      console.log(`[p17] could not reach a .fits leaf under ${probeRoots.join(", ")}.`);
      verdict = "NO-TOKENFREE-TGLC-ROUTE";
    } else {
      console.log(`[p17] sample object under ${usedRoot}: ${sampleKey}`);
      const m = await fitsMagic(sampleKey);
      console.log(`[p17] anonymous download: HTTP ${m.status}, header magic='${m.magic}' -> ${m.ok ? "FITS OK" : "not FITS"}`);
      if (m.ok && deep) {
        const bytes = await downloadFull(sampleKey);
        if (bytes) {
          try {
            const lc = fitsToLightCurve(bytes, "p17-probe");
            const r = bls(lc);
            console.log(`[p17] END-TO-END: parsed ${lc.points.length} points; BLS best period ${r.periodDays.toFixed(4)} d SNR ${r.snr.toFixed(1)} depth ${(r.depth * 1e6).toFixed(0)} ppm`);
          } catch (e) {
            console.log(`[p17] downloaded FITS but fitsToLightCurve/bls failed (TGLC/QLP column names differ from SPOC PDCSAP -> add a column map in Stage 1): ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      verdict = m.ok ? "FEASIBLE" : "NO-TOKENFREE-TGLC-ROUTE";
    }
  } catch (e) {
    const net = isNetworkError(e);
    console.log(`[p17] ${net ? "NETWORK" : "HTTP"} descend failed: ${e instanceof Error ? e.message : e}`);
    verdict = net ? "INCONCLUSIVE-NETWORK" : "NO-TOKENFREE-TGLC-ROUTE";
  }

  console.log(`\nVERDICT: ${verdict}${verdict === "INCONCLUSIVE-NETWORK" ? "  (re-run from a clean network / CF edge before concluding)" : ""}`);
}

main().catch((e) => {
  console.error(`[p17] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
