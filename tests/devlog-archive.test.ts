// devlog/ archives the long-form summaries that were actually pushed to the public feed, so a public post can be
// audited against the commits it describes. scripts/devlog-archive.ts composes each entry from the SAME BYTES that
// were handed to the dispatcher rather than from a re-typed copy, because an archive that has drifted from the feed
// is worse than no archive: it looks authoritative.
//
// So the properties worth pinning are (a) the script reproduces the pushed text exactly, including the CRLF -> LF
// normalisation the dispatcher performs, (b) it REFUSES to write an archive that could not be a real post, and
// (c) every entry already committed satisfies the same red lines post-x-text.ts enforces at send time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overclaimViolations, FEED_TIME_WORDS as TIME_WORDS, FEED_SPEND_WORDS as SPEND_WORDS } from "../scripts/science-digest.ts";

const SCRIPT = new URL("../scripts/devlog-archive.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HERE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Run the script for real: it is a CLI that validates and exits non-zero, so its refusals are the behaviour. */
function run(args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      encoding: "utf8",
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "", stdout };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? ""), stdout: String(err.stdout ?? "") };
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "devlog-archive-"));
}

const EVIDENCE = "# 2026-10-18 -- an entry\n\n- posted id: `123`\n";

test("the archive is the evidence header followed by the pushed text, verbatim, inside a fence", () => {
  const dir = scratch();
  const text = join(dir, "pushed.txt");
  const ev = join(dir, "ev.md");
  const out = join(dir, "devlog", "entry.md");
  writeFileSync(text, "Line one.\n\nLine two with a number: 618 of 618.\n", "utf8");
  writeFileSync(ev, EVIDENCE, "utf8");
  const r = run(["--text-file", text, "--evidence-file", ev, "--out", out]);
  assert.equal(r.status, 0, `expected success, stderr: ${r.stderr}`);
  assert.equal(readFileSync(out, "utf8"), `${EVIDENCE}\n## Text as pushed\n\n\`\`\`\nLine one.\n\nLine two with a number: 618 of 618.\n\`\`\`\n`);
  assert.match(r.stdout, /pushed text 46 chars, 3 line/, "the log states how much text was archived");
});

test("CRLF is normalised to LF, because that is what the dispatcher sent -- not what Windows stored", () => {
  const dir = scratch();
  const text = join(dir, "pushed.txt");
  const ev = join(dir, "ev.md");
  const out = join(dir, "entry.md");
  writeFileSync(text, "alpha\r\nbeta\r\n\r\n", "utf8");
  writeFileSync(ev, EVIDENCE, "utf8");
  assert.equal(run(["--text-file", text, "--evidence-file", ev, "--out", out]).status, 0);
  const md = readFileSync(out, "utf8");
  assert.ok(!md.includes("\r"), "no carriage return may survive into the archive");
  assert.ok(md.includes("```\nalpha\nbeta\n```"), "trailing blank lines are trimmed, inner blank lines are not");
});

test("a code fence inside the pushed text is REFUSED: it would truncate the archive silently", () => {
  const dir = scratch();
  const text = join(dir, "pushed.txt");
  const ev = join(dir, "ev.md");
  const out = join(dir, "entry.md");
  writeFileSync(text, "before\n```\nswallowed\n", "utf8");
  writeFileSync(ev, EVIDENCE, "utf8");
  const r = run(["--text-file", text, "--evidence-file", ev, "--out", out]);
  assert.equal(r.status, 1, "must exit non-zero");
  assert.match(r.stderr, /code fence/, "and say why");
});

test("non-ASCII text is REFUSED: post-x-text.ts would never have sent it, so the archive would be lying", () => {
  const dir = scratch();
  const text = join(dir, "pushed.txt");
  const ev = join(dir, "ev.md");
  const out = join(dir, "entry.md");
  writeFileSync(text, "a perfectly fine line\n", "utf8");
  writeFileSync(ev, EVIDENCE, "utf8");
  // Written as bytes so the fixture really carries a non-ASCII byte rather than depending on the editor.
  writeFileSync(text, Buffer.concat([Buffer.from("caf", "utf8"), Buffer.from([0xc3, 0xa9]), Buffer.from("\n", "utf8")]));
  const r = run(["--text-file", text, "--evidence-file", ev, "--out", out]);
  assert.equal(r.status, 1, "must exit non-zero");
  assert.match(r.stderr, /non-ASCII/, "and say why");
});

