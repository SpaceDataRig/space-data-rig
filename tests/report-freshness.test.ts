// REPORT FRESHNESS GATE -- offline behaviour drill (audit-6 #2).
//
// The failure class this closes: a report's numbers stay published after the input they were computed from
// changed (the RA-unit fix re-ran the P82 centroid checkpoint, but P84/P85 kept quoting wrong-sky figures,
// and the web/reports P81 page still showed "contradictions (4)" after the repository md said 0). Like the
// live-probe drill, we PROVE THE ALARM RINGS without network by feeding synthetic stamps + an injected hash
// function into the real decision logic that scripts/p86-report-library.ts calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareInputs,
  isProvenanceStale,
  evaluateAgainst,
  stampFromMeta,
  buildStamp,
  normalizeEol,
  normalizeInputRecords,
  sha256File,
  type FreshnessStamp,
} from "../scripts/report-freshness.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-17T12:00:00.000Z");

const stamp = (inputs: { path: string; sha256: string | null }[]): FreshnessStamp => ({
  generatedAt: new Date(T0).toISOString(),
  gitSha: "deadbeef",
  inputs,
});

/** A hash function backed by a fixed snapshot of the filesystem: path -> current content hash (null = gone). */
const hashFrom = (fs: Record<string, string | null>) => (path: string): string | null => (path in fs ? fs[path] : null);

test("compareInputs: HARD-STALE when a recorded checkpoint's bytes changed (the centroid re-run case)", () => {
  const r = compareInputs([{ path: "out/scaled/centroid.jsonl", recorded: "aaa", current: "bbb" }]);
  assert.equal(r.hardStale, true);
  assert.match(r.reasons.join(" "), /changed since this report was generated/);
});

test("compareInputs: a recorded input that is simply absent is NOT hard-stale (unverifiable, noted only)", () => {
  const r = compareInputs([{ path: "out/scaled/centroid.jsonl", recorded: "aaa", current: null }]);
  assert.equal(r.hardStale, false);
  assert.match(r.reasons.join(" "), /not present to re-verify/);
});

test("compareInputs: matching hashes stay fresh, and count as actually re-hashed", () => {
  assert.deepEqual(
    compareInputs([{ path: "x", recorded: "aaa", current: "aaa" }]),
    { hardStale: false, reasons: [], rehashed: 1, missing: 0, reproducible: 1, untracked: 0 },
  );
});

test("compareInputs: a matching input on a gitignored path re-hashes but is not reproducible", () => {
  const r = compareInputs([
    { path: "src/detect/bls.ts", recorded: "aaa", current: "aaa", tracked: true },
    { path: "out/scaled/centroid.jsonl", recorded: "bbb", current: "bbb", tracked: false },
  ]);
  assert.equal(r.rehashed, 2, "both really were compared against present bytes");
  assert.equal(r.reproducible, 1, "only the tracked one can be re-hashed by a stranger");
  assert.equal(r.untracked, 1);
  assert.equal(r.hardStale, false);
  assert.match(r.reasons.join(" "), /not tracked in the repository/);
});

test("compareInputs: unknown tracked-ness is not held against an input", () => {
  // Absence of git information is not evidence of being gitignored; treating null as false would publish
  // "nothing is verifiable" from a checkout that simply could not ask git.
  const r = compareInputs([{ path: "a.ts", recorded: "aaa", current: "aaa", tracked: null }]);
  assert.equal(r.reproducible, 1);
  assert.equal(r.untracked, 0);
});

test("compareInputs: an absent input is counted as missing, not as re-hashed", () => {
  const r = compareInputs([
    { path: "tracked.ts", recorded: "aaa", current: "aaa" },
    { path: "out/scaled/centroid.jsonl", recorded: "bbb", current: null },
  ]);
  assert.deepEqual({ rehashed: r.rehashed, missing: r.missing, hardStale: r.hardStale }, { rehashed: 1, missing: 1, hardStale: false });
});

test("compareInputs: a changed input is never counted as re-hashed even if another one matches", () => {
  const r = compareInputs([
    { path: "tracked.ts", recorded: "aaa", current: "aaa" },
    { path: "a.ts", recorded: "bbb", current: "CHANGED" },
  ]);
  assert.equal(r.hardStale, true);
  assert.equal(r.rehashed, 1, "the intact input was still re-hashed -- the report simply is not publishable");
});

