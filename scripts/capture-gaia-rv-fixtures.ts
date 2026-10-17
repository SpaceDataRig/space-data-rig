// scripts/capture-gaia-rv-fixtures.ts -- capture REAL Gaia DR3 independent-corroboration rows for a set of
// confirmed transiting planets (a POSITIVE control: a real planet's transit period must NOT be corroborated as a
// stellar-mass eclipsing binary by Gaia), and freeze them as tests/fixtures/live-gaia-rv.json. Network read-only;
// run locally (`npm run fixtures:capture-gaia`), NOT in `npm test` (CI has no network). The committed fixture then
// drives tests/gaiaRv-live.test.ts, which re-runs the PURE rvAstrometryVsCandidate on real captured records and
// asserts the honesty invariants -- the repo's mandatory live-data regression gate (a passing synthetic test is not
// proof the real external table behaves the same).
//
// POPULATION SOURCE. Same labelled population p88 scores: the token-free ExoFOP TOI table (src/data/toiDispositions).
// Its RA is sexagesimal HOURS and is converted to degrees by the parser (see parseRa) -- the coordinates that drive
// every cone below depend on that x15 being right. Selection targets Gaia's RV-survey magnitude sweet spot (a planet
// host the Gaia spectrometer actually observed); the brightest hosts (V<~6) sit in Gaia's saturation gap and carry no
// has_rvs, so an all-bright sample yields zero data-bearing controls (this is what an earlier tmag<=8 cut hit).
import { writeFileSync, mkdirSync } from "node:fs";
import { fetchToiTable, confirmedPositives, type ToiRecord } from "../src/data/toiDispositions.ts";
import { fetchGaiaNeighborhood, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import { fetchGaiaCorroboration, rvAstrometryVsCandidate, type GaiaOrbit, type GaiaRvEpoch, type GaiaSourceFlags } from "../src/data/gaiaRv.ts";

const OUT = "tests/fixtures/live-gaia-rv.json";
const MAX_CASES = 5;
const EPOCH_CAP = 16;
const HOST_MATCH_ARCSEC = 3.0;
// Gaia RVS magnitude window for the host: bright enough to be well-observed, faint enough to be inside the survey.
const TMAG_MIN = 6.0;
const TMAG_MAX = 12.0;
const CANDIDATE_SCAN = 40; // consider up to this many pool members before stopping at MAX_CASES data-bearing ones
const QUERY_TIMEOUT_MS = 150000; // Gaia sync latency spikes (cone measured ~40s under load); null-everything below this

interface CapturedCase {
  plName: string;
  hostname: string;
  tic: number | null;
  periodDays: number;
  gaiaSourceId: string;
  orbit: GaiaOrbit | null;
  epochs: GaiaRvEpoch[];
  flags: GaiaSourceFlags | null;
  ebExclusion: string;
  blendCorroborated: boolean;
  periodMatched: boolean;
}

/** The nearest Gaia source within arcsec of (ra,dec) -- the host star itself. */
async function hostSourceId(ra: number, dec: number): Promise<string | null> {
  const sources = await fetchGaiaNeighborhood(ra, dec, { radiusDeg: HOST_MATCH_ARCSEC / 3600, timeoutMs: QUERY_TIMEOUT_MS });
  let bestId = "";
  let bestSep = Infinity;
  for (const g of sources) {
    const sep = angularSepArcsec(ra, dec, g.ra, g.dec);
    if (sep <= HOST_MATCH_ARCSEC && sep < bestSep) { bestSep = sep; bestId = g.sourceId; }
  }
  return bestId || null;
}

/** Resolve one confirmed-planet host -> Gaia id -> corroboration; null when the host has no independent Gaia data. */
async function probeHost(rec: ToiRecord): Promise<CapturedCase | null> {
  const ra = rec.ra; const dec = rec.dec; const per = rec.periodDays;
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(per) || per <= 0) return null;
  let id: string | null;
  try { id = await hostSourceId(ra, dec); } catch { return null; }
  if (!id) { console.error(`  probe ${rec.toi}: no Gaia host within ${HOST_MATCH_ARCSEC}" (tmag=${rec.tessMag.toFixed(2)})`); return null; }
  let data;
  try { data = await fetchGaiaCorroboration(id, { timeoutMs: QUERY_TIMEOUT_MS }); } catch { return null; }
  const hasData = Boolean(data.orbit) || data.epochs.length > 0 || (data.flags != null && (data.flags.hasRvs || data.flags.nonSingleStarBits > 0));
  console.error(`  probe ${rec.toi}: host ${id} sep-ok orbit=${data.orbit ? "y" : "n"} epochs=${data.epochs.length} flags=${data.flags ? (data.flags.hasRvs ? "rvs" : data.flags.nonSingleStarBits) : "-"} -> hasData=${hasData}`);
  if (!hasData) return null; // a host with NO Gaia RV/orbit evidence is not a meaningful positive-control case
  const v = rvAstrometryVsCandidate({ candidatePeriodDays: per, orbit: data.orbit, epochs: data.epochs, flags: data.flags });
  console.error(`gaia-rv capture: ${rec.toi} (P=${per.toFixed(3)}d) source ${id} -> ${v.ebExclusion}${v.periodMatched ? " [period-matched]" : ""}`);
  const label = rec.toi || `TIC ${rec.tic}`;
  return {
    plName: label, hostname: label, tic: Number.isFinite(rec.tic) ? rec.tic : null,
    periodDays: per, gaiaSourceId: id,
    orbit: data.orbit, epochs: data.epochs.slice(0, EPOCH_CAP), flags: data.flags,
    ebExclusion: v.ebExclusion, blendCorroborated: v.blendCorroborated, periodMatched: v.periodMatched,
  };
}

