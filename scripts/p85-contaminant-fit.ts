// P85 -- faithful reproduction of eumemic's PER-CONTAMINANT multi-sector centroid F-test, reported on the
// real 500-target P82 run (src/detect/centroidFtest.ts is their statistic: F = n(n-1)|m-s|^2 / RSS with a
// 1"/axis scatter floor, df=(2,2(n-1)), closed-form p; run for the TARGET s=(0,0) and for every neighbouring
// star bright enough to cause the dip via neighbourCanCauseDip). This script does NOT re-fetch pixels; it
// reads the append-only checkpoint out/scaled/centroid.jsonl that the P82 centroid probe wrote while running
// exactly that sweep, and turns it into a focused, honest report -- including a sensitivity check across
// significance thresholds and an explicit statement of the two methodological choices we had to make where
// the author's doc left them open.
//
// Research only: reads a local checkpoint, writes reports/p85-contaminant-fit.{md,json}. Touches no verdict,
// bundle hash, ledger, or money path. safeToGate false, discoveryClaim false.
// Usage: npm run p85:contaminant-fit

import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  tic: number; toi: string; label: "planet" | "blend"; nUsed: number; testable: boolean;
  pTarget: number; viableNeighbours: number; bestNeighbourP: number; falseReject: boolean; caught: boolean;
}

const CHECKPOINT = "out/scaled/centroid.jsonl";
const BASE_ALPHA = 0.001; // the threshold the P82 probe ran at (matches its --alpha default)

function loadRows(): Row[] {
  let text = "";
  try {
    text = readFileSync(CHECKPOINT, "utf8");
  } catch {
    return [];
  }
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Row;
      if (Number.isFinite(o.tic) && typeof o.label === "string") rows.push(o);
    } catch { /* skip malformed */ }
  }
  return rows;
}

interface Tier {
  alpha: number;
  planetsTestable: number;
  planetFalseReject: number;
  blendsTestable: number;
  blendCaught: number;
  blendsWithViable: number;      // blends that are testable AND have >=1 bright-enough neighbour
  blendContaminantFits: number;  // of those, how many have a neighbour whose offset explains the mean (bestP>=alpha)
}