test("isProvenanceStale: a source committed AFTER the report trips the gate; equal/before/unknown do not", () => {
  assert.equal(isProvenanceStale(T0, T0 + DAY), true); // input newer -> stale
  assert.equal(isProvenanceStale(T0, T0 - DAY), false); // input older -> fresh
  assert.equal(isProvenanceStale(T0, T0), false); // strictly newer only
  assert.equal(isProvenanceStale(T0, null), false); // no known input -> never guesses stale
  assert.equal(isProvenanceStale(Number.NaN, T0 + DAY), false); // unknown report time -> do not flag
});

test("evaluateAgainst: stamp with intact inputs is authoritative -- mtime noise cannot override a matching sha", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, {
    reportMs: T0,
    inputNewestMs: T0 + DAY, // checkpoint file looks newer...
    hash: hashFrom({ "out/scaled/centroid.jsonl": "aaa" }), // ...but its recorded hash still matches
  });
  assert.equal(v.stamped, true);
  assert.equal(v.stale, false);
});

test("evaluateAgainst: stamp with a tampered input is stale (the published-stale-numbers bug)", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "out/scaled/centroid.jsonl": "CHANGED" }) });
  assert.equal(v.stale, true);
  assert.equal(v.fresh, false);
});

test("evaluateAgainst: a vanished recorded input is NOT hard-stale (unverifiable, noted; provenance is only a soft note)", () => {
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const v = evaluateAgainst(s, { reportMs: T0, inputNewestMs: T0 + DAY, hash: hashFrom({ "out/scaled/centroid.jsonl": null }) });
  assert.equal(v.stale, false); // a gitignored checkpoint cleaned up must never block a deploy
  assert.match(v.reasons.join(" "), /not present to re-verify/);
  assert.match(v.reasons.join(" "), /informational, not blocking/);
});

test("evaluateAgainst: legacy / unstamped reports are NEVER hard-stale -- no wall-clock false positives", () => {
  // Regression guard: an unrelated later commit touching a shared source (a lint fix, a refactor) used to
  // mark every old report stale and block publishes. Staleness now requires a RECORDED input sha mismatch.
  const unstampedNewer = evaluateAgainst(null, { reportMs: T0, inputNewestMs: T0 + 30 * DAY });
  assert.equal(unstampedNewer.stale, false);
  assert.equal(unstampedNewer.stamped, false);
  assert.match(unstampedNewer.reasons.join(" "), /no freshness stamp/);
  const stampedNoInputs = evaluateAgainst(stamp([]), { reportMs: T0, inputNewestMs: T0 + 30 * DAY });
  assert.equal(stampedNoInputs.stale, false);
  assert.match(stampedNoInputs.reasons.join(" "), /records no input checkpoint/);
});

// `stamped` means "carries a generatedAt timestamp"; `verified` means "the gate re-hashed at least one
// recorded input checksum and it matched". Conflating them let the published p89 artifact -- which has a
// timestamp but NO inputs at all, because its generator grew the stamp wiring after that artifact was
// written -- count toward the site's "N stamped" figure as though it had been machine-checked.
test("verified vs stamped: only a re-hashed matching checksum counts as verified", () => {
  const intact = evaluateAgainst(stamp([{ path: "a.ts", sha256: "aaa" }]), {
    reportMs: T0, inputNewestMs: null, hash: hashFrom({ "a.ts": "aaa" }),
  });
  assert.equal(intact.stamped, true);
  assert.equal(intact.verified, true, "a recorded checksum that still matches IS machine-verified");

  const tampered = evaluateAgainst(stamp([{ path: "a.ts", sha256: "aaa" }]), {
    reportMs: T0, inputNewestMs: null, hash: hashFrom({ "a.ts": "CHANGED" }),
  });
  assert.equal(tampered.stale, true);
  assert.equal(tampered.verified, false, "a mismatching checksum must not read as verified");

  // The p89 published shape: a timestamp and zero recorded inputs.
  const stampedOnly = evaluateAgainst(stamp([]), { reportMs: T0, inputNewestMs: null });
  assert.equal(stampedOnly.stamped, true);
  assert.equal(stampedOnly.verified, false, "a timestamp alone proves nothing about the inputs");

  // The p79 shape: input paths declared as bare strings, normalised to sha256 null.
  const hashless = evaluateAgainst(stamp(normalizeInputRecords(["a.ts", "b.json"])), { reportMs: T0, inputNewestMs: null });
  assert.equal(hashless.stamped, true);
  assert.equal(hashless.verified, false, "declared-but-unhashed inputs cannot be re-verified");
  assert.match(hashless.reasons.join(" "), /cannot be re-verified/);

  const legacy = evaluateAgainst(null, { reportMs: T0, inputNewestMs: null });
  assert.equal(legacy.stamped, false);
  assert.equal(legacy.verified, false);
});

