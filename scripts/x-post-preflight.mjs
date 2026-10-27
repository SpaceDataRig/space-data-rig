// Pre-flight for the hourly X digest (.github/workflows/x-post.yml).
//
// WHY: most hourly windows hold nothing reportable, yet the workflow used to pay for a full dependency
// install, a live-feed read and an X timeline read on every single one of them. This script answers "could
// this window possibly hold anything?" using ONLY the cursors the previous run cached (out/x-cursors.json),
// two cheap HTTPS reads of the public rig state, and local git -- no npm install required. When the answer
// is a confident "no" the workflow exits before installing anything (exit 42); otherwise it proceeds and the
// authoritative composeDigest path decides everything as before.
//
// CONSERVATIVE BY CONSTRUCTION: this script may only ever SKIP a window it is SURE is empty. Every input it
// cannot trust (missing cursor cache, unreachable rig, git history that does not reach the cursor) makes it
// answer "proceed". A stale (too-old) cached cursor can only make it proceed, never skip: a genuinely new
// item is newer than the true cursor, which is newer than or equal to the cached one, so it still trips the
// "newer than cursor" test. Exit codes: 0 = proceed, 42 = provably empty, anything else = proceed.
//
// ROUND-24 AUDIT, three defects closed here (each pinned by tests/x-post-preflight.test.ts):
//  F1 BOUNDARY. The composer's window is `t >= start` (science-digest.ts within(), inclusive) but this script
//    compared with a strict `>`. An item timestamped in the very second the cursor names is therefore reportable
//    by the composer and INVISIBLE here -- and because skipping never advances the cursor, that item would be
//    skipped in every later window too: permanent suppression, not a delay. Both comparisons are now `>=`.
//  F4 FUTURE CURSOR. A hint dated ahead of this clock inverts the window, so the emptiness verdict would be
//    drawn from a range nobody can see. Such a hint is untrusted input, so it now proceeds.
//  F2 PREDICATE DRIFT. `heldBlind` below is a hand copy of isHeldBlindCandidate (src/core/stats-definitions.ts),
//    unavoidable here because the pre-flight must run BEFORE `npm ci` and so cannot import TypeScript. That makes
//    it the second definition of one phrase in a repo that already merged the first one away. It is exported and
//    pinned to the TS predicate by a test, so drift fails CI instead of silently changing what gets skipped.
// The rig endpoints are overridable (STATE_URL / LEDGER_URL) for the same reason science-digest.ts exposes
// --state-url / --ledger-url: without them the empty-window branch could only ever be checked by hand.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "spacedatarig.app";
const STATE_URL = process.env.STATE_URL || `https://${SITE}/api/state`;
const LEDGER_URL = process.env.LEDGER_URL || `https://${SITE}/api/ledger`;
const cursorFile = process.env.CURSOR_FILE || "out/x-cursors.json";
const heartbeatAfterMin = Number(process.env.HEARTBEAT_AFTER_MIN || "45");
const devOverlapMin = Number(process.env.DEV_OVERLAP_MIN || "10");
const devExclude = process.env.DEV_COMMIT_EXCLUDE || "";
const EMPTY = 42;

function log(msg) {
  console.log(`x-post-preflight: ${msg}`);
}
function proceed(reason) {
  log(`proceed (${reason})`);
  process.exit(0);
}
function parseIso(v) {
  const t = Date.parse(String(v == null ? "" : v));
  return Number.isNaN(t) ? null : t;
}
function readCursors() {
  try {
    return JSON.parse(readFileSync(cursorFile, "utf8"));
  } catch {
    return null;
  }
}
async function fetchJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
// Git is invoked with an ARGV ARRAY, never through a shell string. The pathspecs below (`:!reports/**`) rely on
// single quotes being stripped by the shell, and cmd.exe does not strip them -- a shell-string invocation
// therefore handed git a literal `'!reports/**'`, which matches no file, which made the dev window read as empty
// on Windows while behaving correctly on the Linux runner. That is precisely the kind of platform-only difference
// a gate that can suppress posts must not have.
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}
// True when the local clone reaches back at least as far as `iso`, i.e. `git log --since=iso` sees the whole
// window. Always true on the workflow's full-history checkout; it is the guard that keeps a shallow clone
// from ever voting "empty" over history it does not actually have.
export function covers(iso) {
  return git(["log", `--until=${iso}`, "-n1", "--pretty=%H"]).trim() !== "";
}
// Mirrors src/core/stats-definitions.ts isHeldBlindCandidate (origin blind-toi, verdict not rejected; a null
// verdict counts as held, matching BLIND_HELD_SQL). EXPORTED so tests/x-post-preflight.test.ts can assert it
// against the real predicate over a row battery -- see F2 in the header.
export function heldBlind(f) {
  return Boolean(f) && f.origin === "blind-toi" && (f.verdict == null || f.verdict !== "rejected");
}

