// CANDIDATE SNAPSHOT CONTRACT (discovery roadmap, Stage 4 -- the data boundary for surfacing candidates).
//
// The blind-search pipeline (p22) produces candidate rows offline. If we ever SHOW them on the public
// console, they cross a trust boundary: a malformed or over-claiming record must never reach a visitor.
// This module defines the exact on-the-wire shape (web/candidates.json, served as a static asset) and a
// validator that ENFORCES the honesty invariant at that boundary -- above all, that no row may carry a
// discovery claim. p22 runs validateSnapshot before writing, so a bad snapshot fails the build rather than
// publishing something misleading; the front-end additionally renders defensively.
//
// PURE + RESEARCH-ONLY. No network, no worker import, cannot touch a verdict / bundle hash / money path.

export const CANDIDATE_SCHEMA = "sdr-candidates/1";

export const CANDIDATE_DISCLAIMER =
  "These are CANDIDATES from an automated blind search over real TESS full-frame-image photometry. They are " +
  "NOT discoveries and NOT peer-reviewed: most are expected to be false positives (eclipsing binaries, " +
  "background blends, or instrumental systematics). They are shown for transparency about what the pipeline " +
  "sees, are NOT anchored on-chain, and are kept entirely separate from the verified results above.";

export interface CandidateRow {
  tic: number;
  ra: number;
  dec: number;
  tmag: number;
  periodDays: number;
  epochBjd: number;
  depthPpm: number;
  snr: number;
  tier: string; // Stage-2 confidence tier (high|moderate|low|sub-floor|not-novel|not-planetary)
  depthRegime: string; // planet-plausible | deep-suspect | not-planetary | unknown
  priorityBand: string; // high | medium | low | not-rankable
  priorityScore: number; // 0..1
  nextTransitBjd: number | null;
  daysUntilNext: number | null;
  altitudeDeg: number | null; // mid-transit altitude from the reference site
  observable: boolean;
  siteName: string;
  distinctHostsSharingEphemeris: number; // >1 -> a suspected sector-common systematic, not independent planets
  suspectedCommonSystematic: boolean;
  corroboratedSectors: number; // distinct sectors the SAME host's ephemeris recurs in (>=2 = cross-sector corroboration)
  discoveryClaim: false; // honesty invariant: structurally always false
}

export interface CandidateSummary {
  rawDetections: number;
  planetPlausible: number;
  independentEphemerides: number;
  multiHostSystematicGroups: number;
  corroboratedHosts: number;
}

export interface CandidateSnapshot {
  schema: typeof CANDIDATE_SCHEMA;
  generatedAt: string; // ISO timestamp of the pipeline run
  sectors: number[];
  referenceSite: string;
  disclaimer: string;
  calibrationNote: string;
  summary: CandidateSummary;
  candidates: CandidateRow[];
}

export type SnapshotValidation = { ok: true; snapshot: CandidateSnapshot } | { ok: false; errors: string[] };

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isNumOrNull(x: unknown): boolean {
  return x === null || isNum(x);
}

/**
 * Validate an unknown blob against the candidate snapshot contract. Returns the typed snapshot when it is
 * well-formed, or a list of human-readable errors. The non-negotiable rule: EVERY candidate row must have
 * discoveryClaim === false; anything else is rejected outright.
 */
export function validateSnapshot(obj: unknown): SnapshotValidation {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: ["snapshot is not an object"] };
  const s = obj as Record<string, unknown>;

  if (s.schema !== CANDIDATE_SCHEMA) errors.push(`schema must be "${CANDIDATE_SCHEMA}"`);
  if (typeof s.generatedAt !== "string" || !s.generatedAt) errors.push("generatedAt must be a non-empty string");
  if (typeof s.referenceSite !== "string" || !s.referenceSite) errors.push("referenceSite must be a non-empty string");
  if (typeof s.disclaimer !== "string" || !s.disclaimer) errors.push("disclaimer must be a non-empty string");
  if (!Array.isArray(s.sectors) || !s.sectors.every(isNum)) errors.push("sectors must be an array of numbers");

  const sum = s.summary as Record<string, unknown> | undefined;
  if (!sum || typeof sum !== "object") errors.push("summary object missing");
  else for (const k of ["rawDetections", "planetPlausible", "independentEphemerides", "multiHostSystematicGroups", "corroboratedHosts"]) {
    if (!isNum(sum[k])) errors.push(`summary.${k} must be a finite number`);
  }

  if (!Array.isArray(s.candidates)) errors.push("candidates must be an array");
  else {
    s.candidates.forEach((raw, i) => {
      const r = raw as Record<string, unknown>;
      const at = (msg: string): void => { errors.push(`candidates[${i}]: ${msg}`); };
      if (typeof r !== "object" || r === null) { at("not an object"); return; }
      if (r.discoveryClaim !== false) at(`discoveryClaim MUST be false (got ${JSON.stringify(r.discoveryClaim)})`);
      if (!isNum(r.tic)) at("tic must be a finite number");
      if (!isNum(r.periodDays) || (r.periodDays as number) <= 0) at("periodDays must be a positive finite number");
      if (!isNum(r.epochBjd)) at("epochBjd must be a finite number");
      if (!isNum(r.depthPpm)) at("depthPpm must be a finite number");
      if (!isNumOrNull(r.snr)) at("snr must be a number or null");
      if (typeof r.tier !== "string" || !r.tier) at("tier must be a non-empty string");
      if (typeof r.depthRegime !== "string" || !r.depthRegime) at("depthRegime must be a non-empty string");
      if (typeof r.priorityBand !== "string" || !r.priorityBand) at("priorityBand must be a non-empty string");
      if (!isNum(r.priorityScore) || (r.priorityScore as number) < 0 || (r.priorityScore as number) > 1) at("priorityScore must be in [0,1]");
      if (!isNumOrNull(r.nextTransitBjd)) at("nextTransitBjd must be a number or null");
      if (!isNumOrNull(r.altitudeDeg)) at("altitudeDeg must be a number or null");
      if (typeof r.observable !== "boolean") at("observable must be a boolean");
      if (typeof r.suspectedCommonSystematic !== "boolean") at("suspectedCommonSystematic must be a boolean");
      if (!isNum(r.distinctHostsSharingEphemeris) || (r.distinctHostsSharingEphemeris as number) < 1) at("distinctHostsSharingEphemeris must be >= 1");
      if (!isNum(r.corroboratedSectors) || (r.corroboratedSectors as number) < 0) at("corroboratedSectors must be >= 0");
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, snapshot: obj as CandidateSnapshot };
}