// The second half of that distinction (audit b2, 2026-10-18). Three of the four published "verified"
// reports stamp checksums over out/scaled/*.jsonl -- a gitignored working directory. On the machine that ran
// them the re-hash is real; on any fresh clone the files do not exist, and the old code still reported
// verified:true because it looked at whether a checksum had been RECORDED rather than whether one could be
// COMPARED. A recorded checksum is a promise to check, not a check.
test("a checksum that cannot be compared here does NOT count as verified", () => {
  const v = evaluateAgainst(stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]), {
    reportMs: T0, inputNewestMs: null, hash: hashFrom({ "out/scaled/centroid.jsonl": null }),
  });
  assert.equal(v.stale, false, "an absent input must still never block a deploy");
  assert.equal(v.verified, false, "nothing was re-hashed, so nothing was verified");
  assert.equal(v.rehashed, 0);
  assert.equal(v.unverifiableInputs, 1);
  assert.match(v.reasons.join(" "), /not machine-verified on this checkout/);
});

test("partly re-hashed is reported as partly re-hashed, not as verified-wholly", () => {
  const v = evaluateAgainst(stamp([
    { path: "src/data/toiDispositions.ts", sha256: "aaa" },
    { path: "out/scaled/centroid.jsonl", sha256: "bbb" },
  ]), { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "src/data/toiDispositions.ts": "aaa", "out/scaled/centroid.jsonl": null }) });
  assert.equal(v.verified, true, "one recorded input really was re-hashed and matched");
  assert.equal(v.rehashed, 1);
  assert.equal(v.unverifiableInputs, 1, "and the reader must be able to see the one that was not");
  assert.match(v.reasons.join(" "), /out\/scaled\/centroid\.jsonl is not present to re-verify/);
});

test("a report whose only matching inputs are gitignored is NOT verified, even though the hashes agree", () => {
  // The published p82/p84/p85 shape: a stamp over out/scaled/*.jsonl. On the workstation that ran them every
  // checksum matched; on a fresh clone there is nothing to match, so "verified" would be a claim about one
  // machine presented as a property of the repository.
  const s = stamp([{ path: "out/scaled/centroid.jsonl", sha256: "aaa" }]);
  const here = evaluateAgainst(s, {
    reportMs: T0, inputNewestMs: null,
    hash: hashFrom({ "out/scaled/centroid.jsonl": "aaa" }),
    tracked: () => false,
  });
  assert.equal(here.rehashed, 1, "the bytes really did match on this machine");
  assert.equal(here.reproducible, 0);
  assert.equal(here.verified, false, "and yet no stranger can reproduce that check");
  assert.match(here.reasons.join(" "), /only on the workstation that generated it/);

  // Mixed: one tracked input matching plus one gitignored one -- verified, but visibly not wholly.
  const mixed = evaluateAgainst(stamp([{ path: "src/detect/bls.ts", sha256: "aaa" }, { path: "out/scaled/centroid.jsonl", sha256: "bbb" }]), {
    reportMs: T0, inputNewestMs: null,
    hash: hashFrom({ "src/detect/bls.ts": "aaa", "out/scaled/centroid.jsonl": "bbb" }),
    tracked: (p) => p.startsWith("src/"),
  });
  assert.equal(mixed.verified, true);
  assert.equal(mixed.reproducible, 1);
  assert.equal(mixed.untrackedInputs, 1, "the page must show which input is the private one");
});

