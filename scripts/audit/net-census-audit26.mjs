// round-26 audit of the census's own classifier: `unattested-blockers26.mjs` flags a generator "network-needed" with a
// regex that fires if the source merely MENTIONS fetch/http/a fetcher module. That over-claims: a generator can import a
// data module or carry a URL in a comment yet run entirely off committed fixtures. This measures, per C-row generator,
// whether it makes an ACTUAL network call (fetch(...) or a top-level await on a live fetcher) or only mentions one, so
// the ledger can say "needs a networked runner" from evidence rather than from a substring. Read-only: touches nothing.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const ids = [
  "p33-scale-roc","p35-pdm-crosscheck","p39-instrumental-fp","p40-fp-safety","p42-fp-scale","p43-window-alias",
  "p44-diff-imaging","p45-fp-probability","p46-coherence","p47-completeness-grid","p49-blind-test","p50-replay",
  "p51-crowding-stratified","p52-negative-class","p53-psf-diff-imaging","p56-real-selection","p57-true-veto",
  "p58-veto-2x2","p60-joint-vs-single","p61-llm-hypothesis","p62-phase-aligned-joint","p64-fetch-telemetry",
  "p65-external-audit","p67-seed-precision","p69-rednoise-significance","p70-llm-ablation",
  "p71-audit-positive-control","p73-masked-recovery","p74-centroid-consistency","p77-centroid-ctest",
  "p78-blind-multisector","p80-external-validation",
];
const gen = (id) => {
  const b = `scripts/${id}.ts`;
  if (existsSync(b)) return b;
  const p = id.split("-")[0] + "-";
  const h = readdirSync("scripts").filter((f) => f.endsWith(".ts") && f.startsWith(p));
  return h.length ? `scripts/${h[0]}` : null;
};
// A generator really needs the network if it calls fetch(...) OR awaits an imported fetcher function whose module hits a
// socket. Detect the call site, not the mention: `fetch(`, `.json()` on a fetch, or `await fetchFrom...`/live client use.
const CALL = [/\bawait\s+fetch\b/, /\bfetch\(\s*[`'\"http]/, /\bfetchConfirmedPlanets\(/, /\bfetchToiTable\(/,
  /\bfetchSpocLightCurve\(/, /\bfetchTocCandidates\(/, /\bdownloadFile\(/, /\baxios\./, /\bnode:https?\b/];
let real = 0, mentionOnly = 0;
const rows = [];
for (const id of ids) {
  const g = gen(id);
  if (!g) { rows.push([id, "NO-GENERATOR"]); continue; }
  const src = readFileSync(g, "utf8");
  const fired = CALL.filter((re) => re.test(src)).length;
  const kind = fired > 0 ? "REAL-CALL" : "MENTION-ONLY";
  if (fired > 0) real++; else mentionOnly++;
  rows.push([id, kind]);
}
for (const [id, k] of rows) console.log(id.padEnd(28), k);
console.log(`--- realCall=${real} mentionOnly=${mentionOnly} total=${rows.length}`);
console.log("If mentionOnly>0, the census's network-needed=true is overstated for those ids: they are candidates for an");
console.log("offline buildStamp + re-run NOW, shrinking unattested without waiting on a networked runner.");
