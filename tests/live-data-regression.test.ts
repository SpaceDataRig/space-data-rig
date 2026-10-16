// audit-4 live-data regression gate -- the class of bug this closes.
//
// Two audit-3 fixes were correct, unit-tested, and DEPLOYED, yet never fired on real data:
//   1. the scienceHash dedup -- hashScience() folded findingId/targetId/artifacts/dataProvenance into the
//      content address, so the live F-HR-858-b/c/d trio (ONE detection re-run under three catalog labels)
//      produced THREE distinct hashes and the dedup was dead code: three mainnet fees for one content.
//   2. the legacy-card relabel -- a strict `created < POLICY_DATE` boundary, when all four real "Confirmed:"
//      cards were created ON the policy date, so the predicate matched ZERO live cards.
// Both slipped through because their tests asserted a FUNCTION on a hand-built stub, never that the PREDICATE
// processes the REAL records correctly. This file does the opposite: it drives the actual production
// predicates (hashScience, scienceProjection, findAnchoredScience, headlineRelabelNote) over fixtures captured
// straight from the live site by scripts/capture-live-fixtures.ts. Re-add an identity/label field to the
// science hash, or flip the relabel boundary back to `<`, and these assertions fail on the real bytes.
// audit-6: the projection now BINDS dataProvenance (which photometry the science used). The fixtures were
// re-captured after computeDataHash() dropped targetId, so the trio's lightCurveHash is label-independent;
// these tests assert both that the trio STILL collapses to one address and that swapping the data source
// (or its stand-in label) moves the address -- a synthetic curve can no longer share a real-data address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashScience, hashScienceLegacy, scienceProjection, type BundleManifest } from "../src/bundle/bundle.ts";
import { findAnchoredScience } from "../src/solana/anchor-core.ts";
// The SAME module web/app.js imports, so this exercises the predicate the browser actually runs -- not a copy
// re-implemented in the test (a copy is exactly what a string-match test amounted to before).
import { headlineRelabelNote, RELABEL_NOTE, RELABEL_POLICY_DATE } from "../web/relabel.js";

interface LiveFinding {
  id: string;
  targetId: string;
  createdAt?: string;
  verdict?: string;
  verdictReason?: string;
  bundleHash?: string;
  narration?: { headline?: string; explainer?: string };
}
interface FindingsFixture {
  capturedAt: string;
  base: string;
  findings: LiveFinding[];
}
interface ManifestFixture {
  capturedAt: string;
  base: string;
  bundles: { findingId: string; manifest: BundleManifest }[];
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), "tests", "fixtures", file), "utf8")) as T;
}
const findingsFx = load<FindingsFixture>("live-findings.json");
const manifestsFx = load<ManifestFixture>("live-manifests.json");

// The four live cards the audit named: all created ON the policy date, all storing the retired "Confirmed:".
const LEGACY_CONFIRMED = ["F-GJ-1214-b", "F-KELT-9-b", "F-HD-189733-b", "F-WASP-121-b"];

test("hashScience collapses the REAL identical-science trio to ONE content address (audit-4: dedup was dead code)", async () => {
  const bundles = manifestsFx.bundles;
  assert.ok(bundles.length >= 2, `fixture must capture the identical-science group (got ${bundles.length})`);

  // The collapse must happen DESPITE genuinely distinct identities/labels -- not because the fixture is one
  // finding repeated. This is what a hand-built stub could never demonstrate.
  const ids = new Set(bundles.map((b) => b.manifest.findingId));
  const targets = new Set(bundles.map((b) => b.manifest.targetId));
  assert.equal(ids.size, bundles.length, "each captured manifest is a distinct findingId");
  assert.ok(targets.size >= 2, "the group carries distinct targetId labels (e.g. HR 858 b/c/d)");

  // The proposition the audit demanded: re-running the same science is recognised as the same science.
  const hashes = await Promise.all(bundles.map((b) => hashScience(b.manifest)));
  assert.equal(
    new Set(hashes).size,
    1,
    `identical science must share ONE scienceHash; got ${new Set(hashes).size} distinct: ${hashes.join(", ")}`,
  );
});

test("the science projection drops identity/label/render fields AND the post-hoc check, but KEEPS provenance", async () => {
  const [b0, b1] = manifestsFx.bundles;
  // The raw manifests really do differ on the label/render/fetch axis...
  assert.notEqual(b0.manifest.findingId, b1.manifest.findingId);
  assert.notEqual(b0.manifest.targetId, b1.manifest.targetId);
  assert.notEqual(JSON.stringify(b0.manifest.artifacts), JSON.stringify(b1.manifest.artifacts), "SVG titles embed targetId");
  // audit-6 premise, measured on live bytes: once computeDataHash() dropped targetId the light-curve hash
  // is label-independent, so provenance can be bound into the address without breaking the collapse.
  assert.equal(b0.manifest.dataProvenance.lightCurveHash, b1.manifest.dataProvenance.lightCurveHash);
  assert.equal(b0.manifest.dataProvenance.lightCurveSource, b1.manifest.dataProvenance.lightCurveSource);
  // ...and even on the raw checks array: the post-hoc period-vs-truth check compares against EACH label's
  // catalog period, so it differs while the blind detection is identical. Including checks verbatim (as the
  // audit's first-pass field list did) would therefore keep the dedup dead -- the projection must filter it.
  assert.notEqual(JSON.stringify(b0.manifest.checks), JSON.stringify(b1.manifest.checks));

  const p0 = scienceProjection(b0.manifest);
  const p1 = scienceProjection(b1.manifest);
  for (const banned of ["findingId", "targetId", "artifacts", "createdAt", "runId", "codeVersion", "schema"])
    assert.ok(!(banned in p0), `science projection must not carry ${banned}`);
  assert.ok("dataProvenance" in p0, "audit-6: the content address MUST bind which photometry the science used");
  assert.equal(JSON.stringify(p0), JSON.stringify(p1), "the blind-science projections are byte-identical");

  const keptChecks = (p0.checks as { name: string }[]).map((c) => c.name);
  assert.ok(keptChecks.every((n) => !/non-gating|post-hoc/i.test(n)), "no post-hoc/non-gating check survives into the hash");
  assert.ok(keptChecks.includes("snr") && keptChecks.includes("fap"), "the gating checks ARE preserved");
});

