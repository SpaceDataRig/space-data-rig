// The orchestrator: a 5-seat pipeline that drives one target star from raw
// data to an anchored, reproducible finding.
//
//   data-fetch -> anomaly-scout -> sim-runner -> mission-critic -> reporter
//
// Design notes:
//   - Every seat writes to a shared RigStore and emits RigEvents. The store is
//     the single source of truth; the API/SSE layer just subscribes to it, so
//     the same orchestrator powers both the CLI and the live web frontend.
//   - After each target we SAVE a snapshot. A long multi-sector run can be
//     interrupted and resumed with { resume: true } -- already-completed tasks
//     are skipped, which is the OpenRig snapshot/restore guarantee.
//   - Seats are async and separated so a real MAST photometry fetch can later
//     replace the synthetic light-curve stand-in in dataFetch() with no change
//     to the downstream seats.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RigStore, type BundleRecord } from "../core/store.ts";
import type { ArchivePlanet, Finding, LightCurve, Task } from "../core/types.ts";
import { fetchConfirmedPlanets, type ArchiveFetchResult } from "../data/exoplanetArchive.ts";
import { generateSyntheticTransit, type InjectedTruth } from "../data/synthetic.ts";
import { mainSequenceMassFromRadius } from "../sim/transitModel.ts";
import { curatedMastFor, truthFromCatalog } from "../data/mastCurated.ts";
import { fetchMastProductBytes, fitsToLightCurve } from "../data/mast.ts";
import { discoverAndFetchLightCurve } from "../data/mastDiscover.ts";
import type { DetectionResult } from "../detect/pipeline.ts";
import type { ConfidenceResult } from "../sim/confidence.ts";
import type { ReviewResult } from "../critic/review.ts";
// Science compute lives in the runtime-agnostic seat core (shared with the Cloudflare
// RigRunWorkflow); the orchestrator keeps only the store + fs + event side effects.
import { computeDataHash, scout, simulate, critique, report } from "../seats/seats.ts";
import { persistBundle, type EphemerisRecord } from "../bundle/bundle.ts";
import { FsArtifactStore } from "../node/artifact-store.ts";
import { readCodeVersion } from "../node/code-version.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

export interface OrchestratorOptions {
  /** how many target stars to process (default 4). */
  maxTargets?: number;
  /** NASA catalog query knobs. */
  maxTmag?: number;
  minPeriodDays?: number;
  maxPeriodDays?: number;
  /** injection-recovery trials per signal for the confidence estimate (default 8). */
  confidenceTrials?: number;
  /** optional pause between stages so the live feed is watchable (default 0). */
  stageDelayMs?: number;
  /** where findings/SVGs/bundles/state are written (default <repo>/out). */
  outDir?: string;
  /** snapshot file for checkpoint/restore (default <outDir>/state/rig.json). */
  snapshotPath?: string;
  /** resume from an existing snapshot, skipping completed tasks. */
  resume?: boolean;
  /** inject a catalog (tests / offline); otherwise fetched live. */
  catalog?: ArchiveFetchResult;
  /**
   * Attempt anonymous MAST CAOM discovery for targets that are not in the
   * curated registry, before falling back to the synthetic stand-in. Off by
   * default: verified 2026-10-10 that the CAOM query services return empty for
   * anonymous callers, so this only pays off when MAST_DISCOVER (or a token)
   * is supplied on a network where the portal responds.
   */
  discoverMast?: boolean;
  /** run label for logging. */
  runId?: string;
}

/** Per-target working memory handed from seat to seat. */
interface TargetContext {
  task: Task;
  planet: ArchivePlanet;
  index: number;
  lc?: LightCurve;
  truth?: InjectedTruth;
  detection?: DetectionResult;
  confidence?: ConfidenceResult;
  review?: ReviewResult;
  ephemeris?: EphemerisRecord;
  finding?: Finding;
  dataHash?: string;
  bundleHash?: string;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface RunSummary {
  runId: string;
  targets: number;
  accepted: number;
  review: number;
  rejected: number;
  bundles: number;
  findings: Finding[];
  catalogSource: string;
}

export class Orchestrator {
  readonly store: RigStore;
  private opts: Required<Pick<OrchestratorOptions, "maxTargets" | "maxTmag" | "minPeriodDays" | "maxPeriodDays" | "confidenceTrials" | "stageDelayMs" | "outDir" | "snapshotPath" | "resume">>;
  private discoverMast: boolean;
  private catalogOverride?: ArchiveFetchResult;
  private codeVersion: string;
  private artifacts: FsArtifactStore;

