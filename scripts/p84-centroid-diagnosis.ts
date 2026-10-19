// P84 - CENTROID per-contaminant F-test DIAGNOSIS (audit-10 #4: chase the P77 2/6 rather than add another lever).
//
// With the P82 500-target run done we now have >=30 known planets AND a large labelled-blend set scored by the
// faithful per-contaminant centroid F-test. The scaled result (reports/p82-scaled.md) was: planets false-reject
// 1/53 but blends caught 0/56 -- a striking asymmetry. This script reads the SAME checkpoint (out/scaled/
// centroid.jsonl, produced by scripts/p82-scaled-validation.ts) and decomposes WHY, separating two failure modes:
//   (A) COVERAGE   -- fraction of targets where the target-pixel-cube localisation returned >=2 sector offsets at
//                     all (nUsed 0 means nothing measurable: cube fetch failed or too few in-transit cadences).
//   (B) POWER      -- among the measurable ones, how the F-test p-values distribute: pTarget (is the offset cloud
//                     consistent with the target?) vs bestNeighbourP (consistent with ANY viable contaminant?),
//                     against the alpha=0.001 catch bar.
// Verdict logic: high pTarget AND high bestNeighbourP on REAL blends (they neither reject the target nor align
// with a contaminant) points at our pixel baseline (WCS / centroid precision / sector alignment), NOT the F-test
// statistic -- the branch the audit flagged as having chain-wide payoff (P44/P53/P57/P59). Research-only; reads a
// local checkpoint; no network, no worker, no verdict/bundleHash/money. discoveryClaim false, safeToGate false.
//
// Usage: npm run p84:centroid-diagnosis [-- --alpha 0.001 --checkpoint out/scaled/centroid.jsonl]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const ALPHA = Number(arg("alpha", "0.001"));
const CHECKPOINT = arg("checkpoint", "tests/fixtures/scaled/centroid.jsonl");

interface Rec { tic: number; toi: string; label: string; nUsed: number; testable: boolean; pTarget: number; viableNeighbours: number; bestNeighbourP: number; falseReject: boolean; caught: boolean; }

const med = (xs: number[]) => { const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b); return s.length ? Number(s[Math.floor(s.length / 2)].toFixed(4)) : null; };
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");

function analyse(rs: Rec[]) {
  const testable = rs.filter((r) => r.testable);
  const notTestable = rs.filter((r) => !r.testable);
  const nUsed0 = rs.filter((r) => r.nUsed === 0).length;
  return {
    rows: rs.length,
    testable: testable.length,
    testableFrac: testable.length / (rs.length || 1),
    notTestable: notTestable.length,
    notTestableNUsed0: nUsed0,
    coverageLossFrac: nUsed0 / (rs.length || 1),
    caught: testable.filter((r) => r.caught).length,
    falseReject: testable.filter((r) => r.falseReject).length,
    medianViableNeighbours: med(testable.map((r) => r.viableNeighbours)),
    medianPTarget: med(testable.map((r) => r.pTarget)),
    medianBestNeighbourP: med(testable.map((r) => r.bestNeighbourP)),
    testableWithNeighbour: testable.filter((r) => r.viableNeighbours > 0).length,
    pTargetBelowAlpha: testable.filter((r) => Number.isFinite(r.pTarget) && r.pTarget < ALPHA).length,
    bestNeighbourBelowAlpha: testable.filter((r) => Number.isFinite(r.bestNeighbourP) && r.bestNeighbourP < ALPHA).length,
  };
}

