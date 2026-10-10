// P3 checkpoint: MAST product auto-discovery for a catalog target.
//
// Given a host star's coordinates, ask MAST (anonymously, no token) which real
// light-curve products exist, then download the best one and run the same BLS
// detector the pipeline uses. This proves the discovery -> download -> parse ->
// detect chain end to end.
//
// Reality check (verified 2026-10-10): anonymous CAOM query services return an
// empty body, so on a token-less run this script reports "no products" and tells
// you to use the curated registry (npm run p0:mast) or pass a token via
// MAST_TOKEN. With a token on a normal network it lists real product URIs.
//
// Usage:
//   npm run p3:discover -- --ra 96.7977 --dec -3.76 --name WASP-126
//   MAST_TOKEN=... npm run p3:discover -- --ra 96.7977 --dec -3.76   (authenticated)
import { discoverMastProducts, discoverAndFetchLightCurve } from "../src/data/mastDiscover.ts";
import { detectTransit } from "../src/detect/pipeline.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ra = Number(arg("ra"));
const dec = Number(arg("dec"));
const name = arg("name", "TARGET");
const radius = Number(arg("radius", "0.02"));
const token = process.env.MAST_TOKEN?.trim();

if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
  console.error("usage: npm run p3:discover -- --ra <deg> --dec <deg> [--name NAME] [--radius DEG]");
  process.exit(2);
}

const opts = { radiusDeg: radius, authHeader: token ? `Bearer ${token}` : undefined };
console.log(`[discover] coordinates (${ra.toFixed(4)}, ${dec.toFixed(4)}) radius ${radius} deg, auth=${token ? "token" : "anonymous"}`);

let products;
try {
  products = await discoverMastProducts(ra, dec, opts);
} catch (e) {
  console.error(`[discover] query failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (products.length === 0) {
  console.log(`[discover] MAST returned 0 light-curve products for ${name}.`);
  console.log("[discover] This is expected anonymously: the CAOM query services are empty without a token.");
  console.log("[discover] Use a real product via the curated registry (npm run p0:mast), or set MAST_TOKEN and re-run.");
  process.exit(0);
}

console.log(`[discover] found ${products.length} product(s); top candidates:`);
for (const p of products.slice(0, 5)) console.log(`  - ${p.obsId}: ${p.dataUri}`);

const lc = await discoverAndFetchLightCurve(ra, dec, name ?? "TARGET", opts);
if (!lc) {
  console.error("[discover] best product failed to download/parse");
  process.exit(1);
}
console.log(`[discover] parsed ${lc.points.length} real points, cadence ${lc.cadenceSec}s`);
const det = detectTransit(lc, { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 });
console.log(`[discover] BLS: period=${det.candidate.periodDays.toFixed(4)}d depth=${(det.candidate.depthPpt * 1000).toFixed(0)}ppm snr=${det.candidate.snr.toFixed(2)}`);
console.log(`[discover] source: ${lc.source}`);
