#!/usr/bin/env python3
"""BENCHMARK-VS-FIELD arm: score the committed real-curve fixtures against the field's ACTUAL 2025 reference vetter,
LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280), so the rig's vetting is compared to a real external system -- not
only to our own re-implementations -- closing the RESEARCH 4c gap.

WHY THIS EXISTS. cross_pipeline.py proves IMPLEMENTATION-level independence for the DETECTION step (astropy BLS +
batman + wotan re-find the transits). The vetting step had the same gap: we ship validationPosterior.ts /
falseAlarmNull.ts / triceratopsLite.ts but had never run the field's published vetter on identical inputs. LEO-Vetter
is pip-installable and its flux metrics consume exactly what our fixtures plus the committed stellar-params.json
provide: a light curve, an ephemeris, and a stellar dictionary. This arm:

  * INJECTED-PLANET arm -- batman-transit injections across a depth grid, run through LEO-Vetter's full
    compute_flux_metrics + check_thresholds("FA"/"FP"). A candidate LEO-Vetter clears both is a Planet Candidate (PC);
    completeness = PC / injected, per depth. This is the SAME objective LEO-Vetter reports for itself, now measured on
    our fixtures so our pipeline's numbers (p92 SNR-gate completeness, p93 flux-posterior ROC) can sit beside it.
  * INJECTED-EB arm -- an equal-brightness eclipsing binary (a batman primary PLUS a matched secondary at phase 0.5)
    at the same ephemeris. LEO-Vetter's secondary-eclipse FP test should flag it; we report the FP-flag rate. This
    mirrors the p93 EB-family rejection and lets the two vetters be read side by side on the same synthetic FPs.

DESIGN GUARANTEES (mirror cross_pipeline; measure-before-gate; CI-only Python):
  * Every per-curve and per-arm computation is individually try/except-guarded; an exception is CAPTURED INTO THE
    REPORT text, never a silent zero. The whole LEO-Vetter import is guarded: if the package is unavailable the report
    says so and STILL is written (VERDICT LEO-VETTER-MISSING). The script ALWAYS exits 0 so this arm can never redden
    the cross-pipeline job -- an honest "did not run" beats a misleading failure or a masked null.
  * The flux_err we hand LEO-Vetter is ESTIMATED from the detrended scatter (a per-curve constant), because the
    committed fixtures keep only time+flux; this is labelled in the report and in the JSON meta. The stellar dictionary
    is REAL (NASA Exoplanet Archive, committed by p94); limb darkening is computed by LEO-Vetter's own Claret tables.
  * Research only: reads fixtures, writes reports/crosscheck/. Touches no verdict, bundle hash, money or deploy path;
    claims nothing.
"""

import json
import os
import sys
import time

import numpy as np

# Reuse the detection harness's committed data loaders and batman injection verbatim -- one source of truth for the
# fixture reading and the transit model, so the two Python arms analyze byte-identical inputs.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cross_pipeline as cp  # noqa: E402

OUT_DIR = os.path.join("reports", "crosscheck")
STAR_FILE = os.path.join(cp.FIXTURE_DIR, "stellar-params.json")

# A small depth grid keeps the CI runtime bounded; the field-relevant regime for these bright SPOC hosts is the top
# three, but we span deep-to-shallow so the completeness knee is visible.
INJECT_DEPTHS = [1000, 2000, 4000, 8000]
EB_PRIMARY_PPM = 6000     # a ~0.6% primary: unmistakably eclipse-like, well above the MES floor
EB_SECONDARY_RATIO = 0.9  # near-equal secondary (an EB of two similar stars), the canonical flux FP


