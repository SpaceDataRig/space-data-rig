// Two anchor numbers, one rule for keeping them true.
//
// WHY THIS FILE EXISTS. The public dashboard showed a single tile labelled "on-chain" fed by
// `stats.bundlesAnchored`, which counts findings whose CURRENTLY PUBLISHED bundle carries a confirmed stamp.
// Reading that tile as "how many results this rig has anchored" was wrong: /api/ledger held 18 commitments while
// the tile showed 7, because a bundle hash folds the run's timestamp, so every record the rotating survey
// re-measures leaves the 7 without leaving the chain. Both numbers are true and both are now published, with the
// definitions written where the code is read.
//
// Chasing that discrepancy found a second, worse defect: the ledger keeps ONE row per finding, and the write path
// stored whatever the newest attempt produced -- so a FAILED re-anchor of an already-anchored finding overwrote
// the signature, slot and explorer URL of a commitment that is still live on mainnet. Provenance evidence was
// destroyed, and the cumulative count fell on an RPC hiccup. `mergeLedgerRow` is the rule against that, shared by
// both runtimes.
//
// The Durable Object cannot be imported here (it imports `cloudflare:workers`), so the DO side is covered the way
// tests/run-mutex.test.ts covers the rest of it: the rule lives in a pure core module that IS imported, and the
// call site is pinned by reading the shipped file. A rule whose call site was deleted would otherwise stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isCommittedLedgerRow, mergeLedgerRow, LEDGER_COMMITTED_SQL } from "../src/core/anchor-verify.ts";
import type { BundleRecord, LedgerEntry } from "../src/core/state-types.ts";
import { RigStore } from "../src/core/store.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const HERE = resolve(process.cwd());

/** A ledger row as the DO stores it. `h` is the bundle hash the commitment covers, `s` the signature. */
function row(findingId: string, h: string, s?: string, status: LedgerEntry["status"] = "anchored"): LedgerEntry {
  return { findingId, bundleHash: h, memo: `sdr:1|${findingId}|${h}`, status, signature: s, anchoredAt: status === "anchored" ? NOW : undefined };
}

/** A bundle row as the store holds it: `tx` is the stamp, if any. */
function bundle(findingId: string, hash: string, tx?: string): BundleRecord {
  return { findingId, hash, createdAt: NOW, solanaTx: tx } as unknown as BundleRecord;
}

// ---- the predicate: what counts as a commitment ----------------------------------------------------------

test("a commitment is an anchored row that carries a signature anybody can look up", () => {
  assert.equal(isCommittedLedgerRow(row("F1", "hA", "sigA")), true);
  assert.equal(isCommittedLedgerRow(row("F1", "hA", "", "anchored")), false, "an anchored row with no signature is unverifiable, not a commitment");
  assert.equal(isCommittedLedgerRow(row("F1", "hA", undefined)), false, "no signature at all");
  assert.equal(isCommittedLedgerRow(row("F1", "hA", "sigA", "failed")), false, "a failed attempt never counts, signature or not");
  // The fs ledger additionally has rows that never resolved.
  assert.equal(isCommittedLedgerRow({ status: "pending", signature: "sigA" }), false, "pending is not landed");
});

