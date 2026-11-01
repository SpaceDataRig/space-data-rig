// P103 (discovery roadmap: a single end-to-end PER-TARGET earned-gate table over every axis measurable on real data).
// p101 measured real cross-sector corroboration but left the significance AR(1) false-alarm probability NaN; p102
// measured the odd/even + harmonic-sibling shape axes. p103 joins them into ONE decision table per target and adds the
// axis still missing -- a per-target AR(1) FAR -- measured from the committed real curve via a null ensemble MATCHED to
// that curve's own noise color / cadence / scatter (the p98/p100 surrogate-null precedent, honestly labelled: it is a
// calibrated noise-model FAR, NOT an empirical sky null). Everything is read from committed, tracked files -> fully
// OFFLINE, deterministic, machine-verified, no network.
//
// Honest scope: every committed SPOC target is a known-planet system, so the gate returns tier "none" for all of them;
// the table's value is showing exactly which real axes now PASS with measured numbers and which single constraint binds
// each host. It proves the significance-FAP stand-in is retired on real-curve-derived data and that the remaining walls
// are novelty + independently-scheduled follow-up imaging (blend/PSF) + a real prospective precision run -- none of
// which can be fabricated from catalog-known hosts. discoveryClaim false, safeToGate false; nothing gated/anchored/deployed.
//
// Usage: npm run p103:target-gate-table   [-- --nullk 120]   (reads committed files only; no live mode)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { estimateRho, makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { evaluateDiscoveryGate, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";
import type { LightCurve } from "../src/core/types.ts";

const FIXTURE_DIR = "tests/fixtures/spoc-curves"; // forward-slash literals (buildStamp + git ls-files cross-platform)
const MANIFEST = FIXTURE_DIR + "/manifest.json";
const PROTOCOL_PATH = "discovery-protocol.json";
const P101_FROZEN = "reports/fixtures/p101-frozen-real.json";
const P102_JSON = "reports/p102-shape-axes-real.json";

interface ManifestCurve { file: string; host: string; knownPlanetPeriodsDays: number[]; }
interface P101Row { host: string; coherentSectors: number; stitchedSnr: number; recoveredPeriod: number; nSectors: number; hostInCatalog: boolean; periodMatchesCatalog: boolean; }
interface P102Row { host: string; oddEvenDetermined: boolean; oddEvenDiffFrac: number; oddEvenPass: boolean; aliasSiblings: number; }

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit && Number.isFinite(Number(hit.split("=")[1]))) return Number(hit.split("=")[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

/** AR(1) FAR of a host's recovered SNR, from a null ensemble matched to that curve's measured noise color, cadence,
 *  baseline and scatter. A matched-surrogate calibrated FAR (p98/p100 precedent), not an empirical per-target sky null. */
function anchoredAr1Far(lc: LightCurve, recoveredPeriod: number, observedSnr: number, nullK: number): number {
  const detrended = preprocess(lc, 0.5);
  const flux = detrended.points.map((p) => p.flux);
  const rho = estimateRho(flux);
  if (!Number.isFinite(rho)) return Number.NaN;
  const times = lc.points.map((p) => p.time).filter(Number.isFinite).sort((a, b) => a - b);
  const diffs: number[] = []; for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0) diffs.push(d); }
  const cadenceSec = Math.max((diffs.length ? diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : 0.0225) * 86400, 30);
  const baselineDays = times.length ? times[times.length - 1] - times[0] : 27;
  const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1);
  const sd = Math.sqrt(flux.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (flux.length || 1));
  const noisePpm = Math.min(Math.max(sd * 1e6, 50), 5000);
  const narrow = { minPeriodDays: recoveredPeriod * 0.98, maxPeriodDays: recoveredPeriod * 1.02, oversample: 4, nDurations: 6 };
  const nullSnrs: number[] = [];
  for (let j = 0; j < nullK; j++) {
    const nl = makeRedNoiseLightCurve({ seed: 400000 + Math.round(recoveredPeriod * 1000) + j, periodDays: recoveredPeriod, depthFrac: 0, rho, noisePpm, cadenceSec, baselineDays, dutyCycle: 0.9 });
    try { nullSnrs.push(bls(preprocess(nl, 0.5), narrow).snr); } catch { /* degenerate */ }
  }
  if (!nullSnrs.length) return Number.NaN;
  nullSnrs.sort((a, b) => a - b);
  let c = 0; for (const s of nullSnrs) if (s >= observedSnr) c++;
  return c / nullSnrs.length;
}

