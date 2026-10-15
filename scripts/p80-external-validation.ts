// P80 -- EXTERNAL-CANDIDATE INDEPENDENT VALIDATION (audit finding 9, gap 3: the 0/2 number).
//
// The earlier 0/2 was STRUCTURAL (P65 audits with an empty catalog, so an outside claim can never
// self-corroborate and caps at needs-more-data). That is correct safety behaviour but left the project with no
// demonstrated independent-validation path. Here we build one and MEASURE it on real data:
//   - ingest EXTERNAL claims from the anonymous ExoFOP-TESS table, split into
//       KP  (confirmed planets)   -> positive control that the machinery validates what it should; and
//       CP  (candidate planets, NOT yet confirmed) -> genuine, still-uncertain external candidates.
//   - run the detector BLIND (the claim's ephemeris is NEVER fed to it; it searches periods 1-13 d),
//     SECTOR BY SECTOR on the claim's own real SPOC sectors, and group detections by period across
//     independent sectors (corroboration = number of distinct sectors).
//   - INDEPENDENTLY CONFIRM (src/candidate/independentValidation.ts) a claim when some
//     corroboration>=minCorr blind cluster matches its period within tol. The detection path and the external
//     claim are independent, so agreement is confirmation, not the detector echoing the input.
//
// DEPTH STRATIFICATION (audit-10 #5): the headline numbers come from the EASIEST subset (deep + bright +
// multi-sector). To stop that from being read as a universal rate, we ALSO run a HARDER tier at shallow depths
// (default 300-1000 ppm) -- shallow transits are the hard regime, and a low/zero validation there is expected
// and reported, not hidden. Every tier carries its own selection conditions in the headline.
//
// Honest limits: period-only corroboration still admits aliases (P78: 2-sector accepted precision ~47%), so a
// CP "confirmation" is a first independent CHECK that materially supports a candidate -- NOT a discovery or a
// validation to TRICERATOPS precision. Research only: no worker import, no verdict, no bundle hash, no money
// path; nothing gated or claimed. discoveryClaim false, safeToGate false.
//
// Usage: npm run p80:external-validation [-- --kp 10 --cp 8 --sectors 4 --tmag 11 --min-depth 3000 --tol 0.02 --min-corr 2 --hard 1 --hard-min 300 --hard-max 1000 --hard-cp 10]

import { iterativeBls } from "../src/detect/iterative.ts";
import { classifyDepthRegime } from "../src/candidate/falsePositive.ts";
import { fetchToiTable, isPlaceable, type ToiRecord } from "../src/data/toiDispositions.ts";
import { resolveSpocKey, fetchSpocBytes } from "../src/data/mastS3.ts";
import { fitsToLightCurve } from "../src/data/mast.ts";
import { independentlyConfirmed } from "../src/candidate/independentValidation.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LightCurve } from "../src/core/types.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const num = (n: string, d: number) => { const v = Number(arg(n, String(d))); return Number.isFinite(v) ? v : d; };

const wantKp = Math.max(0, Math.round(num("kp", 10)));
const wantCp = Math.max(0, Math.round(num("cp", 8)));
const sectorCap = Math.max(2, Math.round(num("sectors", 4)));
const tmagCap = num("tmag", 11);
const minDepth = num("min-depth", 3000);
const TOL = num("tol", 0.02);
const MIN_CORR = Math.round(num("min-corr", 2));
const minPeriod = 1, maxPeriod = 13;
// Harder (shallow-depth) tier. Same brightness / period / sector bar, only the depth is lowered -- shallow
// transits are where a blind per-sector search loses power, so this tier is expected to validate less.
const doHard = num("hard", 1) > 0;
const hardMin = num("hard-min", 300);
const hardMax = num("hard-max", 1000);
const hardKp = Math.max(0, Math.round(num("hard-kp", 6)));
const hardCp = Math.max(0, Math.round(num("hard-cp", 10)));

type Tier = "easy" | "hard";
interface Cluster { periodDays: number; corroboratedSectors: number; depthPpm: number; }
interface Hit { sector: number; periodDays: number; depthPpm: number; }

