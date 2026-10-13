// P40 - MEASURE-BEFORE-GATE SAFETY CERTIFICATION for the systematics-aware FP gate.
//
// WHY THIS EXISTS. We are about to consider letting systematicsAwareFap (src/detect/instrumentalNull.ts)
// DECLINE a candidate in the production chain. The odd/even discriminator taught us the hard lesson (memory):
// a false-positive filter that passes clean synthetic unit tests can SILENTLY REJECT REAL PLANETS on real,
// phase-imperfect data. So before any production gate we PROVE, on real photometry with real coherent
// systematics, that the gate does not throw away genuine transits. This is the mandatory safety cert.
//
// WHAT IS SAFE vs WHAT IS A GATE. A planet is only at risk from the gate if the production SNR/depth chain
// would have ACCEPTED it in the first place. So the load-bearing safety number is:
//     P(sysFAP declines | production chain detects) across a realistic period x depth grid on real curves.
// A healthy FP filter declines ~0% of real detections (it rejects things that are NOT detections-by-truth);
// if it declines a meaningful share, it is unsafe and must NOT be wired into the money path.
//
// HONEST POSTURE. The gate is evaluated on common-mode-SUBTRACTED curves (subtract-then-gate, the intended
// production posture from p39): after subtraction the coherent systematic is gone, so a real transit is no
// longer "explainable by the shared instrument signal" and should survive. On RAW curves with a huge (11%)
// coherent systematic, a shallow single-star transit genuinely is within what the systematic produces -- the
// gate declining it is CORRECT, not a safety bug -- so that posture is reported separately, not mixed in.
//
// Injected star-specific transits on REAL curves (real noise, real gaps, real residual systematics) are the
// positive control -- the same pattern p31/p39 use, because a confirmed planet's own signal is a single star's,
// exactly like an injection. Research-only: no worker import, no verdict, no bundle hash, no money path.
//
// Run: npm run p40:fp-safety [-- --sector 1 --limit 120 --seed 7 --nNull 60]
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { systematicsAwareFap } from "../src/detect/instrumentalNull.ts";
import { removeCommonMode, commonModeTemplate } from "../src/detect/commonMode.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-p40)";

