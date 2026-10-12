// Generate / inspect the offline closed-loop regression baseline (see src/orchestrator/regressionBaseline.ts).
//
//   npm run p18:baseline            print the current science digest
//   npm run p18:baseline -- --update  (re)write tests/fixtures/baseline-offline.json
//
// Regenerating the golden is the deliberate act of accepting a behaviour change; do it only after
// reviewing WHY a verdict or period moved. Fully offline -- no network, deterministic.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOfflineBaseline, serializeBaseline } from "../src/orchestrator/regressionBaseline.ts";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(here, "..", "tests", "fixtures", "baseline-offline.json");
  const rows = await runOfflineBaseline({ maxTargets: 3, confidenceTrials: 6 });
  const body = serializeBaseline(rows);
  if (process.argv.includes("--update")) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, body, "utf8");
    console.log(`[p18] wrote baseline fixture: ${fixturePath} (${rows.length} rows)`);
  }
  console.log(body);
}

main().catch((e) => {
  console.error(`[p18] failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
