// post-x-text.ts is a CLI whose refusals ARE the behaviour, so this drives the real script rather than a mock.
// The test environment has no X credentials (and they are forced empty here), so an accepted text is a DRY RUN and
// nothing is sent. These cases pin the send-time feed red-line guard that closes the asymmetry with
// tests/devlog-archive.test.ts: text the archive would reject (a relative time word, or wallet / spend wording)
// must never be postable in the first place, and a clean text must still reach the DRY RUN rather than be
// over-refused. Both guards import the SAME predicate from science-digest.ts, so they cannot disagree. Round-18
// adds two nets the money/time/discovery guards all missed: the widened FEED_SPEND_WORDS (the project's own
// currency vocabulary -- $SDR / burn / fee / spend / lamports / rent / payout) and a coverage/capability net that
// refuses a totality claim ("reads the whole catalog") unless its sentence carries a denominator ("34 of 103").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { FEED_TIME_WORDS, FEED_SPEND_WORDS, feedCoverageViolations, overclaimViolations } from "../scripts/science-digest.ts";

const SCRIPT = new URL("../scripts/post-x-text.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HERE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Run the real sender with credentials forced empty, so the only outcomes are REFUSED (exit 1) or DRY RUN (exit 0). */
function send(text: string): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--text", text, "--max-len", "25000"], {
      encoding: "utf8",
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, X_API_KEY: "", X_API_SECRET: "", X_ACCESS_TOKEN: "", X_ACCESS_TOKEN_SECRET: "" },
    });
    return { status: 0, stderr: "", stdout };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? ""), stdout: String(err.stdout ?? "") };
  }
}

// CLEAN must survive ALL FOUR send-time nets (ASCII/length, over-claim, feed red lines, coverage). It states a
// coverage figure WITH its denominator, because the round-18 coverage net refuses a totality claim that lacks one.
// The round-17 fixture said "reads all 103 catalog rows" -- which is exactly the over-claim the new net catches --
// so CLEAN now reads "covers 103 of 103 rows ... can fire on 34 of 103 rows (33.0%)": a real, verifiable basis.
const CLEAN =
  "Eighteenth-round audit of the rig: designator parsing covers 103 of 103 catalog rows, while the " +
  "label-conflict predicate can fire on 34 of 103 rows (33.0%), and the conflict count moved from 5 to 7 " +
  "with no anchored ledger row changed.";

test("the send guard REFUSES a relative time word -- the same red line the archive enforces", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. The catalog today holds only A components, " +
      "so the live host count stays exactly 90 over 103 records.",
  );
  assert.equal(r.status, 1, "a time-worded post must exit non-zero");
  assert.match(r.stderr, /REFUSED/, "and say REFUSED");
  assert.match(r.stderr, /time-implying/i, "and name the time-word reason");
});

test("the send guard REFUSES wallet / key / spend wording", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. The wallet balance is unchanged and the " +
      "anchored ledger rows are intact.",
  );
  assert.equal(r.status, 1, "spend wording must exit non-zero");
  assert.match(r.stderr, /REFUSED/, "and say REFUSED");
  assert.match(r.stderr, /wallet\/spend/i, "and name the wallet/spend reason");
});

test("a clean text is NOT refused -- it reaches the DRY RUN and nothing is sent", () => {
  const r = send(CLEAN);
  assert.equal(r.status, 0, `expected a clean DRY RUN, stderr: ${r.stderr}`);
  assert.match(r.stdout, /DRY RUN/, "and report the DRY RUN");
});

test("guard the guard: the clean fixture trips no time, spend, coverage, or over-claim red line", () => {
  // If CLEAN ever tripped a red line, the DRY RUN case above would be asserting the wrong thing. Uses the SAME
  // shared predicates the sender uses, so this check cannot drift from the guard it is checking.
  assert.ok(!FEED_TIME_WORDS.test(CLEAN), "no time word");
  assert.ok(!FEED_SPEND_WORDS.test(CLEAN), "no spend word");
  assert.deepEqual(feedCoverageViolations(CLEAN), [], "no un-denominated coverage/reach claim");
  assert.deepEqual(overclaimViolations(CLEAN), [], "no over-claim stem");
});