async function main(): Promise<void> {
  const all = await fetchToiTable({ timeoutMs: 60000 });
  if (!all.length) throw new Error("refusing to capture: ExoFOP TOI table unavailable (network) -- fixture must be REAL");
  const pool = confirmedPositives(all)
    .filter((r) => r.tessMag >= TMAG_MIN && r.tessMag <= TMAG_MAX)
    .slice(0, CANDIDATE_SCAN);
  console.error(`gaia-rv capture: ${pool.length} confirmed-planet hosts in tmag ${TMAG_MIN}-${TMAG_MAX} (of ${confirmedPositives(all).length} positives)`);
  const cases: CapturedCase[] = [];
  let considered = 0;
  for (const rec of pool) {
    if (cases.length >= MAX_CASES) break;
    considered++;
    const r = await probeHost(rec).catch(() => null);
    if (r) cases.push(r);
    await new Promise((res) => setTimeout(res, 500)); // gentle pause vs Gaia throttling
  }
  const withGaiaData = cases.length;
  const bundle = {
    schema: "sdr-gaia-rv/1",
    generatedAt: new Date().toISOString(),
    source: "Gaia DR3 TAP (gea.esac.esa.int): vari_epoch_radial_velocity + nss_two_body_orbit + gaia_source flags",
    positiveControl: "confirmed transiting planets (ExoFOP KP labels) -- a real planet's transit period must NOT be corroborated as a stellar-mass EB",
    considered, withGaiaData, count: cases.length,
    cases,
  };
  mkdirSync("tests/fixtures", { recursive: true });
  writeFileSync(OUT, JSON.stringify(bundle, null, 2), "utf8");
  console.error(`gaia-rv capture: wrote ${cases.length} cases (${withGaiaData} with Gaia data of ${considered} considered) -> ${OUT}`);
  if (cases.length === 0) { console.error("gaia-rv capture: WARNING no data-bearing hosts captured; widen the tmag window"); process.exitCode = 1; }
}

const invokedDirectly = /capture-gaia-rv-fixtures(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) main().catch((e) => { console.error(`gaia-rv capture: fatal: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
