// Behavioural tests for the flux-level validation posterior. The claims we pin offline are exactly the ones the
// p93 study leans on: (1) a clean, well-measured transit with NO secondary accumulates POSITIVE log-odds and reaches
// the field's > 0.99 validate norm; (2) an equal-brightness secondary (the EB signature) is rejected; (3) a high
// blend FPP pulls against the planet hypothesis; (4) an UNDETERMINED discriminant is NOT treated as planet evidence,
// so a too-shallow signal stays "uncertain" and is never falsely "validated"; (5) a very deep event is tilted toward
// EB by the depth term.
import { test } from "node:test";
import assert from "node:assert/strict";

import { planetPosterior, type Discriminants } from "../src/candidate/validationPosterior.ts";

// A baseline clean planet: high SNR, shallow dip, a MEASURED secondary near zero, no odd/even split, no blend.
function cleanPlanet(over: Partial<Discriminants> = {}): Discriminants {
  return {
    snr: 40,
    depthFrac: 0.01,
    secondaryRatio: 0.0,
    secondaryDetermined: true,
    oddEvenDiffFrac: 0.0,
    oddEvenDetermined: true,
    blendFpp: 0.0,
    ...over,
  };
}

test("a clean measured transit with no secondary validates past the 0.99 field norm", () => {
  const r = planetPosterior(cleanPlanet());
  assert.equal(r.decision, "validated");
  assert.ok(r.posteriorPlanet > 0.99, `posterior ${r.posteriorPlanet} should exceed 0.99`);
  assert.ok(r.contributions.secondary > 0, "a clean measured secondary is POSITIVE planet evidence");
});

test("an equal-brightness secondary (the EB signature) is rejected", () => {
  const r = planetPosterior(cleanPlanet({ secondaryRatio: 1.0 }));
  assert.equal(r.decision, "false-positive");
  assert.ok(r.posteriorPlanet < 0.01, `posterior ${r.posteriorPlanet} should fall under 0.01`);
  assert.ok(r.contributions.secondary < 0, "a comparable secondary pulls against the planet hypothesis");
});

test("a high neighbour blend FPP pulls against the planet and blocks validation", () => {
  const lowBlend = planetPosterior(cleanPlanet({ blendFpp: 0.0 }));
  const highBlend = planetPosterior(cleanPlanet({ blendFpp: 1.0 }));
  assert.ok(highBlend.posteriorPlanet < lowBlend.posteriorPlanet, "blend FPP monotonically lowers P(planet)");
  assert.ok(highBlend.contributions.blend < 0);
});

test("an undetermined discriminant is NOT counted as planet evidence (stays uncertain, never falsely validated)", () => {
  // Same shallow, high-SNR transit but the secondary could not be measured at all.
  const undetermined = planetPosterior({
    snr: 40,
    depthFrac: 0.01,
    secondaryDetermined: false,
    oddEvenDetermined: false,
    blendFpp: 0.0,
  });
  assert.equal(undetermined.decision, "uncertain");
  assert.ok(undetermined.posteriorPlanet < 0.99, "absence of measurement must not reach the validate cut");
  assert.equal(undetermined.contributions.secondary, 0, "an undetermined secondary contributes nothing");
  assert.equal(undetermined.contributions.oddEven, 0, "an undetermined odd/even contributes nothing");
});

test("an odd/even depth split (period-halved alias / blend) pulls against the planet", () => {
  const split = planetPosterior(cleanPlanet({ oddEvenDiffFrac: 1.0 }));
  assert.ok(split.contributions.oddEven < 0, "a full odd/even asymmetry is negative planet evidence");
  assert.ok(split.posteriorPlanet < planetPosterior(cleanPlanet()).posteriorPlanet);
});

test("a very deep event (>5% flux) is tilted toward an eclipsing binary by the depth term", () => {
  const deep = planetPosterior(cleanPlanet({ depthFrac: 0.3 }));
  assert.ok(deep.contributions.depth < 0, "implausibly deep transits lose log-odds");
  assert.ok(deep.posteriorPlanet < planetPosterior(cleanPlanet()).posteriorPlanet);
});

test("posterior is a monotone sigmoid of log-odds and stays in [0,1]", () => {
  const r = planetPosterior(cleanPlanet());
  assert.ok(r.posteriorPlanet >= 0 && r.posteriorPlanet <= 1);
  // Higher secondary ratio -> lower posterior (monotone in the EB signature).
  const a = planetPosterior(cleanPlanet({ secondaryRatio: 0.2 }));
  const b = planetPosterior(cleanPlanet({ secondaryRatio: 0.8 }));
  assert.ok(b.posteriorPlanet < a.posteriorPlanet);
});
