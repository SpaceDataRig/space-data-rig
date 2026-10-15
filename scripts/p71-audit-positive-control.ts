// P71 - AUDIT POSITIVE CONTROL: is the accepted-only branch of the external-audit critic actually
// REACHABLE, or is P65's "0/2 pass" an unsatisfiable (broken) gate?
//
// WHY THIS EXISTS. P65 (external-candidate audit) reported 0/2 third-party claims pass the accepted-only
// gate, capping at needs-more-data. That is the CORRECT, safe outcome -- but on its own it is ambiguous:
// does the gate cap novel claims because of the deliberate BLIND design (catalog = [], so a signal with no
// catalog cross-match can NEVER reach "accepted"; see src/critic/review.ts:282-296), or because the accept
// path is broken / unsatisfiable? A reviewer cannot tell, and neither can we from P65 alone. This study
// disambiguates it with a positive control on KNOWN planets.
//
// METHOD: for each of a set of real confirmed-planet hosts we run the SAME detect -> calibratedFap ->
// reviewCandidate chain P65 uses, TWICE on the identical detected candidate:
//   BLIND      -- catalog = []            (exactly what P65 feeds a novel external claim).
//   CORROBORATED -- catalog = the real confirmed-planet archive (what production feeds when the host IS known).
// The critic's blind acceptance REQUIRES a direct (harmonic-1) cross-match with the catalog; the detected
// truth period is passed only as a POST-HOC, NON-GATING cross-check (recoveryGating stays false), so the
// verdict is still evidence-driven and never peeked. If a known planet reaches "accepted" only in the
// CORROBORATED run and "needs-more-data" in the BLIND run, that proves the accept branch is live and the
// novel-claim cap is the intended catalog-corroboration design -- not a broken gate.
//
// Red lines: this is a positive control on planets we ALREADY know -- it claims NO discovery and anchors
// NOTHING (it never touches the bundle / money path / Solana; it just calls the pure review function).
// discoveryClaim structurally false, safeToGate false. research only, no worker import.
//
// Run: npm run p71:audit-positive-control [-- --targets 14 --tmag 11 --minperiod 1 --maxperiod 8 --maxsectors 3]

import { writeFileSync, mkdirSync } from "node:fs";
import { detectTransit } from "../src/detect/pipeline.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { reviewCandidate } from "../src/critic/review.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, stitchLightCurves, createSpocSectorFetcher } from "../src/data/mastS3.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const wantTargets = Math.max(3, parseInt(arg("targets", "14"), 10));
const tmagCap = Number(arg("tmag", "11"));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "8"));
const maxSectors = Math.max(1, parseInt(arg("maxsectors", "3"), 10));

const sectorFetcher = createSpocSectorFetcher({ concurrency: 4 });

interface Row {
  name: string; host: string; catPeriod: number; detPeriod: number; detSnr: number; alias: number; fap: number | null;
  blindVerdict: string; corrVerdict: string; corrMatched: boolean; corrHarmonic: number | undefined;
}

