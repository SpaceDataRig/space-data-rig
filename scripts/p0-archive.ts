// P0 data-layer test: fetch REAL confirmed planets from NASA Exoplanet Archive.
// Run: npm run p0:archive
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";

const res = await fetchConfirmedPlanets({ maxTmag: 10.5, limit: 15, minPeriodDays: 0.8, maxPeriodDays: 14 });
console.log(`\nSource: ${res.source}${res.error ? `  (TAP error: ${res.error})` : ""}`);
console.log(`Fetched ${res.planets.length} confirmed transiting planets\n`);
console.log(`${"planet".padEnd(18)}${"P(d)".padStart(9)}${"depth(ppm)".padStart(12)}${"dur(h)".padStart(8)}${"R(E)".padStart(7)}${"Tmag".padStart(7)}`);
for (const p of res.planets.slice(0, 15)) {
  console.log(
    `${(p.pl_name ?? "?").padEnd(18)}${(p.pl_orbper ?? NaN).toFixed(4).padStart(9)}` +
      `${String(p.pl_trandep ?? "-").padStart(12)}${(p.pl_trandur ?? NaN).toFixed(2).padStart(8)}` +
      `${(p.pl_rade ?? NaN).toFixed(2).padStart(7)}${(p.sy_tmag ?? NaN).toFixed(2).padStart(7)}`,
  );
}
console.log(res.source === "nasa-tap" ? "\n✅ Live NASA Exoplanet Archive reachable." : "\n⚠️  Using offline fallback catalog.");
