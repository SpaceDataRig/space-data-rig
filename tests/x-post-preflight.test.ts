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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
 * Spawn a process and wait. ASYNC on purpose, twice over: the fixture rig is served from this process's own
 * event loop, so ANY blocking wait (execFileSync included) deadlocks it and every request hangs until the
 * pre-flight's own 15s abort -- which then surfaces as "state fetch failed -> proceed", i.e. as a wrong verdict
 * rather than a broken harness. Both this file's first draft and its F13 case fell into that trap.
 */
function runProc(cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", (e: Error) => resolveRun({ code: -1, out: `${out}${e.message}` }));
    child.on("close", (code: number | null) => resolveRun({ code: code == null ? -1 : code, out }));
  });
}

function runCli(cwd: string, env: Record<string, string>, script: string = SCRIPT): Promise<{ code: number; out: string }> {
  return runProc(process.execPath, [script], cwd, env);
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

// ---- F13: the SHELL around the pre-flight, not just the pre-flight. -----------------------------------------
// GitHub runs every `run:` block as `bash -e -o pipefail`, so a step that lets a non-zero exit reach the end of a
// line dies there. The shipped pre-flight step ended its `node` call that way: the first window the gate ever
// PROVED empty (run 40303969337) came back as a failed job with no `skip=1` written, because the step aborted on
// the 42 instead of reading it. Nothing in npm test loaded that shell, which is the exact gap the workflow header
// already documents for the compose step. These cases extract the real block from the real YAML and run it under
// the real shell options.
function findBash(): string | null {
  const cands = [process.env.BASH_BIN, "/bin/bash", "C:/Program Files/Git/bin/bash.exe"];
  return cands.find((p) => p && existsSync(p)) || null;
}

/** Slice the pre-flight step's `run: |` body out of the workflow, dedented, exactly as the runner would see it. */
function preflightStepShell(): string {
  const yml = readFileSync(join(REPO, ".github", "workflows", "x-post.yml"), "utf8").replace(/\r\n?/g, "\n");
  const anchor = yml.indexOf("id: preflight");
  assert.ok(anchor > 0, "the pre-flight step no longer carries `id: preflight`");
  const runAt = yml.indexOf("\n        run: |\n", anchor);
  assert.ok(runAt > 0, "the pre-flight step no longer has a `run: |` block");
  const lines: string[] = [];
  for (const line of yml.slice(runAt + "\n        run: |\n".length).split("\n")) {
    if (line.startsWith("          ")) lines.push(line.slice(10));
    else if (line.trim() === "") lines.push("");
    else break;
  }
  const body = lines.join("\n");
  assert.match(body, /x-post-preflight\.mjs/, "the extracted block does not invoke the pre-flight");
  return body;
}

/** Run the extracted workflow step under the runner's own shell options against a fixture rig. */
async function runStepBlock(dir: string, state: unknown, ledger: unknown): Promise<{ code: number; out: string; written: string }> {
  const bash = findBash();
  assert.ok(bash, "no bash on this host");
  const blockFile = join(dir, "step.sh");
  const outFile = join(dir, "github_output.txt");
  writeFileSync(blockFile, preflightStepShell().replace(/\r\n?/g, "\n"));
  const { base, server } = await startFixture(state, ledger);
  try {
    const r = await runProc(bash, ["--noprofile", "--norc", "-eo", "pipefail", blockFile], REPO, {
      GITHUB_OUTPUT: outFile,
      // HERMETICITY (round-26). The step is launched from this checkout because its shell refers to
      // `scripts/x-post-preflight.mjs` by a repo-relative path -- but the pre-flight's own `git log` calls then read
      // THIS repository, not the fixture. That is how a commit touching web/research.json in the real repo flipped the
      // F13 empty-window case to "proceed (web/research.json changed inside the science window)": the science cursor is
      // deliberately in the past, so the only thing that kept that window empty was a fixture that was never consulted.
      // Pointing GIT_DIR/GIT_WORK_TREE at the fixture makes the drill test the gate instead of the calendar.
      GIT_DIR: join(dir, ".git"),
      GIT_WORK_TREE: dir,
      CURSOR_FILE: join(dir, "out", "x-cursors.json"),
      STATE_URL: `${base}/api/state`,
      LEDGER_URL: `${base}/api/ledger`,
      HEARTBEAT_AFTER_MIN: "45",
      DEV_OVERLAP_MIN: "10",
      DEV_COMMIT_EXCLUDE: "^chore\\(deps",
      OVERRIDE_TEXT: "",
      OVERRIDE_SINCE: "",
      DRY_HEARTBEAT: "",
    });
    return { ...r, written: existsSync(outFile) ? readFileSync(outFile, "utf8") : "" };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A build-note cursor in the future keeps the dev window empty whenever this runs, so the empty case stays real
 *  on a repo where commits land minutes apart. */
function emptyWindowCursors(dir: string): void {
  writeFileSync(join(dir, "out", "x-cursors.json"), cursorJson({ last_build_note: iso(NOW + 7200_000) }));
}

test("F13: the workflow step turns a 42 into skip=1 and a green step, not a failed job", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  emptyWindowCursors(dir);
  const r = await runStepBlock(dir, { findings: [] }, { ledger: [] });
  assert.match(r.out, /window provably empty/, r.out);
  assert.equal(r.code, 0, `the step must exit clean on an empty window: ${r.out}`);
  assert.match(r.written, /skip=1/, `the step must record skip=1; got: ${JSON.stringify(r.written)}`);
});

test("the workflow step records skip=0 and stays green when the window holds content", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  emptyWindowCursors(dir);
  const r = await runStepBlock(dir, { findings: [{ origin: "blind-toi", verdict: null, createdAt: CURSOR }] }, { ledger: [] });
  assert.match(r.out, /proceed/, r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.written, /skip=0/, `the step must record skip=0; got: ${JSON.stringify(r.written)}`);
});

/**
 * Commit `web/research.json` in the FIXTURE repo at a chosen moment. Round-26 added this because the research tier --
 * the one tier allowed to announce a science milestone -- had never been exercised through the step block, and the
 * step used to read this checkout by accident: a commit here could flip a fixture's verdict. Now the only repository
 * that can move the answer is the one the test built.
 */
function addResearchCommit(dir: string, atMs: number): void {
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "web", "research.json"), '{"schema":"sdr-research/1"}\n');
  execFileSync("git", ["add", "web/research.json"], { cwd: dir, stdio: "ignore" });
  const epoch = `@${Math.floor(atMs / 1000)}`;
  execFileSync("git", ["commit", "-q", "-m", "docs(research): bundle refresh"], {
    cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: epoch, GIT_COMMITTER_DATE: epoch },
  });
}

