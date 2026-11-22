"""Subprocess entry adapter for LibreLane with digest-aware image lookup.

LibreLane 3.0.4 uses ``docker images <reference>`` to detect an image, which fails
to match digest-qualified references (e.g. repo:tag@sha256:...). This wrapper applies
an inspect-based fallback so present digest-pinned images are reused without
unnecessary registry network calls.
"""
from __future__ import annotations

import subprocess
import sys


def _patch_librelane_container() -> None:
    try:
        import librelane.container

        orig_image_exists = librelane.container.image_exists

        def _digest_aware_image_exists(ce_path: str, image: str) -> bool:
            if orig_image_exists(ce_path, image):
                return True
            try:
                # Docker / Podman inspect works directly with digest references.
                res = subprocess.run(
                    [ce_path, "image", "inspect", image],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                return res.returncode == 0
            except Exception:
                return False

        librelane.container.image_exists = _digest_aware_image_exists
    except Exception:
        pass


def _name_the_container() -> None:
    """Give LibreLane's container the name LanEx chose (``LANEX_CONTAINER_NAME``).

    ``run_in_container`` names it ``str(uuid.uuid4())`` and prints the command
    only to a buffered stdout that ``os.execlp`` throws away, so the name was
    never known and Stop had to guess which container was the flow's. With the
    name set here, Stop removes exactly this container (runner._kill_container).
    """
    import os
    import re
    import types

    name = os.environ.get("LANEX_CONTAINER_NAME") or ""
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", name):
        return
    try:
        import librelane.container

        librelane.container.uuid = types.SimpleNamespace(uuid4=lambda: name)  # type: ignore[attr-defined]
    except Exception:
        pass


def main() -> int:
    _patch_librelane_container()
    _name_the_container()
    from librelane.__main__ import cli
    try:
        cli()
        return 0
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (1 if exc.code else 0)


if __name__ == "__main__":
    sys.exit(main())
