// ROUND-25 (R25-6): the site's honesty marks on the report list had never been executed by anything, and one of them
// was written fail-OPEN.
//
// `web/app.js` renders three badges per report row. The gate's whole public value is that a row which was NOT
// machine-checked carries a visible mark -- 40 of the 56 published rows depend on that mark, and `npm test` had never
// looked at the code that draws it. Reading it closely, the unverified badge fired on `r.verified === false` only: a
// row whose `verified` key is ABSENT (an older or hand-patched index.json, a partial publish, a future writer that
// forgets the field) rendered with no badge at all and read as clean. The mark has to be earned, not lost only by
// being explicitly contradicted, so the predicate is now `!== true`.
//
// Method mirrors round-24's workflow-shell tests: no re-implementation, no import of a copy -- the predicates are
// extracted from the real served file and executed, so a rewrite of the renderer that changes their shape fails the
// extraction rather than passing vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stripWin = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = stripWin(new URL("..", import.meta.url));
const APP = readFileSync(join(REPO, "web", "app.js"), "utf8");

type Row = Record<string, unknown>;

/** The badge conditionals, lifted verbatim out of renderReportsList, keyed by the class they emit. */
function extractBadges(): { cls: string; pred: (r: Row) => boolean }[] {
  const out: { cls: string; pred: (r: Row) => boolean }[] = [];
  for (const line of APP.split("\n")) {
    const cls = /class="(ri-stale|ri-unverified)"/.exec(line);
    if (!cls) continue;
    const open = line.indexOf("(");
    const mark = line.indexOf(" ? `");
    assert.ok(open >= 0 && mark > open, `could not locate a badge conditional in: ${line.trim()}`);
    const cond = line.slice(open + 1, mark).trim();
    const fn = new Function("r", `return (${cond});`) as (r: Row) => boolean;
    out.push({ cls: cls[1], pred: fn });
  }
  return out;
}

const BADGES = extractBadges();

test("the renderer's badge predicates are all found, so a rewrite cannot make this test vacuous", () => {
  assert.equal(BADGES.length, 3, `expected 1 stale + 2 unverified badges, found ${BADGES.map((b) => b.cls).join(",")}`);
  assert.deepEqual(BADGES.map((b) => b.cls), ["ri-stale", "ri-unverified", "ri-unverified"]);
});

/** Which badges a row would show, as class names. */
function shown(r: Row): string[] {
  return BADGES.filter((b) => b.pred(r)).map((b) => b.cls);
}

test("the badge truth table: one mark per state, and no mark only where the gate truly checked the row", () => {
  assert.deepEqual(shown({ fresh: false, verified: true }), ["ri-stale"]);
  assert.deepEqual(shown({ fresh: true, verified: false }), ["ri-unverified"]);
  assert.deepEqual(shown({ fresh: true, verified: true, untrackedInputs: 1 }), ["ri-unverified"]);
  assert.deepEqual(shown({ fresh: true, verified: true, unverifiableInputs: 2 }), ["ri-unverified"]);
  assert.deepEqual(shown({ fresh: true, verified: true }), []);
  // R25-6 proper: a row that says nothing about verification must not read as verified.
  assert.deepEqual(shown({}), ["ri-unverified"]);
  assert.deepEqual(shown({ fresh: true }), ["ri-unverified"]);
  assert.deepEqual(shown({ fresh: true, verified: null }), ["ri-unverified"]);
  // and a stale row keeps its single stale mark rather than accumulating a second, weaker one
  assert.deepEqual(shown({ fresh: false, verified: undefined }), ["ri-stale"]);
});

test("every published row that is not machine-checked carries a mark on the real site copy", () => {
  const idx = JSON.parse(readFileSync(join(REPO, "web", "reports", "index.json"), "utf8")) as {
    reports: Row[];
  };
  const rows = idx.reports || [];
  assert.ok(rows.length > 0, "index.json has no rows");
  let unmarked = 0;
  for (const r of rows) {
    const marks = shown(r);
    const machineChecked = r.verified === true && r.fresh !== false;
    if (!machineChecked) {
      assert.ok(marks.length > 0, `${r.id}: published as not-machine-checked yet the renderer would show no mark`);
    } else {
      unmarked++;
    }
  }
  const verifiedTrue = rows.filter((r) => r.verified === true && r.fresh !== false).length;
  assert.equal(unmarked, verifiedTrue, "only machine-checked rows may render clean");
  assert.equal(rows.length - unmarked, rows.filter((r) => r.verified !== true || r.fresh === false).length);
});
