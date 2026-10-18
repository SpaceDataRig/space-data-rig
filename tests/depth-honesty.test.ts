// Honest-precision guard: the browser mirror and the TypeScript original must agree, and both must be WIRED.
//
// WHY THE PARITY TEST EXISTS. src/core/depthFormat.ts is the reasoning; web/honest-precision.js is a copy of it,
// because the board is served as plain ES modules and cannot import a .ts file (tsconfig has no allowJs). Two
// implementations of one rule drift by default, and the drift is invisible: the finding card and the narration
// would quote different precisions for the same record, each looking authoritative. So the sweep below compares the
// two over every combination the surfaces can actually receive and fails on the first differing string.
//
// WHY THE WIRING TESTS EXIST. A pure function that nothing calls passes forever. This repository has already been
// audited into that exact failure twice (a relabel predicate that matched zero live cards, a freshness gate that
// verified nothing), so the assertions here check the call sites too, against the real web/app.js text.
//
// The numbers themselves are measured, not assumed: P90 (reports/p90-depth-estimators.md, 2026-10-18) graded the
// pipeline's own depth estimators against the NASA Exoplanet Archive on 16 period-matched confirmed planets --
// 36.7% median absolute error for the box, 44.2% for the per-sector fit, 33.0% for what the guard publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  renderDepthPpm as renderDepthTs,
  ceilToOneSigFig as ceilTs,
  decimalsFor as decimalsTs,
  DEPTH_SYSTEMATIC_REL as SYS_TS,
  DEPTH_CALIBRATION_R68_REL as R68_TS,
  DEPTH_CALIBRATION_N as N_TS,
} from "../src/core/depthFormat.ts";
import { renderPeriodDays as renderPeriodTs } from "../src/core/periodFormat.ts";
import {
  renderDepthPpm as renderDepthJs,
  ceilToOneSigFig as ceilJs,
  decimalsFor as decimalsJs,
  renderPeriodDays as renderPeriodJs,
  DEPTH_SYSTEMATIC_REL as SYS_JS,
  DEPTH_CALIBRATION_R68_REL as R68_JS,
  DEPTH_CALIBRATION_N as N_JS,
  BLS_DEFAULT_OVERSAMPLE as OVERSAMPLE_JS,
  MIN_SECTOR_BASELINE_DAYS as BASELINE_JS,
  depthCellText,
  periodCellText,
} from "../web/honest-precision.js";

const APP = readFileSync(resolve(process.cwd(), "web", "app.js"), "utf8");

test("the two implementations agree on every depth and SNR the surfaces can receive", () => {
  const ppms = [1, 12, 105, 660, 2788, 12160, 2339000, 1e7];
  const snrs = [0.4, 1, 3, 7.4, 15, 29.4, 108.7, 5000, -9, 0, Number.NaN];
  for (const p of ppms) {
    for (const s of snrs) {
      const depthFrac = p / 1e6;
      const a = renderDepthTs(depthFrac, s);
      const b = renderDepthJs(depthFrac, s);
      assert.deepEqual(a, b, `depth ${p} ppm at SNR ${s}: TS and the browser mirror must not disagree`);
    }
  }
});

test("the two implementations agree on every period and grid resolution", () => {
  const periods = [0.8, 1.4811, 3.14, 6.2758, 13.0487, 16.0, 42.5, 400.0];
  const resolutions = [undefined, 0.004, 0.02, 1.2037, 27.5, Number.NaN];
  for (const p of periods) {
    for (const r of resolutions) {
      for (const withU of [true, false]) {
        assert.deepEqual(
          renderPeriodTs(p, r, withU),
          renderPeriodJs(p, r, withU),
          `period ${p} at resolution ${r} (uncertainty shown: ${withU})`,
        );
      }
    }
  }
});

test("the constants the mirror repeats are the same numbers, not a paraphrase", () => {
  assert.equal(SYS_JS, SYS_TS, "the systematic floor must be one number across both surfaces");
  assert.equal(R68_JS, R68_TS, "the measured coverage radius must be one number across both surfaces");
  assert.equal(N_JS, N_TS, "the calibration sample size quoted in prose must match on both sides");
  assert.equal(SYS_TS, 0.5, "P90's 68%-coverage radius for a published depth, carried UP to one significant figure");
  assert.equal(R68_TS, 0.48, "the unrounded radius DEPTH_SYSTEMATIC_REL was rounded from");
  assert.ok(SYS_TS >= R68_TS, "the quoted bar may be wider than the measurement, never narrower");
  assert.equal(N_TS, 16, "period-matched rows in reports/p90-depth-estimators.md");
  assert.equal(OVERSAMPLE_JS, 8, "the oversample src/detect/bls.ts actually grids at");
  assert.equal(BASELINE_JS, 27, "one TESS sector, the conservative baseline");
});

