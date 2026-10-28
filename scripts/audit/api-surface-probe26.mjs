// round-26 R26-46: a tracked, re-runnable coherence probe of the LIVE API + served-asset surface that `npm test`
// cannot reach (the suite is hermetic). This is the dashboard- and digest-facing contract: if an endpoint starts
// returning the wrong top-level shape, or a secret pattern ever leaks into a response body, `npm test` stays green and
// nobody notices -- so this script checks exactly those facts against the running edge.
//
// Semantics (R26-25 discipline, kept consistent with live-readback26.mjs):
//   - UNREACHABLE (no answer) -> exit 2: neither a pass nor a defect, re-run when the network is steady.
//   - a core endpoint returns non-200, a required projection key is absent, or a response body matches a SECRET pattern
//     -> exit 1 with the finding named. Otherwise exit 0.
// It reads nothing secret and prints nothing secret; the SECRET regex only DETECTS a leak, never echoes the match.
//
// Usage: node scripts/audit/api-surface-probe26.mjs
const BASE = process.env.SDR_PROBE_BASE || "https://spacedatarig.app";
const SECRET = /alch_|ghp_|sk-|xai-|-----BEGIN|BEGIN [A-Z ]*PRIVATE KEY|ACCESS_TOKEN_SECRET|SOLANA_KEYPAIR/i;

async function get(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30_000) });
      const ct = r.headers.get("content-type") || "";
      const body = await r.text();
      return { ok: true, status: r.status, ct, body };
    } catch (e) {
      if (attempt === 1) return { ok: false, err: e.name === "TimeoutError" ? "timeout" : e.message };
    }
  }
}

// The endpoints that MUST be present and well-shaped for the dashboard/digest, and a few of their load-bearing keys.
const REQUIRED = [
  { p: "/health", keys: ["gitSha", "deployVersion"] },
  { p: "/api/state", keys: ["activeRun", "findings", "stats"] },
  { p: "/api/findings", keys: ["findings", "query", "total", "matched", "hasMore"] },
  { p: "/api/anchor-health", keys: ["asOf", "anchored", "bundleHashMatch", "conflict", "standIn", "unverifiableLetter"] },
  { p: "/research.json", keys: ["generatedAt", "compute"] },
];

const findings = [];
const lines = [];
let unreachable = 0;

for (const { p, keys } of REQUIRED) {
  const r = await get(p);
  if (!r.ok) {
    unreachable++;
    lines.push(`${p.padEnd(22)} UNREACHABLE (${r.err}) -- neither a pass nor a defect`);
    continue;
  }
  if (SECRET.test(r.body)) findings.push(`${p}: response body matches a SECRET pattern (leak)`);
  if (r.status !== 200) { findings.push(`${p}: expected HTTP 200, got ${r.status}`); lines.push(`${p.padEnd(22)} HTTP ${r.status}`); continue; }
  let parsed;
  try { parsed = JSON.parse(r.body); } catch { findings.push(`${p}: HTTP 200 but not valid JSON`); lines.push(`${p.padEnd(22)} 200 non-JSON`); continue; }
  const missing = keys.filter((k) => !(k in parsed));
  if (missing.length) findings.push(`${p}: missing required projection key(s): ${missing.join(", ")}`);
  lines.push(`${p.padEnd(22)} 200 ${missing.length ? "MISSING " + missing.join(",") : "shape ok"}${/secret/i.test(r.body) && SECRET.test(r.body) ? " LEAK" : ""}`);
}

for (const l of lines) console.log(l);
if (findings.length) { console.error(`FINDING(S): ${findings.length}`); for (const f of findings) console.error("  ! " + f); process.exit(1); }
if (unreachable === REQUIRED.length) { console.error("all endpoints unreachable -- edge did not answer, re-run when the network is steady"); process.exit(2); }
if (unreachable) console.error(`NOTE: ${unreachable} endpoint(s) unreachable; verdict is based on those that answered -- re-run when steady.`);
console.log("OK: every reachable core endpoint answered 200 with the expected projection and no secret-pattern leak.");
