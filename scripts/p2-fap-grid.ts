// P2 FAP GRID PROBE: quantify the observed-vs-null period-grid mismatch on the FULL-RESOLUTION path.
//
// On the real-photometry path calibratedFap runs at FULL resolution (no maxPoints cost guard), so the
// observed statistic is the caller's detection SNR -- the global max of a WIDE period search
// (scout: 0.8..16 d). But the null ensemble is searched over a NARROW window (0.7P..1.5P). A wide-grid
// maximum is systematically larger than a narrow-grid maximum (more independent frequencies), so the
// observed value sits high relative to the narrow-null distribution and the empirical FAP is pushed
// toward its floor: the gate under-rejects (is "toothless") on that path.
//
// This probe MEASURES that mismatch instead of asserting it. For each seeded full-resolution red-noise
// curve it computes the detection SNR on the production wide grid, then two FAPs:
//   fapNarrow = calibratedFap with the DEFAULT narrow null grid   (current real-path behaviour)
//   fapWide   = calibratedFap with nulls searched over the SAME wide grid as the detection (matched)
// Comparing them on planet-free curves shows how much the narrow nulls under-state the false-alarm
// probability; comparing on injected-planet curves shows whether widening would false-reject real
// planets (the safety question that must be answered before any gate change ships).
//
// Fully offline + deterministic (seeded synthetic curves, fixed null seeds). Nothing is anchored or
// claimed. Dev/CI diagnostic only.
//
// Usage: npm run p2:fap-grid
import { makeRedNoiseLightCurve } from "../src/sim/redNoise.ts";
import { detectTransit } from "../src/detect/pipeline.ts";
import { calibratedFap } from "../src/detect/significance.ts";

// The production scout grid (src/seats/seats.ts scout -> detectTransit). The observed SNR comes from here.
const SCOUT = { minPeriodDays: 0.8, maxPeriodDays: 16, oversample: 8, nDurations: 12 };
const NNULL = 40; // probe budget; production real path uses 120
const FAP_CUT = 0.05;
const cfg = { cadenceSec: 300, baselineDays: 27, noisePpm: 300 };

interface Row {
  label: string;
  rho: number;
  snr: number;
  fapNarrow: number;
  fapWide: number;
  downsampled: boolean;
}

function measure(label: string, seed: number, rho: number, depthFrac: number): Row {
  const lc = makeRedNoiseLightCurve({
    seed,
    periodDays: 2.5,
    depthFrac,
    noisePpm: cfg.noisePpm,
    rho,
    cadenceSec: cfg.cadenceSec,
    baselineDays: cfg.baselineDays,
  });
  const det = detectTransit(lc, SCOUT);
  const cand = det.candidate; // production feeds cand.snr / cand.periodDays into calibratedFap
  // Current real-path behaviour: full resolution (no maxPoints) + default narrow null grid.
  const narrow = calibratedFap(lc, cand.snr, cand.periodDays, { nNull: NNULL });
  // Matched reference: nulls searched over the same wide grid the detection used.
  const wide = calibratedFap(lc, cand.snr, cand.periodDays, {
    nNull: NNULL,
    minPeriodDays: SCOUT.minPeriodDays,
    maxPeriodDays: SCOUT.maxPeriodDays,
  });
  return { label, rho, snr: cand.snr, fapNarrow: narrow.fap, fapWide: wide.fap, downsampled: narrow.downsampled || wide.downsampled };
}

const rows: Row[] = [];
console.log("P2 FAP GRID PROBE -- full resolution, offline, deterministic. Nothing anchored/claimed.");
console.log(`scout(observed) grid 0.8..16d os8 | null-narrow default 0.7P..1.5P os6 | null-wide 0.8..16d os6 | nNull=${NNULL} cut=${FAP_CUT}`);
console.log("");
console.log("pop     label        rho   obsSNR   fapNarrow  fapWide   narrow<=cut  wide<=cut");

let noiseNarrowAccept = 0;
let noiseWideAccept = 0;
const NOISE = 8;
for (let i = 0; i < NOISE; i++) {
  const rho = [0, 0.3, 0.6, 0.2, 0.5, 0.1, 0.4, 0.6][i] ?? 0.3;
  const r = measure(`NULL-${i}`, 900 + i, rho, 0);
  rows.push(r);
  const na = r.fapNarrow <= FAP_CUT;
  const wa = r.fapWide <= FAP_CUT;
  if (na) noiseNarrowAccept++;
  if (wa) noiseWideAccept++;
  console.log(
    `noise   ${r.label}   ${r.rho.toFixed(2)}  ${r.snr.toFixed(1).padStart(6)}   ${r.fapNarrow.toPrecision(2).padStart(8)}  ${r.fapWide.toPrecision(2).padStart(7)}   ${na ? "YES(toothless)" : "no".padStart(4)}      ${wa ? "YES" : "no"}`,
  );
}

let planetNarrowAccept = 0;
let planetWideAccept = 0;
const PLANET = 4;
for (let i = 0; i < PLANET; i++) {
  const rho = [0, 0.3, 0.5, 0.6][i] ?? 0.3;
  const r = measure(`PLA-${i}`, 700 + i, rho, 0.01);
  rows.push(r);
  const na = r.fapNarrow <= FAP_CUT;
  const wa = r.fapWide <= FAP_CUT;
  if (na) planetNarrowAccept++;
  if (wa) planetWideAccept++;
  console.log(
    `planet  ${r.label}   ${r.rho.toFixed(2)}  ${r.snr.toFixed(1).padStart(6)}   ${r.fapNarrow.toPrecision(2).padStart(8)}  ${r.fapWide.toPrecision(2).padStart(7)}   ${na ? "yes" : "NO(FALSE-KILL)"}      ${wa ? "yes" : "NO(FALSE-KILL)"}`,
  );
}

const anyDown = rows.some((r) => r.downsampled);
console.log("");
console.log(`full-resolution confirmed (downsampled=false everywhere): ${!anyDown}`);
console.log(`planet-free: narrow-null false-accept ${noiseNarrowAccept}/${NOISE}  vs  wide-null(matched) ${noiseWideAccept}/${NOISE}`);
console.log(`planet     : narrow-null keep ${planetNarrowAccept}/${PLANET}  vs  wide-null(matched) keep ${planetWideAccept}/${PLANET}`);
console.log("");
console.log("Reading:");
console.log("  - If planet-free narrow-null false-accept >> wide-null, the narrow nulls UNDER-state the FAP");
console.log("    (observed is a wide-grid max, nulls are narrow-grid maxima) => the real-path gate is toothless.");
console.log("  - If planet wide-null keep == PLANET, widening the null grid would NOT false-reject real planets,");
console.log("    so matching the null grid to the detection grid is a safe completeness-preserving fix.");
console.log("  - If planet wide-null keep < PLANET, widening kills real planets and must NOT ship as a gate.");
