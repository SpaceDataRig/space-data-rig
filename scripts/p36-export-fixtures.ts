// P36 - EXPORT REAL-CURVE FIXTURES FOR THE PYTHON CROSS-PIPELINE HARNESS.
//
// WHY. Problem 3 asks for independent third-party validation. p35 added independence at the ALGORITHM level (PDM,
// a non-parametric estimator sharing no machinery with the box-fit family). This increment adds independence at the
// IMPLEMENTATION level: the SAME real photometry re-analyzed by a completely different software stack (Python:
// astropy BLS + batman injection + wotan detrending) in a dedicated GitHub Actions workflow. The local dev
// environment has no Python interpreter, so the split is deliberate:
//   * TS side (this script, runs anywhere with network): download real public TESS-SPOC curves for the same seeded
//     host sample as p33/p35, deterministically subsample them to a fixture cap, and export plain-CSV fixtures +
//     a manifest (host, TIC, known catalog planet periods, point counts) under tests/fixtures/spoc-curves/.
//   * Python side (scripts/cross_pipeline.py, runs in CI only): inject batman transits across a depth grid into
//     the fixture curves, detrend with wotan, recover periods with astropy's BoxLeastSquares, and report
//     completeness + null-arm TP/FP classification against the manifest's known periods.
//
// FIXTURES ARE COMMITTED, SUBSAMPLED, AND SMALL ON PURPOSE: every CI run re-analyzes byte-identical input, so the
// cross-pipeline numbers are reproducible without re-downloading, and the repo stays light (default 8 curves,
// <=2500 points each). Subsampling is a deterministic uniform stride (gaps/window function preserved in
// proportion); the cap and the sample order are recorded in the manifest.
//
// OUTPUT: tests/fixtures/spoc-curves/<host-slug>.csv (header "time,flux", full double precision) and
// tests/fixtures/spoc-curves/manifest.json. Research tooling: no worker import, no verdict, no bundle hash, no
// money path, nothing gated/anchored/claimed/deployed.
//
// Run:  npm run p36:export-fixtures  [-- --stars 8 --maxsectors 2 --cap 2500 --tmag 12 --seed 7]

import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantStars = Math.max(1, parseInt(arg("stars", "8"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "2"), 10));
const cap = Math.max(200, parseInt(arg("cap", "2500"), 10));
const tmagCap = Number(arg("tmag", "12"));
const seed = Math.max(1, parseInt(arg("seed", "7"), 10));
const minPeriod = 1;
const maxPeriod = 13;
const OUT_DIR = "tests/fixtures/spoc-curves";

// Same TESScut-unreachable workaround as p32/p33/p35: SPOC S3 keys are deterministic given (TIC, sector) and a
// missing product is a fast 404, so probe the public bucket directly.
async function collectSpocCurves(tic: number, name: string, maxCurves: number, sectorMax = 40): Promise<{ lcs: LightCurve[]; sectors: number[] }> {
  const lcs: LightCurve[] = [];
  const sectors: number[] = [];
  for (let s = 1; s <= sectorMax && lcs.length < maxCurves; s++) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 });
    } catch { /* transient; skip this sector */ }
    if (!bytes) continue;
    try {
      const lc = fitsToLightCurve(bytes, name);
      if (lc.points.length < 60) continue;
      lc.source = `TESS-SPOC PDCSAP product sector ${s} from public S3 (REAL photometry); CC BY 4.0, cite Caldwell et al. 2020`;
      lcs.push(lc);
      sectors.push(s);
    } catch { /* unparseable; skip */ }
  }
  return { lcs, sectors };
}

/** Deterministic uniform-stride subsample to at most `cap` points (preserves the window function in proportion). */
function subsample(lc: LightCurve, capPts: number): { points: LightCurve["points"]; stride: number } {
  const n = lc.points.length;
  if (n <= capPts) return { points: lc.points, stride: 1 };
  const stride = Math.ceil(n / capPts);
  const points: LightCurve["points"] = [];
  for (let i = 0; i < n; i += stride) points.push(lc.points[i]);
  return { points, stride };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "host";
}

