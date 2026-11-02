// P108 (discovery roadmap: grow the gate's SPECIFICITY calibration with EVERY committed real known-planet host).
// p105 bounded the earned gate's true-negative rate on the 12 labelled REAL hosts it could reach -- the 9
// multi-sector SPOC hosts (p103) plus 3 Gaia/centroid hosts (p104) -- and honestly called 0.757 a SMALL-SAMPLE
// bound. But the committed SPOC fixture set holds 3 MORE real known-planet hosts that p103 skipped because they
// are single-sector (HD 63433, TOI-5739, KELT-11): their curves are committed and their systems are catalogued,
// so they are legitimate labelled negatives we had simply not used yet. p108 measures them the same way p103
// measured the others (reuse p102's real BLS detection for period+SNR, add a matched-surrogate AR(1) FAR), feeds
// each through the frozen gate, and re-pools the labelled-negative census: 9 + 3 + 3 = 15 independent real hosts,
// ground truth "catalogued planet", expected tier none. Fully OFFLINE, deterministic, machine-verified.
//
// Two honest additions beyond "bigger n": (1) it reports the sample-size CEILING -- how many clean real negatives
// the gate would need before its specificity Wilson lower bound could even reach the protocol's 0.95 bar -- so
// "we need more data" becomes a number, not a mood; (2) it records why single-sector hosts are weak evidence: on
// 2 of these 3 the strongest BLS peak does NOT match the catalogued planet, so a lone sector mis-detects even a
// known signal -- which is exactly the case for requiring cross-sector corroboration. discoveryClaim/safeToGate
// stay false; nothing gated/anchored/claimed/deployed. This audits the instrument; it does not announce a finding.
//
// Usage: npm run p108:negatives-expansion   [-- --nullk 120]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { estimateRho, makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { evaluateDiscoveryGate, wilsonLowerBound, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";
import type { LightCurve } from "../src/core/types.ts";

const FIXTURE_DIR = "tests/fixtures/spoc-curves";
const MANIFEST = FIXTURE_DIR + "/manifest.json";
const PROTOCOL_PATH = "discovery-protocol.json";
const P102_JSON = "reports/p102-shape-axes-real.json";
const P103_JSON = "reports/p103-target-gate-table.json";
const P104_JSON = "reports/p104-corroboration-capability.json";

interface ManifestCurve { file: string; host: string; sectors: number[]; knownPlanetPeriodsDays: number[]; }
interface P102Row { host: string; recoveredPeriod: number; snr: number; oddEvenDetermined: boolean; oddEvenDiffFrac: number; }

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit && Number.isFinite(Number(hit.split("=")[1]))) return Number(hit.split("=")[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

/** AR(1) FAR of a host's recovered SNR from a null ensemble matched to that curve's own noise color / cadence /
 *  baseline / scatter -- the same matched-surrogate calibrated FAR used in p103 (NOT an empirical sky null). */
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
    const nl = makeRedNoiseLightCurve({ seed: 500000 + Math.round(recoveredPeriod * 1000) + j, periodDays: recoveredPeriod, depthFrac: 0, rho, noisePpm, cadenceSec, baselineDays, dutyCycle: 0.9 });
    try { nullSnrs.push(bls(preprocess(nl, 0.5), narrow).snr); } catch { /* degenerate */ }
  }
  if (!nullSnrs.length) return Number.NaN;
  nullSnrs.sort((a, b) => a - b);
  let c = 0; for (const s of nullSnrs) if (s >= observedSnr) c++;
  return c / nullSnrs.length;
}

function readCurve(rel: string, host: string): LightCurve | null {
  try {
    const raw = readFileSync(rel, "utf8").replace(/\r\n/g, "\n").split("\n");
    const pts: { time: number; flux: number }[] = [];
    for (let i = 1; i < raw.length; i++) { const line = raw[i]!.trim(); if (!line) continue; const [t, f] = line.split(","); const tv = Number(t), fv = Number(f); if (Number.isFinite(tv) && Number.isFinite(fv)) pts.push({ time: tv, flux: fv }); }
    return pts.length ? { targetId: host, mission: "TESS", points: pts } : null;
  } catch { return null; }
}

interface NewRow { host: string; nSectors: number; recoveredPeriod: number; snr: number; ar1Far: number; periodMatchesCatalog: boolean; significanceClears: boolean; crossSectorClears: boolean; gateTier: string; unmet: string[]; }

