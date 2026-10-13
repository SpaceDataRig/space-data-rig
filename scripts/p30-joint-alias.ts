// P30 - JOINT search + ALIAS DISAMBIGUATION, scored PER HOST SYSTEM (discovery roadmap, Stage 4+).
//
// WHY. p29 proved the joint multi-sector corroboration ENGINE works (precise period + per-sector dip
// confirmation on 7/10 known planets) but its "did it match the ONE planet we queried" score was a harsh 1/10.
// Two honest reasons: (a) a stitched BLS sometimes locks a half/double PERIOD ALIAS, and (b) in a MULTI-PLANET
// system the strongest signal is a REAL but DIFFERENT planet around the same star -- a correct detection we were
// penalising for. p30 fixes both:
//   * disambiguation: run the production odd/even alias resolver (resolvePeriodAlias) on the stitched curve to
//     undo P/2 / P/3 aliases before scoring;
//   * fair scoring: group the catalog by HOST and credit the method for recovering ANY planet orbit in that
//     system (the honest question a blind search faces is "is there a planet here", not "did you guess which one").
// We report the RAW (pre-resolution) match rate next to the RESOLVED one so the disambiguation's real benefit is
// visible, not asserted.
//
// Positive control on KNOWN planets -- a capability self-test, NOT a discovery claim. Research probe: no worker
// import, no verdict, no bundle hash, no money path, nothing anchored/claimed/deployed.
//
// Run:  npm run p30:joint-alias  [-- --hosts 10 --maxsectors 5 --minperiod 1 --maxperiod 13 --tmag 11 --minsectordepth 150]

