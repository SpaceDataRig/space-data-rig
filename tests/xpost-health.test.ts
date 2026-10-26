// tests for scripts/xpost-health.ts -- the audit of the X posting channel, read out of its job logs.
//
// The lesson these tests exist to pin: an unanchored substring search over a job log is UNSOUND, because the log
// contains the post bodies. The first version of this audit reported "DRY RUN in production -- credentials missing"
// for a run that had in fact posted successfully, purely because the summary it pushed happened to contain the
// words "prints DRY RUN". So the fixtures below deliberately put signal-looking text inside a post body, and the
// assertions check that the audit is not fooled by it -- and, just as importantly, that a healthy window still
// produces an empty findings list rather than a comfortable one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseXpostLog, emptyFindings, judgeFleet, type RunRow } from "../scripts/xpost-health.ts";

/** Prefix each message the way the runner does, so the parser sees a realistic line. */
function log(...messages: string[]): string {
  return messages.map((m, i) => `2026-10-18T04:00:${String(10 + (i % 40)).padStart(2, "0")}.0000000Z ${m}`).join("\n");
}

function row(id: string, createdAt: string, conclusion: string, f: ReturnType<typeof analyseXpostLog>): RunRow {
  return { id, createdAt, conclusion, event: "workflow_dispatch", headSha: "deadbeef", f };
}

const NOW = Date.parse("2026-10-18T05:00:00Z");

// ---- what a genuinely healthy run looks like. Built once and reused, so "no findings" is a real outcome the
// suite proves, not the absence of any input that could produce one.
const HEALTHY_LOG = log(
  "x:last-post: ok",
  "x-last-post: wrote 10 already-reported subject(s) to out/reported-subjects.txt",
  "digest window since: 2026-10-18T03:00:00Z (science cursor: 2026-10-18T03:00:12Z; last post of any kind: 2026-10-18T03:00:12Z)",
  "build-note cursor: dev window since 2026-10-18T02:50:00Z (last build note: 2026-10-18T03:00:44.000Z, overlap 10m)",
  "research.json commits in window: 0 (researchUpdated=0)",
  "build-note backlog: 3 unreported commit subject(s) since 2026-10-18T02:50:00Z (batch 24, look-back cap 200, exclude '^chore\\(deps')",
  "build note: composed 1 batch file(s) from 3 subject(s)",
  "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 337 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 1860 byte(s)] heartbeat [1 file(s) 0 byte(s)]",
  "posting 2 composed item(s); runaway ceiling 25, delay 5s between posts",
  "posting item 1 (of up to 25) from out/posts/02-blind.txt: Its blind sweep turned up 1 new UNCONFIRMED candidate.",
  "x:post: OK posted (id 111).",
  "posting item 2 (of up to 25) from out/posts/10-note.txt: Under the hood, what changed:",
  "x:post: OK posted (id 222).",
  "posted 2 item(s) this run",
);

test("a healthy window produces NO findings, so a clean verdict means something", () => {
  const f = analyseXpostLog(HEALTHY_LOG);
  assert.deepEqual(f.postedIds, ["111", "222"]);
  assert.equal(f.queued, 2);
  assert.equal(f.selfReported, 2);
  assert.equal(f.backlog, 3);
  assert.equal(f.alreadyReported, 10, "the x-last-post prefix must not defeat the cursor-dedup counter");
  assert.deepEqual(f.tiers, { blind: 1, note: 1 });
  assert.equal(f.dryRunLines, 0);
  assert.equal(f.override, false);

  const problems = judgeFleet([row("1", "2026-10-18T04:55:00Z", "success", f)], NOW);
  assert.deepEqual(problems, [], `expected a clean verdict, got: ${JSON.stringify(problems)}`);
});

