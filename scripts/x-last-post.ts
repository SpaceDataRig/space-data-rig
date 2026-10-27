// X LAST-POST (read): print TWO cursors from the authenticated account's recent tweets so the hourly x-post
// workflow can (a) tell how long the channel has actually been silent -- counting human posts too, since those are
// visible on the feed and mean the channel is not really quiet -- and (b) give the BUILD NOTE tier its own commit
// window. This is the read counterpart of scripts/post-x-text.ts and shares its rules: credentials come ONLY from
// the four X_API_* env vars (never hardcoded, never logged); with none present it makes NO network call and exits
// non-zero, so the workflow simply skips the heartbeat. Uses X API v2 user context (OAuth 1.0a): GET /2/users/me ->
// id, then GET /2/users/:id/tweets?max_results=100&tweet.fields=created_at,text.
// (v2 requires max_results in [5,100]; 1 is rejected with HTTP 400, so we ask for the smallest legal page and keep
// the latest timestamp rather than assuming a single-row request.) Errors go to stderr; stdout carries only the two
// labelled timestamps.
//
// WHY TWO CURSORS, NOT ONE (audit-6 follow-up). Both tiers used to share a single window start anchored to the
// newest tweet of ANY kind. That is correct for the science tier (a result must not be re-reported) but fatal for
// the dev tier: the build note is composed ONLY when a window has no science, so every science post moved the
// cursor past commits the dev tier had never reported, and they were dropped permanently. Observed in production:
// a run that posted 3 new UNCONFIRMED candidates consumed two fix commits; the build note that did go out covered
// 1 of the 5 commits in that push. Splitting the cursors makes the dev window self-healing the way the science
// window already was. Recognising a build note requires the tweet TEXT, hence `text` in tweet.fields and the
// larger page (a note is rare, so 5 tweets rarely reach back far enough).
import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { BUILD_NOTE_HEADLINES, HEARTBEAT_HEADLINE } from "./science-digest.ts";

type JsonObject = Record<string, unknown>;

function penv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}
const env = penv();
const API_KEY = env.X_API_KEY || "";
const API_SECRET = env.X_API_SECRET || "";
const TOKEN = env.X_ACCESS_TOKEN || "";
const TOKEN_SECRET = env.X_ACCESS_TOKEN_SECRET || "";
const API = "https://api.twitter.com";

// RFC-3986 percent-encoding (encodeURIComponent plus the marks OAuth still escapes).
export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// The query for the user-tweets read, kept pure so a test can pin its shape. v2 rejects max_results outside
// [5,100] with HTTP 400, so we request a legal page rather than 1 -- and then take the newest timestamp from the
// page (see newestCreatedAt). This exact parameter was the bug that broke the read in prod.
//
// max_results is the legal MAXIMUM and tweet.fields includes `text` because the dev-tier cursor has to find the
// newest BUILD NOTE, and build notes are rare: a 5-tweet page covers well under an hour of this feed and would
// almost never contain one, silently degrading the dev window back to the shared cursor.
export function tweetsQuery(): Record<string, string> {
  return { max_results: "100", "tweet.fields": "created_at,text" };
}

// Pull the authenticated user id out of a GET /2/users/me payload ({} -> ""), so the caller's shape assumption is
// one testable predicate rather than an inline cast.
export function userIdFromMe(me: { data?: { id?: string } } | null | undefined): string {
  return me?.data?.id ?? "";
}

// Newest created_at among the returned rows. v2 returns reverse-chronological, but we pick the max explicitly
// (ISO 8601 stamps sort lexicographically) so the silence gap is measured from the truly most-recent tweet no
// matter the page order. Empty / absent input -> "" (the caller then treats the read as unavailable).
export function newestCreatedAt(rows: Array<{ created_at?: string; [k: string]: unknown }> | null | undefined): string {
  return (rows ?? []).map((r) => r?.created_at).filter((x): x is string => !!x).sort().reverse()[0] ?? "";
}

