# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Raw file uploads (``POST /api/upload``), streamed to disk.

A macro's GDS is often hundreds of MB. Sending it as base64 inside one JSON body
hit the server's 10 MB JSON cap at about 7.5 MB, so the page now sends each file
on its own, as the raw request body, and gets back an ``upload_id``. The save
call (custom cell or macro) then names that id instead of carrying the bytes.

Uploads are staged inside the project, in ``<design>/.lanex-uploads/<id>/``, so
moving one into ``custom_cells/`` or ``macros/`` is a rename, not a second copy
of a 2 GB file. Staged files nobody claimed are removed after a few hours.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any, BinaryIO, Dict, Optional

UPLOAD_SUBDIR = ".lanex-uploads"
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024     # 2 GiB per file
_CHUNK = 1024 * 1024
_STALE_S = 6 * 3600
_ID_RX = re.compile(r"[0-9a-f]{32}")
# Room left on the disk after the file, so an upload never fills it.
_DISK_MARGIN = 256 * 1024 * 1024


class UploadError(Exception):
    """An upload refused for a reason the user can act on; ``status`` is the
    HTTP status to answer with."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def safe_filename(name: Any) -> Optional[str]:
    """The last path component of *name*, spaces as ``_``; None when nothing
    usable is left (empty, only dots)."""
    base = Path(str(name or "").replace("\\", "/")).name
    base = re.sub(r"\s+", "_", base).strip()
    base = re.sub(r"[\x00-\x1f]", "", base)
    if not base or re.fullmatch(r"\.+", base) or len(base) > 200:
        return None
    return base


def _root(design_dir: Path) -> Path:
    """The staging folder, refused when it is a link (it must live in the
    project, or a rename into the project is no longer confined)."""
    root = design_dir / UPLOAD_SUBDIR
    if root.is_symlink():
        raise UploadError("the project's .lanex-uploads folder is a link; remove it and try again")
    return root


def prune(design_dir: Path, max_age: float = _STALE_S) -> None:
    """Remove staged uploads older than *max_age* (best effort)."""
    try:
        root = _root(design_dir)
    except UploadError:
        return
    if not root.is_dir():
        return
    now = time.time()
    for entry in root.iterdir():
        try:
            if entry.is_symlink():
                entry.unlink()
            elif entry.is_dir() and now - entry.stat().st_mtime > max_age:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue
    try:
        root.rmdir()          # only when empty
    except OSError:
        pass


def receive(design_dir: str | Path, filename: Any, stream: BinaryIO, length: int,
            *, max_bytes: int = MAX_UPLOAD_BYTES) -> Dict[str, Any]:
    """Write *length* bytes from *stream* to a new staged file and return
    ``{upload_id, filename, size}``. A short body (the browser gave up) leaves
    nothing behind. Raises :class:`UploadError`."""
    d = Path(design_dir).resolve()
    if not d.is_dir():
        raise UploadError("project folder not found", 404)
    fname = safe_filename(filename)
    if fname is None:
        raise UploadError("the upload needs a file name")
    if length < 0:
        raise UploadError("the upload needs a Content-Length", 411)
    if length > max_bytes:
        raise UploadError(f"{fname} is {length / 2**20:.0f} MiB; the limit is "
                          f"{max_bytes // 2**20} MiB per file", 413)
    try:
        free = shutil.disk_usage(d).free
    except OSError:
        free = None
    if free is not None and length + _DISK_MARGIN > free:
        raise UploadError(f"not enough free disk space for {fname} "
                          f"({length / 2**20:.0f} MiB, {free / 2**20:.0f} MiB free)", 507)
    prune(d)
    root = _root(d)
    upload_id = secrets.token_hex(16)
    folder = root / upload_id
    folder.mkdir(parents=True, exist_ok=False)
    target = folder / fname
    done = 0
    try:
        with open(target, "xb") as out:
            while done < length:
                chunk = stream.read(min(_CHUNK, length - done))
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
        if done != length:
            raise UploadError(f"the upload of {fname} stopped after {done} of {length} bytes")
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return {"upload_id": upload_id, "filename": fname, "size": done}


def staged(design_dir: str | Path, upload_id: Any) -> Optional[Path]:
    """The staged file for *upload_id* in this project, or None."""
    if not isinstance(upload_id, str) or not _ID_RX.fullmatch(upload_id):
        return None
    d = Path(design_dir).resolve()
    try:
        folder = _root(d) / upload_id
    except UploadError:
        return None
    if folder.is_symlink() or not folder.is_dir():
        return None
    files = [f for f in folder.iterdir() if f.is_file() and not f.is_symlink()]
    if len(files) != 1:
        return None
    return files[0]


def move_into(src: Path, target: Path) -> None:
    """Move a staged file to *target* (a rename on the same disk) and drop its
    staging folder."""
    os.replace(src, target)
    try:
        src.parent.rmdir()
        src.parent.parent.rmdir()   # .lanex-uploads, when it is now empty
    except OSError:
        pass
