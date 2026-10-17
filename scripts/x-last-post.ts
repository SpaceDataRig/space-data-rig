// X LAST-POST (read): print the authenticated account's MOST RECENT tweet timestamp (ISO 8601) to stdout, so the
// half-hourly x-post workflow can tell how long the channel has actually been silent -- counting human posts too,
// since those are visible on the feed and mean the channel is not really quiet. This is the read counterpart of
// scripts/post-x-text.ts and shares its rules: credentials come ONLY from the four X_API_* env vars (never
// hardcoded, never logged); with none present it makes NO network call and exits non-zero, so the workflow simply
// skips the heartbeat. Uses X API v2 user context (OAuth 1.0a): GET /2/users/me -> id, then
// GET /2/users/:id/tweets?max_results=5&tweet.fields=created_at -> the newest created_at among the page returned.
// (v2 requires max_results in [5,100]; 1 is rejected with HTTP 400, so we ask for the smallest legal page and keep
// the latest timestamp rather than assuming a single-row request.) Errors go to stderr; stdout carries only the ISO.
import { createHmac, randomBytes } from "node:crypto";

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
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
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

async function main(): Promise<void> {
  if (!API_KEY || !API_SECRET || !TOKEN || !TOKEN_SECRET) {
    console.error("x-last-post: no X credentials in the environment; read is inert (the workflow will skip the heartbeat).");
    process.exitCode = 1;
    return;
  }
  const me = await signedGet("/2/users/me", {});
  const uid = (me.data as { id?: string } | undefined)?.id ?? "";
  if (!uid) {
    console.error("x-last-post: /2/users/me returned no id.");
    process.exitCode = 1;
    return;
  }
  const tw = await signedGet(`/2/users/${uid}/tweets`, { max_results: "5", "tweet.fields": "created_at" });
  const rows = tw.data as Array<{ created_at?: string }> | undefined;
  // v2 returns reverse-chronological, but pick the newest explicitly (ISO stamps sort lexicographically) so the
  // silence gap is measured from the truly most-recent tweet regardless of page order.
  const created = (rows ?? []).map((r) => r?.created_at).filter((x): x is string => !!x).sort().reverse()[0] ?? "";
  if (!created) {
    console.error("x-last-post: no tweets found (the account has posted nothing yet).");
    process.exitCode = 1;
    return;
  }
  console.log(created); // stdout: the single ISO timestamp only
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