test("verified never exceeds stamped, and no report is verified while stale", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync("web/reports/index.json")) return;
  const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8")) as {
    freshness?: { stamped?: number; verified?: number; fullyVerified?: number; unattested?: number; total?: number; stale?: string[] };
    reports?: { id: string; stamped?: boolean; verified?: boolean; fresh?: boolean; rehashed?: number; reproducible?: number; unverifiableInputs?: number; untrackedInputs?: number }[];
  };
  const rs = idx.reports ?? [];
  if (!rs.length) return;
  for (const r of rs) {
    if (r.verified) assert.equal(r.stamped, true, `${r.id}: verified without a stamp is impossible`);
    if (r.verified) assert.notEqual(r.fresh, false, `${r.id}: a stale report must never be published as verified`);
    if (r.verified) assert.ok((r.reproducible ?? 0) > 0, `${r.id}: published as verified although no TRACKED input was re-hashed`);
    if (!r.verified && r.fresh !== false) assert.equal(r.reproducible ?? 0, 0, `${r.id}: fresh and reproducible, yet published as not verified`);
    // Every entry must publish its partial-verification counts, or "verified" silently reverts to meaning
    // whatever the reader assumes it means.
    assert.equal(typeof r.rehashed, "number", `${r.id}: no rehashed count published`);
    assert.equal(typeof r.reproducible, "number", `${r.id}: no reproducible count published`);
    assert.equal(typeof r.untrackedInputs, "number", `${r.id}: no untracked-input count published`);
    assert.equal(typeof r.unverifiableInputs, "number", `${r.id}: no unverifiable-input count published`);
    assert.ok((r.reproducible ?? -1) <= (r.rehashed ?? 0), `${r.id}: reproducible cannot exceed rehashed`);
  }
  const f = idx.freshness ?? {};
  assert.ok((f.verified ?? 0) <= (f.stamped ?? 0), "aggregate verified must not exceed aggregate stamped");
  assert.ok((f.fullyVerified ?? 0) <= (f.verified ?? 0), "fully verified is a subset of verified");
  assert.equal(f.fullyVerified, rs.filter((r) => r.verified && (r.unverifiableInputs ?? 0) === 0 && (r.untrackedInputs ?? 0) === 0).length, "fullyVerified must equal the entries whose every recorded input was tracked, present and matching");
  assert.equal(f.verified, rs.filter((r) => r.verified).length, "aggregate verified must equal the per-entry count");
  assert.equal(f.total, rs.length, "freshness.total must equal the number of report entries");
  // audit-14 N6: the unattested mass is a first-class number, not inferred -- a `fresh:true` with no stamp is
  // "not known stale", never "verified current", and the index must expose how many reports are in that state.
  assert.equal(f.unattested, (f.total ?? 0) - (f.stamped ?? 0), "freshness.unattested must equal total minus stamped");
  assert.equal(f.unattested, rs.filter((r) => !r.stamped).length, "aggregate unattested must equal the per-entry unstamped count");
});

test("a verified report whose inputs are all present claims no partial note", () => {
  const s = stamp([{ path: "a.ts", sha256: "aaa" }]);
  const full = evaluateAgainst(s, { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "a.ts": "aaa" }) });
  assert.equal(full.verified, true);
  assert.equal(full.unverifiableInputs, 0, "nothing missing: the page must not say PARTLY RE-VERIFIED");
  const partial = evaluateAgainst(stamp([{ path: "a.ts", sha256: "aaa" }, { path: "gone.jsonl", sha256: "bbb" }]), {
    reportMs: T0, inputNewestMs: null, hash: hashFrom({ "a.ts": "aaa", "gone.jsonl": null }),
  });
  assert.equal(partial.unverifiableInputs, 1, "the case the green note exists for");
});

