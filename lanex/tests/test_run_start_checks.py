# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Run start: the flow comes from the config (G12), the config is checked
before anything starts (audit 1c), and the reproduce record is there from the
start request on (audit 4.5)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from lanex.controller import configcheck as cc

pytest.importorskip("librelane.flows")


class _Runner:
    running = False

    def __init__(self) -> None:
        self.started: Dict[str, Any] = {}
        self.run_dir = None
        self.gui_meta = None

    def start(self, **kw):
        self.started = kw
        return {"ok": True, "reason": "started"}


def _project(d: Path, **cfg: Any) -> Path:
    (d / "src").mkdir(exist_ok=True)
    (d / "src" / "spm.v").write_text("module spm(input clk, input rst, output y); assign y = rst; endmodule\n")
    base = {"DESIGN_NAME": "spm", "VERILOG_FILES": "dir::src/*.v", "CLOCK_PORT": "clk", "CLOCK_PERIOD": 10,
            "PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"}
    base.update(cfg)
    p = d / "config.json"
    p.write_text(json.dumps(base))
    return p


@pytest.fixture()
def env(monkeypatch, tmp_path: Path):
    from lanex.server import app, routes
    cc.clear_cache()
    runner = _Runner()
    probe_answers: List[Dict[str, Any]] = [{"ok": True}]
    calls: List[Dict[str, Any]] = []

    def probe(args, **kw):
        calls.append(args)
        return dict(probe_answers[-1])
    monkeypatch.setattr(cc, "_run_probe", probe)
    monkeypatch.setattr(routes, "_get_active_design_dir", lambda: str(tmp_path))
    monkeypatch.setattr(app, "get_runner", lambda: runner)
    monkeypatch.setattr(routes.pdk_mod, "check_pdk_ready",
                        lambda p, s, m: {"ready": True, "pdk_root": "/pdks", "where": []})
    yield {"routes": routes, "runner": runner, "probe": probe_answers, "calls": calls, "dir": tmp_path}
    cc.clear_cache()


def _start(env, **body):
    return env["routes"]._start_run({"run_mode": "container", "overrides": {}, **body})


def test_a_config_librelane_refuses_never_starts(env):
    _project(env["dir"])
    env["probe"].append({"ok": False, "kind": "invalid",
                         "errors": ["Path provided for variable 'PNR_SDC_FILE' is invalid: 'src/x.sdc' does not exist"]})
    data, status = _start(env)
    assert status == 200 and data["ok"] is False and data["started"] is False
    assert "PNR_SDC_FILE" in data["reason"] and data["config_check"]["blocking"] is True
    # Nothing started: no runner call, no run folder.
    assert env["runner"].started == {}
    assert not (env["dir"] / "runs").exists()
    # "Run anyway" does not get past a config LibreLane can't load.
    data, _ = _start(env, checks_ack=True)
    assert data["started"] is False and env["runner"].started == {}


def test_wrong_top_name_asks_first_then_runs_when_acknowledged(env):
    _project(env["dir"], DESIGN_NAME="spm_top")
    env["probe"].append({"ok": True, "design_name": "spm_top", "clock_port": "clk",
                         "verilog_files": [str(env["dir"] / "src" / "spm.v")]})
    data, _ = _start(env)
    assert data["started"] is False and "spm_top" in data["reason"] and "spm" in data["reason"]
    assert data["config_check"]["blocking"] is False and env["runner"].started == {}
    data, _ = _start(env, checks_ack=True)
    assert data["ok"] is True and env["runner"].started


def test_missing_clock_port_is_caught_before_the_start(env):
    _project(env["dir"], CLOCK_PORT="clock")
    env["probe"].append({"ok": True, "design_name": "spm", "clock_port": "clock",
                         "verilog_files": [str(env["dir"] / "src" / "spm.v")]})
    data, _ = _start(env)
    assert data["started"] is False and "CLOCK_PORT" in data["reason"] and "clk" in data["reason"]