// The fixture above was written from what I believed the log said. Production decorates the line with the
// stream npm captured -- read from the raw job log of run 39100772239 (2026-10-18T05:30Z), not imagined:
//   x:lastpost stderr: x-last-post: wrote 14 already-reported subject(s) to out/reported-subjects.txt
// An anchor that requires the tool's name at column 0 never matches that, so `alreadyReported` stayed null for
// every real run, and the backlog rule that reads it could not fire in EITHER direction. An auditor that cannot
// find a stall and cannot clear one still prints a clean verdict -- which is how this stayed hidden until the
// raw log was opened.
const PRODUCTION_LOG = log(
  "x:lastpost stderr: x-last-post: wrote 14 already-reported subject(s) to out/reported-subjects.txt ",
  "digest window since: 2026-10-18T04:20:42Z (science cursor: 2026-10-18T04:30:36.000Z; last post of any kind: 2026-10-18T05:00:44.000Z)",
  "build-note cursor: dev window since 2026-10-18T04:50:44Z (last build note: none found, overlap 10m)",
  "build-note backlog: 1 unreported commit subject(s) since 2026-10-18T04:50:44Z (batch 24, look-back cap 200, exclude '^chore\\(deps')",
  "build note: composed 1 batch file(s) from 1 subject(s)",
  "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 423 byte(s)] heartbeat [not-attempted]",
  "posting 1 composed item(s); runaway ceiling 25, delay 5s between posts",
  "posting item 1 (of up to 25) from out/posts/10-note.txt: Not a science result -- a build note on the pipeline itself:",
  "x:post: OK posted (id 2111691404216815807).",
  "posted 1 item(s) this run",
);

test("real production log lines are parsed, not just the tidy ones the fixture invented", () => {
  const f = analyseXpostLog(PRODUCTION_LOG);
  assert.deepEqual(f.postedIds, ["2111691404216815807"]);
  assert.equal(f.alreadyReported, 14, "npm's `x:lastpost stderr: ` decoration must not hide the dedup counter");
  assert.equal(f.backlog, 1);
  assert.equal(f.queued, 1);
  assert.equal(f.selfReported, 1);
  assert.deepEqual(f.tiers, { note: 1 });
  assert.deepEqual(f.tiersAttempted, { ledger: true, blind: true, milestone: true, note: true, heartbeat: false });
  assert.equal(f.override, false);

  const problems = judgeFleet([row("7", "2026-10-18T05:30:00Z", "success", f)], NOW);
  assert.deepEqual(problems, [], `a normal build-note run must be clean, got: ${JSON.stringify(problems)}`);
});

test("with the counter parsed, a backlog that is not covered by announced subjects is finally detectable", () => {
  // Three subjects in the window, one already announced, no build note posted: two are unreported and the tier
  // stayed silent. This is the finding the inert rule was missing.
  const stuck = analyseXpostLog(log(
    "x:lastpost stderr: x-last-post: wrote 1 already-reported subject(s) to out/reported-subjects.txt ",
    "build-note backlog: 3 unreported commit subject(s) since 2026-10-18T04:50:44Z (batch 24, look-back cap 200, exclude '^chore\\(deps')",
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [1 file(s) 0 byte(s)]",
    "posting 0 composed item(s); runaway ceiling 25, delay 5s between posts",
    "posted 0 item(s) this run",
  ));
  const problems = judgeFleet([row("8", "2026-10-18T05:30:00Z", "success", stuck)], NOW);
  const hit = problems.filter((p) => p.includes("build-note backlog"));
  assert.equal(hit.length, 1, `expected the residual rule to fire, got: ${JSON.stringify(problems)}`);
  assert.match(hit[0], /at least 2 are unreported/);
});

test("the fallback is only excused when something else actually went out", () => {
  // The other half of the heartbeat rule: a window in which NO tier posted anything is precisely when the
  // silence watchdog should have fired, so its absence there is a finding and must not be excused.
  const quiet = analyseXpostLog(log(
    "posting 0 composed item(s); runaway ceiling 25, delay 5s between posts",
    "posted 0 item(s) this run",
    "nothing composed; could not read last-post time (X read unavailable) -> skipping, no heartbeat",
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [not-attempted]",
  ));
  const problems = judgeFleet([row("9", "2026-10-18T05:30:00Z", "success", quiet)], NOW);
  assert.ok(problems.some((p) => p.includes("heartbeat")), `heartbeat must still be accountable here, got: ${JSON.stringify(problems)}`);
});

