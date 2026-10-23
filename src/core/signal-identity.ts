/**
 * SIGNAL IDENTITY (audit-16 D1/D2/D3 foundation) -- a runtime-agnostic pure module that answers, from a finding's
 * OWN fields, three questions the data model currently conflates:
 *   1. hostKeyOf      -- the HOST STAR, with any trailing planet designator removed ("HR 858 d" and "TOI-2016.01"
 *                        both reduce to their star). distinctHosts must count THIS, not the raw label.
 *   2. signalKeyOf    -- a canonical (host, period, depth-ppm, snr) fingerprint of the recovered signal. Two finding
 *                        rows with the SAME signalKey are, to the measurement's precision, one physical candidate
 *                        re-detected under two seat labels -- the very duplication the fifteenth/sixteenth audit
 *                        measured live (103 rows -> 91 signals / 90 hosts; ledger 20 -> 17).
 *   3. labelConflict  -- whether the designator baked into the LABEL (requested planet, from the TOI/pscomppars seat)
 *                        DISAGREES with the designator in the finding's OWN crossmatch.knownPlanetName (detected
 *                        planet). This is D1's self-contradiction, e.g. card titled "HR 858 d" whose body says
 *                        cross-matched "HR 858 b".
 *
 * WHY PURE AND SHARED. The correct merge already exists (src/candidate/dedup.ts::collapseCoincident) but is offline-only
 * (scripts/p19, p22; zero production callers -- audit-16 D3). This module is the read-side, dependency-free kernel the
 * projection, the stats counters, and (later, after calibration) the mint-time suppression guard can ALL share, so the
 * "is this the same signal / does the label lie" decision cannot fork between surfaces -- the same single-source rule as
 * stats-definitions.ts. It reads nothing and mutates nothing: a finding's stored row, its bundle manifest and both hashes
 * are UNCHANGED by anything here. The mint guard is deliberately NOT wired in here -- suppressing a record changes which
 * findings exist and therefore which get anchored (the money path), so per this project's rule it must be gated only
 * after measuring false-merge on real data; see HANDOFF next-step.
 */

/** A trailing single-letter planet designator (" b", "\tc"), case-insensitive, only when preceded by a separator. */
const PLANET_SUFFIX = /\s+([a-z])$/i;

/** Reduce a target id to its host star: strip trailing candidate numbers AND planet letters, repeatedly, so
 * compound forms ("TOI-2016.01 b" with BOTH a candidate number and a designator) reduce fully. Order-insensitive:
 * each pass removes whichever suffix is present at the end, until the string stops changing. */
export function hostKeyOf(targetId: string): string {
  let key = targetId.trim().toLowerCase();
  for (;;) {
    const next = key.replace(/\.\d+$/, "").replace(PLANET_SUFFIX, "").replace(/\s+/g, " ").trim();
    if (next === key) return key;
    key = next;
  }
}

/** The designator letter requested by the LABEL, if it carries one ("HR 858 d" -> "d"; "TOI-2016.01" -> null). */
export function labelDesignatorOf(targetId: string): string | null {
  const m = targetId.trim().match(PLANET_SUFFIX);
  return m ? m[1].toLowerCase() : null;
}

/** The designator letter of a crossmatched known-planet name ("HR 858 b" -> "b"). */
export function knownDesignatorOf(knownPlanetName: string): string | null {
  const m = knownPlanetName.trim().match(PLANET_SUFFIX);
  return m ? m[1].toLowerCase() : null;
}

/**
 * A canonical fingerprint of the recovered signal, at the precision the sixth-round audit merged on: host star, period
 * rounded to 1e-9 days, depth in whole ppm, SNR rounded to 1e-6. Equal keys == one physical candidate.
 */
export function signalKeyOf(targetId: string, periodDays: number, depthFrac: number, snr: number): string {
  const ppm = Math.round(depthFrac * 1e6);
  const per = Number.isFinite(periodDays) ? Math.round(periodDays * 1e9) : "nan";
  const sn = Number.isFinite(snr) ? Math.round(snr * 1e6) : "nan";
  return `${hostKeyOf(targetId)}|${per}|${ppm}|${sn}`;
}

interface CrossmatchLike {
  matchedKnownPlanet?: boolean;
  knownPlanetName?: string;
}

/**
 * Does the label's requested planet disagree with the finding's OWN detected-planet crossmatch? Only meaningful when a
 * same-host known-planet name is present; a mismatch (different designator letter on the same star) is the D1 conflict.
 */
export function labelConflict(
  targetId: string,
  crossmatch?: CrossmatchLike,
): { conflict: boolean; requested: string | null; detected: string | null } {
  const req = labelDesignatorOf(targetId);
  const known = crossmatch?.knownPlanetName;
  const det = known ? knownDesignatorOf(known) : null;
  const sameHost = !!known && hostKeyOf(known) === hostKeyOf(targetId);
  return { conflict: sameHost && req != null && det != null && req !== det, requested: req, detected: det };
}

/** Group findings by signalKey; groups with >1 member are the duplicate-label rows (D1/D2/D3 evidence). */
export function groupBySignal<T extends { targetId: string; candidate: { periodDays: number; depthFrac: number; snr: number } }>(
  findings: T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const f of findings) {
    const k = signalKeyOf(f.targetId, f.candidate.periodDays, f.candidate.depthFrac, f.candidate.snr);
    const arr = out.get(k);
    if (arr) arr.push(f);
    else out.set(k, [f]);
  }
  return out;
}
