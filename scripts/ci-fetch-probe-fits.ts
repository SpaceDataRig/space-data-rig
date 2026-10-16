// audit-6 P2: make the real-MAST-FITS gates actually RUN in CI.
//
// tests/mast.test.ts, tests/mastS3.test.ts and tests/mastS3Pixels.test.ts skip themselves when
// out/probe-lc.fits / out/probe-tp.fits are absent, and out/ is gitignored -- so on a fresh CI checkout
// those six gates (real FITS parses; BLS finds the strong signal in real photometry; the target-pixel
// cube parses) NEVER ran. Committing the ~7 MB of binary probes would bloat the repo forever, so instead
// CI prefetches the exact same public products here, through the production fetch code, before the tests.
//
// Read-only and token-free: one curated MAST Download URI (the GL 2-min curve used by the official MAST
// notebook) and one anonymous TESS-SPOC public-S3 target-pixel object. Existing local caches are reused.
// A download that still fails after retries exits 1 ON PURPOSE: these gates exist to surface external
// data fragility, so a silent skip would defeat the point.
//
// Usage: npm run ci:probe-fits
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fetchMastProductBytes } from "../src/data/mast.ts";
import { fetchSpocBytes, resolveSpocKey } from "../src/data/mastS3.ts";

const LC_URI = "mast:TESS/product/tess2018292075959-s0004-0000000025155310-0124-s_lc.fits"; // TIC 25155310, s0004, 2-min
const TP_TIC = 261136679; // pi Men c
const TP_SECTOR = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T | null>, tries = 4): Promise<T> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
      last = "empty/missing response";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`${label}: ${last} (after ${tries} tries)`);
}

mkdirSync("out", { recursive: true });

const lcPath = resolve("out", "probe-lc.fits");
if (existsSync(lcPath)) {
  console.log(`[probe] reusing cached ${lcPath}`);
} else {
  const bytes = await withRetry("probe-lc", () => fetchMastProductBytes(LC_URI));
  writeFileSync(lcPath, bytes);
  console.log(`[probe] wrote ${lcPath} (${bytes.length} bytes)`);
}

const tpPath = resolve("out", "probe-tp.fits");
if (existsSync(tpPath)) {
  console.log(`[probe] reusing cached ${tpPath}`);
} else {
  const key = resolveSpocKey(TP_TIC, TP_SECTOR, "tp");
  const bytes = await withRetry("probe-tp", () => fetchSpocBytes(key));
  writeFileSync(tpPath, bytes);
  console.log(`[probe] wrote ${tpPath} (${bytes.length} bytes)`);
}

console.log("[probe] real MAST probe FITS present; the external-data gates will run");
