# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Everything third-party that ships in the wheel is named in NOTICE and
carries its licence text next to it (audit G23).

A new file in lanex/server/static/vendor/ fails here until it is either
LanEx's own artwork or listed with its licence.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
VENDOR = REPO / "lanex" / "server" / "static" / "vendor"
NOTICE = " ".join((REPO / "NOTICE").read_text(encoding="utf-8").split())

# vendored file (relative to VENDOR) -> (words NOTICE must contain, licence files)
THIRD_PARTY = {
    "codemirror.js": (["CodeMirror 6", "MIT License"], ["codemirror.LICENSE"]),
    "driverjs/driver.js.mjs": (["Driver.js 1.9.0", "MIT License"], ["driverjs/LICENSE"]),
    "driverjs/driver.css": (["Driver.js 1.9.0"], ["driverjs/LICENSE"]),
    "echarts.min.js": (["Apache ECharts 5.5.1", "Copyright 2017-2024 The Apache Software Foundation",
                        "ZRender 5.6.0", "d3.js"],
                       ["echarts.LICENSE", "echarts.NOTICE", "echarts-licenses/LICENSE-d3",
                        "echarts-licenses/LICENSE-zrender"]),
    "fonts/barlow-400.woff2": (["Barlow typeface, version 1.408", "SIL Open Font License"],
                               ["fonts/OFL-Barlow.txt"]),
    "fonts/jetbrainsmono.woff2": (["JetBrains Mono, version 2.211", "SIL Open Font License"],
                                  ["fonts/OFL-JetBrainsMono.txt"]),
}
# LanEx's own artwork, and the licence files themselves.
OWN = re.compile(r"^(favicon\.png|icon-.*\.png|lanex-.*\.png)$")
LICENCE_FILE = re.compile(r"(LICENSE|NOTICE|OFL-.*\.txt)")


def test_every_vendored_file_is_accounted_for() -> None:
    covered = set(THIRD_PARTY)
    for _, (_, licences) in THIRD_PARTY.items():
        covered.update(licences)
    for path in sorted(p for p in VENDOR.rglob("*") if p.is_file()):
        rel = path.relative_to(VENDOR).as_posix()
        if OWN.match(rel) or LICENCE_FILE.search(path.name):
            continue
        if rel.startswith("fonts/barlow"):
            rel = "fonts/barlow-400.woff2"   # one entry covers the family
        assert rel in covered, f"{rel} ships in the wheel but is not in NOTICE / this test"


def test_notice_names_each_component_and_its_licence_text_ships() -> None:
    for vendored, (words, licences) in THIRD_PARTY.items():
        assert (VENDOR / vendored).is_file(), vendored
        for word in words:
            assert word in NOTICE, f"NOTICE does not mention {word!r}"
        for licence in licences:
            assert (VENDOR / licence).is_file(), licence
            assert "vendor/" + licence in NOTICE or licence.split("/")[0] + "/" in NOTICE, licence


def test_licence_texts_are_the_real_ones() -> None:
    assert "SIL OPEN FONT LICENSE Version 1.1" in (VENDOR / "fonts/OFL-Barlow.txt").read_text()
    assert "Copyright 2017 The Barlow Project Authors" in (VENDOR / "fonts/OFL-Barlow.txt").read_text()
    assert "Copyright 2020 The JetBrains Mono Project Authors" in (
        VENDOR / "fonts/OFL-JetBrainsMono.txt").read_text()
    assert "Apache License" in (VENDOR / "echarts.LICENSE").read_text()
    assert "Copyright 2017-2024 The Apache Software Foundation" in (VENDOR / "echarts.NOTICE").read_text()
    assert "Mike Bostock" in (VENDOR / "echarts-licenses/LICENSE-d3").read_text()
    assert "Baidu Inc." in (VENDOR / "echarts-licenses/LICENSE-zrender").read_text()
    assert "Cole Bemis" in (VENDOR / "icons.LICENSE").read_text()
    assert "vendor/icons.LICENSE" in NOTICE
    # The bundled versions NOTICE records.
    js = (VENDOR / "echarts.min.js").read_text(encoding="utf-8")
    assert 't.version="5.5.1"' in js and 'zrender:"5.6.0"' in js


def test_licence_files_and_notice_go_into_the_wheel() -> None:
    tomllib = pytest.importorskip("tomllib")  # Python 3.11+
    config = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    assert "NOTICE" in config["tool"]["setuptools"]["license-files"]
    assert "server/static/vendor/**/*" in config["tool"]["setuptools"]["package-data"]["lanex"]
