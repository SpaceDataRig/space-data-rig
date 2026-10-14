// P49: a FORMAL BLIND TEST of the production detector on real photometry (validation roadmap, priority 5).
//
// Protocol. Take a seeded sample of real TESS-SPOC host curves. For each, a seeded coin either PLANTS one
// synthetic planet (random period/depth from a documented prior, recorded in a SEALED ANSWER KEY the
// detector never sees) or leaves the curve as a NULL. Run the SAME gated detector the pipeline uses
// (iterativeBls under SNR>=7 + depth-regime screen). Score detections against the key with
// src/sim/blindTest.ts: a full confusion matrix, recall (of planted planets, how many recovered) and
// precision (of detections, how many were the planted planet) with Wilson 95% intervals, the false-positive
// rate per null curve, and the corroboration-capped acceptance (a detection is ACCEPTED only at >= 2
// independent sectors; single-baseline detections are capped as needs-more-data).
//
// HONEST FRAMING. (1) A "false positive" here is any detection not matching the planted planet -- which
// INCLUDES the host's own real, uncatalogued planet; so precision is a LOWER bound, the same conservative
// convention the purity numbers use. (2) Our curves are a single stitched baseline, so corroboratedSectors
// is 1 and NOTHING clears a 2-sector bar: the accepted set is empty and falseAccepts is 0 BY THE RULE,
// which is precisely why a single-sector blind detection is never auto-accepted toward the money path.
// Positive control only; nothing gated, anchored, claimed, or deployed. discoveryClaim false.
//
// Run:  npm run p49:blind-test  [-- --stars 30 --maxsectors 2 --tmag 12 --inject-frac 0.5 --seed 7]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { resolveSpocKey, fetchSpocBytes, stitchLightCurves } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { injectTransitInto } from "../src/sim/injectInto.ts";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantStars = Math.max(1, parseInt(arg("stars", "30"), 10));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "2"), 10));
const tmagCap = Number(arg("tmag", "12"));
const injectFrac = Math.min(1, Math.max(0, Number(arg("inject-frac", "0.5"))));
const seed = Math.max(1, parseInt(arg("seed", "7"), 10));
const PERIOD_PRIOR: [number, number] = [2, 8];
const DEPTH_PRIOR = [1000, 2000, 4000];
const minPeriod = 1;
const maxPeriod = 13;

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function collectSpocCurves(tic: number, name: string, maxCurves: number, sectorMax = 40): Promise<LightCurve[]> {
  const out: LightCurve[] = [];
  for (let s = 1; s <= sectorMax && out.length < maxCurves; s++) {
    let bytes: Uint8Array | null = null;
    try { bytes = await fetchSpocBytes(resolveSpocKey(tic, s, "lc"), { timeoutMs: 20000 }); } catch { /* skip */ }
    if (!bytes) continue;
    try {
      const lc = fitsToLightCurve(bytes, name);
      if (lc.points.length < 60) continue;
      out.push(lc);
    } catch { /* skip */ }
  }
  return out;
}