function detectSignals(lc: LightCurve, maxSignals: number): { periodDays: number; depthPpm: number }[] {
  try {
    const it = iterativeBls(lc, { minPeriodDays: minPeriod, maxPeriodDays: maxPeriod + 2, maxSignals });
    return it.signals.filter((s) => classifyDepthRegime(s.depthPpm).planetPlausible).map((s) => ({ periodDays: s.periodDays, depthPpm: s.depthPpm }));
  } catch { return []; }
}

async function clustersForTic(tic: number, sectors: number[], name: string): Promise<{ clusters: Cluster[]; nSectors: number }> {
  const list = (sectors.length ? sectors : []).slice(0, sectorCap);
  const hits: Hit[] = [];
  let used = 0;
  for (let k = 0; k < list.length; k++) {
    let bytes: Uint8Array | null = null;
    try { bytes = await fetchSpocBytes(resolveSpocKey(tic, list[k], "lc"), { timeoutMs: 20000 }); } catch { /* skip */ }
    if (!bytes) continue;
    let lc: LightCurve | null = null;
    try { lc = fitsToLightCurve(bytes, name); } catch { /* skip */ }
    if (!lc || lc.points.length < 120) continue;
    used++;
    for (const s of detectSignals(lc, 3)) hits.push({ sector: used - 1, periodDays: s.periodDays, depthPpm: s.depthPpm });
  }
  // cluster by period (rel tol 0.05, one signal per sector per cluster); corroboration = distinct sectors
  const sorted = [...hits].sort((a, b) => a.periodDays - b.periodDays);
  const cs: { periods: number[]; depths: number[]; sectors: Set<number> }[] = [];
  for (const h of sorted) {
    let t: (typeof cs)[number] | undefined;
    for (const c of cs) { if (c.sectors.has(h.sector)) continue; const m = c.periods[Math.floor(c.periods.length / 2)]; if (Math.abs(m - h.periodDays) / m <= 0.05) { t = c; break; } }
    if (!t) { t = { periods: [], depths: [], sectors: new Set() }; cs.push(t); }
    t.periods.push(h.periodDays); t.depths.push(h.depthPpm); t.sectors.add(h.sector);
  }
  const clusters: Cluster[] = cs.map((c) => ({ periodDays: c.periods[Math.floor(c.periods.length / 2)], depthPpm: c.depths[Math.floor(c.depths.length / 2)], corroboratedSectors: c.sectors.size }));
  return { clusters, nSectors: used };
}

/** Best blind confirmation for a claim: among corroboration>=MIN_CORR clusters, the closest period match. */
function bestConfirmation(claim: ToiRecord, clusters: Cluster[]) {
  let best: { cluster: Cluster; result: ReturnType<typeof independentlyConfirmed> } | null = null;
  for (const cl of clusters.filter((c) => c.corroboratedSectors >= MIN_CORR)) {
    const r = independentlyConfirmed({ periodDays: cl.periodDays, corroboratedSectors: cl.corroboratedSectors }, { id: `${claim.toi}`, periodDays: claim.periodDays, disposition: claim.tfopwgDisposition || claim.tessDisposition }, { periodTolFrac: TOL, minCorroboration: MIN_CORR });
    if (r.validated && (!best || r.relPeriodDiff < best.result.relPeriodDiff)) best = { cluster: cl, result: r };
  }
  return best;
}

interface Row { tier: Tier; tic: number; toi: string; disposition: string; claimPeriod: number; depthPpm: number; tessMag: number; nSectors: number; maxCorr: number; recoveredPeriod?: number; validated: boolean; relDiff?: number; reason: string; }

