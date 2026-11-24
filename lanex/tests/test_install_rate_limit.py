# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""The install double-click guard is per job, not per client.

Field report 2026-11-24: a user clicked Install on PDKs one after another and
got "PDK ihp-sg13g2 install error: Rate limit exceeded". Every request in the
desktop app comes from 127.0.0.1, and one 1-second limit shared by all install
requests refused the third. Different jobs must never wait on each other; the
same job asked for twice within a second is still refused once."""
from __future__ import annotations

import contextlib
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest


@pytest.fixture()
def _server(monkeypatch):
    from lanex.server import app, routes

    started = []
    monkeypatch.setattr(routes.installer, "install_pdk",
                        lambda pdk, libraries=None: started.append(pdk) or {"ok": True, "pdk": pdk})
    monkeypatch.setattr(app.LibreLaneGUIRequestHandler, "_install_rates", {})
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        base = s.getsockname()[1]
    httpd, port = app.make_server(host="127.0.0.1", port=base)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1).read()
            break
        except Exception:
            time.sleep(0.05)
    try:
        yield port, started
    finally:
        httpd.shutdown()
        httpd.server_close()


def _post(port, path, body):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"},
    )
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_three_pdks_clicked_in_a_row_all_start(_server):
    port, started = _server
    for pdk in ("sky130A", "gf180mcuD", "ihp-sg13g2"):
        status, body = _post(port, "/api/tools/install-ciel", {"pdk": pdk})
        assert status == 200, (pdk, body)
    assert started == ["sky130A", "gf180mcuD", "ihp-sg13g2"]


def test_same_pdk_twice_within_a_second_is_refused_once(_server):
    port, started = _server
    assert _post(port, "/api/tools/install-ciel", {"pdk": "ihp-sg13g2"})[0] == 200
    status, _ = _post(port, "/api/tools/install-ciel", {"pdk": "ihp-sg13g2"})
    assert status == 429
    assert started == ["ihp-sg13g2"]
