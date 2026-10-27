// round-26 live audit: every row the report library publishes must resolve to a real page on the PRODUCTION site.
//
// Round-25's release text had to be rewritten because it cited https://spacedatarig.app/reports/ -- a directory with no
// index, a 404 -- a fact that "checking instead of trusting" caught. app.js builds each report page from an index row as
// `/reports/<slug>.html` (web/app.js:1638). This audit closes the loop at full scale: it reads the DEPLOYED
// /reports/index.json (not the local one, so it measures what visitors get), then fetches every row's page on production
// and flags any that is not 200. A row that resolves to a 404 is the exact "published on the list, never built as a page"
// defect that tests/report-library.test.ts guards for p90 alone -- here, for all 56, against the live server.
const BASE = "https://spacedatarig.app";
const H = { "User-Agent": "p26-live-link-integrity" };
// A stalled edge connection must not hang the probe forever: every request is bounded. The shipped version relied on
// undici's default (no timeout) and a single stalled fetch froze the run -- a tool that cannot conclude is worse than one
// that reports the edge as unreachable, which is the honest outcome this exit code now distinguishes.
const REQ_TIMEOUT_MS = 12_000;

async function get(url) {
  try {
    const r = await fetch(url, { headers: H, redirect: "follow", signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, ct };
  } catch (e) {
    return { status: 0, ct: "", err: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

let idx;
try {
  const r = await fetch(`${BASE}/reports/index.json`, { headers: H, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (r.status !== 200) { console.log("FATAL: live index not 200:", r.status); process.exit(2); }
  idx = await r.json();
} catch (e) {
  const why = e.name === "TimeoutError" ? "timeout" : e.message;
  console.log(`UNREACHABLE: the edge did not answer the index (${why}); this is NOT a pass and NOT a defect`);
  process.exit(2);
}
const rows = idx.reports || [];
console.log(`live index: ${rows.length} rows`);

// Probe each slug's page. LOW concurrency: at 6 the flaky edge dropped a dozen requests to timeouts and the first version
// mislabelled them as BROKEN -- a false accusation of the library for a transient network fault, the very thing this tool's
// contract forbids. status 0 (timeout / fetch failed) is UNREACHABLE, not broken; only a real HTTP response that is not a
// 200 text/html is a broken published link.
const CONC = 2;
const broken = [];
const unreachable = new Set();
let done = 0;
const queue = rows.slice();
async function probe(slug) {
  const res = await get(`${BASE}/reports/${encodeURIComponent(slug)}.html`);
  if (res.status === 0) return { kind: "unreachable", detail: res.err || "network" };
  const ok = res.status === 200 && /text\/html/.test(res.ct);
  return ok ? { kind: "ok" } : { kind: "broken", detail: `status=${res.status} ct=${res.ct || "?"}` };
}
async function worker() {
  for (let row = queue.shift(); row; row = queue.shift()) {
    let r = await probe(row.slug);
    if (r.kind === "unreachable") r = await probe(row.slug); // one retry before declaring it unreachable
    if (r.kind === "broken") broken.push(`${row.slug}: ${r.detail}`);
    else if (r.kind === "unreachable") unreachable.add(row.slug);
    done++;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

console.log(`probed ${done}/${rows.length} report pages`);
if (broken.length) {
  console.log("BROKEN (server answered, but not with the row's HTML page):");
  for (const f of broken) console.log("  " + f);
  process.exit(1);
}
if (unreachable.size) {
  console.log(`INCONCLUSIVE: ${unreachable.size} page(s) could not be reached after a retry (${[...unreachable].join(", ")}). ` +
    "This is NOT a pass and NOT a defect -- the edge was unreachable for those requests; re-run when the network is steady.");
  process.exit(2);
}
console.log("OK: every published index row resolves to a 200 text/html page on production.");