test("a post body that mentions DRY RUN is content, not a credential failure", () => {
  // Exactly the case that produced the false alarm: the pushed summary discussed the guard and used the phrase.
  const forged = log(
    "posting override (maxlen=25000): Space Data Rig: authored text now goes through the real guard, which prints DRY RUN without sending anything.",
    "x:post: OK posted (id 555).",
    "posted 1 item(s) this run",
  );
  const f = analyseXpostLog(forged);
  assert.equal(f.override, true);
  assert.deepEqual(f.postedIds, ["555"]);
  assert.equal(f.dryRunLines, 0, "an unanchored match inside the body must not be counted as a status line");
  assert.equal(f.dryRunIsStatus, false);
  assert.deepEqual(judgeFleet([row("2", "2026-10-18T04:50:00Z", "success", f)], NOW), []);
});

test("even a body line that STARTS with a status prefix is contradicted away by a confirmed post", () => {
  // The residual hole, pinned rather than hidden: a multi-line post whose own line begins with the status prefix.
  // Anchoring cannot disambiguate that, so the contradiction rule is what keeps the audit sound -- DRY RUN is only
  // a fault when nothing went out.
  const hostile = log(
    "posting override (maxlen=25000): Space Data Rig documents its own guard:",
    "x:post: DRY RUN (this line is post content, echoed because the body is printed verbatim)",
    "x:post: OK posted (id 777).",
    "posted 1 item(s) this run",
  );
  const f = analyseXpostLog(hostile);
  assert.equal(f.dryRunLines, 1, "the line IS matched -- anchoring cannot tell content from status here");
  assert.equal(f.dryRunIsStatus, false, "but a run that posted is not a run that failed to send");
  assert.deepEqual(judgeFleet([row("3", "2026-10-18T04:45:00Z", "success", f)], NOW), []);
});

test("a real DRY RUN -- nothing posted -- IS reported", () => {
  const f = analyseXpostLog(log("posting override (maxlen=25000): hello", "x:post: DRY RUN (no X credentials in the environment)."));
  assert.equal(f.postedIds.length, 0);
  assert.equal(f.dryRunIsStatus, true);
  const problems = judgeFleet([row("4", "2026-10-18T04:40:00Z", "success", f)], NOW);
  assert.ok(problems.some((p) => /credentials are missing/.test(p)), problems.join(" | "));
});

test("a REFUSED item is reported even when the same run posted others", () => {
  const f = analyseXpostLog(log(
    "posting 2 composed item(s); runaway ceiling 25, delay 5s between posts",
    "x:post: REFUSED -- final text contains 3 affirmative over-claim(s)",
    "##[error]x:post failed on out/posts/10-note.txt; stopping the loop so the cursors do not advance past an unsent item",
    "posting item 1 (of up to 25) from out/posts/02-blind.txt: fine",
    "x:post: OK posted (id 888).",
    "posted 1 item(s) this run",
  ));
  assert.equal(f.refused, 1);
  assert.equal(f.loopAborted, true);
  const problems = judgeFleet([row("5", "2026-10-18T04:35:00Z", "failure", f)], NOW);
  assert.ok(problems.some((p) => /REFUSED 1 item/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /loop aborted/.test(p)), problems.join(" | "));
});

test("the workflow's own counter disagreeing with the confirmed sends is a finding", () => {
  const f = analyseXpostLog(log(
    "posting item 1 (of up to 25) from out/posts/02-blind.txt: x",
    "x:post: OK posted (id 999).",
    "posted 3 item(s) this run",
  ));
  assert.equal(f.postedIds.length, 1);
  assert.equal(f.selfReported, 3);
  const problems = judgeFleet([row("6", "2026-10-18T04:30:00Z", "success", f)], NOW);
  assert.ok(problems.some((p) => /counters disagree/.test(p)), problems.join(" | "));
});

test("items composed but none posted is a finding", () => {
  const f = analyseXpostLog(log("posting 2 composed item(s); runaway ceiling 25, delay 5s between posts", "posted 0 item(s) this run"));
  const problems = judgeFleet([row("7", "2026-10-18T04:25:00Z", "success", f)], NOW);
  assert.ok(problems.some((p) => /composed, none posted/.test(p)), problems.join(" | "));
});