import { bls } from "../src/detect/bls.ts";
import { foldedBoxDepth } from "../src/detect/shapeCoherence.ts";
import { resolvePeriodAlias } from "../src/sim/aliasResolver.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const wantHosts = Math.max(1, parseInt(arg("hosts", "10"), 10));
const maxSectors = Math.max(2, parseInt(arg("maxsectors", "5"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSectorDepthPpm = Number(arg("minsectordepth", "150"));
const matchTolPct = Number(arg("matchtol", "2"));

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lc = await fetchSpocLightCurve(tic, [sector], name);
      if (lc) return lc;
    } catch { /* transient; retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

// nearest catalog period among a host's planets, as a relative % error.
function nearestErrPct(period: number, planets: ArchivePlanet[]): { err: number; name: string; trueP: number } {
  let best = { err: Infinity, name: "?", trueP: NaN };
  for (const p of planets) {
    const tp = p.pl_orbper!;
    const err = Math.abs(period - tp) / tp * 100;
    if (err < best.err) best = { err, name: p.pl_name ?? p.hostname ?? "?", trueP: tp };
  }
  return best;
}

interface Row {
  host: string; nPlanets: number; nSectors: number; rawPeriod: number; resolvedPeriod: number; multiple: number;
  rawErr: number; resolvedErr: number; nConfirm: number;
  rawMatched: boolean; resolvedMatched: boolean; corroborated: boolean; nearest: string;
}

async function main(): Promise<void> {
  console.log(
    `P30 joint search + alias disambiguation, scored per HOST system: ${wantHosts} hosts, P in [${minPeriod},${maxPeriod}] d, ` +
    `T<=${tmagCap}, up to ${maxSectors} sectors, per-sector confirm depth>=${minSectorDepthPpm}ppm, match tol ${matchTolPct}%. REAL photometry; no discovery claim.`,
  );

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null);

  // group by host; keep hosts that have at least one in-range planet
  const byHost = new Map<number, ArchivePlanet[]>();
  for (const p of planets) {
    const arr = byHost.get(p.tic!) ?? [];
    arr.push(p);
    byHost.set(p.tic!, arr);
  }
  const hosts = [...byHost.entries()].slice(0, wantHosts * 4);

  const rows: Row[] = [];
  for (const [tic, hostPlanets] of hosts) {
    if (rows.length >= wantHosts) break;
    const name = hostPlanets[0].pl_name ?? hostPlanets[0].hostname ?? `TIC ${tic}`;
    let sectors: number[];
    try {
      sectors = await sectorsForCoord(hostPlanets[0].ra!, hostPlanets[0].dec!);
    } catch {
      continue;
    }
    if (sectors.length < 2) continue;

    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(tic, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) continue;

    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;
    let raw;
    try {
      raw = bls(stitched, { maxPeriodDays: maxPeriod + 2 });
    } catch {
      continue;
    }
    const sTimes = stitched.points.map((p) => p.time);
    const sFlux = stitched.points.map((p) => p.flux);
    const al = resolvePeriodAlias(sTimes, sFlux, raw.periodDays, raw.epochBjd, raw.durationDays);

    const rawNear = nearestErrPct(raw.periodDays, hostPlanets);
    const resNear = nearestErrPct(al.period, hostPlanets);
    const rawMatched = rawNear.err <= matchTolPct;
    const resolvedMatched = resNear.err <= matchTolPct;

    let nConfirm = 0;
    for (const lc of sectorLcs) {
      const d = foldedBoxDepth(lc, al.period, al.epoch, raw.durationDays);
      const depthPpm = d.depth * 1e6;
      if (Number.isFinite(depthPpm) && depthPpm >= minSectorDepthPpm && classifyDepthRegime(depthPpm).planetPlausible) nConfirm++;
    }
    const corroborated = resolvedMatched && nConfirm >= 2;

    const row: Row = {
      host: name, nPlanets: hostPlanets.length, nSectors: sectorLcs.length,
      rawPeriod: raw.periodDays, resolvedPeriod: al.period, multiple: al.multiple,
      rawErr: rawNear.err, resolvedErr: resNear.err, nConfirm,
      rawMatched, resolvedMatched, corroborated, nearest: resNear.name,
    };
    rows.push(row);
    console.log(
      `  ${name.padEnd(16)} (${hostPlanets.length} pl) nsec ${sectorLcs.length}  ` +
      `raw ${raw.periodDays.toFixed(4)}d [${rawNear.err.toFixed(1)}%]${rawMatched ? "M" : " "}  ` +
      `x${al.multiple}-> ${al.period.toFixed(4)}d [${resNear.err.toFixed(1)}%]${resolvedMatched ? "M" : " "} ` +
      `vs ${resNear.name}  confirm ${nConfirm}  ${corroborated ? "CORROBORATED" : ""}`,
    );
  }

  if (!rows.length) {
    console.log(`\nNo multi-sector hosts resolved. Re-run shortly.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const rawMatch = rows.filter((r) => r.rawMatched).length;
  const resMatch = rows.filter((r) => r.resolvedMatched).length;
  const corroborated = rows.filter((r) => r.corroborated).length;
  const aliasFixed = rows.filter((r) => r.multiple > 1).length;
  const aliasHelped = rows.filter((r) => r.resolvedMatched && !r.rawMatched).length;

  console.log(`\n=== P30 SUMMARY (${rows.length} host systems with >=2 usable sectors) ===`);
  console.log(`  RAW joint period matched a known planet of the host : ${rawMatch}/${rows.length}`);
  console.log(`  ALIAS-RESOLVED period matched a known planet         : ${resMatch}/${rows.length}   (resolver changed period on ${aliasFixed} hosts; rescued ${aliasHelped})`);
  console.log(`  SYSTEM-CORROBORATED (resolved match AND >=2 sectors) : ${corroborated}/${rows.length}`);
  console.log(`  (p29 scored per QUERIED planet and got 1/10; per-SYSTEM is the honest frame)`);

  console.log(
    `\nInterpretation (measure-before-gate): scoring per host system and resolving period aliases is the fair test ` +
    `of whether the joint method re-finds REAL planets -- a multi-planet star lighting up on its strongest orbit is ` +
    `a success, not a miss. If the system-corroborated rate is high, the joint+disambiguation pipeline is ` +
    `discovery-capable and ready to point at NOVEL (non-catalog) multi-sector hosts. If aliases remain or recovery ` +
    `is still patchy, the honest limit is that a single strongest-period fit cannot separate co-orbiting planets -- ` +
    `a real survey needs iterative multi-signature extraction. Positive control on known planets only; nothing ` +
    `gated, anchored, claimed, or deployed.`,
  );
  console.log(`\nVERDICT: JOINT-ALIAS-RAN`);
}

main().catch((e) => {
  console.error(`[p30] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
