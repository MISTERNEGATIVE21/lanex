# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""The LanEx key: a random secret every ``/api/*`` request must carry (G21).

Without it any program on the machine (another user's, a script with no
``Origin`` header) could drive the API, which reaches the Console and file
writes, and ``--allow-remote`` opened that to the network.

How the key travels:

* It lives in ``<LANEX_HOME>/auth-token`` (mode 0600, only this user can read
  it) and in ``server.json`` (also 0600) while a server runs.
* Whatever opens a LanEx window adds it once to the address:
  ``http://127.0.0.1:8765/?lanex_key=<key>`` (the ``lanex`` command, the macOS /
  Linux app shortcut, the Windows launcher, which reads it from ``server.json``).
  The server answers that with a redirect to the same page without the key and
  a cookie, so the key does not stay in the address bar.
* The cookie is ``HttpOnly`` (page scripts never see it) and
  ``SameSite=Strict`` (the browser never sends it with a request another site
  starts), so every same-page request (fetch, the event stream, ``<img>``,
  downloads, the IDE window) carries it and no cross-site request does.
* Scripts send it as the ``X-LanEx-Key`` header.

The key is kept across server restarts on purpose: a window left open while
LanEx restarts (an update, a crash, ``lanex`` run again) reconnects and keeps
working, and an installed app or bookmark keeps opening. Delete the file to
make a new one at the next start; every open window then needs reopening.

Exempt: ``/api/health`` and ``/api/presence`` (read-only probes the launcher
and installer make before any window exists), and the static files (the app's
own public code). A page request without the key gets a short page that says
how to open LanEx instead.
"""
from __future__ import annotations

import hmac
import os
import re
import secrets
from pathlib import Path
from typing import Optional

TOKEN_FILE = "auth-token"
QUERY_PARAM = "lanex_key"
HEADER = "X-LanEx-Key"
EXEMPT_PATHS = frozenset({"/api/health", "/api/presence"})
_TOKEN_RX = re.compile(r"[A-Za-z0-9_-]{32,128}")
# About 400 days: the longest a browser keeps a cookie.
COOKIE_MAX_AGE = 400 * 24 * 3600


def token_path() -> Path:
    from ..controller.platform_env import home

    return home() / TOKEN_FILE


def _private_and_mine(path: Path) -> bool:
    """True when *path* is a regular file only its owner can read, owned by us
    (always True on Windows, which has no such mode bits)."""
    if os.name == "nt":
        return True
    try:
        st = os.lstat(path)
    except OSError:
        return False
    import stat

    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
        return False
    return not hasattr(os, "geteuid") or st.st_uid == os.geteuid()


def _read(path: Path) -> Optional[str]:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text if _TOKEN_RX.fullmatch(text) else None


def write_private(path: Path, text: str) -> None:
    """Write *text* to *path* readable by this user only, replacing it
    atomically (a reader never sees half a file)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.unlink()
    except OSError:
        pass
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    os.replace(tmp, path)


def load_or_create(path: Optional[Path] = None) -> str:
    """The key for this LanEx home: the saved one when it is well formed and
    private, otherwise a new one (saved, mode 0600)."""
    p = path or token_path()
    tok = _read(p) if p.is_file() else None
    if tok and _private_and_mine(p):
        return tok
    if tok:
        # Readable by others: tighten it rather than trust a key that may
        # have been seen.
        tok = None
    tok = secrets.token_urlsafe(32)
    write_private(p, tok + "\n")
    return tok


def read_existing(path: Optional[Path] = None) -> Optional[str]:
    """The saved key, or None (never creates one)."""
    p = path or token_path()
    return _read(p) if p.is_file() else None


def matches(expected: Optional[str], given: Optional[str]) -> bool:
    if not expected or not given:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), given.strip().encode("utf-8"))


def cookie_name(port: int) -> str:
    # Cookies are per host, not per port: two LanEx servers on one machine
    # (8765 and 8766) must not overwrite each other's key.
    return f"lanex_key_{int(port)}"


def cookie_value(header: Optional[str], name: str) -> Optional[str]:
    """One cookie's value from a ``Cookie`` header (stdlib-free parse that
    survives other sites' malformed cookies on localhost)."""
    if not header:
        return None
    for part in header.split(";"):
        k, sep, v = part.strip().partition("=")
        if sep and k == name:
            return v.strip().strip('"')
    return None


def with_key(url: str, token: Optional[str]) -> str:
    """*url* with ``?lanex_key=<token>`` added (unchanged without a token)."""
    if not token:
        return url
    base, hash_sep, frag = url.partition("#")
    joiner = "&" if "?" in base else "?"
    return base + joiner + QUERY_PARAM + "=" + token + (hash_sep + frag if hash_sep else "")