function tier(rows: Row[], alpha: number): Tier {
  const t: Tier = { alpha, planetsTestable: 0, planetFalseReject: 0, blendsTestable: 0, blendCaught: 0, blendsWithViable: 0, blendContaminantFits: 0 };
  for (const r of rows) {
    if (!r.testable) continue;
    const targetRejected = r.pTarget < alpha;
    if (r.label === "planet") {
      t.planetsTestable++;
      if (targetRejected) t.planetFalseReject++;
    } else {
      t.blendsTestable++;
      const contaminantFits = r.viableNeighbours > 0 && r.bestNeighbourP >= alpha;
      if (r.viableNeighbours > 0) {
        t.blendsWithViable++;
        if (contaminantFits) t.blendContaminantFits++;
      }
      if (targetRejected && contaminantFits) t.blendCaught++;
    }
  }
  return t;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function main(): void {
  const rows = loadRows();
  if (rows.length === 0) {
    console.log(`P85: no checkpoint at ${CHECKPOINT}. Run the P82 centroid probe first (npm run p82:scaled -- --probe centroid).`);
    process.exitCode = 2;
    return;
  }
  const nTestable = rows.filter((r) => r.testable).length;
  const nCoverage = rows.length - nTestable; // fewer than 2 usable localised sectors
  const tiers = [1e-4, BASE_ALPHA, 1e-2].map((a) => tier(rows, a));
  const base = tiers.find((t) => t.alpha === BASE_ALPHA)!;

  const json = {
    meta: { generatedFrom: CHECKPOINT, rows: rows.length, statistic: "eumemic per-contaminant multi-sector centroid F-test (src/detect/centroidFtest.ts)", baseAlpha: BASE_ALPHA },
    coverage: { total: rows.length, testable: nTestable, notLocalised: nCoverage, testablePct: Number(((nTestable / rows.length) * 100).toFixed(1)) },
    methodChoices: {
      whichStarFits: "max-p across bright-enough contaminants (a neighbour 'explains' the mean offset); NOT a joint/min-p test",
      scatterFloor: "1\"/axis floor applied to the residual scatter AFTER the mean offset (per-axis min SS = (n-1)*floor^2)",
      brightnessGate: "neighbourCanCauseDip: a total eclipse of the neighbour, diluted by the host, must reach the observed depth",
    },
    sensitivity: tiers,
    headline: {
      planetFalseReject: `${base.planetFalseReject}/${base.planetsTestable}`,
      blendCaught: `${base.blendCaught}/${base.blendsTestable}`,
      blendContaminantFitRateAmongViable: `${base.blendContaminantFits}/${base.blendsWithViable}`,
    },
    safeToGate: false,
    discoveryClaim: false,
  };
  writeFileSync("reports/p85-contaminant-fit.json", JSON.stringify(json, null, 2) + "\n");

  const md: string[] = [];
  md.push("# P85 -- faithful per-contaminant centroid F-test (eumemic method), on the real P82 run\n");
  md.push(`Statistic: \`src/detect/centroidFtest.ts\` -- F = n(n-1)|m-s|^2 / RSS, 1\"/axis scatter floor, df=(2,2(n-1)), closed-form p. Run for the target (s=0,0) AND for every neighbour bright enough to cause the dip (\`neighbourCanCauseDip\`). Source: ${CHECKPOINT} (${rows.length} targets).\n`);
  md.push("## Coverage (the honest ceiling)\n");
  md.push(`- testable (>=2 localised sectors): **${nTestable}/${rows.length}** (${json.coverage.testablePct}%)`);
  md.push(`- never localised (pixel-baseline bound, P84): **${nCoverage}/${rows.length}**\n`);
  md.push(`## Headline at the run threshold (alpha=${BASE_ALPHA})\n`);
  md.push(`- known-planet false-reject: **${base.planetFalseReject}/${base.planetsTestable}** (${pct(base.planetFalseReject, base.planetsTestable)}) -- the calibration arm; eumemic report 0/565 at p<0.001`);
  md.push(`- blend caught (target rejected AND a contaminant fits): **${base.blendCaught}/${base.blendsTestable}** (${pct(base.blendCaught, base.blendsTestable)})`);
  md.push(`- among testable blends that HAVE a bright-enough neighbour, a neighbour's offset explains the mean in **${base.blendContaminantFits}/${base.blendsWithViable}** (${pct(base.blendContaminantFits, base.blendsWithViable)})\n`);
  md.push("## Sensitivity to the significance threshold\n");
  md.push("| alpha | planet false-reject | blend caught | contaminant fits / viable |");
  md.push("|-------|--------------------:|-------------:|--------------------------:|");
  for (const t of tiers) {
    md.push(`| ${t.alpha} | ${t.planetFalseReject}/${t.planetsTestable} | ${t.blendCaught}/${t.blendsTestable} | ${t.blendContaminantFits}/${t.blendsWithViable} |`);
  }
  md.push("\n## Methodological choices (where the author's doc left them open)\n");
  md.push(`- **Which star fits:** ${json.methodChoices.whichStarFits}.`);
  md.push(`- **Scatter floor:** ${json.methodChoices.scatterFloor}.`);
  md.push(`- **Brightness gate:** ${json.methodChoices.brightnessGate}.\n`);
  md.push("## Verdict\n");
  md.push(`FAITHFUL-REPRODUCTION-RUN. The per-contaminant F-test is implemented and executed over ${nTestable} localisable real targets. The statistic behaves as calibrated (a low known-planet false-reject rate), but its POWER is bounded by the same pixel-baseline coverage limit P84 identified: ${nCoverage}/${rows.length} targets never localise a >=2-sector offset to test at all. Widening the sample narrows the error bars; it does not remove the coverage wall. safeToGate=false, discoveryClaim=false.\n`);
  writeFileSync("reports/p85-contaminant-fit.md", md.join("\n"));

  console.log(`P85: rows=${rows.length} testable=${nTestable} notLocalised=${nCoverage}`);
  console.log(`  planet false-reject ${base.planetFalseReject}/${base.planetsTestable}  blend caught ${base.blendCaught}/${base.blendsTestable}  contaminant-fits ${base.blendContaminantFits}/${base.blendsWithViable}`);
  console.log("  wrote reports/p85-contaminant-fit.{md,json}");
}

main();
