# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Standard-cell library browser (Phase 4.3).

Lists the cells in a PDK's standard-cell library by parsing the LEF the PDK
already ships (``$PDK_ROOT/<variant>/libs.ref/<scl>/lef/*.lef``). Pure stdlib —
no klayout needed to *list* cells (rendering a cell layout is the optional
image step). No new dependency.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

_MACRO_RX = re.compile(r"^\s*MACRO\s+(\S+)", re.MULTILINE)

# One taxonomy for the whole app: the Cells tab's categories (celllib
# CATEGORY_LABELS, decided from the Liberty file). The census in Layout uses
# the same, from the Liberty file when the library is installed and from these
# name rules otherwise (and for a library with no Liberty file, in both tabs).
# The rules follow the cell families of sky130 (sky130_fd_sc_hd__a21oi_1),
# gf180mcu (gf180mcu_fd_sc_mcu7t5v0__latq_1) and IHP (sg13g2_dlhq_1). Run on
# every installed library on 2026-11-22 they agree with the Liberty-based
# category on every cell of sky130 hd, hs, hdll, ls, ms and lp, gf180mcu 7t
# and sg13g2 (tests/test_cells_tab.py keeps a sample of each).
_KIND_RULES = [
    (r"bleeder|decap|isowell_tap|^(fill|filler|tap|endcap|diode|antenna|fakediode|corner|sighold|hold)", "physical"),
    (r"inputisolatch|^isolatch|^srdl", "latch"),
    (r"^lpflow_|^(lsbuf|isobuf|inputiso|lvlshift|ls_)", "power"),
    (r"^s?dlclkp|icg|^s?lgcp|^icgt", "clock"),
    (r"^(ebuf|einv|tbuf|tinv|bufz|invz)", "tristate"),
    (r"^(conb|tie|macro_sparecell)", "tie"),
    (r"^(dl[xr]|dlh|dll|lat)", "latch"),
    (r"^(s|e|se)?d(ff|f)[a-z]|^sreg|^srsdf", "flipflop"),
    (r"^iso\d", "logic"),
    (r"^(dly|clkdly|dlygate|dlymetal|delay)", "delay"),
    (r"^clk", "clock"),
    (r"^(fa|fah|ha|maj\d|addf|addh)", "arith"),
    (r"mux", "mux"),
    (r"^(inv|bufinv)", "inverter"),
    (r"^(buf|bufbuf|probe)", "buffer"),
    (r"^(n?and|n?or|xn?or|a\d|o\d|aoi|oai)", "logic"),
]
_KIND_RX = [(re.compile(p, re.I), k) for p, k in _KIND_RULES]
_DRIVE_RX = re.compile(r"^(.*?)_(\d+|lp\d*|m)$")


def family_of(name: str) -> str:
    """A cell's family without library prefix or drive strength:
    ``sky130_fd_sc_hd__a21oi_1`` and ``sg13g2_a21oi_1`` are ``a21oi``."""
    rest = name[name.rfind("__") + 2:] if "__" in name else re.sub(r"^sg13g2_", "", name)
    m = _DRIVE_RX.match(rest)
    return m.group(1) if m else rest


def classify_cell(name: str) -> str:
    """The Cells tab's category of a cell, from its name alone."""
    fam = family_of(name).lower()
    for rx, kind in _KIND_RX:
        if rx.search(fam):
            return kind
    return "other"


def census(names: List[str], pdk: Optional[str], scl: Optional[str]) -> Dict[str, Dict[str, str]]:
    """``{cell: {kind, label, desc}}`` for the cells of a layout, in the Cells
    tab's taxonomy: its Liberty-based category and the PDK's own description
    when the library is installed, the name rules otherwise. A cell that is
    not in the library (a macro) is "other"."""
    rows: Dict[str, Dict[str, Any]] = {}
    labels: Dict[str, str] = {}
    try:
        from . import celllib
        labels = dict(celllib.CATEGORY_LABELS)
        if pdk and scl:
            lib = celllib.library(pdk, scl)
            if lib.get("ok"):
                rows = {r["cell"]: r for r in lib.get("cells") or []}
    except Exception:
        rows = {}
    out: Dict[str, Dict[str, str]] = {}
    for n in names:
        r = rows.get(n)
        if r is not None:
            kind = r.get("category") or "other"
        else:
            # Not in the library: a standard cell from a sister library by
            # its name, anything else (a macro) "other".
            kind = classify_cell(n) if not rows or "__" in n or n.startswith("sg13g2_") else "other"
        out[n] = {"kind": kind, "label": labels.get(kind, kind), "desc": str((r or {}).get("desc") or "")}
    return out


def parse_lef_macros(text: str) -> List[str]:
    """Every ``MACRO <name>`` in a LEF, in file order, de-duplicated."""
    out: List[str] = []
    seen = set()
    for m in _MACRO_RX.finditer(text or ""):
        name = m.group(1)
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _scl_lef_dir(pdk: str, scl: Optional[str]) -> Optional[Path]:
    if not scl:
        return None
    # Search every candidate PDK root the GUI knows about — env PDK_ROOT, ciel
    # homes, volare, etc. (same enumeration the Setup PDK picker uses) — not just
    # $PDK_ROOT, so cells resolve for ciel-installed PDKs too.
    roots: List[Path] = []
    try:
        from . import pdk as _pdk
        roots.extend(_pdk._candidate_pdk_roots())
    except Exception:
        pass
    env = os.environ.get("PDK_ROOT")
    if env:
        roots.append(Path(env))
    seen: set = set()
    for root in roots:
        if str(root) in seen:
            continue
        seen.add(str(root))
        for c in (root / pdk / "libs.ref" / scl / "lef",
                  root / "libs.ref" / scl / "lef"):
            if c.is_dir():
                return c
    # Last resort: shallow glob under each root for libs.ref/<scl>/lef.
    for root in roots:
        try:
            for p in root.glob(f"**/libs.ref/{scl}/lef"):
                if p.is_dir():
                    return p
        except Exception:
            continue
    return None


def list_pdk_cells(pdk: str, scl: Optional[str]) -> Dict[str, Any]:
    """List the standard cells of *scl* by parsing its LEF.

    Returns ``{ok, cells:[{cell, kind}], scl, source}`` or
    ``{ok: False, error}`` when the LEF can't be located (e.g. PDK not
    installed). Never raises."""
    lef_dir = _scl_lef_dir(pdk, scl)
    if lef_dir is None:
        return {"ok": False, "error": "could not locate the SCL's LEF — is the PDK installed?",
                "cells": []}
    names: List[str] = []
    seen = set()
    try:
        lefs = sorted(lef_dir.glob("*.lef"))
        for lf in lefs:
            try:
                for n in parse_lef_macros(lf.read_text(encoding="utf-8", errors="replace")):
                    if n not in seen:
                        seen.add(n)
                        names.append(n)
            except Exception:
                continue
    except Exception as ex:
        return {"ok": False, "error": str(ex), "cells": []}
    cells = [{"cell": n, "kind": classify_cell(n)} for n in sorted(names)]
    return {"ok": True, "scl": scl, "source": str(lef_dir), "cells": cells}
