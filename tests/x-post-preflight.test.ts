// The half-hourly X digest is gated by scripts/x-post-preflight.mjs, which may stop the job BEFORE installing
// anything. That makes it the one component in this channel whose failure mode is silent: a wrong "empty" verdict
// suppresses a post, and because skipping never advances a cursor, the suppressed item stays suppressible forever.
// The workflow header itself records the lesson -- "composeDigest's tiers are unit-tested, but the SHELL that
// drives them is CI-only and no test loads it" -- and round-22 shipped this gate with exactly that hole: over the
// first 10 live runs it skipped nothing, and the empty-window branch had never been executed anywhere.
//
// So these tests drive the REAL CLI (spawned, with a fixture rig over 127.0.0.1 and a throwaway git repo as cwd)
// and pin the two directions separately: every untrusted input must PROCEED, and only a window that is genuinely
// empty may return 42. The F1/F4 cases are regressions for defects found by the round-24 audit; the last case
// pins the hand-copied blind predicate to the shared definition it must agree with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isHeldBlindCandidate } from "../src/core/stats-definitions.ts";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCRIPT = stripWin(new URL("../scripts/x-post-preflight.mjs", import.meta.url));
const REPO = stripWin(new URL("..", import.meta.url));

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// One hour ago: comfortably inside every window, and far enough from the 45-minute heartbeat threshold that a
// test which does not care about silence stays clear of it.
const CURSOR = iso(NOW - 3600_000);
const RECENT = iso(NOW - 60_000);

function cursorJson(over: Record<string, string> = {}): string {
  return JSON.stringify({ last_post: RECENT, last_science: CURSOR, last_build_note: RECENT, ...over });
}

/** A throwaway repo whose single commit sits years in the past, so git coverage is deterministic. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "xpf-"));
  // Epoch form ("@<seconds>"), never an ISO string with a trailing Z: git's date parser reads such a value in
  // the RUNNER's local timezone, so on a UTC+8 box a "recent" commit silently lands eight hours earlier and the
  // dev-window test would fail for a reason that has nothing to do with the code under test.
  const env = { ...process.env, GIT_AUTHOR_DATE: "@1577934245", GIT_COMMITTER_DATE: "@1577934245" };
  const g = (args: string[], extra: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, env: { ...env, ...extra }, stdio: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@example.invalid"]);
  g(["config", "user.name", "x-post-preflight-test"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(["add", "seed.txt"]);
  g(["commit", "-q", "-m", "seed"]);
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "x-cursors.json"), cursorJson());
  return dir;
}

/** Add a commit dated just now, i.e. real development work sitting inside the dev window. */
function addRecentCommit(dir: string): void {
  writeFileSync(join(dir, `work-${Date.now()}.txt`), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "feat: recent work"], {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_DATE: `@${Math.floor((NOW - 120_000) / 1000)}`, GIT_COMMITTER_DATE: `@${Math.floor((NOW - 120_000) / 1000)}` },
  });
}

async function startFixture(state: unknown, ledger: unknown, opts: { stateStatus?: number } = {}): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = req.url || "";
    if (url.startsWith("/api/state")) {
      if (opts.stateStatus && opts.stateStatus !== 200) {
        res.writeHead(opts.stateStatus);
        res.end("upstream down");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    if (url.startsWith("/api/ledger")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ledger));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/**
 * Spawn the CLI and wait. ASYNC on purpose: the fixture rig is served from this process's own event loop, so a
 * blocking execFileSync would deadlock it and every request would hang until the pre-flight's own 15s abort --
 * which is exactly how the first draft of this file failed, and it failed as a "network error", not as a hint
 * that the harness was wrong.
 */
function runCli(cwd: string, env: Record<string, string>, script: string = SCRIPT): Promise<{ code: number; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", (e: Error) => resolveRun({ code: -1, out: `${out}${e.message}` }));
    child.on("close", (code: number | null) => resolveRun({ code: code == null ? -1 : code, out }));
  });
}

