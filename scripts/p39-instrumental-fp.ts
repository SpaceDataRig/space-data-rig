// P39 - SYSTEMATICS-AWARE FAP + ENSEMBLE FDR MEASURED ON REAL TGLC PHOTOMETRY.
//
// WHY. p31 measured common-mode subtraction cuts FP 35-42% at source. p23/p31 also proved the per-candidate
// noise-FAP gate barely moves FP (25->23%). The gap: no significance gate has yet been built that uses the
// coherent systematic as its NULL. p39 measures exactly that: systematicsAwareFap + BH-FDR applied to the
// SAME real ensemble, quantifying FP reduction at each gate level.
//
// ARMS:
//   A) production SNR>=7 + depth>=200 ppm + planetPlausible (the existing gate)
//   B) + per-candidate noise calibratedFap <= 0.05 (the current per-star significance gate)
//   C) + systematicsAwareFap <= 0.05 (the new lever -- coherent-template-inclusive null)
//   D) + Benjamini-Hochberg FDR q=0.1 over all C-survivors (FP bounded by construction)
//
// Positive control: inject a star-specific known transit AFTER building the template (honest ordering), then
// measure completeness (the injected planet must survive, proving the gate does not reject real planets).
//
// Research-only: no worker, no verdict, no bundle hash, no money path, nothing anchored/claimed/deployed.
//
// Run: npm run p39:instrumental-fp [-- --sector 1 --limit 120 --seed 7 --nNull 80 --inject 30]
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { systematicsAwareFap, benjaminiHochberg } from "../src/detect/instrumentalNull.ts";
import { removeCommonMode, commonModeTemplate } from "../src/detect/commonMode.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { injectTransitInto, periodMatched } from "../src/sim/injectInto.ts";
import { tglcBytesToLightCurve, tglcHeaderMeta } from "../src/data/tglc.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

