#!/usr/bin/env python3
# Cross-validate the rig's simplified BLS against astropy's BoxLeastSquares.
#
# Dev-only companion to scripts/p2-bls-astropy.ts, which writes the fixture JSON this script
# consumes (default out/bls-astropy-fixtures.json). For every case BOTH implementations search the
# SAME exported period and duration grids on the SAME input light curve; this script asserts they
# agree on the transit period (tight) and the box depth (loose), and reports the non-gating stats
# (SNR, transit time) whose exact definitions differ between the two implementations.
#
# Contract: if numpy or astropy is missing this is a NO-OP -- it prints SKIP and exits 0, matching
# the "missing astropy => skip" rule of the npm harness. Exit code 1 happens ONLY when astropy IS
# available and a real disagreement is found. Run it directly or via `npm run p2:bls-astropy`.
import json
import sys


def _skip(reason):
    print("SKIP: %s" % reason)
    print("      astropy cross-validation is dev-only; the TS fixtures are unaffected.")
    sys.exit(0)


try:
    import numpy as np
except Exception as exc:  # environment dependent
    _skip("numpy not importable (%s)" % exc)

try:
    from astropy.timeseries import BoxLeastSquares
except Exception:
    try:
        from astropy.stats import BoxLeastSquares  # astropy < 4.0 location
    except Exception as exc:  # environment dependent
        _skip("astropy BoxLeastSquares not importable (%s); try: pip install astropy numpy" % exc)

# astropy and our bls search the SAME exported grid, so their best periods should be nearly
# identical; 1% is generous for that head-to-head match.
PERIOD_MATCH_TOL = 0.01
# The truth comparison instead allows about one period-grid step (~1.5% at oversample 16), which is
# the honest resolution limit of any gridded BLS, not a defect.
PERIOD_TRUTH_TOL = 0.02
# Box depth is model-stable but limb darkening and in/out-of-box edge handling differ; 25% is loose.
DEPTH_TOL = 0.25


def _col(stats, names, i):
    """Read the first present column among `names` at row i as a float, else NaN."""
    for n in names:
        try:
            return float(stats[n][i])
        except Exception:
            continue
    return float("nan")


def _rel(a, b):
    return abs(a - b) / max(abs(b), 1e-12)


def check_case(case):
    inp = case["input"]
    grid = case["grid"]
    ours = case["ours"]
    truth = case["truth"]
    time = np.array(inp["time"], dtype=float)
    flux = np.array(inp["flux"], dtype=float)
    err = inp.get("fluxErr")
    dy = np.array(err, dtype=float) if err else None
    periods = np.array(grid["periods"], dtype=float)
    durations = np.array(grid["durations"], dtype=float)
    # astropy requires every trial duration to be shorter than every trial period.
    durations = durations[durations < 0.9 * float(periods.min())]

    model = BoxLeastSquares(time, flux, dy=dy)
    stats = model.power(period=periods, duration=durations)
    power = np.asarray(stats["power"], dtype=float)
    i = int(np.argmax(power))
    a_period = float(stats["period"][i])
    a_depth = float(abs(stats["depth"][i]))
    a_dur = _col(stats, ["duration"], i)
    a_t0 = _col(stats, ["transit_time", "t0"], i)
    a_snr = _col(stats, ["snr"], i)

    o_period = float(ours["periodDays"])
    o_depth = float(abs(ours["depth"]))
    t_period = float(truth["periodDays"])

    checks = [
        ("period astropy-vs-ours", _rel(a_period, o_period), PERIOD_MATCH_TOL),
        ("period ours-vs-truth", _rel(o_period, t_period), PERIOD_TRUTH_TOL),
        ("period astropy-vs-truth", _rel(a_period, t_period), PERIOD_TRUTH_TOL),
        ("depth astropy-vs-ours", _rel(a_depth, o_depth), DEPTH_TOL),
    ]
    ok = all(v <= tol for _, v, tol in checks)
    detail = {
        "a_period": a_period,
        "o_period": o_period,
        "t_period": t_period,
        "a_depth": a_depth,
        "o_depth": o_depth,
        "a_dur": a_dur,
        "a_t0": a_t0,
        "a_snr": a_snr,
        "o_snr": float(ours.get("snr", float("nan"))),
        "checks": checks,
    }
    return ok, detail


def main(argv):
    path = argv[1] if len(argv) > 1 else "out/bls-astropy-fixtures.json"
    try:
        with open(path, "r") as fh:
            doc = json.load(fh)
    except Exception as exc:
        print("ERROR: cannot read fixtures at %s (%s)" % (path, exc))
        print("       run `npm run p2:bls-astropy` first to regenerate them.")
        return 1
    cases = doc.get("cases", [])
    if not cases:
        print("ERROR: no cases in %s" % path)
        return 1

    version = "unknown"
    try:
        import astropy

        version = astropy.__version__
    except Exception:
        pass
    print("astropy %s BLS cross-validation: %d case(s) from %s" % (version, len(cases), path))
    print("both implementations search the identical exported period+duration grid on identical input.")
    print("")
    hdr = "%-18s %8s %8s %9s %10s %11s %7s %9s  %s"
    print(hdr % ("case", "truthP", "ourP", "astropyP", "ourDepth", "astropyDepth", "ourSNR", "astropySNR", "verdict"))
    all_ok = True
    for case in cases:
        name = str(case.get("name", "?"))
        try:
            ok, d = check_case(case)
        except Exception as exc:
            all_ok = False
            print("%-18s  ERROR running astropy BLS: %s" % (name[:18], exc))
            continue
        all_ok = all_ok and ok
        print(
            hdr
            % (
                name[:18],
                "%.4f" % d["t_period"],
                "%.4f" % d["o_period"],
                "%.4f" % d["a_period"],
                "%.0fppm" % (d["o_depth"] * 1e6),
                "%.0fppm" % (d["a_depth"] * 1e6),
                "%.1f" % d["o_snr"],
                "%.1f" % d["a_snr"],
                "PASS" if ok else "FAIL",
            )
        )
        if not ok:
            for label, val, tol in d["checks"]:
                flag = "ok" if val <= tol else "EXCEEDED"
                print("    %-26s rel-diff %.4f (tol %.3f) %s" % (label, val, tol, flag))
    print("")
    print("non-gating note: SNR and transit-time definitions differ between the two implementations,")
    print("so they are reported for context only; PERIOD agreement (plus a loose depth check) is the")
    print("actual cross-check that our simplified BLS matches the mature astropy reference.")
    print("")
    if all_ok:
        print("RESULT: PASS -- our simplified BLS agrees with astropy on every fixture period.")
        return 0
    print("RESULT: FAIL -- at least one case disagrees with astropy beyond tolerance.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
