#!/usr/bin/env python3
"""Cross-pipeline validation harness: an INDEPENDENT Python software stack re-analyzes the committed real-curve
fixtures exported by scripts/p36-export-fixtures.ts.

WHY. Problem 3 of the roadmap asks for independent third-party validation. p35 added independence at the ALGORITHM
level (PDM vs the box-fit family, both in TypeScript). This harness adds independence at the IMPLEMENTATION level:
the SAME real TESS-SPOC photometry, re-analyzed by completely different software -- batman (transit injection,
Kreidberg 2015) + wotan (detrending, Hippke et al. 2019) + astropy.timeseries.BoxLeastSquares (Kovacs et al. 2002
reference implementation) and, when importable, the Transit Least Squares algorithm (transitleastsquares; Hippke &
Heller 2019). None of these share any code with this repository's TypeScript detectors, so agreement is
corroboration across implementations, not a tautology.

DESIGN (mirrors p33/p35, measure-before-gate, deterministic):
  * INJECT arm: for each fixture curve and each depth in the grid, multiply in a batman quadratic-limb-darkened
    transit at P = 3 d (fixed geometry, recorded in the output; if batman raises, a LABELLED pure-numpy box transit
    is injected instead and the exception text is published into the report), then score recovery on BOTH the raw and
    the wotan-detrended (biweight, 1.0 d window) curve with astropy BLS over [1, 13] d as "best period equals the
    injected period or a low-order harmonic/alias, tol 2%" -- the same alias set and tolerance the TS pipeline uses.
  * NULL arm: detrend + BLS on the fixture curve as-is; the recovered period is a TRUE positive if it matches a
    KNOWN CONFIRMED catalog planet of that host from the manifest (alias-tolerant), else a FALSE positive. Same
    lower-bound semantics as p33 (a genuine but unconfirmed planet counts as FP).

Runs in CI only (the dev environment has no Python); the workflow crosscheck-python.yml pins the interpreter and
package versions and uploads the JSON/markdown outputs as artifacts. Every method is independently guarded: if an
optional package fails to import or a fit fails on one curve, that cell is marked "error" and the rest still runs.
Honest boundary: this script measures and reports; it claims nothing, gates nothing, and touches no production
path.
"""

import json
import os
import sys
import time

import numpy as np

FIXTURE_DIR = os.path.join("tests", "fixtures", "spoc-curves")
OUT_DIR = os.path.join("reports", "crosscheck")

INJ_PERIOD = 3.0          # days, same as p33/p35
DEPTHS_PPM = [300, 500, 1000, 2000, 4000, 8000]
MATCH_TOL_PCT = 2.0       # same tolerance as the TS pipeline
ALIAS_FACTORS = [1.0, 0.5, 2.0, 1.0 / 3.0, 3.0, 2.0 / 3.0, 1.5, 3.0 / 2.0]  # same set as isAliasOf
BLS_MIN_PERIOD = 1.0
BLS_MAX_PERIOD = 13.0
BATMAN_PARAMS = {         # fixed injection geometry (recorded in the output)
    "t0": 1.0, "per": INJ_PERIOD, "a": 12.0, "inc": 88.53, "ecc": 0.0, "w": 90.0,
    "u": [0.4, 0.2], "limb_dark": "quadratic",
}
WOTAN_METHOD = "biweight"
WOTAN_WINDOW = 1.0        # days. Widened from the first run's 0.5 d as good practice (a local filter window should
                          # exceed the transit duration, ~0.12 d at P=3 d / a-R*=12, so it removes systematics rather
                          # than the transit). NOTE: the first CI run's INJECT arm did NOT return zero-recovery -- it
                          # ERRORED on every cell (see summary.injectErrors), and the exception text only reached the
                          # CI job log, which cannot be downloaded without auth. This revision therefore (a) captures
                          # and PUBLISHES the exception text into the committed report, (b) splits RAW vs DETRENDED
                          # recovery so any detrend-induced loss is measurable, and (c) verifies each injection is
                          # present in the data before scoring.


