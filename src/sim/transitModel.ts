// Physical transit model (circular orbit, uniform-source circle overlap +
// optional linear limb darkening). Used by:
//   - data-fetch/synthetic to INJECT known transits (ground truth)
//   - sim-runner to FIT / predict transit shape and ephemeris
// This is real geometry, not a box approximation, so injection-recovery is honest.

export interface OrbitParams {
  periodDays: number;
  t0Bjd: number; // transit center epoch
  aOverRs: number; // semi-major axis in stellar radii
  impactParam: number; // b = (a/Rs) cos(i)
  planetRadiusRatio: number; // p = Rp / Rs
  limbDarkening?: number; // linear coefficient u (0 = uniform)
}

/** Kepler's third law: semi-major axis in stellar radii, given P (days), M* (Msun), R* (Rsun). */
export function aOverRsFromKepler(periodDays: number, stellarMassMsun: number, stellarRadiusRsun: number): number {
  const pYears = periodDays / 365.25;
  const aAu = Math.cbrt(stellarMassMsun * pYears * pYears); // a[AU] = (M P^2)^(1/3)
  const rsAu = stellarRadiusRsun * 0.00465047; // 1 Rsun in AU
  return aAu / rsAu;
}

/** inclination (radians) from impact parameter b and a/Rs. */
export function inclinationFromImpact(impactParam: number, aOverRs: number): number {
  const cosI = Math.min(1, Math.max(-1, impactParam / aOverRs));
  return Math.acos(cosI);
}

/** Sky-projected star-planet separation (units of R*) at time t. */
export function separation(t: number, o: OrbitParams): number {
  const phase = (2 * Math.PI * (t - o.t0Bjd)) / o.periodDays;
  const cosI = o.impactParam / o.aOverRs;
  const sinP = Math.sin(phase);
  const cosP = Math.cos(phase);
  return o.aOverRs * Math.sqrt(sinP * sinP + cosI * cosI * cosP * cosP);
}

/** Overlap area of two circles (unit star, planet radius p) at separation z. */
function overlapArea(z: number, p: number): number {
  if (z >= 1 + p) return 0;
  if (z <= 1 - p) return Math.PI * p * p; // planet fully on disk
  if (p >= 1 && z <= p - 1) return Math.PI; // star fully covered (unlikely)
  const k0 = Math.acos(Math.min(1, Math.max(-1, (z * z + p * p - 1) / (2 * z * p))));
  const k1 = Math.acos(Math.min(1, Math.max(-1, (z * z + 1 - p * p) / (2 * z))));
  return p * p * k0 + k1 - 0.5 * Math.sqrt(Math.max(0, 4 * z * z - (1 + z * z - p * p) ** 2));
}

/**
 * Relative flux at time t for the given orbit (1.0 = out of transit).
 * Uniform-source occultation with an optional linear limb-darkening correction
 * approximated by scaling the in-transit depth with the local intensity.
 *
 * IMPORTANT: a transit only occurs at inferior conjunction, when the planet is
 * on the NEAR side of the star (cos(theta) > 0). The sky-projected separation
 * is symmetric about phase 0.5, so without this gate the model would also
 * produce an equal-depth "dip" at superior conjunction (secondary eclipse),
 * which is physically wrong for optical photometry (secondary eclipses are
 * ppm-level and ignored here). This gate is what makes the injected signal
 * have exactly ONE dip per orbital period.
 */
export function transitFlux(t: number, o: OrbitParams): number {
  const theta = (2 * Math.PI * (t - o.t0Bjd)) / o.periodDays;
  if (Math.cos(theta) <= 0) return 1; // planet behind the star -> no transit
  const z = separation(t, o);
  const p = o.planetRadiusRatio;
  const area = overlapArea(z, p);
  if (area <= 0) return 1;
  const uniformDepth = area / Math.PI; // fraction of stellar disk blocked
  const u = o.limbDarkening ?? 0;
  if (u === 0) return 1 - uniformDepth;
  // linear limb darkening: intensity I(mu)=1-u(1-mu); approximate local mu at separation z
  const mu = z < 1 ? Math.sqrt(1 - z * z) : 0;
  const iLocal = 1 - u * (1 - mu);
  const iMean = 1 - u / 3; // disk-integrated mean intensity
  const scale = iLocal / iMean;
  return 1 - uniformDepth * scale;
}

/** Evaluate the model over an array of times. */
export function transitModel(times: number[], o: OrbitParams): number[] {
  return times.map((t) => transitFlux(t, o));
}

/**
 * Approximate total transit duration (hours) for a circular orbit.
 * T = (P/pi) * arcsin( (Rs/a) * sqrt((1+p)^2 - b^2) / sin i )
 */
export function transitDurationHours(o: OrbitParams): number {
  const cosI = Math.min(1, o.impactParam / o.aOverRs);
  const sinI = Math.sqrt(1 - cosI * cosI);
  const p = o.planetRadiusRatio;
  const arg = (Math.sqrt(Math.max(0, (1 + p) ** 2 - o.impactParam ** 2)) / o.aOverRs) / (sinI || 1e-9);
  const T = (o.periodDays / Math.PI) * Math.asin(Math.min(1, arg));
  return T * 24;
}
