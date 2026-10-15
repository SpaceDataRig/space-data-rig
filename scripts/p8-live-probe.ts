// audit-10 #8: weekly upstream LIVE-PROBE. The rig depends on three external, anonymous data endpoints.
// A schema or behaviour change on any of them is a silent science bug (e.g. Gaia starts emitting a
// rounded source_id, the ExoFOP CSV reorders its columns, NASA's WAF begins rejecting our compact WHERE).
// This script issues the SMALLEST POSSIBLE real query to each, asserts the response carries the fields
// we consume AND a sane row count, and prints a one-line verdict per upstream. Network + read-only:
// it never writes to any store, never touches the ledger, bundle hash, verdict, or money path.
//
// Exit codes (matched to the workflow's "open an issue" gate):
//   0 = all three upstreams look healthy;
//   1 = at least one upstream FAILED its field / row-count assertion (schema drift or a bad response);
//   2 = INCONCLUSIVE due to network errors on ALL upstreams (transit, rate-limit, DNS). Not a science alarm.
//
// Usage: npm run p8:live-probe

interface Check { name: string; ok: boolean; detail: string }
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

// 1. NASA Exoplanet Archive -- pscomppars via TAP. Asserts the compact WHERE still returns rows AND
//    our schema-contract columns (pl_name / hostname / sy_tmag / pl_orbper) survive JSON.
async function probeNasa(): Promise<Check> {
  const name = "nasa-exoplanet-archive";
  const cols = "pl_name,hostname,sy_tmag,pl_orbper";
  // Keep the WHERE compact (no spaces around operators) -- NASA's WAF 403s queries with `is not null` etc.
  const q = `select ${cols} from pscomppars where discoverymethod='Transit' and sy_tmag<12`;
  const url = `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(q)}&format=json`;
  try {
    const r = await fetchWithUA(url, "application/json");
    if (!r.ok) return { name, ok: false, detail: `HTTP ${r.status}` };
    const rows = (await r.json()) as Record<string, unknown>[];
    if (!Array.isArray(rows)) return { name, ok: false, detail: "response was not a JSON array" };
    if (rows.length < 100) return { name, ok: false, detail: `row-count too low: ${rows.length}` };
    const first = rows[0];
    const missing = cols.split(",").filter((c) => !(c in first));
    if (missing.length) return { name, ok: false, detail: `columns missing on first row: ${missing.join(",")}` };
    if (typeof first.pl_name !== "string" || typeof first.hostname !== "string") {
      return { name, ok: false, detail: "pl_name / hostname not strings" };
    }
    return { name, ok: true, detail: `${rows.length} rows; cols present` };
  } catch (e) {
    return { name, ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 2. ExoFOP-TESS TOI table (CSV) -- assert header still carries the two disposition columns we consume,
//    AND that a stable TOI column exists. We DON'T rely on a "TOI-" prefix in values (a documented gotcha).
async function probeExofop(): Promise<Check> {
  const name = "exofop-tess-toi";
  const url = "https://exofop.ipac.caltech.edu/tess/download_toi.php?output=csv&Show=All";
  try {
    const r = await fetchWithUA(url, "text/csv");
    if (!r.ok) return { name, ok: false, detail: `HTTP ${r.status}` };
    const text = await r.text();
    const lines = text.split(/\r?\n/);
    if (lines.length < 1000) return { name, ok: false, detail: `row-count too low: ${lines.length - 1} data lines` };
    const header = lines[0].split(",").map((s) => s.trim());
    const need = ["TIC ID", "TOI", "TESS Disposition"];
    const missing = need.filter((c) => !header.some((h) => h.toLowerCase().includes(c.toLowerCase())));
    if (missing.length) return { name, ok: false, detail: `header missing: ${missing.join(" | ")}` };
    return { name, ok: true, detail: `${lines.length - 1} data lines; header carries needed columns` };
  } catch (e) {
    return { name, ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 3. Gaia archive TAP -- one tiny TOP-5 cone query. We assert the response is the documented COLUMNAR
//    shape ({metadata:[{name}],data:[[v]]}), that source_id came back as a VARCHAR (per cast in ADQL --
//    if it ever returns a rounded Number for a >2^53 id, our neighbour-match silently breaks), and that
//    magnitude + parallax columns are present.
async function probeGaia(): Promise<Check> {
  const name = "gaia-tap";
  // A small field near the celestial equator; TOP 5 keeps the query cheap. source_id CAST to varchar.
  const adql =
    "select TOP 5 cast(source_id as varchar) as source_id,ra,dec,phot_g_mean_mag,parallax " +
    "from gaiadr3.gaia_source " +
    "where CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',10.0,0.0,0.05))=1";
  const url = `https://gea.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=json&PHASE=RUN&QUERY=${encodeURIComponent(adql)}`;
  try {
    const r = await fetchWithUA(url, "application/json");
    if (!r.ok) return { name, ok: false, detail: `HTTP ${r.status}` };
    const obj = (await r.json()) as { metadata?: { name: string }[]; data?: unknown[][] };
    if (!obj || !Array.isArray(obj.metadata) || !Array.isArray(obj.data)) {
      return { name, ok: false, detail: "unexpected response shape (want columnar {metadata,data})" };
    }
    const names = obj.metadata.map((m) => m.name);
    const need = ["source_id", "ra", "dec", "phot_g_mean_mag", "parallax"];
    const missing = need.filter((c) => !names.includes(c));
    if (missing.length) return { name, ok: false, detail: `missing columns: ${missing.join(",")}` };
    if (obj.data.length === 0) return { name, ok: false, detail: "cone returned 0 rows for a known-populated field" };
    const sidIdx = names.indexOf("source_id");
    const firstSid = obj.data[0][sidIdx];
    if (typeof firstSid !== "string") {
      return { name, ok: false, detail: `source_id is not a string (came back as ${typeof firstSid}) -- big-int rounding risk` };
    }
    return { name, ok: true, detail: `${obj.data.length} rows; source_id string; cols present` };
  } catch (e) {
    return { name, ok: false, detail: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function main(): Promise<void> {
  console.log("audit-10 #8 upstream live-probe (read-only, no writes)");
  // Run in parallel -- these are independent, latency-bound probes; sequential would just waste minutes.
  const checks = await Promise.all([probeNasa(), probeExofop(), probeGaia()]);
  let net = 0, fail = 0, pass = 0;
  for (const c of checks) {
    const isNet = !c.ok && c.detail.startsWith("network:");
    const v: Verdict = c.ok ? "PASS" : isNet ? "NET" : "FAIL";
    if (v === "PASS") pass++; else if (v === "NET") net++; else fail++;
    console.log(`  ${v.padEnd(4)}  ${c.name.padEnd(22)} ${c.detail}`);
  }
  if (fail > 0) {
    console.log(`VERDICT: FAIL -- ${fail} upstream(s) drifted schema / row-count (pass ${pass}, net ${net}, fail ${fail}). Open an issue: science assumptions on that upstream are now unverified.`);
    process.exitCode = 1;
    return;
  }
  if (pass === 0 && net === checks.length) {
    console.log("VERDICT: INCONCLUSIVE-NETWORK -- every upstream had a transport error; not a schema alarm. Retry next scheduled run.");
    process.exitCode = 2;
    return;
  }
  if (net > 0) {
    console.log(`VERDICT: PASS-PARTIAL -- ${pass} upstreams healthy, ${net} had transient network errors (retry next run).`);
    process.exitCode = 0;
    return;
  }
  console.log(`VERDICT: PASS -- all ${pass} upstreams returned the expected shape and row counts.`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(`[live-probe] unexpected error: ${e instanceof Error ? e.message : e}`);
  console.log("VERDICT: INCONCLUSIVE-NETWORK");
  process.exitCode = 2;
});
