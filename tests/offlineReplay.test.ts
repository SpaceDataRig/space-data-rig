// OFFLINE REPLAY INTEGRITY TEST -- proves the JS detection chain reproduces known-planet detections from
// frozen, checksummed real-photometry bytes with ZERO network, and guards those fixtures against silent
// corruption (CRLF conversion, accidental edits). The unit suite already runs network-free; the reviewer's
// concern was that the RESEARCH studies depend on live MAST/S3 fetches, so we pin a byte-identical fixture
// set (already exported by p36 for the Python cross-check) and give the JS side the same offline guarantee.
//
// No network call is made here: curves come from tests/fixtures/spoc-curves/*.csv committed to the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTransit } from "../src/detect/pipeline.ts";
import type { LightCurve } from "../src/core/types.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spoc-curves");

// Committed SHA-256 of every fixture's exact bytes (real TESS-SPOC PDCSAP curves, eol=lf via .gitattributes).
// If a file is edited or a checkout mangles line endings, this test fails loudly instead of a study silently
// re-deriving different numbers.
const CHECKSUMS: Record<string, string> = {
  "au-mic.csv": "4c9f9d623ee42b1b8b484616b2b36a73b357b9c5eea661a7216a6953271563e1",
  "gj-143.csv": "e692634d4972a62a5f843399061f7706d1ec136a9a2f32dad2f3c9868ae0c0b6",
  "hd-1397.csv": "ce57f592573e9def68215b6449f61ce37155b5f3ae915665a8ff098bcaaa02a4",
  "hd-207496.csv": "9c4dc4d90a7e40cce32cce0e6a25805ea52123bac63774d19c923fbf296dd45d",
  "hd-25463.csv": "e627a23cc8461324de8e6c9a0deac2c26ba3d043b6ced0593131bb1baac6db6e",
  "hd-39091.csv": "cee5be338987105eb398bbe263c1880a3a4f3b1bf9b7fe3feb758c6bde7b4ed2",
  "hd-63433.csv": "98bb916925bcc7da95c63c9fa44fa4f6ba76fc193f5075562bd8f5267929c377",
  "hd-86226.csv": "ce248047f9791d6e7fc71f01c2d4308639076e558344c96260e38fa94bd9d91e",
  "hr-858.csv": "122432524310699c0d97becd7ba5973aa0a9e2981fac52592e2a788d29c7f353",
  "kelt-11.csv": "c72fee2b96a56f94af27ea5e1536616a3276b059f562c698dfb22e4b0caae8ee",
  "toi-480.csv": "042828458ac1cd3cd7ad8d41c350cbc4746e243de21383f2e6cff00dae755033",
  "toi-5739.csv": "b9e8fdcd8bdd9e6cf4aaef9187a25f7d540e6f113f7e90a6009e51f2b2635ee8",
};

const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
  curves: { file: string; knownPlanetPeriodsDays: number[] }[];
};
const knownByFile = new Map(manifest.curves.map((c) => [c.file, c.knownPlanetPeriodsDays]));

function readCurve(file: string): { bytes: Buffer; lc: LightCurve } {
  const bytes = readFileSync(join(DIR, file));
  const lines = bytes.toString("utf8").trim().split(/\r?\n/);
  const points = lines.slice(1) // drop the "time,flux" header
    .map((ln) => ln.split(",")).filter((r) => r.length >= 2)
    .map((r) => ({ time: Number(r[0]), flux: Number(r[1]) }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.flux));
  return { bytes, lc: { targetId: file, mission: "TESS", cadenceSec: 120, points } };
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const withinPct = (x: number, ref: number, pct: number) => Number.isFinite(x) && Math.abs(x - ref) / ref * 100 <= pct;

test("fixture bytes match the committed SHA-256 manifest (integrity guard, no CRLF/edit drift)", () => {
  for (const [file, want] of Object.entries(CHECKSUMS)) {
    const { bytes } = readCurve(file);
    assert.equal(sha256(bytes), want, `${file} changed or was line-ending-mangled`);
  }
});

test("the JS detection chain replays known-planet periods from frozen bytes, zero network", () => {
  // Every committed fixture must yield a finite candidate offline; a measured subset reproduces a known
  // period within 2%. Detector improvements can only raise the count; a regression below it fails CI.
  let ran = 0, matched = 0;
  const hits: string[] = [];
  for (const file of Object.keys(CHECKSUMS)) {
    const { lc } = readCurve(file);
    const det = detectTransit(lc);
    assert.ok(det.candidate && Number.isFinite(det.candidate.snr), `${file}: detector produced no finite candidate`);
    ran++;
    const known = knownByFile.get(file) ?? [];
    if (known.some((kp) => withinPct(det.candidate.periodDays, kp, 2))) { matched++; hits.push(file); }
  }
  assert.equal(ran, Object.keys(CHECKSUMS).length, "not every fixture produced a candidate");
  assert.ok(matched >= 6, `expected >=6 offline known-period reproductions, got ${matched} (${hits.join(", ")})`);
});

test("detectTransit is deterministic on a fixture curve (identical period + SNR across runs)", () => {
  const { lc } = readCurve("kelt-11.csv");
  const a = detectTransit(lc);
  const b = detectTransit(lc);
  assert.equal(a.candidate.periodDays, b.candidate.periodDays);
  assert.equal(a.candidate.snr, b.candidate.snr);
});
