// RigRunWorkflow: durable, CPU-budgeted execution of the 5-seat pipeline.
//
// A Cloudflare Workflow gives us multi-minute, resumable, retryable orchestration
// that a single Worker invocation cannot: each `step.do` is its own durable unit
// with its own CPU budget, so a multi-target run (NASA fetch -> BLS -> injection
// recovery -> critic -> reporter) is decomposed into one step per seat, and the
// run body replays deterministically from stored step results after any restart.
//
// Why this shape (parity + durability):
//   - All SCIENCE runs through the runtime-agnostic seat functions in src/seats so
//     an edge bundle reproduces the same numbers (esp. recoveryConfidence) as the
//     Node Orchestrator -- identical inputs, identical trial seeds.
//   - This Workers build exposes WorkflowStep.do/sleep/waitForEvent only (no map),
//     so the sim-runner's N injection-recovery trials run as ONE step that loops the
//     pure `recoveryTrial` primitive N times and folds with `combineTrials`. That is
//     still fully deterministic and byte-identical to Node's assessSignal, while
//     keeping each invocation well under the 30s CPU ceiling (a handful of trials on
//     a ~12k-point curve is cheap; the whole per-seat chain fits comfortably in one
//     durable step each).
//   - Heavy intermediates (the built light curve, the DetectionResult, the review) are
//     persisted to R2 and read back by the next step, so nothing large crosses the
//     step-boundary RPC; steps return only small handles / summaries.
//   - The DO (RigStateDO) is the SINGLE writer of state: every step submits seat
//     events + task/finding/bundle updates back over DO RPC. The DO is also the run
//     mutex and the WebSocket fan-out. After each target we checkpoint the DO state
//     to the R2 snapshot (`state/rig.json`) via saveSnapshot().
//
// Errors inside a seat are caught INSIDE the step (so the step records a value and is
// not retried forever); the failed task is marked and its finding skipped, exactly as
// the Node Orchestrator skips a throwing target and continues.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { RunParams } from "./run-types.ts";
import { R2ArtifactStore } from "./artifact-store.ts";
import { computeDataHash, scout, simPlan, critique, report } from "../seats/seats.ts";
import { recoveryTrial, combineTrials, predictEphemeris } from "../sim/confidence.ts";
import type { ConfidenceResult } from "../sim/confidence.ts";
import type { DetectionResult } from "../detect/pipeline.ts";
import type { ReviewResult } from "../critic/review.ts";
import { generateSyntheticTransit } from "../data/synthetic.ts";
import { sectorsForCoord, fetchSpocLightCurve } from "../data/mastS3.ts";
import { fetchSpocTargetPixels, centroidShift } from "../data/mastS3Pixels.ts";
import { oddEvenRefined, secondaryEclipse } from "../detect/vetting.ts";
import { calibratedFap } from "../detect/significance.ts";
import type { ReviewVetting } from "../critic/review.ts";
import { mainSequenceMassFromRadius } from "../sim/transitModel.ts";
import { fetchConfirmedPlanets, getFallbackCatalog } from "../data/exoplanetArchive.ts";
import { persistBundle, type EphemerisRecord } from "../bundle/bundle.ts";
import type { ArchivePlanet, Finding, LightCurve } from "../core/types.ts";
import type { ActiveRunSummary, BundleRecord, DashboardState } from "../core/state-types.ts";

// ---- serializable intermediate records persisted to R2 ----------------------

/** Identity + bookkeeping keys for one target, computed deterministically. */
interface TargetMeta {
  name: string;
  hostName?: string;
  taskId: string;
  findingId: string;
  index: number;
}

/** A selected target: the catalog planet + its derived identity + resume flag. */
interface TargetSel {
  planet: ArchivePlanet;
  meta: TargetMeta;
  skipped: boolean;
}

/** What data-fetch writes: the built curve, its identity, and the data hash. */
interface FetchRecord {
  lc: LightCurve;
  meta: TargetMeta;
  dataHash: string;
  truthPeriodDays: number;
  /** SPOC sectors used for the real S3 photometry, so the critic can fetch target pixels. */
  spocSectors?: number[];
}

