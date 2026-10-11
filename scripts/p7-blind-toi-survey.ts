// P7 REAL-DATA BLIND TOI SURVEY: how often does a from-scratch pipeline independently re-detect
// UNCONFIRMED TESS candidates straight from the raw pixels -- with the candidate ephemeris withheld?
//
// This is the real-sky complement to the synthetic p6:survey. p5:blind ran the protocol on 8 targets;
// this scales it to tens and turns it into an honest operating statistic. For each candidate from the
// NASA Archive `toi` table (minus any host already in the confirmed catalog):
//   1. pull the SAME token-free real TESS-SPOC PDCSAP photometry production uses;
//   2. run detectTransit() BLIND -- the whole period grid, the TOI's reported period/epoch NEVER shown;
//   3. only AFTERWARDS cross-match the period WE recovered against the TOI reference.
// A DIRECT recovery (our period within TOL% of the TOI at the fundamental, AND SNR>=minSnr) is evidence
// the signal is real in the downlinked pixels, independently of the discovery pipeline's own answer.
//
// SAFETY BOUNDARY: this is a research probe, NOT an announcement machine. Nothing here is anchored,
// posted, spent on, or claimed as a discovery. A recovery is a CANDIDATE for human follow-up. The rig
// reports what it can independently recover and stops short of calling any of it a planet.
//
// Needs network (Archive TAP + TESScut + SPOC); not in CI. Fully offline it degrades to a labeled
// fallback and says so.
//
// Usage:
//   npm run p7:toi-survey
//   npm run p7:toi-survey -- --targets 40 --tmag 11 --minsnr 7 --tol 2
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 40));
const tmag = arg("tmag", 11);
const minSnr = arg("minsnr", 7);
const TOL_PCT = arg("tol", 2);

// Is our recovered period a DIRECT (fundamental) match, a HARMONIC/alias match, or no match?
function classify(ourP: number, refP: number): "direct" | "harmonic" | "none" {
  if (Math.abs(ourP - refP) / refP * 100 <= TOL_PCT) return "direct";
  for (const f of [2, 0.5, 3, 1 / 3]) {
    if (Math.abs(ourP * f - refP) / refP * 100 <= TOL_PCT) return "harmonic";
  }
  return "none";
}

const BINS: [string, number, number][] = [
  ["<2d", 0, 2],
  ["2-4d", 2, 4],
  ["4-7d", 4, 7],
  ["7-13d", 7, 13],
  [">13d", 13, Infinity],
];

interface Row {
  name: string;
  refP: number;
  ourP: number;
  snr: number;
  refDepth: number;
  ourDepth: number;
  cls: "direct" | "harmonic" | "none";
}