test("a backlog fully covered by already-announced subjects is NOT a stall", () => {
  // The false positive this replaced: 1 subject in the window, 10 already announced, nothing new to say.
  const f = analyseXpostLog(log(
    "x-last-post: wrote 10 already-reported subject(s) to out/reported-subjects.txt",
    "build-note backlog: 1 unreported commit subject(s) since 2026-10-18T02:50:44Z (batch 24, look-back cap 200, exclude '^chore\\(deps')",
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [1 file(s) 0 byte(s)]",
    "posting 0 composed item(s); runaway ceiling 25, delay 5s between posts",
    "nothing reportable in this window; posted nothing (never posts an empty tweet)",
  ));
  assert.equal(f.backlog, 1);
  assert.equal(f.alreadyReported, 10);
  const problems = judgeFleet([row("8", "2026-10-18T04:20:00Z", "success", f)], NOW);
  assert.ok(!problems.some((p) => /unreported and no build note/.test(p)), `must not call this a stall: ${problems.join(" | ")}`);
});

test("a backlog with genuinely unannounced subjects and no build note IS a stall", () => {
  const f = analyseXpostLog(log(
    "x-last-post: wrote 2 already-reported subject(s) to out/reported-subjects.txt",
    "build-note backlog: 5 unreported commit subject(s) since 2026-10-18T02:50:44Z (batch 24, look-back cap 200, exclude '^chore\\(deps')",
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [1 file(s) 0 byte(s)]",
    "posting 0 composed item(s); runaway ceiling 25, delay 5s between posts",
  ));
  const problems = judgeFleet([row("9", "2026-10-18T04:15:00Z", "success", f)], NOW);
  assert.ok(problems.some((p) => /at least 3 are unreported/.test(p)), problems.join(" | "));
});

test("the per-tier manifest separates 'nothing to report' from 'never attempted'", () => {
  const attempted = analyseXpostLog(log(
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [1 file(s) 0 byte(s)]",
    "x:post: OK posted (id 1).",
  ));
  assert.deepEqual(Object.keys(attempted.tiersAttempted).sort(), ["blind", "heartbeat", "ledger", "milestone", "note"]);
  assert.ok(Object.values(attempted.tiersAttempted).every(Boolean), "a zero-byte file still means the tier ran");

  const notAttempted = analyseXpostLog(log(
    "tier manifest: ledger [not-attempted] blind [1 file(s) 337 byte(s)] milestone [not-attempted] note [1 file(s) 0 byte(s)] heartbeat [not-attempted]",
  ));
  assert.equal(notAttempted.tiersAttempted.ledger, false);
  assert.equal(notAttempted.tiersAttempted.blind, true);

  const problems = judgeFleet([row("10", "2026-10-18T04:10:00Z", "success", notAttempted)], NOW);
  assert.ok(problems.some((p) => /never attempted/.test(p) && /ledger/.test(p)), problems.join(" | "));
});

test("an override run is not blamed for the tiers it deliberately short-circuits", () => {
  // The workflow's override branch posts the supplied text and exits before composing any tier, so a window of
  // overrides has no tier activity by design. Flagging that would be a false alarm on every authored push.
  const f = analyseXpostLog(log(
    "posting override (maxlen=25000): An authored summary of the stage.",
    "x:post: OK posted (id 4242).",
  ));
  assert.equal(f.override, true);
  assert.deepEqual(f.tiers, {});
  assert.deepEqual(f.tiersAttempted, {});
  assert.deepEqual(judgeFleet([row("15", "2026-10-18T04:00:00Z", "success", f)], NOW), []);
});

test("a regular run with no manifest line is reported as an observability gap, not as a clean bill", () => {
  const f = analyseXpostLog(log("x:post: OK posted (id 1).", "posted 1 item(s) this run"));
  assert.deepEqual(f.tiersAttempted, {});
  const problems = judgeFleet([row("11", "2026-10-18T04:05:00Z", "success", f)], NOW);
  assert.ok(problems.some((p) => /cannot tell "nothing to report" from "never attempted"/.test(p)), problems.join(" | "));
});

