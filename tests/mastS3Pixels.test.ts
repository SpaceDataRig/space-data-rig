// Offline tests for the pixel-level false-positive vetting (target-pixel reader +
// centroid-shift discriminators). The centroid math runs on synthetic cubes so it is
// deterministic and needs no network; the one test that parses a REAL SPOC target-pixel
// file runs only when the cached product is present, so fresh clones and CI stay green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  fetchSpocTargetPixels,
  centroidOfCadence,
  centroidShift,
  PIXEL_SCALE_ARCSEC,
  type TargetPixelCube,
} from "../src/data/mastS3Pixels.ts";

const CACHE_TP = "out/probe-tp.fits"; // TIC 261136679 (pi Men c), sector 0001 target pixel
const haveTp = existsSync(CACHE_TP);

/** Build a cube whose aperture is a Gaussian blob at (cx,cy) for each cadence. */
function cubeWithCenters(times: number[], centers: { cx: number; cy: number }[], nx = 14, ny = 14): TargetPixelCube {
  const rows = times.length;
  const flux = new Float64Array(rows * nx * ny);
  for (let r = 0; r < rows; r++) {
    const { cx, cy } = centers[r];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        flux[r * nx * ny + y * nx + x] = 1e6 * Math.exp(-d2 / 8);
      }
    }
  }
  return {
    targetId: "SYNTH",
    rows,
    time: Float64Array.from(times),
    quality: new Float64Array(rows),
    nx,
    ny,
    flux,
    source: "synthetic cube",
  };
}

test("centroidOfCadence finds the aperture flux-weighted center", () => {
  const c = cubeWithCenters([2458000.5], [{ cx: 7, cy: 7 }]);
  const cen = centroidOfCadence(c, 0);
  assert.ok(cen);
  assert.ok(Math.abs(cen!.x - 7) < 0.1 && Math.abs(cen!.y - 7) < 0.1, `centroid (${cen!.x},${cen!.y})`);
});

test("centroidOfCadence returns null for a quality-flagged cadence", () => {
  const c = cubeWithCenters([2458000.5], [{ cx: 7, cy: 7 }]);
  c.quality[0] = 8; // desaturation / drift flag
  assert.equal(centroidOfCadence(c, 0), null);
});

test("centroidShift is ~0 for an on-target planet and large for an off-target blend", () => {
  // 30 cadences over ~3 periods; the first two (near t0) are "in transit".
  const times: number[] = [];
  for (let i = 0; i < 30; i++) times.push(2458000 + i * 0.1);
  const t0 = times[0];
  const period = 3;
  const durHours = 8; // half-window 0.167d, so time[0] and time[1] land in transit (>=2 needed)

  // exact same predicate centroidShift uses, so the cube is unambiguous.
  const halfDur = durHours / 24 / 2;
  const isIn = (t: number): boolean => {
    let d = (t - t0) / period;
    d -= Math.round(d);
    return Math.abs(d * period) <= halfDur;
  };

  // ON-TARGET: the blob center never moves -> shift ~0 -> not flagged.
  const planet = cubeWithCenters(times, times.map(() => ({ cx: 7, cy: 7 })));
  const sPlanet = centroidShift(planet, t0, period, durHours, 1.0);
  assert.equal(sPlanet.shifts, false, `planet shift ${sPlanet.shiftArcsec}"`);
  assert.ok(sPlanet.shiftArcsec < 1.0, `expected sub-arcsec shift, got ${sPlanet.shiftArcsec}"`);

  // OFF-TARGET BLEND: during transit the light comes from a contaminant 3px away.
  const centers = times.map((t) => (isIn(t) ? { cx: 10, cy: 7 } : { cx: 7, cy: 7 }));
  const blend = cubeWithCenters(times, centers);
  const sBlend = centroidShift(blend, t0, period, durHours, 1.0);
  assert.equal(sBlend.inCount >= 2, true, "at least two cadences should be in transit");
  assert.ok(sBlend.shiftArcsec > 20, `blend should shift by arcsec, got ${sBlend.shiftArcsec}"`);
  assert.equal(sBlend.shifts, true);
});

test("PIXEL_SCALE_ARCSEC is the TESS plate scale", () => {
  assert.equal(PIXEL_SCALE_ARCSEC, 21);
});

test("fetchSpocTargetPixels returns null on a 404 (no target-pixel product)", async () => {
  const cube = await fetchSpocTargetPixels(999999, 1, "TIC 999999", {
    fetchImpl: (async () => new Response("Not Found", { status: 404 })) as never,
  });
  assert.equal(cube, null);
});

test(
  "fetchSpocTargetPixels parses a real SPOC 14x14 aperture and pi Men c stays on-target",
  { skip: haveTp ? false : "no cached target-pixel; run the tp fetch" },
  async () => {
    const bytes = new Uint8Array(readFileSync(CACHE_TP));
    const cube = await fetchSpocTargetPixels(261136679, 1, "TIC 261136679", {
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as never,
    });
    assert.ok(cube, "expected a cube");
    assert.equal(cube!.rows, 1337);
    assert.equal(cube!.nx, 14);
    assert.equal(cube!.ny, 14);
    assert.equal(cube!.flux.length, 1337 * 196);
    // true ephemeris (external): a real planet transits the target -> tiny centroid shift.
    const shift = centroidShift(cube!, 2458425.789204, 6.2678399, 2.952, 1.0);
    assert.equal(shift.shifts, false, `pi Men c shifted ${shift.shiftArcsec.toFixed(2)}" -- reader mislabels a planet`);
    assert.ok(shift.inCount > 0 && shift.outCount > 100, `in=${shift.inCount} out=${shift.outCount}`);
  },
);
