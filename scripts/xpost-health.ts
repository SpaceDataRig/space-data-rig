// Audit the X posting channel from its job LOGS, not from run conclusions.
//
// WHY this exists: a run can be completed/success while posting nothing, and a run can be completed/failure
// because the honesty guard refused text -- neither of which the conclusion field distinguishes. The operator's
// standing question is "is every tier still reaching the feed, and is anything stuck or piling up", and that is
// only answerable from the decisive lines the workflow echoes.
//
// THE LESSON THIS FILE IS BUILT AROUND: signals must be anchored to the tool's own status prefix, because the
// audited content can forge them. A first version of this audit reported "DRY RUN in production -- credentials
// missing" for a run that had in fact posted successfully: the summary it pushed happened to contain the words
// "prints DRY RUN", and the workflow echoes the whole post body into the log. Any unanchored substring search
// over a job log is therefore unsound. Patterns here are whole-message matches, and a status that contradicts a
// confirmed post is reported as content rather than as a fault.
//
// Usage:
//   npx tsx scripts/xpost-health.ts [--runs N] [--hours H] [--json]
// Reads the GitHub credential from the git credential helper, in memory. It is never printed.

export type TierCounts = Record<string, number>;

export type RunFindings = {
  postedIds: string[];
  refused: number;
  dryRunLines: number;
  /** DRY RUN is only a fault when nothing was posted. With a posted item present the phrase is post body. */
  dryRunIsStatus: boolean;
  override: boolean;
  tiers: TierCounts;
  selfReported: number | null;
  queued: number | null;
  backlog: number | null;
  batchesComposed: number | null;
  alreadyReported: number | null;
  droppedSubjects: Array<{ reason: string; subject: string }>;
  loopAborted: boolean;
  ceilingReached: boolean;
  byteIdenticalSkips: number;
  silentMin: number | null;
  xReadUnavailable: boolean;
  stepExitFailure: boolean;
  /** The pre-flight TOOL printed its emptiness verdict. Real production text, quoted from run 40303969337. */
  preflightProvedEmpty: boolean;
  /** The pre-flight STEP declared the skip and stopped the job cleanly. Absent means the verdict was discarded. */
  preflightSkipped: boolean;
  scienceCursor: string;
  buildNoteCursor: string;
  digestWindowSince: string;
  /** Which tiers the run ATTEMPTED to compose, from the per-tier manifest line. Empty when the run predates it. */
  tiersAttempted: Record<string, boolean>;
};

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\+?\d*\s+/;

/**
 * npm's wrapper prints a child tool's stderr as `<script-id> stderr: <line>`, so the tool's own status line is
 * NOT at the start of the log line. Verified against the raw job log of run 39102486326:
 * `...Z x:lastpost stderr: x-last-post: wrote 15 already-reported subject(s) to out/reported-subjects.txt`.
 * Anchored literally (`/^x-last-post: wrote/`), that line never matched, `alreadyReported` stayed null, and the
 * backlog rule that needs it could therefore never fire in EITHER direction -- an auditor reporting "no stall" and
 * "not a stall" for the same reason: it was measuring nothing. The fixture did not catch it because the fixture
 * was written from what I believed the log said instead of from a log.
 */
const RUNNER_PREFIX = /^[A-Za-z0-9_.:-]+ (?:stderr|stdout): /;

/** Strip ANSI, then the runner's per-line timestamp and stream decoration, leaving what the tool itself printed. */
function messagesOf(log: string): string[] {
  return log
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(TS, "").replace(RUNNER_PREFIX, "").trimEnd());
}

function intAfter(msg: string, prefix: string): number | null {
  if (!msg.startsWith(prefix)) return null;
  const rest = msg.slice(prefix.length);
  const m = /^(\d+)/.exec(rest);
  return m ? Number(m[1]) : null;
}