  constructor(store?: RigStore, options: OrchestratorOptions = {}) {
    this.store = store ?? new RigStore(options.runId);
    if (options.runId && !store) this.store.runId = options.runId;
    this.opts = {
      maxTargets: options.maxTargets ?? 4,
      maxTmag: options.maxTmag ?? 11,
      minPeriodDays: options.minPeriodDays ?? 1,
      maxPeriodDays: options.maxPeriodDays ?? 14,
      confidenceTrials: options.confidenceTrials ?? 8,
      stageDelayMs: options.stageDelayMs ?? 0,
      outDir: options.outDir ?? resolve(REPO_ROOT, "out"),
      snapshotPath: options.snapshotPath ?? resolve(options.outDir ?? resolve(REPO_ROOT, "out"), "state", "rig.json"),
      resume: options.resume ?? false,
    };
    this.catalogOverride = options.catalog;
    this.discoverMast = options.discoverMast ?? (typeof process !== "undefined" && process.env?.MAST_DISCOVER === "1");
    this.codeVersion = readCodeVersion(resolve(REPO_ROOT, "package.json"));
    this.artifacts = new FsArtifactStore(this.opts.outDir);
  }

  private get findingsDir(): string {
    return resolve(this.opts.outDir, "findings");
  }

  private get bundlesDir(): string {
    return resolve(this.opts.outDir, "bundles");
  }