def load_stars():
    with open(STAR_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def robust_sigma(flux):
    """Median-absolute-deviation scaled to a Gaussian sigma: a per-curve white-noise proxy for the estimated
    flux_err, since the committed fixtures carry no ERR column. Assumption-light and outlier-resistant."""
    finite = flux[np.isfinite(flux)]
    if finite.size < 8:
        return None
    mad = np.median(np.abs(finite - np.median(finite)))
    return float(1.4826 * mad) if mad > 0 else None


def epoch_within(t, per, t0_model):
    """A transit-center BJD that lies inside the observed span: the model puts dips at t0_model + n*per, so snap to
    the nearest such center to the data median. LEO-Vetter folds relative to this epoch, so it only needs to be a
    real center, not the absolute first."""
    tm = float(np.median(t))
    n = round((tm - t0_model) / per)
    return t0_model + n * per


def inject_eb(t, flux, primary_ppm, per, t0, secondary_ratio):
    """Primary eclipse (batman transit at t0) TIMES a matched secondary at t0 + per/2, both limb-darkened batman
    boxes -- a two-identical-stars eclipsing binary, the archetype flux false positive."""
    prim = cp.inject_batman(t, np.ones_like(flux), primary_ppm, )
    sec_model = cp.inject_batman(t - per / 2.0, np.ones_like(flux), primary_ppm * secondary_ratio)
    return flux * prim * sec_model


def classify(tlc, leo):
    """Return (is_PC, FA_flag, FP_flag, dep, MES) after running LEO-Vetter's flux metrics + threshold checks."""
    TCELightCurve = leo["TCELightCurve"]
    check_thresholds = leo["check_thresholds"]
    is_fa = bool(check_thresholds(tlc.metrics, "FA"))
    is_fp = bool(check_thresholds(tlc.metrics, "FP"))
    return (not is_fa and not is_fp), is_fa, is_fp


def try_import_leo():
    try:
        from leo_vetter.main import TCELightCurve
        from leo_vetter.thresholds import check_thresholds
        from leo_vetter import stellar as leo_stellar
        import leo_vetter
        return {
            "ok": True,
            "TCELightCurve": TCELightCurve,
            "check_thresholds": check_thresholds,
            "quadratic_ldc": leo_stellar.quadratic_ldc,
            "version": getattr(leo_vetter, "__version__", "installed"),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - the whole arm degrades gracefully if the external tool cannot load
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def build_star(rec, ldc):
    """Assemble the dictionary LEO-Vetter's compute_flux_metrics + derived_parameters read. u1/u2 come from the
    package's own Claret (2021) interpolation; everything else is the committed NASA-archive value."""
    u1, u2 = ldc
    return {
        "Teff": float(rec["Teff"]), "e_Teff": float(rec.get("e_Teff") or 0.0),
        "rad": float(rec["rad"]), "e_rad": float(rec.get("e_rad") or 0.0),
        "mass": float(rec["mass"]), "e_mass": float(rec.get("e_mass") or 0.0),
        "rho": float(rec["rho"]), "logg": float(rec["logg"]) if rec.get("logg") is not None else 4.5,
        "u1": float(u1), "u2": float(u2),
    }


def main():
    started = time.time()
    manifest = cp.load_manifest()
    curves = manifest["curves"]
    stars = load_stars()
    leo = try_import_leo()

    payload = {
        "meta": {
            "generatedBy": "scripts/benchmark_vs_field.py (CI workflow crosscheck-python.yml)",
            "externalTool": "LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280)",
            "leoImport": {"ok": leo["ok"], "version": leo.get("version"), "error": leo.get("error")},
            "fixtureSeed": manifest["seed"], "injectPeriodDays": cp.INJ_PERIOD,
            "injectDepthsPpm": INJECT_DEPTHS, "ebPrimaryPpm": EB_PRIMARY_PPM,
            "ebSecondaryRatio": EB_SECONDARY_RATIO,
            "stellarSource": stars["meta"]["source"], "fluxErrAssumption": "per-curve constant = 1.4826*MAD of the "
                "wotan-detrended flux (fixtures keep only time+flux); this only scales MES, not the shape tests",
            "provenance": manifest["provenance"], "wallClockSec": None,
        },
        "summary": None, "rows": [],
    }

    if not leo["ok"]:
        payload["meta"]["wallClockSec"] = round(time.time() - started, 1)
        payload["summary"] = {"status": "LEO-VETTER-MISSING",
                              "note": "the pip package did not import; no external numbers are claimed."}
        write_out(payload)
        print(f"LEO-Vetter not importable: {leo['error']}\nVERDICT: LEO-VETTER-MISSING")
        return

    # The package imported: run both arms on every curve. Each curve/arm is guarded so one bad cell never zeroes the
    # column; the exception text is collected and published.
    rec_pc = {str(d): 0 for d in INJECT_DEPTHS}
    rec_n = {str(d): 0 for d in INJECT_DEPTHS}
    eb_fp = 0
    eb_n = 0
    errors = {}

    def note_err(key, exc):
        msg = f"{type(exc).__name__}: {exc}"
        errors[msg] = errors.get(msg, 0) + 1

    TCELightCurve = leo["TCELightCurve"]
    for entry in curves:
        host = entry["host"]
        row = {"host": host, "stellar": None, "injected": {}, "eb": None}
        rec = stars["stars"].get(host)
        if rec is None:
            note_err("stellar-missing", RuntimeError(f"no committed stellar params for {host}"))
            payload["rows"].append(row)
            continue
        try:
            t, f = cp.load_curve(entry)
            flat, trend = cp.detrend_wotan(t, f)
            sigma = robust_sigma(flat if flat is not None else f)
            if sigma is None or not np.isfinite(sigma) or sigma <= 0:
                raise RuntimeError("degenerate scatter estimate")
            flux_err = np.full_like(f, sigma)
            use_detrended = flat is not None
            detrended = flat if use_detrended else f
            row["stellar"] = {k: rec[k] for k in ("Teff", "rad", "mass", "rho", "logg")}
            row["sigmaPpm"] = round(sigma * 1e6, 2)
            u1, u2 = leo["quadratic_ldc"](rec["Teff"], rec.get("logg") or 4.5, 0.0)
            star = build_star(rec, (u1, u2))
        except Exception as exc:  # noqa: BLE001
            note_err(f"{host}:setup", exc)
            payload["rows"].append(row)
            continue

        # INJECTED-PLANET arm across the depth grid.
        for d in INJECT_DEPTHS:
            try:
                inj = cp.inject_batman(t, detrended, d)
                epo = epoch_within(t, cp.INJ_PERIOD, cp.BATMAN_PARAMS["t0"])
                tlc = TCELightCurve(entry["tic"], t, f, inj, flux_err, cp.INJ_PERIOD, epo, 0.12)
                tlc.compute_flux_metrics(star, verbose=False)
                pc, is_fa, is_fp = classify(tlc, leo)
                row["injected"][str(d)] = {
                    "PC": pc, "FA": is_fa, "FP": is_fp,
                    "MES": round(float(tlc.metrics.get("MES", float("nan"))), 2),
                    "dep": round(float(tlc.metrics.get("dep", float("nan"))) * 1e6, 1),
                }
                rec_n[str(d)] += 1
                if pc:
                    rec_pc[str(d)] += 1
            except Exception as exc:  # noqa: BLE001
                row["injected"][str(d)] = {"error": f"{type(exc).__name__}: {exc}"}
                note_err(f"{host}:inject{d}", exc)

        # INJECTED-EB arm (equal-brightness binary: primary + matched secondary). Expect an FP flag.
        try:
            eb = inject_eb(t, detrended, EB_PRIMARY_PPM, cp.INJ_PERIOD, cp.BATMAN_PARAMS["t0"], EB_SECONDARY_RATIO)
            epo = epoch_within(t, cp.INJ_PERIOD, cp.BATMAN_PARAMS["t0"])
            tlc = TCELightCurve(entry["tic"], t, f, eb, flux_err, cp.INJ_PERIOD, epo, 0.12)
            tlc.compute_flux_metrics(star, verbose=False)
            pc, is_fa, is_fp = classify(tlc, leo)
            row["eb"] = {"PC": pc, "FA": is_fa, "FP": is_fp,
                         "dep_sec": round(float(tlc.metrics.get("dep_sec", float("nan"))) * 1e6, 1)
                         if np.isfinite(tlc.metrics.get("dep_sec", np.nan)) else None}
            eb_n += 1
            if is_fp:
                eb_fp += 1
        except Exception as exc:  # noqa: BLE001
            row["eb"] = {"error": f"{type(exc).__name__}: {exc}"}
            note_err(f"{host}:eb", exc)

        payload["rows"].append(row)
        pc_str = "".join("1" if row["injected"].get(str(d), {}).get("PC") else ("E" if "error" in row["injected"].get(str(d), {}) else "0") for d in INJECT_DEPTHS)
        eb_str = "FP" if (row.get("eb") or {}).get("FP") else ("E" if (row.get("eb") or {}).get("error") else "PC")
        print(f"  {host:<12} injectPC[{pc_str}] eb->{eb_str}")

    n = len(curves)
    payload["meta"]["wallClockSec"] = round(time.time() - started, 1)
    payload["summary"] = {
        "status": "RAN",
        "curves": n,
        "planetCompletenessByDepth": {
            str(d): {"pc": rec_pc[str(d)], "n": rec_n[str(d)],
                     "rate": round(rec_pc[str(d)] / rec_n[str(d)], 3) if rec_n[str(d)] else None}
            for d in INJECT_DEPTHS
        },
        "ebFpRejection": {"flaggedFP": eb_fp, "n": eb_n, "rate": round(eb_fp / eb_n, 3) if eb_n else None},
        "capturedErrors": [{"message": m, "count": c} for m, c in sorted(errors.items(), key=lambda kv: -kv[1])],
    }
    write_out(payload)
    print(json.dumps(payload["summary"], indent=2))
    print(f"\nVERDICT: {'BENCHMARK-RAN' if n else 'NO-CURVES'}")


def write_out(payload):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "benchmark-vs-field.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    lines = render_md(payload)
    with open(os.path.join(OUT_DIR, "benchmark-vs-field.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")


def render_md(payload):
    s = payload["summary"] or {}
    meta = payload["meta"]
    lines = ["# Benchmark vs the field: LEO-Vetter on the committed real-curve fixtures", ""]
    li = meta["leoImport"]
    lines += [f"External tool: LEO-Vetter (Kunimoto et al. 2025, AJ 170, 280), import "
              f"{'OK v' + str(li.get('version')) if li.get('ok') else 'FAILED: ' + str(li.get('error'))}",
              f"Stellar parameters: {meta['stellarSource']} (committed by scripts/p94-stellar-params.ts).",
              f"flux_err: {meta['fluxErrAssumption']}.", ""]
    if not li.get("ok"):
        lines += ["LEO-Vetter did not import in this CI environment, so NO external numbers are claimed. The report is",
                  "written anyway to make the absence legible. VERDICT: LEO-VETTER-MISSING.", ""]
        return lines
    lines += [f"## Injected planets -> LEO-Vetter Planet-Candidate completeness ({meta['injectPeriodDays']} d batman transit)", ""]
    lines += ["| depth (ppm) | PC / injected | completeness |", "|---|---|---|"]
    for d, c in (s.get("planetCompletenessByDepth") or {}).items():
        lines.append(f"| {d} | {c['pc']}/{c['n']} | {c['rate']} |")
    e = s.get("ebFpRejection") or {}
    lines += ["", "## Injected equal-brightness eclipsing binaries -> LEO-Vetter false-positive flag", "",
              f"- FP-flagged: {e.get('flaggedFP')}/{e.get('n')} (rate {e.get('rate')})", ""]
    errs = s.get("capturedErrors") or []
    if errs:
        lines += ["### Captured per-cell exceptions (published, never masked as a zero)", ""]
        for m in errs[:12]:
            lines.append(f"- ({m['count']}x) `{m['message']}`")
        lines.append("")
    lines += ["Side-by-side reading (our OWN pipeline on the same kind of real data): p92 measures injected-planet",
              "completeness vs the BLS-SNR joint objective, and p93 reports the flux-posterior rejection of the",
              "eclipsing-binary family. This file is the FIELD reference numbers on byte-identical fixtures; the",
              "comparison is descriptive, nothing here gates or claims. discoveryClaim false.", ""]
    return lines


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - the arm must never redden the cross-pipeline job
        print(f"benchmark_vs_field crashed: {type(exc).__name__}: {exc}")
        crash_meta = {"leoImport": {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                      "stellarSource": "n/a", "injectPeriodDays": 3.0}
        try:
            write_out({"meta": crash_meta, "summary": {"status": "CRASHED"}, "rows": []})
        except Exception:
            pass
        print("VERDICT: LEO-VETTER-CRASHED")
    sys.exit(0)
