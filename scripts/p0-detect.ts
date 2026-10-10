// P0 end-to-end demonstration:
//   real NASA catalog -> inject a planet with REAL params -> detect blind ->
//   cross-match back to the catalog -> emit a Finding + SVG plots.
// Run: npm run p0:detect
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchConfirmedPlanets, crossmatchPeriod } from "../src/data/exoplanetArchive.ts";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { foldedPlotSVG, periodogramSVG, timeSeriesPlotSVG } from "../src/detect/svgPlot.ts";
import type { Finding } from "../src/core/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../out/findings");
mkdirSync(outDir, { recursive: true });

console.log("\n=== Space Data Rig :: P0 End-to-End Detection ===\n");
console.log("[data-fetch] querying NASA Exoplanet Archive ...");
const cat = await fetchConfirmedPlanets({ maxTmag: 11, limit: 40, minPeriodDays: 1, maxPeriodDays: 14 });
console.log(`[data-fetch] ${cat.planets.length} confirmed planets (source=${cat.source})\n`);

// pick a few with usable stellar radius + planet radius to build realistic curves
const targets = cat.planets
  .filter((p) => p.pl_orbper != null && p.st_rad != null && (p.pl_rade ?? 0) > 0)
  .slice(0, 4);

const findings: Finding[] = [];
for (let i = 0; i < targets.length; i++) {
  const tp = targets[i];
  const period = tp.pl_orbper!;
  const stellarRadiusRsun = tp.st_rad!;
  const planetRadiusEarth = tp.pl_rade!;

  // data-fetch: build an observable light curve for this system (synthetic stand-in
  // for a MAST pull; same shape/cadence as TESS 2-min over one 27-day sector)
  const { lc, truth } = generateSyntheticTransit({
    seed: 7000 + i,
    periodDays: period,
    planetRadiusEarth,
    stellarRadiusRsun,
    stellarMassMsun: stellarRadiusRsun,
    impactParam: 0.2 + (i % 3) * 0.15,
    noisePpm: 180,
    cadenceSec: 120,
    baselineDays: 27,
    targetIdLabel: tp.hostname ?? tp.pl_name,
  });

  // anomaly-scout + sim-runner: blind detection (search range not centered on truth)
  const det = detectTransit(lc, { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 });

  // mission-critic: cross-match recovered period against the real catalog
  const match = crossmatchPeriod(det.candidate.periodDays, cat.planets, undefined, 2);
  const periodErr = Math.abs(det.candidate.periodDays - period) / period;
  const accepted = match != null && periodErr < 0.02 && det.candidate.snr >= 7;

  const finding: Finding = {
    id: `P0-${(tp.pl_name ?? tp.hostname).replace(/\s+/g, "-")}`,
    targetId: lc.targetId,
    candidate: det.candidate,
    verdict: accepted ? "accepted" : periodErr < 0.05 ? "needs-more-data" : "rejected",
    verdictReason: accepted
      ? `Recovers known planet ${match!.pl_name} (P err ${(periodErr * 100).toFixed(2)}%, SNR ${det.candidate.snr.toFixed(0)}); odd-even alias x${det.aliasMultiple}.`
      : `Period error ${(periodErr * 100).toFixed(2)}% or low SNR ${det.candidate.snr.toFixed(1)}; needs follow-up.`,
    crossmatch: {
      matchedKnownPlanet: match != null,
      knownPlanetName: match?.pl_name,
      knownPeriodDays: match?.pl_orbper,
      periodDeltaPct: match ? (Math.abs(det.candidate.periodDays - match.pl_orbper!) / match.pl_orbper!) * 100 : undefined,
    },
    createdAt: new Date().toISOString(),
  };
  findings.push(finding);

  // reporter: plots
  const folded = foldedPlotSVG(det.candidate.folded ?? [], { title: `${lc.targetId} — folded @ P=${det.candidate.periodDays.toFixed(4)}d` });
  const perio = periodogramSVG(det.bls.periodGrid, { title: `${lc.targetId} — BLS periodogram` });
  const ts = timeSeriesPlotSVG(
    det.clean.points.map((p) => ({ time: p.time, flux: p.flux })),
    det.model,
    { title: `${lc.targetId} — light curve + transit model` },
  );
  const slug = finding.id;
  writeFileSync(resolve(outDir, `${slug}-folded.svg`), folded);
  writeFileSync(resolve(outDir, `${slug}-periodogram.svg`), perio);
  writeFileSync(resolve(outDir, `${slug}-timeseries.svg`), ts);

  const flag = accepted ? "[PASS]" : finding.verdict === "needs-more-data" ? "[REVIEW]" : "[FAIL]";
  console.log(
    `${flag} ${lc.targetId.padEnd(14)} P_inj=${period.toFixed(4)}d  P_det=${det.candidate.periodDays.toFixed(4)}d  ` +
      `err=${(periodErr * 100).toFixed(2)}%  depth=${(det.candidate.depthFrac * 1e6).toFixed(0)}ppm  ` +
      `SNR=${det.candidate.snr.toFixed(0)}  alias=x${det.aliasMultiple}  match=${match?.pl_name ?? "-"}`,
  );
  console.log(`       injected: Rp=${planetRadiusEarth.toFixed(2)}R_E  Rstar=${stellarRadiusRsun.toFixed(2)}R_Sun  dur=${truth.durationHours.toFixed(2)}h`);
}

writeFileSync(resolve(outDir, "../p0-findings.json"), JSON.stringify(findings, null, 2));
const nAcc = findings.filter((f) => f.verdict === "accepted").length;
console.log(`\n[mission-critic] ${nAcc}/${findings.length} accepted as recoveries of known planets.`);
console.log(`Wrote out/findings/*.svg and out/p0-findings.json\n`);