test("the SQL form used by the Durable Object names the same two conditions the predicate checks", () => {
  // The DO runs in workerd and cannot be imported here, so the query is exported as data and checked against the
  // JavaScript rule. Anything the SQL forgets to filter on would make the two runtimes report different totals.
  assert.match(LEDGER_COMMITTED_SQL, /\$\.status'\) = 'anchored'/);
  assert.match(LEDGER_COMMITTED_SQL, /\$\.signature'\) IS NOT NULL/);
});

// ---- the merge: an attempt that failed cannot demote one that landed ------------------------------------

test("a failed re-anchor preserves the earlier commitment instead of overwriting it", () => {
  const prior = row("F1", "hA", "sigA");
  const failed = { ...row("F1", "hB", undefined, "failed"), error: "all RPC endpoints unreachable" };
  const merged = mergeLedgerRow(prior, failed, NOW);
  assert.equal(merged.status, "anchored", "the row still records the commitment that landed");
  assert.equal(merged.signature, "sigA", "the signature must survive or the tx can no longer be looked up");
  assert.equal(merged.bundleHash, "hA", "and it still covers the hash it covered");
  assert.equal(merged.error, undefined, "the row's own error field stays empty -- this row did not fail");
  assert.equal(merged.lastAttemptError, "all RPC endpoints unreachable", "the lost attempt is recorded beside the row");
  assert.equal(merged.lastAttemptBundleHash, "hB", "including which bundle the retry was for");
  assert.equal(isCommittedLedgerRow(merged), true, "and the cumulative count does not fall");
});

test("a successful re-anchor really does replace the row, and a fresh row is stored verbatim", () => {
  const prior = row("F1", "hA", "sigA");
  const again = row("F1", "hB", "sigB");
  const merged = mergeLedgerRow(prior, again, NOW);
  assert.equal(merged.bundleHash, "hB", "a newer commitment is not a downgrade");
  assert.equal(merged.signature, "sigB");
  assert.equal(merged.lastAttemptError, undefined);
  assert.equal(mergeLedgerRow(undefined, again, NOW), again, "no prior row: store what arrived, untouched");
  // A prior FAILED row must not block a later success.
  assert.equal(mergeLedgerRow(row("F1", "hA", undefined, "failed"), again, NOW).signature, "sigB");
});

// ---- the two counters, on one store ----------------------------------------------------------------------

test("the two anchor counts disagree on purpose, and both are published", () => {
  const store = new RigStore();
  store.addBundle(bundle("F1", "hA", "sigA"));
  store.addBundle(bundle("F2", "hB", "sigB"));
  const ledger = [row("F1", "hA", "sigA"), row("F2", "hB", "sigB")];

  // F1 is re-derived by the rotating survey: same finding, new timestamped hash, so the stamp cannot be inherited
  // (that refusal is tests/integrity.test.ts's job) and the chain never saw hA2.
  store.addBundle(bundle("F1", "hA2"));

  const stats = store.computeStats(ledger);
  assert.equal(stats.bundlesAnchored, 1, "one published bundle still matches a commitment");
  assert.equal(stats.ledgerAnchored, 2, "both commitments are still on chain");
  assert.ok(stats.ledgerAnchored >= stats.bundlesAnchored, "a superseded bundle leaves the small count only");
});

test("a store that was never handed a ledger says zero commitments rather than borrowing the other count", () => {
  const store = new RigStore();
  store.addBundle(bundle("F1", "hA", "sigA"));
  const stats = store.computeStats();
  assert.equal(stats.bundlesAnchored, 1, "the stamp is real and stays counted");
  assert.equal(stats.ledgerAnchored, 0, "no ledger was supplied: the cumulative total is unknown, never inferred");
});

// ---- call sites: the rules must actually be wired in -----------------------------------------------------

test("the Durable Object applies both rules, in the right order", () => {
  const src = readFileSync(resolve(HERE, "src", "cf", "rig-state.do.ts"), "utf8");
  assert.match(src, /from "\.\.\/core\/anchor-verify\.ts"/);
  assert.ok(/import \{[^}]*mergeLedgerRow[^}]*\} from "\.\.\/core\/anchor-verify\.ts"/.test(src), "must use the shared merge rule, not a copy");
  assert.ok(/import \{[^}]*LEDGER_COMMITTED_SQL[^}]*\} from "\.\.\/core\/anchor-verify\.ts"/.test(src), "and the shared count predicate");
  assert.match(src, /ledgerAnchored: scalar\(`SELECT COUNT\(\*\) AS n FROM ledger WHERE \$\{LEDGER_COMMITTED_SQL\}`\)/, "the count must come from the shared predicate");
  // The write path must merge against the row it already holds and store the MERGED row: writing `entry` again
  // would restore the destroy-the-evidence behaviour while every pure test above still passed.
  const upsert = src.slice(src.indexOf("async upsertLedger("));
  const readAt = upsert.indexOf("SELECT data FROM ledger WHERE finding_id = ?");
  const mergeAt = upsert.indexOf("mergeLedgerRow(");
  const writeAt = upsert.indexOf("INSERT OR REPLACE INTO ledger");
  assert.ok(readAt >= 0 && mergeAt > readAt && writeAt > mergeAt, "read prior, then merge, then write");
  assert.match(upsert.slice(writeAt, writeAt + 320), /merged\.findingId[\s\S]*JSON\.stringify\(merged\)/, "the merged row is the row that gets stored");
});

