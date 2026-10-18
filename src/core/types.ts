// Core domain types for the Space Data Rig pipeline.
// Shared by every seat: data-fetch, anomaly-scout, sim-runner, mission-critic, reporter.

/** A single photometric observation point (time in BJD, normalized flux, uncertainty). */
export interface LightCurvePoint {
  time: number; // BJD (Barycentric Julian Date)
  flux: number; // normalized flux (1.0 = out-of-transit baseline)
  fluxErr?: number; // 1-sigma uncertainty on flux
}

/** A raw or processed light curve for one target star. */
export interface LightCurve {
  targetId: string; // e.g. "TIC 261136679" or "KIC 10666592"
  mission: "TESS" | "Kepler" | "synthetic";
  cadenceSec?: number; // e.g. 120 for TESS 2-min
  points: LightCurvePoint[];
  /** SHA-256 of the serialized source data, for provenance. */
  dataHash?: string;
  /** Provenance: where this came from. */
  source?: string;
}

/** Result of a BLS transit search on one light curve. */
export interface TransitCandidate {
  targetId: string;
  periodDays: number; // best-fit orbital period
  epochBjd: number; // best-fit transit center time (T0)
  durationHours: number; // transit duration
  depthPpt: number; // transit depth in parts-per-thousand
  depthFrac: number; // transit depth as a fraction (e.g. 0.01 = 1%)
  snr: number; // signal-to-noise of the detection
  /**
   * Grid-limited 1-sigma period uncertainty in DAYS: P^2 * df, where df = 1/(oversample*baseline). The period is
   * a discrete trial-grid node, not a fitted continuous value, so this is the resolution the search actually had.
   * It grows as P^2 -- about 0.02 d at P=2 d but about 1.2 d at P=16 d on a 27-day baseline -- which is why every
   * period must be rendered against it instead of with a fixed number of decimals (src/core/periodFormat.ts).
   * Absent on records written before the detector started reporting it, in which case a conservative bound is used.
   */
  periodResolutionDays?: number;
  /**
   * True when the adopted peak is the LONG-PERIOD EDGE of the trial grid rather than an interior maximum: the
   * signal wanted a longer period than the search allowed, or a trend/red-noise ramp piled up against the wall.
   * Such a period is an UPPER BOUND on nothing and a measurement of nothing, so it must never be published as
   * "P=16.00d"; it is published as "at the N-day search limit". Measured on the live rig: 3 of 90 findings sat
   * exactly on the k=0 node of a 16-day maximum, one of which had already been announced on the public feed.
   */
  atSearchBoundary?: boolean;
  /** The grid maximum the search ran to, kept so the boundary can be stated as a number in prose. */
  searchMaxPeriodDays?: number;
  power: number; // BLS signal-residue power
  /** Estimated planet radius in Earth radii (needs stellar radius). */
  radiusEarth?: number;
  nPointsInTransit: number;
  /** Per-fold phase curve for plotting (phase, folded flux). */
  folded?: { phase: number; flux: number }[];
}

/** A verified scientific finding ready for provenance anchoring. */
export interface Finding {
  id: string;
  targetId: string;
  candidate: TransitCandidate;
  /** mission-critic verdict */
  verdict: "accepted" | "rejected" | "needs-more-data";
  verdictReason: string;
  /** Cross-match result against the NASA Exoplanet Archive. */
  crossmatch: {
    matchedKnownPlanet: boolean;
    knownPlanetName?: string;
    knownPeriodDays?: number;
    periodDeltaPct?: number;
  };
  /** sim-runner injection-recovery confidence for this signal (0..1). */
  recoveryConfidence?: number;
  /**
   * Trial counts behind recoveryConfidence (targeted re-injection Monte Carlo), so the
   * UI can show the number with its sample size + binomial CI instead of a bare integer
   * percent. Not part of the bundle manifest, so adding it moves no bundle hash.
   */
  recoveryTrials?: { nTrials: number; nRecovered: number };
  /** mission-critic composite score (0..100), used to rank the findings board. */
  score?: number;
  /** sim-runner predicted next transits (falsifiable follow-up targets). */
  ephemeris?: { t0Bjd: number; periodDays: number; nextTransitsBjd: number[] };
  /** reporter's plain-language rendering, cached so the frontend needs no extra call. */
  narration?: { headline: string; explainer: string };
  createdAt: string; // ISO timestamp
  bundleHash?: string; // SHA-256 of the reproducible analysis bundle
  solanaTx?: string; // Solana transaction signature once anchored
  /**
   * audit-5 (audience-legibility): what this row IS in the rotating survey. "revalidation" (or absent,
   * for every pre-rotation row) = the pipeline re-verified a KNOWN confirmed planet; "blind-toi" = an
   * UNCONFIRMED TESS Object of Interest that the detector recovered BLIND on real photometry (the TOI
   * ephemeris is never shown to the detector). This is a display/provenance label ONLY -- it lives on the
   * Finding and in DO state, and is deliberately NOT part of the bundle manifest, so adding it moves no
   * bundleHash and never touches an already-anchored row. A blind-toi finding is capped at needs-more-data
   * and is never auto-anchored (it is a candidate for human follow-up, not a claimed discovery).
   */
  origin?: "revalidation" | "blind-toi";
}

/** A unit of work flowing through the rig. */
export interface Task {
  id: string;
  kind: "transit-search" | "gw-catalog-augment";
  targetId?: string;
  /** For transit-search: the mission/sector to pull. */
  params: Record<string, unknown>;
  status: "queued" | "fetching" | "analyzing" | "simulating" | "reviewing" | "done" | "failed";
  stakedLamports?: number; // token utility (P3), reserved
  createdAt: string;
  findingId?: string;
}

/** Events emitted by seats; consumed by the reporter and the live frontend feed. */
export interface RigEvent {
  ts: string; // ISO timestamp
  seat: SeatName;
  level: "info" | "warn" | "error" | "result";
  /** Human-facing one-liner (reporter-friendly). */
  message: string;
  /** Machine payload. */
  data?: Record<string, unknown>;
}

export type SeatName =
  | "data-fetch"
  | "anomaly-scout"
  | "sim-runner"
  | "mission-critic"
  | "reporter";

/** Known planet record from the NASA Exoplanet Archive (subset we use). */
export interface ArchivePlanet {
  pl_name: string; // e.g. "Kepler-10 b"
  hostname: string; // e.g. "Kepler-10"
  pl_bmasse?: number;
  pl_rade?: number; // planet radius in Earth radii
  pl_orbper?: number; // orbital period in days
  pl_trandep?: number; // transit depth in ppm (archive percent values are normalized on fetch)
  pl_trandur?: number; // transit duration in hours
  pl_tranmid?: number; // transit midpoint epoch T0 (BJD TDB)
  st_rad?: number; // stellar radius in solar radii
  st_mass?: number; // stellar mass in solar masses (pscomppars column)
  ra?: number;
  dec?: number;
  /** TESS Input Catalog id; enables the token-free TESS-SPOC S3 photometry tier. */
  tic?: number;
  sy_tmag?: number; // TESS magnitude
  sy_kmag?: number; // Kepler magnitude
  discoverymethod?: string;
}
