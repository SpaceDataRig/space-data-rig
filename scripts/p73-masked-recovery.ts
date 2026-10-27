// P73 - MASKED RECOVERY (borrowed from eumemic/exoplanets --mask-tois): is the P62/P67 "seed wall" mostly
// SIBLING CROWDING, i.e. does masking the host's OTHER catalogued planets with their catalog ephemerides let
// the joint fold recover the target?
//
// WHY THIS EXISTS. P62 localised the joint-search bottleneck to SEED ACQUISITION: on multi-planet hosts the BLS
// peak locks onto a NEIGHBOURING planet or a harmonic, so a blind fold seeded at that wrong peak re-finds only
// 4-6/20 while a truth-seeded ORACLE fold reaches 10/20. P67 showed the production iterative detector only lifts
// seed recall to 5/20 (it masks a signal's OWN box, not the catalogued siblings). The external project's answer
// is different and stronger: MASK every already-known planet (TOI/planet) using its catalog period+epoch+duration
// widened, THEN search the residual for additional planets. We have never applied catalog-sibling masking to the
// seed problem. This study closes that gap and, crucially, BOUNDS how much of the wall is sibling-crowding vs
// intrinsic (alias/noise) confusion.
//
// STRICT A/B on the SAME P60/P62 planets (read back from reports/p60 so nothing is re-selected), same fetch path,
// same tol/snr/window as P67. For each target we mask the host's OTHER confirmed planets (from pscomppars: those
// with pl_orbper + pl_tranmid + pl_trandur) and compare re-find across arms:
//   SINGLE         - best-SNR single-sector bls() peak                     (continuity, ~6/20)
//   NAIVE-JOINT    - bls() on the full stitched baseline                    (continuity, ~6/20)
//   MASK-JOINT     - mask catalog siblings on the stitched curve, then bls  (THE borrowed lever)
//   MASK-ITER-1    - mask siblings, then iterativeBls top-1                 (masking + production detector)
//   MASK-ITER-K    - ANY of the top-k iterative signals after masking       (seed recall ceiling, masked)
//   ORACLE         - narrow phase-aligned fold seeded at truth              (diagnostic ceiling, ~10/20)
//
// HONESTY BOUND. MASK-* arms consume GROUND-TRUTH catalog ephemerides of the SIBLINGS, so they are an ASSITED
// upper bound ("if you already know the other planets, how many targets come back"), NOT a fully blind claim.
// Positive control on KNOWN planets; research probe: no worker import, no verdict / bundle hash / money path,
// nothing gated, anchored or claimed. discoveryClaim structurally false.
//
// Run: npm run p73:masked-recovery [-- --minsnr 7 --tol 5 --win 0.10 --k 3 --maxsectors 4 --tmag 11 --pad 0.25 --minperiod 1 --maxperiod 13]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { bls } from "../src/detect/bls.ts";
import { iterativeBls, inTransitMask } from "../src/detect/iterative.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { sectorsForCoord, fetchSpocLightCurve, stitchLightCurves } from "../src/data/mastS3.ts";
import type { LightCurve, ArchivePlanet } from "../src/core/types.ts";
import { buildStamp } from "./report-freshness.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

const maxSectors = Math.max(2, parseInt(arg("maxsectors", "4"), 10));
const minPeriod = Number(arg("minperiod", "1"));
const maxPeriod = Number(arg("maxperiod", "13"));
const tmagCap = Number(arg("tmag", "11"));
const minSnr = Number(arg("minsnr", "7"));
const tolPct = Number(arg("tol", "5"));
const win = Number(arg("win", "0.10"));
const k = Math.max(1, parseInt(arg("k", "3"), 10));
const padFrac = Number(arg("pad", "0.25")); // widen each sibling's transit window (proxy for their 3-sigma timing-error widening)

const matched = (period: number, cat: number) => Number.isFinite(period) && Math.abs(period - cat) / cat * 100 <= tolPct;

async function fetchSectorCurve(tic: number, sector: number, name: string): Promise<LightCurve | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const lc = await fetchSpocLightCurve(tic, [sector], name); if (lc) return lc; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

/** Remove every cadence that is in-transit for any sibling ephemeris. Never mutates the input. */
function maskSiblings(lc: LightCurve, siblings: { period: number; epoch: number; durDays: number }[]): LightCurve {
  const times = lc.points.map((p) => p.time);
  const drop = times.map(() => false);
  for (const s of siblings) {
    const m = inTransitMask(times, s.period, s.epoch, s.durDays, padFrac);
    for (let i = 0; i < m.length; i++) if (m[i]) drop[i] = true;
  }
  const points = lc.points.filter((_, i) => !drop[i]);
  return { ...lc, points };
}

