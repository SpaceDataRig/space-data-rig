// post-x-text.ts is a CLI whose refusals ARE the behaviour, so this drives the real script rather than a mock.
// The test environment has no X credentials (and they are forced empty here), so an accepted text is a DRY RUN and
// nothing is sent. These cases pin the send-time feed red-line guard that closes the asymmetry with
// tests/devlog-archive.test.ts: text the archive would reject (a relative time word, or wallet / spend wording)
// must never be postable in the first place, and a clean text must still reach the DRY RUN rather than be
// over-refused. Both guards import the SAME predicate from science-digest.ts, so they cannot disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const SCRIPT = new URL("../scripts/post-x-text.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HERE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Run the real sender with credentials forced empty, so the only outcomes are REFUSED (exit 1) or DRY RUN (exit 0). */
function send(text: string): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--text", text, "--max-len", "25000"], {
      encoding: "utf8",
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, X_API_KEY: "", X_API_SECRET: "", X_ACCESS_TOKEN: "", X_ACCESS_TOKEN_SECRET: "" },
    });
    return { status: 0, stderr: "", stdout };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? ""), stdout: String(err.stdout ?? "") };
  }
}

const CLEAN =
  "Seventeenth-round audit of the rig: the disclosure predicate now reads all 103 catalog rows, " +
  "and the label-conflict count moved from 5 to 7 with no anchored ledger row changed.";

test("the send guard REFUSES a relative time word -- the same red line the archive enforces", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. The catalog today holds only A components, " +
      "so the live host count stays exactly 90 over 103 records.",
  );
  assert.equal(r.status, 1, "a time-worded post must exit non-zero");
  assert.match(r.stderr, /REFUSED/, "and say REFUSED");
  assert.match(r.stderr, /time-implying/i, "and name the time-word reason");
});

test("the send guard REFUSES wallet / key / spend wording", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. The wallet balance is unchanged and the " +
      "anchored ledger rows are intact.",
  );
  assert.equal(r.status, 1, "spend wording must exit non-zero");
  assert.match(r.stderr, /REFUSED/, "and say REFUSED");
  assert.match(r.stderr, /wallet\/spend/i, "and name the wallet/spend reason");
});

test("a clean text is NOT refused -- it reaches the DRY RUN and nothing is sent", () => {
  const r = send(CLEAN);
  assert.equal(r.status, 0, `expected a clean DRY RUN, stderr: ${r.stderr}`);
  assert.match(r.stdout, /DRY RUN/, "and report the DRY RUN");
});

test("guard the guard: the clean fixture trips no time, spend, or over-claim red line", () => {
  // If CLEAN ever tripped a red line, the DRY RUN case above would be asserting the wrong thing.
  assert.ok(!/\b(this week|last week|next week|recently|overnight|today|tonight|yesterday)\b/i.test(CLEAN), "no time word");
  assert.ok(!/wallet|private key|secret key|seed phrase|\bcost\b|\busd\b|\bsol\b|\$\d/i.test(CLEAN), "no spend word");
  assert.ok(!/\b(discover\w*|confirm\w*|first|novel|unprecedented|landmark|historic)\b/i.test(CLEAN), "no over-claim stem");
});