// Is this tweet one of ours from the BUILD NOTE tier? Membership is tested against BUILD_NOTE_HEADLINES -- the
// list composeDigest rotates through with pick() -- rather than a single hardcoded string, so rewording the
// headline in one place cannot quietly stop the dev cursor from finding its own posts. Whitespace is normalised
// first because a long-form post's first line may be preceded or followed by stray spacing.
export function isBuildNoteText(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return BUILD_NOTE_HEADLINES.some((h) => t.startsWith(h.replace(/\s+/g, " ").trim()));
}

// Newest created_at among the returned rows that ARE build notes; "" when the page holds none (the workflow then
// falls back to a bounded look-back rather than to the science cursor, so the dev backlog is still recoverable).
export function newestBuildNoteAt(
  rows: Array<{ created_at?: string; text?: string; [k: string]: unknown }> | null | undefined,
): string {
  return (rows ?? [])
    .filter((r) => isBuildNoteText(r?.text))
    .map((r) => r?.created_at)
    .filter((x): x is string => !!x)
    .sort()
    .reverse()[0] ?? "";
}

// Is this tweet the silence heartbeat? Identified by its opening line, exported from science-digest.ts as the single
// place that composes it -- same reasoning as the build-note matcher.
export function isHeartbeatText(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return t.startsWith(HEARTBEAT_HEADLINE.replace(/\s+/g, " ").trim());
}

// Newest created_at among rows that are NEITHER a build note NOR a heartbeat -- i.e. the newest post that actually
// reported science (or one an operator authored). This is the SCIENCE cursor, and it must skip the other two:
//
//   A run now posts SEVERAL items (science tiers + one build note per commit batch). The science window is anchored
//   to the newest tweet of any kind, so a build note posted ten seconds AFTER the science data was fetched pushed
//   the cursor past that fetch time -- anything created in between fell outside the next window and was never
//   reported. Same defect class as the starved build-note tier, one level up. Heartbeats are excluded for the same
//   reason: a heartbeat fires precisely when the science tier found nothing, so advancing the cursor on one can only
//   drop results.
//
// "" when the page holds no such post; the caller then falls back to newestCreatedAt (a wider window is safe -- it
// re-reports nothing, because the science tiers filter on record timestamps, and it drops nothing).
export function newestScienceAt(
  rows: Array<{ created_at?: string; text?: string; [k: string]: unknown }> | null | undefined,
): string {
  return (rows ?? [])
    .filter((r) => !isBuildNoteText(r?.text) && !isHeartbeatText(r?.text))
    .map((r) => r?.created_at)
    .filter((x): x is string => !!x)
    .sort()
    .reverse()[0] ?? "";
}

// The bullet subjects the account has ALREADY announced, lifted back off its own build notes. One per line, exactly
// as posted (a bullet is `sanitizeSubject(subject)` verbatim, so composeDigest can de-duplicate by string equality).
// This is what lets the dev window OVERLAP its cursor by a few minutes -- recovering a commit that lands mid-run --
// without repeating a bullet that is already on the timeline.
export function reportedSubjects(
  rows: Array<{ created_at?: string; text?: string; [k: string]: unknown }> | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (!isBuildNoteText(r?.text)) continue;
    for (const line of String(r?.text ?? "").split("\n")) {
      const t = line.replace(/\s+/g, " ").trim();
      if (!t.startsWith("- ")) continue;
      const body = t.slice(2).trim();
      // The note's own trailing lines are bullets too ("- Repository (code + history): ..."), but they are never
      // commit subjects and can never equal one, so leaving them in is harmless -- and filtering them by URL would
      // be a guess. Kept verbatim: the consumer only tests membership.
      if (body) out.add(body);
    }
  }
  return [...out];
}

