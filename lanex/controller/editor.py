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
"""Guarded file writes for the RTL IDE (Phase 3.3).

Until now the GUI is **read-only**. This is the *only* module that grants write
power, so the guard is the whole point: every path is resolved strictly inside
the design dir (no ``..``, no absolute escape, no symlink escape), only an
allowlisted set of source extensions is writable, and writes are atomic
(temp + ``os.replace``) and keep the file's mode and line endings. A save
names the content it was based on, so it never overwrites a newer file on
disk unasked. Pure / stdlib only.
"""
from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

# Only these extensions may be created/edited through the IDE.
EDITABLE_EXTS = {
    ".v", ".sv", ".vh", ".svh", ".vhd", ".vhdl", ".sdc", ".tcl", ".xdc",
    ".yaml", ".yml", ".json", ".cfg", ".md", ".txt", ".mem", ".hex",
}
MAX_WRITE_BYTES = 4 * 1024 * 1024  # 4 MiB — RTL/config files are tiny.


def _resolve_inside(design_dir: str | Path, rel_path: str) -> Optional[Path]:
    """Resolve *rel_path* strictly inside *design_dir*; None if it escapes.

    Rejects absolute paths and any ``..`` traversal, and verifies the resolved
    target (following symlinks) is still within the resolved design dir — so a
    symlink inside the design dir can't be used to escape it.
    """
    if not rel_path or os.path.isabs(rel_path):
        return None
    # Reject explicit parent traversal up front (defence in depth).
    parts = Path(rel_path).parts
    if ".." in parts:
        return None
    base = Path(design_dir).resolve()
    target = (base / rel_path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


def normalize_newlines(text: str) -> str:
    """What Python's universal-newline read returns for *text*: CRLF and a lone
    CR become LF. The editor and the read endpoint both see files this way."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def text_hash(text: str) -> str:
    """The stamp of a file's content as the IDE read it (newlines normalised,
    so a file the IDE saved with its CRLF endings kept reads back the same)."""
    return hashlib.sha256(normalize_newlines(text).encode("utf-8")).hexdigest()


def disk_hash(path: str | Path) -> Optional[str]:
    """:func:`text_hash` of the file on disk, or None when it isn't there."""
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return None
    return text_hash(raw.decode("utf-8", errors="replace"))


def _uses_crlf(raw: bytes) -> bool:
    """Most of the file's line breaks are CRLF (a file written on Windows)."""
    crlf = raw.count(b"\r\n")
    return crlf > 0 and crlf >= raw.count(b"\n") - crlf


_umask_lock = threading.Lock()


def _default_mode() -> int:
    """The mode a plain ``open(..., "w")`` would give a new file (0666 less the
    umask). ``mkstemp`` makes 0600, which is what a save used to leave behind."""
    with _umask_lock:
        um = os.umask(0)
        os.umask(um)
    return 0o666 & ~um


def free_name(design_dir: str | Path, rel_path: str) -> str:
    """*rel_path*, or ``name_2.ext``, ``name_3.ext`` … whichever is not taken."""
    p = Path(rel_path)
    stem, suffix = p.stem, p.suffix
    base = Path(design_dir)
    n = 2
    cand = rel_path
    while (base / cand).exists():
        cand = (p.parent / f"{stem}_{n}{suffix}").as_posix()
        n += 1
    return cand


