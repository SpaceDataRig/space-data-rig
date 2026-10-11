import assert from "node:assert/strict";
import { mapTocRows, getFallbackToc } from "../src/data/toiArchive.ts";

// Rows captured verbatim from a live probe of the Archive `toi` table (real schema, no guessing).
const REAL_ROWS = [
  { tid: 427508467, toidisplay: "TOI-1012.01", st_tmag: 8.12718, ra: 117.095285, dec: 6.785064, pl_orbper: 0.884182, pl_tranmid: 2459252.509595, pl_trandurh: 1.621, pl_trandep: 1890, pl_rade: 24.8132, st_rad: 2.72 },
  { tid: 114018671, toidisplay: "TOI-1011.01", st_tmag: 8.2388, ra: 113.984761, dec: -32.841999, pl_orbper: 2.4705036, pl_tranmid: 2460715.898893, pl_trandurh: 2.3513472, pl_trandep: 273.0272045, pl_rade: 1.44656, st_rad: 0.94 },
  // A row with no reference period/epoch cannot be blind-detection-targeted -> must be dropped.
  { tid: 999000, toidisplay: "TOI-9999.01", st_tmag: 9.0, ra: 10, dec: 10, pl_orbper: null, pl_tranmid: null },
];

// 1. Depth is taken AS-IS in ppm (the `toi` table already uses ppm -- must NOT be rescaled by 1e4).
{
  const c = mapTocRows(REAL_ROWS);
  const a = c.find((x) => x.toidisplay === "TOI-1012.01")!;
  assert.equal(a.depthPpm, 1890, "TOI depth must stay in ppm (not rescaled)");
  assert.equal(a.durationHours, 1.621, "duration is in HOURS");
  assert.equal(a.tic, 427508467, "tid maps to the host TIC");
  assert.ok(Number.isFinite(a.ra) && Number.isFinite(a.dec));
}

// 2. Rows missing a usable reference ephemeris are filtered out (blind mode needs a cross-match target).
{
  const c = mapTocRows(REAL_ROWS);
  assert.equal(c.length, 2, `two usable rows expected, got ${c.length}`);
  assert.ok(!c.some((x) => x.tic === 999000), "null-period row must be dropped");
}

// 3. Fallback (offline / CI) returns labeled, finite, unconfirmed candidates.
{
  const { candidates, source } = getFallbackToc({ limit: 5 });
  assert.equal(source, "fallback");
  assert.ok(candidates.length >= 1);
  for (const cnd of candidates) {
    assert.ok(Number.isFinite(cnd.periodDays) && Number.isFinite(cnd.ra) && Number.isFinite(cnd.tic));
  }
}

console.log("toiArchive.test.ts OK");