// ---- round-18 audit item 2: FEED_SPEND_WORDS is a rule, not a narrow word-list ------------------------------
// The old word-list (wallet|private key|secret key|seed phrase|cost|usd|sol|$<digit>) let the project's OWN
// currency vocabulary through -- 8 of 19 auditor probes were measurable misses. Every probe below must now be
// REFUSED at send, and named as a wallet/spend hit rather than refused for some unrelated reason.
test("the send guard REFUSES the project's own currency vocabulary ($SDR / burn / fee / spend / lamports / rent / payout)", () => {
  const probes = [
    "A status line about the rig long enough to be a real post. The $SDR balance is unchanged.",
    "A status line about the rig long enough to be a real post. We burn the mint token each pass.",
    "A status line about the rig long enough to be a real post. The burned tokens are logged.",
    "A status line about the rig long enough to be a real post. A small fee anchors the batch.",
    "A status line about the rig long enough to be a real post. The spend per pass stayed at zero.",
    "A status line about the rig long enough to be a real post. Lamports are reserved for anchoring.",
    "A status line about the rig long enough to be a real post. Rent is exempt on the account.",
    "A status line about the rig long enough to be a real post. The payout address is untouched.",
  ];
  for (const p of probes) {
    const r = send(p);
    assert.equal(r.status, 1, `must REFUSE: ${p}`);
    assert.match(r.stderr, /REFUSED/, `must say REFUSED: ${p}`);
    assert.match(r.stderr, /wallet\/spend/i, `must name the wallet/spend reason: ${p}`);
  }
});

// ---- round-18 audit item 1: a coverage/capability net the money/time/discovery nets all missed ----------------
// "the predicate ... reads the whole catalog" is a CAPABILITY claim, not a money/time/discovery claim, so it passed
// all three old nets. The new net refuses a coverage totality with no denominator, and passes the same claim once
// it states its basis -- which is the correction the round-17 public post needed.
test("the send guard REFUSES a coverage totality claim with no denominator (the round-17 'reads the whole catalog')", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. The predicate now decodes a candidate " +
      "number to its planet letter, so it reads the whole catalog.",
  );
  assert.equal(r.status, 1, "an un-denominated 'reads the whole catalog' must exit non-zero");
  assert.match(r.stderr, /REFUSED/, "and say REFUSED");
  assert.match(r.stderr, /coverage|denominator/i, "and name the coverage reason");
});

test("the send guard PASSES the same coverage claim once it carries its denominator", () => {
  const r = send(
    "A status line about the rig long enough to be a real post. Designator parsing covers 103 of 103 rows, " +
      "and the conflict predicate can fire on 34 of 103 rows (33.0%).",
  );
  assert.equal(r.status, 0, `a denominator-bearing coverage claim is postable, stderr: ${r.stderr}`);
  assert.match(r.stdout, /DRY RUN/, "and reaches the DRY RUN");
});

test("the coverage net does NOT over-refuse honest quantifier prose (no coverage verb, no totality idiom)", () => {
  // Over-refusal is its own failure: these are honest sentences a quantifier-only rule would have wrongly blocked.
  const r = send(
    "A status line about the rig long enough to be a real post. Every candidate it produces is UNCONFIRMED, " +
      "and all 72 re-checked rows kept their prior verdict.",
  );
  assert.equal(r.status, 0, `honest quantifier prose must stay postable, stderr: ${r.stderr}`);
  assert.match(r.stdout, /DRY RUN/, "and reaches the DRY RUN");
});

// ---- round-19 audit: the round-18 nets must not over-refuse honest technical prose ---------------------------
// Measured false hits BEFORE the round-19 narrowing: "MCMC burn-in" / "CCD burn-in" (a methods staple) and
// "Sol" / "sol" (the Sun, a Martian day) tripped FEED_SPEND_WORDS, and true processing totalities ("reads the
// whole light curve", "scans every sector") tripped the coverage net even though they are not reach claims at
// all. Over-refusal silently blocks honest posts, so both directions are pinned clean here. The one accepted
// residual (a citation surname, "Burns 2019") is pinned as a DELIBERATE catch: loosening the money rule for it
// must be a decision, not a drift.
test("the spend rule does NOT over-refuse methods / astronomy prose (burn-in, Sol, sol)", () => {
  for (const frag of ["MCMC burn-in", "CCD burn-in", "a burn-in period", "the Sun (Sol)", "per sol"]) {
    const text = `A status line about the rig long enough to be a real post. It mentions ${frag} only.`;
    assert.ok(!FEED_SPEND_WORDS.test(text), `must not trip spend: ${frag}`);
    const r = send(text);
    assert.equal(r.status, 0, `honest technical prose must stay postable, stderr: ${r.stderr}`);
  }
});