interface Row {
  name: string; catPeriod: number; nSectors: number; nSiblings: number; siblingsMasked: number;
  single: boolean; naiveJoint: boolean; maskJoint: boolean; maskIter1: boolean; maskIterK: boolean; oracle: boolean;
  naiveJointPeriod: number; maskJointPeriod: number; maskIterPeriod: number;
  naiveJointSnr: number; maskJointSnr: number;
}

async function main(): Promise<void> {
  let baseline: { name: string; catPeriod: number }[] = [];
  try {
    const p60 = JSON.parse(readFileSync("reports/p60-joint-vs-single.json", "utf8"));
    baseline = (p60.rows || []).map((r: any) => ({ name: r.name, catPeriod: r.catPeriod }));
  } catch { console.log("  (could not read reports/p60 -- falling back to fresh selection)"); }
  const wantNames = new Set(baseline.map((b) => b.name));
  const catPeriodByName = new Map(baseline.map((b) => [b.name, b.catPeriod]));

  console.log(`P73 MASKED-RECOVERY: does masking catalogued sibling planets (their ephemerides +-${(padFrac * 100).toFixed(0)}% widened) lift joint re-find on the ${baseline.length || "?"} P60/P62 planets? tol ${tolPct}%, minSnr ${minSnr}, refine window +-${(win * 100).toFixed(0)}%, k=${k}. REAL SPOC photometry, token-free; positive control on known planets; discoveryClaim false.`);

  const fetched = await fetchConfirmedPlanets({ maxTmag: tmagCap, requireTic: true, limit: 8000 });
  const allPlanets = fetched.planets.filter((p) => p.tic != null && p.ra != null && p.dec != null);
  // group every catalogued planet by host star so we can mask the OTHER planets on a target's own host.
  const byHost = new Map<string, ArchivePlanet[]>();
  for (const p of allPlanets) {
    const key = p.hostname || `TIC ${p.tic}`;
    (byHost.get(key) || byHost.set(key, []).get(key)!).push(p);
  }
  const targets = allPlanets
    .filter((p) => wantNames.size === 0 || wantNames.has(p.pl_name ?? p.hostname ?? ""))
    .slice(0, 40);

  const rows: Row[] = [];
  for (const p of targets) {
    const name = p.pl_name ?? p.hostname ?? `TIC ${p.tic}`;
    const catPeriod = catPeriodByName.get(name) ?? p.pl_orbper ?? NaN;
    if (!Number.isFinite(catPeriod) || catPeriod < minPeriod || catPeriod > maxPeriod) continue;

    // SIBLINGS = other confirmed planets on the SAME host with a usable ephemeris.
    const host = p.hostname || `TIC ${p.tic}`;
    const siblings = (byHost.get(host) || [])
      .filter((q) => q.pl_name !== p.pl_name && Number.isFinite(q.pl_orbper!) && Number.isFinite(q.pl_tranmid!) && Number.isFinite(q.pl_trandur!))
      .map((q) => ({ period: q.pl_orbper!, epoch: q.pl_tranmid!, durDays: q.pl_trandur! / 24 }));

    let sectors: number[];
    try { sectors = await sectorsForCoord(p.ra!, p.dec!); } catch { continue; }
    if (sectors.length < 2) continue;
    const sectorLcs: LightCurve[] = [];
    for (const s of sectors.slice(0, maxSectors)) {
      const lc = await fetchSectorCurve(p.tic!, s, name);
      if (lc && lc.points.length >= 60) sectorLcs.push(lc);
    }
    if (sectorLcs.length < 2) continue;
    const stitched = stitchLightCurves(sectorLcs);
    if (!stitched) continue;

    // SINGLE: best-SNR single-sector peak.
    let single = { periodDays: NaN, snr: -Infinity };
    for (const lc of sectorLcs) {
      let b; try { b = bls(lc, { maxPeriodDays: maxPeriod + 2 }); } catch { continue; }
      if (b.snr > single.snr) single = { periodDays: b.periodDays, snr: b.snr };
    }
    // NAIVE-JOINT: full-range stitched BLS.
    let joint; try { joint = bls(stitched, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2 }); } catch { joint = null; }
    // MASK siblings on the stitched curve, then re-run joint BLS and the iterative detector.
    const masked = siblings.length ? maskSiblings(stitched, siblings) : stitched;
    let mjoint; try { mjoint = bls(masked, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2 }); } catch { mjoint = null; }
    let iter; try { iter = iterativeBls(masked, { maxPeriodDays: maxPeriod + 2, maxSignals: k, minSnr }); } catch { iter = { signals: [] }; }
    const isigs = iter.signals || [];
    const foldRecover = (seedPeriod: number) => {
      if (!(Number.isFinite(seedPeriod) && seedPeriod > 1)) return false;
      try { const b = bls(masked, { minPeriodDays: seedPeriod * (1 - win), maxPeriodDays: seedPeriod * (1 + win), oversample: 24 }); return b.snr >= minSnr && matched(b.periodDays, catPeriod); } catch { return false; }
    };

    const rec = (period: number, snr: number) => snr >= minSnr && matched(period, catPeriod);
    const row: Row = {
      name, catPeriod, nSectors: sectorLcs.length, nSiblings: siblings.length,
      siblingsMasked: stitched.points.length - masked.points.length,
      single: rec(single.periodDays, single.snr),
      naiveJoint: !!joint && rec(joint.periodDays, joint.snr),
      maskJoint: !!mjoint && rec(mjoint.periodDays, mjoint.snr),
      maskIter1: !!isigs[0] && rec(isigs[0].periodDays, isigs[0].snr),
      maskIterK: isigs.some((s) => rec(s.periodDays, s.snr)),
      oracle: foldRecover(catPeriod),
      naiveJointPeriod: joint?.periodDays ?? NaN, maskJointPeriod: mjoint?.periodDays ?? NaN,
      maskIterPeriod: isigs[0]?.periodDays ?? NaN,
      naiveJointSnr: joint?.snr ?? -Infinity, maskJointSnr: mjoint?.snr ?? -Infinity,
    };
    rows.push(row);
    console.log(`  ${name.padEnd(16)} P=${catPeriod.toFixed(3)}d nsec ${row.nSectors} sib ${row.nSiblings} (masked ${row.siblingsMasked} cad)  single[${row.single ? "R" : "-"}] joint[${row.naiveJoint ? "R" : "-"} ${Number.isFinite(row.naiveJointPeriod) ? row.naiveJointPeriod.toFixed(2) : "?"}] MASK-joint[${row.maskJoint ? "R" : "-"} ${Number.isFinite(row.maskJointPeriod) ? row.maskJointPeriod.toFixed(2) : "?"}] mask-iter1[${row.maskIter1 ? "R" : "-"}] top${k}[${row.maskIterK ? "R" : "-"}] oracle[${row.oracle ? "R" : "-"}]`);
  }

  if (rows.length < 5) {
    console.log(`\nonly ${rows.length} planets resolved. VERDICT: INSUFFICIENT-DATA (re-run shortly)`);
    process.exitCode = 0; return;
  }

  const n = rows.length;
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  const single = cnt((r) => r.single), naive = cnt((r) => r.naiveJoint), maskJoint = cnt((r) => r.maskJoint);
  const maskIter1 = cnt((r) => r.maskIter1), maskIterK = cnt((r) => r.maskIterK), oracle = cnt((r) => r.oracle);
  const withSib = cnt((r) => r.nSiblings > 0);
  const [mjLo, mjHi] = wilsonInterval(maskJoint, n);
  // paired: masking recovered targets the blind joint fold MISSED (and the reverse regressions).
  const gainedByMask = cnt((r) => r.maskJoint && !r.naiveJoint);
  const lostByMask = cnt((r) => r.naiveJoint && !r.maskJoint);
  const netMask = maskJoint - naive;

  console.log(`\n=== P73 SUMMARY (${n} confirmed planets; ${withSib} have >=1 catalogued sibling) ===`);
  console.log(`  SINGLE        ${single}/${n}`);
  console.log(`  NAIVE-JOINT   ${naive}/${n}   (continuity control, P62 = 6/20)`);
  console.log(`  MASK-JOINT    ${maskJoint}/${n}  [${(100 * mjLo).toFixed(0)}, ${(100 * mjHi).toFixed(0)}]   net ${netMask >= 0 ? "+" : ""}${netMask} vs naive; +${gainedByMask} gained / -${lostByMask} lost`);
  console.log(`  MASK-ITER-1   ${maskIter1}/${n} | MASK-ITER-${k} ${maskIterK}/${n}`);
  console.log(`  ORACLE        ${oracle}/${n}   (truth-seed ceiling, P62 = 10/20)`);

  const clearLift = maskJoint - naive >= 3;
  const modestLift = maskJoint > naive;
  const verdict = clearLift
    ? `SIBLING-CROWDING-IS-A-MAJOR-PART: masking catalogued siblings lifts joint re-find ${naive}->${maskJoint}/${n} (+${gainedByMask} recovered that the blind fold missed), closing a large fraction of the ${naive}->${oracle} P62 gap. The seed wall is substantially a NEIGHBOUR-locking problem -- for hosts whose other planets are already catalogued, the borrowed --mask-tois lever recovers them. ASSISTED bound (uses catalog ephemerides), so this bounds the ceiling rather than claiming a blind win.`
    : modestLift
      ? `MODEST-SIBLING-LIFT: masking siblings nudges re-find ${naive}->${maskJoint}/${n} (+${gainedByMask}/-${lostByMask}) but stays well under the ORACLE ${oracle}/${n} -- neighbour-lock is only part of the wall; the rest is intrinsic alias/noise confusion.`
      : `SIBLING-MASK-NO-LIFT: masking catalogued siblings does NOT improve joint re-find (${naive}->${maskJoint}/${n}, ${lostByMask} regressions) -- the P62 wrong-period lock is NOT mainly catalogued-neighbour crowding but harmonics/aliases/noise on these few-sector baselines; the wall is intrinsic.`;
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`  positive control on KNOWN planets; MASK arms are an ASSISTED upper bound (catalog sibling ephemerides); NOT a discovery; no gate relaxed. discoveryClaim false.`);

  mkdirSync("reports", { recursive: true });
  const json = {
    meta: {
      ...buildStamp(["reports/p60-joint-vs-single.json", "scripts/p73-masked-recovery.ts"]),
      generatedBy: "scripts/p73-masked-recovery.ts", n, k, maxSectors, minPeriod, maxPeriod, tmagCap, minSnr, tolPct, win, padFrac,
      arms: "recovered = best period matches catalog truth within tol at snr>=floor. SINGLE best per-sector bls; NAIVE-JOINT bls(stitched); MASK-* masks the host's OTHER catalogued planets (period+tranmid+trandur widened +-pad) on the stitched curve before searching; ORACLE truth-seeded narrow fold.",
      data: "real TESS-SPOC light curves (token-free public S3) + NASA pscomppars ephemerides; strict A/B on the P60/P62/P67 sample",
      note: "tests whether eumemic-style catalog-sibling masking clears the P62 'seed wall'; MASK arms use ground-truth sibling ephemerides so they are an ASSISTED ceiling, not a blind claim; nothing gated; discoveryClaim false.",
    },
    refind: {
      single, naiveJoint: naive, maskJoint: { count: maskJoint, n, ciLow: mjLo, ciHigh: mjHi },
      maskIter1, maskIterK, oracle, n,
    },
    paired: { gainedByMask, lostByMask, netMask, withSiblings: withSib },
    verdict: clearLift ? "SIBLING-CROWDING-MAJOR" : modestLift ? "MODEST-SIBLING-LIFT" : "SIBLING-MASK-NO-LIFT",
    bottleneck: clearLift ? "partially-sibling-crowding" : "intrinsic-alias-noise",
    safeToGate: false,
    discoveryClaim: false,
    rows,
  };
  writeFileSync("reports/p73-masked-recovery.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P73 masked recovery: is the P62 'seed wall' mostly sibling crowding?",
    "",
    `Reproduce: \`npm run p73:masked-recovery -- --minsnr ${minSnr} --tol ${tolPct} --win ${win} --k ${k} --pad ${padFrac}\``,
    "",
    "P62/P67 put the joint-search bottleneck on SEED ACQUISITION: a blind fold locks onto a neighbouring planet",
    "or a harmonic and re-finds only 4-6/20, while a truth-seeded ORACLE fold reaches 10/20. The external",
    "eumemic/exoplanets pipeline attacks this a different way -- it MASKS every already-known planet (catalog",
    "period+epoch+duration widened) and searches the residual. This study applies that lever on the SAME P60",
    `planets: for each target we mask its host's OTHER confirmed planets and compare re-find (${n} planets, ${withSib} with >=1 catalogued sibling).`,
    "",
    "| arm | re-find /${n} |".replace("${n}", String(n)),
    "|---|---|",
    `| SINGLE (best per-sector) | ${single}/${n} |`,
    `| NAIVE-JOINT (stitched BLS) | ${naive}/${n} |`,
    `| MASK-JOINT (siblings masked, then BLS) | ${maskJoint}/${n}  [95% Wilson ${(100 * mjLo).toFixed(0)}-${(100 * mjHi).toFixed(0)}%] |`,
    `| MASK-ITERATIVE top-1 | ${maskIter1}/${n} |`,
    `| MASK-ITERATIVE top-${k} (any) | ${maskIterK}/${n} |`,
    `| ORACLE (truth seed, ceiling) | ${oracle}/${n} |`,
    "",
    `Masking gained ${gainedByMask} re-finds the blind joint fold missed and lost ${lostByMask} (net ${netMask >= 0 ? "+" : ""}${netMask}).`,
    "",
    "**Honesty bound.** The MASK arms consume GROUND-TRUTH catalog ephemerides of the siblings, so they are an",
    "ASSISTED ceiling (\"how many come back if you already know the neighbours\"), not a fully blind result.",
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Positive control on known planets; discovery claims structurally false; nothing gated, anchored or deployed.",
    "",
  ].join("\n");
  writeFileSync("reports/p73-masked-recovery.md", md);
  console.log("\nwrote reports/p73-masked-recovery.md and reports/p73-masked-recovery.json");
}

main().catch((e) => { console.error(`[p73] error: ${e instanceof Error ? e.stack ?? e.message : e}`); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
