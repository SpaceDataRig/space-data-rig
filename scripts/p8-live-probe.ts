// audit-10 #8: weekly upstream LIVE-PROBE. The rig depends on three external, anonymous data endpoints.
// A schema or behaviour change on any of them is a silent science bug (e.g. Gaia starts emitting a
// rounded source_id, the ExoFOP CSV reorders its columns, NASA's WAF begins rejecting our compact WHERE).
// This script issues the SMALLEST POSSIBLE real query to each, asserts the response carries the fields
// we consume AND a sane row count, and prints a one-line verdict per upstream. Network + read-only:
// it never writes to any store, never touches the ledger, bundle hash, verdict, or money path.
//
// Each probe is split into a fetch (I/O) and a pure judge(parsed) so the DETECTION logic -- the part that
// must actually alarm on drift -- is testable offline. `--self-test` runs healthy + drifted fixtures
// through the real judges and asserts the exit code the workflow keys on (audit-3 P1-B: "a mechanism that
// exists is not a mechanism that works"). It makes NO network calls and MUST stay that way.
//
// Exit codes (matched to the workflow's "open an issue" gate):
//   0 = all three upstreams look healthy;
//   1 = at least one upstream FAILED its field / row-count assertion (schema drift or a bad response);
//   2 = INCONCLUSIVE due to network errors on ALL upstreams (transit, rate-limit, DNS). Not a science alarm.
//
// Usage: npm run p8:live-probe         (real network probe)
//        npm run p8:live-probe -- --self-test   (offline detection-logic drill, exit 0 == drill passed)

export interface Check { name: string; ok: boolean; detail: string }
type Verdict = "PASS" | "FAIL" | "NET";

async function fetchWithUA(url: string, accept: string, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Some WAFs 403 the default `node` UA (see exoplanetArchive / toiDispositions); mirror the browser UA.
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; space-data-rig live-probe)", Accept: accept } });
  } finally {
    clearTimeout(timer);
  }
}

