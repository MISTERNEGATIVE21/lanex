# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Every template's testbench checks its design and passes, under the
simulators the RTL IDE uses (Icarus and Verilator, built with LanEx's own
command lines), and fails loudly when the design is wrong (audit 4e)."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from lanex.controller import lint, scaffold, simulate

TEMPLATES = [t["name"] for t in scaffold.list_templates() if t.get("has_testbench")]


def _have(*tools: str) -> bool:
    return all(shutil.which(t) for t in tools)


ENGINES = [
    pytest.param("iverilog", marks=pytest.mark.skipif(not _have("iverilog", "vvp"), reason="Icarus not installed")),
    pytest.param("verilator", marks=pytest.mark.skipif(not _have("verilator", "make", "g++"), reason="Verilator not installed")),
]


def _make(tmp_path: Path, name: str) -> Path:
    res = scaffold.create_project(tmp_path / name, name, top="", pdk="sky130A", scl="sky130_fd_sc_hd")
    if not res.get("ok"):
        pytest.skip(res.get("error"))
    return Path(res["design_dir"])


def _simulate(d: Path, tb: str, engine: str):
    ci = lint.config_inputs(d)
    assert ci["mode"] == "list" and ci["files"], ci
    m = lint.merge_inputs(ci, exclude=[tb])
    top = simulate.top_module_of(d, tb)
    argv = simulate.build_sim_command(d, top=top, sources=m["sources"], testbench=tb,
                                      defines=m["defines"], include_dirs=m["include_dirs"],
                                      run_mode="local", sim_engine=engine)
    p = subprocess.run(argv, cwd=d, capture_output=True, text=True, timeout=600)
    return p.returncode, p.stdout + p.stderr


def test_every_example_has_a_bench():
    assert set(TEMPLATES) >= {"blinky", "counter", "fifo", "multiplier", "spm"}


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("name", TEMPLATES)
def test_template_bench_passes(tmp_path: Path, name: str, engine: str):
    d = _make(tmp_path, name)
    tb = next(iter(sorted(p.relative_to(d).as_posix() for p in (d / "verify").glob("*_tb.v"))))
    rc, out = _simulate(d, tb, engine)
    assert rc == 0, out[-3000:]
    assert re.search(r"^PASS\b", out, re.M), out[-3000:]
    assert not re.search(r"\bFAIL\b", out), out[-3000:]
    # Verilator: one timescale for every file, so no TIMESCALEMOD.
    assert "TIMESCALEMOD" not in out, out[-3000:]


# A design that is wrong makes its bench say FAIL and exit non-zero.
BREAK = {
    "counter": ("src/counter.v", "count <= count + 1'b1;", "count <= count + 2'd2;"),
    "multiplier": ("src/mult.v", "p <= a * b;", "p <= a * b + 1'b1;"),
    "fifo": ("src/fifo.v", "dout <= mem[rptr];", "dout <= ~mem[rptr];"),
    "blinky": ("src/blinky.v", "assign led = ctr[WIDTH-1];", "assign led = ctr[0];"),
}


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("name", sorted(BREAK))
def test_template_bench_catches_a_wrong_design(tmp_path: Path, name: str, engine: str):
    d = _make(tmp_path, name)
    rel, old, new = BREAK[name]
    src = (d / rel).read_text()
    assert old in src
    (d / rel).write_text(src.replace(old, new))
    tb = next(iter(sorted(p.relative_to(d).as_posix() for p in (d / "verify").glob("*_tb.v"))))
    rc, out = _simulate(d, tb, engine)
    assert rc != 0, out[-3000:]
    assert re.search(r"\bFAIL\b", out), out[-3000:]
    assert not re.search(r"^PASS\b", out, re.M), out[-3000:]


def test_benches_drive_inputs_away_from_the_sampling_edge():
    """The races the audit found: inputs set with blocking assignments right
    after @(posedge clk). The benches now change inputs on the falling edge."""
    root = Path(scaffold.__file__).resolve().parent / "templates"
    for tb in root.glob("*/verify/*_tb.v"):
        text = tb.read_text()
        assert not re.search(r"@\(posedge clk\);\s*\w+\s*=", text), tb


def test_spm_project_gets_the_self_checking_bench(tmp_path: Path):
    d = _make(tmp_path, "spm")
    text = (d / "verify" / "spm_tb.v").read_text()
    assert "PASS: spm" in text and "$fatal" in text