def is_alias_of(candidate: float, truth: float, tol_pct: float = MATCH_TOL_PCT) -> bool:
    """Same semantics as src/detect/iterative.ts isAliasOf: candidate matches truth if candidate/truth (or its
    reciprocal) is within tol_pct of one of the low-order alias factors."""
    if not np.isfinite(candidate) or not np.isfinite(truth) or truth <= 0 or candidate <= 0:
        return False
    ratio = candidate / truth
    for f in ALIAS_FACTORS:
        if abs(ratio - f) / f * 100.0 <= tol_pct:
            return True
        if abs(1.0 / ratio - f) / f * 100.0 <= tol_pct:
            return True
    return False


def load_manifest():
    with open(os.path.join(FIXTURE_DIR, "manifest.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_curve(entry):
    data = np.loadtxt(os.path.join(FIXTURE_DIR, entry["file"]), delimiter=",", skiprows=1)
    t, f = data[:, 0], data[:, 1]
    keep = np.isfinite(t) & np.isfinite(f)
    return t[keep], f[keep]


def inject_batman(t, flux, depth_ppm):
    """Multiply a batman transit model (depth in ppm) onto the relative flux; deterministic (fixed params)."""
    import batman
    params = batman.TransitParams()
    params.t0 = BATMAN_PARAMS["t0"]
    params.per = BATMAN_PARAMS["per"]
    params.rp = np.sqrt(depth_ppm * 1e-6)
    params.a = BATMAN_PARAMS["a"]
    params.inc = BATMAN_PARAMS["inc"]
    params.ecc = BATMAN_PARAMS["ecc"]
    params.w = BATMAN_PARAMS["w"]
    params.u = BATMAN_PARAMS["u"]
    params.limb_dark = BATMAN_PARAMS["limb_dark"]
    m = batman.TransitModel(params, t)
    return flux * m.light_curve(params, t)


def inject_box(t, flux, depth_ppm, period=INJ_PERIOD, t0=BATMAN_PARAMS["t0"], dur_days=0.12):
    """Pure-numpy BOX transit fallback (no limb darkening), used ONLY when batman raises, so the INJECT arm still
    yields a measurable recovery instead of an all-error column. Every cell that uses it is labelled
    'injectionModel': 'box-fallback' in the output, and the batman exception is published alongside it."""
    ph = (t - t0 + 0.5 * period) % period - 0.5 * period   # 0 at transit centre, in [-P/2, P/2)
    model = np.ones_like(flux, dtype=float)
    model[np.abs(ph) < 0.5 * dur_days] = 1.0 - depth_ppm * 1e-6
    return flux * model


def detrend_wotan(t, flux):
    """wotan biweight detrend; returns (flux_detrended, trend) or (None, None) on failure."""
    try:
        from wotan import flatten
        flat, trend = flatten(t, flux, method=WOTAN_METHOD, window_length=WOTAN_WINDOW, return_trend=True)
        if flat is None or not np.all(np.isfinite(flat)):
            return None, None
        return flat, trend
    except Exception as exc:  # noqa: BLE001 - report and degrade, never crash the harness
        print(f"    wotan error: {exc}")
        return None, None


def bls_period(t, flux):
    """astropy BoxLeastSquares over the fixed period range; returns best period (days) or None."""
    from astropy.timeseries import BoxLeastSquares
    try:
        bls = BoxLeastSquares(t, flux)
        r = bls.autopower(
            minimum_period=BLS_MIN_PERIOD, maximum_period=BLS_MAX_PERIOD,
            frequency_factor=10.0, duration=np.linspace(0.05, 0.40, 15),
        )
        p = float(r.period[np.argmax(r.power)])
        return p if np.isfinite(p) else None
    except Exception as exc:  # noqa: BLE001
        print(f"    astropy-BLS error: {exc}")
        return None


def tls_period(t, flux):
    """Transit Least Squares (optional; different algorithm AND implementation from astropy BLS). Returns best
    period (days) or None when transitleastsquares is unavailable or fails."""
    try:
        from transitleastsquares import transitleastsquares as tls
    except Exception:
        return None
    try:
        lc = tls(t, flux)
        res = lc.search(period_min=BLS_MIN_PERIOD, period_max=BLS_MAX_PERIOD, show_progress_bar=False)
        p = float(res["period"])
        return p if np.isfinite(p) else None
    except Exception as exc:  # noqa: BLE001
        print(f"    TLS error: {exc}")
        return None


def measure_injection_ppm(t, flux_orig, flux_inj, period=INJ_PERIOD, t0=BATMAN_PARAMS["t0"], half_width=0.03):
    """Verify the injection is actually present in the data: fold at the true period and return the median
    out-of-phase minus median in-phase flux, in ppm (crude but assumption-light)."""
    ph = ((t - t0) / period) % 1.0
    in_tr = (ph < half_width) | (ph > 1.0 - half_width)
    if in_tr.sum() < 5 or (~in_tr).sum() < 5:
        return None
    return float((np.median(flux_orig[~in_tr]) - np.median(flux_orig[in_tr])
                  - (np.median(flux_inj[~in_tr]) - np.median(flux_inj[in_tr]))) * 1e6)


def main():
    started = time.time()
    manifest = load_manifest()
    curves = manifest["curves"]
    print(f"Cross-pipeline harness: {len(curves)} committed real-curve fixtures "
          f"(cap {manifest['capPoints']} pts, <= {manifest['maxSectors']} sectors, seed {manifest['seed']})")
    print(f"Stack: batman injection (P={INJ_PERIOD} d, a/R*={BATMAN_PARAMS['a']}, i={BATMAN_PARAMS['inc']} deg, "
          f"quad LD {BATMAN_PARAMS['u']}) + wotan {WOTAN_METHOD} ({WOTAN_WINDOW} d) + astropy BLS [{BLS_MIN_PERIOD},"
          f"{BLS_MAX_PERIOD}] d; optional TLS. Alias tol {MATCH_TOL_PCT}%.\n")

    versions = {"numpy": np.__version__, "python": sys.version.split()[0]}
    for pkg in ("astropy", "batman", "wotan", "transitleastsquares"):
        try:
            mod = __import__(pkg)
            versions[pkg] = getattr(mod, "__version__", "imported")
        except Exception:
            versions[pkg] = "MISSING"
    print(f"Versions: {versions}\n")

    rows = []
    for entry in curves:
        t, f = load_curve(entry)
        host = entry["host"]
        t_row = time.time()
        row = {"host": host, "file": entry["file"], "nPoints": int(len(t)),
               "knownPlanetPeriodsDays": entry["knownPlanetPeriodsDays"]}

        # NULL arm: wotan + astropy BLS on the real curve as-is; classify against KNOWN CONFIRMED planets.
        flat, _ = detrend_wotan(t, f)
        null_src = flat if flat is not None else f
        p_null = bls_period(t, null_src)
        known = entry["knownPlanetPeriodsDays"]
        if p_null is None:
            row["null"] = {"periodDays": None, "classification": "no-detection"}
        else:
            match = any(is_alias_of(p_null, k) for k in known)
            row["null"] = {"periodDays": p_null, "classification": "TP" if match else "FP"}
        row["nullTlsPeriodDays"] = tls_period(t, null_src)

        # INJECT arm: batman transit at P=3 d across the depth grid -> astropy BLS on BOTH the raw injected
        # curve and the wotan-detrended one. Every exception is CAPTURED INTO THE ROW (and surfaced in the .md and
        # summary) so a failure is legible in the committed report, not hidden in the CI job log.
        rec = {}
        rec_raw = {}
        diag = {}
        errs = {}
        for d in DEPTHS_PPM:
            model = "batman"
            try:
                inj = inject_batman(t, f, d)
            except Exception as exc:  # noqa: BLE001 - capture WHY batman failed, then degrade to a labelled
                errs[str(d)] = f"inject_batman: {type(exc).__name__}: {exc}"  # pure-numpy box transit so the
                model = "box-fallback"                                        # INJECT arm still yields a number.
                inj = inject_box(t, f, d)
            try:
                meas = measure_injection_ppm(t, f, inj)
                p_raw = bls_period(t, inj)
                rec_raw[str(d)] = bool(p_raw is not None and is_alias_of(p_raw, INJ_PERIOD))
                flat_i, _ = detrend_wotan(t, inj)
                src = flat_i if flat_i is not None else inj
                p = bls_period(t, src)
                rec[str(d)] = bool(p is not None and is_alias_of(p, INJ_PERIOD))
                diag[str(d)] = {"injectionModel": model,
                                "measuredInjectedPpm": None if meas is None else round(meas, 1),
                                "rawBestPeriod": p_raw, "detrendedBestPeriod": p}
            except Exception as exc:  # noqa: BLE001 - keep any prior (batman) error, append the scoring error
                prev = errs.get(str(d))
                msg = f"score: {type(exc).__name__}: {exc}"
                errs[str(d)] = (prev + " | " + msg) if prev else msg
                rec[str(d)] = "error"
                rec_raw[str(d)] = "error"
                diag[str(d)] = {"injectionModel": model, "measuredInjectedPpm": None,
                                "rawBestPeriod": None, "detrendedBestPeriod": None}
        row["blsRecByDepth"] = rec
        row["blsRecByDepthRaw"] = rec_raw
        row["injectDiag"] = diag
        row["injectErrors"] = errs
        row["perCurveSec"] = round(time.time() - t_row, 2)
        rows.append(row)
        raw_str = "".join("1" if rec_raw[str(d)] is True else ("E" if rec_raw[str(d)] == "error" else "0") for d in DEPTHS_PPM)
        det_str = "".join("1" if rec[str(d)] is True else ("E" if rec[str(d)] == "error" else "0") for d in DEPTHS_PPM)
        print(f"  {host:<16} ({len(t)} pts, {row['perCurveSec']}s)  null {row['null']['classification']}"
              f"{'' if row['null']['periodDays'] is None else ' P=' + format(row['null']['periodDays'], '.2f') + 'd'}"
              f"  injectRaw[{raw_str}] injectDetrended[{det_str}]")

    n = len(rows)
    null_det = [r for r in rows if r["null"]["classification"] in ("TP", "FP")]
    tp = sum(1 for r in null_det if r["null"]["classification"] == "TP")
    fp = len(null_det) - tp
    # Aggregate every captured injection/scoring exception so the report itself exposes WHY a cell failed -- the
    # first CI run's INJECT arm errored on all 12 curves and the text only reached the un-downloadable job log.
    err_counts = {}
    for r in rows:
        for _d, _msg in r.get("injectErrors", {}).items():
            err_counts[_msg] = err_counts.get(_msg, 0) + 1
    inject_err_summary = {
        "totalCells": sum(err_counts.values()),
        "distinct": [{"message": m, "count": c} for m, c in sorted(err_counts.items(), key=lambda kv: -kv[1])],
    }
    summary = {
        "curves": n,
        "nullDetections": len(null_det), "nullTP": tp, "nullFP": fp,
        "purityLowerBound": round(tp / len(null_det), 3) if null_det else None,
        "blsCompletenessByDepth": {
            str(d): {
                "recovered": sum(1 for r in rows if r["blsRecByDepth"][str(d)] is True),
                "errors": sum(1 for r in rows if r["blsRecByDepth"][str(d)] == "error"),
                "rate": round(sum(1 for r in rows if r["blsRecByDepth"][str(d)] is True) / n, 3) if n else None,
            } for d in DEPTHS_PPM
        },
        "blsCompletenessByDepthRaw": {
            str(d): {
                "recovered": sum(1 for r in rows if r["blsRecByDepthRaw"][str(d)] is True),
                "errors": sum(1 for r in rows if r["blsRecByDepthRaw"][str(d)] == "error"),
                "rate": round(sum(1 for r in rows if r["blsRecByDepthRaw"][str(d)] is True) / n, 3) if n else None,
            } for d in DEPTHS_PPM
        },
        "injectErrors": inject_err_summary,
        "tlsNullPeriods": {r["host"]: r["nullTlsPeriodDays"] for r in rows},
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    payload = {
        "meta": {
            "generatedBy": "scripts/cross_pipeline.py (CI workflow crosscheck-python.yml)",
            "fixtureDir": FIXTURE_DIR, "fixtureSeed": manifest["seed"], "fixtureCapPoints": manifest["capPoints"],
            "injectPeriodDays": INJ_PERIOD, "depthsPpm": DEPTHS_PPM, "matchTolPct": MATCH_TOL_PCT,
            "aliasFactors": ALIAS_FACTORS, "batmanParams": BATMAN_PARAMS,
            "wotan": {"method": WOTAN_METHOD, "windowDays": WOTAN_WINDOW},
            "blsPeriodRangeDays": [BLS_MIN_PERIOD, BLS_MAX_PERIOD],
            "versions": versions, "wallClockSec": round(time.time() - started, 1),
            "provenance": manifest["provenance"],
        },
        "summary": summary, "rows": rows,
    }
    with open(os.path.join(OUT_DIR, "cross-pipeline.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    tls_installed = versions.get("transitleastsquares", "MISSING") != "MISSING"
    tls_note = (" + TLS" if any(v is not None for v in summary["tlsNullPeriods"].values())
                else (" (transitleastsquares imported but returned no period on any null curve -- see tlsNullPeriods)"
                      if tls_installed else " (transitleastsquares not installed: MISSING above)"))
    lines = ["# Cross-pipeline validation: Python stack on the committed real-curve fixtures", "",
             f"Stack: batman + wotan {WOTAN_METHOD} ({WOTAN_WINDOW} d window) + astropy BLS" + tls_note,
             f"Fixtures: {n} real public TESS-SPOC curves (seed {manifest['seed']}, cap {manifest['capPoints']} pts), "
             "byte-identical input each run.",
             f"Versions: {json.dumps(versions)}", "",
             "## NULL arm (independent stack on the real curve as-is)", "",
             f"- detections: {len(null_det)}/{n}; TP {tp} / FP {fp} (alias-tolerant match against KNOWN CONFIRMED planets;",
             "  a genuine unconfirmed planet counts FP, so purity is a lower bound -- same semantics as p33)",
             f"- purity lower bound: {summary['purityLowerBound']}", "",
             "## INJECT arm (batman transit at P=3 d, astropy BLS recovery)", "",
             "Two recovery columns: RAW (BLS on the injected curve as-is) and DETRENDED (wotan then BLS). Each",
             "injection is verified present in the data (measuredInjectedPpm in the JSON) before scoring.", "",
             "| depth (ppm) | raw recovered | raw rate | detrended recovered | detrended rate |", "|---|---|---|---|---|"]
    for d in DEPTHS_PPM:
        c = summary["blsCompletenessByDepth"][str(d)]
        cr = summary["blsCompletenessByDepthRaw"][str(d)]
        lines.append(f"| {d} | {cr['recovered']}/{n} | {cr['rate']} | {c['recovered']}/{n} | {c['rate']} |")
    models_used = sorted({v.get("injectionModel") for r in rows
                          for v in r.get("injectDiag", {}).values() if v.get("injectionModel")})
    lines += ["", f"Injection model(s) used: {', '.join(models_used) if models_used else 'none'}. "
              "('box-fallback' means batman raised, so a labelled pure-numpy box transit was injected instead; the "
              "batman exception text is published below.)"]
    if inject_err_summary["totalCells"] > 0:
        lines += ["", "### Captured injection/scoring errors (published here so they are legible outside the CI log)", ""]
        for e in inject_err_summary["distinct"][:12]:
            lines.append(f"- ({e['count']}x) `{e['message']}`")
    lines += ["", "Compare with the TypeScript pipeline on the same kind of real noise (p33, 33 curves, full "
              "resolution): 42.4% @300 ppm -> 81.8% @4000+. Differences here are expected and informative: these "
              "fixtures are subsampled (cap " + str(manifest['capPoints']) + " pts), the injection geometry is "
              "fixed, and the detrended column applies wotan where the TS p33 inject arm used the raw stitched "
              "curve -- the raw column is the like-for-like comparison.",
              ""]
    with open(os.path.join(OUT_DIR, "cross-pipeline.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    # Machine-readable summary for the workflow log as well.
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines))

    print(f"\nWrote {os.path.join(OUT_DIR, 'cross-pipeline.json')} and cross-pipeline.md "
          f"(wall clock {round(time.time() - started, 1)}s)")
    print(json.dumps(summary, indent=2))
    print("\nVERDICT: CROSS-PIPELINE-RAN")


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as exc:
        print(f"fixtures missing ({exc}); run `npm run p36:export-fixtures` and commit them first.")
        print("\nVERDICT: NO-FIXTURES")
        sys.exit(1)
