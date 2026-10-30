// P100 (discovery roadmap: the PROSPECTIVE-GATE INSTRUMENT). R31 built the earned discovery gate
// (src/discover/discoveryGate.ts) and froze its criteria (discovery-protocol.json), but nothing consumed the
// gate and the measurement that is supposed to FEED it -- a forward precision/FAR run -- did not exist. This
// script builds that instrument and wires it end-to-end: it applies the FROZEN operating point (read from the
// protocol, never re-tuned here) to a seeded forward stream, measures precision (Wilson lower bound), the
// AR(1) false-alarm rate and the expected-false-claims, and hands those numbers to the gate to see what tier
// it returns. The point of the artifact is the WIRING + measurement math, proven to REFUSE an announcement when
// precision is below the floor (the lesson p99 taught) and to grant only nomination at best.
//
// HONEST SCOPE -- THIS IS AN INSTRUMENT CHECK, NOT A RESULT ON THE SKY:
//   - The forward stream is SEEDED SYNTHETIC light curves whose cadence / baseline / noise COLOR are anchored to
//     the committed REAL TESS-SPOC curves (tests/fixtures/spoc-curves, byte-exact) exactly as p98 does, so the
//     ensembles are realistic -- but they are injected-into-simulation, not a survey of unknown targets.
//   - The cross-sector corroboration the protocol demands is modelled as a deterministic stand-in (a deep, well-
//     recovered injected signal counts as coherent across 2 sectors; a null-curve false alarm does not). That is a
//     MODELLING ASSUMPTION used to exercise the code path, NOT a measured real-world corroboration yield. The real
//     run -- same frozen point applied to never-tuned archival targets, corroboration measured for real -- is the
//     next step and is what would actually be allowed to move a tier.
//   - OFFLINE + DETERMINISTIC + COMMITTED-FIXTURE REPLAY: default REPLAY re-derives every published number from
//     reports/fixtures/p100-frozen-cases.json (persisted by the measure run); the report re-hashes the frozen rows
//     + the protocol + the real curves it anchored to, so it is machine-verified with zero drift. This is a
//     METHODOLOGY / instrument validation, clearly labelled. It validates NOTHING about the sky, changes no
//     verdict, arms no gate. discoveryClaim false, safeToGate false.
//
// Usage: npm run p100:prospective-gate   [-- --curves 48 --injectfrac 0.5]   (add --measure to re-run + re-freeze)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildStamp } from "./report-freshness.ts";
import { bls } from "../src/detect/bls.ts";
import { preprocess } from "../src/detect/detrend.ts";
import { makeRedNoiseLightCurve, estimateRho } from "../src/sim/redNoise.ts";
import { scoreBlindTest, type Truth, type Detection } from "../src/sim/blindTest.ts";
import { evaluateDiscoveryGate, type CandidateEvidence, type DiscoveryProtocol } from "../src/discover/discoveryGate.ts";
import type { LightCurve } from "../src/core/types.ts";

const FIXTURE_DIR = join("tests", "fixtures", "spoc-curves");
const FROZEN = "reports/fixtures/p100-frozen-cases.json";
const PROTOCOL_PATH = "discovery-protocol.json";
const INJ_PERIOD = 3.5;
const INJ_DEPTH_PPM = 9000; // deep enough that a strong injection clears the frozen SNR/FAR point on real-anchored red noise
const ANCHOR_NOISE_PPM = 250;
const NARROW = { minPeriodDays: INJ_PERIOD * 0.95, maxPeriodDays: INJ_PERIOD * 1.05, oversample: 3, nDurations: 6 };

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit && Number.isFinite(Number(hit.split("=")[1]))) return Number(hit.split("=")[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const v = Number(process.argv[i + 1]); if (Number.isFinite(v)) return v; }
  return dflt;
}
function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }
function median(xs: number[]): number {
  const f = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const m = f.length >> 1;
  return f.length % 2 ? f[m]! : (f[m - 1]! + f[m]!) / 2;
}

function loadRealCurves(): LightCurve[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as { curves: { file: string; host: string }[] };
  const out: LightCurve[] = [];
  for (const entry of manifest.curves) {
    try {
      const raw = readFileSync(join(FIXTURE_DIR, entry.file), "utf8").replace(/\r\n/g, "\n").split("\n");
      const pts: { time: number; flux: number }[] = [];
      for (let i = 1; i < raw.length; i++) {
        const line = raw[i]!.trim(); if (!line) continue;
        const [t, f] = line.split(","); const tv = Number(t), fv = Number(f);
        if (Number.isFinite(tv) && Number.isFinite(fv)) pts.push({ time: tv, flux: fv });
      }
      if (pts.length >= 150) out.push({ targetId: entry.host, mission: "TESS", points: pts });
    } catch { /* skip unreadable fixture */ }
  }
  return out;
}

