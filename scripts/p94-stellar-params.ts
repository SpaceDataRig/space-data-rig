// P94 - EXPORT REAL STELLAR PARAMETERS FOR THE LEO-VETTER BENCHMARK ARM.
//
// WHY (authority roadmap, priority 1). The cross-pipeline harness proves IMPLEMENTATION-level independence with an
// all-Python detector stack, but the roadmap's hardest gap (RESEARCH 4c) is that the rig's VETTING has never been
// scored against the field's ACTUAL reference system, only against our own re-implementations. The field's 2025
// reference flux/pixel vetter is LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280), which is pip-installable and whose
// flux metrics need a real stellar dictionary {Teff, radius, mass, density, logg} plus limb darkening it computes
// itself from Claret (2017) tables. The committed light-curve fixtures carry no stellar parameters, so this script
// sources them -- from the SAME NASA Exoplanet Archive TAP the pipeline already trusts -- and commits a small,
// provenanced JSON the CI Python harness reads offline. This is real catalog data, not stand-ins: the values are
// queried, and the query + the per-host selection rule are recorded so a re-run reproduces the same bytes.
//
// DETERMINISTIC SELECTION (pscomppars has one stellar-param row PER CONFIRMED PLANET, and multi-planet hosts
// therefore appear several times with slightly different published values -- the exact churn that bit p60). We pin
// it with a pure function of content: order each host's rows by (period ascending, planet name ascending) and take
// the INNERMOST confirmed planet's reported parameters. Errors are symmetric-magnitude (the larger of the two
// published one-sigma tails), and the stellar density is derived as rho = mass / radius^3 * rho_sun from the SAME
// catalog mass and radius (rho_sun = 1.408 g/cm^3), consistent to within rounding with the logg the catalog prints.
//
// Research tooling only: no worker import, no verdict, no bundle hash, no money path. Run (needs network):
//   npm run p94:stellar-params
// The output file is committed; the CI benchmark does NOT re-query (it reads the committed JSON), so CI stays
// network-free and byte-stable.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "tests", "fixtures", "spoc-curves");
const OUT = join(FIXTURE_DIR, "stellar-params.json");

const TAP_SYNC = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const RHO_SUN = 1.408; // g/cm^3

interface StarRow {
  hostname: string;
  tic_id?: string;
  pl_name?: string;
  pl_orbper?: number;
  st_teff?: number;
  st_tefferr1?: number;
  st_tefferr2?: number;
  st_rad?: number;
  st_raderr1?: number;
  st_raderr2?: number;
  st_mass?: number;
  st_masserr1?: number;
  st_masserr2?: number;
  st_logg?: number;
}

async function queryArchive(hostnames: string[]): Promise<StarRow[]> {
  const inList = hostnames.map((h) => `'${h.replace(/'/g, "")}'`).join(",");
  const cols =
    "hostname, tic_id, pl_name, pl_orbper, st_teff, st_tefferr1, st_tefferr2, st_rad, st_raderr1, st_raderr2, " +
    "st_mass, st_masserr1, st_masserr2, st_logg";
  const query = `select distinct ${cols} from pscomppars where hostname in (${inList})`;
  const url = `${TAP_SYNC}?query=${encodeURIComponent(query)}&format=json`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error(`TAP HTTP ${r.status}`);
      const rows = (await r.json()) as StarRow[];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty result");
      return rows;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`archive TAP failed after retries: ${lastErr}`);
}

