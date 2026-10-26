// Audit-24 F9 measurement: the composer's science window starts at the last SCIENCE POST time read off the feed,
// so an item created between this run's state fetch and its post sits behind the next run's cursor and is never
// reported. That gap is structural, but is it real? Measure it: for every run today that posted a science item,
// take (fetch echo timestamp, first OK-posted timestamp) and count findings / ledger rows whose own timestamp
// falls inside that interval.
import { execSync } from "node:child_process";

const SINCE = process.argv[2] || "2026-10-26T05:00:00Z";
const raw = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n", encoding: "utf8" });
const token = /password=(.+)/.exec(raw)[1].trim();
const H = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const base = "https://api.github.com/repos/SpaceDataRig/space-data-rig";

async function get(url, asJson = true) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(45000) });
      if (!r.ok) { if (r.status === 403 || r.status === 429) return { unknown: r.status }; return { http: r.status }; }
      return asJson ? await r.json() : await r.text();
    } catch (e) {
      await new Promise((s) => setTimeout(s, 2500 * (i + 1)));
      if (i === 4) return { err: e.cause?.code || e.message };
    }
  }
}

// The rig's own public endpoints are read WITHOUT the GitHub authorization header -- a repo token must never
// leave api.github.com, not even toward our own site.
async function getPublic(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) return { http: r.status };
      return await r.json();
    } catch (e) {
      await new Promise((s) => setTimeout(s, 2500 * (i + 1)));
      if (i === 4) return { err: e.cause?.code || e.message };
    }
  }
}

const state = await getPublic("https://spacedatarig.app/api/state");
const ledger = await getPublic("https://spacedatarig.app/api/ledger");
const findings = (state && state.findings) || [];
const rows = (ledger && ledger.ledger) || [];
console.log(`live: findings=${findings.length} ledgerRows=${rows.length}`);

const runsResp = await get(`${base}/actions/workflows/x-post.yml/runs?per_page=100`);
const runs = ((runsResp && runsResp.workflow_runs) || []).filter((x) => Date.parse(x.created_at) >= Date.parse(SINCE));
console.log(`runs since ${SINCE}: ${runs.length}`);

let scienceRuns = 0;
let dropped = 0;
for (const run of runs) {
  const jobs = await get(`${base}/actions/runs/${run.id}/jobs`);
  for (const job of (jobs && jobs.jobs) || []) {
    const log = await get(`${base}/actions/jobs/${job.id}/logs`, false);
    if (typeof log !== "string") continue;
    let fetchTs = null;
    const postTs = [];
    for (const line of log.split("\n")) {
      const m0 = line.match(/^(\S+Z)\s/);
      const ts = m0 ? Date.parse(m0[1]) : null;
      if (/digest window since:/.test(line) && !/echo/.test(line) && ts) fetchTs = ts;
      if (/x:post: OK posted \(id/.test(line) && ts) postTs.push(ts);
    }
    if (!fetchTs || !postTs.length) continue;
    scienceRuns++;
    const gapStart = fetchTs;
    const gapEnd = postTs[0];
    const inGapF = findings.filter((f) => {
      const t = Date.parse(f.createdAt || "");
      return !Number.isNaN(t) && t > gapStart && t <= gapEnd;
    });
    const inGapL = rows.filter((e) => {
      const t = Date.parse(e.anchoredAt || "");
      return e.signature && !Number.isNaN(t) && t > gapStart && t <= gapEnd;
    });
    const held = inGapF.filter((f) => f.origin === "blind-toi" && f.verdict !== "rejected");
    if (inGapF.length || inGapL.length) {
      dropped += inGapF.length + inGapL.length;
      console.log(`run ${run.id} gap ${(gapEnd - gapStart) / 1000}s: findings=${inGapF.length} (held ${held.length}) ledger=${inGapL.length} ids=${[...inGapF, ...inGapL].map((x) => x.findingId || x.id || "?").join(",")}`);
    }
  }
}
console.log(`\nMEASURED: posting runs examined=${scienceRuns}, items landing inside a fetch-to-post gap=${dropped}`);
