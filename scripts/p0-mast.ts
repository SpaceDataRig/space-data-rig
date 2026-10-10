// P0 checkpoint: real MAST TESS photometry end to end.
// Downloads (or reuses a cached copy of) a known public TESS light-curve product,
// parses the FITS table, converts to the shared LightCurve shape, and runs the
// same BLS detector the pipeline uses -- proving the real-data path works.
//
// Usage: npm run p0:mast
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fetchMastProductBytes, fitsToLightCurve } from "../src/data/mast.ts";
import { detectTransit } from "../src/detect/pipeline.ts";

// A public GL 2-minute light curve used by the official MAST notebook
// (TIC 25155310, sector 0004). Anonymous download, no token needed.
const URI = "mast:TESS/product/tess2018292075959-s0004-0000000025155310-0124-s_lc.fits";
const TARGET = "TIC 25155310";

const cache = resolve("out", "probe-lc.fits");
mkdirSync("out", { recursive: true });

let bytes: Uint8Array;
if (existsSync(cache)) {
  bytes = new Uint8Array(readFileSync(cache));
  console.log(`[mast] using cached FITS (${bytes.length} bytes)`);
} else {
  console.log(`[mast] downloading ${URI}`);
  bytes = await fetchMastProductBytes(URI);
  writeFileSync(cache, bytes);
  console.log(`[mast] cached to ${cache} (${bytes.length} bytes)`);
}

const lc = fitsToLightCurve(bytes, TARGET);
const t0 = lc.points[0].time;
const t1 = lc.points[lc.points.length - 1].time;
console.log(`[lc] points=${lc.points.length} cadence=${lc.cadenceSec}s span=${(t1 - t0).toFixed(2)}d mission=${lc.mission}`);
console.log(`[lc] source: ${lc.source}`);

const det = detectTransit(lc, { minPeriodDays: 0.5, maxPeriodDays: 13 });
const c = det.candidate;
console.log(`[bls] period=${c.periodDays.toFixed(4)}d epoch=${c.epochBjd.toFixed(3)} depth=${(c.depthFrac * 1e6).toFixed(0)}ppm dur=${c.durationHours.toFixed(2)}h snr=${c.snr.toFixed(1)} aliases=${det.aliasMultiple}`);
console.log("[done] real MAST photometry parsed and searched end to end");
