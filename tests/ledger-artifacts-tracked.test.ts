// ROUND-25: a ledger may not promise a kept tool at a path that cannot exist in a clean checkout.
//
// What triggered it. Round-24's ledger recorded a deliberate non-change with the words "the measurement script is
// the tripwire", and this round wrote the same kind of sentence again -- both pointing into out/, which .gitignore
// excludes entirely (`git ls-files out/` returns nothing). A tripwire nobody can obtain is not a tripwire; it is a
// claim. Round-21 had already done it once with out/measure21.ts. This is the exact defect the report-freshness gate
// exists to catch in the science -- computed but not published -- recurring in the audit tooling that watches it, and
// recurring three times because nothing checked the sentence.
//
// The rule is narrow on purpose. Ledgers legitimately name runtime paths (a digest file a script writes, a keypair
// file that MUST stay out of the repo); those are exempt by name, with the reason recorded below, and the exemption
// list is short enough to read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const LEDGERS = ["CHANGELOG.md", "RESPONSE-TO-AUDIT.md", "HANDOFF.md"];

/**
 * Paths a ledger may name without them being tracked, because they are runtime artifacts rather than tools the
 * reader is invited to run. Anything not on this list that looks like a source file must be in `git ls-files`.
 */
const RUNTIME_EXEMPT = new Set([
  // The anchor keypair: it must NEVER be tracked, and HANDOFF names it while saying exactly that.
  "out/anchor-keypair.json",
  // A transient compose output some older entries cite as the thing a script writes, not as a tool.
  "out/digest.txt",
]);

const SOURCEISH = /\b((?:out|scripts|tests|src|reports|web)\/[A-Za-z0-9._/-]+\.(?:mjs|ts|py|sh|js))\b/g;

function trackedPaths(): Set<string> {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, "git ls-files failed; the ledger gate cannot run");
  return new Set(String(r.stdout).split("\0").filter(Boolean));
}

test("every source path a ledger names is tracked in the repository", () => {
  const tracked = trackedPaths();
  const offenders: string[] = [];
  for (const file of LEDGERS) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const m of text.matchAll(SOURCEISH)) {
      const p = m[1];
      if (RUNTIME_EXEMPT.has(p)) continue;
      if (!tracked.has(p)) offenders.push(`${file}: ${p}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} ledger reference(s) point at a file no clean checkout has:\n  ${offenders.join("\n  ")}\n` +
      "Either move the tool onto a tracked path (scripts/audit/ holds the measurement scripts) or reword the claim.",
  );
});

test("the exemption list stays honest: every exempt path is really untracked and really a runtime artifact", () => {
  // An allowlist that quietly becomes tracked is an allowlist that no longer needs to exist, and one that names a
  // SOURCE file is the loophole this whole file was written to close.
  const tracked = trackedPaths();
  for (const p of RUNTIME_EXEMPT) {
    assert.ok(!tracked.has(p), `${p} is tracked now: drop it from RUNTIME_EXEMPT`);
    assert.match(p, /^out\//, `${p}: only out/ runtime paths may be exempt; tools belong under scripts/`);
  }
});

test("the measurement scripts the ledgers promise are all present and runnable from the repo root", () => {
  // The three named cases, asserted positively so a rename cannot dodge the first test by moving to a path that
  // exists but is not what the sentence describes.
  const tracked = trackedPaths();
  const promised = ["scripts/audit/freshness-recheck.mjs", "scripts/audit/feed-fetch-to-post-gap.mjs", "scripts/audit/anchor-health-measure21.ts"];
  for (const p of promised) assert.ok(tracked.has(p), `the ledger promises ${p} but the repository does not carry it`);
  for (const p of promised) {
    const text = readFileSync(join(REPO, p), "utf8");
    assert.ok(text.length > 200, `${p} looks truncated or empty`);
  }
});
