// GOVERNANCE: every commit is co-signed, so check the commit that is HEAD rather than trust the habit.
//
// WHY THIS EXISTS. GOVERNANCE.md states that changes land under an explicitly-labelled automated identity and
// that "commits are co-signed"; HANDOFF.md documents how -- author sdr-bot (Space Data Rig <bot@spacedatarig.app>)
// plus the trailer `Co-authored-by: Space Data Rig <dev@spacedatarig.app>` naming the human owner. Two commits were
// pushed (2026-10-18, the seventh audit pass) with the trailer missing, and nothing failed: the convention lived
// only in prose, so it depended on remembering it under a different context each time. That is the same failure mode
// this project has already fixed for ASCII hygiene, over-claim wording and deploy-tree cleanliness -- a rule with
// no gate is a rule that quietly lapses.
//
// The history is NOT rewritten to fix the two commits (they are pushed; amending published commits would destroy
// the provenance the ledger and devlog reference). The correction recorded instead is this gate, plus a CHANGELOG
// line stating the deviation plainly.
//
// Scope, stated so the test cannot be satisfied by an unrelated commit: it checks the HEAD commit message only.
// Verifying the whole log would be a different, heavier question (historical commits predate the convention), and a
// gate over the thing you are about to push is the one that fires in time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const TRAILER = "Co-authored-by: Space Data Rig <dev@spacedatarig.app>";

/** Read a git field from HEAD; undefined when there is no repository (e.g. an extracted tarball build). */
function headField(format: string): string | undefined {
  try {
    return execFileSync("git", ["log", "-1", `--format=${format}`], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

test("the HEAD commit carries the co-sign trailer GOVERNANCE.md promises", { skip: headField("%H") === undefined ? "no git repository available" : false }, () => {
  const body = headField("%B") ?? "";
  assert.ok(body.includes(TRAILER), `HEAD commit message is missing the co-sign trailer "${TRAILER}" -- GOVERNANCE.md says commits are co-signed`);
});

test("the HEAD commit is authored by the labelled automated identity, not a machine default", { skip: headField("%H") === undefined ? "no git repository available" : false }, () => {
  const email = headField("%ae") ?? "";
  const name = headField("%an") ?? "";
  // The point of the labelled identity is that a reader can tell an automated landing commit from a stray local
  // machine account (Administrator@<host>), which is what git falls back to when no identity is supplied.
  assert.ok(/@spacedatarig\.app$/.test(email), `unexpected author email "${email}" -- the labelled bot or owner identity is required`);
  assert.match(name, /Space Data Rig/, "the labelled identity, not a workstation name");
});
