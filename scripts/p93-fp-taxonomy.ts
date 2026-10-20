// P93 - FLUX-LEVEL FP-TAXONOMY VALIDATION ROC (authority roadmap, priority 2).
//
// WHAT THIS MEASURES. RAVEN / TRICERATOPS / LEO-Vetter validate candidates by collapsing vetting discriminants into
// a single planet posterior and cutting at > 0.99. The rig now has the generator (src/sim/falsePositiveTaxonomy.ts)
// to inject the labelled astrophysical FP family -- EB, HEB, BEB, NEB (eclipsing-binary family) and HTP, NTP
// (blended PLANETS) -- onto real light curves, plus the combiner (src/candidate/validationPosterior.ts). This study
// answers the one question the field asks of any such posterior: FOR EACH labelled class, how much of it does a
// FLUX-ONLY posterior correctly reject, keep, or leave uncertain -- measured against a KNOWN-negative population.
//
// It runs the repo's own discriminants (secondaryEclipse, oddEvenDepth) at the injected ephemeris on real committed
// fixture curves (byte-identical, offline, deterministic -- no MAST), folds them into the posterior, and tallies the
// decision per class. The expected, honest finding: the EB family has a phase-0.5 secondary the posterior catches,
// so it is rejected; a blended planet (HTP/NTP) has NO secondary and, without pixels, is flux-degenerate with a real
// planet -- so the posterior CANNOT reject it. That limit is the point, not a defect: it tells us exactly which FP
// classes flux can retire and which still need the pixel/centroid machinery (P53/P58/P89, which themselves
// false-kill real planets at present depth).
//
// Conditioned on the correct ephemeris (we feed the discriminants the injected period/epoch/duration), so this
// isolates FP-DISCRIMINATION power from detection/alias error, which are separate axes (P43/P78). Blend FPP is left
// off (needs a Gaia neighbour census) -- this is the FLUX-only arm. Research only: nothing wired into a verdict /
// bundle hash / money path; discoveryClaim and safeToGate stay structurally false.
//
// Run: npm run p93:fp-taxonomy [-- --perClassTrials 4 --prior 0.5 --minSnr 7]

import { preprocess } from "../src/detect/detrend.ts";
import { bls } from "../src/detect/bls.ts";
import { secondaryEclipse, oddEvenDepth } from "../src/detect/vetting.ts";
import { synthesizeFalsePositive, type FpKind } from "../src/sim/falsePositiveTaxonomy.ts";
import { planetPosterior } from "../src/candidate/validationPosterior.ts";
import { readFileSync } from "node:fs";
import { buildStamp } from "./report-freshness.ts";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const perClassTrials = Math.max(1, parseInt(arg("perClassTrials", "4"), 10));
const prior = Number(arg("prior", "0.5"));
const minSnr = Number(arg("minSnr", "7"));
const fixtureDir = join("tests", "fixtures", "spoc-curves");

const KINDS: FpKind[] = ["planet", "EB", "HEB", "BEB", "NEB", "HTP", "NTP"];
const PERIODS = [2, 3, 4, 6];

/** Load the committed byte-exact real SPOC fixture curves (2-col CSV: time,flux; header skipped). */
function loadFixtures(): LightCurve[] {
  const manifest = JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8")) as { curves: { file: string; host: string }[] };
  const out: LightCurve[] = [];
  for (const entry of manifest.curves) {
    try {
      const raw = readFileSync(join(fixtureDir, entry.file), "utf8").replace(/\r\n/g, "\n").split("\n");
      const points = [];
      for (let i = 1; i < raw.length; i++) {
        const line = raw[i]!.trim();
        if (!line) continue;
        const [t, f] = line.split(",");
        const tv = Number(t), fv = Number(f);
        if (Number.isFinite(tv) && Number.isFinite(fv)) points.push({ time: tv, flux: fv });
      }
      if (points.length >= 150) out.push({ targetId: entry.host, mission: "TESS", points });
    } catch { /* skip an unreadable fixture */ }
  }
  return out;
}

interface Row { host: string; kind: FpKind; periodDays: number; snr: number; depthFrac: number; secondaryRatio: number; secondaryDetermined: boolean; oddEvenDiffFrac: number; oddEvenDetermined: boolean; posteriorPlanet: number; decision: string; }

