// PUBLIC STAT DEFINITIONS -- the counter/label mismatch class, applied to the rotation numbers (audit-7 h1).
//
// The rig's most damaging audit finding so far was not a wrong number but a right number under a wrong label:
// `bundlesAnchored` counted "current bytes still match a commitment" while the tile read "on-chain", so the board
// showed 7 where the ledger held 18. This pass sweeps the OTHER public counters the survey exposes -- surveyPass,
// distinctHosts, blindCandidates -- for the same failure, and one was live: the board's "blind candidates" counted
// EVERY blind-toi row including critic-REJECTED noise, while the X digest deliberately counted only surviving ones.
// Two public surfaces, one phrase, two populations.
//
// The Durable Object cannot be imported here (it pulls in `cloudflare:workers`), so the SQL is checked the way
// tests/anchored-stats.test.ts checks its sibling: the shared constants are executed against real SQLite when the
// runtime has it (node:sqlite), and pinned to the pure JS predicate so the two cannot report different totals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BLIND_CANDIDATE_SQL,
  BLIND_HELD_SQL,
  isBlindCandidate,
  isHeldBlindCandidate,
  surveyStatsSentence,
} from "../src/core/stats-definitions.ts";
import { RigStore } from "../src/core/store.ts";

const HERE = resolve(process.cwd());
const read = (...p: string[]) => readFileSync(resolve(HERE, ...p), "utf8");

/** A finding row carrying only what the three counters read. `id` is the store's primary key, so it must be set. */
const row = (targetId: string, origin: string | undefined, verdict: string | undefined) =>
  ({ id: `F-${targetId}`, targetId, origin, verdict }) as never;

// ---- the populations themselves ------------------------------------------------------------

test("blind HELD is blind ASSESSED minus the critic-rejected -- the two are one subset, not two opinions", () => {
  const rows = [
    row("TOI-1.01", "blind-toi", "needs-more-data"),
    row("TOI-2.01", "blind-toi", "rejected"),
    row("TOI-3.01", "blind-toi", undefined), // verdict not written yet: held, matching the JS `!== "rejected"`
    row("TOI-4.01", "revalidation", "accepted"),
    row("KELT-1b", undefined, "accepted"), // pre-rotation row: no origin at all
  ];
  assert.equal(rows.filter(isBlindCandidate).length, 3, "assessed counts every blind-toi row");
  assert.equal(rows.filter(isHeldBlindCandidate).length, 2, "held drops only the rejected one");
  // A rejected row is excluded from HELD but must never sneak into ASSESSED's complement -- assessed is the superset.
  for (const r of rows) if (isHeldBlindCandidate(r)) assert.ok(isBlindCandidate(r), "held is a subset of assessed");
});

test("a re-validation or unlabelled row is neither held nor assessed, so breadth cannot dress as a candidate", () => {
  for (const r of [row("X", "revalidation", "accepted"), row("Y", undefined, "needs-more-data")]) {
    assert.equal(isBlindCandidate(r), false);
    assert.equal(isHeldBlindCandidate(r), false);
  }
});

/** The slice of node:sqlite this test uses, declared so no `any` is needed to talk to an optional module. */
interface SqliteSync {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): void; get(): Record<string, number> };
    close(): void;
  };
}

// ---- the SQL the Durable Object runs, executed for real where the runtime allows -------------

