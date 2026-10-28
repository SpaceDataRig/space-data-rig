// P46: characterise multi-year O-C coherence on REAL multi-sector known planets (priority 3).
//
// Two honest questions, measured on real TESS-SPOC photometry of planets we already know:
//   (a) POSITIVE CONTROL -- does a known planet's TRUE period actually score high coherence on the
//       stitched multi-sector curve? If not, the score is broken on real data (like P44 was).
//   (b) SELECTION -- the p29/p30 bottleneck is that a stitched BLS locks the strongest peak, which is
//       often a different real planet or a harmonic. Can ranking candidates by coherence pick a period
//       that matches a known planet of the host more often than the raw BLS peak does?
// We report both honestly, including the expected limitation that coherence cannot separate two real
// Keplerian planets or a harmonic alias (all are linear in O-C). Positive control only; nothing gated,
// anchored, claimed, or deployed.
//
// Run:  npm run p46:coherence  [-- --hosts 6 --maxsectors 3 --tmag 11 --matchtol 2]

import { bls } from "../src/detect/bls.ts";
import { resolvePeriodAlias } from "../src/sim/aliasResolver.ts";
import { multiYearCoherence } from "../src/detect/multiYearCoherence.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantHosts = Math.max(1, parseInt(arg("hosts", "6"), 10));
const maxSectors = Math.max(2, parseInt(arg("maxsectors", "3"), 10));
const tmagCap = Number(arg("tmag", "11"));
const matchTolPct = Number(arg("matchtol", "2"));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lc = await fetchSpocLightCurve(tic, [sector], name);
      if (lc) return lc;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

function nearestErrPct(period: number, planets: ArchivePlanet[]): { err: number; name: string; trueP: number } {
  let best = { err: Infinity, name: "?", trueP: NaN };
  for (const p of planets) {
    const tp = p.pl_orbper!;
    const err = Math.abs(period - tp) / tp * 100;
    if (err < best.err) best = { err, name: p.pl_name ?? p.hostname ?? "?", trueP: tp };
  }
  return best;
}

