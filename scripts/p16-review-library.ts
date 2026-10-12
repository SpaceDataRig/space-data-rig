// P16 - INDEPENDENT REVIEW via the reusable library (src/review/externalReview.ts) + the detection
// FLOOR table. Where p15 was a one-off, p16 exercises the first-class module against live public data
// and makes our OWN sensitivity explicit: for each candidate it prints what our untuned box-BLS can
// see at different sampling cadences, so "we did not detect it" is always paired with "and here is
// exactly why that is our limit, not a statement about the signal."
//
// Reviews SOMEONE ELSE'S published candidates. Not our discovery. No gating, nothing anchored.
// Degrades honestly if a channel is rate-limited/offline (the module records the failure as a note).
//
// Run:  npx tsx scripts/p16-review-library.ts
import { detectTransit } from "../src/detect/pipeline.ts";
import { calibratedFap } from "../src/detect/significance.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchTocCandidates } from "../src/data/toiArchive.ts";
import { fetchSpocLightCurve } from "../src/data/mastS3.ts";
import { fetchGaiaBySourceId, fetchGaiaNeighborhood } from "../src/data/gaiaDilution.ts";
import { reviewExternalCandidate, detectabilityFloor, type CandidateClaim, type ReviewDeps } from "../src/review/externalReview.ts";
import type { LightCurve } from "../src/core/types.ts";

const CLAIMS: CandidateClaim[] = [
  { label: "Aakanksha", tic: 370612437, gaiaSourceId: "1981360227180249088", periodDays: 3.564921, epochBjd: 2458742.1409, depthPpm: 210, t14Hours: 1.44, rpEarth: 1.04, rpOverRs: 0.0144, impactParam: 0.73, sectors: [16, 17, 56, 57, 76, 77, 83, 84] },
  { label: "Orbit", tic: 252721481, gaiaSourceId: "1991778271640247808", periodDays: 4.933533, epochBjd: 2458740.6616, depthPpm: 279, t14Hours: 1.59, rpEarth: 1.1, rpOverRs: 0.0167, impactParam: 0.68, sectors: [16, 17, 57, 77, 84] },
];

async function ticsConfirmed() {
  const r = await fetchConfirmedPlanets({ maxTmag: 14, requireTic: true, limit: 6000 });
  const tics = new Set<number>();
  for (const p of r.planets) if (p.tic != null) tics.add(p.tic);
  return { tics, scanned: r.planets.length, source: r.source };
}
async function ticsToi() {
  const r = await fetchTocCandidates({ excludeConfirmedHosts: false, limit: 20000 });
  const tics = new Set<number>();
  for (const c of r.candidates) if (Number.isFinite(c.tic)) tics.add(c.tic);
  return { tics, scanned: r.candidates.length, source: r.source };
}

const deps: ReviewDeps = {
  confirmedTics: ticsConfirmed,
  toiTics: ticsToi,
  gaiaById: (id) => fetchGaiaBySourceId(id),
  gaiaNeighborhood: (ra, dec) => fetchGaiaNeighborhood(ra, dec, { radiusDeg: 21 / 3600 }),
  lightCurves: async (tic, sectors, label) => {
    const out: LightCurve[] = [];
    for (const s of sectors) {
      const lc = await fetchSpocLightCurve(tic, [s], label);
      if (lc) out.push(lc);
    }
    return out;
  },
  runBls: (lc) => detectTransit(lc).bls,
  // bounded cost guard on the research path (matches the offline survey discipline)
  calibratedSignificance: (lc, snr, period) => {
    const s = calibratedFap(lc, snr, period, { maxPoints: 2500, nNull: 60 });
    return { fap: s.fap, rho: s.rho };
  },
};

console.log("P16 INDEPENDENT REVIEW (via reusable library). Reviews another party's candidates -- NOT our discovery; his ephemeris withheld from our detector.\n");

for (const claim of CLAIMS) {
  const rep = await reviewExternalCandidate(claim, deps);
  console.log(`================ ${rep.label}  (TIC ${rep.tic}) ================`);
  console.log(`  [A novelty] in confirmed? ${rep.novelty.inConfirmed ? "YES" : "no"} | in TOI? ${rep.novelty.inToi ? "YES" : "no"}  (scanned ${rep.novelty.confirmedScanned} confirmed / ${rep.novelty.toiScanned} TOI @ ${rep.catalogStamp.asOfUtc})`);
  if (rep.host) {
    console.log(`  [B host] distance ${rep.host.distancePc.toFixed(1)} pc (${rep.host.distanceLy.toFixed(0)} ly), G=${rep.host.gmag.toFixed(2)}, RUWE=${rep.host.ruwe.toFixed(2)} (${rep.host.astrometryClean ? "clean" : "elevated"})`);
    if (rep.dilution && rep.blend) console.log(`         blend/EB risk = ${rep.blend.tier.toUpperCase()}: n=${rep.dilution.nInAperture}, brightest contrast ${rep.dilution.brightestContrastMag.toFixed(1)} mag, contamination ${rep.dilution.contaminationPct.toFixed(1)}% -> ${rep.blend.rationale}`);
  } else console.log(`  [B host] Gaia unavailable`);
  console.log(`  [D geometry] expected T14 ${rep.geometry.expectedT14Hours.toFixed(2)}h vs his ${claim.t14Hours}h (delta ${(rep.geometry.deltaPct * 100).toFixed(0)}%) -> ${rep.geometry.consistent ? "consistent" : "INCONSISTENT"}`);
  for (const d of rep.detection) {
    console.log(`  [C blind] ${d.tag}: n=${d.nPoints} cadence~${d.cadenceMin.toFixed(0)}min span ${d.spanDays.toFixed(0)}d | our peak ${d.blsPeakPeriod.toFixed(3)}d SNR ${d.blsPeakSnr.toFixed(1)}` +
      (d.rank ? ` | his ${claim.periodDays}d = power #${d.rank.rank + 1}/${d.rank.total}${d.fap != null ? ` | our-peak calibrated FAP ${d.fap.toFixed(3)} (rho ${d.rho?.toFixed(2)})` : ""}` : ""));
  }
  console.log(`  -> corroborated by our blind detector? ${rep.corroborated ? "YES" : "NO"}`);
  console.log(`  [E floor] ${rep.detectability.reason}`);

  // the cadence-sensitivity table: the SAME claimed planet across sampling regimes
  const row = [2, 5, 10, 20, 30, 60].map((cad) => {
    const f = detectabilityFloor(claim.depthPpm, claim.t14Hours, cad);
    return `${cad}min:${f.pointsInTransit.toFixed(1)}pts/${f.belowOurFloor ? "BLIND" : "ok"}`;
  });
  console.log(`  [E floor] depth ${claim.depthPpm}ppm T14 ${claim.t14Hours}h across cadences -> ${row.join("  ")}\n`);

  if (rep.notes.length) console.log(`  notes: ${rep.notes.join("; ")}\n`);
}

console.log("How to read: A/B/D are independent corroborations; C is OUR detector's verdict (a NO at coarse\n" +
  "cadence reflects the [E floor] row, i.e. our sensitivity, not evidence against the planet; the decisive\n" +
  "test stays the preregistered follow-up + ground-based neighbour clearing. Not our discovery.");
