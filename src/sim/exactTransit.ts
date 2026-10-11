// Exact occultation transit model with quadratic limb darkening -- an additive,
// independently-validated primitive for modeling REAL photometry.
//
// Why here and not replacing ./transitModel.ts: transitModel.ts (uniform-source circle
// overlap + a local intensity heuristic) backs the deterministic synthetic injection
// path whose numbers feed the reproducible bundle hash; we must not silently change
// those. This module instead computes the physically exact blocked light --
//   flux(t) = 1 - [ integral over the occulted part of the stellar disk of I(mu) dA ]
//           / [ integral over the whole disk of I(mu) dA ]
// with the quadratic limb-darkening law I(mu) = 1 - u1(1-mu) - u2(1-mu)^2, mu = the
// cosine of the emission angle = sqrt(1 - r^2) at disk radius r.
//
// Method: reduce the 2-D occultation to a 1-D radial integral. At stellar radius r the
// annulus has circumference fraction f(r) covered by the planet disk (closed form from
// circle-circle geometry); the blocked light is integral of I(r) * f(r) * 2 pi r dr. A
// FIXED Simpson grid makes the result deterministic and reproducible. Correctness is
// enforced by tests that check the uniform-source limit reproduces the exact analytic
// circle-overlap area (pi p^2 at central transit, general z elsewhere).

export interface LdQuadratic {
  /** linear coefficient (mu^1). */
  u1: number;
  /** quadratic coefficient (mu^2). */
  u2: number;
}

/** Fraction of the annulus at radius r (unit star) covered by a planet disk of
 *  radius p centered at sky separation z. Pure geometry, closed form. */
function annulusCoverage(r: number, z: number, p: number): number {
  if (r <= 0) return 0; // measure-zero center
  if (z === 0) return r < p ? 1 : 0; // concentric: ring fully in or out
  const outer = r + z;
  const inner = Math.abs(r - z);
  if (outer <= p) return 1; // entire ring lies inside the planet disk
  if (inner >= p) return 0; // entire ring lies outside it
  // partial: the arc of the ring inside the planet spans +-theta about the star-planet line
  const cosTheta = (r * r + z * z - p * p) / (2 * r * z);
  const clamped = Math.min(1, Math.max(-1, cosTheta));
  return Math.acos(clamped) / Math.PI;
}

/** Quadratic limb-darkened surface brightness at disk radius r (mu = sqrt(1-r^2)). */
function intensity(r: number, ld: LdQuadratic): number {
  const mu = Math.sqrt(Math.max(0, 1 - r * r));
  return 1 - ld.u1 * (1 - mu) - ld.u2 * (1 - mu) * (1 - mu);
}

/**
 * Normalization = integral of I(mu) over the disk (so the model is 1.0 out of transit
 * for any limb darkening). Closed form for the quadratic law:
 *   (1/2) * integral_0^1 I(r) d(r^2) = 1 - u1/3 - u2/6 ... times 2pi, but we integrate
 * numerically for consistency with the blocked-light integral.
 */
function diskIntegral(ld: LdQuadratic, n: number): number {
  // integrand g(r) = I(r) * 2 pi r ; Simpson over [0,1] with n (even) intervals.
  const h = 1 / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const r = i * h;
    const g = intensity(r, ld) * 2 * Math.PI * r;
    const w = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    sum += w * g;
  }
  return (sum * h) / 3;
}

/**
 * Exact relative flux for a planet (radius ratio p) at sky-projected separation z
 * (units of stellar radii) in front of a quadratically limb-darkened star.
 * Returns 1.0 when there is no overlap. n controls the Simpson grid (even).
 */
export function exactTransitFlux(z: number, p: number, ld: LdQuadratic, n = 2000): number {
  if (p <= 0) return 1;
  if (z >= 1 + p) return 1; // no overlap
  const norm = diskIntegral(ld, n);
  const h = 1 / n;
  let blocked = 0;
  for (let i = 0; i <= n; i++) {
    const r = i * h;
    const f = annulusCoverage(r, z, p);
    if (f <= 0) continue;
    const g = intensity(r, ld) * f * 2 * Math.PI * r;
    const w = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    blocked += w * g;
  }
  blocked = (blocked * h) / 3;
  return 1 - blocked / norm;
}

/** Sky-projected separation (stellar radii) for a circular orbit at true phase. */
export function separationCircular(phase: number, aOverRs: number, impactParam: number): number {
  // phase in orbital cycles; inferior conjunction at phase 0.
  const theta = 2 * Math.PI * phase;
  const cosI = impactParam / aOverRs;
  const sinP = Math.sin(theta);
  const cosP = Math.cos(theta);
  // transit only at the near side (cos(theta) > 0); on the far side no optical transit.
  if (Math.cos(theta) <= 0) return 1e9; // effectively no overlap
  return aOverRs * Math.sqrt(sinP * sinP + cosI * cosI * cosP * cosP);
}