def write_text(design_dir: str | Path, rel_path: str, content: str, *,
               base_hash: Optional[str] = None, force: bool = False,
               on_exists: Optional[str] = None) -> Dict[str, Any]:
    """Atomically write *content* to *rel_path* inside *design_dir*.

    Returns ``{ok, path, bytes, hash}`` or ``{ok: False, error}``. Refuses paths
    that escape the design dir or carry a non-allowlisted extension.

    * *base_hash*: the :func:`text_hash` the IDE read. When the file on disk no
      longer matches it (Setup, a terminal or another window changed it since),
      nothing is written and the answer is ``{ok: False, conflict: True, hash}``,
      unless *force* (the person chose to keep their version).
    * *on_exists*: ``"error"`` refuses an existing file (``exists: True`` plus
      a free ``suggested`` name), ``"keep_both"`` writes under that free name,
      anything else replaces it (the old behaviour).
    * The file keeps its mode, and its CRLF line endings when the new text
      comes from the editor (LF only).
    """
    target = _resolve_inside(design_dir, rel_path)
    if target is None:
        return {"ok": False, "error": "path escapes the design directory"}
    if target.suffix.lower() not in EDITABLE_EXTS:
        return {"ok": False, "error": f"extension '{target.suffix}' is not editable"}
    if target.exists() and on_exists in ("error", "keep_both"):
        if not target.is_file():
            return {"ok": False, "error": f"{rel_path} exists and is not a file"}
        suggested = free_name(design_dir, rel_path)
        if on_exists == "error":
            return {"ok": False, "exists": True, "suggested": suggested,
                    "error": f"{rel_path} already exists"}
        rel_path = suggested
        target = _resolve_inside(design_dir, rel_path)
        if target is None:
            return {"ok": False, "error": "path escapes the design directory"}
    raw_old: Optional[bytes] = None
    mode: Optional[int] = None
    if target.is_file():
        try:
            raw_old = target.read_bytes()
            mode = stat.S_IMODE(target.stat().st_mode)
        except OSError as ex:
            return {"ok": False, "error": str(ex)}
        if base_hash is not None and not force:
            now = text_hash(raw_old.decode("utf-8", errors="replace"))
            if now != base_hash:
                return {"ok": False, "conflict": True, "hash": now,
                        "error": f"{rel_path} changed on disk since it was opened"}
    text = content
    if raw_old is not None and "\r" not in text and _uses_crlf(raw_old):
        text = text.replace("\n", "\r\n")
    data = text.encode("utf-8")
    if len(data) > MAX_WRITE_BYTES:
        return {"ok": False, "error": "file too large to save"}
    target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic: write to a temp file in the same dir, then replace.
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".ll-edit-", suffix=target.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            os.chmod(tmp, mode if mode is not None else _default_mode())
        except OSError:
            pass  # a filesystem without modes (some Windows mounts): nothing to keep
        os.replace(tmp, target)
    except Exception as ex:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return {"ok": False, "error": str(ex)}
    return {"ok": True, "path": Path(rel_path).as_posix(), "bytes": len(data), "hash": text_hash(text),
            "eol": "crlf" if "\r\n" in text else "lf"}


def create_file(design_dir: str | Path, rel_path: str) -> Dict[str, Any]:
    """Create an empty editable file (refuses to clobber an existing one)."""
    target = _resolve_inside(design_dir, rel_path)
    if target is None:
        return {"ok": False, "error": "path escapes the design directory"}
    if target.suffix.lower() not in EDITABLE_EXTS:
        return {"ok": False, "error": f"extension '{target.suffix}' is not editable"}
    if target.exists():
        return {"ok": False, "error": "file already exists"}
    return write_text(design_dir, rel_path, "")


def delete_file(design_dir: str | Path, rel_path: str) -> Dict[str, Any]:
    """Delete a file inside the design dir (never recursive, never outside)."""
    target = _resolve_inside(design_dir, rel_path)
    if target is None:
        return {"ok": False, "error": "path escapes the design directory"}
    if not target.is_file():
        return {"ok": False, "error": "not a file"}
    try:
        target.unlink()
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
    return {"ok": True, "deleted": rel_path}


def rename_file(design_dir: str | Path, rel_path: str, new_rel: str) -> Dict[str, Any]:
    """Rename/move a file inside the design dir. Never overwrites, never leaves it."""
    src = _resolve_inside(design_dir, rel_path)
    dst = _resolve_inside(design_dir, new_rel)
    if src is None or dst is None:
        return {"ok": False, "error": "path escapes the design directory"}
    if not src.is_file():
        return {"ok": False, "error": "not a file"}
    if dst.suffix.lower() not in EDITABLE_EXTS:
        return {"ok": False, "error": f"extension '{dst.suffix}' is not editable"}
    if dst.exists() and not (os.path.normcase(str(dst)) == os.path.normcase(str(src))):
        return {"ok": False, "error": f"{new_rel} already exists"}
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dst)
    except Exception as ex:
        return {"ok": False, "error": str(ex)}
    return {"ok": True, "old": rel_path, "rel": Path(new_rel).as_posix(), "abs": str(dst)}
