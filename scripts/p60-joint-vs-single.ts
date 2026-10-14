// P60 - JOINT multi-sector search vs the SINGLE-sector path, head-to-head re-find rate on known
// planets (third-party roadmap, highest priority; the measurement that must come BEFORE anyone even
// discusses relaxing the discoveryClaim hard limit -- which this project will NOT do here).
//
// WHAT P29 LEFT OPEN. p29 runs the joint (stitched long-baseline) fit and compares its corroboration to
// p28's BLIND PER-SECTOR trigger (0/10) -- a different metric. The reviewer's precise standard is a direct
// A/B: on the SAME multi-sector known planets, how many does a single-sector BLS re-find, versus how many
// does the joint BLS re-find? Only a clear lift justifies ever leaning on the joint path for novel targets.
//
// THIS SCRIPT. For every confirmed planet with >= 2 usable real TESS-SPOC sectors, run BOTH arms with a
// production-like detector (bls + SNR gate + period-match tolerance):
//   SINGLE arm  -- bls() each sector on its own; a planet is "re-found" if ANY single sector, at its best,
//                  clears minSnr AND its period is within tolPct of catalog truth;
//   JOINT arm   -- bls() the stitched baseline; "re-found" if the joint period clears minSnr AND matches;
//                  plus p29's phase-coherent confirmation (a >=minDepth positive, planet-plausible dip at the
//                  joint ephemeris in >=2 independent sectors) as the corroborating check.
// We report the re-find rates, the lift in percentage points, and the mean best-single vs joint SNR to show
// the mechanism (longer baseline -> finer period + higher SNR). Positive control ONLY, on known planets:
// research probe, no worker import, no verdict / bundle hash / money path, nothing anchored or claimed.
//
// Run: npm run p60:joint-vs-single  [-- --targets 20 --maxsectors 4 --minperiod 1 --maxperiod 13 --tmag 11 --minsnr 7 --tol 5 --minsectordepth 150]

import { writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { foldedBoxDepth } from "../src/detect/shapeCoherence.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const want = Math.max(1, parseInt(arg("targets", "20"), 10));
const maxSectors = Math.max(2, parseInt(arg("maxsectors", "4"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSnr = Number(arg("minsnr", "7"));
const tolPct = Number(arg("tol", "5"));
const minSectorDepthPpm = Number(arg("minsectordepth", "150"));

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

interface Row {
  name: string; catPeriod: number; nSectors: number;
  bestSinglePeriod: number; bestSingleSnr: number; singleRecovered: boolean;
  jointPeriod: number; jointSnr: number; jointRecovered: boolean; nSectorsConfirm: number; jointCorroborated: boolean;
}

const matched = (period: number, cat: number) => Number.isFinite(period) && Math.abs(period - cat) / cat * 100 <= tolPct;

async function main(): Promise<void> {
  console.log(`P60 JOINT vs SINGLE re-find (positive control): up to ${want} confirmed planets, P in [${minPeriod},${maxPeriod}]d, T<=${tmagCap}, <=${maxSectors} sectors, minSnr ${minSnr}, tol ${tolPct}%. REAL SPOC photometry, token-free; no discovery claim.`);

  const planets = (await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 })).planets
    .filter((p) => p.pl_orbper != null && p.pl_orbper >= minPeriod && p.pl_orbper <= maxPeriod)
    .filter((p) => p.tic != null && p.ra != null && p.dec != null)
    .slice(0, want * 5);

  const rows: Row[] = [];
  for (const p of planets) {
    if (rows.length >= want) break;
    const tic = p.tic!;
    const name = p.pl_name ?? p.hostname ?? `TIC ${tic}`;
    const catPeriod = p.pl_orbper!;
    let sectors: number[];
    try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (sectors.length < 2) continue;

    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(tic, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) { console.log(`  ${name.padEnd(16)} P=${catPeriod.toFixed(3)}d  ${sectorLcs.length} usable sector(s) -> skip`); continue; }

    // SINGLE arm: bls each sector; best-SNR sector; recovered if ANY sector clears minSnr AND matches.
    let bestSingle = { periodDays: NaN, snr: -Infinity };
    let singleRecovered = false;
    for (const lc of sectorLcs) {
      let b; try { b = bls(lc, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
      if (b.snr > bestSingle.snr) bestSingle = { periodDays: b.periodDays, snr: b.snr };
      if (b.snr >= minSnr && matched(b.periodDays, catPeriod)) singleRecovered = true;
    }

    // JOINT arm: bls the stitched long baseline.
    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;
    let joint; try { joint = bls(stitched, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
    const jointRecovered = joint.snr >= minSnr && matched(joint.periodDays, catPeriod);

    // phase-coherent confirmation: at the joint ephemeris, a real positive dip appears in each sector.
    let nConfirm = 0;
    for (const lc of sectorLcs) {
      const d = foldedBoxDepth(lc, joint.periodDays, joint.epochBjd, joint.durationDays);
      const depthPpm = d.depth * 1e6;
      if (Number.isFinite(depthPpm) && depthPpm >= minSectorDepthPpm && classifyDepthRegime(depthPpm).planetPlausible) nConfirm++;
    }
    const jointCorroborated = jointRecovered && nConfirm >= 2;

    rows.push({ name, catPeriod, nSectors: sectorLcs.length, bestSinglePeriod: bestSingle.periodDays, bestSingleSnr: bestSingle.snr, singleRecovered, jointPeriod: joint.periodDays, jointSnr: joint.snr, jointRecovered, nSectorsConfirm: nConfirm, jointCorroborated });
    console.log(`  ${name.padEnd(16)} P=${catPeriod.toFixed(3)}d  nsec ${sectorLcs.length}  single[best SNR ${bestSingle.snr.toFixed(1)} ${singleRecovered ? "REFIND" : "-"}]  joint[SNR ${joint.snr.toFixed(1)} ${jointRecovered ? "REFIND" : "-"}${jointCorroborated ? " CORROB" : ""}]`);
  }

  if (rows.length < 5) {
    console.log(`\nonly ${rows.length} multi-sector planets resolved (TAP/SPOC fallback?). VERDICT: INSUFFICIENT-DATA (re-run shortly)`);
    process.exitCode = 0; return;
  }

  const n = rows.length;
  const single = rows.filter((r) => r.singleRecovered).length;
  const joint = rows.filter((r) => r.jointRecovered).length;
  const corrob = rows.filter((r) => r.jointCorroborated).length;
  const meanBestSingle = rows.reduce((a, r) => a + r.bestSingleSnr, 0) / n;
  const meanJointSnr = rows.reduce((a, r) => a + r.jointSnr, 0) / n;
  const liftPp = (100 * (joint - single) / n);
  // planets the JOINT arm re-finds that the SINGLE arm misses (and vice-versa) -- the operative A/B delta.
  const jointOnly = rows.filter((r) => r.jointRecovered && !r.singleRecovered).length;
  const singleOnly = rows.filter((r) => r.singleRecovered && !r.jointRecovered).length;
  const [sLo, sHi] = wilsonInterval(single, n);
  const [jLo, jHi] = wilsonInterval(joint, n);

  console.log(`\n=== P60 SUMMARY (${n} confirmed planets with >=2 usable sectors) ===`);
  console.log(`  SINGLE-sector re-find (any sector SNR>=${minSnr} & within ${tolPct}%): ${single}/${n} = ${(100 * single / n).toFixed(1)}%  [${(100 * sLo).toFixed(0)}, ${(100 * sHi).toFixed(0)}]`);
  console.log(`  JOINT re-find        (stitched baseline SNR>=${minSnr} & within ${tolPct}%): ${joint}/${n} = ${(100 * joint / n).toFixed(1)}%  [${(100 * jLo).toFixed(0)}, ${(100 * jHi).toFixed(0)}]`);
  console.log(`  JOINT corroborated (re-find + >=2 sectors confirm at joint ephemeris): ${corrob}/${n}`);
  console.log(`  lift JOINT - SINGLE: ${liftPp >= 0 ? "+" : ""}${liftPp.toFixed(1)} pp   (joint-only re-finds ${jointOnly}, single-only ${singleOnly})`);
  console.log(`  mean best-single SNR ${meanBestSingle.toFixed(1)} vs joint SNR ${meanJointSnr.toFixed(1)}  (longer baseline -> higher SNR / finer period)`);
  const clearLift = jointOnly > singleOnly && liftPp >= 10;
  console.log(`\nVERDICT: ${clearLift ? "JOINT-BEATS-SINGLE (clear re-find lift; the joint path is worth leaning on for a future novel-target hunt -- which still requires novelty + calibrated vetting + independent follow-up, and discoveryClaim stays false here)" : joint > single ? "JOINT-MODEST-EDGE (small lift; Wilson intervals overlap -- not yet decisive)" : "NO-JOINT-ADVANTAGE (stitching does not re-find more known planets than the single path here)"}`);
  console.log(`  measure-before-gate: this is a self-test on KNOWN planets. A positive-control lift justifies USING the joint fit for a novel hunt; it is NOT itself a discovery and does NOT relax any gate. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      generatedBy: "scripts/p60-joint-vs-single.ts", n, maxSectors, minPeriod, maxPeriod, tmagCap, minSnr, tolPct, minSectorDepthPpm,
      arms: "SINGLE = best of independent per-sector bls(); JOINT = bls() on the stitched long baseline; corroboration = joint re-find + >=2 sectors confirm a dip at the joint ephemeris",
      data: "real TESS-SPOC light curves (token-free public S3), confirmed-planet catalog",
      note: "positive-control A/B of joint vs single-sector re-find on known planets; NOT a discovery claim; nothing gated.",
    },
    singleRefind: { count: single, n, rate: single / n, ciLow: sLo, ciHigh: sHi },
    jointRefind: { count: joint, n, rate: joint / n, ciLow: jLo, ciHigh: jHi },
    jointCorroborated: { count: corrob, n },
    liftPp,
    jointOnly, singleOnly,
    meanBestSingleSnr: meanBestSingle, meanJointSnr,
    verdict: clearLift ? "JOINT-BEATS-SINGLE" : joint > single ? "JOINT-MODEST-EDGE" : "NO-JOINT-ADVANTAGE",
    discoveryClaim: false,
    rows,
  };
  writeFileSync("reports/p60-joint-vs-single.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P60 joint multi-sector search vs the single-sector path: a head-to-head re-find test",
    "",
    `Reproduce: \`npm run p60:joint-vs-single -- --targets ${want} --maxsectors ${maxSectors} --tmag ${tmagCap} --minsnr ${minSnr} --tol ${tolPct}\``,
    "On **${n}** confirmed planets that have >= 2 usable real TESS-SPOC sectors, both arms run the same",
    "production-like detector (BLS + SNR>=${minSnr} + period within ${tolPct}% of catalog truth): the SINGLE arm",
    "takes the best independent sector, the JOINT arm folds the stitched long baseline. Positive control on",
    "known planets -- this measures whether the joint upgrade actually re-finds more, the prerequisite to",
    "ever leaning on it for novel targets.",
    "",
    `| arm | re-find | 95% Wilson CI | mean SNR |`,
    `|---|---|---|---|`,
    `| single-sector (best) | ${single}/${n} = ${(100 * single / n).toFixed(1)}% | [${(100 * sLo).toFixed(0)}, ${(100 * sHi).toFixed(0)}] | ${meanBestSingle.toFixed(1)} |`,
    `| joint (stitched) | ${joint}/${n} = ${(100 * joint / n).toFixed(1)}% | [${(100 * jLo).toFixed(0)}, ${(100 * jHi).toFixed(0)}] | ${meanJointSnr.toFixed(1)} |`,
    "",
    `Joint corroborated (re-find + >=2 sectors confirm at the joint ephemeris): ${corrob}/${n}.`,
    `Lift JOINT - SINGLE = ${liftPp >= 0 ? "+" : ""}${liftPp.toFixed(1)} pp; joint-only re-finds ${jointOnly}, single-only ${singleOnly}.`,
    "",
    `**VERDICT: ${json.verdict}.** ${clearLift ? "The joint path re-finds a clear margin more known planets, so a future novel-target hunt can justifiably use joint-fit period + per-sector phase-coherent confirmation -- but that hunt still requires novelty, calibrated structural vetting, and independent follow-up; this is a positive control, not a discovery, and no gate is relaxed." : "The joint path does not clearly beat the single path on this sample; there is NO justification to lean on it for a discovery claim."}`,
    "",
    "Discovery claims stay structurally false; nothing here is gated, anchored, or deployed.",
    "",
  ].join("\n").replace(/\$\{n\}/g, String(n)).replace(/\$\{minSnr\}/g, String(minSnr)).replace(/\$\{tolPct\}/g, String(tolPct));
  writeFileSync("reports/p60-joint-vs-single.md", md);
  console.log("\nwrote reports/p60-joint-vs-single.md and reports/p60-joint-vs-single.json");
}

main().catch((e) => { console.error(`[p60] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