test("a quoted depth never claims better precision than the measurement supports", () => {
  // No matter how strong the signal, the systematic floor from P90 stays: a 5000-SNR dip is still a ~37% depth.
  for (const snr of [7, 30, 1000, 1e6]) {
    for (const p of [60, 660, 13090]) {
      const r = renderDepthTs(p / 1e6, snr)!;
      assert.ok(r.uncertaintyPpm >= Math.floor(p * SYS_TS), `${p} ppm at SNR ${snr}: ${r.text}`);
      // Quoted to ONE significant figure, and never rounded down below the true uncertainty.
      const sig = String(r.uncertaintyPpm).replace(/^0\./, "").replace(/^0+/, "").replace(/0+$/, "");
      assert.ok(/^[1-9]$/.test(sig), `${r.text}: uncertainty must carry exactly one significant figure`);
      assert.ok(r.uncertaintyPpm >= r.relativeUncertainty * p - 1e-9, `${r.text}: rounding an error bar down over-claims`);
    }
  }
});

test("the rendered text is ASCII and uses the ASCII plus-minus the posting path requires", () => {
  const r = renderDepthTs(6.6e-4, 29.4)!;
  assert.equal(r.text, "660 +/- 400 ppm");
  assert.ok(!/[^\x00-\x7F]/.test(r.text), "no real minus sign, no en dash: the sender refuses non-ASCII");
  assert.ok(!/[^\x00-\x7F]/.test(r.percentText), r.percentText);
  // 660 ppm at 0.5 systematic (the statistical term 1/29.4 is negligible next to it) -> 330.8 -> ceil 1 sf -> 400.
  assert.equal(r.uncertaintyPpm, 400);
  assert.equal(r.percentText, "0.07 +/- 0.04 %");
});

test("a depth with no honest rendering returns null instead of a number with a fake error bar", () => {
  for (const bad of [0, -1.05e-4, Number.NaN, Number.POSITIVE_INFINITY, 1e-13]) {
    assert.equal(renderDepthTs(bad, 12), null, `depthFrac ${bad}`);
    assert.equal(renderDepthJs(bad, 12), null, `mirror depthFrac ${bad}`);
  }
  // A tiny depth that rounds to zero ppm cannot be shown as "0 +/- 0 ppm".
  assert.equal(renderDepthTs(2e-7, 9), null);
});

test("one-sig-fig rounding of an uncertainty goes up, which is the only safe direction", () => {
  assert.equal(ceilTs(244), 300);
  assert.equal(ceilJs(244), 300);
  assert.equal(ceilTs(201), 300);
  assert.equal(ceilTs(100), 100);
  assert.equal(ceilTs(0.0244), 0.03);
  assert.ok(Number.isNaN(ceilTs(0)) && Number.isNaN(ceilTs(-5)) && Number.isNaN(ceilTs(Number.NaN)));
  assert.equal(decimalsTs(300), 0);
  assert.equal(decimalsTs(0.03), 2);
  assert.equal(decimalsJs(0.03), decimalsTs(0.03));
});

test("a brightening is still described as a brightening, with no error bar on a dip that was never measured", () => {
  assert.equal(depthCellText(-105, -9), "no dip -- box measured a rise of 105 ppm");
  assert.equal(depthCellText(0, 0), "no dip measured");
  assert.equal(depthCellText(Number.NaN, 5), "no dip measured");
  assert.ok(!depthCellText(-105, -9).includes("+/-"), "an uncertainty on a non-dip would imply a measured dip");
});

test("period cells stop claiming three decimals the grid never resolved", () => {
  // A 16 d signal from a 27 d baseline at oversample 8 has a grid step of about 1.2 d.
  assert.equal(periodCellText(16.0, undefined), "16 +/- 1 d");
  assert.equal(periodCellText(1.96, 0.02), "1.96 +/- 0.02 d");
  assert.notEqual(periodCellText(16.0, undefined), "16.000 d");
});

test("a one-ppm depth does not get a fractional error bar, which would resolve the unit instead of the depth", () => {
  // 1 ppm at SNR 1.5: rel = sqrt(0.37^2 + (1/1.5)^2) = 0.76, so the raw 1-sf error is 0.8 ppm. Printed as-is it
  // claims a precision below the unit the value itself is written in.
  const r = renderDepthTs(1e-6, 1.5)!;
  assert.equal(r.text, "1 +/- 1 ppm");
  assert.equal(Number.isInteger(r.uncertaintyPpm), true, r.text);
  assert.equal(renderDepthJs(1e-6, 1.5)!.text, r.text, "the mirror must floor the error bar the same way");
});

// ---- wiring: the mirror must be the code the board actually runs ----