test("missing arguments and an empty text are refused rather than archiving nothing", () => {
  const dir = scratch();
  const ev = join(dir, "ev.md");
  const empty = join(dir, "empty.txt");
  writeFileSync(ev, EVIDENCE, "utf8");
  writeFileSync(empty, "\n\n", "utf8");
  assert.equal(run(["--text-file", empty, "--evidence-file", ev]).status, 1, "--out is required");
  assert.equal(run(["--text-file", empty, "--evidence-file", ev, "--out", join(dir, "x.md")]).status, 1, "empty text");
  assert.equal(run(["--text-file", join(dir, "nope.txt"), "--evidence-file", ev, "--out", join(dir, "x.md")]).status, 1, "unreadable text");
});

// ---- the entries already in the repository --------------------------------------------------------
// Whatever was archived must satisfy the same red lines the send path enforces. This is the check that keeps
// devlog/ honest as it grows: an entry whose text could never have been posted is a fabricated record. The two
// red-line regexes are IMPORTED from science-digest.ts -- the very predicate post-x-text.ts guards the send with
// -- so the archive guard and the send guard are the same rule by construction and can never drift apart.

const FENCE = "```";
const HEADING = "## Text as pushed";

// Archived entries exempted BY NAME from the SPEND scan only (see the "could actually have been posted" test for
// why). Kept next to the parser consts so the exemption is impossible to miss when reading the guard.
const GRANDFATHERED_SPEND_META = new Set(["2026-10-18-byte-exact-devlog-archive.md"]);

/** The verbatim pushed text out of an archived entry, or null when the entry has no such block. Split on the fence
 *  with string operations rather than a multi-line regex: the parser must not be confusable by the very newlines it
 *  is looking for, and a fence inside the pushed text is already refused at archive time. */
function pushedTextOf(md: string): string | null {
  const at = md.lastIndexOf(HEADING);
  if (at < 0) return null;
  const parts = md.slice(at + HEADING.length).split(FENCE);
  if (parts.length < 3) return null;
  let body = parts[1];
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return body;
}

function archivedEntries(): Array<{ file: string; pushed: string }> {
  const dir = join(HERE, "devlog");
  const out: Array<{ file: string; pushed: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const md = readFileSync(join(dir, name), "utf8");
    const pushed = pushedTextOf(md);
    assert.ok(pushed !== null, `${name}: must end with a "Text as pushed" fenced block`);
    out.push({ file: name, pushed: String(pushed) });
  }
  return out;
}

test("every archived devlog entry holds text that could actually have been posted", () => {
  const entries = archivedEntries();
  assert.ok(entries.length >= 2, `expected the archived summaries, found ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.pushed.length > 200, `${e.file}: an archived summary is long-form, got ${e.pushed.length} chars`);
    assert.ok(!/[^\x00-\x7F]/.test(e.pushed), `${e.file}: must be pure ASCII (post-x-text.ts refuses anything else)`);
    assert.ok(!e.pushed.includes("\r"), `${e.file}: must hold the LF bytes that were sent`);
    assert.ok(!TIME_WORDS.test(e.pushed), `${e.file}: must not imply a time window`);
    // Round-18 spend-word widening (audit item 2) added the project's own currency vocabulary (spend / burn / fee /
    // lamports / rent / payout / $SDR) to FEED_SPEND_WORDS. One entry archived BEFORE that widening quotes a red-line
    // word while DESCRIBING the guard ("...no time-implying wording, no spend wording...") -- legitimate meta usage in
    // a post about these very tests. An archive must never be re-struck to satisfy a later-widened predicate (a
    // drifted archive is worse than none), so that entry is exempted BY NAME from the SPEND scan only, with the reason
    // recorded here. The send guard (post-x-text.ts) still refuses such wording in any NEW post. Measured: it is the
    // only archived entry the widening affects (out/m5-guard-scan.txt).
    if (!GRANDFATHERED_SPEND_META.has(e.file))
      assert.ok(!SPEND_WORDS.test(e.pushed), `${e.file}: must never mention wallet/key/spend`);
    assert.deepEqual(overclaimViolations(e.pushed), [], `${e.file}: must contain no affirmative over-claim`);
  }
});

test("every archived devlog entry carries its dispatch evidence, so the post is traceable", () => {
  const dir = join(HERE, "devlog");
  for (const e of archivedEntries()) {
    const md = readFileSync(join(dir, e.file), "utf8");
    const header = md.split("## Text as pushed")[0];
    assert.match(header, /actions\/runs\/\d+/, `${e.file}: must cite the Actions run that posted it`);
    assert.match(header, /posted id: `\d+`/, `${e.file}: must cite the tweet id, the proof it actually went out`);
    assert.match(header, /HTTP `204`/, `${e.file}: must record that the dispatch was accepted`);
  }
});