/** Larger magnitude of the two published one-sigma tails, as a single positive uncertainty. */
function symErr(e1?: number, e2?: number): number | null {
  const a = Math.abs(e1 ?? NaN);
  const b = Math.abs(e2 ?? NaN);
  const vals = [a, b].filter((v) => Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

interface StarRecord {
  hostname: string;
  tic: number | null;
  fromPlanet: string | null;
  fromPeriodDays: number | null;
  Teff: number;
  e_Teff: number | null;
  rad: number;
  e_rad: number | null;
  mass: number;
  e_mass: number | null;
  logg: number | null;
  rho: number;
}

function pickPerHost(rows: StarRow[]): Map<string, StarRecord> {
  // Deterministic: innermost confirmed planet's row, tie-broken on planet name (plain code-unit, not locale).
  const byCode = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const best = new Map<string, StarRow>();
  for (const r of rows) {
    if (!finite(r.st_teff) || !finite(r.st_rad) || !finite(r.st_mass)) continue;
    if (r.st_rad <= 0 || r.st_mass <= 0) continue;
    const cur = best.get(r.hostname);
    const rp = finite(r.pl_orbper) ? r.pl_orbper : Infinity;
    const cp = cur && finite(cur.pl_orbper) ? cur.pl_orbper : Infinity;
    if (!cur || rp < cp || (rp === cp && byCode(String(r.pl_name ?? ""), String(cur.pl_name ?? "")) < 0)) {
      best.set(r.hostname, r);
    }
  }
  const out = new Map<string, StarRecord>();
  for (const [host, r] of best) {
    const rad = r.st_rad as number;
    const mass = r.st_mass as number;
    out.set(host, {
      hostname: host,
      tic: Number.parseInt(String(r.tic_id ?? "").replace(/\D+/g, ""), 10) || null,
      fromPlanet: r.pl_name ?? null,
      fromPeriodDays: finite(r.pl_orbper) ? r.pl_orbper : null,
      Teff: r.st_teff as number,
      e_Teff: symErr(r.st_tefferr1, r.st_tefferr2),
      rad,
      e_rad: symErr(r.st_raderr1, r.st_raderr2),
      mass,
      e_mass: symErr(r.st_masserr1, r.st_masserr2),
      logg: finite(r.st_logg) ? r.st_logg : null,
      rho: (mass / rad ** 3) * RHO_SUN,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as {
    curves: { host: string; tic: number }[];
  };
  const hosts = manifest.curves.map((c) => c.host);
  console.log(`p94: sourcing stellar parameters for ${hosts.length} committed fixture hosts from the NASA Exoplanet Archive`);
  const rows = await queryArchive(hosts);
  const picked = pickPerHost(rows);

  const stars: Record<string, StarRecord> = {};
  const missing: string[] = [];
  for (const c of manifest.curves) {
    const rec = picked.get(c.host);
    if (!rec) {
      missing.push(c.host);
      continue;
    }
    if (rec.tic != null && rec.tic !== c.tic) {
      console.log(`  note: ${c.host} archive tic ${rec.tic} != manifest tic ${c.tic}; trusting manifest TIC`);
    }
    stars[c.host] = { ...rec, tic: c.tic };
    console.log(
      `  ${c.host.padEnd(12)} Teff=${rec.Teff} R*=${rec.rad} M*=${rec.mass} logg=${rec.logg} rho=${rec.rho.toFixed(3)} (from ${rec.fromPlanet})`,
    );
  }
  if (missing.length) throw new Error(`no stellar params found for: ${missing.join(", ")}`);

  const payload = {
    meta: {
      generatedBy: "scripts/p94-stellar-params.ts (network; committed so CI reads it offline)",
      source: "NASA Exoplanet Archive pscomppars TAP (https://exoplanetarchive.ipac.caltech.edu/TAP/sync)",
      selectionRule:
        "one row per host = innermost confirmed planet's published parameters (period asc, then planet name asc); " +
        "errors are the larger one-sigma tail; rho = mass/radius^3 * 1.408 g/cm^3 (solar density)",
      limbDarkening: "u1/u2 are NOT stored here -- the CI harness computes quadratic TESS-band LDC from Claret (2021) " +
        "via leo_vetter.stellar.quadratic_ldc(Teff, logg) at run time",
      units: { Teff: "K", rad: "R_sun", mass: "M_sun", rho: "g/cm^3", logg: "dex" },
      citation: "Kunimoto et al. 2025, AJ 170, 280 (LEO-Vetter); NASA Exoplanet Archive (Borucki et al. 2018)",
    },
    stars,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`p94: wrote ${OUT} (${Object.keys(stars).length} hosts, all fields real catalog values)`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