def test_the_run_uses_the_configs_meta_flow(env):
    _project(env["dir"], meta={"version": 2, "flow": "Chip"})
    data, _ = _start(env)
    assert data["ok"] is True and data["flow"] == "Chip"
    st = env["runner"].started
    assert st["flow_factory"].__name__ == "Chip"
    # The container gets no -f (LibreLane reads meta.flow, as in a terminal).
    assert st["flow_name"] is None
    assert st["gui_meta"]["flow"] == "Chip"
    assert " -f " not in st["gui_meta"]["cli_command"]["container"]


def test_an_unknown_flow_is_refused_not_swapped(env):
    _project(env["dir"])
    data, _ = _start(env, flow="Classicc")
    assert data["started"] is False and "no flow called 'Classicc'" in data["reason"]
    _project(env["dir"], meta={"version": 2, "flow": "Fancy"})
    data, _ = _start(env)
    assert data["started"] is False and "'Fancy'" in data["reason"] and "meta.flow" in data["reason"]
    assert env["runner"].started == {}


def test_explicit_flow_is_passed_on(env):
    _project(env["dir"])
    data, _ = _start(env, flow="Chip")
    st = env["runner"].started
    assert data["ok"] and st["flow_factory"].__name__ == "Chip" and st["flow_name"] == "Chip"
    assert "-f Chip" in st["gui_meta"]["cli_command"]["container"]


# ---------------------------------------------------------------- reproduce before the folder exists

def test_reproduce_answers_for_the_live_run_before_its_folder_exists(env):
    routes = env["routes"]
    _project(env["dir"])
    r = env["runner"]
    r.run_dir = str(env["dir"] / "runs" / "live-1")
    r.gui_meta = {"run_mode": "container", "cli_command": {
        "container": "librelane --docker-no-tty --dockerized config.json --run-tag live-1",
        "local": "librelane config.json --run-tag live-1", "recommended": "container", "cwd": str(env["dir"])}}
    got: Dict[str, Any] = {}
    routes_respond = routes._respond
    try:
        routes._respond = lambda h, payload, code=200: got.update(payload=payload, code=code)

        class H:
            path = "/api/run-reproduce?tag=live-1"
        routes.h_run_reproduce(H())
        assert got["code"] == 200 and got["payload"]["pending"] is True
        assert got["payload"]["command"].endswith("--run-tag live-1-repro")
        # The folder exists but gui-run.json is not written yet: still the record.
        (env["dir"] / "runs" / "live-1").mkdir(parents=True)
        routes.h_run_reproduce(H())
        assert got["payload"]["recorded"] is True and got["payload"]["pending"] is True
        # Another tag is still unknown.

        class H2:
            path = "/api/run-reproduce?tag=other"
        routes.h_run_reproduce(H2())
        assert got["code"] == 404
    finally:
        routes._respond = routes_respond


def test_preflight_carries_the_flow_and_the_config_check(env, monkeypatch):
    routes = env["routes"]
    _project(env["dir"], CLOCK_PORT="clock")
    env["probe"].append({"ok": True, "design_name": "spm", "clock_port": "clock",
                         "verilog_files": [str(env["dir"] / "src" / "spm.v")]})
    monkeypatch.setattr(routes, "_preflight_container_tools", lambda: {"container": {"available": True, "daemon_ok": True, "ready": True}})
    got: Dict[str, Any] = {}
    monkeypatch.setattr(routes, "_respond", lambda h, payload, code=200: got.update(payload=payload))

    class H:
        path = "/api/preflight?pdk=sky130A&scl=sky130_fd_sc_hd&run_mode=container"
    routes.h_preflight(H())
    p = got["payload"]
    assert p["flow"]["name"] == "Classic" and p["flow"]["steps"]
    assert p["config_check"]["problems"][0]["code"] == "clock"
    assert p["ready"] is False and any("CLOCK_PORT" in b for b in p["blockers"])
