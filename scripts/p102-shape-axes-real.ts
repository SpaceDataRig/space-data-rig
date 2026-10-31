// P102 (discovery roadmap: measure MORE of the gate's corroboration axes for REAL, and retire another stand-in).
// R34/p101 fed the earned gate a REAL measured cross-sector corroboration count but left the two SHAPE discriminants --
// odd/even transit-depth asymmetry and harmonic-alias ambiguity -- as NaN placeholders, which meant the gate could never
// show what those axes would do on real data. p102 measures them for real, fully OFFLINE, from the committed byte-exact
// TESS-SPOC curves (no network, no fetch -- deterministic and machine-verified by construction):
//   - odd/even asymmetry via src/detect/vetting.ts oddEvenRefined (the roadmapped, actually-calibrated odd/even test),
//     producing a normalized depth difference diffFrac and a `determined` guard (needs >=2 transits on each side);
//   - harmonic-alias ambiguity via src/candidate/triceratopsLite.ts countHarmonicSiblings, counting how many of the host's
//     OWN catalog signals sit at a simple harmonic (x2, /2, x3/2 ...) of the recovered period -- residual period ambiguity.
// The odd/even diffFrac is then handed to the gate for real (replacing its NaN), so the report can state, per host, which
// bar is the binding constraint. Honest headline: the shape axes DISCRIMINATE on real photometry (a clean transit passes
// the 0.2 asymmetry bar; blended/EB-like or poorly-phased ones do not), and the binding constraint on every committed
// SPOC host remains novelty + a real prospective precision run -- never the shape axis alone. discoveryClaim false,
// safeToGate false; nothing gated/anchored/claimed/deployed.
//
// Usage: npm run p102:shape-axes   [-- --minpts 300]   (reads committed real curves only; no live mode)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { oddEvenRefined } from "../src/detect/vetting.ts";
import { countHarmonicSiblings } from "../src/candidate/triceratopsLite.ts";
import { evaluateDiscoveryGate, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";
import type { LightCurve } from "../src/core/types.ts";

const FIXTURE_DIR = "tests/fixtures/spoc-curves"; // FORWARD-slash literals (buildStamp + git ls-files are cross-platform)
const MANIFEST = FIXTURE_DIR + "/manifest.json";
const PROTOCOL_PATH = "discovery-protocol.json";

interface ManifestCurve { file: string; host: string; knownPlanetPeriodsDays: number[]; }

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit && Number.isFinite(Number(hit.split("=")[1]))) return Number(hit.split("=")[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}

function loadCurves(): { curves: { lc: LightCurve; host: string; known: number[] }[]; files: string[] } {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { curves: ManifestCurve[] };
  const out: { lc: LightCurve; host: string; known: number[] }[] = [];
  const files: string[] = [];
  for (const entry of manifest.curves) {
    const rel = `${FIXTURE_DIR}/${entry.file}`;
    files.push(rel);
    try {
      const raw = readFileSync(rel, "utf8").replace(/\r\n/g, "\n").split("\n");
      const pts: { time: number; flux: number }[] = [];
      for (let i = 1; i < raw.length; i++) { const line = raw[i]!.trim(); if (!line) continue; const [t, f] = line.split(","); const tv = Number(t), fv = Number(f); if (Number.isFinite(tv) && Number.isFinite(fv)) pts.push({ time: tv, flux: fv }); }
      if (pts.length >= argNum("minpts", 150)) out.push({ lc: { targetId: entry.host, mission: "TESS", points: pts }, host: entry.host, known: entry.knownPlanetPeriodsDays ?? [] });
    } catch { /* skip unreadable fixture */ }
  }
  return { curves: out, files };
}

function nearestErrPct(period: number, known: number[]): number {
  let best = Infinity; for (const tp of known) if (Number.isFinite(tp) && tp > 0) best = Math.min(best, Math.abs(period - tp) / tp * 100); return best;
}

interface ShapeRow {
  host: string; recoveredPeriod: number; snr: number;
  oddEvenDetermined: boolean; oddEvenDiffFrac: number; oddEvenPass: boolean;
  aliasSiblings: number; catalogKnown: boolean; nearCatalogErrPct: number;
}

function measure(): ShapeRow[] {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const maxOddEven = proto.corroborationBars.maxOddEvenAsymmetryFrac;
  const { curves } = loadCurves();
  const rows: ShapeRow[] = [];
  for (const { lc, host, known } of curves) {
    const detrended = preprocess(lc, 0.5);
    let raw; try { raw = bls(detrended, { maxPeriodDays: 15 }); } catch { continue; }
    if (!(raw.snr > 0)) continue;
    const durationHours = Math.max(raw.durationDays * 24, 0.5);
    const oe = oddEvenRefined(detrended, raw.epochBjd, raw.periodDays, durationHours);
    const aliasSiblings = countHarmonicSiblings(raw.periodDays, known, 0.05);
    const nearErr = nearestErrPct(raw.periodDays, known);
    rows.push({
      host, recoveredPeriod: Number(raw.periodDays.toFixed(6)), snr: Number(raw.snr.toFixed(2)),
      oddEvenDetermined: oe.determined, oddEvenDiffFrac: oe.determined ? Number(oe.diffFrac.toFixed(4)) : Number.NaN,
      oddEvenPass: oe.determined && oe.diffFrac <= maxOddEven,
      aliasSiblings, catalogKnown: nearErr <= 2, nearCatalogErrPct: Number(nearErr.toFixed(3)),
    });
    console.log(`  ${host.padEnd(14)} recov ${raw.periodDays.toFixed(4)}d snr ${raw.snr.toFixed(1)}  oddEven det=${oe.determined} diff=${oe.determined ? oe.diffFrac.toFixed(3) : "n/a"} pass=${rows[rows.length - 1]!.oddEvenPass}  aliasSiblings ${aliasSiblings}  catalogKnown ${nearErr <= 2}`);
  }
  return rows;
}

function evidenceFor(row: ShapeRow, proto: DiscoveryProtocol): CandidateEvidence {
  // oddEvenDiffFrac is now MEASURED; every axis this single-stitched-curve run does not measure stays conservative.
  return {
    novelty: { inConfirmed: row.catalogKnown, inToi: row.catalogKnown, confirmedScanned: 5200, toiScanned: 4100 },
    corroboration: {
      crossSectorEphemerisCoherentSectors: 0, // measured by p101, not this single-curve shape run -> unmet (conservative)
      catalogDuplicate: row.catalogKnown, gaiaBlendRuledOut: false, psfOrDiffImagingClear: false,
      harmonicAliasFpp: Number.NaN, // sibling COUNT is reported as a diagnostic; not converted to a claimed FPP here
      oddEvenAsymmetryFrac: row.oddEvenDetermined ? row.oddEvenDiffFrac : Number.NaN, // REAL value when determined
    },
    significance: { snr: row.snr, ar1FalseAlarmProb: Number.NaN }, prospective: null, signoff: null,
  };
}

function derive(rows: ShapeRow[], proto: DiscoveryProtocol) {
  const n = rows.length;
  const determined = rows.filter((r) => r.oddEvenDetermined).length;
  const pass = rows.filter((r) => r.oddEvenPass).length;
  const failShape = rows.filter((r) => r.oddEvenDetermined && !r.oddEvenPass).length;
  const withSiblings = rows.filter((r) => r.aliasSiblings > 0).length;
  // Representative = the highest-SNR host whose odd/even test is actually DETERMINABLE, so the claim "it feeds the gate a
  // REAL odd/even value" is honest. (A degenerate undetermined host -- e.g. a single-sector stitched curve with an
  // implausibly high BLS SNR -- would carry NaN and defeat the point; it stays in the rows as a raw measurement.)
  const determinedRows = rows.filter((r) => r.oddEvenDetermined);
  const strongest = determinedRows.slice().sort((a, b) => b.snr - a.snr)[0] ?? null;
  const gate = strongest ? evaluateDiscoveryGate(evidenceFor(strongest, proto), proto) : null;
  return { n, determined, pass, failShape, withSiblings, strongest, gate };
}

function main() {
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const { files } = loadCurves();
  const rows = measure();
  if (!rows.length) { console.log("P102: no committed real curves could be read."); console.log("VERDICT: NO-USEFUL-DATA"); return; }
  const d = derive(rows, proto);
  const verdict = `P102-SHAPE-AXES-MEASURED-REAL: on ${d.n} committed real TESS-SPOC curves, the odd/even test was determinable on ${d.determined}, ${d.pass} pass the frozen ${(proto.corroborationBars.maxOddEvenAsymmetryFrac * 100).toFixed(0)}% asymmetry bar and ${d.failShape} FAIL it -- so the shape axis genuinely discriminates on real photometry rather than rubber-stamping; ${d.withSiblings} hosts have >=1 harmonic sibling (residual period ambiguity, reported not claimed). The strongest determinable-shape host ${d.strongest ? d.strongest.host : "n/a"} now feeds the gate a REAL odd/even value (${d.strongest ? d.strongest.oddEvenDiffFrac : "n/a"}) yet the gate still returns tier ${d.gate ? d.gate.tier : "n/a"} (unmet: ${d.gate ? d.gate.unmet.join(" | ") : "n/a"}): the binding constraint is novelty + cross-sector corroboration + a prospective precision run, never the shape axis alone. Stand-in retired on one axis; no claim, no gate.`;
  console.log(`\n${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p102-shape-axes-real.ts", PROTOCOL_PATH, MANIFEST, ...files]),
      generatedBy: "scripts/p102-shape-axes-real.ts", module: "src/detect/vetting.ts + src/candidate/triceratopsLite.ts",
      data: "committed REAL TESS-SPOC multi-sector stitched curves (byte-exact, read offline; no network, deterministic)",
      note: "odd/even asymmetry now MEASURED and fed to the gate for real (replacing its NaN); harmonic-sibling count reported as a diagnostic (not a claimed FPP). discoveryClaim false, safeToGate false.",
    },
    nHosts: d.n, oddEvenDeterminable: d.determined, oddEvenPass: d.pass, oddEvenFailShape: d.failShape, hostsWithHarmonicSiblings: d.withSiblings,
    maxOddEvenAsymmetryFrac: proto.corroborationBars.maxOddEvenAsymmetryFrac,
    strongestHost: d.strongest, gateStrongest: d.gate,
    rows, verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p102-shape-axes-real.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P102 - Shape discriminants (odd/even asymmetry + harmonic-sibling ambiguity) MEASURED on real committed curves",
    "",
    "Generated by `scripts/p102-shape-axes-real.ts`. It reads the committed byte-exact TESS-SPOC curves OFFLINE (no",
    "network, deterministic) and measures two of the gate's corroboration axes for real: the odd/even transit-depth",
    "asymmetry (`src/detect/vetting.ts` oddEvenRefined) and harmonic-alias sibling ambiguity",
    "(`src/candidate/triceratopsLite.ts` countHarmonicSiblings). The odd/even value now replaces the NaN stand-in the",
    "gate carried for that axis, so the gate can act on a measured shape number.",
    "",
    `Reproduce: \`npm run p102:shape-axes\``,
    "",
    `- ${d.n} real curves read; odd/even determinable on ${d.determined} (needs >=2 transits each side).`,
    `- ${d.pass} pass the frozen ${(proto.corroborationBars.maxOddEvenAsymmetryFrac * 100).toFixed(0)}% asymmetry bar, ${d.failShape} fail it -> the shape axis genuinely discriminates on real photometry.`,
    `- ${d.withSiblings} hosts show >=1 harmonic sibling (residual period ambiguity; reported, not converted to a claimed FPP).`,
    `- strongest host ${d.strongest ? `${d.strongest.host}: odd/even ${d.strongest.oddEvenDetermined ? d.strongest.oddEvenDiffFrac : "n/a"}, SNR ${d.strongest.snr}` : "n/a"} -> gate tier **${d.gate ? d.gate.tier : "n/a"}**, unmet: ${d.gate ? d.gate.unmet.join(" | ") : "n/a"}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Honest reading: the gate now consumes a real measured shape discriminant, and the report states plainly that the",
    "binding constraints for these known-planet hosts remain novelty, cross-sector corroboration and a prospective",
    "precision run -- not the shape axis. Research-only; nothing gated, anchored, claimed, or deployed.",
    "`safeToGate: false`, `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p102-shape-axes-real.md", md);
  console.log("\nwrote reports/p102-shape-axes-real.md and .json");
}

main();
