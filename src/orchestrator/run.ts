// CLI entry: run the 5-seat pipeline over real NASA targets and stream the
// seat events to the console as they happen.
//
//   npm run orchestrator
//   npm run orchestrator -- --targets 6 --delay 250
//   npm run orchestrator -- --resume          # continue from the last snapshot
//   npm run orchestrator -- --offline         # use the bundled fallback catalog
//
// The same Orchestrator class is imported by the API server (P2); this file is
// only the terminal driver + live event printer.

import { RigStore } from "../core/store.ts";
import { Orchestrator } from "./pipeline.ts";
import { seatRole, verdictBadge } from "../reporter/narrate.ts";
import { getFallbackCatalog, type ArchiveFetchResult } from "../data/exoplanetArchive.ts";
import type { RigEvent, SeatName } from "../core/types.ts";

interface Args {
  targets: number;
  delay: number;
  resume: boolean;
  offline: boolean;
  confidenceTrials: number;
  maxTmag: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { targets: 4, delay: 0, resume: false, offline: false, confidenceTrials: 8, maxTmag: 11 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--targets": a.targets = Math.max(1, parseInt(next(), 10) || a.targets); break;
      case "--delay": a.delay = Math.max(0, parseInt(next(), 10) || 0); break;
      case "--confidence": a.confidenceTrials = Math.max(1, parseInt(next(), 10) || a.confidenceTrials); break;
      case "--tmag": a.maxTmag = parseFloat(next()) || a.maxTmag; break;
      case "--resume": a.resume = true; break;
      case "--offline": a.offline = true; break;
      case "-h":
      case "--help":
        console.log("Usage: npm run orchestrator -- [--targets N] [--delay MS] [--confidence N] [--tmag X] [--resume] [--offline]");
        process.exit(0);
    }
  }
  return a;
}

const SEAT_TAG: Record<SeatName, string> = {
  "data-fetch": "FETCH ",
  "anomaly-scout": "SCOUT ",
  "sim-runner": "SIM   ",
  "mission-critic": "CRITIC",
  reporter: "REPORT",
};

function printEvent(ev: RigEvent): void {
  const mark = ev.level === "error" ? "!" : ev.level === "warn" ? "~" : ev.level === "result" ? "+" : " ";
  console.log(` [${mark}] ${SEAT_TAG[ev.seat]} ${ev.message}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new RigStore();

  console.log("\n=== Space Data Rig :: P1 Orchestrator (5-seat pipeline) ===\n");
  console.log("Seats:");
  for (const s of ["data-fetch", "anomaly-scout", "sim-runner", "mission-critic", "reporter"] as SeatName[]) {
    console.log(`  - ${s.padEnd(15)} ${seatRole(s)}`);
  }
  console.log("");

  const unsub = store.subscribe(printEvent);

  // Offline mode: use the bundled real-value catalog, touching no network.
  let catalog: ArchiveFetchResult | undefined;
  if (args.offline) {
    catalog = getFallbackCatalog({
      maxTmag: args.maxTmag,
      limit: Math.max(40, args.targets * 6),
      minPeriodDays: 1,
      maxPeriodDays: 14,
    });
    console.log(" [i] offline mode: using the bundled fallback catalog\n");
  }

  const orch = new Orchestrator(store, {
    maxTargets: args.targets,
    stageDelayMs: args.delay,
    resume: args.resume,
    confidenceTrials: args.confidenceTrials,
    maxTmag: args.maxTmag,
    catalog,
  });

  const summary = await orch.run();
  unsub();

  console.log("\n=== Findings ===");
  for (const f of summary.findings) {
    const badge = verdictBadge(f.verdict);
    const head = f.narration?.headline ?? f.verdictReason;
    console.log(` [${badge.label.padEnd(9)}] ${f.id.padEnd(16)} score ${String(f.score ?? 0).padStart(3)}/100  ${head}`);
  }

  console.log(`\nRun ${summary.runId}: ${summary.accepted} confirmed, ${summary.review} watchlist, ${summary.rejected} rejected, ${summary.bundles} bundles.`);
  console.log(`Artifacts written under out/ (findings/, bundles/, state/rig.json).`);
  console.log(`Next: 'npm run api' to serve the live dashboard, or 'npm run anchor' to anchor bundles on Solana mainnet.\n`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
