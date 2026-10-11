// P5 blind / discovery-mode PROBE (research tool -- NOT wired to the anchoring path).
//
// Protocol: for a set of UNCONFIRMED TESS candidates (Archive `toi` table), fetch the SAME
// token-free real TESS-SPOC photometry the production pipeline uses, run our detector BLIND --
// i.e. detectTransit() searches the whole period grid with NO knowledge of the TOI's reported
// ephemeris -- and only THEN cross-match the period we independently recovered against the TOI
// reference. Independent recovery is evidence the candidate signal is real in the downlinked
// pixels, not a restatement of the discovery pipeline's own output.
//
// DELIBERATE SAFETY BOUNDARY: nothing here anchors, posts, spends, or claims a discovery. A hit is
// reported as "CANDIDATE (blind recovery)" for human review, exactly as README states -- the rig
// does not auto-announce. This keeps the discovery pipeline honest and off the money path.
//
// Usage:
//   npm run p5:blind                          (a handful of bright, unconfirmed TOIs)
//   npm run p5:blind -- --targets 10 --tmag 10.5 --minsnr 7
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { crossmatchPeriod } from "../src/data/exoplanetArchive.ts";
import type { ArchivePlanet, LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 8));
const tmag = arg("tmag", 10.5);
const minSnr = arg("minsnr", 7);

async function main() {
  console.log("P5 BLIND DISCOVERY PROBE -- candidate validation only. Nothing here is anchored or announced.");
  console.log(`(unconfirmed TOI candidates, tmag<${tmag}, minSnr=${minSnr}, target sample ${want})`);
  const toc = await fetchTocCandidates({ maxTmag: tmag, limit: want * 3, excludeConfirmedHosts: true });
  if (toc.source !== "nasa-tap") {
    console.log(`WARNING: TOI source=${toc.source} (live TAP unavailable)${toc.error ? " :: " + toc.error : ""} -- using labeled fallback, results are not a real blind test.`);
  }
  const queue = toc.candidates.slice(0, want);
  console.log(`queued ${queue.length} unconfirmed candidates`);
  console.log("");

  let measurable = 0;
  let recovered = 0;
  for (const c of queue) {
    const ref: ArchivePlanet = { pl_name: c.toidisplay, hostname: c.toidisplay, pl_orbper: c.periodDays };
    try {
      const sectors = await sectorsForCoord(c.ra, c.dec);
      let lc: LightCurve | null = null;
      let usedSector = -1;
      for (const s of sectors.slice(0, 3)) {
        lc = await fetchSpocLightCurve(c.tic, [s], c.toidisplay);
        if (lc) { usedSector = s; break; }
      }
      if (!lc) {
        console.log(`${c.toidisplay.padEnd(14)} TIC ${c.tic}: no token-free SPOC light curve in sectors [${sectors.slice(0, 3).join(",")}] -- skipped (not every target is downlinked)`);
        continue;
      }
      measurable++;
      // DETECT BLIND: no TOI ephemeris passed in.
      const det = detectTransit(lc);
      const cand = det.candidate;
      const match = crossmatchPeriod(cand.periodDays, [ref], undefined, 3);
      const ourDepthPpm = cand.depthFrac * 1e6;
      const strong = cand.snr >= minSnr;
      const verdict = match ? (strong ? "CANDIDATE (blind recovery, review)" : "recovered but below SNR cut") : "no match to TOI reference";
      if (match && strong) recovered++;
      console.log(
        `${c.toidisplay.padEnd(14)} TIC ${c.tic} s${usedSector}: TOI P=${c.periodDays.toFixed(4)}d/${c.depthPpm.toFixed(0)}ppm  ` +
        `OURS P=${cand.periodDays.toFixed(4)}d/${ourDepthPpm.toFixed(0)}ppm SNR=${cand.snr.toFixed(1)} alias x${det.aliasMultiple} -> ${verdict}`,
      );
    } catch (e) {
      console.log(`${c.toidisplay.padEnd(14)} TIC ${c.tic}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("");
  console.log(`blind-recovered ${recovered} of ${measurable} measurable candidates (SNR>=${minSnr}).`);
  console.log("REMINDER: these are CANDIDATES for human follow-up, not confirmations; the rig does not auto-anchor or announce them.");
}

main().catch((e) => {
  console.error("blind probe failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