/** Everything this channel did in one run, read only from lines the tools themselves printed. */
export function analyseXpostLog(log: string): RunFindings {
  const f: RunFindings = {
    postedIds: [],
    refused: 0,
    dryRunLines: 0,
    dryRunIsStatus: false,
    override: false,
    tiers: {},
    selfReported: null,
    queued: null,
    backlog: null,
    batchesComposed: null,
    alreadyReported: null,
    droppedSubjects: [],
    loopAborted: false,
    ceilingReached: false,
    byteIdenticalSkips: 0,
    silentMin: null,
    xReadUnavailable: false,
    stepExitFailure: false,
    preflightProvedEmpty: false,
    preflightSkipped: false,
    scienceCursor: "",
    buildNoteCursor: "",
    digestWindowSince: "",
    tiersAttempted: {},
  };

  for (const msg of messagesOf(log)) {
    // Anchored: `x:post:` is the prefix scripts/post-x-text.ts prints for its own verdict and nothing else does.
    const ok = /^x:post: OK posted \(id (\d+)\)/.exec(msg);
    if (ok) f.postedIds.push(ok[1]);
    if (/^x:post: REFUSED\b/.test(msg)) f.refused++;
    if (/^x:post: DRY RUN\b/.test(msg)) f.dryRunLines++;

    // Tier attribution comes from the composed filename, whose numeric prefix IS the post order.
    const item = /^posting item \d+ \(of up to \d+\) from out\/posts\/\d+-([a-z]+)\.txt/.exec(msg);
    if (item) f.tiers[item[1]] = (f.tiers[item[1]] || 0) + 1;
    if (/^posting override \(maxlen=/.test(msg)) f.override = true;

    const queued = intAfter(msg, "posting ");
    if (queued !== null && msg.includes("composed item(s)")) f.queued = queued;
    const self = intAfter(msg, "posted ");
    if (self !== null && msg.includes("item(s) this run")) f.selfReported = self;
    const backlog = intAfter(msg, "build-note backlog: ");
    if (backlog !== null) f.backlog = backlog;
    const batches = intAfter(msg, "build note: composed ");
    if (batches !== null) f.batchesComposed = batches;
    const already = /^x-last-post: wrote (\d+) already-reported subject\(s\) to \S+/.exec(msg);
    if (already) f.alreadyReported = Number(already[1]);
    const silent = intAfter(msg, "nothing composed; channel silent ");
    if (silent !== null) f.silentMin = silent;

    // The diagnostics here are prefixed with the tool that printed them, so the anchor must include it -- the
    // same class of miss as `x-last-post: wrote ...` above. The reason itself can contain ')', so match greedily
    // up to the last '): ' separator rather than the first closing paren.
    const drop = /^science-digest: dropping commit subject \((.*)\): (.*)$/.exec(msg);
    if (drop) f.droppedSubjects.push({ reason: drop[1], subject: drop[2] });
    if (/^##\[error\]x:post failed on \S+; stopping the loop/.test(msg)) f.loopAborted = true;
    if (/^##\[warning\]runaway ceiling reached/.test(msg)) f.ceilingReached = true;
    if (/^skip out\/posts\/\S+: byte-identical to an item already posted/.test(msg)) f.byteIdenticalSkips++;
    if (/^nothing composed; could not read last-post time/.test(msg)) f.xReadUnavailable = true;
    if (/^##\[error\]Process completed with exit code/.test(msg)) f.stepExitFailure = true;

    // ROUND-24 F18: the pre-flight gate. Both anchors are START-ANCHORED on purpose, and this is the second time
    // that distinction has bitten this file. Scanning production for the round-24 audit, a substring search for
    // `preflight: window provably empty -> skipping` matched SIX runs -- every one of them a run that had NOT
    // skipped. GitHub echoes each command line before executing it, so the log contains the step's own SOURCE,
    // indented (`  echo "preflight: ..."`), and messagesOf() only trims the right-hand side. Same class as the
    // post-body problem in the header comment, arriving from a different direction: the log carries text the tool
    // never printed. An unanchored match here would read every run as skipped and the auditor would be blind in
    // the comfortable, green, says-nothing-wrong way.
    if (/^x-post-preflight: window provably empty/.test(msg)) f.preflightProvedEmpty = true;
    if (/^preflight: window provably empty -> skipping/.test(msg)) f.preflightSkipped = true;

    const sci = /^digest window since: (\S+)(?: \(science cursor: ([^;)]*))?/.exec(msg);
    if (sci) {
      f.digestWindowSince = sci[1];
      f.scienceCursor = sci[2] ? sci[2].replace(/^:\s*/, "").trim() : "";
    }
    const dev = /^build-note cursor: dev window since (\S+) \(last build note: ([^,]+),/.exec(msg);
    if (dev) f.buildNoteCursor = dev[2].trim();

    // `tier manifest: ledger [1 file(s) 337 byte(s)] blind [not-attempted] ...` -- the line that separates "this
    // tier had nothing honest to say" from "this tier was never run", which no log line did before.
    const tm = /^tier manifest: (.*)$/.exec(msg);
    if (tm) {
      for (const m of tm[1].matchAll(/([a-z-]+) \[([^\]]*)\]/g)) {
        // Anything other than `not-attempted` means the compose step ran and produced a file, even a zero-byte
        // one. Whether it had anything to say is a separate question, answered by the per-tier post counters.
        f.tiersAttempted[m[1]] = m[2].trim() !== "not-attempted";
      }
    }
  }

  f.dryRunIsStatus = f.dryRunLines > 0 && f.postedIds.length === 0;
  return f;
}

export type RunRow = { id: string; createdAt: string; conclusion: string; event: string; headSha: string; f: RunFindings };

/**
 * Fleet-level findings across a window of runs. Returns human-readable problems; empty means the channel is
 * demonstrably alive AND draining, which is a stronger claim than "no run failed".
 */
export function judgeFleet(rows: RunRow[], nowMs: number, opts: { staleAfterMin?: number } = {}): string[] {
  const staleAfterMin = opts.staleAfterMin ?? 90;
  const out: string[] = [];
  const done = rows.filter((r) => r.conclusion !== "" && r.conclusion !== "in_progress" && r.conclusion !== "queued");
  if (done.length === 0) return [`no completed runs in the window: the trigger itself is not firing`];

  const postedRuns = done.filter((r) => r.f.postedIds.length > 0);
  const totalPosts = postedRuns.reduce((n, r) => n + r.f.postedIds.length, 0);
  if (totalPosts === 0) out.push(`zero posts across ${done.length} completed runs: the feed is silent`);

  // Liveness, measured against the newest run rather than the newest post: a quiet window with nothing to report
  // is correct behaviour, so silence alone must not be reported as a stall.
  const newest = done.reduce((a, r) => (new Date(r.createdAt).getTime() > new Date(a.createdAt).getTime() ? r : a), done[0]);
  const ageMin = Math.round((nowMs - new Date(newest.createdAt).getTime()) / 60000);
  if (ageMin > staleAfterMin) out.push(`no run in ${ageMin} min (newest ${newest.id} at ${newest.createdAt}): the dispatch wake is not firing`);

  for (const r of done) {
    if (r.f.refused > 0) out.push(`run ${r.id}: REFUSED ${r.f.refused} item(s) -- lost work, the cursor did not advance past it`);
    if (r.f.dryRunIsStatus) out.push(`run ${r.id}: DRY RUN with nothing posted -- the X credentials are missing on the runner`);
    if (r.f.loopAborted) out.push(`run ${r.id}: the posting loop aborted on a failed post`);
    if (r.f.ceilingReached) out.push(`run ${r.id}: runaway ceiling reached, remainder deferred to the next window`);
    if (r.f.xReadUnavailable) out.push(`run ${r.id}: the feed could not be read, so every cursor fell back and no heartbeat was possible`);
    // ROUND-24 F18, the two directions a working gate can be wrong in, read off the one window where BOTH the
    // gate and the composer left a trace:
    //  - proved empty yet the run went on to POST: the gate's emptiness verdict was false, and had it been
    //    honoured this content would have been suppressed for good (skipping never advances a cursor). This is the
    //    finding the whole gate class needs a tripwire for, and it is not the same finding as the next one.
    //  - proved empty and nothing posted, but no skip declaration either: the verdict was discarded, so the saving
    //    is gone. This is exactly what run 40303969337 looked like -- `bash -e` killed the step on the 42 before
    //    `skip=1` could be written, and the job went red.
    if (r.f.preflightProvedEmpty && r.f.postedIds.length > 0) {
      out.push(
        `run ${r.id}: the pre-flight called the window empty and the composer posted ${r.f.postedIds.length} item(s) from it ` +
          `-- a false "empty" verdict; had the gate been honoured this content would have been suppressed`,
      );
    } else if (r.f.preflightProvedEmpty && !r.f.preflightSkipped) {
      out.push(`run ${r.id}: the pre-flight proved the window empty but no skip was declared -- the gate's verdict was discarded`);
    }
    if (r.conclusion !== "success") {
      // A failed run that posted nothing AND never reached a status line is a shell abort: invisible to any
      // check that only looks for refusals.
      const where = r.f.stepExitFailure ? "the step exited non-zero" : "no decisive error line found";
      out.push(`run ${r.id}: conclusion=${r.conclusion || "?"} (${where}) with ${r.f.postedIds.length} posted`);
    }
    // The workflow counts its own posts; if that disagrees with the number of confirmed sends, one of the two is
    // lying and every conclusion drawn from the logs is unsafe.
    if (r.f.selfReported !== null && r.f.selfReported !== r.f.postedIds.length) {
      out.push(`run ${r.id}: self-reported ${r.f.selfReported} posted but ${r.f.postedIds.length} confirmed sends -- the counters disagree`);
    }
    if (r.f.queued !== null && r.f.queued > 0 && r.f.postedIds.length === 0 && !r.f.override) {
      out.push(`run ${r.id}: ${r.f.queued} item(s) composed, none posted`);
    }
  }

  // Backlog: `build-note backlog: N` counts commit SUBJECTS IN THE WINDOW, which includes ones the feed has
  // already announced -- composeDigest subtracts those later, so a large N is not by itself a stall. The sound
  // statement is the residual: if N exceeds the count of subjects read back off the feed, at least N-minus-that
  // are genuinely unannounced, and a run that posted no build note while holding them is leaving work behind.
  // `newest` is the same run the liveness check above already identified.
  const nb = newest.f.backlog;
  if (nb !== null && nb > 0 && newest.f.alreadyReported !== null && !(newest.f.tiers["note"] || 0)) {
    const residual = nb - newest.f.alreadyReported;
    if (residual > 0) {
      out.push(`build-note backlog: ${nb} subject(s) in the window, only ${newest.f.alreadyReported} matched as already announced, so at least ${residual} are unreported and no build note went out in run ${newest.id}`);
    }
  }

  // Tier coverage. A tier that never POSTED is normal when no such event occurred; what must not be normal is
  // being unable to tell "nothing to report" apart from "never tried". The per-tier manifest line answers that,
  // so its absence is itself the finding, and a tier the manifest says was not attempted is a hard one.
  //
  // OVERRIDE runs are excluded: an authored dispatch posts its text and `exit 0`s before any tier is composed, so
  // a window of overrides legitimately contains no tier activity at all, and flagging it would be a false alarm.
  // SKIPPED runs are excluded for the same reason (round-24 F18): the gate stopped the job before the compose step,
  // so it prints no manifest line by design. That exclusion is safe against a stuck-open gate because the silence
  // rule above counts posts across ALL completed runs, skipped ones included -- a window of nothing but skips
  // still reads "zero posts across N completed runs: the feed is silent".
  const normal = done.filter((r) => !r.f.override && !r.f.preflightSkipped);
  const tierSeen = new Set<string>();
  const attemptedSeen = new Set<string>();
  let anyManifest = false;
  for (const r of normal) {
    for (const t of Object.keys(r.f.tiers)) tierSeen.add(t);
    for (const [t, ok] of Object.entries(r.f.tiersAttempted)) {
      anyManifest = true;
      if (ok) attemptedSeen.add(t);
    }
  }
  const expected = ["ledger", "blind", "milestone", "note", "heartbeat"];
  // HEARTBEAT IS A FALLBACK, NOT A SCHEDULE. The workflow reaches the silence watchdog only when no other tier
  // composed anything, so in a window where a build note or a candidate did go out, `heartbeat [not-attempted]`
  // is the designed outcome and the previous release of this rule reported it as a defect -- found by running the
  // auditor against a real production run instead of only against fixtures. It stays a finding when nothing at all
  // was composed anywhere in the window, which is the case where the watchdog genuinely should have fired.
  const otherActivity = normal.some((r) => Object.entries(r.f.tiers).some(([t, n]) => t !== "heartbeat" && n > 0));
  const accountable = otherActivity ? expected.filter((t) => t !== "heartbeat") : expected;
  const neverPostedReal = accountable.filter((t) => !tierSeen.has(t));
  if (normal.length > 0 && neverPostedReal.length > 0 && !anyManifest) {
    out.push(`tier(s) with no post across ${normal.length} regular run(s): ${neverPostedReal.join(", ")} -- and no per-tier manifest line exists, so this audit cannot tell "nothing to report" from "never attempted"`);
  } else if (normal.length > 0 && neverPostedReal.length > 0) {
    const unattempted = neverPostedReal.filter((t) => !attemptedSeen.has(t));
    if (unattempted.length > 0) {
      out.push(`tier(s) never attempted in any regular run of the window: ${unattempted.join(", ")} -- the manifest says they were not even composed`);
    }
  }
  return out;
}

export function formatRow(r: RunRow): string {
  const f = r.f;
  const tiers = Object.entries(f.tiers).map(([k, v]) => `${k}=${v}`).join(",") || "-";
  return [
    r.id,
    r.createdAt,
    r.event,
    String(r.conclusion).padEnd(8),
    `posted=${f.postedIds.length}`,
    `queued=${f.queued ?? "-"}`,
    `backlog=${f.backlog ?? "-"}`,
    `tiers=${tiers}`,
    `alreadyReported=${f.alreadyReported ?? "-"}`,
    `dropped=${f.droppedSubjects.length}`,
    f.override ? "OVERRIDE" : "",
    f.preflightSkipped ? "SKIP" : f.preflightProvedEmpty ? "EMPTY-NOT-SKIPPED" : "",
    f.refused ? `REFUSED=${f.refused}` : "",
    f.dryRunIsStatus ? "DRYRUN-STATUS" : "",
    f.loopAborted ? "LOOP-ABORT" : "",
    f.xReadUnavailable ? "XREAD-DOWN" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A findings object for a run whose log could not be read, so the row still appears in the table instead of
 *  the run silently vanishing from the window it claims to cover. */
export function emptyFindings(): RunFindings {
  return analyseXpostLog("");
}

// ---- I/O --------------------------------------------------------------------------------
// Everything below touches the network, and it runs only when this file is executed directly, so importing the
// pure analysis above from tests/xpost-health.test.ts never leaves the machine.
import { spawnSync } from "node:child_process";

const OWNER = "SpaceDataRig";
const REPO = "space-data-rig";

/** The in-memory git credential, the same one used to push. Never printed; scrubbed from every output line. */
function gitCredential(): string {
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    timeout: 30000,
  });
  const m = /^password=(.+)$/m.exec(String(r.stdout || "") + String(r.stderr || ""));
  return m ? m[1].trim() : "";
}

function argNum(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = hit ? hit.slice(name.length + 3) : process.argv[process.argv.indexOf(`--${name}`) + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function get(url: string, headers: Record<string, string>, tries = 3): Promise<{ status: number; text: string; json: unknown } | { err: string }> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) {
        const text = await r.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return { status: r.status, text, json };
      }
      last = `HTTP ${r.status}`;
      if (r.status === 404) return { status: 404, text: "", json: null };
      // Back off on a rate limit instead of burning the remaining tries in milliseconds.
      await new Promise((res) => setTimeout(res, (r.status === 403 || r.status === 429 ? 6000 : 1200) * (i + 1)));
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
    }
  }
  return { err: last || "fetch failed" };
}

/** Concatenated job log for a run, or null when it could not be read at all. */
async function runLog(runId: string, headers: Record<string, string>): Promise<{ log: string } | { err: string }> {
  const jobs = await get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`, headers);
  if ("err" in jobs || !jobs.json) return { err: "err" in jobs ? jobs.err : `jobs HTTP ${jobs.status}` };
  const list = (jobs.json as { jobs?: Array<{ id: number }> }).jobs || [];
  if (list.length === 0) return { err: "the run has no jobs" };
  let text = "";
  const errs: string[] = [];
  for (const job of list) {
    const lr = await get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/jobs/${job.id}/logs`, headers);
    if ("err" in lr || !lr.text) errs.push("err" in lr ? lr.err : `job ${job.id} HTTP ${lr.status}`);
    else text += lr.text + "\n";
  }
  if (!text) return { err: errs.join("; ") || "no readable job log" };
  return { log: text };
}

