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

async function get(url) {
  try {
    const r = await fetch(url, { headers: H, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, ct };
  } catch (e) {
    return { status: 0, ct: "", err: e.message };
  }
}

const idxRes = await fetch(`${BASE}/reports/index.json`, { headers: H });
if (!idxRes.ok) { console.log("FATAL: could not read the live index:", idxRes.status); process.exit(2); }
const idx = await idxRes.json();
const rows = idx.reports || [];
console.log(`live index: ${rows.length} rows`);

// Probe each slug's page. Modest concurrency so a slow edge is not hammered, but the check finishes promptly.
const CONC = 6;
const failures = [];
let done = 0;
const queue = rows.slice();
async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const slug = item.slug;
    const res = await get(`${BASE}/reports/${encodeURIComponent(slug)}.html`);
    // A report page must be HTML and 200. Anything else (404, 200 text/plain fallback, 500) is a broken published link.
    const ok = res.status === 200 && /text\/html/.test(res.ct);
    if (!ok) failures.push(`${slug}: status=${res.status} ct=${res.ct || "?"}${res.err ? " err=" + res.err : ""}`);
    done++;
    item = null;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

console.log(`probed ${done}/${rows.length} report pages`);
if (failures.length) {
  console.log("BROKEN (published row without a served HTML page):");
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("OK: every published index row resolves to a 200 text/html page on production.");