async function signedGet(path: string, query: Record<string, string>): Promise<JsonObject> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: TOKEN,
    oauth_version: "1.0",
  };
  // OAuth1 signs the url plus ALL request parameters (oauth_* AND the query string), sorted and percent-encoded.
  const all: Record<string, string> = { ...oauth, ...query };
  const norm = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join("&");
  const url = `${API}${path}`;
  const base = `GET&${pct(url)}&${pct(norm)}`;
  const signingKey = `${pct(API_SECRET)}&${pct(TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const authz = "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
  const qs = Object.keys(query).length ? "?" + Object.keys(query).map((k) => `${pct(k)}=${pct(query[k])}`).join("&") : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url + qs, { method: "GET", signal: controller.signal, headers: { authorization: authz, accept: "application/json" } });
    const j = (await r.json().catch(() => null)) as JsonObject | null;
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    return j ?? {};
  } finally {
    clearTimeout(timer);
  }
}

// Minimal --name value / --name=value reader (same contract as science-digest.ts's arg), so `--reported-out` can be
// passed through `npm run x:lastpost -- --reported-out <path>`.
function arg(name: string, dflt = ""): string {
  const argv = process.argv;
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

async function main(): Promise<void> {
  if (!API_KEY || !API_SECRET || !TOKEN || !TOKEN_SECRET) {
    console.error("x-last-post: no X credentials in the environment; read is inert (the workflow will skip the heartbeat).");
    process.exitCode = 1;
    return;
  }
  const me = await signedGet("/2/users/me", {});
  const uid = userIdFromMe(me as { data?: { id?: string } });
  if (!uid) {
    console.error("x-last-post: /2/users/me returned no id.");
    process.exitCode = 1;
    return;
  }
  const tw = await signedGet(`/2/users/${uid}/tweets`, tweetsQuery());
  const rows = tw.data as Array<{ created_at?: string; text?: string }> | undefined;
  const created = newestCreatedAt(rows);
  if (!created) {
    console.error("x-last-post: no tweets found (the account has posted nothing yet).");
    process.exitCode = 1;
    return;
  }
  const buildNote = newestBuildNoteAt(rows);
  if (!buildNote) {
    console.error(
      "x-last-post: no build note among the newest tweets read; the dev tier will use its bounded look-back.",
    );
  }
  const science = newestScienceAt(rows);
  if (!science) {
    console.error(
      "x-last-post: no science post among the newest tweets read; the science window falls back to the newest tweet of any kind.",
    );
  }
  // Optional side output: the subjects already announced on the feed, one per line. The workflow feeds this back to
  // science-digest (--already-reported-file) so the dev window can overlap its cursor without repeating a bullet.
  // A write failure is NOT fatal -- de-duplication simply stays off, and the overlap is minutes wide.
  const reportedOut = arg("reported-out", "");
  if (reportedOut) {
    const subjects = reportedSubjects(rows);
    try {
      const d = dirname(reportedOut);
      if (d && d !== ".") mkdirSync(d, { recursive: true });
      writeFileSync(reportedOut, subjects.length ? `${subjects.join("\n")}\n` : "", "utf8");
      console.error(`x-last-post: wrote ${subjects.length} already-reported subject(s) to ${reportedOut}`);
    } catch (e) {
      console.error(
        `x-last-post: could not write ${reportedOut} (${e instanceof Error ? e.message : String(e)}); de-duplication off this run.`,
      );
    }
  }
  // Labelled, one per line. Two cursors must not share a bare-timestamp stream: the workflow used to pull the ISO
  // with `grep -Eo <ISO> | tail -1`, which would silently hand the DEV tier's time to the science window (or the
  // reverse) once a second timestamp appeared. An empty value is still printed so the consumer can distinguish
  // "read succeeded, no build note yet" from "read failed".
  console.log(`last_post=${created}`);
  console.log(`last_build_note=${buildNote}`);
  console.log(`last_science=${science}`);
}

// Side-effect guard (same contract as science-digest.ts): run only when invoked directly, never on import, so an
// offline `npm test` can never trigger a network read.
const invokedDirectly = /x-last-post(\.ts)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`x-last-post: failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