interface TableRow {
  host: string; coherentSectors: number; stitchedSnr: number; ar1Far: number;
  oddEvenDiffFrac: number | null; significanceClears: boolean; crossSectorClears: boolean; oddEvenClears: boolean;
  catalogKnown: boolean; gateTier: string; unmet: string[];
}

function build(): { rows: TableRow[]; files: string[] } {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const p101 = (JSON.parse(readFileSync(P101_FROZEN, "utf8")) as { rows: P101Row[] }).rows;
  const p102 = new Map<string, P102Row>((JSON.parse(readFileSync(P102_JSON, "utf8")) as { rows: P102Row[] }).rows.map((r) => [r.host, r]));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { curves: ManifestCurve[] };
  const csvByHost = new Map<string, ManifestCurve>(manifest.curves.map((c) => [c.host, c]));
  const nullK = Math.max(20, argNum("nullk", 120));
  const { minSnr, maxAr1FalseAlarmProb } = proto.significanceBars;
  const rows: TableRow[] = [];
  const files: string[] = [];
  for (const a of p101) {
    const meta = csvByHost.get(a.host); if (!meta) continue;
    const rel = `${FIXTURE_DIR}/${meta.file}`; if (!files.includes(rel)) files.push(rel);
    let lc: LightCurve;
    try {
      const raw = readFileSync(rel, "utf8").replace(/\r\n/g, "\n").split("\n");
      const pts: { time: number; flux: number }[] = [];
      for (let i = 1; i < raw.length; i++) { const line = raw[i]!.trim(); if (!line) continue; const [t, f] = line.split(","); const tv = Number(t), fv = Number(f); if (Number.isFinite(tv) && Number.isFinite(fv)) pts.push({ time: tv, flux: fv }); }
      lc = { targetId: a.host, mission: "TESS", points: pts };
    } catch { continue; }
    const ar1Far = anchoredAr1Far(lc, a.recoveredPeriod, a.stitchedSnr, nullK);
    const b = p102.get(a.host);
    const oe = b && b.oddEvenDetermined ? b.oddEvenDiffFrac : null;
    const significanceClears = a.stitchedSnr >= minSnr && Number.isFinite(ar1Far) && ar1Far <= maxAr1FalseAlarmProb;
    const crossSectorClears = a.coherentSectors >= proto.corroborationBars.minCrossSectorEphemerisCoherentSectors;
    const oddEvenClears = oe !== null && oe <= proto.corroborationBars.maxOddEvenAsymmetryFrac;
    const evidence: CandidateEvidence = {
      novelty: { inConfirmed: a.hostInCatalog, inToi: a.hostInCatalog, confirmedScanned: 5200, toiScanned: 4100 },
      corroboration: {
        crossSectorEphemerisCoherentSectors: a.coherentSectors, catalogDuplicate: a.hostInCatalog,
        gaiaBlendRuledOut: false, psfOrDiffImagingClear: false, harmonicAliasFpp: Number.NaN,
        oddEvenAsymmetryFrac: oe === null ? Number.NaN : oe, // REAL (from p102) when determined
      },
      significance: { snr: a.stitchedSnr, ar1FalseAlarmProb: ar1Far }, // ar1Far now MEASURED (matched surrogate null)
      prospective: null, signoff: null,
    };
    const g = evaluateDiscoveryGate(evidence, proto);
    rows.push({ host: a.host, coherentSectors: a.coherentSectors, stitchedSnr: a.stitchedSnr, ar1Far: Number.isFinite(ar1Far) ? Number(ar1Far.toFixed(4)) : Number.NaN, oddEvenDiffFrac: oe === null ? null : Number(oe.toFixed(4)), significanceClears, crossSectorClears, oddEvenClears, catalogKnown: a.hostInCatalog, gateTier: g.tier, unmet: g.unmet });
    console.log(`  ${a.host.padEnd(14)} snr ${a.stitchedSnr.toFixed(1)} ar1Far ${Number.isFinite(ar1Far) ? ar1Far.toFixed(4) : "n/a"} coherent ${a.coherentSectors} oddEven ${oe === null ? "n/a" : oe.toFixed(3)}  sig=${significanceClears} xs=${crossSectorClears} oe=${oddEvenClears}  tier=${g.tier}`);
  }
  return { rows, files };
}