test("the research tier fires when research.json lands inside the science window of the repository the step reads", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  emptyWindowCursors(dir);
  addResearchCommit(dir, NOW - 120_000); // two minutes ago: inside a window opened an hour ago
  const r = await runStepBlock(dir, { findings: [] }, { ledger: [] });
  assert.match(r.out, /research\.json changed inside the science window/, r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.written, /skip=0/, `a research milestone must not be skipped away; got: ${JSON.stringify(r.written)}`);
});

test("the same commit is ignored once it predates the science cursor -- the window decides, not the file's existence", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  emptyWindowCursors(dir);
  addResearchCommit(dir, NOW - 2 * 3600_000); // two hours ago: outside the window, and already reported
  const r = await runStepBlock(dir, { findings: [] }, { ledger: [] });
  assert.match(r.out, /window provably empty/, r.out);
  assert.match(r.written, /skip=1/, `an already-announced bundle must not re-fire the tier; got: ${JSON.stringify(r.written)}`);
});

// ---- ROUND-24 F17: the hint must not launder the silence watchdog. -------------------------------------------
// F3 advanced the hint to the run's own snapshot so the gate stops re-proceeding on news already announced. That
// is right for the two WINDOW cursors (last_science, last_build_note) and wrong for last_post, which the
// pre-flight uses as `now - last_post >= heartbeat threshold`. Bumping it every half hour caps silentMin at the
// cadence forever: a heartbeat could never come due, and the gate would skip precisely the windows the heartbeat
// exists to cover. The first version of the F3 fix did exactly that, and no test noticed, because the CLI side of
// the watchdog was already pinned (above) and the shell side was not tested at all.
function hintStepShell(): string {
  const yml = readFileSync(join(REPO, ".github", "workflows", "x-post.yml"), "utf8").replace(/\r\n?/g, "\n");
  const start = yml.indexOf("HINT_EPOCH=");
  const end = yml.indexOf("pre-flight hint for the next run");
  assert.ok(start > 0 && end > start, "the hint block is no longer in the workflow");
  const body = yml
    .slice(start, yml.indexOf("\n", end) + 1)
    .split("\n")
    .map((l) => (l.startsWith("          ") ? l.slice(10) : l))
    .join("\n");
  assert.match(body, /last_post/, "the extracted block does not write last_post");
  return body;
}

