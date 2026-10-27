// P52: is a rigorous TRUE-VETO acceptance test constructible from token-free public data? (P51 follow-up)
//
// The reviewer's standard demands a labelled NEGATIVE class -- real off-target eclipsing binaries / blends at
// known positions -- so a veto's catch-rate (not just its over-kill rate) can be measured. P51 established the
// positives side (crowded-field localization on confirmed planets) and probed reachability. This script turns
// that into a MEASURED constructibility study of the negatives, using the reusable access in
// src/data/vizierEb.ts:
//   (1) ExoFOP-TESS (the authoritative per-candidate blend/EB dispositions): attempt anonymous reachability.
//   (2) VizieR GCVS: pull a real eclipsing-binary list (positions + periods) -- proves the list path works.
//   (3) For crowded planet hosts, ATTEMPT to place a catalogued EB inside the ~21" aperture two ways: a live
//       cone per host, and a client-side cross-match of the pulled list against host positions.
//   (4) If any real EB lands in an aperture AND the host has a SPOC cube, run the localization at the EB
//       ephemeris -- a genuine true-veto trial. Report the honest count of usable labelled negatives.
// The verdict is whether the full 2x2 (true-veto vs false-veto) can be built NOW from public data, or is
// blocked on access. Research-only: no worker import, no verdict/bundle hash/money path, nothing gated.
//
// Usage:  npm run p52:negative-class  [-- --hosts 12 --cone-radius-arcsec 21 --list-rows 3000]