/** One place to drive the CLI against a fixture rig, so no test can forget to close the server. */
async function decide(
  dir: string,
  fixtures: { state?: unknown; ledger?: unknown; stateStatus?: number; script?: string; env?: Record<string, string> },
): Promise<{ code: number; out: string }> {
  const { base, server } = await startFixture(fixtures.state ?? { findings: [] }, fixtures.ledger ?? { ledger: [] }, { stateStatus: fixtures.stateStatus });
  try {
    return await runCli(
      dir,
      {
        CURSOR_FILE: join(dir, "out", "x-cursors.json"),
        STATE_URL: `${base}/api/state`,
        LEDGER_URL: `${base}/api/ledger`,
        HEARTBEAT_AFTER_MIN: "45",
        DEV_OVERLAP_MIN: "10",
        DEV_COMMIT_EXCLUDE: "^chore\\(deps",
        ...(fixtures.env || {}),
      },
      fixtures.script,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("a window with nothing sealed, nothing held and no backlog is provably empty (exit 42)", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { state: { findings: [{ id: "F-1", origin: "catalog", verdict: "accepted", createdAt: iso(NOW - 5000) }] }, ledger: { ledger: [] } });
  assert.equal(r.code, 42, r.out);
  assert.match(r.out, /window provably empty/);
});

test("F1: a sealed result timestamped exactly AT the science cursor proceeds, not skips", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { ledger: { ledger: [{ signature: "sig", anchoredAt: CURSOR }] } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sealed on-chain/);
});

test("F1: a held blind candidate timestamped exactly AT the science cursor proceeds", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { state: { findings: [{ origin: "blind-toi", verdict: null, createdAt: CURSOR }] } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held blind candidate/);
});

test("a rejected blind row is not content: the predicate is applied, not just a timestamp scan", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { state: { findings: [{ origin: "blind-toi", verdict: "rejected", createdAt: iso(NOW - 5000) }] } });
  assert.equal(r.code, 42, r.out);
});

test("F4: a cursor dated ahead of this clock is untrusted and proceeds", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "out", "x-cursors.json"), cursorJson({ last_science: iso(NOW + 3600_000) }));
  const r = await decide(dir, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ahead of the clock/);
});

test("no cached cursor file proceeds (first run, cache miss, or an override run that wrote none)", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { env: { CURSOR_FILE: join(dir, "out", "absent.json") } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no cached cursors/);
});

test("an incomplete cursor (no science field) proceeds", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "out", "x-cursors.json"), JSON.stringify({ last_post: RECENT, last_science: "", last_build_note: "" }));
  const r = await decide(dir, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cursors incomplete/);
});

test("an unreachable rig proceeds (the gate may never skip on a network error)", async () => {
  const dir = makeRepo();
  const r = await decide(dir, { stateStatus: 500 });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /state fetch failed/);
});

test("silence past the heartbeat threshold proceeds regardless of rig state", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "out", "x-cursors.json"), cursorJson({ last_post: iso(NOW - 3600_000) }));
  const r = await decide(dir, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /silent 60 min >= heartbeat 45 min/);
});

test("an unreported commit in the dev window proceeds", async () => {
  const dir = makeRepo();
  addRecentCommit(dir);
  const r = await decide(dir, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unreported commit subject/);
});

test("the CLI still runs when the workflow invokes it by a RELATIVE path", async () => {
  // The module exports its helpers for the drift test below, which requires a "run only as a script" guard.
  // argv[1] is relative exactly when invoked as `node scripts/x-post-preflight.mjs`, so a naive compare would
  // have disabled the gate on the one path that matters while every test here still passed.
  const r = await runCli(REPO, { CURSOR_FILE: join(tmpdir(), "xpf-relative-probe.json") }, "scripts/x-post-preflight.mjs");
  assert.match(r.out, /x-post-preflight: proceed/);
  assert.equal(r.code, 0, r.out);
});

test("F2: the pre-flight's hand copy of the blind predicate agrees with the shared definition", async () => {
  const mod = (await import(pathToFileURL(SCRIPT).href)) as { heldBlind: (f: unknown) => boolean };
  const rows: unknown[] = [
    { origin: "blind-toi" },
    { origin: "blind-toi", verdict: null },
    { origin: "blind-toi", verdict: "rejected" },
    { origin: "blind-toi", verdict: "accepted" },
    { origin: "blind-toi", verdict: "needs-more-data" },
    { origin: "blind-toi", verdict: "Rejected" },
    { origin: "blind", verdict: "accepted" },
    { origin: "catalog", verdict: "rejected" },
    { verdict: "rejected" },
    {},
  ];
  for (const row of rows) {
    assert.equal(
      mod.heldBlind(row),
      isHeldBlindCandidate(row as Parameters<typeof isHeldBlindCandidate>[0]),
      `the two definitions of "held blind candidate" disagree on ${JSON.stringify(row)}`,
    );
  }
});