/** Run the shipped hint block under the runner's shell options and return the cursor JSON it leaves behind. */
async function runHintBlock(dir: string, over: Record<string, string>): Promise<Record<string, string>> {
  const bash = findBash();
  assert.ok(bash, "no bash on this host");
  const blockFile = join(dir, "hint.sh");
  writeFileSync(blockFile, hintStepShell().replace(/\r\n?/g, "\n"));
  const r = await runProc(bash, ["--noprofile", "--norc", "-eo", "pipefail", blockFile], dir, {
    FETCH_EPOCH: String(Math.floor(NOW / 1000)),
    CURSOR_HINT_BACKOFF_S: "30",
    LAST_POST_ISO: iso(NOW - 3 * 3600_000),
    LAST_SCIENCE_ISO: iso(NOW - 3 * 3600_000),
    LAST_BUILD_NOTE_ISO: iso(NOW - 3 * 3600_000),
    SENT: "0",
    ...over,
  });
  assert.equal(r.code, 0, `the hint block failed: ${r.out}`);
  return JSON.parse(readFileSync(join(dir, "out", "x-cursors.json"), "utf8"));
}

test("F17: a run that posted nothing leaves last_post at the true feed value", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  const cur = await runHintBlock(dir, { SENT: "0" });
  assert.equal(cur.last_post, iso(NOW - 3 * 3600_000), "last_post must NOT be advanced by a run that posted nothing");
  // The window cursors DO advance, which is the whole point of F3.
  assert.ok(Date.parse(cur.last_science) > NOW - 3 * 3600_000, `last_science should have advanced, got ${cur.last_science}`);
});

test("F17: a run that posted advances last_post, so the next window is measured from a real post", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  const cur = await runHintBlock(dir, { SENT: "2" });
  const advanced = Date.parse(cur.last_post);
  assert.ok(advanced >= NOW - 60_000 && advanced <= NOW, `expected a hint near the snapshot, got ${cur.last_post}`);
});

test("F17: the hint a silent run writes still makes the real CLI post a heartbeat, not skip", async (t) => {
  if (!findBash()) return t.skip("no bash on this host");
  const dir = makeRepo();
  // Compose the two halves: the shipped shell produces the cursor file, the shipped CLI reads it. Each side was
  // tested alone before; the defect lived in the seam, where last_post looked fresh enough to skip with.
  const cur = await runHintBlock(dir, { SENT: "0", LAST_BUILD_NOTE_ISO: iso(NOW + 7200_000) });
  writeFileSync(join(dir, "out", "x-cursors.json"), JSON.stringify({ ...cur, last_build_note: iso(NOW + 7200_000) }));
  const { base, server } = await startFixture({ findings: [] }, { ledger: [] });
  try {
    const r = await runCli(dir, {
      CURSOR_FILE: join(dir, "out", "x-cursors.json"),
      STATE_URL: `${base}/api/state`,
      LEDGER_URL: `${base}/api/ledger`,
      HEARTBEAT_AFTER_MIN: "45",
    });
    assert.equal(r.code, 0, `a 3-hour silence must proceed for a heartbeat, not skip: ${r.out}`);
    assert.match(r.out, /silent 180 min >= heartbeat 45 min/, r.out);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});