test("an empty window and a stale trigger are both reported", () => {
  assert.ok(judgeFleet([], NOW).some((p) => /no completed runs/.test(p)));
  const quiet = analyseXpostLog(log("nothing reportable in this window; posted nothing (never posts an empty tweet)",
    "tier manifest: ledger [1 file(s) 0 byte(s)] blind [1 file(s) 0 byte(s)] milestone [1 file(s) 0 byte(s)] note [1 file(s) 0 byte(s)] heartbeat [1 file(s) 0 byte(s)]"));
  const stale = judgeFleet([row("12", "2026-10-18T01:00:00Z", "success", quiet)], NOW);
  assert.ok(stale.some((p) => /dispatch wake is not firing/.test(p)), stale.join(" | "));
  // Silence alone is not a fault: a run 10 minutes ago that had nothing to say is correct behaviour.
  const fresh = judgeFleet([row("13", "2026-10-18T04:55:00Z", "success", quiet)], NOW);
  assert.ok(!fresh.some((p) => /dispatch wake is not firing/.test(p)), fresh.join(" | "));
});

test("a shell abort that never reached a status line is still reported", () => {
  // conclusion=failure with no x:post line at all: the old pipefail class of bug, invisible to a refusal check.
  const f = analyseXpostLog(log("digest window since: 2026-10-18T03:36:08Z", "##[error]Process completed with exit code 1."));
  assert.equal(f.stepExitFailure, true);
  assert.equal(f.postedIds.length, 0);
  const problems = judgeFleet([row("14", "2026-10-18T04:00:00Z", "failure", f)], NOW);
  assert.ok(problems.some((p) => /the step exited non-zero/.test(p)), problems.join(" | "));
});

test("dropped commit subjects are collected with their reasons, so silence is explainable", () => {
  const f = analyseXpostLog(log(
    "science-digest: dropping commit subject (over-claim wording (first)): feat: the first automated veto",
    "science-digest: dropping commit subject (spend/key wording): fix: wallet cost",
  ));
  assert.equal(f.droppedSubjects.length, 2);
  assert.equal(f.droppedSubjects[0].reason, "over-claim wording (first)");
  assert.match(f.droppedSubjects[1].subject, /wallet/);
});

test("emptyFindings is a valid row, so an unreadable run still appears in the table", () => {
  const f = emptyFindings();
  assert.deepEqual(f.postedIds, []);
  assert.equal(f.backlog, null);
  assert.deepEqual(f.tiers, {});
  assert.equal(f.dryRunIsStatus, false, "an unreadable run must never look like a credential failure");
});

// ---- ROUND-24 F18: the pre-flight gate, and the echo that is not an output. ------------------------------------
// These fixtures are quoted from production, not written from belief -- and the first one is the reason. While
// auditing the gate on 2026-10-26 a substring search for the skip message hit SIX runs in a row; every one of them
// was a run that had NOT skipped. GitHub prints each command before running it, so the log carries the step's own
// SOURCE LINE, indented, and `messagesOf()` only trims the right. Anchoring at the start of the message is what
// separates "the tool said it" from "the script contains the words" -- the same soundness distinction the header
// comment of this file exists to enforce, arriving from a new direction.
const ECHOED_STEP_SOURCE = '  echo "preflight: window provably empty -> skipping install + compose + post"';
// The tool's own verdict line, verbatim from the raw job log of run 40303969337 at 2026-10-26T10:00:30Z.
const TOOL_VERDICT = "x-post-preflight: window provably empty (science cursor 2026-10-26T09:58:00.000Z, silent 3 min, no dev backlog)";
// The step's declaration that it honoured the verdict. NOT YET OBSERVED IN PRODUCTION -- the gate has proved a
// window empty exactly once (40303969337) and that attempt died on the 42 before writing skip=1 (F13). Built from
// the shipped YAML and pinned to it below, rather than asserted as a real capture.
const STEP_SKIP_DECLARED = "preflight: window provably empty -> skipping install + compose + post";