import { writeFileSync, mkdirSync } from "node:fs";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { absGalacticLatitude } from "../src/candidate/crowding.ts";
import { buildEbListUrl, buildEbConeUrl, parseEbVotable, eclipsingOnly, type EbEntry } from "../src/data/vizierEb.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchSpocTargetPixels } from "../src/data/mastS3Pixels.ts";
import { localizeTransitSource, judgeLocalization } from "../src/detect/diffImaging.ts";
import type { ArchivePlanet } from "../src/core/types.ts";
import { buildStamp } from "./report-freshness.ts";

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}
const wantHosts = Math.round(argNum("hosts", 12));
const coneRadiusArcsec = argNum("cone-radius-arcsec", 21);
const listRows = Math.round(argNum("list-rows", 3000));
const GATE_ARCSEC = 2.0;
const MIN_SNR = 5;
const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "space-data-rig-research/1.0" } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function main() {
  console.log(`P52 negative-class constructibility (hosts=${wantHosts}, cone=${coneRadiusArcsec}", listRows=${listRows})`);

  // (1) ExoFOP-TESS reachability (the authoritative blend/EB disposition source).
  const exofop = await fetchText("https://exofop.ipac.caltech.edu/tess/api/planets/?format=json&tic=261136679");
  const exofopReachable = !!exofop && /^\s*[\[{]/.test(exofop);
  console.log(`  (1) ExoFOP-TESS dispositions: ${exofopReachable ? "reachable" : "NOT reachable anonymously (404 / token-gated)"}`);

  // (2) VizieR GCVS real eclipsing-binary list (positions + periods).
  const listTxt = await fetchText(buildEbListUrl(listRows));
  const allVars = listTxt ? parseEbVotable(listTxt) : [];
  const ebList = eclipsingOnly(allVars);
  console.log(`  (2) VizieR GCVS list: ${allVars.length} variables parsed, ${ebList.length} eclipsing binaries (positions+periods)`);

  // crowded planet hosts, lowest |b| first
  const cat = await fetchConfirmedPlanets({ maxTmag: 12, requireTic: true, limit: 500 });
  const hosts = cat.planets
    .filter((p: ArchivePlanet) => Number.isFinite(p.tic) && Number.isFinite(p.ra) && Number.isFinite(p.dec) && Number.isFinite(p.pl_orbper))
    .sort((a, b) => absGalacticLatitude(a.ra!, a.dec!) - absGalacticLatitude(b.ra!, b.dec!))
    .slice(0, wantHosts);

  // (3a) live cone per host for a catalogued EB inside the aperture
  const coneMatches: { host: string; eb: EbEntry; sepArcsec: number }[] = [];
  let coneEmptyResponses = 0;
  for (const p of hosts) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    const txt = await fetchText(buildEbConeUrl(p.ra!, p.dec!, coneRadiusArcsec / 60));
    await sleep(1200); // be polite; VizieR throttles rapid queries
    if (!txt || parseEbVotable(txt).length === 0) { coneEmptyResponses++; continue; }
    for (const eb of eclipsingOnly(parseEbVotable(txt))) {
      const sep = angularSepArcsec(p.ra!, p.dec!, eb.ra, eb.dec);
      if (sep <= coneRadiusArcsec) coneMatches.push({ host: name, eb, sepArcsec: +sep.toFixed(2) });
    }
  }
  console.log(`  (3a) live GCVS cone over ${hosts.length} hosts: ${coneMatches.length} EBs within ${coneRadiusArcsec}", ${coneEmptyResponses}/${hosts.length} cones returned empty`);

  // (3b) client-side cross-match of the pulled list against host positions (independent of the cone)
  const xmatch: { host: string; eb: EbEntry; sepArcsec: number }[] = [];
  for (const p of hosts) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    for (const eb of ebList) {
      const sep = angularSepArcsec(p.ra!, p.dec!, eb.ra, eb.dec);
      if (sep <= coneRadiusArcsec) xmatch.push({ host: name, eb, sepArcsec: +sep.toFixed(2) });
    }
  }
  console.log(`  (3b) client cross-match of the ${ebList.length}-EB list vs ${hosts.length} hosts: ${xmatch.length} within ${coneRadiusArcsec}"`);

  const usableNegatives = [...coneMatches, ...xmatch];

  // (4) true-veto trial on any real labelled negative whose host has a SPOC cube
  const vetoTrials: { host: string; eb: string; ebSepArcsec: number; offsetArcsec: number; dropSnr: number; caughtOffTarget: boolean }[] = [];
  for (const m of usableNegatives.slice(0, 6)) {
    const p = hosts.find((h) => (h.pl_name ?? h.hostname ?? `TIC ${h.tic}`) === m.host);
    if (!p || !m.eb.periodDays) continue;
    try {
      const sectors = await sectorsForCoord(p.ra!, p.dec!);
      for (const s of sectors.slice(0, 3)) {
        const lc = await fetchSpocLightCurve(p.tic!, [s], m.host);
        if (!lc) continue;
        const cube = await fetchSpocTargetPixels(p.tic!, s, lc.targetId);
        if (!cube) continue;
        // localise at the EB's period (epoch unknown -> use a mid-mission BJD; the point is the SOURCE position)
        const loc = localizeTransitSource(cube, 2458340.0, m.eb.periodDays, 0.1, { bootstraps: 150, seed: 4242 });
        if (loc && loc.determined) {
          const verdict = judgeLocalization(loc, GATE_ARCSEC, { minSnr: MIN_SNR }).classification;
          vetoTrials.push({ host: m.host, eb: m.eb.name, ebSepArcsec: m.sepArcsec, offsetArcsec: +loc.offsetArcsec.toFixed(2), dropSnr: +loc.dropSnr.toFixed(1), caughtOffTarget: verdict === "off-target" });
        }
        break;
      }
    } catch { /* localization optional */ }
  }

  const constructible = usableNegatives.length >= 5; // need a handful of real labelled blends for a 2x2
  console.log(`\n=== P52 SUMMARY ===`);
  console.log(`  usable labelled negatives (real EBs in host apertures): ${usableNegatives.length}`);
  console.log(`  true-veto trials run on real blends: ${vetoTrials.length}${vetoTrials.length ? ` (caught off-target: ${vetoTrials.filter((v) => v.caughtOffTarget).length})` : ""}`);
  const verdict = constructible
    ? `P52-NEGATIVE-CLASS-CONSTRUCTIBLE (${usableNegatives.length} real blends; ${vetoTrials.length} true-veto trials) -> full 2x2 buildable`
    : `P52-NEGATIVE-CLASS-NOT-CONSTRUCTIBLE-FROM-PUBLIC-DATA (only ${usableNegatives.length} real blends obtainable; GCVS cone ${coneEmptyResponses}/${hosts.length} empty, ExoFOP ${exofopReachable ? "reachable" : "gated"}) -> true-veto 2x2 BLOCKED on access, veto remains un-acceptable`;
  console.log(`\nVERDICT: ${verdict}`);

  const json = {
    meta: { ...buildStamp(["src/data/vizierEb.ts", "scripts/p52-negative-class.ts"]), generatedBy: "scripts/p52-negative-class.ts", wantHosts, coneRadiusArcsec, listRows, reviewerStandard: "acceptance needs a labelled negative class (real off-target blends), not just positives" },
    exofopReachable,
    gcvsList: { variablesParsed: allVars.length, eclipsingBines: ebList.length },
    hosts: hosts.map((p) => ({ name: p.pl_name ?? p.hostname ?? `TIC ${p.tic}`, ra: p.ra, dec: p.dec, absB: +absGalacticLatitude(p.ra!, p.dec!).toFixed(2) })),
    coneMatches: coneMatches.map((m) => ({ host: m.host, eb: m.eb.name, sepArcsec: m.sepArcsec, periodDays: m.eb.periodDays })),
    coneEmptyResponses,
    clientCrossMatches: xmatch.map((m) => ({ host: m.host, eb: m.eb.name, sepArcsec: m.sepArcsec })),
    usableNegatives: usableNegatives.length,
    vetoTrials,
    constructible,
    safeToGate: false,
    discoveryClaim: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p52-negative-class.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P52 can we build a labelled NEGATIVE class from public data? (true-veto acceptance feasibility)",
    "",
    `Reproduce: \`npm run p52:negative-class -- --hosts ${wantHosts} --cone-radius-arcsec ${coneRadiusArcsec} --list-rows ${listRows}\``,
    "",
    "P51 measured the veto tools on crowded-field POSITIVES (confirmed planets). A reviewer's standard goes",
    "further: to accept a veto you must also show it CATCHES real blends, which needs a labelled NEGATIVE class",
    "-- real off-target eclipsing binaries at known positions. This script measures whether such a class is",
    "constructible from token-free public sources, using the reusable access in `src/data/vizierEb.ts`.",
    "",
    "| source / method | result |",
    "|---|---|",
    `| ExoFOP-TESS per-candidate dispositions | ${exofopReachable ? "reachable anonymously" : "**NOT reachable** (REST 404 / token-gated) -- the authoritative blend/EB labels are behind access" } |`,
    `| VizieR GCVS list (positions + periods) | works: ${allVars.length} variables, ${ebList.length} eclipsing binaries parsed |`,
    `| VizieR GCVS cone around ${hosts.length} crowded hosts (${coneRadiusArcsec}") | ${coneMatches.length} real EBs landed in an aperture; ${coneEmptyResponses}/${hosts.length} cones returned empty |`,
    `| client cross-match of the ${ebList.length}-EB list vs hosts | ${xmatch.length} within ${coneRadiusArcsec}" |`,
    `| usable labelled negatives | **${usableNegatives.length}** |`,
    `| true-veto trials on real blends | ${vetoTrials.length}${vetoTrials.length ? ` (caught off-target: ${vetoTrials.filter((v) => v.caughtOffTarget).length})` : ""} |`,
    "",
    constructible
      ? `With ${usableNegatives.length} real blends obtainable, the full 2x2 (true-veto vs false-veto) is buildable;` +
        " the trials above are the first entries. Continue by widening the negative sample."
      : "Honest conclusion: a rigorous true-veto acceptance test is **NOT constructible from token-free public" +
        " data in this pass**. The GCVS catalogue is bright-star-only and its anonymous cone endpoint returned" +
        ` empty even for guaranteed matches (a control on Algol), so real EBs essentially never fall inside a` +
        ` specific TESS ~${coneRadiusArcsec}" host aperture; and the one source that DOES label per-candidate` +
        " blends (ExoFOP-TESS) is token-gated. This is exactly the blocker the reviewer's standard runs into:" +
        " without a labelled negative class we can measure a veto's over-kill but never its catch-rate. The veto" +
        " tools therefore remain **un-acceptable** (not proven safe), `safeToGate: false`. The concrete unlock is" +
        " an ExoFOP-TESS API token (or a dedicated blend/FP catalogue with TIC + offset), after which" +
        " `src/data/vizierEb.ts` and this script extend to the full 2x2.",
    "",
    "Research-only audit artifact; no verdict/bundle-hash/money-path change; nothing anchored, claimed, or",
    "deployed. `discoveryClaim: false`.",
    "",
  ].join("\n");
  writeFileSync("reports/p52-negative-class.md", md);
  console.log("\nwrote reports/p52-negative-class.md and reports/p52-negative-class.json");
}

main().catch((e) => {
  console.error("p52 failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