test("app.js imports the shared module and uses it in all three depth-bearing surfaces", () => {
  assert.match(APP, /import \{ depthCellText, periodCellText \} from "\/honest-precision\.js"/, "app.js must import the ONE shared module");
  const uses = APP.match(/depthCellText\(/g) ?? [];
  const periods = APP.match(/periodCellText\(/g) ?? [];
  // finding card + candidate card + observe panel, plus the definitions inside this module are not in APP.
  assert.equal(uses.length, 3, `expected 3 depth cells, saw ${uses.length}`);
  assert.equal(periods.length, 3, `expected 3 period cells, saw ${periods.length}`);
});

test("no card in app.js prints a raw ppm integer or a three-decimal period any more", () => {
  // The shapes this pass removed. If one comes back, the error bar is being dropped on a public surface.
  assert.doesNotMatch(APP, /\$\{Math\.round\(c\.depthPpm\)\} ppm/, "candidate card must go through depthCellText");
  assert.doesNotMatch(APP, /\$\{Math\.round\(s\.depthPpm\)\} ppm/, "observe panel must go through depthCellText");
  assert.doesNotMatch(APP, /\$\{\(c\.periodDays \?\? 0\)\.toFixed\(3\)\} d/, "finding card period");
  assert.doesNotMatch(APP, /c\.periodDays\.toFixed\(3\)\} d/, "candidate card period");
  assert.doesNotMatch(APP, /s\.periodDays\.toFixed\(3\)\} d/, "observe panel period");
});

// ---- the measurement behind the constant, recomputed independently ----

/* eslint-disable @typescript-eslint/no-explicit-any */
const P90_JSON = JSON.parse(readFileSync(resolve(process.cwd(), "reports", "p90-depth-estimators.json"), "utf8")) as any;
const P90_MD = readFileSync(resolve(process.cwd(), "reports", "p90-depth-estimators.md"), "utf8");

test("the depth error bar cited in code survives a recompute from P90's committed rows, offline", () => {
  // The statistics are re-derived HERE, with code written independently of scripts/p90-depth-estimators.ts, from the
  // rows that run committed. If the report's table, the JSON summary and the constant in src/core/depthFormat.ts
  // ever stop agreeing -- because someone edited the markdown, or re-ran the script on a different sample and left
  // the code citing the old number -- this fails. A cited measurement has to be checkable against the data it cites.
  const medAbs = (a: number[]): number => {
    const s = [...a.map(Math.abs)].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const qAbs = (a: number[], p: number): number => {
    const s = [...a.map(Math.abs)].sort((x, y) => x - y);
    const h = (s.length - 1) * p;
    const f = Math.floor(h);
    const c = Math.ceil(h);
    return s[f]! + (s[c]! - s[f]!) * (h - f);
  };

  const rows: any[] = P90_JSON.rows.filter(
    (r: any) => r.matched && Number.isFinite(r.perSectorDepthPpm) && Number.isFinite(r.boxDepthPpm),
  );
  assert.equal(rows.length, N_TS, `the report's own sample size changed (${rows.length}) but the cited constant did not`);

  const pub: number[] = rows.map((r) => r.publishedErrPct);
  const box: number[] = rows.map((r) => r.boxErrPct);
  const per: number[] = rows.map((r) => r.perSectorErrPct);

  // 1. recompute vs what the run stored.
  const summary = P90_JSON.meta.summary;
  assert.ok(Math.abs(medAbs(pub) - summary.publishedMedianAbsErrPct) < 1e-9, "published median");
  assert.ok(Math.abs(medAbs(box) - summary.boxMedianAbsErrPct) < 1e-9, "box median");
  assert.ok(Math.abs(medAbs(per) - summary.perSectorMedianAbsErrPct) < 1e-9, "per-sector median");
  const r68 = qAbs(pub, 0.68);
  assert.ok(Math.abs(r68 - summary.errorBar.published.r68Pct) < 1e-9, "68% radius vs stored");

  // 2. the constant is that radius carried UP to one significant figure: wider than measured, by less than one
  //    figure's worth of headroom, so it neither under-claims nor inflates the measurement into a fiction.
  assert.ok(SYS_TS >= r68 / 100, `${SYS_TS} must not be narrower than the measured ${r68.toFixed(1)}%`);
  assert.ok(SYS_TS < r68 / 100 + 0.1, `${SYS_TS} is more than one significant figure above ${r68.toFixed(1)}%`);
  assert.equal(R68_TS, Math.round(r68) / 100, `DEPTH_CALIBRATION_R68_REL cites ${R68_TS}, the rows say ${r68.toFixed(2)}%`);

  // 3. the markdown the report publishes carries the same numbers, so a reader can check the citation by hand.
  // The coverage table is the row with the 68%-over-median column; the Result table has the same label and no "x".
  const covRow = P90_MD.split("\n").find((l) => l.startsWith("| what the guard publishes |") && l.includes("x |"));
  assert.ok(covRow, "the coverage table is missing from reports/p90-depth-estimators.md");
  assert.ok(covRow.includes(`${r68.toFixed(1)}%`), `${covRow} must show the recomputed 68% radius ${r68.toFixed(1)}%`);
  assert.ok(covRow.includes(`${medAbs(pub).toFixed(1)}%`), `${covRow} must show the recomputed median`);
});
