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
"""Custom standard-cell injection / swap-out for a single run (advanced).

LibreLane lets a design pull in extra cell views and exclude library cells via
**verified-real** variables:

* ``EXTRA_LEFS`` / ``EXTRA_LIBS`` / ``EXTRA_GDS`` / ``EXTRA_SPICE_MODELS`` /
  ``EXTRA_VERILOG_MODELS`` / ``EXTRA_CDLS`` / ``EXTRA_SPEFS`` — add the custom
  cell's physical (LEF/GDS), timing (LIB), and verification (SPICE/CDL/Verilog)
  views so synthesis, PnR, STA and signoff all know about it; and
* ``EXTRA_EXCLUDED_CELLS`` — the standard cells to *remove* from synthesis and
  placement, so the tools pick the custom cell "in exchange" for them.

This module stores a per-design set of custom cells in a GUI sidecar
(``<design>/.gui-custom-cells.json``) with the uploaded files saved under
``<design>/custom_cells/<name>/``, and turns the enabled ones into a run-time
override dict. The overrides are applied **per run** (never written into the
user's ``config.json``), matching "use my cell for this run". Pure stdlib; all
writes confined to the design dir; cross-platform via ``pathlib``.
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

_SIDECAR = ".gui-custom-cells.json"
_CELLS_SUBDIR = "custom_cells"
_MAX_FILE_BYTES = 64 * 1024 * 1024  # a GDS can be sizeable; cap to a sane bound.

# Cell-view kind -> (LibreLane variable, allowed extensions).
_VIEW_VARS: Dict[str, Dict[str, Any]] = {
    "lef":     {"var": "EXTRA_LEFS",           "exts": (".lef",)},
    "lib":     {"var": "EXTRA_LIBS",           "exts": (".lib",)},
    "gds":     {"var": "EXTRA_GDS",            "exts": (".gds", ".gds.gz")},
    "spice":   {"var": "EXTRA_SPICE_MODELS",   "exts": (".spice", ".sp", ".cir")},
    "verilog": {"var": "EXTRA_VERILOG_MODELS", "exts": (".v", ".sv")},
    "cdl":     {"var": "EXTRA_CDLS",           "exts": (".cdl", ".spice")},
    "spef":    {"var": "EXTRA_SPEFS",          "exts": (".spef",)},
}

_NAME_RX = re.compile(r"^[A-Za-z0-9_.\-]+$")
_NAME_MAX = 128


def valid_name(name: Any) -> bool:
    """A cell name that is safe as one folder under ``custom_cells/``: letters,
    digits, ``_.-``, not only dots (``.`` and ``..`` name the folder itself or
    the project), no separator, a sane length."""
    if not isinstance(name, str) or not name or len(name) > _NAME_MAX:
        return False
    return bool(_NAME_RX.match(name)) and not re.fullmatch(r"\.+", name)


def _cell_dir(d: Path, name: str) -> Optional[Path]:
    """``<design>/custom_cells/<name>``, or None when that folder would not be
    a direct child of the project's own ``custom_cells`` (a bad name, or a
    ``custom_cells`` that is a link to somewhere else)."""
    if not valid_name(name):
        return None
    root = d / _CELLS_SUBDIR
    try:
        root_res = root.resolve()
        root_res.relative_to(d)
    except (OSError, ValueError):
        return None
    if root_res.parent != d:
        return None
    return root / name


def _sidecar_path(design_dir: str | Path) -> Path:
    return Path(design_dir).resolve() / _SIDECAR


def _load(design_dir: str | Path) -> List[Dict[str, Any]]:
    f = _sidecar_path(design_dir)
    if not f.is_file():
        return []
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
        return doc.get("cells", []) if isinstance(doc, dict) else []
    except Exception:
        return []


def _save(design_dir: str | Path, cells: List[Dict[str, Any]]) -> None:
    from . import platform_env
    f = _sidecar_path(design_dir)
    # Atomic: a crash mid-write must not corrupt the sidecar (a corrupt sidecar
    # reads back as "no cells" and the next save persists the loss).
    platform_env.atomic_write_text(f, json.dumps({"cells": cells}, indent=2) + "\n")


def list_cells(design_dir: str | Path) -> Dict[str, Any]:
    """Return the design's saved custom cells (read-only)."""
    return {"ok": True, "cells": _load(design_dir)}