test("findAnchoredScience dedups the 2nd/3rd real finding against the first anchored one (no repeat fee)", async () => {
  const bundles = manifestsFx.bundles;
  const sci = await hashScience(bundles[0].manifest);
  // The ledger state right after the FIRST of the group anchored: one committed row carrying the content address.
  const ledger = [{ findingId: bundles[0].findingId, status: "anchored", signature: "5xMainnetSig", scienceHash: sci }];
  for (const later of bundles.slice(1)) {
    const laterSci = await hashScience(later.manifest);
    const dupe = findAnchoredScience(ledger, laterSci);
    assert.equal(dupe?.findingId, bundles[0].findingId, `${later.findingId} must dedup against the first anchored finding`);
    assert.equal(dupe?.signature, "5xMainnetSig");
  }
});

test("the relabel predicate annotates EVERY real legacy 'Confirmed' card (audit-4: strict '<' matched zero)", () => {
  const byId = new Map(findingsFx.findings.map((f) => [f.id, f]));
  for (const id of LEGACY_CONFIRMED) {
    const f = byId.get(id);
    assert.ok(f, `fixture must contain the live legacy card ${id}`);
    // The off-by-one guard: each was created ON the policy date, so a strict `<` boundary excludes it.
    assert.equal((f.createdAt ?? "").slice(0, 10), RELABEL_POLICY_DATE, `${id} was created ON the policy date`);
    assert.match(f.narration?.headline ?? "", /^Confirmed:/, `${id} stores the retired "Confirmed:" headline`);
    assert.equal(headlineRelabelNote(f), RELABEL_NOTE, `${id} must be re-labeled as injection-recovery`);
  }
  // And exactly those four on the live snapshot -- nothing over- or under-labeled.
  const noted = findingsFx.findings.filter((f) => headlineRelabelNote(f) !== "");
  assert.deepEqual(noted.map((f) => f.id).sort(), [...LEGACY_CONFIRMED].sort());
});

test("post-policy and non-'confirm' cards get NO relabel note (no false positives on the boundary day)", () => {
  for (const f of findingsFx.findings) {
    const created = (f.createdAt ?? "").slice(0, 10);
    const saysConfirm = /confirm/i.test(`${f.narration?.headline ?? ""} ${f.verdictReason ?? ""}`);
    const note = headlineRelabelNote(f);
    if (created > RELABEL_POLICY_DATE || !saysConfirm)
      assert.equal(note, "", `${f.id} (created ${created}, confirm=${saysConfirm}) must NOT be re-labeled`);
  }
  // A boundary-day card that is already honest ("Promising but unproven") is left untouched -- the /confirm/
  // guard, not the date, is what spares it. This is the case a date-only test would get wrong.
  const hatp11 = findingsFx.findings.find((f) => f.id === "F-HAT-P-11-b");
  assert.ok(hatp11, "fixture must contain the boundary-day non-confirm card");
  assert.equal((hatp11.createdAt ?? "").slice(0, 10), RELABEL_POLICY_DATE);
  assert.equal(headlineRelabelNote(hatp11), "");
});

test("audit-6: swapping the photometry source moves the content address (a stand-in cannot share a real address)", async () => {
  const m = manifestsFx.bundles[0].manifest;
  const real = await hashScience(m);
  const rerun = { ...m, createdAt: "2030-01-01T00:00:00Z", runId: "rerun" };
  assert.equal(await hashScience(rerun), real, "the same bytes re-run later keep the address");
  const standInHash = { ...m, dataProvenance: { ...m.dataProvenance, lightCurveHash: "0".repeat(64) } };
  assert.notEqual(await hashScience(standInHash), real, "different photometry bytes must yield a different address");
  const standInSrc = { ...m, dataProvenance: { ...m.dataProvenance, lightCurveSource: "synthetic stand-in (not real photometry)" } };
  assert.notEqual(await hashScience(standInSrc), real, "a stand-in source label must not share the real-data address");
});

test("audit-6: rows sealed pre-audit-6 still dedup via the legacy address (no second fee for old science)", async () => {
  const bundles = manifestsFx.bundles;
  const legacy = await hashScienceLegacy(bundles[0].manifest);
  const current = await hashScience(bundles[0].manifest);
  assert.notEqual(legacy, current, "binding provenance changes the address definition");
  // A ledger row written before audit-6 carries the legacy hash; a re-run today must still recognise it.
  const ledger = [{ findingId: bundles[0].findingId, status: "anchored", signature: "5xOldSig", scienceHash: legacy }];
  assert.equal(findAnchoredScience(ledger, current), null, "the new address alone must NOT match a pre-audit-6 row");
  assert.equal(findAnchoredScience(ledger, legacy)?.findingId, bundles[0].findingId, "the legacy fallback matches it");
  // The legacy address is itself label-independent, so the fallback cannot resurrect the dead dedup.
  const legacyAll = await Promise.all(bundles.map((b) => hashScienceLegacy(b.manifest)));
  assert.equal(new Set(legacyAll).size, 1, "the legacy address also collapses the trio");
});
