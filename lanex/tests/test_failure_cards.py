"""Failure cards for the errors users hit most, each on the text LibreLane
3.0.4 really printed.

``goldens/failures/librelane-3.0.4.json`` holds, per case, what a forced
failure on a scratch copy of LibreLane's spm example left behind (made with
LibreLane 3.0.4 in its own container image, 2026-11-22): the step folders, the
stopped step's log tail, error.log, warning.log's codes and the config. Each
test rebuilds that run folder and reads the card Flow would show."""

import json
from pathlib import Path

import pytest

from lanex.controller import problems, runexplain

FIX = json.loads((Path(__file__).parent / "goldens" / "failures" / "librelane-3.0.4.json").read_text(encoding="utf-8"))["cases"]


def _run(tmp: Path, case: str, *, cfg_extra=None, outcome=None) -> Path:
    rec = FIX[case]
    run = tmp / "proj" / "runs" / case
    run.mkdir(parents=True)
    for d in rec["steps"]:
        sd = run / d
        sd.mkdir()
        (sd / "state_in.json").write_text("{}")
        if d != rec["stopped"]:
            (sd / "state_out.json").write_text(json.dumps({"metrics": {}}))
        else:
            if rec.get("step_log_name") and rec.get("step_log_tail"):
                (sd / rec["step_log_name"]).write_text("\n".join(rec["step_log_tail"]) + "\n", encoding="utf-8")
            if rec.get("process_stats"):
                (sd / (d.split("-", 1)[1] + ".process_stats.json")).write_text(json.dumps(rec["process_stats"]))
    if rec.get("lint_log_tail"):
        (run / "01-verilator-lint" / "verilator-lint.log").write_text("\n".join(rec["lint_log_tail"]) + "\n", encoding="utf-8")
    if rec["final"]:
        (run / "final").mkdir()
    cfg = dict(rec["cfg"], DESIGN_DIR=rec["design_dir"], **(cfg_extra or {}))
    (run / "resolved.json").write_text(json.dumps(cfg))
    (run / "error.log").write_text(rec["error_log"] or "", encoding="utf-8")
    (run / "warning.log").write_text("\n".join(rec.get("warnings", {}).values()) + "\n", encoding="utf-8")
    if outcome:
        (run / "gui-run.json").write_text(json.dumps({"outcome": {"result": "error", "error": outcome}}))
    return run


def _card(tmp, case, **kw):
    rx = runexplain.explain_run(_run(tmp, case, **kw))
    assert rx["kind"] == "halted", rx["kind"]
    return rx, rx["card"]


def _sets(card):
    return {f["var"]: f for f in card["fixes"] if f["kind"] == "setting"}


@pytest.fixture(autouse=True)
def _known_vars(monkeypatch):
    # finish() keeps only settings this LibreLane knows: the real list when
    # librelane is importable, else every name passes.
    from lanex.controller import introspect
    names = introspect.known_var_names() or set()
    if not names:
        monkeypatch.setattr(introspect, "known_var_names", lambda: set())


def test_every_case_in_the_fixture_is_covered():
    assert set(FIX) == {"verilator_syntax", "yosys_syntax", "verilator_top", "yosys_top", "clock_port", "no_clock",
                        "core_negative", "core_outside", "core_bigger", "pins", "pdn_small_die", "gpl_util", "dpl_cts",
                        "route_drc", "cts_buffer", "rsz_no_buffers", "oom_openroad", "oom_container", "disk_full",
                        "lvs_crash"}


def test_a_syntax_error_names_the_file_and_line_from_verilator(tmp_path):
    rx, c = _card(tmp_path, "verilator_syntax")
    assert c["kb"] == "verilog-error"
    assert c["title"] == "Syntax error in src/spm.v, line 67"
    assert "unexpected IDENTIFIER" in c["plain"] and "semicolon" in c["plain"]
    assert c["evidence"] == ["%Error: src/spm.v:67:13: syntax error, unexpected IDENTIFIER"]
    # The log link is Verilator's, not the checker's (which writes none).
    assert rx["at"]["step"] == "Verilator.Lint" and rx["at"]["line"] == 1
    assert c["fixes"][0]["go"] == {"tab": "ide", "rel": "src/spm.v", "line": 67}