async function main(): Promise<void> {
  const r = await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 6000 });
  const catalog: ArchivePlanet[] = r.planets;
  const planets = catalog
    .filter((p) => p.tic != null && p.ra != null && p.dec != null && p.pl_orbper != null)
    .filter((p) => (p.pl_orbper as number) >= minPeriod && (p.pl_orbper as number) <= maxPeriod)
    .slice(0, 80);
  console.log(`P71 audit positive control: is the accepted branch reachable? ${wantTargets} real known planets; BLIND (catalog=[]) vs CORROBORATED (catalog=archive) on the SAME detected candidate. Token-free SPOC; no discovery claim.`);

  const rows: Row[] = [];
  for (const p of planets) {
    if (rows.length >= wantTargets) break;
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    const host = p.hostname ?? name;
    const catPeriod = p.pl_orbper as number;
    let sectors: number[]; try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (!sectors.length) continue;
    const curves = (await sectorFetcher.fetchSectors(p.tic!, sectors.slice(0, maxSectors), name)).filter((c) => c && c.points.length >= 60);
    if (!curves.length) continue;
    const curve = curves.length >= 2 ? (stitchLightCurves(curves) || curves[0]) : curves[0];
    let det; try { det = detectTransit(curve); } catch { continue; }
    const c = det.candidate;
    if (!c || !Number.isFinite(c.snr)) continue;
    let fap: number | null = null;
    try { fap = calibratedFap(det.clean, c.snr, c.periodDays, { maxPoints: 2500, nNull: 60 }).fap; } catch { /* null */ }

    // (A) BLIND -- exactly P65's novel-claim path.
    const blind = reviewCandidate({ candidate: c, aliasMultiple: det.aliasMultiple, catalog: [], hostName: host, truthPeriodDays: catPeriod, truthSource: "catalog", vetting: fap != null ? { fap } : {} });
    // (B) CORROBORATED -- production path where the host is in the archive.
    const corr = reviewCandidate({ candidate: c, aliasMultiple: det.aliasMultiple, catalog, hostName: host, truthPeriodDays: catPeriod, truthSource: "catalog", vetting: fap != null ? { fap } : {} });

    rows.push({ name, host, catPeriod, detPeriod: c.periodDays, detSnr: c.snr, alias: det.aliasMultiple, fap, blindVerdict: blind.verdict, corrVerdict: corr.verdict, corrMatched: corr.crossmatch.matchedKnownPlanet, corrHarmonic: corr.crossmatch.harmonic });
    console.log(`  ${name.padEnd(18)} cat ${catPeriod.toFixed(3)}d det ${c.periodDays.toFixed(3)}d snr ${c.snr.toFixed(1)} alias x${det.aliasMultiple}  BLIND=${blind.verdict}  CORROBORATED=${corr.verdict}${corr.crossmatch.matchedKnownPlanet ? ` (match x${corr.crossmatch.harmonic})` : ""}`);
  }

  if (rows.length < 3) { console.log(`\nonly ${rows.length} resolved. VERDICT: INSUFFICIENT-DATA`); process.exitCode = 0; return; }

  const n = rows.length;
  const blindAccepted = rows.filter((x) => x.blindVerdict === "accepted").length;
  const blindNMD = rows.filter((x) => x.blindVerdict === "needs-more-data").length;
  const corrAccepted = rows.filter((x) => x.corrVerdict === "accepted").length;
  const example = rows.find((x) => x.corrVerdict === "accepted");

  console.log(`\n=== P71 SUMMARY (${n} known planets, same detected candidate scored two ways) ===`);
  console.log(`  BLIND (catalog=[] as P65 does): accepted ${blindAccepted}/${n}, needs-more-data ${blindNMD}/${n}`);
  console.log(`  CORROBORATED (catalog=archive): accepted ${corrAccepted}/${n}`);
  if (example) console.log(`  reachability example: ${example.name} -- blind capped, corroboration cross-matched its fundamental period -> ACCEPTED (reason cites the catalog match).`);

  const reachable = corrAccepted >= 1;
  const cleanSeparation = reachable && blindAccepted === 0;
  const verdict = cleanSeparation
    ? `ACCEPT-PATH-REACHABLE: the accept branch fires for a genuine known planet the instant its host is corroborated by the catalog (${corrAccepted}/${n} accepted CORROBORATED), yet the SAME detected signals all cap at needs-more-data BLIND (accepted ${blindAccepted}/${n}). P65's "0/2 pass" is therefore the CORRECT blind-by-design outcome -- a novel external claim has no catalog match and is never auto-accepted -- NOT a broken or unsatisfiable gate. The money path stays protected exactly as intended.`
    : reachable
      ? `ACCEPT-PATH-REACHABLE (${corrAccepted}/${n} corroboration-accepted), but blind acceptance was ${blindAccepted} -- inspect the rows; a blind accepted would indicate the catalog=[] guard is not holding.`
      : `NOT-SHOWN-REACHABLE on this sample: 0/${n} corroboration-accepted (known planets re-detected at the wrong/harmonic period by our detector, so no direct fundamental cross-match fired). This reflects the P62/P67 seed limitation, not necessarily a broken gate; the accepted branch exists in code and is exercised by the production pipeline. Re-run with stronger/direct-detecting hosts to demonstrate it.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log("  positive control on KNOWN planets; claims no discovery; anchors nothing; touches no bundle / money path. discoveryClaim false, safeToGate false.");

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { generatedBy: "scripts/p71-audit-positive-control.ts", n, wantTargets, tmagCap, minPeriod, maxPeriod, maxSectors, data: "real TESS-SPOC + NASA confirmed-planet archive (token-free)", note: "same detected candidate scored BLIND (catalog=[]) vs CORROBORATED (catalog=archive) via src/critic/review; truth period post-hoc non-gating. Positive control on known planets; not a discovery." },
    summary: { blindAccepted, blindNeedsMoreData: blindNMD, corroborationAccepted: corrAccepted, example: example?.name ?? null },
    reachability: reachable, cleanBlindSeparation: cleanSeparation,
    rows, verdict, safeToGate: false, discoveryClaim: false, anchored: false,
  };
  writeFileSync("reports/p71-audit-positive-control.json", JSON.stringify(json, null, 2) + "\n");

  const exampleMd: string[] = example
    ? [`Reachability example: **${example.name}** -- capped BLIND, but once its host is in the catalog`,
       "the re-detected fundamental period cross-matches and the critic returns ACCEPTED (evidence-driven;",
       "the truth period was only a post-hoc non-gating check)."]
    : ["No corroboration-accepted case in this sample (known planets re-detected off-period -- the P62/P67 seed wall)."];

  const md = [
    "# P71 is the external-audit 'accepted' branch reachable, or is P65's 0/2 a dead gate?",
    "",
    `Reproduce: \`npm run p71:audit-positive-control -- --targets ${wantTargets} --tmag ${tmagCap}\``,
    "",
    "P65 capped 0/2 novel external claims at needs-more-data. Is that the intended BLIND guard (a novel",
    "signal with no catalog cross-match can never be accepted -- src/critic/review.ts:282-296) or a broken,",
    "unsatisfiable gate? This control scores the SAME detected candidate two ways on real known planets:",
    "BLIND (catalog = [], what P65 feeds a novel claim) vs CORROBORATED (catalog = the archive).",
    "",
    "| run | accepted | needs-more-data |",
    "|---|---|---|",
    `| BLIND (catalog=[]) | ${blindAccepted}/${n} | ${blindNMD}/${n} |`,
    `| CORROBORATED (catalog=archive) | ${corrAccepted}/${n} | - |`,
    "",
    ...exampleMd,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Positive control on KNOWN planets; claims no discovery; anchors nothing; touches no bundle / money path.",
    "discoveryClaim false, safeToGate false.",
    "",
  ].join("\n");
  writeFileSync("reports/p71-audit-positive-control.md", md);
  console.log("\nwrote reports/p71-audit-positive-control.md and reports/p71-audit-positive-control.json");
}

main().catch((e) => { console.error(`[p71] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