function arg(name: string, d: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
}
async function s3Keys(prefix: string, maxKeys = 2000): Promise<string[]> {
  const r = await fetch(`${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`, { headers: { Accept: "application/xml", "User-Agent": UA } });
  if (!r.ok) throw new Error(`S3 list HTTP ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+\.fits)<\/Key>/g)].map((m) => m[1]!);
}
async function download(key: string): Promise<Uint8Array | null> {
  try { const r = await fetch(`${S3_BASE}/${key}`, { headers: { "User-Agent": UA } }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; }
}

async function main(): Promise<void> {
  const sector = arg("sector", "1");
  const limit = Math.max(10, parseInt(arg("limit", "120"), 10));
  const seed = parseInt(arg("seed", "7"), 10);
  const nNull = Math.max(20, parseInt(arg("nNull", "60"), 10));
  const fapThr = 0.05;
  const sectStr = `s${String(sector).padStart(4, "0")}`;
  const periods = [2, 3, 4, 5, 8, 12];
  const depths = [500, 1000, 2000, 4000, 8000];

  console.log(`[p40] sysFAP safety cert: sector ${sectStr}, ${limit} curves, periods [${periods}] d, depths [${depths}] ppm, nNull ${nNull}, seed ${seed}.`);

  let keys: string[];
  try { keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit); }
  catch (e) { console.log(`[p40] listing failed: ${e instanceof Error ? e.message : e}`); console.log("VERDICT: INCONCLUSIVE-NETWORK"); return; }
  const curves: LightCurve[] = [];
  for (const key of keys) {
    const bytes = await download(key);
    if (!bytes) continue;
    try { const lc = tglcBytesToLightCurve(bytes, key.slice(-30)); if (lc && lc.points.length >= 40) curves.push(lc); } catch { /* skip */ }
  }
  console.log(`[p40] ${curves.length}/${keys.length} usable curves.`);
  if (curves.length < 8) { console.log("[p40] too few curves; VERDICT: NO-USEFUL-DATA"); return; }

  // subtract-then-gate posture: build the residual ensemble + its template ONCE (reused for every candidate).
  const corrected = removeCommonMode(curves, { minStars: 8 }).curves;
  const residualTemplate = commonModeTemplate(corrected);
  console.log(`[p40] residual coherent template after subtraction: ${residualTemplate.applied ? `RMS ${residualTemplate.rmsPpm.toFixed(0)}ppm peak ${residualTemplate.maxAbsPpm.toFixed(0)}ppm` : "NOT APPLIED"}`);

  // For every (period, depth) inject a star-specific transit onto a distinct corrected curve, run the
  // production SNR/depth gate, and -- ONLY when the production chain detects it -- ask whether sysFAP would
  // decline it. det = production detections; lost = detections sysFAP would reject (the safety numerator).
  const grid: Record<string, { det: number; lost: number }> = {};
  let totDet = 0, totLost = 0, trial = 0;
  for (const p of periods) {
    for (const d of depths) {
      let det = 0, lost = 0;
      // spread across up to `curves.length` distinct stars so each injection is one star's own signal
      for (let rep = 0; rep < Math.min(curves.length, 12); rep++) {
        trial++;
        const base = corrected[(trial) % corrected.length]!;
        const withPlanet = injectTransitInto(base, { periodDays: p, depthFrac: d / 1e6, seed: seed + trial });
        try {
          const r = bls(preprocess(withPlanet, 0.5));
          const depthPpm = r.depth * 1e6;
          if (!(depthPpm >= 200 && r.snr >= 7 && classifyDepthRegime(depthPpm).planetPlausible)) continue;
          if (!periodMatched(r.periodDays, p, 5)) continue; // production counts this as a (mis)detection only if period matches; here we grade recoveries
          det++;
          const sys = systematicsAwareFap(withPlanet, r.snr, r.periodDays, corrected, { nNull, seed, template: residualTemplate });
          if (sys.fapSys > fapThr) lost++; // the gate would DECLINE a genuine detected transit
        } catch { /* degenerate */ }
      }
      grid[`${p}d/${d}ppm`] = { det, lost };
      totDet += det; totLost += lost;
      const line = `  P=${String(p).padStart(2)}d @ ${String(d).padStart(4)}ppm : detected ${String(det).padStart(2)}  declined-by-gate ${lost}`;
      console.log(line);
    }
  }

  const safetyRate = totDet > 0 ? (100 * (totDet - totLost) / totDet) : NaN;
  console.log(`\n[p40] ===== SAFETY (subtract-then-gate posture) =====`);
  console.log(`  production-detected genuine transits : ${totDet}`);
  console.log(`  of those, DECLINED by sysFAP          : ${totLost}`);
  console.log(`  => detection-survival (safety)        : ${Number.isFinite(safetyRate) ? safetyRate.toFixed(1) + "%" : "n/a"} (target ~100%)`);

  const verdict = totDet >= 20 && Number.isFinite(safetyRate) && safetyRate >= 95 ? "SAFE-TO-WIRE"
    : totDet < 20 ? "INSUFFICIENT-DETECTIONS"
    : "UNSAFE-KEEPS-REJECTING-REAL-PLANETS";
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const L: string[] = [];
  L.push("# P40 systematics-aware FP gate -- measure-before-gate safety certification");
  L.push("");
  L.push(`Reproduce: \`npm run p40:fp-safety -- --sector ${sector} --limit ${limit} --nNull ${nNull} --seed ${seed}\``);
  L.push(`Data: real TGLC sector ${sector} curves, common-mode subtracted first (the intended subtract-then-gate posture).`);
  L.push(`Residual coherent template after subtraction: RMS ${residualTemplate.rmsPpm.toFixed(0)} ppm / peak ${residualTemplate.maxAbsPpm.toFixed(0)} ppm.`);
  L.push("");
  L.push("Positive control: a star-specific transit injected onto a REAL corrected curve (real noise, gaps and");
  L.push("residual systematics). A genuine detection is one the production SNR>=7 / depth / plausibility gate");
  L.push("accepts AND whose period matches the injection. The safety number is what fraction of those the");
  L.push("systematics-aware gate would then DECLINE -- it must decline ~none, or the gate is unsafe to enable.");
  L.push("");
  L.push("| period | depth ppm | production-detected | declined by sysFAP gate |");
  L.push("|---|---|---|---|");
  for (const p of periods) for (const d of depths) { const c = grid[`${p}d/${d}ppm`]!; L.push(`| ${p} | ${d} | ${c.det} | ${c.lost} |`); }
  L.push("");
  L.push(`## Totals / verdict`);
  L.push("");
  L.push(`- production-detected genuine transits: **${totDet}**`);
  L.push(`- of those, declined by the systematics-aware gate: **${totLost}**`);
  L.push(`- detection-survival (safety rate): **${Number.isFinite(safetyRate) ? safetyRate.toFixed(1) + "%" : "n/a"}** (target ~100%)`);
  L.push(`- VERDICT: **${verdict}**`);
  L.push("");
  L.push("Measure-before-gate: the systematics-aware FP gate may only be wired into the production critic /");
  L.push("candidate contract after this cert shows it declines (near-)none of the real detections. On RAW curves");
  L.push("with a huge coherent systematic the gate correctly declines shallow transits the systematic can explain");
  L.push("(see p39); the production posture is therefore subtract-then-gate. Nothing here gates, anchors, claims");
  L.push("or deploys; wiring into the money path additionally requires explicit operator go-ahead.");
  writeFileSync("reports/p40-fp-safety.md", L.join("\n"));
  writeFileSync("reports/p40-fp-safety.json", JSON.stringify({
    meta: { sector: +sector, limit, nNull, seed, residualTemplateRmsPpm: Math.round(residualTemplate.rmsPpm), residualTemplatePeakPpm: Math.round(residualTemplate.maxAbsPpm), generatedBy: "p40-fp-safety" },
    detected: totDet, declined: totLost, safetyRatePct: Number.isFinite(safetyRate) ? +safetyRate.toFixed(1) : null, verdict,
  }, null, 2));
  console.log(`[p40] wrote reports/p40-fp-safety.md and reports/p40-fp-safety.json`);
}

main().catch((e) => { console.error(`[p40] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("VERDICT: INCONCLUSIVE"); });
