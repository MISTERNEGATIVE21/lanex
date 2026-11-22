# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Sweep correctness (audit 2026-11-15, G11 G18 G19 and 4.7): values checked
the way LibreLane reads them before any point runs, each setting's value in
the design from its effective config, the fixed-die guard, the riders, why a
sweep ended short, fail-fast, continuing a sweep, and Compare's best."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from lanex.controller import dse, history

SPM_YAML = """DESIGN_NAME: spm
VERILOG_FILES: dir::src/*.v
CLOCK_PERIOD: 10
CLOCK_PORT: clk
pdk::sky130*:
  FP_CORE_UTIL: 55
  CLOCK_PERIOD: 10.0
  scl::sky130_fd_sc_hs:
    CLOCK_PERIOD: 8
pdk::gf180mcu*:
  CLOCK_PERIOD: 24.0
"""


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv("LANEX_HOME", str(tmp_path / "home"))
    yield
    dse.job.cancel()


def _drain(job, n=400):
    for _ in range(n):
        if not job.active:
            return
        time.sleep(0.02)
    raise AssertionError("sweep thread never finished")


def _design(tmp_path: Path, text: str = SPM_YAML, name: str = "config.yaml") -> Path:
    d = tmp_path / "spm"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(text, encoding="utf-8")
    return d


@pytest.fixture
def typed_vars(monkeypatch):
    """The variable kinds the checks rely on, whether or not LibreLane is
    importable here (with it, its own Variable.compile does the check)."""
    info = {
        "FP_CORE_UTIL": {"name": "FP_CORE_UTIL", "kind": "number", "default": 50, "units": "%", "description": "The core utilization percentage."},
        "CLOCK_PERIOD": {"name": "CLOCK_PERIOD", "kind": "number", "default": None, "units": "ns", "description": "The clock period."},
        "RUN_CTS": {"name": "RUN_CTS", "kind": "bool", "default": True},
        "GRT_ANTENNA_REPAIR_ITERS": {"name": "GRT_ANTENNA_REPAIR_ITERS", "kind": "int", "default": 3},
        "FP_SIZING": {"name": "FP_SIZING", "kind": "choice", "choices": ["absolute", "relative"], "default": "relative"},
        "DIE_AREA": {"name": "DIE_AREA", "kind": "numbers", "default": None},
        "CORE_AREA": {"name": "CORE_AREA", "kind": "numbers", "default": None},
        "PL_TARGET_DENSITY_PCT": {"name": "PL_TARGET_DENSITY_PCT", "kind": "number", "default": None, "pdk": True},
        "SYNTH_STRATEGY": {"name": "SYNTH_STRATEGY", "kind": "choice", "choices": ["AREA 0", "DELAY 0"], "default": "AREA 0"},
        "MAX_FANOUT_CONSTRAINT": {"name": "MAX_FANOUT_CONSTRAINT", "kind": "int", "default": 10},
    }
    merged = dict(info)
    monkeypatch.setattr(dse, "_var_info", lambda: merged)
    monkeypatch.setattr(dse, "_known_var_names", lambda: frozenset(merged))
    return merged


# ---------------------------------------------------------------- value checks
@pytest.mark.parametrize("var,value,needle", [
    ("FP_CORE_UTIL", "abc", "takes a number"),
    ("FP_CORE_UTIL", "150", "at most 100"),
    ("FP_CORE_UTIL", "0", "above 0"),
    ("CLOCK_PERIOD", "-5", "above 0"),
    ("RUN_CTS", "maybe", "true or false"),
    ("GRT_ANTENNA_REPAIR_ITERS", "3.5", "whole number"),
    ("FP_SIZING", "fixed", "absolute"),
    ("DIE_AREA", "0 0 100", "numbers"),
    ("FP_CORE_UTIL", "35:65:x", "takes a number"),
])
def test_a_value_librelane_would_refuse_is_named(typed_vars, var, value, needle):
    msg = dse.check_value(var, value)
    assert msg and needle in msg and var in msg


@pytest.mark.parametrize("var,value", [
    ("FP_CORE_UTIL", "45"), ("FP_CORE_UTIL", "45.5"), ("CLOCK_PERIOD", "12.5"), ("RUN_CTS", "true"),
    ("GRT_ANTENNA_REPAIR_ITERS", "3"), ("FP_SIZING", "absolute"), ("DIE_AREA", "0 0 200 200"),
    ("SYNTH_STRATEGY", "AREA 0"),
])
def test_good_values_pass(typed_vars, var, value):
    assert dse.check_value(var, value) is None