export async function main() {
  const cur = readCursors();
  if (!cur || typeof cur !== "object") proceed("no cached cursors (first run or cache miss)");
  const scienceCursor = parseIso(cur.last_science);
  const lastPost = parseIso(cur.last_post);
  const buildCursor = parseIso(cur.last_build_note);
  if (scienceCursor == null || lastPost == null) proceed("cached cursors incomplete");
  // F4: a hint dated ahead of this clock cannot describe a window anyone has seen.
  if (scienceCursor > Date.now() || lastPost > Date.now()) proceed("cached cursor is ahead of the clock");

  // Silence watchdog first: past the threshold a heartbeat is due regardless of rig state, so the window is
  // never "empty".
  const silentMin = (Date.now() - lastPost) / 60000;
  if (silentMin >= heartbeatAfterMin) proceed(`silent ${silentMin.toFixed(0)} min >= heartbeat ${heartbeatAfterMin} min`);

  // Live rig state: anything sealed on-chain, or any held blind candidate, newer than the science cursor is
  // real content the tiers would report.
  let state = null;
  let ledger = null;
  try {
    state = await fetchJson(STATE_URL);
  } catch (e) {
    proceed(`state fetch failed (${e && e.message})`);
  }
  try {
    ledger = await fetchJson(LEDGER_URL);
  } catch (e) {
    proceed(`ledger fetch failed (${e && e.message})`);
  }
  const entries = Array.isArray(ledger && ledger.ledger) ? ledger.ledger : [];
  const findings = Array.isArray(state && state.findings) ? state.findings : [];
  const newestAnchored = entries.reduce((m, e) => {
    const t = e && e.signature ? parseIso(e.anchoredAt) : null;
    return t == null ? m : Math.max(m, t);
  }, 0);
  const newestBlind = findings.reduce((m, f) => {
    const t = heldBlind(f) ? parseIso(f.createdAt) : null;
    return t == null ? m : Math.max(m, t);
  }, 0);
  // F1: `>=`, matching the composer's inclusive window start. `>` here would suppress an item forever.
  if (newestAnchored >= scienceCursor && newestAnchored > 0) proceed("a result was sealed on-chain at or after the science cursor");
  if (newestBlind >= scienceCursor && newestBlind > 0) proceed("a held blind candidate is at or after the science cursor");

  // Research milestone: reportable only when web/research.json landed inside the science window.
  const scienceIso = new Date(scienceCursor).toISOString();
  if (!covers(scienceIso)) proceed("git history does not cover the science cursor");
  if (git(["log", "HEAD", "--no-merges", `--since=${scienceIso}`, "--pretty=%H", "--", "web/research.json"]).trim()) {
    proceed("web/research.json changed inside the science window");
  }

  // Build note: any unreported, non-excluded commit subject since the dev cursor is content.
  if (buildCursor == null) proceed("no cached build-note cursor");
  const devIso = new Date(buildCursor - devOverlapMin * 60000).toISOString();
  if (!covers(devIso)) proceed("git history does not cover the dev cursor");
  let subjects = git(["log", "HEAD", "--no-merges", `--since=${devIso}`, "--pretty=%s", "--", ":!web/research.json", ":!reports/**", ":!out/**"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (devExclude) {
    let re = null;
    try {
      re = new RegExp(devExclude, "i");
    } catch {
      re = null;
    }
    if (re) subjects = subjects.filter((s) => !re.test(s));
  }
  if (subjects.length) proceed(`${subjects.length} unreported commit subject(s) in the dev window`);

  log(`window provably empty (science cursor ${scienceIso}, silent ${silentMin.toFixed(0)} min, no dev backlog)`);
  process.exit(EMPTY);
}

// Run only as a CLI: the helpers are imported by tests, and main() ends in process.exit(). argv[1] is relative
// when the workflow calls `node scripts/x-post-preflight.mjs`, so resolve it before comparing -- a raw string
// compare would silently disable the gate on exactly the path that matters.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(`unexpected error (${e && e.message}); proceeding`);
    process.exit(0);
  });
}