test("F18: GitHub's echo of the step's own source line is NOT read as a skip", () => {
  const f = analyseXpostLog(log(
    ECHOED_STEP_SOURCE,
    "posting item 1 (of up to 25) from out/posts/10-note.txt: The changelog now says preflight: window provably empty -> skipping install + compose + post in the docs.",
  ));
  assert.equal(f.preflightSkipped, false, "an indented echo of the script is not the tool speaking");
  assert.equal(f.preflightProvedEmpty, false, "and it is not the pre-flight's verdict either");
});

test("F18: the tool's verdict and the step's skip declaration are told apart", () => {
  const proved = analyseXpostLog(log(TOOL_VERDICT));
  assert.equal(proved.preflightProvedEmpty, true, "the real production line must be recognised");
  assert.equal(proved.preflightSkipped, false, "a verdict alone is not a skip -- 40303969337 proved the empty case and then FAILED");

  const skipped = analyseXpostLog(log(TOOL_VERDICT, STEP_SKIP_DECLARED));
  assert.equal(skipped.preflightSkipped, true);
  assert.equal(skipped.preflightProvedEmpty, true);
});

test("F18: a proved-empty window with no skip declared is reported as a discarded verdict", () => {
  const f = analyseXpostLog(log(TOOL_VERDICT));
  const problems = judgeFleet([row("40303969337", "2026-10-26T10:00:20Z", "failure", f)], Date.parse("2026-10-26T10:30:00Z"));
  assert.ok(problems.some((p) => /gate's verdict was discarded/.test(p)), problems.join(" | "));
});

test("F18: a proved-empty window that went on to POST is reported as a FALSE empty verdict", () => {
  // The direction that actually costs science: had the gate been honoured, this content would have been suppressed,
  // and because skipping never advances a cursor it would have stayed suppressed. Nothing else in the suite can see
  // this class, because from the composer's side everything looks fine.
  const f = analyseXpostLog(log(
    TOOL_VERDICT,
    "posting 1 composed item(s); runaway ceiling 25, delay 5s between posts",
    "posting item 1 (of up to 25) from out/posts/02-blind.txt: A blind sweep turned up 1 UNCONFIRMED candidate.",
    "x:post: OK posted (id 999).",
    "posted 1 item(s) this run",
  ));
  const problems = judgeFleet([row("1", "2026-10-26T10:00:20Z", "success", f)], Date.parse("2026-10-26T10:30:00Z"));
  assert.ok(problems.some((p) => /false "empty" verdict/.test(p)), problems.join(" | "));
});

test("F18: a window of clean skips does not fake a tier-coverage defect, and still reports real silence", () => {
  // Before this fix, a skipped run printed no `tier manifest:` line, so every quiet window -- precisely the ones
  // the gate now exists to skip -- read as "tier(s) with no post ... and no per-tier manifest line".
  const skipped = analyseXpostLog(log(TOOL_VERDICT, STEP_SKIP_DECLARED));
  const rows = [row("1", "2026-10-26T10:00:20Z", "success", skipped), row("2", "2026-10-26T10:30:20Z", "success", analyseXpostLog(log(TOOL_VERDICT, STEP_SKIP_DECLARED)))];
  const problems = judgeFleet(rows, Date.parse("2026-10-26T11:00:00Z"));
  assert.ok(!problems.some((p) => /no per-tier manifest line|never attempted/.test(p)), `skip must not fake a coverage defect: ${problems.join(" | ")}`);
  assert.ok(problems.some((p) => /the feed is silent/.test(p)), `an all-skip window must still be reported as silence: ${problems.join(" | ")}`);
});

test("F18: the two literals the parser anchors on are the ones the workflow actually prints", async () => {
  // The F2 lesson applied to log parsing: a detector written against a remembered string silently matches nothing
  // the day the producer's wording moves. Read the shipped YAML and require both forms to be present.
  const { readFileSync } = await import("node:fs");
  const yml = readFileSync(new URL("../.github/workflows/x-post.yml", import.meta.url), "utf8");
  assert.ok(yml.includes(STEP_SKIP_DECLARED), "the step no longer prints the skip line the parser anchors on");
  assert.ok(yml.includes("x-post-preflight.mjs"), "the step no longer runs the pre-flight the verdict line comes from");
});

