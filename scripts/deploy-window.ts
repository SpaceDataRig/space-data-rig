// DEPLOY WINDOW -- measure the production survey's real cadence and say whether NOW is safe to upload.
//
// WHY. The plan carried a belief that a survey pass takes about 45 minutes and leaves only seconds of gap, which
// makes every deploy feel like a gamble -- and a gamble people resolve two ways badly: uploading inside a live pass
// (the failure mode src/deploy/deployGuard.ts exists for: one pass narrated by two renderers while /health.gitSha can
// name only one) or waiting for the mythical narrow hole and leaving production stale longer. Both come from the same
// thing: an unmeasured number. This script measures it from the live rig and returns a verdict computed by
// src/deploy/deployWindow.ts -- the same pure module the tests pin, so the advice cannot be a different rule than the
// one CI checks.
//
// WHAT IT READS. /health for the running version and gitSha (so the operator sees how far behind HEAD the site is),
// /api/state for the claimed-run bookkeeping and every recorded finding timestamp. Nothing is asserted about the sky;
// this is an operational check, and it never gates, anchors or deploys anything itself.
//
// Exit codes follow the p8 live-probe convention, because "could not look" must never be reported as "not safe":
//   0 = GO (idle, and the gap ahead exceeds the upload budget)
//   1 = WAIT (a pass is live, or the remaining gap is too short)
//   2 = NET  (the rig could not be reached -- transient, not a finding)
//
// Usage:
//   npm run deploy:window                       # verdict + measured cadence, human-readable
//   npm run deploy:window -- --json out/dw.json # also write the machine-readable evidence
//   npm run deploy:window -- --budget 180       # seconds the upload is expected to need (default 120)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_WINDOW_POLICY, judgeWindow, measurePassSpans, median, type ActiveRunState, type WindowVerdict } from "../src/deploy/deployWindow.ts";

const SITE = process.env.RIG_SITE ?? "https://spacedatarig.app";
const argNum = (name: string, d: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const i = process.argv.indexOf(`--${name}`);
  const raw = hit ? hit.split("=")[1] : i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : String(d);
  const n = Number(raw);
  return Number.isFinite(n) ? n : d;
};

interface Health { ok?: boolean; deployVersion?: string; gitSha?: string }
interface StateBody { activeRun?: ActiveRunState | null; stats?: Record<string, number>; findings?: Array<{ createdAt?: string }> }

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Quote the measured cadence, or say plainly that the retained window holds too little to measure. */
function cadenceText(spans: ReturnType<typeof measurePassSpans>["spans"], gaps: number[]): string {
  const full = spans.filter((s) => s.rows >= 6);
  if (!full.length) return "no full pass (6+ rows) in the retained catalog -- cadence unknown, so judge the claim state alone";
  const spanMed = median(full.map((s) => s.spanSec));
  const gapMed = median(gaps.filter((g) => g > 0));
  return (
    `measured over ${spans.length} recorded passes: full-pass span median ${spanMed}s ` +
    `(min ${Math.min(...full.map((s) => s.spanSec))}s, max ${Math.max(...full.map((s) => s.spanSec))}s), ` +
    `median idle between passes ${gapMed}s`
  );
}

async function run(): Promise<number> {
  const policy = { ...DEFAULT_WINDOW_POLICY, uploadBudgetSec: argNum("budget", DEFAULT_WINDOW_POLICY.uploadBudgetSec) };
  let health: Health, state: StateBody;
  try {
    [health, state] = await Promise.all([getJSON<Health>(`${SITE}/health`), getJSON<StateBody>(`${SITE}/api/state`)]);
  } catch (e) {
    console.log(`NET: ${SITE} unreachable (${e instanceof Error ? e.message : String(e)}) -- unknown, NOT a verdict about the rig`);
    return 2;
  }

  const nowMs = Date.now();
  const active = state.activeRun ?? null;
  const verdict: WindowVerdict = judgeWindow(active, nowMs, policy);
  const { spans, idleGapsSec } = measurePassSpans((state.findings ?? []).map((f) => Date.parse(String(f.createdAt ?? ""))), policy);

  console.log(`site ${SITE}  version ${health.deployVersion ?? "?"}  gitSha ${health.gitSha ?? "?"}`);
  try {
    const { execFileSync } = await import("node:child_process");
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    if (head && health.gitSha && !String(health.gitSha).startsWith(head)) console.log(`HEAD ${head} is NOT what production runs (${String(health.gitSha).slice(0, 7)}) -- a deploy is owed`);
  } catch {
    /* not inside a git checkout: the comparison is a courtesy, not a check */
  }
  console.log(`activeRun: ${active ? `${active.runId ?? "?"} running=${active.running} started=${active.startedAt ?? "n/a"} finished=${active.finishedAt ?? "n/a"}` : "none published"}`);
  console.log(cadenceText(spans, idleGapsSec));
  if (verdict.nextClaimAtMs != null) {
    // The remaining time is shown whether or not the verdict calls it a usable gap: a WAIT still wants to say how
    // long the rig has before the next claim, and judgeWindow deliberately leaves usableSec null when busy.
    const remainSec = Math.round((verdict.nextClaimAtMs - nowMs) / 1000);
    console.log(`next cron claim boundary: ${new Date(verdict.nextClaimAtMs).toISOString()} (in ${remainSec}s, ${verdict.usableSec == null ? "not counted as usable" : `${verdict.usableSec}s usable`})`);
  }
  console.log(`VERDICT ${verdict.state}: ${verdict.reason}`);

  if (process.argv.includes("--json")) {
    const outPath = resolve(process.cwd(), "out", `deploy-window-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const explicit = process.argv.find((a) => a.startsWith("--json="))?.split("=")[1];
    const target = explicit ? resolve(process.cwd(), explicit) : outPath;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ site: SITE, checkedAtUtc: new Date(nowMs).toISOString(), health, activeRun: active, policy, verdict, cadence: { spans, idleGapsSec } }, null, 2) + "\n", "utf8");
    console.log(`evidence written: ${target}`);
  }
  return verdict.state === "GO" ? 0 : 1;
}

run().then((code) => process.exit(code)).catch((e) => {
  console.error("deploy-window failed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
