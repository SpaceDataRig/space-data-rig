// Registry validator: prove every curated MAST entry still resolves to REAL TESS photometry.
//
// The curated registry (src/data/mastCurated.ts) is the only deterministic path to real
// light curves, and each entry is a hand-added product URI. This script downloads every
// URI anonymously (Download/file), FITS-parses it, and asserts the result is genuine TESS
// photometry (>1k points, finite flux, mission=TESS). Run it before trusting a new entry
// or after any registry edit; it exits non-zero if ANY curated URI fails, so a stale or
// mistyped product line can never silently degrade the pipeline to a synthetic stand-in.
//
// Adding a target is a two-step contribution: append one line to the registry, then run
// `npm run mast:validate` -- it must print PASS for the new host before the entry counts.
//
// Usage: npm run mast:validate
import { listCuratedMast } from "../src/data/mastCurated.ts";
import { fetchMastProductBytes, fitsToLightCurve } from "../src/data/mast.ts";

const MIN_POINTS = 1000; // TESS 2-min SPOC light curves carry >10k points

const entries = listCuratedMast();
console.log(`[validate] checking ${entries.length} curated MAST product URI(s)...`);

let pass = 0;
let fail = 0;
for (const { host, product } of entries) {
  const label = `${host} -> ${product.productUri}`;
  try {
    const bytes = await fetchMastProductBytes(product.productUri);
    const lc = fitsToLightCurve(bytes, product.label);
    const finite = lc.points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux)).length;
    if (lc.mission !== "TESS") throw new Error(`mission is ${lc.mission}, expected TESS`);
    if (lc.points.length < MIN_POINTS) throw new Error(`only ${lc.points.length} points (< ${MIN_POINTS})`);
    if (finite < MIN_POINTS) throw new Error(`only ${finite} finite flux points (< ${MIN_POINTS})`);
    console.log(`[validate] PASS ${label}: ${lc.points.length} real points, cadence ${lc.cadenceSec ?? "?"}s, source="${lc.source ?? "?"}"`);
    pass++;
  } catch (e) {
    console.error(`[validate] FAIL ${label}: ${e instanceof Error ? e.message : String(e)}`);
    fail++;
  }
}

console.log(`[validate] ${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.error("[validate] one or more curated URIs did not yield real TESS photometry; fix or remove them before relying on the registry.");
  process.exit(1);
}
console.log("[validate] every curated entry resolves to real TESS photometry.");