/** What anomaly-scout writes: the raw DetectionResult (plain nested data). */
interface DetectRecord {
  detection: DetectionResult;
}

/** What mission-critic writes: the ReviewResult, so reporter can re-read it. */
interface ReviewRecord {
  review: ReviewResult;
}

/** The catalog (for cross-matching), persisted once per run. */
interface CatalogRecord {
  planets: ArchivePlanet[];
  source: "nasa-tap" | "fallback";
}

/** A step outcome wrapper that never throws across the step boundary. */
type Safe<T> = { ok: true; value: T } | { ok: false; error: string };

// ---- DO + R2 accessors (WorkflowEntrypoint exposes `this.env`) --------------

function rigStub(env: Env) {
  return env.RIG_STATE.get(env.RIG_STATE.idFromName("rig-state"));
}

function artifacts(env: Env): R2ArtifactStore {
  return new R2ArtifactStore(env.RIG_ARTIFACTS);
}

// ---- deterministic identity helpers (mirror the Node Orchestrator) ----------

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function targetName(p: ArchivePlanet, index: number): string {
  return p.pl_name ?? p.hostname ?? `TARGET-${index}`;
}

function metaFor(p: ArchivePlanet, index: number): TargetMeta {
  const name = targetName(p, index);
  const s = slug(name);
  return { name, hostName: p.hostname, taskId: `T-${s}`, findingId: `F-${s}`, index };
}

// ---- small R2 JSON helpers --------------------------------------------------

async function putJson(store: R2ArtifactStore, key: string, value: unknown): Promise<void> {
  await store.put(key, JSON.stringify(value), "application/json");
}

async function getJson<T>(store: R2ArtifactStore, key: string): Promise<T | null> {
  const text = await store.getText(key);
  return text == null ? null : (JSON.parse(text) as T);
}

