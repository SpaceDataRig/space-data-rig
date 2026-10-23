// audit-16: capture the SERVED catalog + ledger as committed fixtures, so the accounting assertions
// (103 rows / 91 signals / 90 host stars / 12 duplicate rows; 18 accepted -> 15; ledger 20 -> 17; label-vs-crossmatch
// conflicts) run against REAL production bytes in CI, offline and deterministic -- the same lesson as
// scripts/capture-live-fixtures.ts: a predicate tested only on hand-built ids is a gate over part of the set, which is
// exactly how the round-14 tic fix shipped its cadence hole (tests/fixtures fixture only ever exercised the host
// direction). Re-run with: npm run fixtures:capture.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.LIVE_BASE ?? "https://spacedatarig.app";
const getJson = async <T>(path: string, tries = 4): Promise<T> => {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}_cb=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return (await r.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 2500 * (i + 1)));
    }
  }
  throw lastErr;
};

interface FindingsPage { findings: unknown[]; total: number }
const page = await getJson<FindingsPage>("/api/findings?limit=500");
const ledger = await getJson<{ ledger: unknown[] }>("/api/ledger");
writeFileSync(resolve("tests/fixtures/live-catalog.json"), JSON.stringify({ capturedFrom: BASE, capturedAt: new Date().toISOString(), total: page.total, findings: page.findings }, null, 2) + "\n");
writeFileSync(resolve("tests/fixtures/live-ledger.json"), JSON.stringify({ capturedFrom: BASE, capturedAt: new Date().toISOString(), ledger: ledger.ledger }, null, 2) + "\n");
console.log(`captured ${page.findings.length} findings (total ${page.total}) + ${ledger.ledger.length} ledger rows -> tests/fixtures/live-catalog.json / live-ledger.json`);