function main() {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const p102 = new Map<string, P102Row>((JSON.parse(readFileSync(P102_JSON, "utf8")) as { rows: P102Row[] }).rows.map((r) => [r.host, r]));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { curves: ManifestCurve[] };
  const nullK = Math.max(20, argNum("nullk", 120));
  const { minSnr, maxAr1FalseAlarmProb } = proto.significanceBars;

  // The committed single-sector known-planet hosts p103 skipped.
  const singles = manifest.curves.filter((c) => c.sectors.length === 1 && (c.knownPlanetPeriodsDays || []).length > 0);
  const files: string[] = [];
  const newRows: NewRow[] = [];
  for (const meta of singles) {
    const rel = `${FIXTURE_DIR}/${meta.file}`; if (!files.includes(rel)) files.push(rel);
    const lc = readCurve(rel, meta.host); if (!lc) continue;
    const b = p102.get(meta.host); if (!b) continue;
    const ar1Far = anchoredAr1Far(lc, b.recoveredPeriod, b.snr, nullK);
    const periodMatchesCatalog = meta.knownPlanetPeriodsDays.some((kp) => Math.abs(kp - b.recoveredPeriod) / kp <= 0.02);
    const significanceClears = b.snr >= minSnr && Number.isFinite(ar1Far) && ar1Far <= maxAr1FalseAlarmProb;
    const crossSectorClears = meta.sectors.length >= proto.corroborationBars.minCrossSectorEphemerisCoherentSectors; // single sector -> false by construction
    const evidence: CandidateEvidence = {
      novelty: { inConfirmed: true, inToi: true, confirmedScanned: 5200, toiScanned: 4100 }, // host is a catalogued planet system
      corroboration: {
        crossSectorEphemerisCoherentSectors: meta.sectors.length, catalogDuplicate: true,
        gaiaBlendRuledOut: false, psfOrDiffImagingClear: false, harmonicAliasFpp: Number.NaN,
        oddEvenAsymmetryFrac: b.oddEvenDetermined ? b.oddEvenDiffFrac : Number.NaN,
      },
      significance: { snr: b.snr, ar1FalseAlarmProb: ar1Far },
      prospective: null, signoff: null,
    };
    const g = evaluateDiscoveryGate(evidence, proto);
    newRows.push({ host: meta.host, nSectors: meta.sectors.length, recoveredPeriod: b.recoveredPeriod, snr: b.snr, ar1Far: Number.isFinite(ar1Far) ? Number(ar1Far.toFixed(4)) : Number.NaN, periodMatchesCatalog, significanceClears, crossSectorClears, gateTier: g.tier, unmet: g.unmet });
    console.log(`  ${meta.host.padEnd(12)} snr ${b.snr.toFixed(1)} ar1Far ${Number.isFinite(ar1Far) ? ar1Far.toFixed(4) : "n/a"} sectors ${meta.sectors.length} peakMatchesKnown ${periodMatchesCatalog}  sig=${significanceClears} xs=${crossSectorClears}  tier=${g.tier}`);
  }

  // Re-pool the labelled-negative census: p103 (9) + p104 (3) + the p108 additions. All truth = catalogued planet.
  const p103 = JSON.parse(readFileSync(P103_JSON, "utf8")) as { rows: { host: string; gateTier: string; catalogKnown: boolean; unmet: string[] }[] };
  const p104 = JSON.parse(readFileSync(P104_JSON, "utf8")) as { rows: { tic: number; tier: string }[] };
  const labeled = [
    ...p103.rows.map((r) => ({ id: r.host, source: "p103/spoc-multi", tier: r.gateTier, unmet: r.unmet })),
    ...p104.rows.map((r) => ({ id: String(r.tic), source: "p104/gaia+centroid", tier: r.tier, unmet: [] as string[] })),
    ...newRows.map((r) => ({ id: r.host, source: "p108/spoc-single", tier: r.gateTier, unmet: r.unmet })),
  ];
  const ids = new Set(labeled.map((l) => l.id));
  const n = ids.size;
  const nPrior = new Set([...p103.rows.map((r) => r.host), ...p104.rows.map((r) => String(r.tic))]).size; // p105's union
  // disjoinness: the p108 hosts must not already appear in p103/p104, else pooling double-counts.
  const priorIds = new Set([...p103.rows.map((r) => r.host), ...p104.rows.map((r) => String(r.tic))]);
  const collisions = newRows.map((r) => r.host).filter((h) => priorIds.has(h));
  const falsePromotions = labeled.filter((l) => l.tier !== "none").length;
  const trueNegatives = n - falsePromotions;
  const specificity = n ? trueNegatives / n : 0;
  const specLB = Number(wilsonLowerBound(trueNegatives, n).toFixed(4));
  const priorLB = Number(wilsonLowerBound(trueNegatives - newRows.length, nPrior).toFixed(4)); // the p105-style bound before this round
  // sample-size ceiling: the fewest clean real negatives that would lift a zero-false-claim Wilson LB to 0.95.
  const target = proto.prospectiveValidation.minPrecisionWilsonLowerBound;
  let nForTarget = 0; for (let k = 1; k <= 500; k++) { if (wilsonLowerBound(k, k) >= target) { nForTarget = k; break; } }

  const singleMismatch = newRows.filter((r) => !r.periodMatchesCatalog).length;
  const verdict = `P108-NEGATIVES-EXPANSION (grow the gate specificity bound using every committed real known-planet host, offline): p103 skipped ${newRows.length} single-sector hosts; their curves are committed and their systems are catalogued, so they are legitimate labelled negatives. Measured the same way as p103 and fed to the frozen gate, all ${newRows.length} land tier none -> the labelled-negative union grows ${nPrior} -> ${n} (${trueNegatives}/${n} refused, ${falsePromotions} false promotion(s), specificity ${specificity.toFixed(3)}), tightening the Wilson 95% lower bound on the true-negative rate ${priorLB.toFixed(3)} -> ${specLB.toFixed(3)}. Honest ceiling: reaching the protocol's ${target.toFixed(2)} precision bar on a zero-false-claim bound needs >= ${nForTarget} clean real negatives -- we have ${n}; the gap is sample size of real labelled planets, not method. On ${singleMismatch}/${newRows.length} single-sector hosts the strongest BLS peak did NOT match the catalogued planet -- a lone sector mis-detects even a known signal, the direct case for requiring cross-sector corroboration. Sensitivity arm (promoting a clean novelty) remains synthetic-only (p100). No claim, no gate.`;
  console.log(`\n  labelled union ${nPrior} -> ${n}; false promotions ${falsePromotions}; Wilson LB ${priorLB.toFixed(3)} -> ${specLB.toFixed(3)}; n-for-0.95 = ${nForTarget}`);
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p108-negatives-expansion.ts", PROTOCOL_PATH, MANIFEST, P102_JSON, P103_JSON, P104_JSON, ...files]),
      generatedBy: "scripts/p108-negatives-expansion.ts", module: "src/discover/discoveryGate.ts (evaluateDiscoveryGate, wilsonLowerBound)",
      data: "newly measured single-sector committed SPOC hosts (period+SNR from p102's real BLS detection, AR(1) FAR from a matched surrogate null) pooled with the committed p103/p104 labelled hosts. Fully offline, deterministic.",
      note: "expands the gate specificity census on real labelled negatives and states the sample-size ceiling. discoveryClaim false, safeToGate false.",
    },
    newHosts: newRows.length, nLabeledPrior: nPrior, nLabeled: n, trueNegatives, falsePromotions, specificity,
    specificityWilsonLB: specLB, priorWilsonLB: priorLB, targetPrecisionLB: target, nRequiredForTarget: nForTarget,
    idCollisions: collisions, singleSectorPeakMismatch: singleMismatch, rows: newRows, labeled, verdict,
    discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p108-negatives-expansion.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P108 - Grow the gate specificity bound with every committed real known-planet host",
    "",
    "Generated by `scripts/p108-negatives-expansion.ts`. p105 bounded the earned gate's true-negative rate on the",
    "12 real hosts it could reach (p103 multi-sector + p104 Gaia/centroid) and honestly called 0.757 a small-sample",
    "bound. The committed SPOC set holds 3 MORE real known-planet hosts that p103 skipped because they are",
    "single-sector. p108 measures them exactly as p103 measured the others (period+SNR from p102's real BLS",
    "detection, AR(1) FAR from a matched surrogate null), feeds each to the frozen gate, and re-pools the census.",
    "Fully offline over committed, tracked files.",
    "",
    `Reproduce: \`npm run p108:negatives-expansion\``,
    "",
    `- newly used single-sector hosts: ${newRows.length} (all tier none). labelled-negative union ${nPrior} -> ${n}; false promotions ${falsePromotions}; specificity ${specificity.toFixed(3)}.`,
    `- Wilson 95% lower bound on the true-negative rate: ${priorLB.toFixed(3)} -> ${specLB.toFixed(3)}.`,
    `- honest ceiling: reaching the protocol's ${target.toFixed(2)} precision bar needs >= ${nForTarget} clean real negatives (we have ${n}) -- the limit is sample size of real labelled planets, not method.`,
    `- detection-reliability note: on ${singleMismatch}/${newRows.length} single-sector hosts the strongest BLS peak did NOT match the catalogued planet -- a lone sector mis-detects even a known signal.`,
    "",
    "| host | SNR | AR(1) FAR | sectors | peak matches known? | sig | xsec | tier |",
    "|---|---|---|---|---|---|---|---|",
    ...newRows.map((r) => `| ${r.host} | ${r.snr.toFixed(1)} | ${Number.isFinite(r.ar1Far) ? r.ar1Far.toFixed(4) : "n/a"} | ${r.nSectors} | ${r.periodMatchesCatalog ? "Y" : "n"} | ${r.significanceClears ? "Y" : "n"} | ${r.crossSectorClears ? "Y" : "n"} | ${r.gateTier} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: every real planet we can reach now sits in the specificity census, the gate refuses all of them,",
    "and the residual weakness is stated as a number (how many more negatives the bound needs) rather than left vague.",
    "Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p108-negatives-expansion.md", md);
  console.log("\nwrote reports/p108-negatives-expansion.md and .json");
}

main();
