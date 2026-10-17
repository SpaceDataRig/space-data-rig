// Post an English-only status update to X (Twitter) via API v2 with OAuth 1.0a user-context signing.
//
// SECURITY / red lines:
//  - Credentials are read ONLY from the environment (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
//    X_ACCESS_TOKEN_SECRET). Nothing is hardcoded, nothing is logged, and nothing here is ever committed.
//    This mirrors the project's token rule (temporary scripts read env vars, never inline literals).
//  - With no credentials present the script is a DRY RUN: it prints exactly what it WOULD post and makes
//    NO network call. A real post happens only when all four credentials are set (e.g. as GitHub Actions
//    secrets) -- so the CI job is inert until an operator opts in by adding keys.
//  - English-only is ENFORCED: any non-ASCII character (e.g. Chinese) in the text aborts the post, so the
//    automation cannot emit anything but English by construction. Text-only by design -- no media upload.
//  - xAI / Grok keys (api.x.ai) are a model-inference API and are UNRELATED to posting on X; they cannot
//    be used here. This uses the X platform API only.
//
// Usage:
//   npm run x:post -- --text "English update ..."        # dry run (no keys) / post (with keys)
//   npm run x:post -- --text-file out/tweet.txt
//   npm run x:post -- --text "..." --max-len 25000       # Premium long-post probe (default ceiling is 280)
// Optional: X_BEARER-free; only the four OAuth1.0a values are required.

import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { overclaimViolations } from "./science-digest.ts";

function penv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}

function arg(name: string, dflt = ""): string {
  const g = globalThis as { process?: { argv?: string[] } };
  const argv = g.process?.argv ?? [];
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}

const env = penv();
const API_KEY = env.X_API_KEY || "";
const API_SECRET = env.X_API_SECRET || "";
const TOKEN = env.X_ACCESS_TOKEN || "";
const TOKEN_SECRET = env.X_ACCESS_TOKEN_SECRET || "";

let text = arg("text", "");
if (!text) {
  const f = arg("text-file", "");
  if (f) { try { text = readFileSync(f, "utf8"); } catch { text = ""; } }
}
// Preserve the long-form post's intentional line structure (X renders newlines; it has no rich text, so layout
// is newlines + ASCII only). Normalize CRLF->LF, collapse runs of spaces/tabs WITHIN each line, trim each line,
// and squeeze 3+ newlines to one blank line -- but NEVER join lines. This is the identical normalization
// science-digest.ts clip() applies, so what is composed there is byte-for-byte what is sent here.
text = text
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((ln) => ln.replace(/[ \t]+/g, " ").trim())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// Length ceiling. The default 280 (the standard post limit) keeps every automatic digest short and safe.
// A Premium ("blue") author MAY pass --max-len up to X's 25,000-char long-post ceiling; we clamp to that and
// never exceed it. Whether the official /2/tweets endpoint actually accepts >280 for a Premium author is the
// server's call, not ours -- an over-long body still fails cleanly at send time with X's own length error, so
// this clamp only ever prevents an obviously-too-long body from being sent.
const maxArg = Number(arg("max-len", "280"));
const MAXLEN = Number.isFinite(maxArg) && maxArg > 0 ? Math.min(Math.floor(maxArg), 25000) : 280;

if (!text) {
  console.error("x:post: no text supplied (use --text \"...\" or --text-file path)");
  process.exitCode = 1;
} else if (/[^\x00-\x7F]/.test(text)) {
  // English-only guard: refuse anything with a non-ASCII character rather than silently post it.
  console.error("x:post: REFUSED -- text contains a non-ASCII character; policy is English-only.");
  process.exitCode = 1;
} else if (text.length > MAXLEN) {
  text = `${text.slice(0, MAXLEN - 3).trimEnd()}...`;
}

// Output-level over-claim net (audit-6 #2): the per-post "discoveryClaim=false" stamp was removed, so honesty
// now rests on wording alone. As a final, template-independent safety net, refuse to send ANY text that
// affirmatively over-claims (a discover/confirm/first/novel stem in an un-hedged sentence). This is a hard
// stop even in a manual dispatch -- the whole point is that no code path can post an over-claim.
if (process.exitCode !== 1) {
  const over = overclaimViolations(text);
  if (over.length) {
    console.error(`x:post: REFUSED -- final text contains ${over.length} affirmative over-claim(s); policy is no discovery/confirmation wording:`);
    for (const h of over) console.error(`  - ${h}`);
    process.exitCode = 1;
  }
}

const ready = Boolean(API_KEY && API_SECRET && TOKEN && TOKEN_SECRET);

if (process.exitCode === 1) {
  // fall through to exit; nothing more to do
} else if (!ready) {
  console.log("x:post: DRY RUN (no X credentials in the environment; nothing was sent to X).\n");
  console.log("Would post (English-only, text-only):");
  console.log("---");
  console.log(text);
  console.log("---");
  console.log(`length=${text.length}/${MAXLEN}`);
} else {
  const method = "POST";
  const url = "https://api.twitter.com/2/tweets";
  const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const oauth: Record<string, string> = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: TOKEN,
    oauth_version: "1.0",
  };
  // JSON body is NOT part of the OAuth1 signature base (only the url + sorted params are).
  const norm = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join("&");
  const base = `${method}&${pct(url)}&${pct(norm)}`;
  const signingKey = `${pct(API_SECRET)}&${pct(TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const authz = "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
  const body = JSON.stringify({ text });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { authorization: authz, "content-type": "application/json" },
      body,
    });
    const j = await r.text();
    if (!r.ok) {
      console.error(`x:post: X returned HTTP ${r.status}: ${j.slice(0, 300)}`);
      process.exitCode = 1;
    } else {
      let id = "";
      try { id = (JSON.parse(j).data && JSON.parse(j).data.id) || ""; } catch { /* ignore */ }
      console.log(`x:post: OK posted (id ${id || "?"}).`);
    }
  } catch (e) {
    console.error(`x:post: request failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