// One frozen case = one forward curve with its hidden truth and what the FROZEN operating point decided.
interface FrozenCase { id: string; rho: number; injected: boolean; detected: boolean; snr: number; fapAr1: number; corroboratedSectors: number; }

function measure(curves: number, injectFrac: number): FrozenCase[] {
  const hosts = loadRealCurves();
  if (hosts.length < 3) throw new Error("P100: too few committed real curves to anchor the forward stream");
  const realRho = hosts.map((h) => estimateRho(preprocess(h, 0.5).points.map((p) => p.flux))).filter(Number.isFinite);
  const cadenceSec = Math.max(median(hosts.map((h) => h.cadenceSec ?? 120)) || 200, 600);
  const baselineDays = Math.min(median(hosts.map((h) => h.points.length ? h.points[h.points.length - 1].time - h.points[0].time : 27)) || 13.5, 13.5);
  const rhoLo = Math.min(...realRho), rhoHi = Math.max(...realRho);
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  const { minSnr, maxAr1FalseAlarmProb } = proto.significanceBars;

  // A matched NULL ensemble (no planet) sets the empirical AR(1) false-alarm rate the frozen point keys on:
  // a candidate's FAR = fraction of null curves whose BLS SNR reaches its own. A strong injected planet clears
  // every null -> FAR 0 (passes the cap); a null's own FAR is >= 1/K (rejected). This is resolvable at a modest
  // K, unlike a per-candidate bootstrap that cannot report a FAR below 1/nNull. p98 uses the same surrogate idea.
  const NULL_K = 200;
  const nullSnrs: number[] = [];
  for (let j = 0; j < NULL_K; j++) {
    const r = rhoLo + (rhoHi - rhoLo) * ((j * 53) % 100) / 100;
    const nl = makeRedNoiseLightCurve({ seed: 90000 + j, periodDays: INJ_PERIOD, depthFrac: 0, rho: r, noisePpm: ANCHOR_NOISE_PPM, cadenceSec, baselineDays, dutyCycle: 0.9 });
    try { nullSnrs.push(bls(preprocess(nl, 0.5), NARROW).snr); } catch { /* degenerate */ }
  }
  nullSnrs.sort((a, b) => a - b);
  const farOf = (snr: number): number => { let c = 0; for (const s of nullSnrs) if (s >= snr) c++; return c / nullSnrs.length; };

  const rows: FrozenCase[] = [];
  for (let i = 0; i < curves; i++) {
    // deterministic rho sampled across the REAL measured distribution; deterministic injection density ~= injectFrac
    const rho = rhoLo + (rhoHi - rhoLo) * ((i * 37) % 100) / 100;
    const injected = Math.floor((i + 1) * injectFrac) > Math.floor(i * injectFrac);
    const lc = makeRedNoiseLightCurve({
      seed: 5000 + i, periodDays: INJ_PERIOD, depthFrac: injected ? INJ_DEPTH_PPM / 1e6 : 0,
      rho, noisePpm: ANCHOR_NOISE_PPM, cadenceSec, baselineDays, dutyCycle: 0.9,
    });
    let snr = 0;
    try { snr = bls(preprocess(lc, 0.5), NARROW).snr; } catch { /* degenerate */ }
    const fapAr1 = snr > 0 ? farOf(snr) : NaN;
    // FROZEN operating point: significant only if SNR >= floor AND the empirical AR(1) FAR <= cap (protocol, not re-tuned)
    const detected = snr >= minSnr && Number.isFinite(fapAr1) && fapAr1 <= maxAr1FalseAlarmProb;
    // corroboration MODELLED as a stand-in (see header): a deep recovered injected signal is treated as coherent
    // across 2 sectors; a null-curve detection is single-sector. NOT a measured real-world yield.
    let corroboratedSectors = 0;
    if (detected) corroboratedSectors = injected && snr >= minSnr * 1.5 ? 2 : 1;
    rows.push({ id: `fwd-${i}`, rho: Number(rho.toFixed(4)), injected, detected, snr: Number(snr.toFixed(2)), fapAr1: Number.isFinite(fapAr1) ? Number(fapAr1.toFixed(4)) : null as unknown as number, corroboratedSectors });
  }
  return rows;
}