def test_a_syntax_error_yosys_finds_reads_the_same(tmp_path):
    rx, c = _card(tmp_path, "yosys_syntax")
    assert c["title"] == "Syntax error in src/spm.v, line 67"
    assert c["plain"].startswith("Yosys stopped reading src/spm.v at line 67: syntax error, unexpected TOK_ID")
    # error.log wraps the line in LibreLane's "Subprocess had a non-zero exit": the card shows Yosys's own.
    assert c["evidence"] == ["src/spm.v:67: ERROR: syntax error, unexpected TOK_ID"]
    assert rx["at"]["path"] == "01-yosys-jsonheader/yosys-jsonheader.log"
    assert "syntax error" in rx["at"]["text"]


@pytest.mark.parametrize("case", ["verilator_top", "yosys_top"])
def test_a_wrong_top_module_offers_the_one_module_nobody_uses(tmp_path, case):
    src = tmp_path / "spm.v"
    src.write_text("module spm(input clk, input rst, input x, output y);\n  delayed_serial_adder dsa(.clk(clk));\n"
                   "endmodule\nmodule delayed_serial_adder(input clk);\nendmodule\n")
    rx, c = _card(tmp_path, case, cfg_extra={"VERILOG_FILES": [str(src)]})
    assert c["kb"] == "top-missing"
    assert c["title"] == "There is no module called spm_top"
    assert "spm, delayed_serial_adder" in c["plain"]
    f = _sets(c)["DESIGN_NAME"]
    assert (f["from"], f["to"]) == ("spm_top", "spm")


def test_a_missing_submodule_is_not_called_a_wrong_top(tmp_path):
    c = problems.explain_error("ERROR: Module `adder' not found!", {"DESIGN_NAME": "spm"})
    assert c.get("kb") != "top-missing"


def test_missing_source_files_and_empty_globs_are_told_apart():
    # LibreLane stops while loading the config (no run folder): these are the
    # words it printed, for the run-start check and the Flow page to use.
    a = problems.explain_error("Path provided for variable 'VERILOG_FILES[0]' is invalid: "
                               "'/work/missing/src/spm_core.v' does not exist", {"DESIGN_DIR": "/work/missing"})
    assert a["kb"] == "path-missing" and a["title"] == "A file in VERILOG_FILES is missing"
    assert "src/spm_core.v" in a["plain"]
    b = problems.explain_error("Path provided for variable 'VERILOG_FILES[0]' is invalid: "
                               "'/work/glob/rtl/*.v' does not exist", {"DESIGN_DIR": "/work/glob"})
    assert b["title"] == "No file matches rtl/*.v"


def test_too_many_pins_grows_a_fixed_die_to_the_perimeter_openroad_asks_for(tmp_path):
    _rx, c = _card(tmp_path, "pins")
    assert c["code"] == "PPL-0024" and c["title"] == "Too many pins for the die's edge"
    assert "602 pins" in c["plain"] and "room for 206" in c["plain"] and "819 µm" in c["plain"]
    f = _sets(c)["DIE_AREA"]
    # 818.72 um around -> about 205 um a side, with 5 % to spare -> 215.
    assert (f["from"], f["to"]) == ("0 0 60 60", "0 0 215 215")


def test_too_many_pins_on_a_relative_die_lowers_the_utilisation():
    c = problems.explain_error("[PPL-0024] Number of IO pins (602) exceeds maximum number of available positions (206). "
                               "Increase the die perimeter from 240.00um to 818.72um.",
                               {"FP_SIZING": "relative", "FP_CORE_UTIL": 50})
    f = _sets(c)["FP_CORE_UTIL"]
    assert f["from"] == "50" and 1 <= int(f["to"]) < 5


def test_a_die_smaller_than_its_margins(tmp_path):
    _rx, c = _card(tmp_path, "core_negative")
    assert c["code"] == "STA-0572" and c["kb"] == "ifp-margins"
    assert c["title"] == "The die is too small for its margins"
    s = _sets(c)
    assert s["DIE_AREA"]["to"] == "0 0 60 60" and s["FP_SIZING"]["to"] == "relative"


def test_a_core_area_with_its_corners_swapped(tmp_path):
    _rx, c = _card(tmp_path, "core_outside")
    assert c["code"] == "IFP-0002" and c["title"] == "The core is too small for a single cell"
    assert "5 × 5 µm" in c["plain"] and "CORE_AREA (10 10 5 5" in c["plain"]
    assert not _sets(c), "no setting is safe to guess for a CORE_AREA typo"


