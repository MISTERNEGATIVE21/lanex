# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Tests for DSE sweep expansion + targeted re-verify argv (Phase 2)."""
from __future__ import annotations

import pytest

from lanex.controller import dse, reverify


def test_expand_sweep_grid():
    spec = {"axes": [{"var": "FP_CORE_UTIL", "values": [40, 50, 60]},
                     {"var": "PL_TARGET_DENSITY_PCT", "values": [55, 65]}], "mode": "grid"}
    combos = dse.expand_sweep(spec)
    assert len(combos) == 6
    assert {"FP_CORE_UTIL": "40", "PL_TARGET_DENSITY_PCT": "55"} in combos
    assert {"FP_CORE_UTIL": "60", "PL_TARGET_DENSITY_PCT": "65"} in combos


def test_expand_sweep_list_zip():
    spec = {"axes": [{"var": "FP_CORE_UTIL", "values": [40, 60]},
                     {"var": "CLOCK_PERIOD", "values": [10, 12]}], "mode": "list"}
    combos = dse.expand_sweep(spec)
    assert combos == [{"FP_CORE_UTIL": "40", "CLOCK_PERIOD": "10"},
                      {"FP_CORE_UTIL": "60", "CLOCK_PERIOD": "12"}]


def test_expand_sweep_list_mismatched_lengths():
    spec = {"axes": [{"var": "FP_CORE_UTIL", "values": [40, 60]},
                     {"var": "CLOCK_PERIOD", "values": [10]}], "mode": "list"}
    with pytest.raises(ValueError):
        dse.expand_sweep(spec)


def test_expand_sweep_unknown_var_rejected():
    spec = {"axes": [{"var": "TOTALLY_FAKE_VAR_XYZ", "values": [1, 2]}]}
    # Only enforced when librelane is importable; if names empty it's a skip.
    if dse._known_var_names():
        with pytest.raises(ValueError):
            dse.expand_sweep(spec)


def test_expand_sweep_combo_cap():
    # 5 axes * many values -> exceeds MAX_COMBOS.
    axes = [{"var": "FP_CORE_UTIL", "values": list(range(10))}]
    axes += [{"var": "PL_TARGET_DENSITY_PCT", "values": list(range(10))}]
    spec = {"axes": axes, "mode": "grid"}
    # If var validation kicks in these are real vars; 10x10=100 > 64.
    with pytest.raises(ValueError):
        dse.expand_sweep(spec)


def test_dse_run_tags_deterministic_unique():
    tags = dse.dse_run_tags("spm", 3)
    assert tags == ["dse-spm-00", "dse-spm-01", "dse-spm-02"]
    assert len(set(tags)) == 3


def test_dse_bool_formatting():
    spec = {"axes": [{"var": "RUN_LVS", "values": [True, False]}]}
    if dse._known_var_names() and "RUN_LVS" not in dse._known_var_names():
        pytest.skip("RUN_LVS not in this librelane")
    combos = dse.expand_sweep(spec)
    assert combos == [{"RUN_LVS": "true"}, {"RUN_LVS": "false"}]


