// HANDOFF currency gate -- the handover document may not claim to describe the current state while describing
// last week's.
//
// WHY THIS EXISTS. HANDOFF.md section 13 is titled "Current state (as of ...)" and is the first thing a successor
// reads: which commit is tip, what production runs, which switches are live, how many tests exist. In this pass it
// said "as of 2026-10-13" with HEAD 148ff2c while the repository had moved ~60 commits and six audit passes beyond
// it -- every statement in the section was true of a state of affairs that no longer held, which is the same defect
// class as the counter labels (a published field that stopped matching the thing it describes). Sections 1-12 are a
// map and a rulebook: they age slowly. Section 13 is a snapshot: it rots on every deploy, so it needs a clock.
//
// Three checks, all deterministic and offline:
//   1. the section's "as of" date is not older than the newest dated entry in CHANGELOG's Unreleased block -- if the
//      changelog documents work newer than the handoff's snapshot, the snapshot is stale by its own record;
//   2. every commit sha the section names is reachable from HEAD, so it cannot cite a rewritten or invented commit;
//   3. the production bullet names a deployment revision next to the wrangler version, because "deployed" without a
//      sha is exactly the claim /health.gitSha exists to make checkable.
//
// A test that only passes when the doc is edited to satisfy it is still worth having: the point is that the edit
// happens, close to the work, instead of never.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = resolve(process.cwd());
const handoff = readFileSync(resolve(HERE, "HANDOFF.md"), "utf8");
const changelog = readFileSync(resolve(HERE, "CHANGELOG.md"), "utf8");

/** The body of a `## N.` section, up to the next `## ` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  assert.ok(start >= 0, `${heading} is missing -- the gate has nothing to check`);
  const next = md.indexOf("\n## ", start + heading.length);
  return md.slice(start, next > 0 ? next : md.length);
}

const DATE = /(20\d{2})-(\d{2})-(\d{2})/;

/** ISO date as a comparable integer; later sorts higher. */
const dmy = (m: RegExpMatchArray): number => Number(`${m[1]}${m[2]}${m[3]}`);

function newestDate(text: string): number {
  const found = [...text.matchAll(new RegExp(DATE.source, "g"))].map((m) => dmy(m));
  assert.ok(found.length, "no date to compare against");
  return Math.max(...found);
}

/** Is `sha` (short or full) an ancestor of HEAD? git decides; a non-zero exit means no. */
function reachable(sha: string): boolean {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/**
 * A shallow clone cannot answer the ancestor question at all -- every real ancestor looks unreachable. CI therefore
 * checks out with fetch-depth: 0 (see .github/workflows/ci.yml); this makes the reason legible if that is ever
 * reverted, instead of reporting a hand-written commit as invented.
 */
test("the checkout carries enough history to ask about ancestors", () => {
  const r = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" });
  const shallow = (r.stdout || "").trim() === "true";
  assert.ok(!shallow, "this checkout is shallow, so commit reachability is unknowable here -- run with full history (fetch-depth: 0)");
});

test("section 13 exists and carries an explicit as-of date", () => {
  const s = section(handoff, "## 13. Current state");
  const header = s.split("\n")[0];
  assert.match(header, /as of 20\d\d-\d\d-\d\d/, `the snapshot must state its date, got: ${header}`);
});

test("the handoff snapshot is not older than the newest changelog entry it should already reflect", () => {
  const s = section(handoff, "## 13. Current state");
  const asOf = dmy(s.split("\n")[0].match(DATE) as unknown as RegExpMatchArray);
  const unreleased = section(changelog, "## Unreleased");
  let newestDoc = 0;
  try {
    newestDoc = newestDate(unreleased);
  } catch {
    newestDoc = 0; // an Unreleased block with no dated entries cannot outdate anything
  }
  assert.ok(
    asOf >= newestDoc,
    `HANDOFF section 13 is dated ${asOf} but CHANGELOG documents work dated ${newestDoc}. The handover document is ` +
      `describing a previous state of the project while claiming not to -- refresh section 13 from the live rig.`,
  );
});

test("every commit sha section 13 names is reachable from HEAD", () => {
  const s = section(handoff, "## 13. Current state");
  // Only shas on a "Git:" / "Production:" bullet -- prose elsewhere legitimately cites commits by subject too.
  const lines = s.split("\n").filter((l) => /^-\s+(Git|Production):/i.test(l));
  assert.ok(lines.length >= 1, "section 13 must record where git and production stand");
  // A wrangler VERSION id is a hex UUID and looks exactly like a sha to a regex -- and the first run of this gate
  // duly reported it as an unreachable commit. Take the version out before asking about commits.
  const withoutVersions = lines.join("\n").replace(/version\s+[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "");
  const shas = [...new Set(withoutVersions.match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
  assert.ok(shas.length >= 1, "the state bullets must name commit shas, not just say 'latest'");
  for (const sha of shas) {
    assert.ok(reachable(sha), `section 13 cites ${sha}, which is not an ancestor of HEAD -- rewritten, wrong, or invented`);
  }
});

test("the production bullet names the deployed revision, not only a wrangler version", () => {
  const s = section(handoff, "## 13. Current state");
  const prod = s.split("\n").find((l) => /^-\s+Production:/i.test(l)) ?? "";
  assert.match(prod, /version [0-9a-f-]{36}/, "the wrangler version id is the deploy's own identity");
  assert.match(
    prod,
    /gitSha [0-9a-f]{7,40}/,
    "and the revision it was built from -- /health.gitSha is what makes 'deployed' checkable, so the handoff quotes the same pair",
  );
});