/** Run a durable step whose callback never lets an error escape the boundary. */
async function runSafe<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
): Promise<Safe<T>> {
  return step.do(name, async (): Promise<Safe<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export class RigRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep): Promise<ActiveRunSummary> {
    const params = event.payload;
    const env = this.env;
    const stub = rigStub(env);
    const store = artifacts(env);
    const runId = params.runId;
    const ctxBase = `run/${runId}/targets`;

    // ---- SEAT 1 (front half): catalog query + target selection + resume ------
    const selectR = await runSafe(
      step,
      "select-targets",
      async (): Promise<{ targets: TargetSel[]; catalogSource: string }> => {
        await stub.setSeatStatus("data-fetch", "running", "Querying NASA Exoplanet Archive");
        await stub.emitEvent(
          "data-fetch",
          "info",
          `Starting run ${runId}: querying the NASA Exoplanet Archive for bright transiting systems.`,
        );
        const query = {
          maxTmag: params.maxTmag,
          limit: Math.max(40, params.targets * 6),
          minPeriodDays: 1,
          maxPeriodDays: 14,
          // Autonomous mode: when the S3 photometry tier is on, queue only
          // targets that carry a TIC so each has a chance at REAL data. When it
          // is off this is false and the historical query is unchanged.
          requireTic: env.MAST_S3 === "1",
        };
        const catalog: CatalogRecord = params.offline
          ? (() => {
              const fb = getFallbackCatalog(query);
              return { planets: fb.planets, source: "fallback" as const };
            })()
          : await (async () => {
              const r = await fetchConfirmedPlanets(query);
              return { planets: r.planets, source: r.source };
            })();
        await putJson(store, `run/${runId}/catalog.json`, catalog);

        await stub.emitEvent(
          "data-fetch",
          catalog.source === "nasa-tap" ? "result" : "warn",
          `Catalog ready: ${catalog.planets.length} confirmed planets (source=${catalog.source}).`,
          { source: catalog.source, count: catalog.planets.length },
        );

        // pick targets with enough real parameters to build a physical light curve
        const planets = catalog.planets
          .filter((p) => p.pl_orbper != null && p.st_rad != null && (p.pl_rade ?? 0) > 0)
          .slice(0, params.targets);

        // Build deterministic identities; register tasks and honour resume-skip.
        const targets: TargetSel[] = [];
        for (let i = 0; i < planets.length; i++) {
          const planet = planets[i];
          const meta = metaFor(planet, i);
          const prevStatus = await stub.taskStatus(meta.taskId);
          const skip = params.resume && (prevStatus === "done" || prevStatus === "failed");
          targets.push({ planet, meta, skipped: skip });
          if (skip) continue;
          await stub.addTask({
            id: meta.taskId,
            kind: "transit-search",
            targetId: planet.hostname ?? meta.name,
            params: { planet: meta.name, periodDays: planet.pl_orbper, tmag: planet.sy_tmag },
            status: "queued",
            createdAt: new Date().toISOString(),
          });
        }
        await stub.setSeatStatus("data-fetch", "idle", `${planets.length} planets loaded`);
        await stub.emitEvent("data-fetch", "info", `Selected ${targets.length} targets for transit analysis.`);
        return { targets, catalogSource: catalog.source };
      },
    );
    if (!selectR.ok) {
      await stub.finishRun({ error: selectR.error });
      await stub.emitEvent("reporter", "error", `Run ${runId} failed during target selection: ${selectR.error}`);
      return { targets: 0, accepted: 0, review: 0, rejected: 0, bundles: 0, catalogSource: "unavailable" };
    }
    const { targets, catalogSource } = selectR.value;

    // ---- pipeline over targets: one durable step per seat --------------------
    for (const t of targets) {
      const { meta, planet } = t;
      const i = meta.index;
      if (t.skipped) continue;
      const key = `${ctxBase}/${i}`;

      // SEAT 1 (per target): build the light curve + data hash (persisted to R2)
      const fetchR = await runSafe(step, `fetch-${i}`, async (): Promise<{ points: number; dataHash: string }> => {
        await stub.setSeatStatus("data-fetch", "running", `Observing ${meta.name}`);
        await stub.updateTask(meta.taskId, { status: "fetching" });
        await stub.emitEvent(
          "data-fetch",
          "info",
          `Building an observable light curve for ${meta.name} (P=${planet.pl_orbper?.toFixed(3)}d, Rp=${planet.pl_rade?.toFixed(2)} R_Earth, R*=${planet.st_rad?.toFixed(2)} R_Sun).`,
        );
        const useS3 = env.MAST_S3 === "1" && Number.isFinite(planet.tic);
        const sectors =
          useS3 && Number.isFinite(planet.ra) && Number.isFinite(planet.dec)
            ? await sectorsForCoord(planet.ra!, planet.dec!)
            : [];
        const spoc = sectors.length > 0 ? await fetchSpocLightCurve(planet.tic!, sectors, meta.name) : null;
        let lc: LightCurve;
        let truthPeriodDays: number;
        if (spoc) {
          // Token-free REAL photometry from the public TESS-SPOC S3 bucket.
          lc = spoc;
          lc.source = `${lc.source}; catalog source=${catalogSource}`;
          truthPeriodDays = planet.pl_orbper!;
          await stub.emitEvent(
            "data-fetch",
            "result",
            `Fetched REAL TESS-SPOC photometry for ${meta.name} from the public S3 bucket (token-free).`,
          );
        } else {
          // Default deterministic path: byte-identical to the historical stand-in.
          const built = generateSyntheticTransit({
            seed: 7000 + i,
            periodDays: planet.pl_orbper!,
            planetRadiusEarth: planet.pl_rade!,
            stellarRadiusRsun: planet.st_rad!,
            stellarMassMsun: planet.st_mass ?? mainSequenceMassFromRadius(planet.st_rad!), // catalog mass; empirical M-R only as fallback
            impactParam: 0.2 + (i % 3) * 0.15,
            noisePpm: 180,
            cadenceSec: 120,
            baselineDays: 27,
            targetIdLabel: planet.hostname ?? meta.name,
          });
          lc = built.lc;
          truthPeriodDays = built.truth.periodDays;
          lc.source = `synthetic stand-in for MAST TESS 2-min (seed=${7000 + i}); catalog source=${catalogSource}`;
        }
        const dataHash = await computeDataHash(lc);
        lc.dataHash = dataHash;
        const rec: FetchRecord = { lc, meta, dataHash, truthPeriodDays, spocSectors: spoc ? sectors : undefined };
        await putJson(store, `${key}/fetch.json`, rec);
        await stub.markSeatProcessed("data-fetch");
        await stub.emitEvent(
          "data-fetch",
          "result",
          `${lc.points.length} photometry points ready for ${meta.name} (data hash ${dataHash.slice(0, 12)}...).`,
          { points: lc.points.length, dataHash },
        );
        return { points: lc.points.length, dataHash };
      });
      if (!fetchR.ok) {
        await this.markFailed(step, env, meta.taskId, meta.name, fetchR.error);
        continue;
      }

      // SEAT 2: anomaly-scout (BLS + alias), persist the DetectionResult to R2
      const scoutR = await runSafe(step, `scout-${i}`, async (): Promise<{ periodDays: number; snr: number; aliasMultiple: number }> => {
        const rec = await getJson<FetchRecord>(store, `${key}/fetch.json`);
        if (!rec) throw new Error("missing light curve");
        await stub.setSeatStatus("anomaly-scout", "running", `BLS search on ${rec.lc.targetId}`);
        await stub.updateTask(meta.taskId, { status: "analyzing" });
        await stub.emitEvent("anomaly-scout", "info", `Running Box-Least-Squares transit search on ${rec.lc.targetId} ...`);
        const det = scout(rec.lc);
        await putJson(store, `${key}/detect.json`, { detection: det } satisfies DetectRecord);
        const c = det.candidate;
        await stub.markSeatProcessed("anomaly-scout");
        await stub.emitEvent(
          "anomaly-scout",
          "result",
          `Candidate on ${rec.lc.targetId}: P=${c.periodDays.toFixed(4)}d, depth=${(c.depthFrac * 1e6).toFixed(0)}ppm, SNR=${c.snr.toFixed(1)}, odd-even alias x${det.aliasMultiple}.`,
          { periodDays: c.periodDays, depthFrac: c.depthFrac, snr: c.snr, aliasMultiple: det.aliasMultiple },
        );
        return { periodDays: c.periodDays, snr: c.snr, aliasMultiple: det.aliasMultiple };
      });
      if (!scoutR.ok) {
        await this.markFailed(step, env, meta.taskId, meta.name, scoutR.error);
        continue;
      }

      // SEAT 3: sim-runner -- ONE step looping N recovery trials (deterministic)
      const simR = await runSafe(step, `sim-${i}`, async (): Promise<{ confidence: ConfidenceResult; ephemeris: EphemerisRecord; noisePpm: number }> => {
        const rec = await getJson<FetchRecord>(store, `${key}/fetch.json`);
        const dr = await getJson<DetectRecord>(store, `${key}/detect.json`);
        if (!rec || !dr) throw new Error("missing detection");
        await stub.setSeatStatus("sim-runner", "running", `Injection-recovery replay for ${rec.lc.targetId}`);
        await stub.updateTask(meta.taskId, { status: "simulating" });
        await stub.emitEvent(
          "sim-runner",
          "info",
          `Replaying the ${rec.lc.targetId} signal through ${params.confidenceTrials} fresh noise realizations to measure how reliable it is ...`,
        );
        const plan = simPlan({ lc: rec.lc, detection: dr.detection, planet, index: i, confidenceTrials: params.confidenceTrials });
        const nTrials = Math.max(1, plan.options.nTrials ?? params.confidenceTrials);
        const outcomes = Array.from({ length: nTrials }, (_, k) => recoveryTrial(plan.signal, plan.options, k));
        const confidence: ConfidenceResult = {
          ...combineTrials(outcomes, nTrials, plan.signal.noisePpm ?? 200),
          nextTransitsBjd: predictEphemeris(plan.epochBjd, plan.signal.periodDays, 3),
        };
        const ephemeris: EphemerisRecord = {
          t0Bjd: plan.epochBjd,
          periodDays: plan.signal.periodDays,
          nextTransitsBjd: confidence.nextTransitsBjd,
        };
        await stub.markSeatProcessed("sim-runner");
        await stub.emitEvent(
          "sim-runner",
          "result",
          `Recovery confidence ${(confidence.confidence * 100).toFixed(0)}% (${confidence.nRecovered}/${confidence.nTrials}); noise ~${plan.noisePpm.toFixed(0)}ppm; next transits predicted at BJD ${confidence.nextTransitsBjd.map((x) => x.toFixed(3)).join(", ") || "n/a"}.`,
          { confidence: confidence.confidence, noisePpm: plan.noisePpm, nextTransitsBjd: confidence.nextTransitsBjd },
        );
        return { confidence, ephemeris, noisePpm: plan.noisePpm };
      });
      if (!simR.ok) {
        await this.markFailed(step, env, meta.taskId, meta.name, simR.error);
        continue;
      }
      const confidence = simR.value.confidence;
      const ephemeris = simR.value.ephemeris;

      // SEAT 4: mission-critic -- verdict + checks, persisted to R2 for the reporter
      const criticR = await runSafe(step, `critic-${i}`, async (): Promise<ReviewResult> => {
        const dr = await getJson<DetectRecord>(store, `${key}/detect.json`);
        const fr = await getJson<FetchRecord>(store, `${key}/fetch.json`);
        const cat = await getJson<CatalogRecord>(store, `run/${runId}/catalog.json`);
        if (!dr || !fr) throw new Error("missing detection");
        await stub.setSeatStatus("mission-critic", "running", `Reviewing ${dr.detection.candidate.targetId}`);
        await stub.updateTask(meta.taskId, { status: "reviewing" });
        // False-positive vetting: only for REAL photometry, only when VET=1, best-effort.
        // It fetches the SPOC target-pixel cube and measures the in-transit photocenter
        // displacement against the CANDIDATE's own ephemeris. Disabled by default, so the
        // deterministic run path (and its bundle hash) is byte-for-byte unchanged.
        let vetting: ReviewVetting | undefined;
        const isReal = (fr.lc.source ?? "").includes("REAL photometry");
        if (env.VET === "1" && isReal) {
          const cand = dr.detection.candidate;
          vetting = {};
          // Per-candidate calibrated significance: measure THIS target's own noise color (rho) and
          // scatter, generate planet-free nulls matched to them, and report the empirical false-alarm
          // probability of the candidate's BLS SNR. Unlike a global SNR cut, this adapts to red-noise
          // hosts. Threshold (critic fapThreshold 0.05) is calibrated on real planets and sits above the
          // ensemble resolution floor 1/(nNull+1), so known SNR>=7 planets are never floored into rejection.
          try {
            const sig = calibratedFap(fr.lc, cand.snr, cand.periodDays);
            vetting.fap = sig.fap;
            await stub.emitEvent(
              "mission-critic",
              "info",
              `Calibrated significance for ${meta.name}: SNR ${cand.snr.toFixed(1)} at noise color rho=${sig.rho.toFixed(2)} -> empirical FAP ${sig.fap.toPrecision(2)} (${sig.exceedances}/${sig.nNull} matched nulls reached it).`,
            );
          } catch {
            /* best-effort: if significance can't be computed, leave FAP unset (no gating) */
          }
          // Light-curve discriminators are computed and LOGGED as instrumentation, but NOT
          // fed to the reject path. A per-event refit (oddEvenRefined) replaces the naive
          // fixed-window measure: calibration (scripts/p2-vet-calibrate) shows the fixed window
          // reports up to 200% asymmetry for CONFIRMED planets (catalog phase error accumulates
          // across a sector), whereas the refit correctly declines to judge ("n/d") on sparse
          // single-sector coverage. Even so the refit cannot gate yet: it reaches a confident
          // verdict on only ~2/14 real planets and one true planet (HR 858 b) still reads 69%,
          // so any 0.5-0.7 cut would drop a known planet. Only the centroid shift (calibrated
          // <=0.6" for real planets) is allowed to reject.
          const oer = oddEvenRefined(fr.lc, cand.epochBjd, cand.periodDays, cand.durationHours);
          const se = secondaryEclipse(fr.lc, cand.epochBjd, cand.periodDays, cand.durationHours);
          await stub.emitEvent(
            "mission-critic",
            "info",
            `Light-curve diagnostics for ${meta.name} (informational, not gating): odd/even depth asymmetry ${oer.determined ? (oer.diffFrac * 100).toFixed(0) + "%" : "n/d"} (per-event refit, ${oer.nEven}/${oer.nOdd} transits), secondary/primary ratio ${se.ratio.toFixed(2)}${se.determined ? "" : " (n/d)"}.`,
          );
          // Pixel centroid shift (needs a ~5MB target-pixel download; best-effort).
          if (Number.isFinite(planet.tic)) {
            const sectors = fr.spocSectors ?? [];
            for (const s of sectors.slice(0, 3)) {
              try {
                const cube = await fetchSpocTargetPixels(planet.tic!, s, fr.lc.targetId);
                if (!cube) continue;
                const cs = centroidShift(cube, cand.epochBjd, cand.periodDays, cand.durationHours);
                if (cs.inCount >= 2 && cs.outCount >= 2) {
                  vetting.centroidShiftArcsec = cs.shiftArcsec;
                  await stub.emitEvent(
                    "mission-critic",
                    "info",
                    `Pixel vetting for ${meta.name}: in-transit photocenter shift ${cs.shiftArcsec.toFixed(2)} arcsec (${cs.inCount} in / ${cs.outCount} out cadences).`,
                  );
                }
                break; // first usable cube decides; sector search stops here
              } catch {
                /* best-effort: a failed tp fetch simply leaves the centroid unset */
              }
            }
          }
        }
        const review = critique({
          detection: dr.detection,
          catalog: cat?.planets ?? [],
          hostName: meta.hostName,
          confidence,
          truthPeriodDays: fr.truthPeriodDays,
          truthSource: (fr.lc.source ?? "").includes("REAL photometry") ? "catalog" : "injected",
          vetting,
        });
        await putJson(store, `${key}/review.json`, { review } satisfies ReviewRecord);
        await stub.markSeatProcessed("mission-critic");
        await stub.emitEvent(
          "mission-critic",
          review.verdict === "accepted" ? "result" : review.verdict === "needs-more-data" ? "warn" : "info",
          `Verdict for ${dr.detection.candidate.targetId}: ${review.verdict.toUpperCase()} (score ${review.score}/100) -- ${review.reason}`,
          { verdict: review.verdict, score: review.score, crossmatch: review.crossmatch },
        );
        return review;
      });
      if (!criticR.ok) {
        await this.markFailed(step, env, meta.taskId, meta.name, criticR.error);
        continue;
      }

      // SEAT 5: reporter -- compose bundle, persist to R2, record finding + bundle
      const reportR = await runSafe(step, `report-${i}`, async (): Promise<Finding["verdict"]> => {
        const rec = await getJson<FetchRecord>(store, `${key}/fetch.json`);
        const dr = await getJson<DetectRecord>(store, `${key}/detect.json`);
        const rr = await getJson<ReviewRecord>(store, `${key}/review.json`);
        if (!rec || !dr || !rr) throw new Error("missing pipeline output");
        await stub.setSeatStatus("reporter", "running", `Packaging ${rec.meta.findingId}`);
        const codeVersion = env.CODE_VERSION ?? "unknown";
        const out = await report({
          lc: rec.lc,
          detection: dr.detection,
          confidence,
          review: rr.review,
          ephemeris,
          findingId: rec.meta.findingId,
          runId,
          codeVersion,
          catalogSource,
          dataHash: rec.dataHash,
          lightCurveSource: rec.lc.source,
        });
        // persist the reproducible bundle to R2 (identical key layout to the Node fs store)
        await persistBundle(store, out.composed, out.artifacts);
        const bundle: BundleRecord = {
          findingId: rec.meta.findingId,
          hash: out.composed.hash,
          files: [...out.artifacts.map((a) => a.name), "manifest.json", "HASH.txt"],
          createdAt: out.finding.createdAt,
        };
        await stub.recordFinding(out.finding);
        await stub.recordBundle(bundle);
        await stub.updateTask(rec.meta.taskId, { status: "done", findingId: rec.meta.findingId });
        await stub.markSeatProcessed("reporter");
        await stub.emitEvent(
          "reporter",
          "result",
          `${out.finding.narration!.headline} [bundle ${out.composed.hash.slice(0, 12)}...]`,
          { findingId: rec.meta.findingId, bundleHash: out.composed.hash, verdict: out.finding.verdict },
        );
        return out.finding.verdict;
      });
      if (!reportR.ok) {
        await this.markFailed(step, env, meta.taskId, meta.name, reportR.error);
        continue;
      }

      // Autonomous runs may seal an ACCEPTED finding on-chain, but only through
      // the DO's budget gate: AUTO_ANCHOR defaults to "off" (no-op) and even
      // "live" spends nothing until AUTO_ANCHOR_DAILY_CAP > 0. Manual dashboard
      // runs never reach this branch (params.autonomous is false), so anchoring
      // stays exactly as manual as before for a launched run.
      if (params.autonomous && reportR.value === "accepted") {
        await runSafe(step, `anchor-${i}`, async (): Promise<string> => {
          const res = await stub.autoAnchorBudgeted(meta.findingId);
          await stub.emitEvent(
            "reporter",
            res.performed && res.spentSol ? "result" : "info",
            `Auto-anchor ${meta.findingId}: mode=${res.mode} spent=${res.spentSol} -- ${res.reason}`,
          );
          return `${res.mode}:${res.performed}:${res.spentSol}`;
        });
      }

      // checkpoint the DO state to the R2 snapshot after every completed target
      await runSafe(step, `snapshot-${i}`, async (): Promise<string> => {
        const res = await stub.saveSnapshot();
        return res.key;
      });

      // let the live feed breathe between targets (durable sleep, no CPU burn)
      if (params.stageDelayMs > 0) await step.sleep(`stage-${i}`, params.stageDelayMs);
    }

    // ---- tail: release the run slot with a summary derived from DO state ------
    const summary = await step.do("finish", async (): Promise<ActiveRunSummary> => {
      const st: DashboardState = await stub.getState();
      const accepted = st.findings.filter((f) => f.verdict === "accepted").length;
      const review = st.findings.filter((f) => f.verdict === "needs-more-data").length;
      const rejected = st.findings.filter((f) => f.verdict === "rejected").length;
      const out: ActiveRunSummary = {
        targets: targets.length,
        accepted,
        review,
        rejected,
        bundles: st.bundles.length,
        catalogSource,
      };
      await stub.finishRun({ summary: out });
      await stub.emitEvent(
        "reporter",
        "result",
        `Run ${runId} finished: ${accepted} confirmed, ${review} watchlist, ${rejected} rejected, ${st.bundles.length} bundles.`,
        { runId, ...out },
      );
      return out;
    });
    return summary;
  }

  /**
   * Durable, run-once handler for a failed target: emits the error event and marks the
   * task failed (mirrors the Orchestrator's per-target catch), as its own step so the
   * side effects are not repeated when the run body replays.
   */
  private async markFailed(step: WorkflowStep, env: Env, taskId: string, name: string, message: string): Promise<void> {
    await step.do(`task-failed-${taskId}`, async () => {
      const stub = rigStub(env);
      await stub.updateTask(taskId, { status: "failed" });
      await stub.setSeatStatus("reporter", "idle", `Task ${name} failed`);
      await stub.emitEvent("reporter", "error", `Task ${name} failed: ${message}`);
    });
  }
}
