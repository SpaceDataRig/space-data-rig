// Offline tests for the LLM -> measurement closed loop: the strict proposal parser (fails closed on
// anything off-menu or malformed, so a model cannot trigger arbitrary work) and the deterministic
// executors (run on a seeded synthetic transit -- no network, no model).
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProposal, hypothesisSystemPrompt, TEST_MENU } from "../src/ai/hypothesis.ts";
import { runHypothesisTest } from "../src/detect/hypothesisTests.ts";
import { generateSyntheticTransit } from "../src/data/synthetic.ts";

// ---- parseProposal ----

test("parseProposal accepts a clean JSON reply and clips free text", () => {
  const raw = '{"hypothesis":"this is an eclipsing binary","test":"odd-even-depth","prediction":"blend","rationale":"odd and even depths should differ"}';
  const p = parseProposal(raw);
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.test, "odd-even-depth");
    assert.equal(p.prediction, "blend");
    assert.match(p.hypothesis, /eclipsing binary/);
  }
});

test("parseProposal tolerates code fences and surrounding prose", () => {
  const raw = 'Sure!\n```json\n{"hypothesis":"spike not transit","test":"shape-coherence","prediction":"blend","rationale":"ratio near 0"}\n```\nDone.';
  const p = parseProposal(raw);
  assert.equal(p.ok, true);
  if (p.ok) assert.equal(p.test, "shape-coherence");
});

test("parseProposal normalizes prediction case and defaults an unknown one to inconclusive", () => {
  const up = parseProposal('{"hypothesis":"x","test":"bls-snr","prediction":"PLANET","rationale":"y"}');
  assert.equal(up.ok, true);
  if (up.ok) assert.equal(up.prediction, "planet");
  const unknown = parseProposal('{"hypothesis":"x","test":"bls-snr","prediction":"banana","rationale":"y"}');
  assert.equal(unknown.ok, true);
  if (unknown.ok) assert.equal(unknown.prediction, "inconclusive");
});

test("parseProposal FAILS CLOSED on a test id that is not in the menu (prompt-injection style)", () => {
  for (const bad of ["rm -rf /", "https://evil.example/exec", "download_pixel_file", "", "42"]) {
    const p = parseProposal(`{"hypothesis":"x","test":${JSON.stringify(bad)},"prediction":"planet","rationale":"y"}`);
    assert.equal(p.ok, false, `must reject test=${JSON.stringify(bad)}`);
  }
});

test("parseProposal rejects malformed / empty / hypothesis-less replies", () => {
  assert.equal(parseProposal("").ok, false);
  assert.equal(parseProposal("no json here").ok, false);
  assert.equal(parseProposal("{not valid json}").ok, false);
  assert.equal(parseProposal('{"test":"bls-snr","prediction":"planet"}').ok, false, "missing hypothesis");
});

test("every menu id is a value the parser will accept", () => {
  for (const t of TEST_MENU) {
    const p = parseProposal(`{"hypothesis":"h","test":"${t.id}","prediction":"planet","rationale":"r"}`);
    assert.equal(p.ok, true, `menu id ${t.id} must parse`);
  }
  assert.match(hypothesisSystemPrompt(), /ONLY a JSON object/);
});

// ---- deterministic executors (on a real seeded synthetic transit, no model) ----

test("bls-snr executor re-detects a strong synthetic planet and tags it planet-consistent", () => {
  const { lc, truth } = generateSyntheticTransit({ seed: 7, periodDays: 3.2, depthFrac: 0.01, noisePpm: 200, cadenceSec: 120, baselineDays: 27 });
  const o = runHypothesisTest("bls-snr", { lc, t0Bjd: truth.t0Bjd, periodDays: truth.periodDays, durationHours: truth.durationHours });
  assert.equal(o.determined, true);
  assert.ok(o.metric >= 7, `expected SNR>=7, got ${o.metric}`);
  assert.equal(o.outcome, "planet");
});

test("unknown / off-menu test id degrades to an undetermined outcome and never throws", () => {
  const { lc, truth } = generateSyntheticTransit({ seed: 3, periodDays: 4, depthFrac: 0.008, noisePpm: 300 });
  const o = runHypothesisTest("not-a-real-test", { lc, t0Bjd: truth.t0Bjd, periodDays: truth.periodDays, durationHours: truth.durationHours });
  assert.equal(o.determined, false);
  assert.equal(o.outcome, "inconclusive");
});

test("every menu test runs on a synthetic curve without throwing", () => {
  const { lc, truth } = generateSyntheticTransit({ seed: 11, periodDays: 3, depthFrac: 0.01, noisePpm: 200 });
  const ctx = { lc, t0Bjd: truth.t0Bjd, periodDays: truth.periodDays, durationHours: truth.durationHours };
  for (const t of TEST_MENU) {
    const o = runHypothesisTest(t.id, ctx);
    assert.equal(o.test, t.id);
    assert.ok(o.outcome === "planet" || o.outcome === "blend" || o.outcome === "inconclusive");
  }
});

test("the pixel (PSF) and Gaia-dilution tests degrade to undetermined when their data is absent, never throw", () => {
  const { lc, truth } = generateSyntheticTransit({ seed: 5, periodDays: 3, depthFrac: 0.01, noisePpm: 200 });
  const ctx = { lc, t0Bjd: truth.t0Bjd, periodDays: truth.periodDays, durationHours: truth.durationHours };
  for (const id of ["psf-localize", "gaia-dilution"]) {
    const o = runHypothesisTest(id, ctx);
    assert.equal(o.determined, false, `${id} without its data must be undetermined`);
    assert.equal(o.outcome, "inconclusive");
  }
});