  /** Run the whole pipeline. Resolves with a summary; safe to call in background. */
  async run(): Promise<RunSummary> {
    mkdirSync(this.findingsDir, { recursive: true });
    mkdirSync(this.bundlesDir, { recursive: true });
    mkdirSync(dirname(this.opts.snapshotPath), { recursive: true });

    // ---- restore (snapshot/restore) ----
    if (this.opts.resume && this.store.load(this.opts.snapshotPath)) {
      this.store.emitEvent("reporter", "info", `Resumed from snapshot ${this.opts.snapshotPath} (run ${this.store.runId}).`);
    }

    const t0 = Date.now();
    this.store.emitEvent("data-fetch", "info", `Starting run ${this.store.runId}: querying the NASA Exoplanet Archive for bright transiting systems.`);

    // ---- data-fetch (catalog) ----
    this.store.setSeatStatus("data-fetch", "running", "Querying NASA Exoplanet Archive");
    const cat = this.catalogOverride ?? (await fetchConfirmedPlanets({
      maxTmag: this.opts.maxTmag,
      limit: Math.max(40, this.opts.maxTargets * 6),
      minPeriodDays: this.opts.minPeriodDays,
      maxPeriodDays: this.opts.maxPeriodDays,
    }));
    this.store.emitEvent(
      "data-fetch",
      cat.source === "nasa-tap" ? "result" : "warn",
      `Catalog ready: ${cat.planets.length} confirmed planets (source=${cat.source}).`,
      { source: cat.source, count: cat.planets.length },
    );
    this.store.setSeatStatus("data-fetch", "done", `${cat.planets.length} planets loaded`);

    // pick targets with enough real parameters to build a physical light curve
    const targets = cat.planets
      .filter((p) => p.pl_orbper != null && p.st_rad != null && (p.pl_rade ?? 0) > 0)
      .slice(0, this.opts.maxTargets);

    this.store.emitEvent("data-fetch", "info", `Selected ${targets.length} targets for transit analysis.`);

    // ---- pipeline over targets ----
    for (let i = 0; i < targets.length; i++) {
      const planet = targets[i];
      const name = planet.pl_name ?? planet.hostname ?? `TARGET-${i}`;
      const taskId = `T-${slug(name)}`;

      // resume support: skip tasks already completed in a restored snapshot
      const existing = this.store.getTask(taskId);
      if (this.opts.resume && existing && (existing.status === "done" || existing.status === "failed")) {
        this.store.emitEvent("reporter", "info", `Skipping ${name}: already ${existing.status} in snapshot.`);
        continue;
      }

      const task: Task = existing ?? {
        id: taskId,
        kind: "transit-search",
        targetId: planet.hostname ?? name,
        params: { planet: name, periodDays: planet.pl_orbper, tmag: planet.sy_tmag },
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      this.store.addTask(task);

      const ctx: TargetContext = { task, planet, index: i };
      try {
        await this.seatDataFetch(ctx, cat);
        await this.seatAnomalyScout(ctx);
        await this.seatSimRunner(ctx);
        await this.seatMissionCritic(ctx, cat);
        await this.seatReporter(ctx, cat);
        this.store.updateTask(task.id, { status: "done", findingId: ctx.finding?.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.store.emitEvent("reporter", "error", `Task ${name} failed: ${msg}`);
        this.store.updateTask(task.id, { status: "failed" });
      }
      // checkpoint after every target
      this.store.save(this.opts.snapshotPath);
    }

    const findings = this.store.listFindings();
    const summary: RunSummary = {
      runId: this.store.runId,
      targets: targets.length,
      accepted: findings.filter((f) => f.verdict === "accepted").length,
      review: findings.filter((f) => f.verdict === "needs-more-data").length,
      rejected: findings.filter((f) => f.verdict === "rejected").length,
      bundles: this.store.listBundles().length,
      findings,
      catalogSource: cat.source,
    };
    this.store.emitEvent("reporter", "result", `Run finished in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${summary.accepted} confirmed, ${summary.review} watchlist, ${summary.rejected} rejected.`, {
      runId: summary.runId,
      targets: summary.targets,
      accepted: summary.accepted,
      review: summary.review,
      rejected: summary.rejected,
      bundles: summary.bundles,
      catalogSource: summary.catalogSource,
    });
    this.store.save(this.opts.snapshotPath);
    return summary;
  }

  // ---- SEAT 1: data-fetch --------------------------------------------------
  private async seatDataFetch(ctx: TargetContext, cat: ArchiveFetchResult): Promise<void> {
    const { task, planet, index } = ctx;
    this.store.updateTask(task.id, { status: "fetching" });
    this.store.setSeatStatus("data-fetch", "running", `Observing ${planet.pl_name ?? planet.hostname}`);
    const name = planet.pl_name ?? planet.hostname ?? `TARGET-${index}`;
    this.store.emitEvent("data-fetch", "info", `Building an observable light curve for ${name} (P=${planet.pl_orbper?.toFixed(3)}d, Rp=${planet.pl_rade?.toFixed(2)} R_Earth, R*=${planet.st_rad?.toFixed(2)} R_Sun).`);
    await sleep(this.opts.stageDelayMs);

    // Real MAST photometry first when a curated product exists for this host;
    // otherwise the real-parameter injection stand-in (identical cadence, sector
    // length and duty-cycle gaps). lc.source always states which path produced
    // the data -- never let a stand-in masquerade as an observation.
    let lc: LightCurve;
    let truth: InjectedTruth;
    const curated = curatedMastFor(planet.hostname);
    if (curated) {
      try {
        this.store.emitEvent("data-fetch", "info", `Real MAST photometry is on file for ${name} -- fetching ${curated.label} ...`);
        const bytes = await fetchMastProductBytes(curated.productUri);
        lc = fitsToLightCurve(bytes, curated.label);
        truth = truthFromCatalog(planet);
        lc.source = `MAST TESS product ${curated.productUri.split("/").pop()} (REAL photometry); ${curated.note ?? ""}; catalog source=${cat.source}`.trim();
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.store.emitEvent("data-fetch", "warn", `MAST download for ${name} failed (${why.slice(0, 120)}) -- falling back to the synthetic stand-in.`);
        const built = this.buildStandIn(planet, index, cat.source);
        lc = built.lc;
        truth = built.truth;
      }
    } else {
      // Not curated: optionally let MAST discovery find a real product by
      // coordinate before falling back to the stand-in. Anonymous CAOM queries
      // return empty (verified), so this is a no-op unless a token/network
      // makes the portal respond -- the stand-in keeps the run deterministic.
      let discovered: LightCurve | null = null;
      if (this.discoverMast && Number.isFinite(planet.ra) && Number.isFinite(planet.dec)) {
        this.store.emitEvent("data-fetch", "info", `No curated product for ${name} -- asking MAST to discover one at (${planet.ra!.toFixed(3)}, ${planet.dec!.toFixed(3)}) ...`);
        discovered = await discoverAndFetchLightCurve(planet.ra!, planet.dec!, name);
      }
      if (discovered) {
        lc = discovered;
        truth = truthFromCatalog(planet);
        lc.source = `${lc.source}; ${cat.source ? `catalog source=${cat.source}` : ""}`.trim();
        this.store.emitEvent("data-fetch", "result", `Discovered real MAST photometry for ${name} via anonymous CAOM query.`);
      } else {
        if (this.discoverMast) this.store.emitEvent("data-fetch", "warn", `MAST discovery returned nothing for ${name} (anonymous CAOM queries are empty without a token) -- using the synthetic stand-in.`);
        const built = this.buildStandIn(planet, index, cat.source);
        lc = built.lc;
        truth = built.truth;
      }
    }
    lc.dataHash = await computeDataHash(lc);

    ctx.lc = lc;
    ctx.truth = truth;
    ctx.dataHash = lc.dataHash;
    this.store.markSeatProcessed("data-fetch");
    this.store.emitEvent("data-fetch", "result", `${lc.points.length} photometry points ready for ${name} (data hash ${lc.dataHash!.slice(0, 12)}...).`, { points: lc.points.length, dataHash: lc.dataHash });
    this.store.setSeatStatus("data-fetch", "idle", `Fetched ${name}`);
  }

  // ---- SEAT 1 helper: seeded synthetic stand-in (default path) --------------
  private buildStandIn(planet: ArchivePlanet, index: number, catalogSource: string): { lc: LightCurve; truth: InjectedTruth } {
    const name = planet.pl_name ?? planet.hostname ?? `TARGET-${index}`;
    const { lc, truth } = generateSyntheticTransit({
      seed: 7000 + index,
      periodDays: planet.pl_orbper!,
      planetRadiusEarth: planet.pl_rade!,
      stellarRadiusRsun: planet.st_rad!,
      stellarMassMsun: planet.st_mass ?? mainSequenceMassFromRadius(planet.st_rad!), // catalog mass; empirical M-R only as fallback
      impactParam: 0.2 + (index % 3) * 0.15,
      noisePpm: 180,
      cadenceSec: 120,
      baselineDays: 27,
      targetIdLabel: planet.hostname ?? name,
    });
    lc.source = `synthetic stand-in for MAST TESS 2-min (seed=${7000 + index}); catalog source=${catalogSource}`;
    return { lc, truth };
  }

  // ---- SEAT 2: anomaly-scout ----------------------------------------------
  private async seatAnomalyScout(ctx: TargetContext): Promise<void> {
    const { task, lc } = ctx;
    if (!lc) throw new Error("no light curve");
    this.store.updateTask(task.id, { status: "analyzing" });
    this.store.setSeatStatus("anomaly-scout", "running", `BLS search on ${lc.targetId}`);
    this.store.emitEvent("anomaly-scout", "info", `Running Box-Least-Squares transit search on ${lc.targetId} ...`);
    await sleep(this.opts.stageDelayMs);

    const det = scout(lc);
    ctx.detection = det;
    const c = det.candidate;
    this.store.markSeatProcessed("anomaly-scout");
    this.store.emitEvent(
      "anomaly-scout",
      "result",
      `Candidate on ${lc.targetId}: P=${c.periodDays.toFixed(4)}d, depth=${(c.depthFrac * 1e6).toFixed(0)}ppm, SNR=${c.snr.toFixed(1)}, odd-even alias x${det.aliasMultiple}.`,
      { periodDays: c.periodDays, depthFrac: c.depthFrac, snr: c.snr, aliasMultiple: det.aliasMultiple },
    );
    this.store.setSeatStatus("anomaly-scout", "idle", `Found candidate on ${lc.targetId}`);
  }

  // ---- SEAT 3: sim-runner --------------------------------------------------
  private async seatSimRunner(ctx: TargetContext): Promise<void> {
    const { task, lc, detection } = ctx;
    if (!lc || !detection) throw new Error("missing detection");
    this.store.updateTask(task.id, { status: "simulating" });
    this.store.setSeatStatus("sim-runner", "running", `Injection-recovery replay for ${lc.targetId}`);
    const c = detection.candidate;
    this.store.emitEvent("sim-runner", "info", `Replaying the ${lc.targetId} signal through ${this.opts.confidenceTrials} fresh noise realizations to measure how reliable it is ...`);
    await sleep(this.opts.stageDelayMs);

    const sim = simulate({ lc, detection, planet: ctx.planet, index: ctx.index, confidenceTrials: this.opts.confidenceTrials });
    const conf = sim.confidence;
    const noisePpm = sim.noisePpm;
    ctx.confidence = conf;
    ctx.ephemeris = sim.ephemeris;

    this.store.markSeatProcessed("sim-runner");
    this.store.emitEvent(
      "sim-runner",
      "result",
      `Recovery confidence ${(conf.confidence * 100).toFixed(0)}% (${conf.nRecovered}/${conf.nTrials}); noise ~${noisePpm.toFixed(0)}ppm; next transits predicted at BJD ${conf.nextTransitsBjd.map((t) => t.toFixed(3)).join(", ") || "n/a"}.`,
      { confidence: conf.confidence, noisePpm, nextTransitsBjd: conf.nextTransitsBjd },
    );
    this.store.setSeatStatus("sim-runner", "idle", `Assessed ${lc.targetId}`);
  }

  // ---- SEAT 4: mission-critic ---------------------------------------------
  private async seatMissionCritic(ctx: TargetContext, cat: ArchiveFetchResult): Promise<void> {
    const { task, detection, confidence } = ctx;
    if (!detection) throw new Error("missing detection");
    this.store.updateTask(task.id, { status: "reviewing" });
    this.store.setSeatStatus("mission-critic", "running", `Reviewing ${detection.candidate.targetId}`);
    await sleep(this.opts.stageDelayMs);

    // recovery mode: stand-in paths grade against the injection; real-photometry paths
    // grade against the published catalog value -- an honest open-loop cross-check.
    const review = critique({
      detection,
      catalog: cat.planets,
      hostName: ctx.planet.hostname,
      confidence,
      truthPeriodDays: ctx.truth?.periodDays,
      truthSource: (ctx.lc?.source ?? "").includes("REAL photometry") ? "catalog" : "injected",
    });
    ctx.review = review;

    this.store.markSeatProcessed("mission-critic");
    this.store.emitEvent(
      "mission-critic",
      review.verdict === "accepted" ? "result" : review.verdict === "needs-more-data" ? "warn" : "info",
      `Verdict for ${detection.candidate.targetId}: ${review.verdict.toUpperCase()} (score ${review.score}/100) -- ${review.reason}`,
      { verdict: review.verdict, score: review.score, crossmatch: review.crossmatch },
    );
    this.store.setSeatStatus("mission-critic", "idle", `Reviewed ${detection.candidate.targetId}`);
  }

  // ---- SEAT 5: reporter ----------------------------------------------------
  private async seatReporter(ctx: TargetContext, cat: ArchiveFetchResult): Promise<void> {
    const { task, lc, detection, confidence, review, ephemeris } = ctx;
    if (!lc || !detection || !review) throw new Error("missing pipeline output");
    this.store.setSeatStatus("reporter", "running", `Packaging ${lc.targetId}`);
    await sleep(this.opts.stageDelayMs);

    const name = ctx.planet.pl_name ?? ctx.planet.hostname ?? `TARGET-${ctx.index}`;
    const findingId = `F-${slug(name)}`;

    // reporter compute is pure + runtime-agnostic: build the Finding, render the three
    // SVG plots in memory, and compose the reproducible bundle manifest + hash.
    const out = await report({
      lc,
      detection,
      confidence,
      review,
      ephemeris,
      findingId,
      runId: this.store.runId,
      codeVersion: this.codeVersion,
      catalogSource: cat.source,
      dataHash: ctx.dataHash,
      lightCurveSource: lc.source,
    });
    const { finding, composed } = out;
    const bundleHash = composed.hash;

    // persist bundles/<id>/{svg,manifest.json,HASH.txt} via the fs ArtifactStore
    // (identical key layout to R2, so verify/read code is shared across runtimes).
    await persistBundle(this.artifacts, composed, out.artifacts);
    // also drop a copy in findings/ for the P0-style gallery
    for (const a of out.artifacts) writeFileSync(resolve(this.findingsDir, `${findingId}-${a.name}`), a.bytes);

    const bundle: BundleRecord = {
      findingId,
      hash: bundleHash,
      files: [...out.artifacts.map((a) => a.name), "manifest.json", "HASH.txt"],
      createdAt: finding.createdAt,
    };
    this.store.addBundle(bundle);
    this.store.addFinding(finding);
    this.store.updateTask(task.id, { findingId });

    this.store.markSeatProcessed("reporter");
    this.store.emitEvent(
      "reporter",
      "result",
      `${finding.narration!.headline} [bundle ${bundleHash.slice(0, 12)}...]`,
      { findingId, bundleHash, verdict: finding.verdict },
    );
    this.store.setSeatStatus("reporter", "idle", `Published ${findingId}`);
  }
}
