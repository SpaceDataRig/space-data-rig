// P29 - JOINT multi-sector coherent search, positive control on KNOWN planets (discovery roadmap, Stage 4+).
//
// WHY. p28 (npm run p28:corroboration-proof) measured that a BLIND PER-SECTOR pass cannot corroborate even
// known planets: each 27-day sector resolves the period too coarsely to line the signal up across sectors
// (strict cross-sector corroboration fired 0/10). The fix it pointed to is a JOINT search: stitch the SAME
// host's sectors into one long baseline, fit ONE precise period on it, then CONFIRM that at that ephemeris a
// positive transit actually appears in each independent sector. A long-baseline period is fine enough to keep
// phase coherent across the sectors (for short periods), so the per-sector confirmation becomes meaningful --
// and a single-sector artifact cannot produce a matching dip in the sectors where it was not generated.
//
// This script is again a POSITIVE CONTROL, not a discovery hunt: run the joint method on confirmed planets and
// measure (a) how accurately the joint period recovers catalog truth, and (b) how many planets get a positive
// dip in >=2 independent sectors at that ephemeris. If the joint method corroborates far more known planets
// than p28's per-sector method did (0/10), we have PROVEN the upgrade works and can then point it at NOVEL
// (non-catalog) multi-sector targets with justified confidence. Whatever it finds is reported as-is.
//
// Research probe: no worker import, no verdict, no bundle hash, no money path, nothing anchored/claimed.
//
// Run:  npm run p29:joint-search  [-- --targets 10 --maxsectors 5 --minperiod 1 --maxperiod 13 --tmag 11 --minsectordepth 150]

import { bls } from "../src/detect/bls.ts";
import { foldedBoxDepth } from "../src/detect/shapeCoherence.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const want = Math.max(1, parseInt(arg("targets", "10"), 10));
const maxSectors = Math.max(2, parseInt(arg("maxsectors", "5"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSectorDepthPpm = Number(arg("minsectordepth", "150")); // a sector "confirms" if its folded dip is at least this deep
const matchTolPct = Number(arg("matchtol", "5"));

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

interface Row {
  name: string; catPeriod: number; nSectors: number; jointPeriod: number; jointErrPct: number;
  nSectorsConfirm: number; jointMatched: boolean; corroborated: boolean;
}

async function main(): Promise<void> {
  console.log(
    `P29 JOINT multi-sector search (positive control): ${want} confirmed planets, P in [${minPeriod},${maxPeriod}] d, ` +
    `T<=${tmagCap}, up to ${maxSectors} sectors, per-sector confirm depth>=${minSectorDepthPpm}ppm. REAL photometry; research probe, no discovery claim.`,
  );

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null)
    .slice(0, want * 4);

  const rows: Row[] = [];
  let scanned = 0;
  for (const p of planets) {
    if (rows.length >= want) break;
    scanned++;
    const tic = p.tic!;
    const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
    const catPeriod = p.pl_orbper!;
    let sectors: number[];
    try {
      sectors = await sectorsForCoord(p.ra!, p.dec!);
    } catch {
      continue;
    }
    if (sectors.length < 2) continue;

    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(tic, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) {
      console.log(`  ${name.padEnd(18)} P=${catPeriod.toFixed(3)}d  only ${sectorLcs.length} usable sector(s) -> skip`);
      continue;
    }

    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) { console.log(`  ${name.padEnd(18)} stitch failed -> skip`); continue; }
    let joint;
    try {
      joint = bls(stitched, { maxPeriodDays: maxPeriod + 2 });
    } catch {
      continue;
    }
    const jointErrPct = Math.abs(joint.periodDays - catPeriod) / catPeriod * 100;
    const jointMatched = jointErrPct <= matchTolPct;

    // Confirm the joint ephemeris produces a real, positive, planet-plausible dip in EACH independent sector.
    let nConfirm = 0;
    for (const lc of sectorLcs) {
      const d = foldedBoxDepth(lc, joint.periodDays, joint.epochBjd, joint.durationDays);
      const depthPpm = d.depth * 1e6;
      if (Number.isFinite(depthPpm) && depthPpm >= minSectorDepthPpm && classifyDepthRegime(depthPpm).planetPlausible) nConfirm++;
    }
    const corroborated = jointMatched && nConfirm >= 2;

    const row: Row = { name, catPeriod, nSectors: sectorLcs.length, jointPeriod: joint.periodDays, jointErrPct, nSectorsConfirm: nConfirm, jointMatched, corroborated };
    rows.push(row);
    console.log(
      `  ${name.padEnd(18)} P=${catPeriod.toFixed(3)}d  nsec ${sectorLcs.length}  ` +
      `joint ${joint.periodDays.toFixed(4)} (${jointErrPct.toFixed(2)}%)${jointMatched ? " MATCH" : ""}  ` +
      `confirm ${nConfirm}/${sectorLcs.length} sectors${corroborated ? "  CORROBORATED" : ""}`,
    );
  }

  if (!rows.length) {
    console.log(`\nNo multi-sector planets resolved (TAP/SPOC fallback or too few sectors). scanned=${scanned}. Re-run shortly.`);
    console.log(`\nVERDICT: NO-USEFUL-DATA`);
    return;
  }

  const matched = rows.filter((r) => r.jointMatched).length;
  const corroborated = rows.filter((r) => r.corroborated).length;
  const anyConfirm2 = rows.filter((r) => r.nSectorsConfirm >= 2).length;
  const errs = rows.map((r) => r.jointErrPct).filter(Number.isFinite).sort((a, b) => a - b);
  const medErr = errs.length ? (errs.length % 2 ? errs[(errs.length - 1) / 2] : (errs[errs.length / 2 - 1] + errs[errs.length / 2]) / 2) : NaN;

  console.log(`\n=== P29 SUMMARY (${rows.length} confirmed planets with >=2 usable sectors) ===`);
  console.log(`  joint period within ${matchTolPct}% of catalog truth        : ${matched}/${rows.length}   (median err ${Number.isFinite(medErr) ? medErr.toFixed(2) + "%" : "n/a"})`);
  console.log(`  >=2 sectors confirm a dip at the joint ephemeris : ${anyConfirm2}/${rows.length}`);
  console.log(`  JOINT-CORROBORATED (period matches AND >=2 sectors confirm) : ${corroborated}/${rows.length}`);
  console.log(`  (p28's blind per-sector strict corroboration, same idea    : 0/10)`);

  console.log(
    `\nInterpretation (measure-before-gate): if the joint method corroborates many known planets where the blind ` +
    `per-sector method corroborated none, the upgrade is PROVEN on ground-truth data and a novel-target hunt can ` +
    `legitimately lean on joint-fit period + per-sector confirmation. If it still corroborates few, the limiting ` +
    `factor is raw sensitivity (sector depth/SNR), not the corroboration logic -- and a defensible new-planet claim ` +
    `needs deeper/longer data than a public-FFI hobby pass. Either way this is a self-test on KNOWN planets, not a ` +
    `discovery claim; a real find would additionally require novelty, calibrated structural vetting, and independent follow-up.`,
  );
  console.log(`\nVERDICT: JOINT-SEARCH-RAN`);
}

main().catch((e) => {
  console.error(`[p29] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  console.log(`\nVERDICT: INCONCLUSIVE-NETWORK`);
});
