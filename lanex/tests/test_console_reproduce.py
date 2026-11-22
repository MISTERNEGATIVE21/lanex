"""Console drawer, Command tab: the reproduce record and script of a run
(manualcmd.reproduce_info / reproduce_script, /api/run-reproduce)."""
from __future__ import annotations

import json
from pathlib import Path

from lanex.controller import manualcmd

META = {
    "pdk": "sky130A", "scl": "sky130_fd_sc_hd", "run_mode": "container",
    "config_file": "/home/u/spm/config.yaml",
    "config_hash": "0540eeca6ee88a104e3ae2ed3c3416d1afdf693b518c609d6f1afd6c62464059",
    "branched_from": {"tag": "dse-spm-02", "step": "OpenROAD.Floorplan"},
    "cli_command": {
        "container": "librelane --pdk-root /home/u/.ciel --docker-no-tty --dockerized config.yaml -f Classic -p sky130A -s sky130_fd_sc_hd --run-tag r1",
        "local": "librelane --pdk-root /home/u/.ciel /home/u/spm/config.yaml -f Classic --run-tag r1",
        "recommended": "container", "cwd": "/home/u/spm",
    },
    "tag": "r1",
    "toolchain": {"librelane_version": "3.0.4", "lanex_version": "1.0.0",
                  "image": "ghcr.io/librelane/librelane:3.0.4@sha256:eab07a50"},
}
RESOLVED = {"PDK_ROOT": "/home/u/.ciel/ciel/sky130/versions/8afc8346a57fe1ab7934ba5a6056ea8b43078e71",
            "PDK": "sky130A", "meta": {"librelane_version": "3.0.4"}}


def test_reproduce_info_reads_only_what_the_run_recorded(tmp_path: Path):
    info = manualcmd.reproduce_info(META, RESOLVED, str(tmp_path / "r1"))
    # The rerun gets its own tag: LibreLane appends to an existing run folder.
    assert info["recorded_command"] == META["cli_command"]["container"]
    assert info["command"] == META["cli_command"]["container"].replace("--run-tag r1", "--run-tag r1-repro")
    assert info["repro_tag"] == "r1-repro"
    assert info["commands"]["local"].endswith("--run-tag r1-repro")
    assert info["cwd"] == "/home/u/spm"
    assert info["pdk_version"] == "8afc8346a57fe1ab7934ba5a6056ea8b43078e71"
    assert info["image"].endswith("@sha256:eab07a50")
    assert info["librelane_version"] == "3.0.4"
    assert info["resolved_config"].endswith("resolved.json")
    assert info["recorded"] is True


def test_reproduce_info_without_a_record_invents_nothing(tmp_path: Path):
    info = manualcmd.reproduce_info({}, None, str(tmp_path / "term-run"))
    assert info["recorded"] is False and info["command"] is None
    assert info["image"] is None and info["pdk_version"] is None and info["resolved_config"] is None
    assert "no recorded command" in manualcmd.reproduce_script(info)


def test_reproduce_script_pins_image_and_checks_config(tmp_path: Path):
    s = manualcmd.reproduce_script(manualcmd.reproduce_info(META, RESOLVED, str(tmp_path / "r1")))
    lines = [l for l in s.splitlines() if l and not l.startswith("#")]
    assert lines[0] == "set -euo pipefail"
    assert lines[1] == "PROJECT_DIR=${PROJECT_DIR:-/home/u/spm}"
    assert lines[2] == 'cd "$PROJECT_DIR"'
    # sha256sum on Linux, shasum on macOS (which has no sha256sum).
    assert "sha256sum config.yaml" in lines[3] and "shasum -a 256 config.yaml" in lines[3]
    assert lines[4].startswith('[ "$sum" = 0540eeca')
    assert lines[5] == "export LIBRELANE_IMAGE_OVERRIDE=ghcr.io/librelane/librelane:3.0.4@sha256:eab07a50"
    # The PDK store travels as PDK_ROOT, relative to whoever's home runs it.
    assert lines[6] == 'export PDK_ROOT=${PDK_ROOT:-"$HOME"/.ciel}'
    assert lines[7] == ("librelane --docker-no-tty --dockerized config.yaml -f Classic -p sky130A "
                        "-s sky130_fd_sc_hd --run-tag r1-repro")
    assert "--pdk-root" not in "\n".join(lines)
    assert "ciel enable --pdk-family sky130 8afc8346a57fe1ab7934ba5a6056ea8b43078e71" in s


THREADED = json.loads(json.dumps(META))
THREADED["cli_command"]["container"] += " -c DRT_THREADS=16 -c STA_THREADS=9 -c FP_CORE_UTIL=40"
THREADED["resources"] = {"values": {"DRT_THREADS": 16, "STA_THREADS": 9}, "reason": "32 cores, 45 GB free"}