def test_a_core_area_bigger_than_the_die(tmp_path):
    _rx, c = _card(tmp_path, "core_bigger")
    assert c["code"] == "IFP-0055" and c["title"] == "The core is outside the die"


def test_pdn_0185_reads_the_numbers_and_grows_a_fixed_die(tmp_path):
    _rx, c = _card(tmp_path, "pdn_small_die")
    assert "10.7 µm" in c["plain"] and "8.16 µm" in c["plain"] and "met5" in c["plain"]
    s = _sets(c)
    assert s["DIE_AREA"]["to"] == "0 0 40 40" and s["FP_SIZING"]["to"] == "relative"


def test_pdn_0179_is_about_the_gaps_between_macros():
    c = problems.explain_error("[PDN-0179] Unable to repair all channels.", {})
    assert c["title"] == "The power grid can't get between the macros"
    assert all(f["kind"] == "open" for f in c["fixes"])


def test_detailed_placement_inside_cts_says_the_clock_tree_had_no_room(tmp_path):
    # The sweep point the audit flagged: the run's stage is cts (OpenROAD.CTS
    # raised), and the card now says it was the clock tree's legalisation.
    rx, c = _card(tmp_path, "dpl_cts")
    assert rx["stage"] == "cts" and rx["step"]["dir"] == "35-openroad-cts"
    assert c["code"] == "DPL-0036" and c["title"] == "No room for the clock tree's buffers"
    assert "2 cells (_138_, _150_)" in c["plain"]
    assert _sets(c)["FP_CORE_UTIL"]["to"] == "60"


def test_global_placement_out_of_room_still_reads_the_same(tmp_path):
    _rx, c = _card(tmp_path, "gpl_util")
    assert c["title"] == "Placement ran out of room" and "172 %" in c["plain"]


def test_a_clock_buffer_the_library_lacks_goes_back_to_the_pdks(tmp_path, monkeypatch):
    monkeypatch.setattr(problems, "_pdk_default", lambda cfg, var: {
        "CTS_CLK_BUFFERS": ["sky130_fd_sc_hd__clkbuf_8", "sky130_fd_sc_hd__clkbuf_4"],
        "CTS_ROOT_BUFFER": "sky130_fd_sc_hd__clkbuf_16"}[var])
    _rx, c = _card(tmp_path, "cts_buffer")
    assert c["code"] == "CTS-0127" and "sky130_fd_sc_hd__nosuchbuf_4" in c["plain"]
    s = _sets(c)
    assert s["CTS_ROOT_BUFFER"]["to"] == "sky130_fd_sc_hd__clkbuf_16"
    assert s["CTS_CLK_BUFFERS"]["to"] == "sky130_fd_sc_hd__clkbuf_8 sky130_fd_sc_hd__clkbuf_4"


def test_no_buffers_names_the_exclusion_list(tmp_path):
    _rx, c = _card(tmp_path, "rsz_no_buffers", cfg_extra={"PNR_EXCLUDED_CELL_FILE": "/work/nobuf.cells"})
    assert c["code"] == "RSZ-0022" and c["title"] == "Every buffer is excluded"
    assert "PNR_EXCLUDED_CELL_FILE" in c["plain"]


def test_an_lvs_crash_is_not_an_lvs_mismatch(tmp_path):
    rx, c = _card(tmp_path, "lvs_crash")
    assert c["kb"] == "lvs-crash" and c["title"] == "LVS didn't finish"
    # Netgen's Tcl error, found by the line before "while executing".
    assert c["evidence"] == ['wrong # args: should be "netgen::readnet ?format? file ?filenum?"']
    assert rx["at"]["line"] > 0


def test_a_tool_killed_for_memory_says_so_with_the_peak(tmp_path):
    _rx, c = _card(tmp_path, "oom_openroad")
    assert c["kb"] == "silent" and c["title"] == "The tool stopped without saying why"
    assert "260 MB" in c["plain"] and "memory" in c["plain"]
    # LanEx's runner records the container's exit code: 137 is the kernel's kill.
    _rx, c2 = _card(tmp_path / "b", "oom_container", outcome="exit code 137")
    assert c2["kb"] == "oom" and c2["title"] == "Out of memory: the system stopped the run"


