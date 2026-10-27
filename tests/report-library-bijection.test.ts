// ROUND-26 R26-22: the report library's published index and its built fragments must be a bijection.
//
// THE GAP. `npm run p86:report-library` writes `web/reports/index.json` AND the 56 `web/reports/<slug>.html` fragments
// in one run, so a fresh build is internally consistent. But the committed state is what ships, and it can be assembled
// by other hands: the freshness-regen fleet merges with `-X ours`, a report page can be committed without the index row
// (or the reverse), and `web/app.js:1638` turns a row's `slug` straight into `/reports/<slug>.html` -- so a row whose
// fragment is absent is a link every visitor clicks and gets a 404. This is the exact defect `tests/report-library.test.ts`
// guards for p90 alone, generalized to all 56 rows and to the orphan direction. Round-25 already proved a public 404
// reaches the release text ("https://spacedatarig.app/reports/ -- a directory with no index"); this makes that a gate,
// not an anecdote.
//
// HERMETIC BY DESIGN. It reads only the committed tree, so CI can run it without the network -- the live probe
// (scripts/audit/live-link-integrity26.mjs) is the manual complement, used when a workstation can reach the edge.
// The logic is exercised on synthetic inputs first, so "the real files match" is not a pass-by-absence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const DIR = join(REPO, "web", "reports");

// Compare row slugs to the .html files present; return both directions of mismatch.
function compare(rows: { slug: string }[], files: string[]): { missing: string[]; orphan: string[] } {
  const have = new Set(files);
  const wanted = new Set(rows.map((r) => `${r.slug}.html`));
  const missing = rows.map((r) => r.slug).filter((s) => !have.has(`${s}.html`));
  const orphan = files.filter((f) => f.endsWith(".html") && !wanted.has(f));
  return { missing, orphan };
}

test("the bijection comparison catches a missing page and an orphan page on synthetic inputs", () => {
  const rows = [{ slug: "a" }, { slug: "b" }, { slug: "c" }];
  const files = ["a.html", "b.html", "d.html"]; // c.html missing; d.html orphan
  const c = compare(rows, files);
  assert.deepEqual(c.missing, ["c"], "a row whose fragment is absent must be named");
  assert.deepEqual(c.orphan, ["d.html"], "a built fragment no row references must be named");
});

test("a consistent index and fragment set compares clean (the positive control is not always red)", () => {
  const c = compare([{ slug: "a" }, { slug: "b" }], ["a.html", "b.html"]);
  assert.deepEqual(c, { missing: [], orphan: [] }, "the comparison must pass when the two sides agree");
});

test("every published report row has its page in the committed tree, with no orphan fragments", () => {
  const idx = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as { reports: { id: string; slug: string }[] };
  const rows = idx.reports || [];
  assert.ok(rows.length > 0, "the index has no rows -- the gate would pass on an empty library");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".html"));
  const c = compare(rows, files);
  assert.deepEqual(c.missing, [], `row(s) published with no built page (a live 404): ${c.missing.join(", ")}`);
  assert.deepEqual(c.orphan, [], `fragment(s) built but referenced by no row (dead bytes on the CDN): ${c.orphan.join(", ")}`);
});
