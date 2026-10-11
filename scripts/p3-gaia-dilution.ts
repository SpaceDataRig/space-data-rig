// P3 checkpoint: measure Gaia DR3 DILUTION / blend contamination for real confirmed planets.
//
// This quantifies, for known-good transiting planets, how much extra light sits inside the TESS
// aperture next to the host. It calibrates the dilution diagnostic (src/data/gaiaDilution.ts) on
// REAL data -- the same discipline we apply before trusting any discriminator. Dilution is a
// CORRECTION/diagnostic and (unlike an off-target centroid) is NOT a rejection criterion: a genuine
// planet can sit in front of a diluted star. So nothing here changes a verdict; we report the
// distribution and the corrected depths so blends/crowding are visible and honest.
//
// Chain: confirmed planet (TIC, ra/dec) --(Gaia cone)--> neighbours -> nearest source = host proxy
// -> dilution factor from the rest. All anonymous; no tokens; no anchoring.
//
// Usage:
//   npm run p3:gaia                          (sample of bright TIC planets)
//   npm run p3:gaia -- --targets 12 --tmag 10 --aperture 30
import { fetchConfirmedPlanets } from "../src/data/exoplanetArchive.ts";
import { fetchGaiaNeighborhood, dilutionFromNeighbors, angularSepArcsec } from "../src/data/gaiaDilution.ts";
import type { ArchivePlanet } from "../src/core/types.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

const want = Math.round(arg("targets", 8));
const tmag = arg("tmag", 10);
const apertureArcsec = arg("aperture", 30); // ~ TESS sub-pixel blend scale
const radiusDeg = apertureArcsec / 3600;

function hasCoord(p: ArchivePlanet): boolean {
  return Number.isFinite(p.tic) && Number.isFinite(p.ra) && Number.isFinite(p.dec);
}

async function main() {
  console.log(`P3 Gaia dilution calibration (confirmed planets, tmag<${tmag}, aperture ${apertureArcsec}")`);
  const cat = await fetchConfirmedPlanets({ maxTmag: tmag, requireTic: true });
  if (cat.source !== "nasa-tap") console.log(`WARNING: catalog source=${cat.source} -- calibration needs real rows.`);

  // One measurement PER HOST STAR: a multi-planet system shares a light curve and a sky position,
  // so dedupe by TIC (else the same neighborhood is counted several times and biases the spread).
  const seen = new Set<number>();
  const hosts: ArchivePlanet[] = [];
  for (const p of cat.planets) {
    if (!hasCoord(p) || seen.has(p.tic!)) continue;
    seen.add(p.tic!);
    hosts.push(p);
    if (hosts.length >= want) break;
  }
  console.log(`queued ${hosts.length} distinct TIC host stars`);
  console.log("");

  const results: { name: string; dilution: number; contaminationPct: number; n: number; contrast: number }[] = [];
  for (const p of hosts) {
    const name = p.hostname ?? p.pl_name ?? `TIC ${p.tic}`;
    try {
      const sources = await fetchGaiaNeighborhood(p.ra!, p.dec!, { radiusDeg });
      if (sources.length === 0) {
        console.log(`${name.padEnd(18)} TIC ${p.tic}: no Gaia sources returned -- skip`);
        continue;
      }
      // Nearest Gaia source to the catalogued position is the host proxy.
      let host = sources[0];
      let bestSep = Infinity;
      for (const g of sources) {
        const sep = angularSepArcsec(p.ra!, p.dec!, g.ra, g.dec);
        if (sep < bestSep) { bestSep = sep; host = g; }
      }
      const r = dilutionFromNeighbors(host.gmag, host.ra, host.dec, sources, apertureArcsec, host.sourceId);
      results.push({ name, dilution: r.dilutionFactor, contaminationPct: r.contaminationPct, n: r.nInAperture, contrast: r.brightestContrastMag });
      console.log(
        `${name.padEnd(18)} TIC ${p.tic}: G=${host.gmag.toFixed(2)} dilution ${r.dilutionFactor.toFixed(3)} ` +
        `(${r.contaminationPct.toFixed(1)}% extra light, ${r.nInAperture} neighbours${r.nInAperture ? `, brightest +${r.brightestContrastMag.toFixed(1)}mag @${r.brightestSepArcsec.toFixed(1)}"` : ""})`,
      );
    } catch (e) {
      console.log(`${name.padEnd(18)} TIC ${p.tic}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("");
  if (results.length === 0) {
    console.log("no measurable dilution (network/Gaia unavailable) -- cannot report in this environment.");
    return;
  }
  const ds = results.map((x) => x.dilution).sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
  const blended = results.filter((x) => x.contaminationPct > 5).length;
  console.log(`measured ${ds.length} host stars: dilution factor min=${ds[0].toFixed(3)} p50=${q(ds, 0.5).toFixed(3)} max=${ds[ds.length - 1].toFixed(3)}`);
  console.log(`  ${blended}/${ds.length} have >5% contaminating light in the ${apertureArcsec}" aperture (these depths are UNDER-estimated by that much or more).`);
  console.log("  dilution is a CORRECTION/diagnostic (true depth = observed / dilution factor); it does NOT reject a candidate.");
}

main().catch((e) => {
  console.error("gaia dilution calibration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