def _confined(design_dir: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(design_dir.resolve())
        return True
    except Exception:
        return False


def save_cell(
    design_dir: str | Path,
    name: str,
    *,
    swap_out: Optional[List[str]] = None,
    views: Optional[Dict[str, Dict[str, str]]] = None,
    enabled: bool = True,
) -> Dict[str, Any]:
    """Save (or replace) a custom cell for *design_dir*.

    *views* maps a kind (``lef``/``lib``/``gds``/…) to ``{filename, upload_id}``
    (a file sent to ``/api/upload`` first, see :mod:`.uploads`) or, for small
    files, ``{filename, content_b64}``. Files are written under
    ``custom_cells/<name>/`` and recorded as design-dir-relative ``dir::`` paths
    so they resolve in both local and container runs. *swap_out* is the list of
    standard-cell names to exclude (``EXTRA_EXCLUDED_CELLS``). Returns
    ``{ok, cell}`` or ``{ok: False, error}``. Never raises."""
    from . import uploads

    d = Path(design_dir).resolve()
    if not d.is_dir():
        return {"ok": False, "error": "design directory not found"}
    name = (name or "").strip()
    if not valid_name(name):
        return {"ok": False, "error": "cell name must use only letters, digits and _ . - "
                                      "(and not be only dots)"}

    cell_dir = _cell_dir(d, name)
    if cell_dir is None or cell_dir.is_symlink() or not _confined(d, cell_dir):
        return {"ok": False, "error": "refusing to write outside the design dir"}

    # Check every view BEFORE writing anything, so a bad file cannot leave a
    # half-saved cell on disk.
    planned: List[Any] = []
    for kind, payload in (views or {}).items():
        spec = _VIEW_VARS.get(kind)
        if spec is None:
            return {"ok": False, "error": f"unknown cell view '{kind}'"}
        fname = (payload or {}).get("filename") or f"{name}.{kind}"
        fname = Path(str(fname).replace("\\", "/")).name  # strip any directory component
        # These paths ride whitespace-joined list overrides (EXTRA_LEFS=a b) —
        # a space in the filename would split into phantom paths mid-flow.
        fname = re.sub(r"\s+", "_", fname)
        if not fname or re.fullmatch(r"\.+", fname):
            return {"ok": False, "error": "invalid file name"}
        ext_ok = any(fname.lower().endswith(e) for e in spec["exts"])
        if not ext_ok:
            return {"ok": False,
                    "error": f"{kind} file should end with {' or '.join(spec['exts'])}"}
        upload_id = (payload or {}).get("upload_id")
        if upload_id:
            staged = uploads.staged(d, upload_id)
            if staged is None:
                return {"ok": False, "error": f"the uploaded {kind} file is gone; add it again"}
            planned.append((kind, fname, staged))
            continue
        b64 = (payload or {}).get("content_b64") or ""
        try:
            raw = base64.b64decode(b64, validate=False)
        except Exception:
            return {"ok": False, "error": f"could not decode {kind} file"}
        if len(raw) > _MAX_FILE_BYTES:
            return {"ok": False, "error": f"{kind} file exceeds {_MAX_FILE_BYTES // (1024*1024)} MiB"}
        planned.append((kind, fname, raw))

    if not any(k == "lef" for k, _f, _s in planned):
        return {"ok": False, "error": "a LEF view is required (the cell's abstract/footprint)"}

    try:
        cell_dir.mkdir(parents=True, exist_ok=True)
    except OSError as ex:
        return {"ok": False, "error": str(ex)}
    saved_views: Dict[str, str] = {}
    for kind, fname, src in planned:
        target = cell_dir / fname
        if target.is_symlink() or target.resolve().parent != cell_dir.resolve():
            return {"ok": False, "error": "invalid file name"}
        try:
            if isinstance(src, Path):
                uploads.move_into(src, target)
            else:
                target.write_bytes(src)
        except Exception as ex:
            return {"ok": False, "error": str(ex)}
        # Forward slashes: ``dir::`` paths resolve in both run modes and on
        # Windows-authored designs (mirrors custommacros).
        saved_views[kind] = "dir::" + str(target.relative_to(d)).replace("\\", "/")

    # Swap-out names ride the whitespace-joined EXTRA_EXCLUDED_CELLS override —
    # a name with whitespace would corrupt every other entry in the list.
    swap_clean: List[str] = []
    for s in (swap_out or []):
        s = str(s or "").strip()
        if not s:
            continue
        if any(ch.isspace() for ch in s):
            return {"ok": False,
                    "error": f"swap-out cell name '{s}' contains whitespace — "
                             "cell names never do; check for a stray space"}
        swap_clean.append(s)

    cells = [c for c in _load(d) if c.get("name") != name]
    entry = {
        "name": name,
        "enabled": bool(enabled),
        "swap_out": swap_clean,
        "views": saved_views,
    }
    cells.append(entry)
    try:
        _save(d, cells)
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
    return {"ok": True, "cell": entry}


def set_enabled(design_dir: str | Path, name: str, enabled: bool) -> Dict[str, Any]:
    cells = _load(design_dir)
    found = False
    for c in cells:
        if c.get("name") == name:
            c["enabled"] = bool(enabled)
            found = True
    if not found:
        return {"ok": False, "error": "cell not found"}
    _save(design_dir, cells)
    return {"ok": True}


def remove_cell(design_dir: str | Path, name: str) -> Dict[str, Any]:
    """Remove a custom cell and the folder LanEx stored its files in.

    Only ever deletes ``<design>/custom_cells/<name>`` itself: a name such as
    ``..`` or an empty one (which used to resolve to the project folder or to
    every cell) is refused, and a ``<name>`` that is a link loses the link,
    never what it points to. A record with an unsafe name (written before
    names were checked) is dropped from the list without touching any file."""
    d = Path(design_dir).resolve()
    if not d.is_dir():
        return {"ok": False, "error": "design directory not found"}
    cells = _load(d)
    keep = [c for c in cells if c.get("name") != name]
    known = len(keep) != len(cells)
    if not valid_name(name):
        if not known:
            return {"ok": False, "error": "no custom cell by that name"}
        _save(d, keep)
        return {"ok": True, "files_removed": False}
    cell_dir = _cell_dir(d, name)
    if cell_dir is None:
        return {"ok": False, "error": "refusing to delete outside the project's custom_cells folder"}
    _save(d, keep)
    return {"ok": True, "files_removed": _remove_child_dir(cell_dir)}


def _remove_child_dir(target: Path) -> bool:
    """Delete one folder LanEx made (or the link standing in for it)."""
    import shutil
    try:
        if target.is_symlink():
            target.unlink()
            return True
        if target.is_dir():
            shutil.rmtree(target)
            return True
    except OSError:
        pass
    return False


def _config_lists(design_dir: str | Path, keys: List[str]) -> Dict[str, List[str]]:
    """List values the design's JSON/YAML config sets for *keys* (Tcl: none)."""
    try:
        from . import configedit
        data = configedit.read_config(design_dir).get("data") or {}
    except Exception:
        return {}
    out: Dict[str, List[str]] = {}
    for k in keys:
        v = data.get(k)
        if isinstance(v, list):
            out[k] = [str(x) for x in v]
        elif isinstance(v, str) and v.strip():
            out[k] = v.split()
    return out


def build_overrides(design_dir: str | Path) -> Dict[str, Any]:
    """Aggregate the enabled custom cells into a run-time override dict.

    List-valued overrides are whitespace-joined (how LibreLane parses list
    overrides on the CLI / via ``config_override_strings``). Returns ``{}`` when
    no enabled cells, so a normal run is unaffected."""
    cells = [c for c in _load(design_dir) if c.get("enabled", True)]
    if not cells:
        return {}
    accum: Dict[str, List[str]] = {}
    excluded: List[str] = []
    for c in cells:
        for kind, path in (c.get("views") or {}).items():
            var = _VIEW_VARS.get(kind, {}).get("var")
            if var and path:
                accum.setdefault(var, []).append(path)
        for cell_name in (c.get("swap_out") or []):
            if cell_name and cell_name not in excluded:
                excluded.append(cell_name)
    # A ``-c KEY=VALUE`` override REPLACES the config's own value, so start each
    # list from what the design's config already sets; otherwise enabling one
    # swap silently drops the user's own EXTRA_EXCLUDED_CELLS / EXTRA_LEFS.
    own = _config_lists(design_dir, list(accum) + ["EXTRA_EXCLUDED_CELLS"])
    for var in list(accum):
        accum[var] = own.get(var, []) + [p for p in accum[var] if p not in own.get(var, [])]
    if excluded:
        excluded = own.get("EXTRA_EXCLUDED_CELLS", []) + [c for c in excluded if c not in own.get("EXTRA_EXCLUDED_CELLS", [])]
    overrides: Dict[str, Any] = {k: " ".join(v) for k, v in accum.items()}
    if excluded:
        overrides["EXTRA_EXCLUDED_CELLS"] = " ".join(excluded)
    return overrides


def merge_into(overrides: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    """Merge *extra* (custom-cell) overrides into user *overrides*, appending to
    whitespace-separated list values rather than clobbering them."""
    out = dict(overrides or {})
    list_vars = {spec["var"] for spec in _VIEW_VARS.values()} | {"EXTRA_EXCLUDED_CELLS"}
    for k, v in (extra or {}).items():
        if k in list_vars and out.get(k):
            out[k] = f"{out[k]} {v}".strip()
        else:
            out[k] = v
    return out