test("the spend rule still catches the token-burn forms, and the surname residual stays a deliberate catch", () => {
  assert.ok(FEED_SPEND_WORDS.test("we burn the mint token"), "burn");
  assert.ok(FEED_SPEND_WORDS.test("the burned tokens"), "burned");
  assert.ok(FEED_SPEND_WORDS.test("burning supply"), "burning");
  assert.ok(FEED_SPEND_WORDS.test("Burns 2019"), "documented residual: citation surname still refused by design");
});

test("the coverage net does NOT over-refuse true processing totalities (light curve / sector)", () => {
  for (const frag of ["reads the whole light curve", "scans every sector", "covers the full sector"]) {
    const text = `A status line about the rig long enough to be a real post. The aperture ${frag}.`;
    assert.deepEqual(feedCoverageViolations(text), [], `must not trip coverage: ${frag}`);
    const r = send(text);
    assert.equal(r.status, 0, `true processing prose must stay postable, stderr: ${r.stderr}`);
  }
});

// ---- round-20 audit item 4: the coverage net was a phrase matcher, so the plainest rephrasings escaped it -------
// The auditor's 25-sample probe found 3 of the simplest rewrites walk straight through a phrase-shaped net:
// "reads the catalog in full" (totality AFTER the noun), "parses the entire input" (a verb + a reach-noun the old
// lists lacked), and "handles everything" (a bare totality object). The verb list now gains parses/handles/processes,
// the reach-noun list gains input, a postpositive branch catches "...catalog IN FULL", and a bare-object branch
// catches "...EVERYTHING". As with every round-19 narrowing, the widening is paired with a re-proof that the PRIOR
// catches still refuse -- tightening one edge must not quietly re-open another.
test("the coverage net REFUSES the three escaped rephrasings, and every prior catalog catch survives the widening", () => {
  const newEscapes = ["reads the catalog in full", "parses the entire input", "handles everything"];
  const priorCatches = ["reads the whole catalog", "sees all rows", "covers every finding", "spans the entire dataset", "decodes the complete catalog"];
  for (const frag of [...newEscapes, ...priorCatches]) {
    const text = `A status line about the rig long enough to be a real post. The predicate now ${frag}.`;
    assert.ok(feedCoverageViolations(text).length > 0, `must trip coverage: ${frag}`);
    const r = send(text);
    assert.equal(r.status, 1, `must REFUSE at send: ${frag}`);
    assert.match(r.stderr, /coverage|denominator/i, `must name the coverage reason: ${frag}`);
  }
});

// The round-19 F3 hole (a denominator-bearing false totality) is NARROWED for the exact form that shipped: a
// transition that names the FULL count as reached carries the OLD value as its denominator, so it must be refused
// even though the denominator gate would otherwise wave it through.
test("the coverage net REFUSES a '...from N of M to all M' transition despite its (contrastive) denominator", () => {
  const text = "A status line about the rig long enough to be a real post. Reach went from 28 of 103 to all 103 rows.";
  assert.ok(feedCoverageViolations(text).length > 0, "the contrastive 'to all M' must trip coverage");
  const r = send(text);
  assert.equal(r.status, 1, "must REFUSE at send");
  assert.match(r.stderr, /coverage|denominator/i, "must name the coverage reason");
});

test("the round-20 coverage widening does NOT over-refuse honest transitions or non-reach 'in full' prose", () => {
  // Over-refusal is its own failure (the round-19 lesson). Each of these is honest and must stay postable: a
  // partial->partial transition, a percentage transition, a postpositive "in full" whose noun is NOT a reach noun,
  // an "in full" with no coverage verb, and the round-19 light-curve control.
  const honest = [
    "reach moved from 28 of 103 to 34 of 103 rows",
    "reach moved from 27.2% to 33.0%",
    "it reads the light curve in full",
    "the manifest is reproduced in full below",
    "it reads the whole light curve once",
  ];
  for (const frag of honest) {
    const text = `A status line about the rig long enough to be a real post. Note that ${frag}.`;
    assert.deepEqual(feedCoverageViolations(text), [], `must NOT trip coverage: ${frag}`);
    const r = send(text);
    assert.equal(r.status, 0, `honest prose must stay postable: ${frag} -- stderr ${r.stderr}`);
  }
});