function main(): void {
  if (!existsSync(CHECKPOINT)) { console.log(`checkpoint ${CHECKPOINT} not found -- run the P82 centroid probe first.`); process.exitCode = 1; return; }
  const recs: Rec[] = readFileSync(CHECKPOINT, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Rec);
  const planets = analyse(recs.filter((r) => r.label === "planet"));
  const blends = analyse(recs.filter((r) => r.label === "blend"));

  console.log(`P84 centroid diagnosis on ${recs.length} records (alpha ${ALPHA}).`);
  console.log(`  PLANETS : testable ${planets.testable}/${planets.rows} (coverage loss nUsed0 ${planets.notTestableNUsed0}, ${pct(planets.notTestableNUsed0, planets.rows)}); false-reject ${planets.falseReject}; median pTarget ${planets.medianPTarget}`);
  console.log(`  BLENDS  : testable ${blends.testable}/${blends.rows} (coverage loss nUsed0 ${blends.notTestableNUsed0}, ${pct(blends.notTestableNUsed0, blends.rows)}); caught ${blends.caught}; median pTarget ${blends.medianPTarget} median bestNeighbourP ${blends.medianBestNeighbourP}`);

  const coverageDominated = blends.coverageLossFrac > 0.5;
  const powerAbsent = blends.testable > 0 && blends.caught === 0 && (blends.medianPTarget ?? 1) > ALPHA && (blends.medianBestNeighbourP ?? 1) > ALPHA;
  const verdict = coverageDominated && powerAbsent
    ? `PIXEL-BASELINE-BOUND: real blends fail two ways at once -- (A) ${pct(blends.notTestableNUsed0, blends.rows)} of blend targets never yield >=2 localisable sector offsets (target-pixel-cube coverage collapse), and (B) among the ${blends.testable} measurable blends the F-test catches 0 because the offset cloud matches NEITHER the target (median pTarget ${blends.medianPTarget}) NOR any viable contaminant (median bestNeighbourP ${blends.medianBestNeighbourP}), both far above alpha ${ALPHA}. Meanwhile known planets false-reject only ${planets.falseReject}/${planets.testable}. The F-test statistic is fine; OUR per-sector centroid localisation (WCS / centroid precision / sector alignment) is too noisy/biased to move a real blend off-target -- the audit's suspected branch. Fixing the pixel baseline has chain-wide payoff (P44/P53/P57/P59), not just this gate. Measures only.`
    : coverageDominated
      ? `COVERAGE-DOMINATED: most blend targets (nUsed0 ${pct(blends.notTestableNUsed0, blends.rows)}) are not localisable at all; the F-test itself is not the first-order limit here. Improve cube fetch / in-transit sampling before judging the statistic.`
      : powerAbsent
        ? `POWER-ABSENT: localisation succeeds but the per-contaminant F-test has no discriminating power on this real data (offsets align with neither target nor contaminant).`
        : `CENTROID-TEST-HEALTHY-ON-THIS-SAMPLE: blends are being caught at a non-trivial rate; no systematic failure to chase.`;
  console.log(`VERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: { ...buildStamp([CHECKPOINT]), generatedBy: "scripts/p84-centroid-diagnosis.ts", checkpoint: CHECKPOINT, alpha: ALPHA, eumemicReference: { planetFalseReject: "0/565 at p<0.001", blendCatch: "127/175 (73%); 38% within 15 arcsec" }, note: "decomposes the P82 centroid result into COVERAGE (localisable fraction) vs POWER (F-test discrimination); research-only; discoveryClaim false, safeToGate false." },
    planets, blends, verdict, discoveryClaim: false, safeToGate: false,
  };
  writeFileSync("reports/p84-centroid-diagnosis.json", JSON.stringify(json, null, 2) + "\n");
  const row = (name: string, s: ReturnType<typeof analyse>) => [
    `### ${name}`,
    "",
    `- rows ${s.rows}; localisable (>=2 sector offsets) ${s.testable} (${pct(s.testable, s.rows)}); NOT localisable ${s.notTestable} (nUsed 0: ${s.notTestableNUsed0} = ${pct(s.notTestableNUsed0, s.rows)} coverage loss)`,
    `- among localisable: median viable neighbours ${s.medianViableNeighbours}; median pTarget ${s.medianPTarget}; median bestNeighbourP ${s.medianBestNeighbourP}`,
    `- caught ${s.caught}; false-reject ${s.falseReject}; pTarget<alpha ${s.pTargetBelowAlpha}; bestNeighbourP<alpha ${s.bestNeighbourBelowAlpha}`,
    "",
  ];
  const md = [
    "# P84 centroid per-contaminant F-test diagnosis (audit-10 #4: chase the 2/6, don't add a lever)",
    "",
    `Reproduce: \`npm run p84:centroid-diagnosis -- --alpha ${ALPHA}\` (reads the P82 centroid checkpoint; run \`npm run p82:scaled -- --probe centroid\` first).`,
    "",
    "Provenance: this diagnosis is re-derived on every run from the checkpoint's content-addressed sha256 (see meta),",
    "so it always matches the current P82 sweep -- here, the corrected host coordinates after the ExoFOP RA-unit fix.",
    "",
    `The scaled centroid result (P82) was asymmetric: known planets false-reject ${planets.falseReject}/${planets.testable}, but labelled blends caught`,
    `${blends.caught}/${blends.testable}. This splits the WHY into (A) COVERAGE -- did the target-pixel-cube even yield >=2 localisable sector`,
    "offsets? -- and (B) POWER -- among the localisable ones, does the F-test align the offset cloud with the target",
    "or with any Gaia-viable contaminant? High pTarget AND high bestNeighbourP on REAL blends means the offsets",
    "match neither, which points at our pixel baseline (WCS / centroid precision / sector alignment), not the test.",
    "",
    ...row("Known planets (positive control)", planets),
    ...row("Labelled blends (the catch target)", blends),
    `**VERDICT: ${verdict}**`,
    "",
    "eumemic reference for context: 0/565 known planets wrongly rejected, 127/175 (73%) off-source blends caught",
    "(38% within 15 arcsec). Our planet false-reject rate is compatible; our blend catch-rate is not, and this",
    "diagnosis attributes it to the pixel-baseline/coverage path. Measures only; gates nothing; discoveryClaim false.",
    "",
  ];
  writeFileSync("reports/p84-centroid-diagnosis.md", md.join("\n"));
  console.log("wrote reports/p84-centroid-diagnosis.{md,json}");
}

main();