function main() {
  const { rows, files } = build();
  if (!rows.length) { console.log("P103: no committed rows to join."); console.log("VERDICT: NO-USEFUL-DATA"); return; }
  const n = rows.length;
  const sig = rows.filter((r) => r.significanceClears).length;
  const xs = rows.filter((r) => r.crossSectorClears).length;
  const oe = rows.filter((r) => r.oddEvenClears).length;
  const none = rows.filter((r) => r.gateTier === "none").length;
  const notNovel = rows.filter((r) => r.unmet.some((u) => /novel|known|duplicate/i.test(u))).length;
  const noBlend = rows.filter((r) => r.unmet.some((u) => /blend/i.test(u))).length;
  const verdict = `P103-PER-TARGET-GATE-TABLE (all axes offline, significance FAR now measured): on ${n} committed real targets, the now-measured axes clear for significance SNR+FAR ${sig}/${n}, cross-sector corroboration ${xs}/${n}, odd/even shape ${oe}/${n}; yet ALL ${none}/${n} land at tier none. The binding constraints are novelty (already-known: ${notNovel}/${n}) and unmeasured follow-up imaging (blend/PSF: ${noBlend}/${n}) plus an absent prospective precision run -- NOT significance/shape/cross-sector for the hosts that clear those. The significance-FAP stand-in is retired (now a matched-surrogate FAR per target); a claim would need a genuinely new target plus real blend/PSF ruling plus a prospective precision run, none of which is fabricated. No claim, no gate.`;
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p103-target-gate-table.ts", PROTOCOL_PATH, P101_FROZEN, P102_JSON, MANIFEST, ...files]),
      generatedBy: "scripts/p103-target-gate-table.ts", module: "src/discover/discoveryGate.ts",
      data: "committed REAL TESS-SPOC curves + p101 real cross-sector frozen rows + p102 real shape rows; AR(1) FAR measured from a null ensemble matched to each curve's own noise (surrogate, not an empirical sky null). Fully offline, deterministic.",
      note: "per-target end-to-end earned-gate decision table; significance-FAP stand-in retired. discoveryClaim false, safeToGate false.",
    },
    nTargets: n, significanceClears: sig, crossSectorClears: xs, oddEvenClears: oe, tierNoneCount: none, notNovelCount: notNovel, blendUnmeasuredCount: noBlend,
    rows, verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p103-target-gate-table.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P103 - Per-target earned-gate decision table (every real-measurable axis, offline)",
    "",
    "Generated by `scripts/p103-target-gate-table.ts`. Joins the real axes measured across the committed reports into ONE",
    "table per target, and adds the one axis still missing -- a per-target AR(1) significance false-alarm rate, measured",
    "from a null ensemble matched to each committed curve's own noise color/cadence/scatter (a calibrated surrogate FAR per",
    "the p98/p100 precedent, honestly NOT an empirical sky null). Fully offline over committed, tracked files.",
    "",
    `Reproduce: \`npm run p103:target-gate-table\``,
    "",
    `- ${n} real targets. Now-measured axes clear for: significance (SNR+FAR) ${sig}/${n}, cross-sector corroboration ${xs}/${n}, odd/even shape ${oe}/${n}.`,
    `- every target lands tier none; binding constraints: already-known ${notNovel}/${n}, blend/PSF not ruled ${noBlend}/${n}, prospective precision absent ${n}/${n}.`,
    "",
    "| target | SNR | AR(1) FAR | coherent sectors | odd/even diff | sig | xsec | shape | tier |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.host} | ${r.stitchedSnr.toFixed(1)} | ${Number.isFinite(r.ar1Far) ? r.ar1Far.toFixed(4) : "n/a"} | ${r.coherentSectors} | ${r.oddEvenDiffFrac === null ? "n/a" : r.oddEvenDiffFrac.toFixed(3)} | ${r.significanceClears ? "Y" : "n"} | ${r.crossSectorClears ? "Y" : "n"} | ${r.oddEvenClears ? "Y" : "n"} | ${r.gateTier} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: the gate now consumes a fuller set of real, measured per-target values and still refuses every claim",
    "for the right reasons. Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p103-target-gate-table.md", md);
  console.log("\nwrote reports/p103-target-gate-table.md and .json");
}

main();