test("stampFromMeta: reads nested + flat shapes, rejects legacy metas with no generatedAt", () => {
  assert.equal(stampFromMeta({ generatedAt: "2026-10-17T00:00:00Z", gitSha: "abc", inputs: [{ path: "p", sha256: "h" }] })?.gitSha, "abc");
  assert.equal(stampFromMeta({ generatedBy: "scripts/p59-offtarget-subset.ts" }), null); // the pre-gate meta shape
  assert.equal(stampFromMeta(undefined), null);
});

test("buildStamp: stamps a real repo file and reads it back through stampFromMeta", () => {
  const s = buildStamp(["scripts/report-freshness.ts"]);
  assert.match(s.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.inputs[0].path, "scripts/report-freshness.ts");
  assert.match(s.inputs[0].sha256 ?? "", /^[0-9a-f]{64}$/);
  const back = stampFromMeta(s);
  assert.deepEqual(back?.inputs, s.inputs);
});

test("the gate re-flags a real committed report when its recorded checkpoint is tampered (end-to-end wiring)", async () => {
  // Read the actual stamped P85 json shipped in the repo, keep its recorded hashes but pretend the
  // checkpoint changed, and confirm the same function p86 calls says STALE.
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync("reports/p85-contaminant-fit.json")) return; // report set varies; skip silently if absent
  const meta = (JSON.parse(readFileSync("reports/p85-contaminant-fit.json", "utf8")) as { meta?: unknown }).meta;
  const s = stampFromMeta(meta);
  if (!s || !s.inputs.length) return; // P85 not yet regenerated with a stamp on this checkout
  const v = evaluateAgainst(s, { reportMs: T0 + 10 * DAY, inputNewestMs: null, hash: () => "0".repeat(64) });
  assert.equal(v.stale, true);
});

// ---- line-ending independence (audit-6 follow-up) -----------------------------------------------
//
// REGRESSION THIS PINS: the CI bot published reports/p59-offtarget-subset.json from LF bytes; on a Windows
// checkout with core.autocrlf=true the very same tracked .ts inputs materialise as CRLF, so hashing raw
// bytes declared a report the bot had just written to be HARD-STALE and blocked the deploy -- while
// `git show HEAD:<path>` proved nothing had changed. The hash must depend on CONTENT, not on the platform
// that happens to have checked it out.

test("normalizeEol: CRLF and lone CR fold to LF; LF-only content is returned unchanged", () => {
  assert.deepEqual(normalizeEol(Buffer.from("a\r\nb\r\n")), Buffer.from("a\nb\n"));
  assert.deepEqual(normalizeEol(Buffer.from("a\rb")), Buffer.from("a\nb"));
  const lf = Buffer.from("a\nb\n");
  assert.equal(normalizeEol(lf), lf); // identity, not a copy: the fast path must not rewrite anything
});

test("normalizeEol: binary content is NEVER rewritten even when it contains CR bytes", () => {
  // git treats a NUL in the leading bytes as binary and skips EOL conversion; so must we, or a .fits/.png
  // input would hash differently here than in CI.
  const bin = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(normalizeEol(bin), bin);
  assert.deepEqual(normalizeEol(bin), bin);
});

test("sha256File: the SAME text hashes identically from a CRLF file and an LF file (platform independence)", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = tmpdir();
  const crlf = join(dir, "sdr-freshness-crlf.txt");
  const lf = join(dir, "sdr-freshness-lf.txt");
  try {
    writeFileSync(crlf, "line one\r\nline two\r\n");
    writeFileSync(lf, "line one\nline two\n");
    const a = sha256File(crlf);
    const b = sha256File(lf);
    assert.match(a ?? "", /^[0-9a-f]{64}$/);
    assert.equal(a, b, "CRLF and LF renderings of the same text must produce the same stamp");
    // And a genuine content change must still be caught -- normalising must not blind the gate.
    writeFileSync(lf, "line one\nline CHANGED\n");
    assert.notEqual(sha256File(lf), a);
    assert.equal(sha256File(join(dir, "sdr-does-not-exist.txt")), null);
  } finally {
    rmSync(crlf, { force: true });
    rmSync(lf, { force: true });
  }
});

// ---- hand-written / hash-less input declarations -------------------------------------------------