def test_reproduce_script_threads_are_optional_and_capped(tmp_path: Path):
    s = manualcmd.reproduce_script(manualcmd.reproduce_info(THREADED, RESOLVED, str(tmp_path / "r1")))
    run = [l for l in s.splitlines() if l.startswith("librelane")][0]
    # The user's own -c stays in the command; the PC-sized thread counts move
    # to a list the script fills (capped to this machine, THREADS=auto drops them).
    assert "-c FP_CORE_UTIL=40" in run and "DRT_THREADS" not in run
    assert run.endswith(' ${threads[@]+"${threads[@]}"}')
    assert "for kv in DRT_THREADS=16 STA_THREADS=9; do" in s
    assert 'if [ "${THREADS:-recorded}" != auto ]; then' in s


def _stub_run(tmp_path: Path, script: str, env_extra: dict, tools: dict) -> str:
    """Run *script* with stub commands on PATH; returns what the stub librelane saw."""
    import os
    import shutil
    import subprocess
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    for name, body in tools.items():
        p = bin_dir / name
        p.write_text("#!/bin/bash\n" + body + "\n")
        p.chmod(0o755)
    keep = ["bash", "cut", "getconf", "cat", "dirname", "printf"]
    for t in keep:
        w = shutil.which(t)
        if w and not (bin_dir / t).exists():
            (bin_dir / t).symlink_to(w)
    env = {"PATH": str(bin_dir), "HOME": str(tmp_path / "home"), **env_extra}
    r = subprocess.run([shutil.which("bash"), "-c", script], capture_output=True, text=True, env=env, cwd=str(tmp_path))
    assert r.returncode == 0, r.stderr
    return r.stdout + "\nSTDERR:" + r.stderr


def test_reproduce_script_runs_on_a_mac_like_machine(tmp_path: Path):
    """No sha256sum (macOS), another user's home, fewer cores: the script still
    runs, checks the config with shasum, points PDK_ROOT at this home, and
    caps the threads."""
    import hashlib
    import shutil
    if not shutil.which("bash"):
        import pytest
        pytest.skip("no bash")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "config.yaml").write_text("DESIGN_NAME: spm\n")
    meta = json.loads(json.dumps(THREADED))
    meta["config_hash"] = hashlib.sha256(b"DESIGN_NAME: spm\n").hexdigest()
    info = manualcmd.reproduce_info(meta, RESOLVED, str(tmp_path / "r1"))
    script = manualcmd.reproduce_script(info)
    real_sha = shutil.which("sha256sum")
    out = _stub_run(tmp_path, script, {"PROJECT_DIR": str(proj)}, {
        "librelane": 'echo "PDK_ROOT=$PDK_ROOT"; echo "ARGS=$*"; echo "PWD=$PWD"',
        "shasum": f'[ "$1" = -a ] && shift 2; {real_sha} "$@"',
        "getconf": "echo 4",
    })
    assert f"PDK_ROOT={tmp_path / 'home'}/.ciel" in out
    assert "-c DRT_THREADS=4 -c STA_THREADS=4" in out
    assert f"PWD={proj}" in out
    assert "changed since this run" not in out
    # THREADS=auto: LibreLane picks the thread counts itself.
    out = _stub_run(tmp_path, script, {"PROJECT_DIR": str(proj), "THREADS": "auto"},
                    {"librelane": 'echo "ARGS=$*"', "getconf": "echo 4"})
    assert "DRT_THREADS" not in out and "FP_CORE_UTIL=40" in out
    # An edited config is said, not fatal.
    (proj / "config.yaml").write_text("DESIGN_NAME: other\n")
    out = _stub_run(tmp_path, script, {"PROJECT_DIR": str(proj)}, {"librelane": "true", "getconf": "echo 4"})
    assert "config.yaml changed since this run" in out


def test_local_run_gets_no_image_override(tmp_path: Path):
    meta = json.loads(json.dumps(META))
    meta["cli_command"]["recommended"] = "local"
    info = manualcmd.reproduce_info(meta, RESOLVED, str(tmp_path / "r1"))
    assert info["image"] is None
    assert "LIBRELANE_IMAGE_OVERRIDE" not in manualcmd.reproduce_script(info)


def test_retag_changes_only_the_run_tag():
    assert manualcmd.retag("librelane c.json --run-tag a-1 -i runs/a-1/s.json") == "librelane c.json --run-tag a-1-repro -i runs/a-1/s.json"
    assert manualcmd.retag("librelane c.json") == "librelane c.json"
    assert manualcmd.retag(None) is None