// 1. NASA Exoplanet Archive -- pscomppars via TAP. Pure judge: the compact WHERE must still return a
//    JSON-array body of sane size AND carry our schema-contract columns on the first row as the right types.
const NASA_COLS = "pl_name,hostname,sy_tmag,pl_orbper";
export function judgeNasa(rows: unknown): Check {
  const name = "nasa-exoplanet-archive";
  if (!Array.isArray(rows)) return { name, ok: false, detail: "response was not a JSON array" };
  if (rows.length < 100) return { name, ok: false, detail: `row-count too low: ${rows.length}` };
  const first = rows[0] as Record<string, unknown>;
  const missing = NASA_COLS.split(",").filter((c) => !(c in first));
  if (missing.length) return { name, ok: false, detail: `columns missing on first row: ${missing.join(",")}` };
  if (typeof first.pl_name !== "string" || typeof first.hostname !== "string") {
    return { name, ok: false, detail: "pl_name / hostname not strings" };
  }
  return { name, ok: true, detail: `${rows.length} rows; cols present` };
}
async function probeNasa(): Promise<Check> {
  const q = `select ${NASA_COLS} from pscomppars where discoverymethod='Transit' and sy_tmag<12`;
  const url = `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(q)}&format=json`;
  try {
    const r = await fetchWithUA(url, "application/json");
    if (!r.ok) return { name: "nasa-exoplanet-archive", ok: false, detail: `HTTP ${r.status}` };
    return judgeNasa(await r.json());
  } catch (e) {
    return { name: "nasa-exoplanet-archive", ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 2. ExoFOP-TESS TOI table (CSV) -- assert header still carries the two disposition columns we consume,
//    AND that a stable TOI column exists. We DON'T rely on a "TOI-" prefix in values (a documented gotcha).
const EXOFOP_NEED = ["TIC ID", "TOI", "TESS Disposition"];
export function judgeExofop(text: string): Check {
  const name = "exofop-tess-toi";
  const lines = text.split(/\r?\n/);
  if (lines.length < 1000) return { name, ok: false, detail: `row-count too low: ${lines.length - 1} data lines` };
  const header = lines[0].split(",").map((s) => s.trim());
  const missing = EXOFOP_NEED.filter((c) => !header.some((h) => h.toLowerCase().includes(c.toLowerCase())));
  if (missing.length) return { name, ok: false, detail: `header missing: ${missing.join(" | ")}` };
  return { name, ok: true, detail: `${lines.length - 1} data lines; header carries needed columns` };
}
async function probeExofop(): Promise<Check> {
  const url = "https://exofop.ipac.caltech.edu/tess/download_toi.php?output=csv&Show=All";
  try {
    const r = await fetchWithUA(url, "text/csv");
    if (!r.ok) return { name: "exofop-tess-toi", ok: false, detail: `HTTP ${r.status}` };
    return judgeExofop(await r.text());
  } catch (e) {
    return { name: "exofop-tess-toi", ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 3. Gaia archive TAP -- one tiny TOP-5 cone query. Pure judge: response must be the documented COLUMNAR
//    shape ({metadata:[{name}],data:[[v]]}), carry the consumed columns, return >=1 row, and source_id must
//    be a VARCHAR (if it ever returns a rounded Number for a >2^53 id, our neighbour-match silently breaks).
const GAIA_NEED = ["source_id", "ra", "dec", "phot_g_mean_mag", "parallax"];
export function judgeGaia(obj: unknown): Check {
  const name = "gaia-tap";
  const o = obj as { metadata?: { name: string }[]; data?: unknown[][] };
  if (!o || !Array.isArray(o.metadata) || !Array.isArray(o.data)) {
    return { name, ok: false, detail: "unexpected response shape (want columnar {metadata,data})" };
  }
  const names = o.metadata.map((m) => m.name);
  const missing = GAIA_NEED.filter((c) => !names.includes(c));
  if (missing.length) return { name, ok: false, detail: `missing columns: ${missing.join(",")}` };
  if (o.data.length === 0) return { name, ok: false, detail: "cone returned 0 rows for a known-populated field" };
  const firstSid = o.data[0][names.indexOf("source_id")];
  if (typeof firstSid !== "string") {
    return { name, ok: false, detail: `source_id is not a string (came back as ${typeof firstSid}) -- big-int rounding risk` };
  }
  return { name, ok: true, detail: `${o.data.length} rows; source_id string; cols present` };
}
async function probeGaia(): Promise<Check> {
  const adql =
    "select TOP 5 cast(source_id as varchar) as source_id,ra,dec,phot_g_mean_mag,parallax " +
    "from gaiadr3.gaia_source " +
    "where CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',10.0,0.0,0.05))=1";
  const url = `https://gea.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=json&PHASE=RUN&QUERY=${encodeURIComponent(adql)}`;
  try {
    const r = await fetchWithUA(url, "application/json");
    if (!r.ok) return { name: "gaia-tap", ok: false, detail: `HTTP ${r.status}` };
    return judgeGaia(await r.json());
  } catch (e) {
    return { name: "gaia-tap", ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Shared verdict + exit-code logic, driven purely off the Check list so both live and self-test use it. */
export function evaluate(checks: Check[]): number {
  let net = 0, fail = 0, pass = 0;
  for (const c of checks) {
    const isNet = !c.ok && c.detail.startsWith("network:");
    const v: Verdict = c.ok ? "PASS" : isNet ? "NET" : "FAIL";
    if (v === "PASS") pass++; else if (v === "NET") net++; else fail++;
    console.log(`  ${v.padEnd(4)}  ${c.name.padEnd(22)} ${c.detail}`);
  }
  if (fail > 0) {
    console.log(`VERDICT: FAIL -- ${fail} upstream(s) drifted schema / row-count (pass ${pass}, net ${net}, fail ${fail}). Open an issue: science assumptions on that upstream are now unverified.`);
    return 1;
  }
  if (pass === 0 && net === checks.length) {
    console.log("VERDICT: INCONCLUSIVE-NETWORK -- every upstream had a transport error; not a schema alarm. Retry next scheduled run.");
    return 2;
  }
  if (net > 0) {
    console.log(`VERDICT: PASS-PARTIAL -- ${pass} upstreams healthy, ${net} had transient network errors (retry next scheduled run).`);
    return 0;
  }
  console.log(`VERDICT: PASS -- all ${pass} upstreams healthy.`);
  return 0;
}

async function main(): Promise<void> {
  console.log("audit-10 #8 upstream live-probe (read-only, no writes)");
  // Run in parallel -- these are independent, latency-bound probes; sequential would just waste minutes.
  process.exitCode = evaluate(await Promise.all([probeNasa(), probeExofop(), probeGaia()]));
}

// Offline detection drill (audit-3 P1-B). Feeds a HEALTHY fixture and a DRIFTED fixture through each real
// judge and asserts: healthy passes, every drift class the probe is supposed to catch trips FAIL, and the
// shared evaluate() then yields the exact exit code the workflow alerts on. Asserts, never just prints.
export function selfTest(): number {
  const results: string[] = [];
  const expect = (label: string, got: boolean | number, want: boolean | number): void => {
    const ok = got === want;
    results.push(`${ok ? "ok  " : "FAIL"}  ${label}`);
    if (!ok) console.error(`  expected ${String(want)}, got ${String(got)}`);
  };

  // NASA: healthy vs a dropped consumed column vs a too-small result set.
  const nasaGood = Array.from({ length: 120 }, () => ({ pl_name: "b", hostname: "H", sy_tmag: 10, pl_orbper: 3 }));
  const nasaNoCol = Array.from({ length: 120 }, () => ({ pl_name: "b", hostname: "H", sy_tmag: 10 })); // pl_orbper gone
  const nasaTiny = [{ pl_name: "b", hostname: "H", sy_tmag: 10, pl_orbper: 3 }];
  expect("nasa healthy PASS", judgeNasa(nasaGood).ok, true);
  expect("nasa dropped consumed column -> FAIL", judgeNasa(nasaNoCol).ok, false);
  expect("nasa row-count collapse -> FAIL", judgeNasa(nasaTiny).ok, false);

  // ExoFOP: healthy vs header renamed (the exact "change a field name" scenario).
  const header = "TOI,TIC ID,TESS Disposition,other";
  const row = Array.from({ length: 1200 }, () => "1,2,3,4").join("\n");
  const exofopGood = `${header}\n${row}`;
  const exofopRenamed = `TOI,TIC Number,TESS Disposition,other\n${row}`; // "TIC ID" renamed
  expect("exofop healthy PASS", judgeExofop(exofopGood).ok, true);
  expect("exofop renamed column -> FAIL", judgeExofop(exofopRenamed).ok, false);

  // Gaia: healthy vs rounded (Number) source_id vs non-columnar shape vs empty.
  const gaiaGood = { metadata: GAIA_NEED.map((name) => ({ name })), data: [["123", 1, 2, 3, 4]] };
  const gaiaRounded = { metadata: GAIA_NEED.map((name) => ({ name })), data: [[4.5e18, 1, 2, 3, 4]] };
  const gaiaShape = { rows: [] };
  const gaiaEmpty = { metadata: GAIA_NEED.map((name) => ({ name })), data: [] };
  expect("gaia healthy PASS", judgeGaia(gaiaGood).ok, true);
  expect("gaia rounded source_id -> FAIL", judgeGaia(gaiaRounded).ok, false);
  expect("gaia non-columnar shape -> FAIL", judgeGaia(gaiaShape).ok, false);
  expect("gaia empty cone -> FAIL", judgeGaia(gaiaEmpty).ok, false);

  // Exit-code wiring: one drifted upstream MUST produce the alert code 1, not a silent 0.
  const exitOnDrift = evaluate([{ name: "nasa-exoplanet-archive", ok: true, detail: "x" }, { name: "gaia-tap", ok: false, detail: "missing columns: parallax" }]);
  expect("evaluate() alerts (exit 1) on a single drift", exitOnDrift, 1);
  const exitAllNet = evaluate([{ name: "a", ok: false, detail: "network: down" }, { name: "b", ok: false, detail: "network: down" }, { name: "c", ok: false, detail: "network: down" }]);
  expect("evaluate() inconclusive-network is NOT an alarm (exit 2)", exitAllNet, 2);
  const exitHealthy = evaluate([{ name: "a", ok: true, detail: "x" }, { name: "b", ok: true, detail: "x" }, { name: "c", ok: true, detail: "x" }]);
  expect("evaluate() healthy -> exit 0", exitHealthy, 0);

  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log("audit-10 #8 live-probe SELF-TEST (offline, no network):");
  for (const r of results) console.log(`  ${r}`);
  console.log(failed ? `SELF-TEST: ${failed} ASSERTION(S) FAILED -- the probe does NOT reliably detect drift.` : "SELF-TEST: PASS -- drift detection + alert wiring verified offline.");
  return failed ? 1 : 0;
}

// Only hit the network when run directly (node/tsx <thisfile>); importing the judges/evaluate from a test
// must be side-effect-free so the offline `npm test` gate never leaves the machine.
const invokedDirectly = /p8-live-probe(\.ts)?$/.test(process.argv[1] ?? "");
if (process.argv.includes("--self-test")) {
  process.exitCode = selfTest();
} else if (invokedDirectly) {
  void main();
}