async function main(): Promise<void> {
  console.log(
    `P36 fixture export: first ${wantStars} seeded hosts (same catalog order as p33/p35, T<=${tmagCap}, P in [${minPeriod},${maxPeriod}] d), ` +
    `<=${maxSectors} sectors stitched, subsample cap ${cap} points. Output: ${OUT_DIR}/`,
  );
  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) {
    const a = byHost.get(p.tic!) ?? [];
    a.push(p);
    byHost.set(p.tic!, a);
  }
  const hosts = [...byHost.entries()].slice(0, wantStars);
  console.log(`  catalog: ${planets.length} in-range planets on ${byHost.size} hosts; sampling first ${hosts.length} hosts\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: {
    generatedBy: string; seed: number; maxSectors: number; capPoints: number; tmagCap: number;
    periodRangeDays: [number, number];
    fluxUnits: string; timeUnits: string; provenance: string;
    curves: { file: string; host: string; tic: number; sectors: number[]; nPointsRaw: number; nPoints: number; stride: number; knownPlanetPeriodsDays: number[] }[];
  } = {
    generatedBy: "p36-export-fixtures", seed, maxSectors, capPoints: cap, tmagCap,
    periodRangeDays: [minPeriod, maxPeriod],
    fluxUnits: "relative flux (PDCSAP, ~1.0)", timeUnits: "BJD (TDB)",
    provenance: "REAL public TESS-SPOC PDCSAP photometry from the public MAST S3 bucket; CC BY 4.0, cite Caldwell et al. 2020. Deterministic uniform-stride subsample; no other processing.",
    curves: [],
  };

  let idx = 0;
  for (const [tic, hostPlanets] of hosts) {
    idx++;
    const name = hostPlanets[0].hostname ?? hostPlanets[0].pl_name ?? `TIC ${tic}`;
    const { lcs, sectors } = await collectSpocCurves(tic, name, maxSectors);
    if (!lcs.length) {
      console.log(`  [${idx}/${hosts.length}] ${name}: no public SPOC curve (probed sectors 1-40); coverage miss`);
      continue;
    }
    const stitched = stitchLightCurves(lcs);
    if (!stitched) {
      console.log(`  [${idx}/${hosts.length}] ${name}: stitch failed; coverage miss`);
      continue;
    }
    const { points, stride } = subsample(stitched, cap);
    const file = `${slugify(name)}.csv`;
    const rows = points.map((p) => `${p.time},${p.flux}`);
    writeFileSync(`${OUT_DIR}/${file}`, `time,flux\n${rows.join("\n")}\n`);
    const known = hostPlanets.map((p) => p.pl_orbper!).sort((a, b) => a - b);
    manifest.curves.push({
      file, host: name, tic, sectors, nPointsRaw: stitched.points.length, nPoints: points.length, stride,
      knownPlanetPeriodsDays: known,
    });
    console.log(`  [${idx}/${hosts.length}] ${name.padEnd(16)} sectors [${sectors.join(",")}] ${stitched.points.length} pts -> ${points.length} (stride ${stride})  known P [${known.map((k) => k.toFixed(2)).join(", ")}] d  => ${file}`);
  }

  if (!manifest.curves.length) {
    console.log(`\nNo sampled host had a usable public SPOC curve; nothing exported.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }
  writeFileSync(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nExported ${manifest.curves.length} real-curve fixtures + manifest.json to ${OUT_DIR}/`);
  console.log(`Commit them so the Python cross-pipeline workflow (crosscheck-python.yml) re-analyzes byte-identical input.`);
  console.log(`\nVERDICT: P36-EXPORTED`);
}

main().catch((e) => {
  console.error(`[p36] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