def test_a_bad_value_is_refused_before_any_run(typed_vars):
    with pytest.raises(ValueError, match="takes a number"):
        dse.expand_sweep({"axes": [{"var": "FP_CORE_UTIL", "values": ["40", "abc"]}]})
    assert dse.expand_sweep({"axes": [{"var": "FP_CORE_UTIL", "values": ["40", "50"]}]}) == [
        {"FP_CORE_UTIL": "40"}, {"FP_CORE_UTIL": "50"}]


# ---------------------------------------------------------------- effective values
def test_the_clock_comes_from_the_section_that_matches_the_pdk(tmp_path, typed_vars):
    d = _design(tmp_path)
    hd = dse.effective_values(d, ["CLOCK_PERIOD"], {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"})
    e = hd["values"]["CLOCK_PERIOD"]
    assert float(e["value"]) == 10.0 and e["source"] == "config" and "pdk::sky130*" in e["config_source"]
    hs = dse.effective_values(d, ["CLOCK_PERIOD"], {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hs"})
    assert float(hs["values"]["CLOCK_PERIOD"]["value"]) == 8
    gf = dse.effective_values(d, ["CLOCK_PERIOD"], {"PDK": "gf180mcuD"})
    assert float(gf["values"]["CLOCK_PERIOD"]["value"]) == 24.0
    # A one-off setting (a -c override) wins over every section.
    ov = dse.effective_values(d, ["CLOCK_PERIOD"], {"PDK": "sky130A", "CLOCK_PERIOD": "7"})
    assert ov["values"]["CLOCK_PERIOD"]["value"] == "7" and ov["values"]["CLOCK_PERIOD"]["source"] == "override"
    assert ov["values"]["CLOCK_PERIOD"]["config"] == 10.0


def test_unset_values_fall_back_to_the_default_or_the_pdk(tmp_path, typed_vars):
    d = _design(tmp_path, "DESIGN_NAME: spm\nCLOCK_PERIOD: 10\n")
    v = dse.effective_values(d, ["FP_CORE_UTIL", "PL_TARGET_DENSITY_PCT"], {})["values"]
    assert v["FP_CORE_UTIL"]["source"] == "default" and v["FP_CORE_UTIL"]["value"] == 50
    assert v["FP_CORE_UTIL"]["description"]
    assert v["PL_TARGET_DENSITY_PCT"]["source"] == "pdk" and v["PL_TARGET_DENSITY_PCT"]["value"] is None


# ---------------------------------------------------------------- the plan
def test_fixed_die_blocks_a_utilisation_sweep(tmp_path, typed_vars):
    d = _design(tmp_path, json.dumps({"DESIGN_NAME": "spm", "FP_SIZING": "absolute", "DIE_AREA": [0, 0, 300, 300]}),
                "config.json")
    p = dse.plan_sweep(d, axes=[{"var": "FP_CORE_UTIL", "values": ["40", "50"]}], base_overrides={"PDK": "sky130A"})
    assert p["problems"] and "FP_SIZING is absolute" in p["problems"][0] and "0 0 300 300" in p["problems"][0]
    # Sweeping FP_SIZING alongside (relative) makes FP_CORE_UTIL size the die again.
    p2 = dse.plan_sweep(d, axes=[{"var": "FP_CORE_UTIL", "values": ["40"]}, {"var": "FP_SIZING", "values": ["relative"]}])
    assert not p2["problems"] and p2["count"] == 1
    # The die itself can be swept.
    p3 = dse.plan_sweep(d, axes=[{"var": "DIE_AREA", "values": ["0 0 300 300", "0 0 270 270"]}])
    assert not p3["problems"] and p3["count"] == 2


def test_a_smaller_die_cannot_cut_into_a_fixed_core(tmp_path, typed_vars):
    d = _design(tmp_path, json.dumps({"DESIGN_NAME": "spm", "FP_SIZING": "absolute", "DIE_AREA": "0 0 300 300",
                                       "CORE_AREA": "10 10 290 290"}), "config.json")
    p = dse.plan_sweep(d, axes=[{"var": "DIE_AREA", "values": ["0 0 270 270"]}])
    assert any("CORE_AREA" in x for x in p["problems"])


def test_a_relative_die_ignores_die_area(tmp_path, typed_vars):
    d = _design(tmp_path)
    p = dse.plan_sweep(d, axes=[{"var": "DIE_AREA", "values": ["0 0 270 270"]}])
    assert any("only used when FP_SIZING is absolute" in x for x in p["problems"])


def test_riders_and_typed_problems_are_listed(tmp_path, typed_vars):
    d = _design(tmp_path)
    p = dse.plan_sweep(d, axes=[{"var": "CLOCK_PERIOD", "values": ["10", "abc"]}],
                       base_overrides={"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd",
                                       "MAX_FANOUT_CONSTRAINT": "6", "CLOCK_PERIOD": "9", "BLANK": ""},
                       keys=["FP_CORE_UTIL"])
    assert p["riders"] == {"MAX_FANOUT_CONSTRAINT": "6"}
    assert any("CLOCK_PERIOD is also a one-off setting" in w for w in p["warnings"])
    assert p["value_problems"] and p["value_problems"][0]["value"] == "abc"
    assert p["problems"]
    assert float(p["context"]["FP_CORE_UTIL"]["value"]) == 55   # pdk::sky130* section


# ---------------------------------------------------------------- how a sweep ended
def test_end_reasons_are_reported(tmp_path):
    ends = []
    job = dse.DseJob()
    job.start(start_one=lambda t, o: {"ok": True, "kind": "clean"}, overrides_list=[{}, {}], tags=["a", "b"],
              on_done=ends.append)
    _drain(job)
    assert ends == [{"reason": "done", "detail": None}] and job.status()["end_reason"] == "done"

    job2 = dse.DseJob()
    job2.start(start_one=lambda t, o: {"ok": True, "kind": "clean", "good": True}, overrides_list=[{}, {}],
               tags=["a", "b"], stop_when_good=True, on_done=ends.append)
    _drain(job2)
    assert ends[-1]["reason"] == "first-clean"

    job3 = dse.DseJob()

    def slow(t, o):
        time.sleep(0.05)
        return {"ok": False, "kind": "stopped"}
    job3.start(start_one=slow, overrides_list=[{}, {}, {}], tags=["a", "b", "c"], on_done=ends.append)
    job3.cancel()
    _drain(job3)
    assert ends[-1]["reason"] == "stopped"


def test_two_points_failing_before_any_step_stop_the_rest():
    ends, ran = [], []
    job = dse.DseJob()

    def start_one(tag, ov):
        ran.append(tag)
        return {"ok": False, "kind": "halted", "steps_done": 0, "reason": "The config did not load"}
    job.start(start_one=start_one, overrides_list=[{}] * 5, tags=list("abcde"), on_done=ends.append)
    _drain(job)
    assert ran == ["a", "b"]
    assert ends == [{"reason": "failed-fast", "detail": "The config did not load"}]


def test_points_that_fail_later_or_differently_keep_going():
    ran = []
    job = dse.DseJob()

    def start_one(tag, ov):
        ran.append(tag)
        # A utilisation sweep: the fullest points fail in placement, after many steps.
        return {"ok": False, "kind": "halted", "steps_done": 30, "reason": "DPL-0036"}
    job.start(start_one=start_one, overrides_list=[{}] * 3, tags=list("abc"))
    _drain(job)
    assert ran == list("abc") and job.end_reason == "done"


def test_the_end_is_recorded_in_the_manifest(tmp_path):
    dse.record_sweep(tmp_path, {"id": "s1", "tags": ["a", "b"], "count": 2})
    dse.record_end(tmp_path, "s1", {"reason": "stopped", "detail": None, "junk": 1})
    s = dse.load_sweeps(tmp_path)[0]
    assert s["ended"]["reason"] == "stopped" and "at" in s["ended"] and "junk" not in s["ended"]


def test_the_sweeps_list_says_when_lanex_stopped_mid_sweep(tmp_path, monkeypatch):
    from lanex.server import routes
    out = {}
    monkeypatch.setattr(routes, "_respond", lambda h, payload, code=200: out.update(payload=payload, code=code))
    monkeypatch.setattr(routes, "_get_active_design_dir", lambda: str(tmp_path))
    dse.record_sweep(tmp_path, {"id": "old", "tags": ["a", "b", "c"], "count": 3, "results": {"a": {"ok": True}}})
    dse.record_sweep(tmp_path, {"id": "done", "tags": ["x"], "count": 1, "ended": {"reason": "done"}})
    # Started by this LanEx (an end is expected), never ended: certainly cut short.
    dse.record_sweep(tmp_path, {"id": "cut", "tags": ["y", "z"], "count": 2, "ended": None})

    class H:
        _body = {}
        path = "/api/dse/sweeps"
    routes.h_dse_sweeps(H())
    by = {s["id"]: s for s in out["payload"]["sweeps"]}
    assert by["old"]["ended"] == {"reason": "interrupted", "assumed": True}
    assert by["done"]["ended"] == {"reason": "done"}
    assert by["cut"]["ended"] == {"reason": "interrupted", "assumed": False}


# ---------------------------------------------------------------- continuing a sweep
def _manifest():
    return {"id": "s1", "axes": [{"var": "CLOCK_PERIOD", "values": ["10", "9", "8"]}], "mode": "grid",
            "tags": ["sweep-clk-10", "sweep-clk-9", "sweep-clk-8"],
            "points": [{"CLOCK_PERIOD": "10"}, {"CLOCK_PERIOD": "9"}, {"CLOCK_PERIOD": "8"}],
            "results": {"sweep-clk-8": {"ok": False, "values": {"CLOCK_PERIOD": "8"}}}}


def test_rerun_failed_points_runs_their_own_values():
    c = dse.continuation(_manifest(), rerun=["sweep-clk-8"])
    assert c["points"] == [{"CLOCK_PERIOD": "8"}] and c["reruns"] == ["sweep-clk-8"]
    with pytest.raises(ValueError):
        dse.continuation(_manifest(), rerun=["not-a-point"])


def test_add_values_skips_the_ones_already_run(typed_vars):
    c = dse.continuation(_manifest(), values=["9", "7", "6.5", "7"])
    assert c["points"] == [{"CLOCK_PERIOD": "7"}, {"CLOCK_PERIOD": "6.5"}]
    assert c["axes"][0]["values"] == ["10", "9", "8", "7", "6.5"]
    with pytest.raises(ValueError, match="already"):
        dse.continuation(_manifest(), values=["10"])
    with pytest.raises(ValueError, match="takes a number"):
        dse.continuation(_manifest(), values=["fast"])
    two = {**_manifest(), "axes": [{"var": "A", "values": [1]}, {"var": "B", "values": [2]}]}
    with pytest.raises(ValueError, match="one setting"):
        dse.continuation(two, values=["3"])


def test_a_continued_sweep_keeps_its_id_and_settings(tmp_path, monkeypatch, typed_vars):
    from lanex.server import app, routes
    d = _design(tmp_path)
    m = {**_manifest(), "base_overrides": {"PDK": "sky130A", "MAX_FANOUT_CONSTRAINT": "6"}, "count": 3,
         "run_mode": "container", "flow": "Classic", "sources": [], "extras": [], "ended": {"reason": "stopped"}}
    dse.record_sweep(d, m)
    out, seen = {}, {}
    monkeypatch.setattr(routes, "_respond", lambda h, payload, code=200: out.update(payload=payload, code=code))
    monkeypatch.setattr(routes, "_get_active_design_dir", lambda: str(d))
    monkeypatch.setattr(routes, "_design_refusal", lambda h, dd: None)
    monkeypatch.setattr(routes, "_other_flow_busy", lambda **k: None)

    def fake_start(**kw):
        seen.update(kw)
        return {"ok": True, "count": len(kw["tags"]), "run_tags": list(kw["tags"])}
    monkeypatch.setattr(dse.job, "start", fake_start)

    class H:
        _body = {"continue": {"sweep_id": "s1", "rerun": ["sweep-clk-8"]},
                 "base_overrides": {"PDK": "sky130A", "CLOCK_PERIOD": "99"}}
        headers = {}
        path = "/api/dse/start"
    routes.h_dse_start(H())
    assert out.get("code", 200) == 200, out
    assert out["payload"]["sweep_id"] == "s1"
    assert seen["overrides_list"] == [{"CLOCK_PERIOD": "8"}]
    assert seen["tags"] == ["sweep-clk-8-2"], "a continued sweep's new run never takes an old point's name"
    s = dse.load_sweeps(d)[0]
    assert s["count"] == 4 and len(s["tags"]) == 4 and s["ended"] is None
    assert s["reruns"] == {"sweep-clk-8": seen["tags"][0]}
    assert s["base_overrides"] == {"PDK": "sky130A", "MAX_FANOUT_CONSTRAINT": "6"}


# ---------------------------------------------------------------- Compare's best
def _run(root: Path, tag: str, metrics: dict, *, finished: bool = True) -> Path:
    run = root / "runs" / tag
    run.mkdir(parents=True)
    if finished:
        (run / "final").mkdir()
        (run / "final" / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
        (run / "state_out.json").write_text("{}", encoding="utf-8")
    else:
        (run / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
    (run / "config.json").write_text(json.dumps({"PDK": "sky130A"}), encoding="utf-8")
    return run


def test_a_failed_run_is_never_the_best(tmp_path):
    ok = _run(tmp_path, "ok", {"design__instance__area": 900.0, "timing__setup__ws": 1.0})
    bad = _run(tmp_path, "stopped", {"design__instance__area": 100.0, "timing__setup__ws": 9.0},
               finished=False)
    out = history.compare_runs([ok, bad])
    if not out["metric_meta"]["timing__setup__ws"]["direction_known"]:
        pytest.skip("no metric registry here")
    assert [r["success"] for r in out["runs"]] == [True, False]
    # The stopped run is "smaller" and has "more slack": neither makes it the best.
    assert out["best"]["design__instance__area"] == str(ok.resolve())
    assert out["best"]["timing__setup__ws"] == str(ok.resolve())