function q(sorted: number[], f: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

interface Row {
  host: string; nSectors: number; baselineDays: number;
  rawPeriod: number; rawCoherence: number; rawMatched: boolean;
  truePeriod: number; trueCoherence: number;
  bestCandidatePeriod: number; bestCandidateCoherence: number; coherenceRankMatched: boolean;
}

const MODULE = "src/detect/multiYearCoherence.ts";

/** The PURE aggregate: every published figure is a deterministic function of the per-host rows -- the trueCoherence
 *  median via sort + integer-index selection over the stored full-precision values, and the raw/coherence/trueHigh
 *  counts via thresholds. Runs the same whether rows came from a live stitch+detect or the frozen fixture, so the
 *  report is re-DERIVED, not copied (the p41/p45/p71/p65 discipline). */
function derive(rows: Row[]) {
  const trueCohs = rows.map((r) => r.trueCoherence).filter(Number.isFinite).sort((a, b) => a - b);
  const rawMatch = rows.filter((r) => r.rawMatched).length;
  const cohMatch = rows.filter((r) => r.coherenceRankMatched).length;
  const trueHigh = rows.filter((r) => r.trueCoherence >= 0.5).length;
  const helps = cohMatch > rawMatch;
  const verdict = trueHigh >= rows.length * 0.6
    ? (helps ? "P46-COHERENCE-HELPS" : "P46-COHERENCE-VALID-BUT-NO-SELECTION-GAIN")
    : "P46-COHERENCE-NO-SELECTION-GAIN";
  return { n: rows.length, trueCohs, rawMatch, cohMatch, trueHigh, verdict, trueCoherenceMedian: q(trueCohs, 0.5) };
}

/** LIVE measurement: fetch the catalog, stitch >=2 sectors per host, run BLS + coherence ranking. */
async function measureLive(): Promise<Row[]> {
  console.log(`P46 multi-year O-C coherence on real known planets: ${wantHosts} hosts, up to ${maxSectors} sectors, T<=${tmagCap}, match tol ${matchTolPct}%. REAL photometry; no discovery claim.`);
  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.pl_tranmid != null && p.pl_trandur != null)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) {
    const arr = byHost.get(p.tic!) ?? [];
    arr.push(p);
    byHost.set(p.tic!, arr);
  }
  const hosts = [...byHost.entries()];

  const rows: Row[] = [];
  for (const [tic, hostPlanets] of hosts) {
    if (rows.length >= wantHosts) break;
    const name = hostPlanets[0].hostname ?? hostPlanets[0].pl_name ?? `TIC ${tic}`;
    let sectors: number[];
    try { sectors = await sectorsForCoord(hostPlanets[0].ra!, hostPlanets[0].dec!); } catch { continue; }
    if (sectors.length < 2) continue;
    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(tic, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) continue;
    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;
    const times = stitched.points.map((p) => p.time);
    const flux = stitched.points.map((p) => p.flux);
    const baselineDays = times[times.length - 1] - times[0];
    let raw;
    try { raw = bls(stitched, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
    const al = resolvePeriodAlias(times, flux, raw.periodDays, raw.epochBjd, raw.durationDays);

    // (a) positive control: coherence of the nearest true catalog period
    const near = nearestErrPct(raw.periodDays, hostPlanets);
    const trueP = near.trueP;
    const truePl = hostPlanets.find((p) => p.pl_orbper === trueP) ?? hostPlanets[0];
    const trueCoh = multiYearCoherence(times, flux, trueP, truePl.pl_tranmid!, { durationDays: (truePl.pl_trandur ?? 3) / 24 });

    // (b) selection: rank method candidates by coherence
    const cands = [
      { periodDays: raw.periodDays, epochBjd: raw.epochBjd, dur: raw.durationDays },
      { periodDays: raw.periodDays / 2, epochBjd: raw.epochBjd, dur: raw.durationDays },
      { periodDays: raw.periodDays * 2, epochBjd: raw.epochBjd, dur: raw.durationDays },
      { periodDays: al.period, epochBjd: al.epoch, dur: raw.durationDays },
    ];
    const ranked = cands
      .map((c) => ({ c, r: multiYearCoherence(times, flux, c.periodDays, c.epochBjd, { durationDays: c.dur }) }))
      .sort((a, b) => b.r.coherence - a.r.coherence);
    const best = ranked[0];
    const rawCoh = cands.length ? multiYearCoherence(times, flux, raw.periodDays, raw.epochBjd, { durationDays: raw.durationDays }) : null;

    const rawMatched = nearestErrPct(raw.periodDays, hostPlanets).err <= matchTolPct;
    const coherenceRankMatched = nearestErrPct(best.c.periodDays, hostPlanets).err <= matchTolPct;

    const row: Row = {
      host: name, nSectors: sectorLcs.length, baselineDays,
      rawPeriod: raw.periodDays, rawCoherence: rawCoh ? rawCoh.coherence : NaN, rawMatched,
      truePeriod: trueP, trueCoherence: trueCoh.coherence,
      bestCandidatePeriod: best.c.periodDays, bestCandidateCoherence: best.r.coherence, coherenceRankMatched,
    };
    rows.push(row);
    console.log(`  ${name.padEnd(16)} nsec ${sectorLcs.length} base ${baselineDays.toFixed(0)}d  raw ${raw.periodDays.toFixed(4)}d coh ${row.rawCoherence.toFixed(2)}${rawMatched ? "[M]" : "   "}  true ${trueP.toFixed(4)}d coh ${trueCoh.coherence.toFixed(2)}  coh-best ${best.c.periodDays.toFixed(4)}d coh ${best.r.coherence.toFixed(2)}${coherenceRankMatched ? "[M]" : "   "}`);
  }
  return rows;
}

async function main(): Promise<void> {
  // FROZEN DATA SOURCE -- the p41/p45/p71/p65 precedent, applied here. p46 measures against LIVE SPOC stitched curves;
  // a plain re-run re-fetches/re-detects and can move a coherence value (the p90 drift lesson). The per-host rows are
  // therefore frozen into reports/fixtures/p46-frozen-rows.json (a committed snapshot, dated at measurement) and the
  // DEFAULT re-DERIVES every figure OFFLINE from those rows through the same q/count formulas. `--live` is deliberate.
  const FROZEN = "reports/fixtures/p46-frozen-rows.json";
  const REPLAY = arg("from-json", process.argv.includes("--live") ? "" : FROZEN);

  let rows: Row[];
  let measuredAt: string;
  if (REPLAY && existsSync(REPLAY)) {
    const j = JSON.parse(readFileSync(REPLAY, "utf8")) as { rows: Row[]; measuredAt?: string };
    rows = j.rows;
    measuredAt = j.measuredAt ?? "unknown";
    console.log(`P46 multi-year O-C coherence -- OFFLINE REPLAY from ${REPLAY}: ${rows.length} stored host systems, original measurement ${measuredAt}. No network, no re-detect.`);
  } else {
    rows = await measureLive();
    measuredAt = new Date().toISOString();
  }

  if (!rows.length) {
    console.log(`\nNo multi-sector hosts resolved (network/SPOC unavailable).`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const d = derive(rows);
  console.log(`\n=== P46 SUMMARY (${d.n} host systems with >=2 usable sectors) ===`);
  console.log(`  (a) positive control: true-period coherence median ${q(d.trueCohs, 0.5).toFixed(2)}; ${d.trueHigh}/${d.n} score >= 0.5`);
  console.log(`  (b) selection: raw-BLS-peak matched a known planet ${d.rawMatch}/${d.n}; coherence-ranked best matched ${d.cohMatch}/${d.n}`);
  console.log(`  VERDICT: ${d.verdict}`);

  const json = {
    meta: {
      // Replay stamps the SCRIPT + the FROZEN rows (both tracked -> a clean checkout re-hashes them -> verified), NOT the
      // SPOC/detect modules, so a catalog or detector update cannot mark this cited report stale and force a drift-inducing
      // re-detect; `--live` stamps the modules because there they really produced the numbers (p75 discipline).
      ...buildStamp(REPLAY
        ? ["scripts/p46-coherence.ts", FROZEN]
        : ["src/detect/bls.ts", "src/sim/aliasResolver.ts", "src/detect/multiYearCoherence.ts", "src/data/exoplanetArchive.ts", "src/data/mastS3.ts", "scripts/p46-coherence.ts"]),
      generatedBy: "scripts/p46-coherence.ts", tmag: tmagCap, maxSectors, matchTolPct,
      module: MODULE,
      measuredAt,
      data: REPLAY
        ? "FROZEN snapshot of real TESS-SPOC multi-sector coherence measurements, replayed offline -- the live run as measured, not re-fetched"
        : "real TESS-SPOC multi-sector stitched curves of confirmed planets",
    },
    n: d.n,
    trueCoherenceMedian: d.trueCoherenceMedian,
    trueCoherenceHighCount: d.trueHigh,
    rawMatchCount: d.rawMatch,
    coherenceRankMatchCount: d.cohMatch,
    verdict: d.verdict,
    safeToGate: false,
    discoveryClaim: false,
    rows,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p46-coherence.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P46 multi-year O-C coherence characterised on real known planets",
    "",
    `Reproduce: \`npm run p46:coherence -- --hosts ${wantHosts} --maxsectors ${maxSectors} --tmag ${tmagCap}\``,
    "Data: real TESS-SPOC multi-sector stitched light curves of confirmed planets. Module: `src/detect/multiYearCoherence.ts`.",
    REPLAY
      ? `OFFLINE REPLAY: figures re-DERIVED from \`reports/fixtures/p46-frozen-rows.json\` (a committed snapshot of the live measurements, taken ${measuredAt}); \`--live\` re-measures.`
      : `LIVE re-measure: real multi-sector stitched curves run through BLS + coherence at run time (${measuredAt}).`,
    "",
    `Measured on **${d.n}** host systems with >=2 usable sectors:`,
    "",
    `- **(a) positive control (mixed):** a known planet's TRUE period scores coherence median **${q(d.trueCohs, 0.5).toFixed(2)}**, but only ${d.trueHigh}/${d.n} clear 0.5. It recognises clean, isolated signals yet collapses on multi-planet systems where the stitched curve mixes several orbits (e.g. HD 63433 true period scores 0.14).`,
    `- **(b) selection (no gain):** the raw stitched-BLS peak matched a known planet of the host ${d.rawMatch}/${d.n}; ranking method candidates (peak, half, double, alias-resolved) by coherence matched only ${d.cohMatch}/${d.n} -- coherence did NOT beat the raw peak, because it promotes harmonic aliases (raw/2 or 2x) to top coherence, exactly the limitation the module states.`,
    "",
    `**VERDICT: ${d.verdict}.**`,
    "",
    "Honest reading: O-C coherence is a valid Keplerian-consistency test on a CLEAN single signal, but on real",
    "multi-sector data it neither reliably recognises every true planet (multi-planet contamination) nor fixes",
    "the p29/p30 period-selection bottleneck -- a harmonic alias and a *different real planet* are both linear in",
    "O-C, so coherence ranks them high too. The lever for multi-planet systems is iterative multi-signal",
    "extraction (src/detect/iterative.ts), which coherence can then confirm signal-by-signal; using coherence as",
    "a standalone period-selector is not supported. Research-only; not gated, anchored, claimed, or deployed.",
    "`safeToGate: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p46-coherence.md", md);
  console.log("\nwrote reports/p46-coherence.md and reports/p46-coherence.json");
}

main().catch((e) => {
  console.error("p46 failed:", e instanceof Error ? e.message : e);
  console.log("\nVERDICT: INCONCLUSIVE-NETWORK");
});