function derive(rows: FrozenCase[]) {
  const truth: Truth[] = rows.map((r) => ({ id: r.id, injected: r.injected, periodDays: r.injected ? INJ_PERIOD : undefined, depthPpm: r.injected ? INJ_DEPTH_PPM : undefined }));
  const dets: Detection[] = rows.filter((r) => r.detected).map((r) => ({ id: r.id, periodDays: INJ_PERIOD, snr: r.snr, corroboratedSectors: r.corroboratedSectors }));
  const atBar1 = scoreBlindTest(truth, dets, { minCorroboration: 1 });
  const atBar2 = scoreBlindTest(truth, dets, { minCorroboration: 2 });
  // expected false claims if this bar were used for an announcement batch of size accepted: accepted * (1 - precision)
  const prec = atBar2.acceptedPrecision;
  const expectedFalseClaims = Number.isFinite(prec) ? atBar2.accepted * (1 - prec) : rows.length;
  return { atBar1, atBar2, expectedFalseClaims };
}

function gateResult(bar2: ReturnType<typeof derive>["atBar2"], precisionWilsonLB: number, expectedFalseClaims: number, proto: DiscoveryProtocol) {
  // a representative candidate that cleared every per-candidate bar, carrying the prospective instrument's numbers
  const c: CandidateEvidence = {
    novelty: { inConfirmed: false, inToi: false, confirmedScanned: 5000, toiScanned: 4000 },
    corroboration: { crossSectorEphemerisCoherentSectors: 2, catalogDuplicate: false, gaiaBlendRuledOut: true, psfOrDiffImagingClear: true, harmonicAliasFpp: 0.002, oddEvenAsymmetryFrac: 0.05 },
    significance: { snr: 12, ar1FalseAlarmProb: 0.0001 },
    prospective: { validated: true, precisionWilsonLowerBound: precisionWilsonLB, expectedFalseClaims },
    signoff: null, // no human sign-off in this instrument check
  };
  void bar2;
  return evaluateDiscoveryGate(c, proto);
}