async function main() {
  console.log("P7 REAL-DATA BLIND TOI SURVEY -- independent re-detection of UNCONFIRMED candidates.");
  console.log(`(toi table minus confirmed hosts; tmag<${tmag}; BLIND detect; direct match <=${TOL_PCT}% and SNR>=${minSnr}; sample ${want})`);
  console.log("Nothing is anchored or claimed. A recovery is a CANDIDATE for human follow-up.\n");

  const toc = await fetchTocCandidates({ maxTmag: tmag, limit: want * 4, excludeConfirmedHosts: true });
  if (toc.source !== "nasa-tap") {
    console.log(`WARNING: TOI source=${toc.source} (live TAP unavailable)${toc.error ? " :: " + toc.error : ""} -- using labeled fallback; results are NOT a real blind test.`);
  }
  const queue = toc.candidates;
  console.log(`pool: ${queue.length} unconfirmed candidates (brightest first)\n`);

  const rows: Row[] = [];
  let measurable = 0;
  let noData = 0;
  for (const c of queue) {
    if (measurable >= want) break;
    try {
      const sectors = await sectorsForCoord(c.ra, c.dec);
      let lc: LightCurve | null = null;
      for (const s of sectors.slice(0, 3)) {
        lc = await fetchSpocLightCurve(c.tic, [s], c.toidisplay);
        if (lc) break;
      }
      if (!lc) { noData++; continue; } // not every target is downlinked to the token-free SPOC bucket
      measurable++;
      const det = detectTransit(lc); // BLIND: no TOI ephemeris passed
      const cand = det.candidate;
      const cls = classify(cand.periodDays, c.periodDays);
      const ourDepth = cand.depthFrac * 1e6;
      const recovered = cls === "direct" && cand.snr >= minSnr;
      rows.push({ name: c.toidisplay, refP: c.periodDays, ourP: cand.periodDays, snr: cand.snr, refDepth: c.depthPpm, ourDepth, cls });
      const perr = ((cand.periodDays - c.periodDays) / c.periodDays) * 100;
      console.log(
        `${c.toidisplay.padEnd(13)} P=${c.periodDays.toFixed(4)}d ours=${cand.periodDays.toFixed(4)}d (${perr >= 0 ? "+" : ""}${perr.toFixed(2)}%) ` +
        `SNR=${cand.snr.toFixed(1).padStart(5)} depth ${c.depthPpm.toFixed(0)}->${ourDepth.toFixed(0)}ppm alias x${det.aliasMultiple} ` +
        `-> ${recovered ? "CANDIDATE (blind recovery)" : cls === "harmonic" ? "alias (harmonic match)" : cls === "direct" ? "matched, below SNR cut" : "no match"}`,
      );
    } catch (e) {
      console.log(`${c.toidisplay.padEnd(13)} ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const recovered = rows.filter((r) => r.cls === "direct" && r.snr >= minSnr);
  const harmonic = rows.filter((r) => r.cls === "harmonic");
  console.log("\n=================================================================");
  console.log(`measurable (had token-free SPOC data): ${measurable}   (skipped, no data: ${noData})`);
  console.log(`BLIND RECOVERY (direct fundamental match, SNR>=${minSnr}): ${recovered.length}/${measurable} = ${measurable ? ((recovered.length / measurable) * 100).toFixed(1) : "0"}%`);
  console.log(`recovered-but-alias (harmonic match only): ${harmonic.length}`);

  // Recovery as a function of period -- the honest single-sector completeness limit.
  console.log("\nblind recovery by period bin (real single-sector coverage):");
  console.log("  bin      measurable  recovered  rate");
  for (const [label, lo, hi] of BINS) {
    const m = rows.filter((r) => r.refP >= lo && r.refP < hi);
    if (!m.length) continue;
    const rec = m.filter((r) => r.cls === "direct" && r.snr >= minSnr).length;
    console.log(`  ${label.padEnd(8)}  ${String(m.length).padStart(6)}  ${String(rec).padStart(9)}  ${((rec / m.length) * 100).toFixed(0).padStart(4)}%`);
  }

  // The headline independent quantity is the PERIOD, recovered blind to well under a percent.
  if (recovered.length >= 1) {
    const perrs = recovered.map((r) => (Math.abs(r.ourP - r.refP) / r.refP) * 100).sort((a, b) => a - b);
    const medP = perrs[perrs.length >> 1];
    console.log(`\nindependent PERIOD recovery: median |ours-TOI|/TOI = ${medP.toFixed(2)}% (max ${perrs[perrs.length - 1].toFixed(2)}%) -- recovered blind from the pixels, never shown the TOI ephemeris.`);
    const derrs = recovered.map((r) => (Math.abs(r.ourDepth - r.refDepth) / r.refDepth) * 100).sort((a, b) => a - b);
    console.log(`(BLS box depth is a crude proxy: median |ours-TOI|/TOI = ${derrs[derrs.length >> 1].toFixed(0)}%. The PERIOD, not the box depth, is the reliable independent measurement; depth needs the exact-transit model fit, a separate step.)`);
  }

  console.log("\nREMINDER: these are CANDIDATES for human follow-up, not confirmations. The rig does not auto-anchor, post, or announce any of them.");
}

main().catch((e) => {
  console.error("blind TOI survey failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