type RunRecord = { id: number; created_at: string; status: string; conclusion: string | null; event: string; head_sha: string };

async function main(): Promise<void> {
  const token = gitCredential();
  if (!token) {
    console.error("xpost-health: NO_CREDENTIAL the git credential helper returned nothing, so the audit cannot read the runs");
    process.exitCode = 2;
    return;
  }
  const headers = { "User-Agent": "Mozilla/5.0", Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
  const redact = (s: string) => s.split(token).join("[REDACTED]");

  const wantRuns = argNum("runs", 60);
  const hours = argNum("hours", 24);
  const asJson = process.argv.includes("--json");

  const listRes = await get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/x-post.yml/runs?per_page=${wantRuns}`, headers);
  if ("err" in listRes || !listRes.json) {
    // "Could not look" must never be printed as "nothing wrong found", so this is its own exit status.
    console.error("xpost-health: CANNOT_AUDIT the run list itself could not be read: " + redact("err" in listRes ? listRes.err : `HTTP ${listRes.status}`));
    process.exitCode = 4;
    return;
  }
  const all = ((listRes.json as { workflow_runs?: RunRecord[] }).workflow_runs || []).slice().reverse();
  const cutoff = Date.now() - hours * 3600 * 1000;
  const inWindow = all.filter((r) => new Date(r.created_at).getTime() >= cutoff);

  const rows: RunRow[] = [];
  const unreadable: string[] = [];
  for (const r of inWindow) {
    let f = emptyFindings();
    if (r.status === "completed") {
      const lr = await runLog(String(r.id), headers);
      if ("err" in lr) unreadable.push(`run ${r.id} ${r.created_at}: ${lr.err}`);
      else f = analyseXpostLog(lr.log);
    } else {
      unreadable.push(`run ${r.id} ${r.created_at}: still ${r.status}, no final log`);
    }
    rows.push({ id: String(r.id), createdAt: r.created_at, conclusion: r.conclusion || "", event: r.event, headSha: r.head_sha, f });
  }

  const tierTotals: TierCounts = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.f.tiers)) tierTotals[k] = (tierTotals[k] || 0) + v;
  const totalPosts = rows.reduce((n, r) => n + r.f.postedIds.length, 0);
  const backlogs = rows.filter((r) => r.f.backlog !== null).map((r) => `${r.createdAt}=${String(r.f.backlog)}`);

  const problems = judgeFleet(rows, Date.now());
  if (unreadable.length > 0) problems.push(`${unreadable.length} run(s) had no readable log: the verdict covers only the ${rows.length - unreadable.length} that did`);

  if (asJson) {
    console.log(JSON.stringify({ window: { hours, fetched: all.length, inWindow: rows.length }, totalPosts, tierTotals, backlogs, unreadable, problems, rows }, null, 2).split(token).join("[REDACTED]"));
  } else {
    console.log(`x-post runs in the last ${hours}h: ${rows.length} (of ${all.length} fetched)`);
    console.log("");
    console.log("--- per run, oldest first ---");
    for (const r of rows) console.log("  " + redact(formatRow(r)));
    console.log("");
    console.log(`total confirmed posts: ${totalPosts}`);
    console.log(`posts by tier: ${Object.entries(tierTotals).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
    console.log(`build-note backlog over the window: ${backlogs.slice(-12).join(" ") || "(never reported)"}`);
    console.log("");
    console.log("--- runs without a readable log ---");
    if (unreadable.length === 0) console.log("  (all read)");
    for (const u of unreadable) console.log("  ? " + redact(u));
    console.log("");
    console.log("--- verdict ---");
    if (problems.length === 0) console.log("POSTING_HEALTHY");
    else {
      console.log(`POSTING_FINDINGS (${problems.length})`);
      for (const p of problems) console.log("  ! " + redact(p));
    }
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}

const invokedDirectly = /xpost-health(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`xpost-health: fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  });
}