def test_assemble_overrides_cleans_and_carries_context(tmp_path):
    # A2: the shared assembler must clean blanks (keeping real 0/False), pull PDK/
    # SCL out as kwargs, and carry the picker sources/extras through — for BOTH
    # the Setup path and the DSE sweep path (they call the same helper).
    from lanex.server import routes

    body = {
        "overrides": {"A": "1", "BLANK": "", "SPACE": "   ",
                      "ZERO": 0, "FALSE": False, "PDK": "sky130A",
                      "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
        "sources": ["src/spm.v"],
        "extras": [],
    }
    asm = routes._assemble_overrides(str(tmp_path), body)
    assert asm["pdk"] == "sky130A"
    assert asm["scl"] == "sky130_fd_sc_hd"
    # blank/whitespace dropped; real falsy values preserved; PDK/SCL pulled out.
    assert asm["overrides"] == {"A": "1", "ZERO": 0, "FALSE": False}
    assert asm["extra_sources"] == ["src/spm.v"]
    assert asm["extra_extras"] is None            # [] normalises to None
    assert asm["extra_config_files"] is None      # no macro overlay in a bare dir


def test_assemble_overrides_takes_pdk_from_config_when_request_names_none(tmp_path):
    # LibreLane's CLI mounts the ciel version of the family -p names (default
    # sky130A); a gf180 config run without -p fails "The PDK gf180mcuD was not
    # found". A request without a PDK must carry the config's PDK and library.
    from lanex.server import routes
    (tmp_path / "config.json").write_text(
        '{"DESIGN_NAME": "fifo", "PDK": "gf180mcuD", '
        '"STD_CELL_LIBRARY": "gf180mcu_fd_sc_mcu7t5v0"}', encoding="utf-8")
    asm = routes._assemble_overrides(str(tmp_path), {"overrides": {}})
    assert asm["pdk"] == "gf180mcuD"
    assert asm["scl"] == "gf180mcu_fd_sc_mcu7t5v0"
    # An explicit request wins; the config's library is not paired with another PDK.
    asm = routes._assemble_overrides(str(tmp_path), {"pdk": "ihp-sg13g2"})
    assert asm["pdk"] == "ihp-sg13g2" and asm["scl"] is None


def test_dse_and_setup_assemble_identically(tmp_path):
    # A2 regression guard (the audit's "golden-equality between the two entry
    # points"): given the same merged overrides + sources, a DSE sweep point and
    # a Setup run must produce byte-identical assembled kwargs.
    from lanex.server import routes

    setup_body = {"overrides": {"FP_CORE_UTIL": "50", "PDK": "sky130A"},
                  "sources": ["src/spm.v"], "extras": ["macro.v"]}
    # DSE builds: synthetic["overrides"] = {**base_overrides, **swept_point}
    base_overrides = {"PDK": "sky130A"}
    swept_point = {"FP_CORE_UTIL": "50"}
    dse_body = {"overrides": {**base_overrides, **swept_point},
                "sources": ["src/spm.v"], "extras": ["macro.v"]}
    a = routes._assemble_overrides(str(tmp_path), setup_body)
    b = routes._assemble_overrides(str(tmp_path), dse_body)
    assert a == b


def test_reverify_validate_rejects_unknown_step():
    res = reverify.validate("Totally.Fake.Step", {})
    if reverify._known_step_ids():
        assert res["ok"] is False


# --- Verify's "Re-run step": a new run resumed from the finished one ----------

def _finished(tmp_path, *, overrides=None, cfg="DESIGN_NAME: spm\nCLOCK_PERIOD: 10\nFP_CORE_UTIL: 45\n", toolchain=None):
    """A design with a finished Classic run "done" (every step saved its
    state), made with *overrides* for that run only."""
    import json
    from lanex.controller import introspect
    steps = [s["id"] for s in introspect.flow_steps("Classic")]
    d = tmp_path / "proj"
    (d / "runs" / "done").mkdir(parents=True)
    (d / "config.yaml").write_text(cfg)
    run = d / "runs" / "done"
    log = []
    for i, sid in enumerate(steps):
        sd = run / f"{i + 1:02d}-{sid.lower().replace('.', '-')}"
        sd.mkdir()
        (sd / "state_in.json").write_text("{}")
        (sd / "state_out.json").write_text(json.dumps({"metrics": {}}))
        log.append(f"Running '{sid}' at 'runs/done/{sd.name}'…")
    (run / "flow.log").write_text("\n".join(log) + "\n")
    (run / "final").mkdir()
    (run / "resolved.json").write_text(json.dumps({"DESIGN_NAME": "spm", "PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd",
                                                   "CLOCK_PERIOD": 10, "FP_CORE_UTIL": 45, "meta": {"flow": None}}))
    gui = {"flow": "Classic", "pdk": "sky130A", "scl": "sky130_fd_sc_hd", "overrides": overrides or {}}
    if toolchain:
        gui["toolchain"] = toolchain
    (run / "gui-run.json").write_text(json.dumps(gui))
    return d, steps


def test_rerun_is_a_new_run_on_the_old_runs_last_state(tmp_path):
    pytest.importorskip("librelane")
    d, steps = _finished(tmp_path, overrides={"PL_TARGET_DENSITY_PCT": "60"})
    p = reverify.plan_rerun(d, "done", "Magic.DRC")
    assert p["ok"] and p["tag"] != "done"
    last = f"{len(steps):02d}-{steps[-1].lower().replace('.', '-')}"
    assert p["state"] == "runs/done/" + last + "/state_out.json"
    # The run's own settings ride along; the flow and PDK are the run's.
    assert p["overrides"] == {"PL_TARGET_DENSITY_PCT": "60"}
    assert p["parent"] == {"tag": "done", "flow": "Classic", "pdk": "sky130A", "scl": "sky130_fd_sc_hd"}
    assert p["branched_from"]["step"] == "Magic.DRC" and p["branched_from"]["rerun"] is True


def test_rerun_pins_what_the_config_changed_since_and_types_the_changes(tmp_path):
    pytest.importorskip("librelane")
    d, _steps = _finished(tmp_path)
    (d / "config.yaml").write_text("DESIGN_NAME: spm\nCLOCK_PERIOD: 7\nFP_CORE_UTIL: 45\n")
    # A list value stays one value (it used to be split on commas).
    p = reverify.plan_rerun(d, "done", "OpenROAD.STAPostPNR", {"DIE_AREA": "0, 0, 100, 100", "CLOCK_PERIOD": "8"})
    assert p["overrides"]["DIE_AREA"] == "0 0 100 100"
    assert p["overrides"]["CLOCK_PERIOD"] == "8"
    p2 = reverify.plan_rerun(d, "done", "OpenROAD.STAPostPNR")
    assert p2["overrides"]["CLOCK_PERIOD"] == "10", "the run's own value, not the config's new 7"
    assert [x["var"] for x in p2["pinned"]] == ["CLOCK_PERIOD"]
    with pytest.raises(reverify.RerunError, match="takes a number"):
        reverify.plan_rerun(d, "done", "OpenROAD.STAPostPNR", {"CLOCK_PERIOD": "fast"})
    with pytest.raises(reverify.RerunError, match="isn't a step"):
        reverify.plan_rerun(d, "done", "Not.AStep")


def test_rerun_refuses_a_run_made_with_another_librelane(tmp_path, monkeypatch):
    pytest.importorskip("librelane")
    from lanex.controller import branch
    d, _steps = _finished(tmp_path, toolchain={"librelane_version": "3.0.3", "run_mode": "local"})
    monkeypatch.setattr(branch, "versions_now", lambda: {"librelane": "3.0.4", "image": None})
    monkeypatch.setattr(branch, "_pdk_pin", lambda pdk: None)
    p = reverify.plan_rerun(d, "done", "Magic.DRC")
    assert not p["ok"] and "LibreLane 3.0.3 then, 3.0.4 now" in p["blocked"]


def test_rerun_route_names_the_new_run_as_the_dialog_said(tmp_path, monkeypatch):
    """Verify's dialog shows the dry run's name; the started run must get it
    (it used to get a newer timestamp, so the run named in the dialog never
    appeared)."""
    pytest.importorskip("librelane")
    from lanex.controller import branch
    from lanex.server import app as server_app
    from lanex.server import routes
    d, _steps = _finished(tmp_path)
    monkeypatch.setattr(branch, "versions_now", lambda: {"librelane": None, "image": None})
    monkeypatch.setattr(branch, "_pdk_pin", lambda pdk: None)
    monkeypatch.setattr(routes, "_get_active_design_dir", lambda: str(d))
    monkeypatch.setattr(routes, "_design_refusal", lambda h, dd: None)
    monkeypatch.setattr(routes, "_resolve_run_dir", lambda tag: d / "runs" / tag)
    monkeypatch.setattr(server_app, "get_runner", lambda: type("R", (), {"running": False})())
    started = {}
    monkeypatch.setattr(routes, "_start_run", lambda body, **kw: (started.update(body=body) or {"ok": True}, 200))
    out = {}
    monkeypatch.setattr(routes, "_respond", lambda h, body, status=200: out.update(body=body, status=status))

    class H:
        _body = {"step_id": "Magic.DRC", "run_tag": "done", "new_tag": "glui-20261122-194109"}

    routes.h_verify_rerun(H())
    assert out["status"] == 200, out
    assert out["body"]["tag"] == "glui-20261122-194109"
    assert started["body"]["tag"] == "glui-20261122-194109"

    # A name with a path in it is refused before anything is planned.
    H._body = dict(H._body, new_tag="../escape")
    routes.h_verify_rerun(H())
    assert out["status"] == 400
    # A name already taken is refused in words (the page then asks without one).
    (d / "runs" / "taken").mkdir()
    H._body = dict(H._body, new_tag="taken")
    routes.h_verify_rerun(H())
    assert out["status"] == 400 and "exists already" in str(out["body"])