function main() {
  const doMeasure = hasFlag("measure") || !existsSync(FROZEN);
  const proto = JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")) as DiscoveryProtocol;
  let rows: FrozenCase[];
  if (doMeasure) {
    rows = measure(Math.round(argNum("curves", 48)), argNum("injectfrac", 0.5));
    mkdirSync("reports/fixtures", { recursive: true });
    writeFileSync(FROZEN, JSON.stringify({ note: "P100 frozen forward-stream cases (seeded synthetic anchored to real SPOC cadence/noise; instrument validation only, not a sky result)", cases: rows }, null, 2) + "\n");
    console.log(`P100 MEASURED ${rows.length} forward cases and froze them to ${FROZEN}.`);
  } else {
    rows = (JSON.parse(readFileSync(FROZEN, "utf8")) as { cases: FrozenCase[] }).cases;
    console.log(`P100 REPLAY from ${FROZEN} (${rows.length} frozen cases) -- no recompute, zero drift.`);
  }
  const { atBar1, atBar2, expectedFalseClaims } = derive(rows);
  const precisionWilsonLB = atBar2.precisionCI[0];
  const floor = proto.prospectiveValidation.minPrecisionWilsonLowerBound;
  const gate = gateResult(atBar2, precisionWilsonLB, expectedFalseClaims, proto);

  const verdict = gate.tier === "none"
    ? `P100-INSTRUMENT-REFUSES-OPEN: on this seeded forward stream the frozen point yields precision Wilson-LB ${(precisionWilsonLB * 100).toFixed(1)}% < the ${(floor * 100).toFixed(0)}% floor (accepted ${atBar2.accepted}, false-accepts ${atBar2.falseAccepts}); the gate denies even nomination-for-announcement. The instrument CORRECTLY will not open the door -- this is the expected honest outcome, and it says NOTHING about the real sky.`
    : `P100-INSTRUMENT-WIRES-NOMINATION-ONLY: forward precision Wilson-LB ${(precisionWilsonLB * 100).toFixed(1)}%; the gate reaches tier "${gate.tier}" and discoveryClaimAllowed=${gate.discoveryClaimAllowed} (announcement still blocked without a real prospective run + human sign-off). Instrument plumbing validated; not a sky result.`;
  console.log(`  bar1 (significance-only): accepted ${atBar1.accepted} falseAccepts ${atBar1.falseAccepts} precision ${(atBar1.acceptedPrecision * 100).toFixed(0)}%`);
  console.log(`  bar2 (corroboration>=2):  accepted ${atBar2.accepted} falseAccepts ${atBar2.falseAccepts} precision ${(atBar2.acceptedPrecision * 100).toFixed(0)}% Wilson-LB ${(precisionWilsonLB * 100).toFixed(1)}%`);
  console.log(`  gate tier=${gate.tier} discoveryClaimAllowed=${gate.discoveryClaimAllowed}`);
  console.log(`VERDICT: ${verdict}`);

  const json = {
    meta: {
      ...buildStamp(["scripts/p100-prospective-gate.ts", FROZEN, PROTOCOL_PATH, join(FIXTURE_DIR, "manifest.json")]),
      generatedBy: "scripts/p100-prospective-gate.ts",
      protocol: "frozen operating point from discovery-protocol.json applied to a seeded forward stream (never re-tuned here)",
      data: "SEEDED SYNTHETIC forward stream anchored to committed REAL TESS-SPOC cadence/baseline/noise color; corroboration is a modelled stand-in. Instrument validation, NOT a real prospective survey.",
      note: "validates the prospective-measurement -> earned-gate wiring; claims nothing; arms nothing. discoveryClaim false, safeToGate false.",
    },
    forward: {
      nCases: rows.length, rhoLo: Math.min(...rows.map((r) => r.rho)), rhoHi: Math.max(...rows.map((r) => r.rho)),
      bar1: { accepted: atBar1.accepted, acceptedTp: atBar1.acceptedTp, falseAccepts: atBar1.falseAccepts, acceptedPrecision: atBar1.acceptedPrecision },
      bar2: { accepted: atBar2.accepted, acceptedTp: atBar2.acceptedTp, falseAccepts: atBar2.falseAccepts, acceptedPrecision: atBar2.acceptedPrecision, precisionWilsonLowerBound: Number(precisionWilsonLB.toFixed(4)), expectedFalseClaims: Number(expectedFalseClaims.toFixed(3)) },
    },
    gate: { tier: gate.tier, discoveryClaimAllowed: gate.discoveryClaimAllowed, unmet: gate.unmet, precisionFloor: floor },
    rows, verdict, discoveryClaim: false, safeToGate: false,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/p100-prospective-gate.json", JSON.stringify(json, null, 2) + "\n");
  const md = [
    "# P100 - Prospective-Gate Instrument (seeded forward stream -> earned gate)",
    "",
    "Generated by `scripts/p100-prospective-gate.ts`. **An instrument/methodology validation, not a result on the sky.**",
    "It applies the FROZEN operating point from `discovery-protocol.json` (never re-tuned here) to a seeded forward",
    "stream whose cadence/baseline/noise color are anchored to the committed real TESS-SPOC curves, measures precision",
    "(Wilson lower bound), the AR(1) FAR and expected-false-claims, and hands those to `src/discover/discoveryGate.ts`.",
    "Cross-sector corroboration is a **modelled stand-in** (deep recovered injected = coherent across 2 sectors; null",
    "detection = single-sector), used to exercise the code path -- not a measured real-world yield. discoveryClaim false,",
    "safeToGate false; nothing is claimed, gated or anchored.",
    "",
    "## Frozen operating point (from the pre-registered protocol)",
    `- min SNR ${proto.significanceBars.minSnr}; max AR(1) FAR ${proto.significanceBars.maxAr1FalseAlarmProb}; announcement precision floor (Wilson LB) ${(floor * 100).toFixed(0)}%.`,
    "",
    "## Forward stream (offline, deterministic, replayed from committed frozen cases)",
    `- ${rows.length} seeded curves, rho anchored to the real ${Math.min(...rows.map((r) => r.rho)).toFixed(2)}..${Math.max(...rows.map((r) => r.rho)).toFixed(2)}.`,
    `- significance-only (bar 1): accepted ${atBar1.accepted}, false-accepts ${atBar1.falseAccepts}, precision ${(atBar1.acceptedPrecision * 100).toFixed(0)}%.`,
    `- corroboration-gated (bar 2): accepted ${atBar2.accepted}, false-accepts ${atBar2.falseAccepts}, precision ${(atBar2.acceptedPrecision * 100).toFixed(0)}%, Wilson LB ${(precisionWilsonLB * 100).toFixed(1)}%, expected false claims ${expectedFalseClaims.toFixed(2)}.`,
    "",
    "## What the gate returned",
    `- tier **${gate.tier}**, discoveryClaimAllowed **${gate.discoveryClaimAllowed}**`,
    `- unmet: ${gate.unmet.length ? gate.unmet.join(" | ") : "(none)"}`,
    "",
    "## VERDICT",
    `**${verdict}**`,
    "",
    "Reproduce: `npm run p100:prospective-gate`",
    "",
  ].join("\n");
  writeFileSync("reports/p100-prospective-gate.md", md);
}

main();
