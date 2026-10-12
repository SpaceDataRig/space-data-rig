# Changelog

All notable changes to Space Data Rig are documented here. This project aims to follow
Keep a Changelog and adheres to Semantic Versioning.

## v0.1.0

First tagged release of the reproducible exoplanet transit research rig.

### Platform
- Reproducible transit pipeline: NASA Exoplanet Archive + TESS candidates -> token-free TESS-SPOC
  public-S3 real photometry -> Box-Least-Squares detection -> exact limb-darkened depth/shape fit ->
  blind mission-critic -> sealed, reproducible result bundle.
- Runs identically on Node (local/dev) and Cloudflare Workers (production: Durable Object state,
  Workflows, R2 artifacts); live at spacedatarig.app on an hourly autonomous schedule.
- Content-addressed provenance anchoring to Solana mainnet for accepted findings, behind an explicit,
  budgeted switch.
- Deterministic, offline-safe core: fixed-seed pure functions; the full test suite plus Node and
  worker type-checks run on every push and pull request in CI.

### Science
- A pixel -> shape -> depth -> size -> error-calibration chain, reproduced on real confirmed planets.
- Exact limb-darkened transit fit and a per-candidate empirical false-alarm probability calibrated to
  each star's own noise color (quiet vs red-noise active hosts).
- Measured findings recorded honestly: the limb-darkening floor is not removable from the light curve
  (fitting u1 lowers rms but leaves true-depth error unchanged -> a shape degeneracy); statistical
  error bars under-cover and are brought to ~68% coverage only by an empirical inflation factor.
- Long-period depth accuracy is limited by phase coherence, not data volume: a robust per-sector
  median beats a naive multi-season long fold (measured 24.9% vs 34.7% median depth error, 18 planets).

### Independent review
- A reusable library to independently audit a THIRD-PARTY planet candidate: novelty vs the confirmed +
  TOI lists, Gaia host parameters and neighbour dilution / blend risk, a blind re-detection with the
  claim's ephemeris withheld, geometry self-consistency, unified significance, and a catalog version
  stamp. Research-only -- it never gates, accepts, or anchors.

### Robustness fixes
- Gaia `source_id` is cast to text at the query so IDs beyond 2^53 survive JSON parsing (previously a
  silently-rounded value produced a false "no such star").
- Per-sector robust depth is wired into the production scout step behind an explicit, default-off flag.
- A cadence-aware transit-box width is available opt-in; the default detector is byte-for-byte unchanged.

Safety: the rig measures and re-verifies. It makes no new-planet discovery claim, and any external
candidate it reviews remains attributed to its original author.
