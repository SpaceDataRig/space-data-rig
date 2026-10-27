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
// Four checks, all deterministic and offline:
//   1. the section's "as of" date is not older than the newest dated entry in CHANGELOG's Unreleased block -- if the
//      changelog documents work newer than the handoff's snapshot, the snapshot is stale by its own record;
//   2. every commit sha the section names is reachable from HEAD, so it cannot cite a rewritten or invented commit;
//   3. the production bullet names a deployment revision next to the wrangler version, because "deployed" without a
//      sha is exactly the claim /health.gitSha exists to make checkable;
//   4. (round-25) that revision's src/ and web/ trees equal HEAD's, or the bullet admits the gap -- because a green CI
//      on a commit that nothing deploys says nothing about what the public receives. See R25-11's block below.
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
  // A wrangler VERSION / DEPLOY id is a hex UUID and looks exactly like a sha to a regex -- and the first run of this
  // gate duly reported it as an unreachable commit. The original strip matched only the `version <uuid>` form, which
  // broke the moment the production bullet named a second UUID (the deploy id) or backticked one: round-24 does both.
  // A UUID is never a commit, so strip every uuid-shaped token regardless of what precedes it.
  // KNOWN LIMITATION, left deliberately: the filter above keeps only the FIRST line of each bullet, so a sha written on
  // a continuation line is not checked at all. Widening it is not free -- those lines legitimately carry non-commit hex
  // (a scienceHash prefix, a byte count) -- so the reachability gate stays scoped to the bullet heads.
  const withoutVersions = lines.join("\n").replace(/`?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}`?/gi, "");
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

/**
 * ROUND-25 (R25-11): name-checking a sha is not the same as checking what it SHIPS.
 *
 * Round-24's F15 found this bullet two deploys behind reality and concluded that this gate "cannot catch this class"
 * because it never compares the named revision with the live endpoint. It still cannot -- CI has no network, and a test
 * that phones production is a test that fails on a plane. But the class is wider than a wrong id: round-25 committed a
 * fix to two SERVED files (`web/app.js`, `web/reports/index.json`), watched CI go green, and wrote "published" in the
 * ledger while the site was still serving the 2026-10-23 build, because NO workflow in this repository deploys
 * anything. That is the freshness gate's own failure mode -- computed but not published -- arriving in the handoff.
 *
 * The offline invariant that does exist: `wrangler deploy` ships exactly two trees, the Worker bundle from `src/` and
 * the static assets from `web/`. So the revision named as production must have the SAME `src/` and `web/` content as
 * HEAD, or the bullet must say out loud that it does not (marker: `awaiting deploy`). A later round that changes
 * runtime code and stops short of deploying is then forced into a sentence a reader can see, instead of a green badge
 * that means nothing. It cannot prove what the edge is serving; `/health` does that, and the bullet quotes its answer.
 */
test("the revision named as production ships the same src/ and web/ trees as HEAD, or the bullet says otherwise", () => {
  const s = section(handoff, "## 13. Current state");
  const lines = s.split("\n");
  const start = lines.findIndex((l) => /^-\s+Production:/i.test(l));
  const prod = start < 0 ? "" : (() => {
    // ROUND-26: the marker has to be searched for across the BULLET, not just its first line. The original
    // implementation took the single line matching "- Production:", so a disclosure written on the bullet's second or
    // third line -- where a careful writer naturally puts it, right next to the version id it qualifies -- did not count,
    // and the check failed for a formatting accident instead of for the silence it exists to catch. Scope widened to the
    // whole bullet, and the marker match made case-insensitive for the same reason.
    let end = start + 1;
    while (end < lines.length && !/^(?:-\s+\S|##\s)/.test(lines[end])) end++;
    return lines.slice(start, end).join("\n");
  })();
  const m = /gitSha ([0-9a-f]{7,40})/.exec(prod);
  assert.ok(m, "the production bullet must name a gitSha for this check to mean anything");
  const sha = m[1];
  assert.ok(reachable(sha), `the named revision ${sha} is not an ancestor of HEAD (or this checkout is too shallow to know)`);

  const differing = (dir: string): string[] => {
    const r = spawnSync("git", ["diff", "--name-only", `${sha}..HEAD`, "--", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, `git diff ${sha}..HEAD -- ${dir} failed: ${r.stderr}`);
    return (r.stdout || "").split("\n").filter(Boolean);
  };
  const shipped = [...differing("src"), ...differing("web")];
  if (shipped.length === 0) return; // production equals HEAD in exactly the two trees a deploy uploads
  assert.match(
    prod,
    /awaiting deploy/i,
    `the bullet calls ${sha.slice(0, 7)} production, but ${shipped.length} file(s) a deploy would upload differ between it and HEAD ` +
      `(${shipped.slice(0, 6).join(", ")}${shipped.length > 6 ? ", ..." : ""}). Either deploy, or say so in the bullet with the ` +
      `marker "awaiting deploy" so the next reader learns the gap from the handoff rather than from an incident.`,
  );
});