def test_a_full_disk_is_told_from_memory(tmp_path, monkeypatch):
    monkeypatch.setattr(problems, "disk_free", lambda p: {"free": 0, "total": 4 << 20})
    _rx, c = _card(tmp_path, "disk_full")
    assert c["kb"] == "disk-full" and c["title"] == "The disk is full"
    assert "0 MB of 4 MB" in c["plain"]
    # The words themselves, as local mode records them (OSError from LibreLane).
    c2 = problems.explain_error("", {}, outcome="OSError: [Errno 28] No space left on device")
    assert c2["kb"] == "disk-full"


def test_container_engine_problems_are_told_apart():
    perm = problems.explain_error("permission denied while trying to connect to the docker API at unix:///var/run/docker.sock", {})
    assert perm["title"] == "This user can't use Docker" and "usermod -aG docker" in perm["plain"]
    pull = problems.explain_error("Failed to pull image 'ghcr.io/librelane/librelane:3.0.4' from the container registries.", {})
    assert pull["title"] == "Couldn't get the LibreLane image"
    down = problems.explain_error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", {})
    assert down["title"] == "The container engine isn't running"
    none = problems.explain_error("No compatible container engine found.", {})
    assert none["title"] == "No container engine is installed"


def test_anything_else_gets_the_generic_card_with_copy_for_help(tmp_path):
    run = _run(tmp_path, "gpl_util")
    (run / "error.log").write_text("[ERROR ANT-0099] something LanEx has never seen.\n")
    log = run / "28-openroad-globalplacement" / "openroad-globalplacement.log"
    log.write_text("line one\n[ERROR ANT-0099] something LanEx has never seen.\nError: x.tcl, 3 ANT-0099\n")
    rx = runexplain.explain_run(run)
    c = rx["card"]
    assert c["generic"] and c["title"] is None
    assert c["evidence"][0] == "[ERROR ANT-0099] something LanEx has never seen."
    assert "OpenROAD stopped the run at" in c["plain"]
    assert rx["at"]["line"] == 2
    h = c["help"]
    # (no flow.log here, so the step is named by its folder)
    assert "Stopped at step 28 28-openroad-globalplacement (placement)" in h
    assert "Error: [ERROR ANT-0099]" in h and "LibreLane" in h and "PDK sky130A" in h
    assert "Last lines of 28-openroad-globalplacement/openroad-globalplacement.log" in h


def test_every_halted_card_carries_help_text(tmp_path):
    _rx, c = _card(tmp_path, "pins")
    assert c["help"].startswith("LanEx run report: pins")
    assert "/work/pins/" not in c["help"], "paths are relative to the project"


def test_a_clock_port_that_isnt_there_is_a_problem_on_a_clean_run(tmp_path, monkeypatch):
    src = tmp_path / "spm.v"
    src.write_text("module spm(input clk, input rst, input x, output y);\nendmodule\n")
    run = _run(tmp_path, "clock_port", cfg_extra={"VERILOG_FILES": [str(src)]})
    rx = runexplain.explain_run(run)
    assert rx["kind"] == "clean"
    notes = {g["code"]: g.get("note") for g in rx["warnings"]["by_code"]}
    assert "CLOCK_PORT is 'clock'" in notes["STA-0366"] and notes["CTS-0083"]
    p = problems.clock_problems(run, {}, rx)[0]
    assert p["title"] == "The clock port 'clock' isn't in the design" and p["severity"] == "warn"
    f = [x for x in p["fixes"] if x["kind"] == "setting"][0]
    assert (f["var"], f["from"], f["to"]) == ("CLOCK_PORT", "clock", "clk")


def test_no_clock_port_at_all(tmp_path):
    src = tmp_path / "spm.v"
    src.write_text("module spm(input clk, input rst, input x, output y);\nendmodule\n")
    run = _run(tmp_path, "no_clock", cfg_extra={"VERILOG_FILES": [str(src)]})
    rx = runexplain.explain_run(run)
    p = problems.clock_problems(run, {}, rx)[0]
    assert p["title"] == "No clock is set, so nothing was timed against one"


def test_route_drc_after_one_router_pass_is_a_check_not_a_halt(tmp_path):
    rx = runexplain.explain_run(_run(tmp_path, "route_drc"))
    assert rx["kind"] == "checks-failed" and rx["card"] is None
