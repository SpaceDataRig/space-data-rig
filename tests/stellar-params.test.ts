// Offline schema test for the committed stellar-params.json (scripts/p94-stellar-params.ts output). This file is the
// ONLY stellar data the CI LEO-Vetter benchmark reads, so it must be present, complete (one entry per fixture host),
// and physically sane BEFORE a CI job tries to import an external package against it. Everything here is pure file
// inspection -- no network, no Python -- so it runs in the main CI on every push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures", "spoc-curves");

interface StarRecord {
  hostname: string;
  tic: number | null;
  Teff: number;
  e_Teff: number | null;
  rad: number;
  e_rad: number | null;
  mass: number;
  e_mass: number | null;
  logg: number | null;
  rho: number;
}

const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
  curves: { host: string; tic: number }[];
};
const params = JSON.parse(readFileSync(join(DIR, "stellar-params.json"), "utf8")) as {
  meta: Record<string, string>;
  stars: Record<string, StarRecord>;
};

test("stellar-params carries a provenanced meta block", () => {
  assert.ok(params.meta.source.includes("Exoplanet Archive"), "source must be named");
  assert.ok(typeof params.meta.selectionRule === "string" && params.meta.selectionRule.length > 10);
  assert.ok(typeof params.meta.citation === "string" && params.meta.citation.includes("Kunimoto"));
});

test("every fixture host has a stellar record with a matching TIC", () => {
  const hosts = manifest.curves.map((c) => c.host);
  assert.ok(hosts.length >= 8, "the committed fixture sample should be non-trivial");
  for (const c of manifest.curves) {
    const rec = params.stars[c.host];
    assert.ok(rec, `missing stellar params for ${c.host}`);
    assert.equal(rec.tic, c.tic, `TIC mismatch for ${c.host}`);
  }
});

test("stellar values are finite, positive, and physically plausible", () => {
  for (const [host, r] of Object.entries(params.stars)) {
    assert.ok(Number.isFinite(r.Teff) && r.Teff > 2500 && r.Teff < 8000, `${host}: Teff=${r.Teff} out of dwarf/giant range`);
    assert.ok(Number.isFinite(r.rad) && r.rad > 0.05 && r.rad < 10, `${host}: radius=${r.rad} implausible`);
    assert.ok(Number.isFinite(r.mass) && r.mass > 0.05 && r.mass < 5, `${host}: mass=${r.mass} implausible`);
    // rho derived as mass/radius^3 * 1.408 must be consistent with the stored values to well within rounding.
    const expectRho = (r.mass / r.rad ** 3) * 1.408;
    assert.ok(Math.abs(r.rho - expectRho) < 1e-6 * Math.max(1, expectRho), `${host}: rho not self-consistent`);
    assert.ok(r.rho > 0.01 && r.rho < 20, `${host}: rho=${r.rho} out of range`);
    if (r.logg != null) assert.ok(r.logg > 1 && r.logg < 6, `${host}: logg=${r.logg} out of range`);
  }
});
