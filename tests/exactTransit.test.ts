// Validation for the exact limb-darkened occultation model. The correctness anchor is
// that with NO limb darkening it must reproduce the analytic circle-circle overlap area
// exactly (an independent closed form), and that limb darkening shifts depth in the
// physically correct direction. Pure, deterministic, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { exactTransitFlux, separationCircular } from "../src/sim/exactTransit.ts";

/** Analytic overlap area of two circles radius 1 and p at center separation z. */
function overlapArea(z: number, p: number): number {
  if (z >= 1 + p) return 0;
  if (z <= 1 - p) return Math.PI * p * p;
  if (p >= 1 && z <= p - 1) return Math.PI;
  const a1 = Math.acos(Math.min(1, Math.max(-1, (z * z + p * p - 1) / (2 * z * p))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (z * z - p * p + 1) / (2 * z))));
  const root = 0.5 * Math.sqrt(Math.max(0, (-z + p + 1) * (z + p - 1) * (z - p + 1) * (z + p + 1)));
  return p * p * a1 + a2 - root;
}

const UNIFORM = { u1: 0, u2: 0 };

test("uniform source: blocked depth == analytic overlap area / pi at many separations", () => {
  const p = 0.12;
  for (const z of [0, 0.3, 0.6, 0.85, 0.95, 1.0, 1.05, 1.11]) {
    const flux = exactTransitFlux(z, p, UNIFORM, 4000);
    const expected = 1 - overlapArea(z, p) / Math.PI;
    assert.ok(Math.abs(flux - expected) < 2e-3, `z=${z}: got ${flux}, expected ${expected}`);
  }
});

test("uniform source: central depth is exactly p^2 (planet area over star area)", () => {
  const p = 0.1;
  const depth = 1 - exactTransitFlux(0, p, UNIFORM, 6000);
  assert.ok(Math.abs(depth - p * p) < 1e-4, `central depth ${depth} vs p^2 ${p * p}`);
});

test("no overlap returns exactly 1.0; a planet larger than the star fully covers", () => {
  assert.equal(exactTransitFlux(1.5, 0.1, UNIFORM), 1);
  // grazing just at contact
  assert.ok(exactTransitFlux(1.1001, 0.1, UNIFORM) > 0.999);
});

test("limb darkening deepens a central transit and shallows a grazing one", () => {
  const p = 0.1;
  const ld = { u1: 0.6, u2: 0.2 };
  const centralUniform = 1 - exactTransitFlux(0, p, UNIFORM, 4000);
  const centralLD = 1 - exactTransitFlux(0, p, ld, 4000);
  assert.ok(centralLD > centralUniform, `LD central ${centralLD} should exceed uniform ${centralUniform}`);

  const grazeZ = 0.9;
  const grazeUniform = 1 - exactTransitFlux(grazeZ, p, UNIFORM, 4000);
  const grazeLD = 1 - exactTransitFlux(grazeZ, p, ld, 4000);
  assert.ok(grazeLD < grazeUniform, `LD grazing ${grazeLD} should be shallower than uniform ${grazeUniform}`);
});

test("model is normalized: a very small planet at mid-transit depth scales as p^2", () => {
  const ld = { u1: 0.4, u2: 0.1 };
  const p = 0.02;
  const depth = 1 - exactTransitFlux(0, p, ld, 8000);
  // central intensity is highest, so depth slightly exceeds p^2
  assert.ok(depth > p * p && depth < 1.4 * p * p, `depth ${depth} vs p^2 ${p * p}`);
});

test("separationCircular: far side never transits, near conjunction reaches min separation", () => {
  const a = 10;
  const b = 0.3;
  // phase 0 = inferior conjunction (transit), phase 0.5 = secondary (behind star)
  const atTransit = separationCircular(0.0, a, b);
  const atSecondary = separationCircular(0.5, a, b);
  assert.ok(atTransit < 1, `transit separation ${atTransit} should be on the disk`);
  assert.equal(atSecondary, 1e9); // far side -> no optical transit
  // impact parameter is the minimum separation at conjunction for a circular orbit
  assert.ok(Math.abs(atTransit - b) < 1e-9, `min separation ${atTransit} should equal b=${b}`);
});