function main(): void {
  const hosts = loadFixtures();
  if (hosts.length < 3) { console.log(`only ${hosts.length} committed fixture curves readable. VERDICT: NO-FIXTURES (run npm run p36:export-fixtures).`); return; }
  console.log(`P93 FP-taxonomy validation ROC: ${hosts.length} committed real curves x ${KINDS.length} labelled classes x ${perClassTrials} trials. prior=${prior}, minSnr=${minSnr}. Offline, deterministic, flux-only arm. discoveryClaim false.`);

  const rows: Row[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]!;
    const clean = preprocess(host, 0.5);
    for (const kind of KINDS) {
      for (let trial = 0; trial < perClassTrials; trial++) {
        const period = PERIODS[(i + trial) % PERIODS.length];
        const seed = 1000 + i * 31 + trial * 7 + kind.length;
        const { lc, shape } = synthesizeFalsePositive(clean, { kind, periodDays: period, seed });
        const durationHours = shape.dutyCycle * shape.periodDays * 24;
        let snr = 0;
        try { snr = bls(lc, { minPeriodDays: Math.max(1, shape.periodDays * 0.9), maxPeriodDays: shape.periodDays * 1.1 }).snr; } catch { /* undetected */ }
        const sec = secondaryEclipse(lc, shape.t0Bjd, shape.periodDays, durationHours);
        const oe = oddEvenDepth(lc, shape.t0Bjd, shape.periodDays, durationHours);
        const depthFrac = Math.max(0, sec.primaryDepthPpt / 1000);
        const post = planetPosterior(
          { snr, depthFrac, secondaryRatio: sec.ratio, secondaryDetermined: sec.determined && snr >= minSnr, oddEvenDiffFrac: oe.diffFrac, oddEvenDetermined: oe.determined && snr >= minSnr },
          { priorPlanetProb: prior },
        );
        rows.push({ host: host.targetId, kind, periodDays: shape.periodDays, snr, depthFrac, secondaryRatio: sec.ratio, secondaryDetermined: sec.determined, oddEvenDiffFrac: oe.diffFrac, oddEvenDetermined: oe.determined, posteriorPlanet: post.posteriorPlanet, decision: post.decision });
      }
    }
  }

  // Per-class tallies: validated (accepted as planet), uncertain, false-positive (rejected).
  const byClass = new Map<FpKind, { n: number; validated: number; uncertain: number; rejected: number; meanSec: number }>();
  for (const k of KINDS) byClass.set(k, { n: 0, validated: 0, uncertain: 0, rejected: 0, meanSec: 0 });
  for (const r of rows) {
    const c = byClass.get(r.kind)!;
    c.n++; c.meanSec += r.secondaryRatio;
    if (r.decision === "validated") c.validated++; else if (r.decision === "false-positive") c.rejected++; else c.uncertain++;
  }

  const planet = byClass.get("planet")!;
  const ebFamily = (["EB", "HEB", "BEB", "NEB"] as FpKind[]).map((k) => byClass.get(k)!);
  const blendPlanet = (["HTP", "NTP"] as FpKind[]).map((k) => byClass.get(k)!);
  const sum = (arr: { n: number; validated: number; uncertain: number; rejected: number }[], key: "n" | "validated" | "uncertain" | "rejected") => arr.reduce((a, b) => a + b[key], 0);
  const ebN = sum(ebFamily, "n");
  const ebRejected = sum(ebFamily, "rejected");
  const bpN = sum(blendPlanet, "n");
  const bpValidated = sum(blendPlanet, "validated");
  const planetValidatedRate = planet.n ? planet.validated / planet.n : NaN;

  console.log("\n=== P93 SUMMARY: per labelled class, flux-posterior decision ===");
  console.log("class   |   n | validated | uncertain | rejected | mean secondary/primary");
  for (const k of KINDS) {
    const c = byClass.get(k)!;
    console.log(`${k.padEnd(7)} | ${String(c.n).padStart(3)} | ${String(c.validated).padStart(9)} | ${String(c.uncertain).padStart(9)} | ${String(c.rejected).padStart(7)} | ${(c.meanSec / Math.max(1, c.n)).toFixed(2)}`);
  }
  console.log(`\n  positive control (planet) validated: ${planet.validated}/${planet.n} = ${(100 * planetValidatedRate).toFixed(0)}%`);
  console.log(`  EB-family rejected by flux (secondary caught): ${ebRejected}/${ebN} = ${(100 * ebRejected / Math.max(1, ebN)).toFixed(0)}%`);
  console.log(`  blended PLANETS mis-validated (flux-degenerate, no secondary): ${bpValidated}/${bpN} = ${(100 * bpValidated / Math.max(1, bpN)).toFixed(0)}%`);

  const ebCaught = ebN > 0 && ebRejected / ebN > 0.5;
  const planetKept = planetValidatedRate > 0.5;
  const degenerateExposed = bpN > 0 && bpValidated / bpN > 0.5;
  const verdict = ebCaught && planetKept && degenerateExposed
    ? `FLUX-POSTERIOR-PARTIAL: the combiner keeps a true planet (validated ${planet.validated}/${planet.n}) and rejects the eclipsing-binary family via its secondary (rejected ${ebRejected}/${ebN}), but leaves blended PLANETS (HTP/NTP) mis-validated (${bpValidated}/${bpN}) -- exactly the flux degeneracy that only pixel/centroid vetting can break, and which P53/P58/P89 measure as not yet safe to gate. A flux posterior is a real but PARTIAL vetting step; it is not, and cannot be, a complete FP solution.`
    : `MEASURED: EB-family rejected ${ebRejected}/${ebN}, planet kept ${planet.validated}/${planet.n}, blended planets mis-validated ${bpValidated}/${bpN}. See the per-class table; no class is wired into a gate.`;
  console.log(`\nVERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["tests/fixtures/spoc-curves/manifest.json", "src/sim/falsePositiveTaxonomy.ts", "src/detect/vetting.ts", "src/candidate/validationPosterior.ts"]),
      generatedBy: "scripts/p93-fp-taxonomy.ts", nFixtures: hosts.length, perClassTrials, prior, minSnr, kinds: KINDS, periods: PERIODS,
      data: "committed byte-exact real TESS-SPOC fixture curves (tests/fixtures/spoc-curves, no network), labelled FP family injected via src/sim/falsePositiveTaxonomy.ts",
      note: "flux-only validation posterior (secondaryEclipse + oddEvenDepth -> planetPosterior, validateAt 0.99) scored against a KNOWN-labelled FP population; conditioned on the correct ephemeris so it isolates FP-discrimination from detection/alias; blend FPP and pixels deliberately OFF. Measures only; wires nothing; discoveryClaim/safeToGate false.",
    },
    byClass: Object.fromEntries([...byClass.entries()].map(([k, c]) => [k, { n: c.n, validated: c.validated, uncertain: c.uncertain, rejected: c.rejected, meanSecondaryRatio: c.meanSec / Math.max(1, c.n) }])),
    summary: {
      planetValidated: planet.validated, planetN: planet.n,
      ebFamilyRejected: ebRejected, ebFamilyN: ebN,
      blendedPlanetsMisvalidated: bpValidated, blendedPlanetsN: bpN,
    },
    verdict: ebCaught && planetKept && degenerateExposed ? "FLUX-POSTERIOR-PARTIAL" : "MEASURED",
    safeToGate: false, discoveryClaim: false, rows,
  };
  writeFileSync("reports/p93-fp-taxonomy.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P93 flux-level false-positive taxonomy validation ROC",
    "",
    `Reproduce: \`npm run p93:fp-taxonomy -- --perClassTrials ${perClassTrials} --prior ${prior} --minSnr ${minSnr}\``,
    "",
    "RAVEN / TRICERATOPS / LEO-Vetter validate by collapsing discriminants into a single planet posterior cut at",
    "> 0.99. The rig now has a labelled FP generator (falsePositiveTaxonomy.ts) and a combiner (validationPosterior.ts).",
    `On **${hosts.length} committed byte-exact real SPOC fixtures** we inject the labelled FP family, run the repo's own`,
    "secondary-eclipse and odd/even discriminants at the injected ephemeris, and tally the posterior decision per",
    "class. This is the FLUX-ONLY arm: blend FPP and pixel centroid are deliberately off.",
    "",
    "| class | n | validated | uncertain | rejected | mean secondary/primary |",
    "|---|---|---|---|---|---|",
    ...KINDS.map((k) => { const c = byClass.get(k)!; return `| ${k} | ${c.n} | ${c.validated} | ${c.uncertain} | ${c.rejected} | ${(c.meanSec / Math.max(1, c.n)).toFixed(2)} |`; }),
    "",
    `**Positive control (planet) kept:** ${planet.validated}/${planet.n} | **EB-family rejected via its secondary:** ${ebRejected}/${ebN} | **Blended planets (HTP/NTP) mis-validated (flux-degenerate):** ${bpValidated}/${bpN}.`,
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Conditioned on the correct ephemeris so it measures FP-discrimination, not detection/alias error. Nothing is",
    "wired into the critic or the money path; discoveryClaim and safeToGate stay false.",
    "",
  ].join("\n");
  writeFileSync("reports/p93-fp-taxonomy.md", md);
  console.log("\nwrote reports/p93-fp-taxonomy.md and reports/p93-fp-taxonomy.json");
}

main();
