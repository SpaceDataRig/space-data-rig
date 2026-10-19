// P82 SCALED DIGEST -- turn the gitignored P82 checkpoints into a COMMITTED, machine-recomputable provenance
// bundle, so the flagship scaled reports (p82/p84/p85) can be re-derived on any checkout instead of only on the
// one workstation that ran the 2.7h long-pull.
//
// WHY (external audit, problem #3 "verified 3/50"). p82/p84/p85 stamp buildStamp([out/scaled/*.jsonl]) -- but
// out/scaled is gitignored, so report-freshness.evaluateAgainst records those inputs as untracked: their checksum
// matches only on the machine that produced them, and NOTHING on a fresh clone can re-hash them. The reports are
// therefore "stamped but not reproducible". The fix is not a weaker hash -- it is to commit the row-level bytes and
// prove, in CI, that they regenerate the published headline numbers.
//
// This script writes, under a TRACKED path (tests/fixtures/scaled/):
//   - blind.jsonl / external.jsonl / centroid.jsonl  verbatim (the append-only checkpoints, LF-normalised);
//   - digest.json: for each checkpoint, {rows, sha256 (file), lineSha[] (sha256 of every raw row)} -- the
//     "row-level summary, each line a sha256" the audit asked for -- plus a `headline` block recomputed from the
//     committed checkpoints THROUGH THE SAME scorer the report uses (scoreBlindTest + Wilson), so the digest's
//     headline must equal reports/p82-scaled.json field-for-field. tests/scaled-reproducibility.test.ts enforces
//     that equality and that each committed row still hashes to its recorded lineSha.
//
// Research only: reads/writes files under tests/fixtures + prints; no worker import, no verdict, no bundle hash,
// no money path. discoveryClaim false.
//
// Usage: npm run p82:digest [-- --checkpoint-dir out/scaled]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { scoreBlindTest } from "../src/sim/blindTest.ts";
import { wilsonInterval } from "../src/sim/completenessGrid.ts";

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : dflt;
}

const SRC = arg("checkpoint-dir", "out/scaled");
const DEST = "tests/fixtures/scaled";
const MIN_CORR = 2; // must match scripts/p82-scaled-validation.ts aggregate()
const FILES = ["blind.jsonl", "external.jsonl", "centroid.jsonl"] as const;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const readLines = (f: string): string[] => {
  const p = `${SRC}/${f}`;
  if (!existsSync(p)) throw new Error(`p82-digest: missing checkpoint ${p}; run the probes (or pass --checkpoint-dir) first`);
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
};

function main(): void {
  mkdirSync(DEST, { recursive: true });
  const files: Record<string, { rows: number; sha256: string; lineSha: string[] }> = {};
  const raw: Record<string, string[]> = {};
  for (const f of FILES) {
    const lines = readLines(f);
    raw[f] = lines;
    const body = lines.join("\n") + "\n";
    writeFileSync(`${DEST}/${f}`, body, "utf8"); // verbatim checkpoint, LF-normalised
    files[f] = { rows: lines.length, sha256: sha256(body), lineSha: lines.map((l) => sha256(l)) };
  }

  const parse = (f: string) => raw[f].map((l) => JSON.parse(l));
  // ---- blind: reuse the EXACT scorer the report uses ----
  const blindRows = parse("blind.jsonl").filter((r: any) => r.truth);
  const truth: any[] = blindRows.map((r: any) => r.truth);
  const dets: any[] = blindRows.flatMap((r: any) => r.dets as any[]);
  const bt = truth.length ? scoreBlindTest(truth, dets, { minCorroboration: MIN_CORR }) : null;
  // ---- external: mirror aggregate() rate() ----
  const ext = parse("external.jsonl").filter((r: any) => r.disp);
  const rate = (rows: any[]) => ({
    tested: rows.length,
    validated: rows.filter((r) => r.validated).length,
    grade: rows.filter((r) => r.validated && (r.blendFpp ?? 1) < 1e-3 && (r.harmonicSiblings ?? 0) === 0).length,
  });
  const kpR = rate(ext.filter((r: any) => r.disp === "KP"));
  const cpR = rate(ext.filter((r: any) => r.disp === "CP"));
  // ---- centroid: mirror aggregate() filters ----
  const cen = parse("centroid.jsonl").filter((r: any) => r.testable);
  const planets = cen.filter((r: any) => r.label === "planet");
  const blends = cen.filter((r: any) => r.label === "blend");

  const headline = {
    blind: bt ? { curves: bt.nCurves, injected: bt.nInjected, nullCurves: bt.nNull, recall: bt.recall, precision: bt.precision, acceptedUnderBar: bt.accepted, acceptedTp: bt.acceptedTp, falseAccepts: bt.falseAccepts, acceptedPrecision: bt.acceptedPrecision } : null,
    blindRecallCI: bt ? bt.recallCI : null,
    external: { kp: kpR, cp: cpR, kpCI: wilsonInterval(kpR.validated, kpR.tested), cpCI: wilsonInterval(cpR.validated, cpR.tested) },
    centroid: { planetsTestable: planets.length, planetFalseReject: planets.filter((r: any) => r.falseReject).length, blendsTestable: blends.length, blendCaught: blends.filter((r: any) => r.caught).length },
  };

  const digest = {
    schema: "sdr-scaled-digest/1",
    generatedBy: "scripts/p82-scaled-digest.ts",
    source: SRC,
    note: "Committed row-level digest of the gitignored P82 checkpoints. Each line carries the sha256 of that raw " +
      "checkpoint row; `headline` is recomputed from the committed checkpoints via the same scoreBlindTest/Wilson the " +
      "report uses, so tests/scaled-reproducibility.test.ts can prove any checkout re-derives the published p82/p84/p85 " +
      "numbers from committed bytes. Research-only; discoveryClaim false.",
    discoveryClaim: false,
    files,
    headline,
  };
  const json = JSON.stringify(digest, null, 2) + "\n";
  writeFileSync(`${DEST}/digest.json`, json, "utf8");
  if (/[^\x00-\x7F]/.test(json)) { console.error("p82-digest: non-ASCII in digest.json"); process.exitCode = 1; }
  console.log(`p82-digest: wrote ${DEST}/{blind,external,centroid}.jsonl + digest.json`);
  console.log(`  rows: ${FILES.map((f) => `${f}=${files[f].rows}`).join(" ")}`);
  console.log(`  headline: blind recall ${bt ? (100 * bt.recall).toFixed(1) + "%" : "n/a"} / acceptedPrecision ${bt ? (100 * bt.acceptedPrecision).toFixed(1) + "%" : "n/a"}; external KP ${kpR.validated}/${kpR.tested} CP ${cpR.validated}/${cpR.tested}; centroid planetFalseReject ${headline.centroid.planetFalseReject}/${headline.centroid.planetsTestable} blendCaught ${headline.centroid.blendCaught}/${headline.centroid.blendsTestable}`);
}

main();