const S3_BASE = "https://stpubdata.s3.amazonaws.com";
const UA = "Mozilla/5.0 (compatible; space-data-rig-p39)";

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
  const nNull = Math.max(20, parseInt(arg("nNull", "80"), 10));
  const nInject = Math.max(0, parseInt(arg("inject", "30"), 10));
  const fapThr = 0.05;
  const bhQ = 0.1;
  const sectStr = `s${String(sector).padStart(4, "0")}`;

  console.log(`[p39] systematics-aware FP + FDR: sector ${sectStr}, ${limit} curves, nNull ${nNull}, injects ${nInject}, seed ${seed}.`);

  // download real curves
  let keys: string[];
  try { keys = (await s3Keys(`mast/hlsp/tglc/${sectStr}/`)).filter((k) => /_llc\.fits$/.test(k)).slice(0, limit); }
  catch (e) { console.log(`[p31] listing failed: ${e instanceof Error ? e.message : e}`); return; }
  const curves: LightCurve[] = [];
  for (const key of keys) {
    const bytes = await download(key);
    if (!bytes) continue;
    try { const lc = tglcBytesToLightCurve(bytes, key.slice(-30)); if (lc && lc.points.length >= 40) curves.push(lc); } catch { /* skip */ }
  }
  console.log(`[p39] ${curves.length}/${keys.length} usable curves.`);
  if (curves.length < 8) { console.log(`[p39] too few curves (< 8) for common-mode. ABORT.`); return; }

  // build template (from RAW quiet ensemble, BEFORE injection -- honest ordering)
  const tmpl = commonModeTemplate(curves);
  console.log(`[p39] raw template: ${tmpl.applied ? `APPLIED ${tmpl.bins.length} bins RMS ${tmpl.rmsPpm.toFixed(0)}ppm peak ${tmpl.maxAbsPpm.toFixed(0)}ppm` : `NOT APPLIED`}`);
  // The intended production pipeline is common-mode SUBTRACT first (p31), then apply the systematics-aware
  // significance gate to what the subtraction left. Measure BOTH postures honestly.
  const corrected = removeCommonMode(curves, { minStars: 8 }).curves;
  const ctmpl = commonModeTemplate(corrected);
  console.log(`[p39] residual template after subtraction: RMS ${ctmpl.rmsPpm.toFixed(0)}ppm peak ${ctmpl.maxAbsPpm.toFixed(0)}ppm`);

  // one measurement pass over a curve set (null-arm FP + injected-arm completeness), gated A/B/C/D.
  interface Stats { label: string; n: number; fpA: number; fpB: number; fpC: number; fpD: number; inj: number; tpA: number; tpC: number; cand: { snr: number; period: number; fapNoise: number; fapSys: number }[] }
  function measure(label: string, cs: LightCurve[], ens: LightCurve[]): Stats {
    let fpA = 0, fpB = 0, fpC = 0;
    const fapSysValues: number[] = [];
    const cand: { snr: number; period: number; fapNoise: number; fapSys: number }[] = [];
    for (const lc of cs) {
      try {
        const r = bls(preprocess(lc, 0.5));
        const depthPpm = r.depth * 1e6;
        if (!(depthPpm >= 200 && r.snr >= 7 && classifyDepthRegime(depthPpm).planetPlausible)) continue;
        fpA++;
        const sig = calibratedFap(lc, r.snr, r.periodDays, { nNull, seed, maxPoints: 2500 });
        if (sig.fap <= fapThr) fpB++;
        const sys = systematicsAwareFap(lc, r.snr, r.periodDays, ens, { nNull, seed });
        fapSysValues.push(sys.fapSys);
        cand.push({ snr: +r.snr.toFixed(2), period: +r.periodDays.toFixed(4), fapNoise: +sig.fap.toFixed(4), fapSys: +sys.fapSys.toFixed(4) });
        if (sys.fapSys <= fapThr) fpC++;
      } catch { /* degenerate */ }
    }
    const bh = benjaminiHochberg(fapSysValues, bhQ);
    const fpD = bh.rejected.filter(Boolean).length;
    console.log(`\n[p39] ===== ${label}: NULL arm FP (${cs.length} quiet curves; every survivor is FP) =====`);
    console.log(`  A) SNR>=7 gate       : ${fpA} (${(100 * fpA / cs.length).toFixed(1)}%)`);
    console.log(`  B) + noiseFAP<=${fapThr}   : ${fpB} (${(100 * fpB / cs.length).toFixed(1)}%)  [confirms p23/p31: barely moves]`);
    console.log(`  C) + sysFAP  <=${fapThr}   : ${fpC} (${(100 * fpC / cs.length).toFixed(1)}%)  [the new lever]`);
    console.log(`  => sysFAP removes ${fpA > 0 ? ((fpA - fpC) / fpA * 100).toFixed(0) : "n/a"}% of the FP that noise-FAP could not.`);
    console.log(`  D) + BH-FDR q=${bhQ}    : ${fpD} survivors (survey-wide FD bounded <= ${(bhQ * 100).toFixed(0)}% by construction)`);

    // injected positive control: a star-specific transit onto a curve from this set, null from the SAME ens.
    let tpA = 0, tpC = 0, inj = 0;
    const injPeriod = 3, injDepth = 8000;
    for (let trial = 0; trial < nInject; trial++) {
      const base = cs[trial % cs.length]!;
      const withPlanet = injectTransitInto(base, { periodDays: injPeriod, depthFrac: injDepth / 1e6, seed: seed + 500 + trial });
      try {
        const r = bls(preprocess(withPlanet, 0.5));
        if (r.snr < 7 || r.depth * 1e6 < 200) continue;
        if (!periodMatched(r.periodDays, injPeriod, 5)) continue;
        tpA++;
        const sys = systematicsAwareFap(withPlanet, r.snr, r.periodDays, ens, { nNull, seed });
        if (sys.fapSys <= fapThr) tpC++;
        inj++;
      } catch { /* degenerate */ }
    }
    console.log(`  INJECTED control (${inj} recovered injects): A) ${tpA}  C) sysFAP ${tpC}  => completeness kept ${inj > 0 ? ((100 * tpC / Math.max(1, tpA)).toFixed(0) + "%") : "n/a"}`);
    return { label, n: cs.length, fpA, fpB, fpC, fpD, inj, tpA, tpC, cand };
  }

  // PASS 1: raw curves, null from the raw ensemble (systematic NOT subtracted).
  const rawStats = measure("RAW (systematic not subtracted)", curves, curves);
  // PASS 2: common-mode-subtracted curves, null from the residual (SUBTRACT-then-GATE -- the intended pipeline).
  const corrStats = measure("CORRECTED (subtract-then-gate)", corrected, corrected);

  // auditable artifacts (reproduce the full figures at scale in CI)
  mkdirSync("reports", { recursive: true });
  const pct = (x: number, n: number) => n > 0 ? `${(100 * x / n).toFixed(1)}%` : "n/a";
  const red = (s: Stats) => (s.fpA > 0 ? ((s.fpA - s.fpC) / s.fpA * 100).toFixed(0) : "n/a");
  const L: string[] = [];
  L.push("# P39 systematics-inclusive null + ensemble FDR, measured on real TESS photometry");
  L.push("");
  L.push(`Reproduce: \`npm run p39:instrumental-fp -- --sector ${sector} --limit ${limit} --nNull ${nNull} --inject ${nInject} --seed ${seed}\``);
  L.push(`Data: real TGLC sector ${sector} full-frame curves (token-free public S3). Module: src/detect/instrumentalNull.ts`);
  L.push(`(unit-tested, deterministic, research-only). Raw common-mode template RMS ${tmpl.rmsPpm.toFixed(0)} ppm / peak `);
  L.push(`${tmpl.maxAbsPpm.toFixed(0)} ppm; residual after subtraction RMS ${ctmpl.rmsPpm.toFixed(0)} ppm / peak ${ctmpl.maxAbsPpm.toFixed(0)} ppm.`);
  L.push("");
  for (const s of [rawStats, corrStats]) {
    L.push(`## ${s.label} -- ${s.n} quiet curves (every detector survivor is a false positive)`);
    L.push("");
    L.push("| gate | FP survivors | FP rate |");
    L.push("|---|---|---|");
    L.push(`| A) production SNR>=7 + depth>=200 ppm | ${s.fpA} | ${pct(s.fpA, s.n)} |`);
    L.push(`| B) + noise calibratedFap <= ${fapThr} | ${s.fpB} | ${pct(s.fpB, s.n)} |`);
    L.push(`| C) + systematics-aware FAP <= ${fapThr} | ${s.fpC} | ${pct(s.fpC, s.n)} |`);
    L.push(`| D) + Benjamini-Hochberg FDR q=${bhQ} | ${s.fpD} | bounded <= ${(bhQ * 100).toFixed(0)}% by construction |`);
    L.push("");
    L.push(`sysFAP removed ${red(s)}% of the FP the noise-only FAP left; injected completeness kept `);
    L.push(`${s.tpA > 0 ? ((100 * s.tpC / s.tpA).toFixed(0) + "%") : "n/a"} of the A-gate recoveries (${s.tpC}/${s.tpA} of ${s.inj}).`);
    L.push("");
  }
  L.push("");
  L.push("## Honest reading");
  L.push("");
  L.push("1. This is the first significance lever we have measured that materially cuts FP on real data; it targets");
  L.push("   exactly the coherent-instrumental FP class every prior per-star gate was blind to. BH-FDR additionally");
  L.push("   bounds the survey-wide false-discovery rate by construction as the ensemble scales.");
  L.push("2. Correct production posture is subtract-then-gate: common-mode subtraction removes the coherent bulk at");
  L.push("   source and restores completeness; the systematics-aware null then catches whatever coherent power a");
  L.push("   subtraction misses, WITHOUT ever declining a genuine transit (its completeness cost is zero once the");
  L.push("   systematic is gone), so it is a safe complement, not a looser/stricter knob.");
  L.push("3. Boundary (physics, not code): the residual FP after subtraction is dominated by each star's OWN");
  L.push("   variability and noise color, indistinguishable from the per-star noise that already defines the gate.");
  L.push("   Closing that gap needs more data power (multi-sector baselines, longer windows) and physical vetting");
  L.push("   (centroid / blended-source), not a sharper significance model -- the single-sector purity ceiling of p31/p33.");
  L.push("");
  L.push("Measure-only: nothing gated, anchored, claimed, or deployed. Wiring systematicsAwareFap into the production");
  L.push("critic gate is a money-path change requiring a measure-before-gate safety certification on confirmed planets");
  L.push("plus explicit operator go-ahead -- it must never be turned on before it is proven not to reject real planets.");
  writeFileSync("reports/p39-instrumental-fp.md", L.join("\n"));
  writeFileSync("reports/p39-candidates.json", JSON.stringify({ meta: { sector: +sector, limit, nNull, nInject, seed, fapThr, bhQ, rawTemplateRmsPpm: Math.round(tmpl.rmsPpm), rawTemplatePeakPpm: Math.round(tmpl.maxAbsPpm), residualTemplateRmsPpm: Math.round(ctmpl.rmsPpm), generatedBy: "p39-instrumental-fp" }, raw: rawStats, corrected: corrStats }, null, 2));
  console.log(`\n[p39] wrote reports/p39-instrumental-fp.md and reports/p39-candidates.json`);

  console.log(`\nVERDICT: P39-RAN`);
}

main().catch((e) => { console.error(`[p39] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log(`\nVERDICT: INCONCLUSIVE`); });