/** Gated detector signals (production gate), strongest first, with depth. */
function detectSignals(lc: LightCurve, maxSignals: number): { periodDays: number; depthPpm: number }[] {
  try {
    const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
    return it.signals
      .filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible)
      .map((s) => ({ periodDays: s.periodDays, depthPpm: s.depthPpm }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  console.log(`P49 formal blind test on real photometry: ${wantStars} seeded hosts, inject-frac ${injectFrac}, period prior [${PERIOD_PRIOR}]d, depth prior [${DEPTH_PRIOR}]ppm, seed ${seed}. Detector = iterativeBls under the production gate. Sealed key hidden from the detector.`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) { const a = byHost.get(p.tic!) ?? []; a.push(p); byHost.set(p.tic!, a); }
  const hosts = [...byHost.entries()].slice(0, wantStars * 2); // over-fetch to absorb coverage misses

  const rng = mulberry32(seed);
  const truth: Truth[] = [];
  const detections: Detection[] = [];
  let made = 0;
  for (const [tic, hostPlanets] of hosts) {
    if (made >= wantStars) break;
    const name = hostPlanets[0].hostname ?? `TIC ${tic}`;
    const sectorLcs = await collectSpocCurves(tic, name, maxSectors);
    if (!sectorLcs.length) continue;
    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;
    const id = `${tic}`;
    made++;

    const doInject = rng() < injectFrac;
    let curve = stitched;
    if (doInject) {
      const periodDays = PERIOD_PRIOR[0] + rng() * (PERIOD_PRIOR[1] - PERIOD_PRIOR[0]);
      const depthPpm = DEPTH_PRIOR[Math.floor(rng() * DEPTH_PRIOR.length)];
      truth.push({ id, injected: true, periodDays, depthPpm });
      curve = injectTransitInto(stitched, { seed: seed + made, periodDays, depthFrac: depthPpm / 1e6 });
    } else {
      truth.push({ id, injected: false });
    }
    for (const s of detectSignals(curve, 3)) {
      detections.push({ id, periodDays: s.periodDays, depthPpm: s.depthPpm, corroboratedSectors: 1 });
    }
  }

  if (!truth.length) {
    console.log(`\nNo usable curves (network/coverage). Re-run shortly.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const raw = scoreBlindTest(truth, detections, { minCorroboration: 1 }); // detector as-is, no corroboration bar
  const capped = scoreBlindTest(truth, detections, { minCorroboration: 2 }); // with the 2-sector acceptance bar

  const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
  const ci = (r: [number, number]) => `[${pct(r[0])}, ${pct(r[1])}]`;
  console.log(`\n=== P49 BLIND-TEST SUMMARY (${truth.length} curves: ${raw.nInjected} injected, ${raw.nNull} null; ${raw.nDetections} gated detections) ===`);
  console.log(`  confusion: TP ${raw.tp}  FP ${raw.fp}  FN ${raw.fn}  TN ${raw.tn}`);
  console.log(`  RECALL (planted recovered)   : ${pct(raw.recall)} ${ci(raw.recallCI)}`);
  console.log(`  PRECISION (detections real)  : ${pct(raw.precision)} ${ci(raw.precisionCI)}  (lower bound: FP includes hosts' own real planets)`);
  console.log(`  FP rate per null curve       : ${Number.isFinite(raw.fpPerNullCurve) ? raw.fpPerNullCurve.toFixed(2) : "n/a"}`);
  console.log(`  under a 2-sector bar         : accepted ${capped.accepted}, needs-more-data ${capped.needsMoreData}, FALSE-ACCEPTS ${capped.falseAccepts}`);

  const json = {
    meta: {
      generatedBy: "scripts/p49-blind-test.ts", protocol: "sealed-key injection-recovery blind test",
      detector: "iterativeBls under production gate (SNR>=7, depth-regime screen), maxSignals=3",
      wantStars, injectFrac, periodPrior: PERIOD_PRIOR, depthPrior: DEPTH_PRIOR, seed,
      note: "precision is a lower bound: a detection not matching the planted planet counts FP even if it is the host's own real planet. Single stitched baseline => corroboratedSectors=1, so a 2-sector bar accepts nothing (falseAccepts 0 by rule).",
    },
    curves: truth.length, injected: raw.nInjected, null: raw.nNull, detections: raw.nDetections,
    raw, capped, discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p49-blind-test.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P49 formal blind test of the detector on real photometry",
    "",
    `Reproduce: \`npm run p49:blind-test -- --stars ${wantStars} --maxsectors ${maxSectors} --inject-frac ${injectFrac} --seed ${seed}\``,
    "",
    "A seeded coin planted one synthetic planet (random period/depth from a documented prior, logged in a",
    "sealed answer key the detector never saw) on some real TESS-SPOC curves and left the rest null; the",
    "production gated detector then ran on every curve and its detections were scored against the key.",
    "",
    `**${truth.length} curves** (${raw.nInjected} injected, ${raw.nNull} null), **${raw.nDetections} gated detections**`,
    "",
    "| metric | value |",
    "|---|---|",
    `| TP / FP / FN / TN | ${raw.tp} / ${raw.fp} / ${raw.fn} / ${raw.tn} |`,
    `| recall (planted recovered) | ${pct(raw.recall)} ${ci(raw.recallCI)} |`,
    `| precision (detections real) | ${pct(raw.precision)} ${ci(raw.precisionCI)} |`,
    `| FP rate per null curve | ${Number.isFinite(raw.fpPerNullCurve) ? raw.fpPerNullCurve.toFixed(2) : "n/a"} |`,
    `| accepted under a 2-sector bar | ${capped.accepted} |`,
    `| false-accepts under a 2-sector bar | ${capped.falseAccepts} |`,
    "",
    "Honest reading: precision is a LOWER bound (a detection that is the host's own real-but-uncatalogued",
    "planet counts as FP). The decisive safety number is false-accepts: on our single stitched baseline every",
    `detection has corroboratedSectors=1, so under a 2-sector corroboration bar ${capped.accepted} are accepted and`,
    `${capped.falseAccepts} are false-accepts -- the pipeline refuses to auto-accept any single-sector signal, which`,
    "is exactly why it makes no discovery claim. Positive control only; nothing gated, anchored, claimed, or",
    "deployed. `discoveryClaim: false`.",
    "",
  ];
  writeFileSync("reports/p49-blind-test.md", md.join("\n"));
  console.log("\nwrote reports/p49-blind-test.md and reports/p49-blind-test.json");
  console.log(`\nVERDICT: ${capped.falseAccepts === 0 ? "P49-BLIND-RAN-ZERO-FALSE-ACCEPTS" : "P49-BLIND-RAN"}`);
}

main().catch((e) => {
  console.error("p49 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 1;
});