async function main(): Promise<void> {
  const easyCond = `EASIEST subset (deep+bright): depth>=${minDepth} ppm, Tmag<=${tmagCap}, 2-8 d, >=2 sectors`;
  const hardCond = doHard ? `HARDER subset (shallow): depth ${hardMin}-${hardMax} ppm, Tmag<=${tmagCap}, 2-8 d, >=2 sectors` : "(hard tier disabled)";
  console.log(`P80 external-candidate independent validation. Detector BLIND (1-13d, claim ephemeris never fed), per-sector corroboration>=${MIN_CORR}, period tol ${(TOL * 100).toFixed(0)}%.`);
  console.log(`  tiers -> easy: ${easyCond} (KP<=${wantKp}, CP<=${wantCp}); hard: ${hardCond}${doHard ? ` (KP<=${hardKp}, CP<=${hardCp})` : ""}`);
  const records = await fetchToiTable();
  if (!records.length) { console.log("ExoFOP TOI table unavailable (network). Nothing to validate."); process.exitCode = 1; return; }

  const usableIn = (r: ToiRecord, lo: number, hi: number) => isPlaceable(r) && Number.isFinite(r.depthPpm) && r.depthPpm >= lo && r.depthPpm <= hi && r.periodDays >= 2 && r.periodDays <= 8 && r.sectors.length >= 2 && Number.isFinite(r.tessMag) && r.tessMag <= tmagCap;
  const isKP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "KP" || (r.tessDisposition || "").toUpperCase() === "KP";
  const isCP = (r: ToiRecord) => (r.tfopwgDisposition || "").toUpperCase() === "CP" || (r.tessDisposition || "").toUpperCase() === "CP";
  const brightestUnique = (rows: ToiRecord[]) => { const seen = new Set<number>(); const out: ToiRecord[] = []; for (const r of [...rows].sort((a, b) => a.tessMag - b.tessMag)) { if (seen.has(r.tic)) continue; seen.add(r.tic); out.push(r); } return out; };
  // hard tier is CP-focused (that is the point: shallow, still-uncertain external candidates), KP only as a sparse control.
  const pools: { tier: Tier; kp: ToiRecord[]; cp: ToiRecord[] }[] = [
    { tier: "easy", kp: brightestUnique(records.filter((r) => usableIn(r, minDepth, Infinity) && isKP(r))).slice(0, wantKp), cp: brightestUnique(records.filter((r) => usableIn(r, minDepth, Infinity) && isCP(r))).slice(0, wantCp) },
  ];
  if (doHard) pools.push({ tier: "hard", kp: brightestUnique(records.filter((r) => usableIn(r, hardMin, hardMax) && isKP(r))).slice(0, hardKp), cp: brightestUnique(records.filter((r) => usableIn(r, hardMin, hardMax) && isCP(r))).slice(0, hardCp) });

  const clusterCache = new Map<number, { clusters: Cluster[]; nSectors: number }>();
  async function clustersFor(rec: ToiRecord) {
    const hit = clusterCache.get(rec.tic);
    if (hit) return hit;
    const c = await clustersForTic(rec.tic, rec.sectors, `TIC ${rec.tic} ${rec.toi}`);
    clusterCache.set(rec.tic, c);
    return c;
  }

  const rows: Row[] = [];
  for (const p of pools) {
    console.log(`\n[${p.tier.toUpperCase()} tier] pools: ${p.kp.length} KP controls, ${p.cp.length} CP uncertain-external`);
    for (const pool of [p.kp, p.cp]) {
      for (const rec of pool) {
        const { clusters, nSectors } = await clustersFor(rec);
        const maxCorr = Math.max(0, ...clusters.map((c) => c.corroboratedSectors));
        const best = bestConfirmation(rec, clusters);
        const row: Row = {
          tier: p.tier, tic: rec.tic, toi: rec.toi, disposition: (rec.tfopwgDisposition || rec.tessDisposition || "?").toUpperCase(),
          claimPeriod: Number(rec.periodDays.toFixed(5)), depthPpm: Math.round(rec.depthPpm), tessMag: rec.tessMag, nSectors, maxCorr,
          validated: !!best, recoveredPeriod: best ? Number(best.cluster.periodDays.toFixed(5)) : undefined, relDiff: best ? Number((best.result.relPeriodDiff * 100).toFixed(3)) : undefined,
          reason: best ? best.result.reason : (maxCorr >= MIN_CORR ? `no corroboration>=${MIN_CORR} cluster within ${(TOL * 100).toFixed(0)}% of claim (best corr ${maxCorr})` : `no period corroborated in >=${MIN_CORR} sectors (best ${maxCorr})`),
        };
        rows.push(row);
        console.log(`  [${p.tier}/${row.disposition}] TIC ${rec.tic} ${rec.toi} P=${row.claimPeriod}d depth ${row.depthPpm}ppm sectors ${nSectors} maxCorr ${maxCorr} -> ${row.validated ? `VALIDATED (rec ${row.recoveredPeriod}d, off ${row.relDiff}%)` : "not validated"}`);
      }
    }
  }

  function stats(tier: Tier) {
    const rs = rows.filter((r) => r.tier === tier);
    const kp = rs.filter((r) => r.disposition === "KP");
    const cp = rs.filter((r) => r.disposition === "CP");
    return { tested: rs.length, validated: rs.filter((r) => r.validated).length, kpTested: kp.length, kpValid: kp.filter((r) => r.validated).length, cpTested: cp.length, cpValid: cp.filter((r) => r.validated).length };
  }
  const easy = stats("easy");
  const hard = stats("hard");

  console.log(`\nEASY  (${easyCond}): KP ${easy.kpValid}/${easy.kpTested} controls, CP ${easy.cpValid}/${easy.cpTested} uncertain-external validated.`);
  if (doHard) console.log(`HARD  (${hardCond}): KP ${hard.kpValid}/${hard.kpTested} controls, CP ${hard.cpValid}/${hard.cpTested} uncertain-external validated.`);

  let verdict: string;
  if (!easy.tested) verdict = "NO-IN-SCOPE-CLAIMS: no KP/CP met the deep+bright+multi-sector filters (network or coverage). Nothing validated; not a refutation. Measure-only.";
  else if (easy.kpTested && easy.kpValid < Math.ceil(easy.kpTested * 0.5)) verdict = `MACHINERY-WEAK: on the EASIEST subset only ${easy.kpValid}/${easy.kpTested} KP controls validated on real per-sector data -- blind corroboration at this sensitivity confirms fewer than half the KNOWN planets, so it cannot responsibly validate external claims. CP ${easy.cpValid}/${easy.cpTested}.`;
  else if (easy.cpValid > 0) verdict = `CAPABILITY-DEMONSTRATED (EASIEST subset only): blind, catalog-never-fed per-sector detection independently reproduced ${easy.cpValid}/${easy.cpTested} still-uncertain CP candidates and ${easy.kpValid}/${easy.kpTested} KP controls under ${easyCond}. This rate is NOT universal -- on the HARDER shallow tier (${hardCond}) CP validated ${hard.cpValid}/${hard.cpTested}. A CP confirmation is a first CHECK supporting a candidate, not a discovery nor TRICERATOPS-grade validation. safeToGate stays false.`;
  else verdict = `MACHINERY-WORKS-ON-CONTROLS: ${easy.kpValid}/${easy.kpTested} KP controls independently validated on the EASIEST subset, but ${easy.cpValid}/${easy.cpTested} CP candidates met the >=${MIN_CORR}-sector + ${(TOL * 100).toFixed(0)}% bar (harder shallow tier CP ${hard.cpValid}/${hard.cpTested}) -- the uncertain external claims stayed unconfirmed at this sensitivity (aliases/systematics, P78). Not a refutation. Measure-only.`;
  console.log(`VERDICT: ${verdict}`);

  mkdirSync("reports", { recursive: true });
  const tierTable = (label: string, cond: string, s: ReturnType<typeof stats>) => [
    `### ${label} -- ${cond}`,
    "",
    "| disposition | tested | independently validated |",
    "|---|---|---|",
    `| KP (confirmed-planet control) | ${s.kpTested} | ${s.kpValid} |`,
    `| CP (candidate, uncertain external) | ${s.cpTested} | ${s.cpValid} |`,
    "",
  ];
  const json = {
    meta: {
      generatedBy: "scripts/p80-external-validation.ts", protocol: "BLIND per-sector detection (claim ephemeris never fed); corroboration>=minCorr independent sectors + period tol; external claims from ExoFOP (KP controls, CP uncertain)",
      wantKp, wantCp, sectorCap, tmagCap, minDepth, tol: TOL, minCorroboration: MIN_CORR,
      easyCondition: easyCond, hardCondition: doHard ? hardCond : null, hardTier: { min: hardMin, max: hardMax, wantKp: hardKp, wantCp: hardCp, enabled: doHard },
      detector: "iterativeBls under production gate (depth-regime), maxSignals=3/sector",
      note: "headline rates are from the EASIEST (deep+bright) subset and are NOT universal; the harder shallow-depth tier is reported alongside. period-only corroboration admits aliases (P78: 2-sector precision ~47%); a CP confirmation is a first independent check, not a discovery. KP rows are positive controls. discoveryClaim false, safeToGate false.",
    },
    totals: { tested: rows.length, validated: rows.filter((r) => r.validated).length, kpTested: easy.kpTested, kpValidated: easy.kpValid, cpTested: easy.cpTested, cpValidated: easy.cpValid, hardCpTested: hard.cpTested, hardCpValidated: hard.cpValid, easy, hard },
    rows, verdict, discoveryClaim: false, safeToGate: false,
  };
  writeFileSync("reports/p80-external-validation.json", JSON.stringify(json, null, 2) + "\n");

  const md = [
    "# P80 external-candidate independent validation (audit finding 9, gap 3; depth-stratified per audit-10 #5)",
    "",
    `Reproduce: \`npm run p80:external-validation -- --kp ${wantKp} --cp ${wantCp} --sectors ${sectorCap} --min-depth ${minDepth} --tol ${TOL} --min-corr ${MIN_CORR} --hard ${doHard ? 1 : 0} --hard-min ${hardMin} --hard-max ${hardMax} --hard-cp ${hardCp}\``,
    "",
    "Closes the structural gap behind the old 0/2: P65 audits an outside claim while running the detector",
    "blind on an empty catalog, so it can never self-corroborate. Here we build an INDEPENDENT validation",
    "path: the detector never sees the claim's ephemeris, searches 1-13 d blind SECTOR BY SECTOR on the claim's",
    "own real SPOC sectors, corroborates a period across independent sectors, and confirms an ExoFOP claim only",
    "when that blind detection matches its period. KP rows are positive controls; CP rows are still-uncertain",
    "EXTERNAL candidates -- a genuine validation attempt, not a self-check.",
    "",
    "The headline numbers are NOT a universal rate: they come from the EASIEST (deep+bright) subset. A harder",
    "shallow-depth tier is reported right below so the easy number is not over-generalised (audit-10 #5).",
    "",
    ...tierTable("EASY tier (headline subset)", easyCond, easy),
    ...(doHard ? tierTable("HARD tier (shallow depth)", hardCond, hard) : []),
    "| host (TIC) | TOI | tier | disp | claim P (d) | depth ppm | sectors | maxCorr | recovered P (d) | off % | validated |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.tic} | ${r.toi} | ${r.tier} | ${r.disposition} | ${r.claimPeriod} | ${r.depthPpm} | ${r.nSectors} | ${r.maxCorr} | ${r.recoveredPeriod ?? "-"} | ${r.relDiff ?? "-"} | ${r.validated ? "YES" : "no"} |`),
    "",
    `**VERDICT: ${verdict}**`,
    "",
    "Residual alias risk: period-only corroboration admits aliases (P78: 2-sector accepted precision ~47%), so a",
    "CP 'confirmation' is a first independent CHECK, not a discovery nor a TRICERATOPS-grade validation. Measures",
    "only; gates nothing, anchors nothing, claims nothing. discoveryClaim false, safeToGate false.",
    "",
  ];
  writeFileSync("reports/p80-external-validation.md", md.join("\n"));
  console.log("wrote reports/p80-external-validation.{md,json}");
}

main().catch((e) => { console.error("p80 failed:", e instanceof Error ? e.message : e); console.log("\nVERDICT: INCONCLUSIVE-NETWORK"); process.exitCode = 1; });
