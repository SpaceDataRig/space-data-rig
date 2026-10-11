// P4 checkpoint: the token-free AUTONOMOUS research chain.
//
// For a batch of REAL confirmed transiting planets (picked from the NASA
// Exoplanet Archive, keeping only those that carry a TIC), this script:
//   ra/dec --(TESScut, no token)--> covering sectors
//          --(TESS-SPOC public S3, no token)--> REAL PDCSAP light curve
//          --(fits.ts)--> shared LightCurve
//          --(BLS)--> a transit candidate.
// It reports, honestly, how many of the queued targets actually resolve to real
// SPOC photometry (a target not in the SPOC program 404s and is skipped, exactly
// as the pipeline tier falls through to the stand-in). Nothing here costs a MAST
// token or an AWS account.
//
// Usage:
//   npm run p4:autonomous                         (live: 8 brightest TIC targets)
//   npm run p4:autonomous -- --targets 12 --tmag 9
//   npm run p4:autonomous -- --tic 1024880 --sector 4   (a known-good SPOC target)
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const nTargets = Number(arg("targets", "8"));
const maxTmag = Number(arg("tmag", "10"));
const directTic = arg("tic") != null ? Number(arg("tic")) : undefined;
const directSector = arg("sector") != null ? Number(arg("sector")) : undefined;

interface Candidate {
  name: string;
  tic: number;
  ra?: number;
  dec?: number;
  sectorsHint?: number[];
}

let candidates: Candidate[] = [];
if (Number.isFinite(directTic)) {
  candidates = [{ name: `TIC ${directTic}`, tic: directTic!, sectorsHint: Number.isFinite(directSector) ? [directSector!] : [] }];
  console.log(`[p4] direct mode: TIC ${directTic} sector ${directSector ?? "auto"}`);
} else {
  console.log(`[p4] querying the NASA Exoplanet Archive for the ${nTargets} brightest TIC-bearing transiting planets (tmag<${maxTmag}) ...`);
  const r = await fetchConfirmedPlanets({ maxTmag, limit: nTargets, minPeriodDays: 1, maxPeriodDays: 14, requireTic: true });
  console.log(`[p4] catalog source=${r.source}, ${r.planets.length} planets returned`);
  candidates = r.planets
    .filter((p) => Number.isFinite(p.tic))
    .slice(0, nTargets)
    .map((p) => ({ name: p.pl_name ?? p.hostname, tic: p.tic!, ra: p.ra, dec: p.dec }));
}

let realHits = 0;
let firstCurve: { lc: LightCurve; name: string } | null = null;

for (const c of candidates) {
  let sectors = c.sectorsHint ?? [];
  if (sectors.length === 0 && Number.isFinite(c.ra) && Number.isFinite(c.dec)) {
    sectors = await sectorsForCoord(c.ra!, c.dec!);
  }
  if (sectors.length === 0) {
    console.log(`  - ${c.name} (TIC ${c.tic}): no sectors resolved (offline/blocked?) -- would fall through to stand-in`);
    continue;
  }
  const lc = await fetchSpocLightCurve(c.tic, sectors, c.name);
  if (!lc) {
    console.log(`  - ${c.name} (TIC ${c.tic}, sectors ${sectors.join("/")}): not in the SPOC bucket -- would fall through to stand-in`);
    continue;
  }
  realHits++;
  console.log(`  + ${c.name} (TIC ${c.tic}): REAL ${lc.points.length}-point PDCSAP curve from sectors ${sectors.join("/")}`);
  if (!firstCurve) firstCurve = { lc, name: c.name };
}

console.log(`\n[p4] autonomous real-photometry hits: ${realHits}/${candidates.length} targets resolved to REAL TESS-SPOC curves (token-free).`);

if (firstCurve) {
  const det = detectTransit(firstCurve.lc, { minPeriodDays: 0.5, maxPeriodDays: 13 });
  const c = det.candidate;
  console.log(`[p4] BLS on ${firstCurve.name}: P=${c.periodDays.toFixed(4)}d depth=${(c.depthFrac * 1e6).toFixed(0)}ppm SNR=${c.snr.toFixed(1)}`);
  console.log(`[p4] source: ${firstCurve.lc.source}`);
  process.exit(0);
} else {
  console.log("[p4] no real curve resolved on this network; the pipeline tier would use the deterministic stand-in.");
  process.exit(0);
}
