"""One settings model (audit 2026-11-15, plan 1a/1d): a value that lives in a
``pdk::``/``scl::`` section is edited where it takes effect, the source list
keeps its globs, a new project's top module is always a valid identifier, and
a one-click fix is saved to the config by default."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from lanex.controller import configedit, scaffold
from lanex.controller.configedit import ConfigEditError

# LibreLane's own SPM example (librelane/examples/spm/config.yaml), as LanEx
# ships it: the clock lives in the pdk::sky130* section.
SPM_YAML = """\
# Basics
DESIGN_NAME: spm
VERILOG_FILES: dir::src/*.v
CLOCK_PERIOD: 10
CLOCK_PORT: clk

# Technology-Specific Configs
pdk::sky130*:
  FP_CORE_UTIL: 45
  CLOCK_PERIOD: 10.0
  scl::sky130_fd_sc_hs:
    CLOCK_PERIOD: 8
  scl::sky130_fd_sc_ls:
    MAX_FANOUT_CONSTRAINT: 5
pdk::gf180mcu*:
  CLOCK_PERIOD: 24.0
  FP_CORE_UTIL: 38
"""


def _design(tmp_path: Path, name: str = "config.yaml", text: str = SPM_YAML) -> Path:
    d = tmp_path / "spm"
    (d / "src").mkdir(parents=True)
    (d / "src" / "spm.v").write_text("module spm(input clk); endmodule\n")
    (d / "src" / "alu.v").write_text("module alu(input a); endmodule\n")
    (d / name).write_bytes(text.encode("utf-8"))
    return d


def _data(d: Path, name: str = "config.yaml"):
    return configedit.read_config(d)["data"]


# ------------------------------------------------------------------ where a value takes effect

def test_effective_value_is_the_most_specific_section_that_applies():
    data = yaml.safe_load(SPM_YAML)
    e = configedit.effective_entry(data, "CLOCK_PERIOD", "sky130A", "sky130_fd_sc_hd")
    assert e["value"] == 10.0 and e["scope"] == ["pdk::sky130*"]
    e = configedit.effective_entry(data, "CLOCK_PERIOD", "sky130A", "sky130_fd_sc_hs")
    assert e["value"] == 8 and e["scope"] == ["pdk::sky130*", "scl::sky130_fd_sc_hs"]
    e = configedit.effective_entry(data, "CLOCK_PERIOD", "ihp-sg13g2", "sg13g2_stdcell")
    assert e["value"] == 10 and e["scope"] is None
    assert configedit.effective_entry(data, "MAX_FANOUT_CONSTRAINT", "sky130A", "sky130_fd_sc_hd") is None
    allv = configedit.effective_values(data, "gf180mcuD", "gf180mcu_fd_sc_mcu7t5v0")
    assert allv["FP_CORE_UTIL"]["value"] == 38 and allv["CLOCK_PERIOD"]["value"] == 24.0
    assert "MAX_FANOUT_CONSTRAINT" not in allv


def test_editing_the_section_changes_one_line_and_the_effective_value(tmp_path):
    d = _design(tmp_path)
    res = configedit.set_keys(d, {"CLOCK_PERIOD": 12.5}, scope=["pdk::sky130*"])
    new = (d / "config.yaml").read_text()
    assert [(x["op"], x["text"]) for x in res["diff"]] == [("-", "  CLOCK_PERIOD: 10.0"), ("+", "  CLOCK_PERIOD: 12.5")]
    data = yaml.safe_load(new)
    assert configedit.effective_entry(data, "CLOCK_PERIOD", "sky130A", "sky130_fd_sc_hd")["value"] == 12.5
    assert data["CLOCK_PERIOD"] == 10 and data["pdk::gf180mcu*"]["CLOCK_PERIOD"] == 24.0


def test_every_pdk_writes_the_top_level_and_clears_the_sections(tmp_path):
    d = _design(tmp_path)
    res = configedit.set_keys(d, {"CLOCK_PERIOD": 12}, unscope=True)
    data = yaml.safe_load((d / "config.yaml").read_text())
    assert data["CLOCK_PERIOD"] == 12
    for pdk, scl in (("sky130A", "sky130_fd_sc_hd"), ("sky130A", "sky130_fd_sc_hs"), ("gf180mcuD", "x")):
        assert configedit.effective_entry(data, "CLOCK_PERIOD", pdk, scl) == {"value": 12, "scope": None, "label": "top level"}
    # The hs section held only the clock, so it is gone; everything else stays.
    assert "scl::sky130_fd_sc_hs" not in data["pdk::sky130*"]
    assert data["pdk::sky130*"] == {"FP_CORE_UTIL": 45, "scl::sky130_fd_sc_ls": {"MAX_FANOUT_CONSTRAINT": 5}}
    assert data["pdk::gf180mcu*"] == {"FP_CORE_UTIL": 38}
    assert sorted(res["unscoped"]) == ["pdk::gf180mcu*", "pdk::sky130*", "pdk::sky130* / scl::sky130_fd_sc_hs"]
    # Comments stay where they were.
    assert "# Technology-Specific Configs" in (d / "config.yaml").read_text()


def test_removing_the_last_key_of_a_section_removes_the_section(tmp_path):
    d = _design(tmp_path)
    configedit.set_keys(d, {}, ["CLOCK_PERIOD"], scope=["pdk::sky130*", "scl::sky130_fd_sc_hs"])
    data = yaml.safe_load((d / "config.yaml").read_text())
    assert "scl::sky130_fd_sc_hs" not in data["pdk::sky130*"]
    assert data["pdk::sky130*"]["CLOCK_PERIOD"] == 10.0


def test_emptying_a_parent_section_removes_it_too(tmp_path):
    text = "DESIGN_NAME: t\npdk::sky130*:\n  scl::sky130_fd_sc_hs:\n    CLOCK_PERIOD: 8\nCLOCK_PORT: clk\n"
    d = _design(tmp_path, text=text)
    configedit.set_keys(d, {"CLOCK_PERIOD": 9}, unscope=True)
    assert yaml.safe_load((d / "config.yaml").read_text()) == {"DESIGN_NAME": "t", "CLOCK_PORT": "clk", "CLOCK_PERIOD": 9}


def test_every_pdk_works_on_json_configs(tmp_path):
    cfg = {"DESIGN_NAME": "t", "CLOCK_PERIOD": 10, "pdk::sky130*": {"CLOCK_PERIOD": 15, "FP_CORE_UTIL": 40}}
    d = _design(tmp_path, "config.json", json.dumps(cfg, indent=4) + "\n")
    configedit.set_keys(d, {"CLOCK_PERIOD": 20}, unscope=True)
    got = json.loads((d / "config.json").read_text())
    assert got == {"DESIGN_NAME": "t", "CLOCK_PERIOD": 20, "pdk::sky130*": {"FP_CORE_UTIL": 40}}


def test_scope_and_every_pdk_together_are_refused(tmp_path):
    d = _design(tmp_path)
    before = (d / "config.yaml").read_text()
    with pytest.raises(ConfigEditError):
        configedit.set_keys(d, {"CLOCK_PERIOD": 9}, scope=["pdk::sky130*"], unscope=True)
    assert (d / "config.yaml").read_text() == before


def test_dry_run_writes_nothing(tmp_path):
    d = _design(tmp_path)
    before = (d / "config.yaml").read_text()
    res = configedit.set_keys(d, {"CLOCK_PERIOD": 9}, unscope=True, dry_run=True)
    assert res["changed"] == ["CLOCK_PERIOD"] and res["diff"]
    assert (d / "config.yaml").read_text() == before


# ------------------------------------------------------------------ the route

def test_config_set_route_reads_scope_and_all_pdks(tmp_path, monkeypatch):
    from lanex.server import routes

    d = _design(tmp_path)
    out = {}

    class H:
        _body = {"set": {"CLOCK_PERIOD": 11}, "scope": ["pdk::sky130*"], "pdk": "sky130A", "scl": "sky130_fd_sc_hd"}

    monkeypatch.setattr(routes, "_design_dir_or_400", lambda h: str(d))
    monkeypatch.setattr(routes, "_refuse_while_running", lambda h: False)
    monkeypatch.setattr(routes, "_respond", lambda h, body, status=200: out.update(body=body, status=status))
    routes.h_config_set(H())
    assert out["status"] == 200
    assert out["body"]["effective"]["CLOCK_PERIOD"] == {"value": 11, "scope": ["pdk::sky130*"], "label": "pdk::sky130* section"}
    assert yaml.safe_load((d / "config.yaml").read_text())["pdk::sky130*"]["CLOCK_PERIOD"] == 11

    H._body = {"set": {"CLOCK_PERIOD": 13}, "all_pdks": True, "pdk": "sky130A", "scl": "sky130_fd_sc_hd"}
    routes.h_config_set(H())
    assert out["body"]["effective"]["CLOCK_PERIOD"]["scope"] is None
    assert configedit.effective_entry(_data(d), "CLOCK_PERIOD", "gf180mcuD", None)["value"] == 13

    H._body = {"set": {"CLOCK_PERIOD": 13}, "scope": "pdk::sky130*"}
    routes.h_config_set(H())
    assert out["status"] == 400


def test_design_info_effective_mode(tmp_path, monkeypatch):
    from lanex.server import routes
    d = _design(tmp_path)
    out = {}

    class H:
        _body = {"effective": True, "pdk": "sky130A", "scl": "sky130_fd_sc_hs"}

    monkeypatch.setattr(routes, "_design_dir_or_400", lambda h: str(d))
    monkeypatch.setattr(routes, "_respond", lambda h, body, status=200: out.update(body=body, status=status))
    routes.h_design_info(H())
    eff = out["body"]["effective"]
    assert eff["CLOCK_PERIOD"]["value"] == 8 and eff["FP_CORE_UTIL"]["value"] == 45
    assert out["body"]["config"]["name"] == "config.yaml"


# ------------------------------------------------------------------ sources

def test_unticking_under_a_glob_says_it_had_to_be_written_out(tmp_path):
    d = _design(tmp_path)
    before = (d / "config.yaml").read_text()
    res = configedit.set_sources(d, [str(d / "src" / "spm.v")], dry_run=True)
    assert res["expanded"] == ["dir::src/*.v"] and not res["kept_glob"]
    assert (d / "config.yaml").read_text() == before
    configedit.set_sources(d, [str(d / "src" / "spm.v")])
    assert yaml.safe_load((d / "config.yaml").read_text())["VERILOG_FILES"] == ["dir::src/spm.v"]


def test_a_file_outside_the_glob_is_added_and_the_glob_stays(tmp_path):
    d = _design(tmp_path)
    (d / "rtl").mkdir()
    (d / "rtl" / "extra.v").write_text("module extra; endmodule\n")
    files = [str(d / "src" / "spm.v"), str(d / "src" / "alu.v"), str(d / "rtl" / "extra.v")]
    res = configedit.set_sources(d, files)
    assert res["expanded"] == [] and res["kept_glob"]
    assert yaml.safe_load((d / "config.yaml").read_text())["VERILOG_FILES"] == ["dir::src/*.v", "dir::rtl/extra.v"]
    # A new file in src/ is still picked up by the glob.
    (d / "src" / "new.v").write_text("module n; endmodule\n")
    r = configedit.resolve_sources(d, _data(d))
    assert str((d / "src" / "new.v").resolve()) in r["files"]


def test_an_empty_source_list_is_refused(tmp_path):
    d = _design(tmp_path)
    before = (d / "config.yaml").read_text()
    with pytest.raises(ConfigEditError, match="at least one design file"):
        configedit.set_sources(d, [])
    assert (d / "config.yaml").read_text() == before


def test_plan_sources_keeps_plain_entries_and_drops_the_one_that_goes(tmp_path):
    d = _design(tmp_path)
    p = configedit.plan_sources(d, ["dir::src/spm.v", "dir::src/alu.v"], [str(d / "src" / "spm.v")])
    assert p == {"entries": ["dir::src/spm.v"], "expanded": []}


def test_a_deleted_file_leaves_an_explicit_list(tmp_path):
    text = SPM_YAML.replace("VERILOG_FILES: dir::src/*.v", "VERILOG_FILES:\n  - dir::src/spm.v\n  - dir::src/alu.v")
    d = _design(tmp_path, text=text)
    (d / "src" / "alu.v").unlink()
    res = configedit.follow_delete(d, str(d / "src" / "alu.v"))
    assert res["changed"] == ["VERILOG_FILES"]
    assert yaml.safe_load((d / "config.yaml").read_text())["VERILOG_FILES"] == ["dir::src/spm.v"]
    # The last file is never taken out: an empty list can't build.
    (d / "src" / "spm.v").unlink()
    res = configedit.follow_delete(d, str(d / "src" / "spm.v"))
    assert res["changed"] == [] and res["last"]


def test_a_glob_needs_no_follow_on_delete(tmp_path):
    d = _design(tmp_path)
    (d / "src" / "alu.v").unlink()
    assert configedit.follow_delete(d, str(d / "src" / "alu.v"))["changed"] == []


# ------------------------------------------------------------------ new projects

@pytest.mark.parametrize("raw, want", [
    ("my chip", "my_chip"), ("1top", "top_1top"), ("counter", "counter"), ("  a--b ", "a_b"),
    ("module", "module_top"), ("", "top"), ("über", "ber"),
])
def test_top_names_become_valid_verilog_identifiers(raw, want):
    assert scaffold.verilog_identifier(raw) == want


def test_a_blank_project_with_a_spaced_top_name_builds(tmp_path):
    res = scaffold.create_project(str(tmp_path / "p"), "empty", top="my chip", pdk="sky130A")
    assert res["ok"], res
    assert res["top"] == "my_chip"
    cfg = json.loads((tmp_path / "p" / "config.json").read_text())
    assert cfg["DESIGN_NAME"] == "my_chip"
    src = (tmp_path / "p" / "src" / "my_chip.v").read_text()
    assert "module my_chip" in src


def test_a_used_folder_gets_plain_words_and_a_free_name(tmp_path):
    first = scaffold.create_project(str(tmp_path / "blinky"), "blinky", top="blinky", pdk="sky130A")
    assert first["ok"]
    again = scaffold.create_project(str(tmp_path / "blinky"), "blinky", top="blinky", pdk="sky130A")
    assert not again["ok"] and "not empty" in again["error"] and "blinky-2" in again["error"]
    assert again["suggest"] == "blinky-2"
    assert scaffold.free_folder(tmp_path / "blinky").name == "blinky-2"
    assert scaffold.free_folder(tmp_path / "fresh").name == "fresh"


def test_a_clock_of_zero_is_refused(tmp_path):
    res = scaffold.create_project(str(tmp_path / "z"), "empty", top="t", pdk="sky130A", clock_period=0)
    assert not res["ok"] and "positive" in res["error"]
    assert not (tmp_path / "z").exists()


def test_project_new_route_refuses_a_bad_clock(tmp_path, monkeypatch):
    from lanex.server import routes
    out = {}

    class H:
        _body = {"dest_dir": str(tmp_path / "x"), "template": "empty", "clock_period": "-5"}

    monkeypatch.setattr(routes, "_respond", lambda h, body, status=200: out.update(body=body, status=status))
    routes.h_project_new(H())
    assert out["status"] == 400 and "positive" in out["body"]
    H._body = dict(H._body, clock_period="abc")
    routes.h_project_new(H())
    assert out["status"] == 400
    assert not (tmp_path / "x").exists()


# ------------------------------------------------------------------ one-click fixes

def test_a_fix_goes_to_the_config_even_when_the_run_had_one_off_settings(tmp_path):
    pytest.importorskip("librelane")
    from test_fixloop import _design as fl_design, _run as fl_run
    from lanex.controller import branch
    d = fl_design(tmp_path)
    # The old run had an unrelated one-off setting (All settings): before, every
    # fix of that run defaulted to "this run only" and the next Run lost it.
    fl_run(d, "try1", 28, stopped=28, overrides={"SYNTH_STRATEGY": "AREA 2"})
    p = branch.plan(d, "try1", {"FP_CORE_UTIL": "35"})
    c = p["changes"][0]
    assert c["save"] == "config" and c["scope"] == ["pdk::sky130*"]
    assert p["overrides"] == {"SYNTH_STRATEGY": "AREA 2"}
    # A value the old run set for itself still stays that way by default.
    fl_run(d, "try2", 28, stopped=28, overrides={"FP_CORE_UTIL": "30"}, resolved={"FP_CORE_UTIL": 30})
    assert branch.plan(d, "try2", {"FP_CORE_UTIL": "35"})["changes"][0]["save"] == "run"