test("the DO's SQL selects exactly the same rows the JS predicate does", async () => {
  const rows: Array<ReturnType<typeof row>> = [
    row("TOI-1.01", "blind-toi", "needs-more-data"),
    row("TOI-2.01", "blind-toi", "rejected"),
    row("TOI-3.01", "blind-toi", undefined),
    row("TOI-4.01", "revalidation", "accepted"),
    row("KELT-1b", undefined, "accepted"),
  ];
  let sqlite: SqliteSync | undefined;
  try {
    sqlite = (await import("node:sqlite")) as unknown as SqliteSync;
  } catch {
    sqlite = undefined;
  }
  if (!sqlite) {
    // No SQLite in this runner: fall back to pinning the literal shape, and say so loudly rather than passing
    // silently -- an empty assertion here is exactly the "gate that scans nothing" the repo has been burned by.
    assert.match(BLIND_CANDIDATE_SQL, /json_extract\(data,'\$\.origin'\) = 'blind-toi'/);
    assert.match(BLIND_HELD_SQL, /json_extract\(data,'\$\.verdict'\) IS NULL OR json_extract\(data,'\$\.verdict'\) != 'rejected'/);
    return;
  }
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("CREATE TABLE findings (data TEXT)");
  const insert = db.prepare("INSERT INTO findings (data) VALUES (?)");
  for (const r of rows) insert.run(JSON.stringify(r));
  const count = (where: string) => db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where}`).get().n;
  assert.equal(count(BLIND_CANDIDATE_SQL), rows.filter(isBlindCandidate).length, "assessed: SQL vs JS");
  assert.equal(count(BLIND_HELD_SQL), rows.filter(isHeldBlindCandidate).length, "held: SQL vs JS");
  db.close();
});

// ---- the Node mirror, driven through the real store ------------------------------------------

test("the Node store reports the same two blind numbers from the same rows the board renders", () => {
  const store = new RigStore();
  store.addFinding(row("TOI-1.01", "blind-toi", "needs-more-data"));
  store.addFinding(row("TOI-2.01", "blind-toi", "rejected"));
  store.addFinding(row("KELT-1b", "revalidation", "accepted"));
  const stats = store.computeStats();
  assert.equal(stats.blindCandidates, 2, "assessed: the two blind rows, rejected included");
  assert.equal(stats.blindHeld, 1, "held: only the surviving candidate");
  assert.equal(stats.distinctHosts, 3, "hosts with a RECORDED RESULT of any verdict");
});

// ---- the sentence, and the surfaces that must show it ----------------------------------------

test("the survey sentence names all three populations and never calls an assessed candidate held", () => {
  const s = surveyStatsSentence({ surveyPass: 4, distinctHosts: 12, blindHeld: 3, blindCandidates: 5 });
  assert.match(s, /survey pass 4 claimed/, "the pass count must be labelled claimed, not completed");
  assert.match(s, /12 hosts with recorded results/, "breadth is hosts with results, not targets analysed");
  assert.match(s, /3\/5 blind candidates held\/assessed/, "both blind numbers, held over assessed");
  assert.doesNotMatch(s, /distinct targets/, "the old over-label that read as survey breadth");
});

test("both browser surfaces render the shared sentence, and the pre-JS markup matches it", () => {
  const app = read("web", "app.js");
  assert.match(app, /function surveyStatsSentence\(stats\)/, "one builder, not two inline templates");
  assert.equal((app.match(/= surveyStatsSentence\((?:stats|st)\)/g) ?? []).length, 2, "both render sites call it");
  assert.doesNotMatch(app, /distinct targets/, "no surface may keep the loose label");

  const html = read("web", "index.html");
  const zeros = surveyStatsSentence({ surveyPass: 0, distinctHosts: 0, blindHeld: 0, blindCandidates: 0 });
  // The text a reader sees before the first fetch must already be the honest sentence, not the old over-label.
  // Count occurrences as plain substrings -- the sentence has parentheses, which would need escaping as a RegExp.
  const occurrences = html.split(zeros).length - 1;
  assert.equal(occurrences, 2, "both survey lines ship honest");
  for (const id of ["survey-head-stats", "survey-stats"]) {
    const el = new RegExp(`id="${id}"[^>]*`);
    assert.match(html, el, `${id} must exist`);
    const title = html.match(new RegExp(`id="${id}" title="([^"]{80,})"`));
    assert.ok(title, `${id} must carry its definition where a reader can hover it`);
    assert.match(title[1], /CLAIMED, not completed/);
    assert.match(title[1], /held for follow-up over blind rows assessed/);
  }
});

// ---- call sites: the shared rule must actually be the one in production ----------------------

test("the Durable Object counts through the shared SQL constants, not an inline copy", () => {
  const src = read("src", "cf", "rig-state.do.ts");
  assert.match(src, /import \{[^}]*BLIND_HELD_SQL[^}]*\} from "\.\.\/core\/stats-definitions\.ts"/, "must import the shared rule");
  assert.match(src, /blindCandidates: scalar\(`SELECT COUNT\(\*\) AS n FROM findings WHERE \$\{BLIND_CANDIDATE_SQL\}`\)/);
  assert.match(src, /blindHeld: scalar\(`SELECT COUNT\(\*\) AS n FROM findings WHERE \$\{BLIND_HELD_SQL\}`\)/);
  // The whole point: an inline `= 'blind-toi'` here would count rejected noise under the held label again.
  assert.doesNotMatch(src, /blindCandidates: scalar\(`SELECT COUNT\(\*\) AS n FROM findings WHERE json_extract\(data,'\$\.origin'\) = 'blind-toi'`\)/);
});

test("the digest's blind count uses the shared held predicate, so board and feed count one phrase one way", () => {
  const digest = read("scripts", "science-digest.ts");
  assert.match(digest, /import \{[^}]*isHeldBlindCandidate[^}]*\} from "\.\.\/src\/core\/stats-definitions\.ts"/);
  assert.match(digest, /const blindTotal = findings\.filter\(\(f\) => f && isHeldBlindCandidate\(f\)\)\.length/, "the headline count");
  assert.match(digest, /\.filter\(\(f\) => f && isHeldBlindCandidate\(f\) && within\(/, "the newly-flagged tier");
  // A re-tightened inline copy would drift the moment the predicate changes; forbid both surfaces keeping their own.
  assert.doesNotMatch(digest, /f\.origin === "blind-toi" && f\.verdict !== "rejected"/, "no parallel hand-written filter");
});

test("the type the two runtimes share carries blindHeld, so a missing field cannot silently read as zero", () => {
  const types = read("src", "core", "state-types.ts");
  assert.match(types, /blindHeld: number;/, "the field must exist on RigStats");
  assert.match(types, /surveyPass: number;/);
  assert.match(types, /distinctHosts: number;/);
});