test("the Node ledger applies the same merge, and the CLI counts it the same way", () => {
  const anchor = readFileSync(resolve(HERE, "src", "solana", "anchor.ts"), "utf8");
  assert.match(anchor, /ledger\[i\] = mergeLedgerRow\(ledger\[i\], entry/, "the fs ledger may not keep its own replace rule");
  assert.doesNotMatch(anchor, /ledger\[i\] = \{ \.\.\.ledger\[i\], \.\.\.entry \}/, "the old spread-downgrade shape must be gone");
  assert.match(anchor, /countCommittedLedger/, "and the cumulative count is exposed once, not re-derived per caller");

  const cli = readFileSync(resolve(HERE, "scripts", "p2-anchor.ts"), "utf8");
  assert.match(cli, /countCommittedLedger\(ledger\)/, "the CLI must not keep a looser filter of its own");
  assert.doesNotMatch(cli, /\.filter\(\(e\) => e\.status === "anchored"\)\.length/, "status alone would count rows with no signature");
  const readAt = cli.indexOf("readLedger(args.ledger)");
  const saveAt = cli.indexOf("store.save(args.snapshot, ledger)");
  assert.ok(readAt >= 0 && saveAt > readAt, "the snapshot must be written after the ledger is read, or it freezes a stale total");
});

test("the Node API server hands every rendered surface the live ledger rows", () => {
  const src = readFileSync(resolve(HERE, "src", "api", "server.ts"), "utf8");
  assert.match(src, /const ledgerRows = \(\): LedgerEntry\[\] => readLedger\(LEDGER_PATH\)/, "one reader, defined once");
  assert.doesNotMatch(src, /store\.computeStats\(\)/, "no surface may render the counters without the ledger");
  const uses = (src.match(/store\.computeStats\(ledgerRows\(\)\)/g) ?? []).length;
  assert.ok(uses >= 3, `expected the state pulse, /api/state and the boot banner all to pass rows, saw ${uses}`);
  // A snapshot persisted without the ledger would freeze ledgerAnchored at the empty default -- a written-down
  // statistic that quietly disagrees with /api/ledger, which is the defect this pass is about.
  assert.doesNotMatch(src, /store\.save\(STATE_PATH\)/, "a saved snapshot must carry the ledger rows too");
  assert.equal((src.match(/store\.save\(STATE_PATH, /g) ?? []).length, 2, "both anchor paths persist against the ledger");
});

// ---- the served dashboard markup, which no test touched before ------------------------------------------

test("the telemetry tiles separate the two numbers, and no tile calls a verdict 'confirmed'", () => {
  const html = readFileSync(resolve(HERE, "web", "index.html"), "utf8");
  // Capture the opening tag (attributes, where the definition lives) with the number id and the label, so a title
  // belonging to a neighbouring tile can never satisfy the assertion for this one.
  const tiles = [...html.matchAll(/<div class="tel"([^>]*)>\s*<span class="tel-num" id="(stat-[a-z]+)">[^<]*<\/span><span class="tel-lbl">([^<]+)<\/span>/g)];
  assert.equal(tiles.length, 6, `expected six telemetry tiles, found ${tiles.length}`);
  const byId = new Map(tiles.map((m) => [m[2], { attrs: m[1], label: m[3] }]));
  assert.equal(byId.get("stat-anchored")?.label, "sealed as published", "the current-bytes count must not read as a total");
  assert.equal(byId.get("stat-commitments")?.label, "chain commitments", "the cumulative count needs its own tile");
  assert.equal(byId.get("stat-confirmed")?.label, "recovered", "a verdict tile labelled 'confirmed' contradicts the project's own wording rule");
  for (const [, tile] of byId) assert.doesNotMatch(tile.label, /confirm/i, `tile "${tile.label}" claims more than the pipeline can say`);
  for (const id of ["stat-anchored", "stat-commitments", "stat-confirmed"]) {
    assert.match(byId.get(id)?.attrs ?? "", /title="[^"]{60,}/, `${id} must carry its definition where a reader can hover it`);
  }
});

test("the board writes both tile numbers, and the stylesheet lays out the tile count that exists", () => {
  const app = readFileSync(resolve(HERE, "web", "app.js"), "utf8");
  assert.match(app, /\$\("#stat-anchored"\)\.textContent = stats\.bundlesAnchored/, "the stamp count");
  assert.match(app, /\$\("#stat-commitments"\)\.textContent = stats\.ledgerAnchored/, "the ledger count");
  assert.doesNotMatch(app, /chips\.push\(\["results sealed on-chain", stats\.bundlesAnchored/, "the ticker chip that implied a total is gone");
  assert.match(app, /chips\.push\(\["chain commitments recorded", stats\.ledgerAnchored/, "the ticker carries both numbers too");

  const css = readFileSync(resolve(HERE, "web", "styles.css"), "utf8");
  const rule = css.match(/\.telemetry \{[^}]*grid-template-columns: repeat\((\d+), 1fr\)/);
  assert.ok(rule, "the telemetry grid rule must exist");
  const html = readFileSync(resolve(HERE, "web", "index.html"), "utf8");
  const tiles = (html.match(/<div class="tel"/g) ?? []).length;
  assert.equal(Number(rule[1]), tiles, `the grid declares ${rule[1]} columns but the page renders ${tiles} tiles`);
});
