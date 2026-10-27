// round-26 CI watch. github.com HTML pages do not load from this workstation (connect timeouts to github.com:443),
// while api.github.com answers in about a second -- so CI's verdict is read as OBJECTS from the API, and that limitation
// is stated in the ledger rather than hidden behind a link a reader can open and we cannot.
//
// It reports two different things on purpose: check runs (what ci.yml concluded) and workflow runs (whether the fleet
// this round extended actually fired). A step added to a workflow is a hypothesis about CI until a run proves it.
const REPO = "SpaceDataRig/space-data-rig";
const api = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "space-data-rig-audit" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return r.json();
};

const shas = process.argv.slice(2);
if (!shas.length) { console.log("usage: node scripts/audit/ci-watch26.mjs <sha> [<sha> ...]"); process.exit(1); }

for (const sha of shas) {
  const checks = await api(`/commits/${sha}/check-runs?per_page=50`);
  if (checks.error) { console.log(`${sha.slice(0, 7)} check-runs ${checks.error}`); continue; }
  const latest = new Map();
  for (const r of checks.check_runs || []) {
    const prev = latest.get(r.name);
    if (!prev || prev.started_at < r.started_at) latest.set(r.name, r);
  }
  const cells = [...latest.entries()].map(([n, r]) => `${n}=${r.status}${r.status === "completed" ? "/" + r.conclusion : ""}`);
  console.log(`${sha.slice(0, 7)} checks: ${cells.join(" | ") || "(none)"}`);
}

// Which workflows ran in the last few hours, and for which commit.
const runs = await api("/actions/runs?per_page=15");
if (runs.error) console.log(`workflow runs ${runs.error}`);
else {
  for (const r of runs.workflow_runs || []) {
    console.log(`  ${r.name} | event=${r.event} | ${r.status}${r.conclusion ? "/" + r.conclusion : ""} | head=${(r.head_sha || "").slice(0, 7)} | run=${r.id} | created=${r.created_at} | html=${r.html_url}`);
  }
}