test("normalizeInputRecords: bare path strings become visible {path, sha256:null} instead of being dropped", () => {
  // The real p79-benchmark.json shape: inputs declared as plain strings. The old strict filter discarded
  // them, so the report looked fully verified when nothing about it could be checked.
  assert.deepEqual(normalizeInputRecords(["reports/p47-completeness-grid.json", "reports/p78-blind-multisector.json"]), [
    { path: "reports/p47-completeness-grid.json", sha256: null },
    { path: "reports/p78-blind-multisector.json", sha256: null },
  ]);
  assert.deepEqual(normalizeInputRecords([{ path: "p", sha256: "h" }]), [{ path: "p", sha256: "h" }]);
  assert.deepEqual(normalizeInputRecords([{ path: "p" }]), [{ path: "p", sha256: null }]); // object with no hash
  assert.deepEqual(normalizeInputRecords(["", null, 42, {}, { sha256: "h" }]), []); // junk contributes nothing
});

test("stampFromMeta: keeps the p79 bare-string inputs rather than silently emptying them", () => {
  const s = stampFromMeta({ generatedAt: "2026-10-17T00:00:00Z", inputs: ["reports/p47-completeness-grid.json"] });
  assert.equal(s?.inputs.length, 1);
  assert.equal(s?.inputs[0].path, "reports/p47-completeness-grid.json");
  assert.equal(s?.inputs[0].sha256, null);
});

test("evaluateAgainst: inputs declared but never hashed are NOT stale, and say they cannot be re-verified", () => {
  const s = stamp([{ path: "reports/p47-completeness-grid.json", sha256: null }]);
  const v = evaluateAgainst(s, { reportMs: T0, inputNewestMs: T0 + DAY, hash: hashFrom({}) });
  assert.equal(v.stale, false, "an unhashable declaration must never block a deploy");
  assert.equal(v.stamped, true);
  assert.match(v.reasons.join(" "), /records no sha256 for them/);
  // Crucially it must NOT read as clean-and-verified: the gap has to be in the reasons.
  assert.ok(v.reasons.length > 0);
});

test("evaluateAgainst: one hashed input alongside a hash-less one still verifies the hashed one", () => {
  const s = stamp([{ path: "a.json", sha256: null }, { path: "b.jsonl", sha256: "bbb" }]);
  const ok = evaluateAgainst(s, { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "b.jsonl": "bbb" }) });
  assert.equal(ok.stale, false);
  assert.doesNotMatch(ok.reasons.join(" "), /records no sha256/); // at least one input WAS verifiable
  const bad = evaluateAgainst(s, { reportMs: T0, inputNewestMs: null, hash: hashFrom({ "b.jsonl": "zzz" }) });
  assert.equal(bad.stale, true);
});

test("the published builtAtGitSha is reachable from HEAD, never a dangling rewritten commit", async () => {
  // REGRESSION. p86 was built, then the commit carrying its output was AMENDED, so web/reports/index.json
  // went out naming a commit that lived only in the local object database and was never pushed -- a
  // provenance field that resolves to nothing on the remote, which is worse than naming no commit at all.
  // Rebuilding after the rewrite is the fix; this pins the invariant so an amend or rebase after a build
  // cannot silently publish an unreachable SHA again. Note the field legitimately trails HEAD by the one
  // commit that ships the artifact (see shaNote in p86) -- a parent IS an ancestor, so that still passes.
  const { readFileSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  if (!existsSync("web/reports/index.json")) return; // not built on this checkout
  const idx = JSON.parse(readFileSync("web/reports/index.json", "utf8")) as { builtAtGitSha?: string };
  const sha = idx.builtAtGitSha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return; // pre-rename artifact, or built with git unavailable
  let type = "";
  try {
    type = execFileSync("git", ["cat-file", "-t", sha], { encoding: "utf8" }).trim();
  } catch {
    return; // shallow clone or no git: the object is legitimately absent, nothing to assert
  }
  if (type !== "commit") return;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { encoding: "utf8" });
  } catch {
    assert.fail(
      `web/reports/index.json publishes builtAtGitSha ${sha.slice(0, 12)}, which is not an ancestor of HEAD. ` +
        "Re-run npm run p86:report-library after any amend/rebase so the artifact never names an unreachable commit.",
    );
  }
});
