# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Stop ends this flow and nothing else (audit G5).

History: cancel used to report "cancelled" while the LibreLane container kept
running, because librelane 3.0.4 never shows the ``--name`` it gives the
container. The first fix removed every container that mounted the design
folder, and killed every child process of the server, so a Stop also closed
KLayout/GTKWave viewers and ended simulations, Console commands and Tools
installs. Now LanEx names the container itself (``LANEX_CONTAINER_NAME``,
applied by ``librelane_entry``) and removes that one, and a local run's
processes are recorded as LibreLane starts them. Engine calls are faked; the
process tests use real ``sleep`` processes.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
from pathlib import Path
from typing import List

import psutil
import pytest

from lanex.controller import runner as runner_mod
from lanex.controller.runner import CONTAINER_NAME_RX, FlowRunner, new_container_name


class _FakeRun:
    def __init__(self) -> None:
        self.calls: List[List[str]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")


def _docker_only(monkeypatch):
    monkeypatch.setattr(runner_mod.shutil, "which",
                        lambda name: "/usr/bin/docker" if name == "docker" else None)


def test_kill_container_removes_only_the_named_container(tmp_path: Path, monkeypatch):
    """No `ps`/`inspect` discovery any more: a viewer or simulation container
    of the same project (same mount, same working dir) is never matched."""
    fake = _FakeRun()
    monkeypatch.setattr(runner_mod.subprocess, "run", fake)
    _docker_only(monkeypatch)
    r = FlowRunner()
    r._run_dir = str(tmp_path / "spm" / "runs" / "t1")
    r._container_name = "lanex-flow-0123456789abcdef"
    r._kill_container()
    assert fake.calls == [["/usr/bin/docker", "rm", "-f", "lanex-flow-0123456789abcdef"]]


def test_kill_container_uses_the_runs_engine_and_sg(monkeypatch):
    fake = _FakeRun()
    monkeypatch.setattr(runner_mod.subprocess, "run", fake)
    r = FlowRunner()
    r._container_name = "lanex-flow-aa"
    r._container_engine = "/usr/bin/podman"
    r._kill_container()
    assert fake.calls == [["/usr/bin/podman", "rm", "-f", "lanex-flow-aa"]]
    fake.calls.clear()
    r._container_engine = "/usr/bin/docker"
    r._container_sg = True
    r._kill_container()
    assert fake.calls[0][:3] == ["sg", "docker", "-c"]
    assert "rm -f lanex-flow-aa" in fake.calls[0][3]


def test_kill_container_without_a_name_touches_nothing(monkeypatch):
    fake = _FakeRun()
    monkeypatch.setattr(runner_mod.subprocess, "run", fake)
    _docker_only(monkeypatch)
    r = FlowRunner()
    r._run_dir = "/tmp/x/runs/y"
    r._container_name = None
    r._kill_container()
    assert fake.calls == []


def test_container_launch_names_the_container(monkeypatch):
    from lanex.controller import container_run, tools
    monkeypatch.setattr(tools, "resolve_engine", lambda *a, **k: {"engine": "docker", "env": {}, "sg_wrap": False})
    monkeypatch.setattr(container_run, "image_ref", lambda: "img@sha256:1")
    _docker_only(monkeypatch)
    r = FlowRunner()
    argv, env = r._container_launch(["python", "-m", "x"])
    assert argv == ["python", "-m", "x"]
    assert env["LANEX_CONTAINER_NAME"] == r._container_name
    assert re.fullmatch(CONTAINER_NAME_RX, r._container_name) and r._container_name.startswith("lanex-flow-")
    assert r._container_engine == "/usr/bin/docker"
    first = r._container_name
    r._container_launch(["x"])
    assert r._container_name != first   # one name per container (step-by-step runs several)


def test_parsed_echo_does_not_replace_lanex_name():
    r = FlowRunner()
    r._container_name = "lanex-flow-mine"
    r._dispatch_parsed({"type": "container", "name": "something-else"})
    assert r._container_name == "lanex-flow-mine"


def test_entry_applies_the_name_to_librelane(monkeypatch):
    pytest.importorskip("librelane.container")
    import librelane.container as lc

    from lanex.controller import librelane_entry
    orig = lc.uuid
    try:
        monkeypatch.setenv("LANEX_CONTAINER_NAME", new_container_name())
        librelane_entry._name_the_container()
        assert str(lc.uuid.uuid4()) == __import__("os").environ["LANEX_CONTAINER_NAME"]
        # A name a shell or the engine would choke on is ignored.
        lc.uuid = orig
        monkeypatch.setenv("LANEX_CONTAINER_NAME", "bad name; rm -rf /")
        librelane_entry._name_the_container()
        assert lc.uuid is orig
    finally:
        lc.uuid = orig


def test_librelane_still_names_containers_with_uuid4():
    """The entry patch relies on run_in_container calling uuid.uuid4() for the
    name; this fails loudly if a LibreLane upgrade changes that."""
    pytest.importorskip("librelane.container")
    import inspect

    import librelane.container as lc
    src = inspect.getsource(lc.run_in_container)
    assert "uuid.uuid4()" in src and '"--name"' in src


def _sleep(seconds: int = 60) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({seconds})"])


def _gone(p: subprocess.Popen, timeout: float = 6.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if p.poll() is not None:
            return True
        time.sleep(0.05)
    return False


def test_stop_kills_the_flows_processes_and_spares_the_rest():
    """The audit scenario: a viewer (or simulation, Console command) is a
    child of the server too. Stop must end only what the flow started."""
    bystander = _sleep()
    flow_tool = subprocess.Popen([sys.executable, "-c",
                                  "import subprocess, sys, time; "
                                  "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                                  "time.sleep(60)"])
    try:
        time.sleep(0.5)
        grandchild = psutil.Process(flow_tool.pid).children()[0]
        r = FlowRunner()
        r._track_flow_proc(psutil.Process(flow_tool.pid))
        r._kill_flow_processes()
        assert _gone(flow_tool)
        assert not grandchild.is_running() or grandchild.status() == psutil.STATUS_ZOMBIE
        assert bystander.poll() is None, "Stop ended a process that was not the flow's"
    finally:
        for p in (bystander, flow_tool):
            if p.poll() is None:
                p.kill()


def test_stop_kills_the_container_client_tree_only():
    bystander = _sleep()
    client = _sleep()
    try:
        r = FlowRunner()
        r._container_proc = client
        r._kill_flow_processes()
        assert _gone(client)
        assert bystander.poll() is None
    finally:
        for p in (bystander, client):
            if p.poll() is None:
                p.kill()


def test_stop_with_nothing_tracked_kills_nothing():
    bystander = _sleep()
    try:
        FlowRunner()._kill_flow_processes()
        time.sleep(0.3)
        assert bystander.poll() is None
    finally:
        bystander.kill()


def test_subprocess_patch_records_what_librelane_starts(monkeypatch):
    """run_subprocess is wrapped so each tool the flow starts is recorded;
    without an active run it behaves exactly as before."""
    started = []

    class FakeStep:
        def run_subprocess(self, cmd, log_to=None, *, _popen_callable=psutil.Popen, **kw):
            p = _popen_callable(cmd)
            started.append(p)
            p.wait()
            return {"returncode": p.returncode}

    import librelane.steps.step as step_mod
    monkeypatch.setattr(step_mod, "Step", FakeStep)
    monkeypatch.setattr(runner_mod, "_ORIG_PROGRESS", {})
    runner_mod._install_subprocess_patch()
    r = FlowRunner()
    cmd = [sys.executable, "-c", "pass"]
    monkeypatch.setattr(runner_mod, "_ACTIVE_RUNNER", None)
    FakeStep().run_subprocess(cmd)
    assert r._flow_procs == []
    monkeypatch.setattr(runner_mod, "_ACTIVE_RUNNER", r)
    FakeStep().run_subprocess(cmd)
    assert [p.pid for p in r._flow_procs] == [started[-1].pid]


def test_design_dir_of_run_shapes(tmp_path: Path):
    r = FlowRunner()
    r._run_dir = str(tmp_path / "chip" / "runs" / "tag1")
    assert r._design_dir_of_run() == str((tmp_path / "chip").resolve())
    r._run_dir = None
    assert r._design_dir_of_run() is None
