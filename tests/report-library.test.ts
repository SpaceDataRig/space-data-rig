// Report-library coverage gate.
//
// WHY THIS EXISTS. reports/*.md is the measurement record; web/reports/*.html is what a reader can actually open at
// spacedatarig.app/reports/<slug>.html, and the site serves exactly the committed fragments. Those two directories
// are generated apart, so they drift apart: P90's report was committed, announced in RESEARCH.md and CHANGELOG.md,
// and linked from a post draft -- and the URL 404'd, because nobody re-ran `npm run p86:report-library`. A report
// that cannot be read is not a publication, and a claim of machine-checkability that points at a missing page is
// worse than no claim. This test makes the omission impossible to ship: every report in the record must have a page
// in the library, and the library's index must name it.
//
// The assertions are on the COMMITTED tree contents read from disk, so a green run means a clean checkout can serve
// every page this repository says it has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MD_DIR = resolve(process.cwd(), "reports");
const LIB_DIR = resolve(process.cwd(), "web", "reports");

const slugs = (dir: string, ext: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
    .sort();

const mdSlugs = slugs(MD_DIR, ".md").filter((s) => s !== "README");
const htmlSlugs = slugs(LIB_DIR, ".html");

interface IndexEntry {
  slug?: string;
  id?: string;
  file?: string;
  href?: string;
  fresh?: boolean;
  verified?: boolean;
}

test("every report in reports/ has a published page in web/reports/", () => {
  const missing = mdSlugs.filter((s) => !htmlSlugs.includes(s));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} report(s) have no page a reader can open: ${missing.join(", ")}. ` +
      `Run npm run p86:report-library and commit web/reports/.`,
  );
});

test("the library index names every page, and no page is absent from the index", () => {
  const index = JSON.parse(readFileSync(resolve(LIB_DIR, "index.json"), "utf8")) as { reports?: IndexEntry[] } | IndexEntry[];
  const entries: IndexEntry[] = Array.isArray(index) ? index : (index.reports ?? []);
  assert.ok(entries.length > 0, "index.json holds no entries");
  const listed = entries.map((e) => String(e.slug ?? e.id ?? "")).sort();
  const absent = htmlSlugs.filter((s) => !listed.includes(s));
  const phantom = listed.filter((s) => s && !htmlSlugs.includes(s));
  assert.deepEqual(absent, [], `pages the index does not know about: ${absent.join(", ")}`);
  assert.deepEqual(phantom, [], `index entries with no page behind them: ${phantom.join(", ")}`);
});

test("a page whose cited inputs no longer match the tree is still served, and is not marked verified", () => {
  // The freshness gate is p86's job; this pins the consequence the reader feels. The index field is `fresh` (the
  // inputs hash to what is committed) and `verified` (the page is reproducible from a clean checkout). A report can
  // go un-fresh because the CODE moved under it -- exactly what happened to p41 when the depth/SNR fix changed
  // src/detect/bls.ts -- and the honest outcome is a page still served and no longer stamped as reproducible.
  const index = JSON.parse(readFileSync(resolve(LIB_DIR, "index.json"), "utf8")) as { reports?: IndexEntry[] } | IndexEntry[];
  const entries: IndexEntry[] = Array.isArray(index) ? index : (index.reports ?? []);
  const stale = entries.filter((e) => e.fresh === false).map((e) => String(e.slug ?? e.id));
  for (const s of stale) assert.ok(existsSync(resolve(LIB_DIR, `${s}.html`)), `un-fresh page ${s} must still be served, not deleted`);
  for (const e of entries) {
    if (e.verified === true) assert.equal(e.fresh, true, `${e.slug}: a page cannot be verified while its inputs do not match the tree`);
  }
  const verified = entries.filter((e) => e.verified === true).length;
  assert.ok(verified >= 1, "at least one page must be reproducible from a clean checkout, or the gate is vacuous");
});

test("the newest measurement is readable, not just committed", () => {
  // P90 is the report this round cites publicly; pin its page specifically so the exact failure that happened --
  // md committed, announcement written, page never built -- cannot happen silently again.
  const p = resolve(LIB_DIR, "p90-depth-estimators.html");
  assert.ok(existsSync(p), "web/reports/p90-depth-estimators.html is missing: run npm run p86:report-library");
  const html = readFileSync(p, "utf8");
  assert.match(html, /48\.0/, "the published page must carry the 68% coverage radius the code cites");
  assert.match(html, /33\.0/, "and the median absolute error");
});
