# Copyright 2026 LanEx Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Paths that could destroy or leak a user's work (audit 2026-11-15, 3.1).

G1  a custom cell or macro named ``..`` (or nothing) deleted the project or
    every custom cell;
G2  a bundle's MANIFEST run tag wrote outside the project; adopt_run followed
    symlinks out of the run;
G10 opening a huge folder walked the whole tree on a request thread.
"""
from __future__ import annotations

import base64
import io
import itertools
import json
import os
import time
import zipfile
from pathlib import Path

import pytest

from lanex.controller import bundle, customcells, custommacros, fsbrowser, history, projectfiles, uploads

posix_only = pytest.mark.skipif(os.name == "nt", reason="symlinks need POSIX here")


def _project(tmp_path: Path) -> Path:
    d = tmp_path / "chip"
    (d / "src").mkdir(parents=True)
    (d / "src" / "top.v").write_text("module top; endmodule\n")
    (d / "config.json").write_text('{"DESIGN_NAME": "top"}\n')
    return d


def _lef(name: str = "c.lef") -> dict:
    return {"lef": {"filename": name, "content_b64": base64.b64encode(b"MACRO c\nEND c\n").decode()}}


# ------------------------------------------------------------------ G1 cells

@pytest.mark.parametrize("bad", ["..", ".", "...", "", "a/b", "../x", "a\\b"])
def test_custom_cell_save_refuses_unsafe_names(tmp_path, bad):
    d = _project(tmp_path)
    res = customcells.save_cell(d, bad, views=_lef())
    assert res["ok"] is False
    assert not (d / "c.lef").exists(), "a view landed in the project root"
    assert sorted(p.name for p in d.iterdir()) == ["config.json", "src"]


@pytest.mark.parametrize("bad", ["..", ".", ""])
def test_custom_cell_remove_never_deletes_the_project(tmp_path, bad):
    d = _project(tmp_path)
    assert customcells.save_cell(d, "good", views=_lef())["ok"]
    res = customcells.remove_cell(d, bad)
    assert res["ok"] is False
    assert (d / "src" / "top.v").is_file(), "the project was deleted"
    assert (d / "custom_cells" / "good" / "c.lef").is_file(), "other cells were wiped"


def test_custom_cell_legacy_unsafe_record_is_dropped_without_touching_files(tmp_path):
    d = _project(tmp_path)
    (d / ".gui-custom-cells.json").write_text(json.dumps({"cells": [{"name": "..", "views": {}}]}))
    res = customcells.remove_cell(d, "..")
    assert res == {"ok": True, "files_removed": False}
    assert (d / "src" / "top.v").is_file()
    assert customcells.list_cells(d)["cells"] == []


def test_custom_cell_remove_deletes_only_its_own_folder(tmp_path):
    d = _project(tmp_path)
    assert customcells.save_cell(d, "inv_x", views=_lef())["ok"]
    assert customcells.save_cell(d, "nand_y", views=_lef())["ok"]
    assert customcells.remove_cell(d, "inv_x")["files_removed"] is True
    assert not (d / "custom_cells" / "inv_x").exists()
    assert (d / "custom_cells" / "nand_y" / "c.lef").is_file()


@posix_only
def test_custom_cell_folder_link_loses_the_link_not_its_target(tmp_path):
    d = _project(tmp_path)
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    (d / "custom_cells").mkdir()
    (d / "custom_cells" / "x").symlink_to(outside, target_is_directory=True)
    (d / ".gui-custom-cells.json").write_text(json.dumps({"cells": [{"name": "x", "views": {}}]}))
    assert customcells.remove_cell(d, "x")["ok"]
    assert (outside / "keep.txt").is_file()
    assert not (d / "custom_cells" / "x").exists()
    # and a save never writes through such a link
    (d / "custom_cells" / "y").symlink_to(outside, target_is_directory=True)
    assert customcells.save_cell(d, "y", views=_lef())["ok"] is False
    assert not (outside / "c.lef").exists()


@posix_only
def test_custom_cells_root_linked_elsewhere_is_refused(tmp_path):
    d = _project(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (d / "custom_cells").symlink_to(outside, target_is_directory=True)
    assert customcells.save_cell(d, "good", views=_lef())["ok"] is False
    assert list(outside.iterdir()) == []


# ----------------------------------------------------------------- G1 macros

def _macro_views() -> dict:
    return {"gds": {"filename": "m.gds", "content_b64": base64.b64encode(b"GDS").decode()},
            "lef": {"filename": "m.lef", "content_b64": base64.b64encode(b"MACRO m\nEND m\n").decode()}}


@pytest.mark.parametrize("bad", ["..", ".", "", "a/b"])
def test_custom_macro_remove_never_deletes_the_project(tmp_path, bad):
    d = _project(tmp_path)
    assert custommacros.save_macro(d, "sram", views=_macro_views())["ok"]
    res = custommacros.remove_macro(d, bad)
    assert res["ok"] is False
    assert (d / "src" / "top.v").is_file(), "the project was deleted"
    assert (d / "macros" / "sram" / "m.gds").is_file()


def test_custom_macro_remove_removes_its_folder(tmp_path):
    d = _project(tmp_path)
    assert custommacros.save_macro(d, "sram", views=_macro_views())["ok"]
    assert custommacros.remove_macro(d, "sram") == {"ok": True, "files_removed": True}
    assert not (d / "macros" / "sram").exists()


def test_custom_macro_copy_corner_cannot_escape(tmp_path):
    d = _project(tmp_path)
    src = tmp_path / "m.lib"
    src.write_text("library(m) {}\n")
    res = custommacros.save_macro(d, "sram", views=_macro_views(), copies={"lib": {"../../x": str(src)}})
    assert res["ok"] is False
    assert not (tmp_path / "x").exists()


# ---------------------------------------------------------------- G16 staging

def test_staged_upload_moves_into_the_cell_folder(tmp_path):
    d = _project(tmp_path)
    blob = os.urandom(1024) * 64
    up = uploads.receive(d, "big cell.gds", io.BytesIO(blob), len(blob))
    assert up["filename"] == "big_cell.gds" and up["size"] == len(blob)
    views = {"lef": {"filename": "c.lef", "upload_id": uploads.receive(d, "c.lef", io.BytesIO(b"MACRO c\n"), 8)["upload_id"]},
             "gds": {"filename": "big cell.gds", "upload_id": up["upload_id"]}}
    res = customcells.save_cell(d, "big", views=views)
    assert res["ok"], res
    assert (d / "custom_cells" / "big" / "big_cell.gds").read_bytes() == blob
    assert not (d / uploads.UPLOAD_SUBDIR).exists(), "staging left behind"


@pytest.mark.parametrize("bad_id", ["../../etc", "x" * 32, "", None, "A" * 32])
def test_staged_rejects_ids_that_are_not_ours(tmp_path, bad_id):
    assert uploads.staged(_project(tmp_path), bad_id) is None


def test_upload_short_body_leaves_nothing(tmp_path):
    d = _project(tmp_path)
    with pytest.raises(uploads.UploadError):
        uploads.receive(d, "m.gds", io.BytesIO(b"abc"), 10)
    assert not any((d / uploads.UPLOAD_SUBDIR).glob("*/*"))


def test_upload_over_the_cap_is_refused_before_reading(tmp_path):
    d = _project(tmp_path)
    with pytest.raises(uploads.UploadError) as ei:
        uploads.receive(d, "m.gds", io.BytesIO(b""), 10, max_bytes=5)
    assert ei.value.status == 413


@pytest.mark.parametrize("name", ["", "..", ".", "a/../../..", "/"])
def test_upload_needs_a_real_file_name(tmp_path, name):
    with pytest.raises(uploads.UploadError):
        uploads.receive(_project(tmp_path), name, io.BytesIO(b"x"), 1)


def test_stale_uploads_are_pruned(tmp_path):
    d = _project(tmp_path)
    up = uploads.receive(d, "a.lef", io.BytesIO(b"x"), 1)
    folder = d / uploads.UPLOAD_SUBDIR / up["upload_id"]
    old = time.time() - 7 * 3600
    os.utime(folder, (old, old))
    uploads.prune(d)
    assert not folder.exists()


# ------------------------------------------------------------------- G2 bundle

def _zip(members: dict, *, manifest: dict | None = None, links: dict | None = None) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if manifest is not None:
            zf.writestr("MANIFEST.json", json.dumps(manifest))
        for name, data in members.items():
            zf.writestr(name, data)
        for name, target in (links or {}).items():
            info = zipfile.ZipInfo(name)
            info.external_attr = (0o120777 << 16)
            zf.writestr(info, target)
    buf.seek(0)
    return buf


@pytest.mark.parametrize("tag", ["../../../evil", "/abs/evil", "..", "a/../../b", "..\\..\\x", ""])
def test_bundle_run_tag_cannot_leave_runs(tmp_path, tag):
    d = _project(tmp_path)
    res = bundle.import_bundle(_zip({"final/metrics.json": "{}"}, manifest={"run_tag": tag}), d)
    dest = d / "runs" / res["tag"]
    assert dest.is_dir()
    assert dest.resolve().parent == (d / "runs").resolve()
    assert "/" not in res["tag"] and not res["tag"].startswith(".")
    assert not (tmp_path / "evil-imported").exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["chip"]


def test_bundle_symlink_members_are_skipped(tmp_path):
    d = _project(tmp_path)
    res = bundle.import_bundle(_zip({"final/metrics.json": "{}"}, manifest={"run_tag": "r1"},
                                    links={"final/evil": "/etc/passwd"}), d)
    dest = d / "runs" / res["tag"]
    assert (dest / "final" / "metrics.json").is_file()
    assert not (dest / "final" / "evil").exists()


def test_bundle_member_count_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle, "IMPORT_MAX_MEMBERS", 5)
    d = _project(tmp_path)
    with pytest.raises(ValueError, match="at most 5"):
        bundle.import_bundle(_zip({f"f{i}.txt": "x" for i in range(10)}), d)
    assert not any((d / "runs").iterdir())


def test_bundle_unpacked_size_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(bundle, "IMPORT_MAX_BYTES", 1000)
    d = _project(tmp_path)
    with pytest.raises(ValueError, match="unpacks"):
        bundle.import_bundle(_zip({"big.bin": b"\0" * 5000}), d)
    assert not any((d / "runs").iterdir())


def test_bundle_unpacked_size_is_counted_when_headers_lie(tmp_path, monkeypatch):
    # A crafted zip can claim tiny sizes in its directory: zipfile then stops
    # at the claimed size and fails the CRC, the count of bytes written is a
    # second guard; either way the import is refused and nothing is left.
    monkeypatch.setattr(bundle, "IMPORT_MAX_BYTES", 1000)
    real = zipfile.ZipFile.infolist

    def lying(self):
        infos = real(self)
        for i in infos:
            i.file_size = 1
        return infos
    monkeypatch.setattr(zipfile.ZipFile, "infolist", lying)
    d = _project(tmp_path)
    with pytest.raises(ValueError, match="damaged|unpacks"):
        bundle.import_bundle(_zip({"a.bin": b"\0" * 600, "b.bin": b"\0" * 600}), d)
    assert not any((d / "runs").iterdir()), "a half-imported run was left behind"


def test_bundle_zip_slip_member_still_dropped(tmp_path):
    d = _project(tmp_path)
    res = bundle.import_bundle(_zip({"../../escape.txt": "x", "final/metrics.json": "{}"},
                                    manifest={"run_tag": "ok"}), d)
    assert res["tag"] == "ok-imported"
    assert not (tmp_path / "escape.txt").exists()


def test_safe_run_tag():
    assert bundle.safe_run_tag("RUN_2026-11-22_10-00-00") == "RUN_2026-11-22_10-00-00"
    assert bundle.safe_run_tag("../x") == "x"
    assert bundle.safe_run_tag(r"..\..\x") == "x"
    assert bundle.safe_run_tag("..") == "bundle"
    assert bundle.safe_run_tag(None) == "bundle"
    assert len(bundle.safe_run_tag("a" * 500)) == 100


# ------------------------------------------------------------------ adopt_run

@posix_only
def test_adopt_run_does_not_follow_links_out_of_the_run(tmp_path):
    d = _project(tmp_path)
    src = tmp_path / "ext-run"
    (src / "final").mkdir(parents=True)
    (src / "final" / "metrics.json").write_text("{}")
    (src / "resolved.json").write_text("{}")
    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "id_rsa").write_text("PRIVATE")
    (src / "home").symlink_to(secret, target_is_directory=True)        # out of the run
    (src / "abs-inside").symlink_to(src / "final")                      # absolute, even if inside
    (src / "dangling").symlink_to(tmp_path / "nope")
    (src / "final" / "m2.json").symlink_to("metrics.json")              # relative, inside: kept
    (src / "loop").symlink_to(src, target_is_directory=True)            # would recurse forever
    res = history.adopt_run(src, d)
    dest = Path(res["run_dir"])
    assert (dest / "final" / "metrics.json").is_file()
    assert not (dest / "home").exists() and not (dest / "home").is_symlink()
    assert not (dest / "loop").exists() and not (dest / "loop").is_symlink()
    assert not (dest / "dangling").is_symlink()
    assert not (dest / "abs-inside").is_symlink()
    assert (dest / "final" / "m2.json").is_symlink()
    assert (dest / "final" / "m2.json").resolve() == (dest / "final" / "metrics.json").resolve()
    assert res["skipped_links"] == 4
    marker = json.loads((dest / "gui-imported.json").read_text())
    assert "home" in marker["skipped_links"]


# ----------------------------------------------------------------------- G10

def test_bounded_walk_stops_at_the_file_limit(tmp_path):
    for i in range(30):
        sub = tmp_path / f"d{i:02d}"
        sub.mkdir()
        for j in range(10):
            (sub / f"f{j}.v").write_text("")
    walk = fsbrowser.BoundedWalk(tmp_path, max_files=25)
    seen = list(walk)
    assert len(seen) == 25 and walk.truncated


def test_bounded_walk_honours_the_time_budget(tmp_path, monkeypatch):
    for i in range(5):
        (tmp_path / f"d{i}").mkdir()
        (tmp_path / f"d{i}" / "a.v").write_text("")
    clock = itertools.count(0, 10)
    monkeypatch.setattr(fsbrowser.time, "monotonic", lambda: float(next(clock)))
    walk = fsbrowser.BoundedWalk(tmp_path, budget_s=5)
    list(walk)
    assert walk.truncated


def test_bounded_walk_skips_hidden_and_named_dirs(tmp_path):
    for name in (".git", ".cache", "runs", "src"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "x.v").write_text("")
    got = {Path(r).name for r, _f in fsbrowser.BoundedWalk(tmp_path, skip_dirs={"runs"})}
    assert got == {"src"}


def test_walk_sources_returns_at_the_limit_on_a_huge_tree(tmp_path):
    for i in range(50):
        sub = tmp_path / f"m{i:02d}"
        sub.mkdir()
        for j in range(20):
            (sub / f"f{j}.v").write_text("")
    t0 = time.monotonic()
    res = fsbrowser.walk_sources(str(tmp_path), max_results=10)
    assert res["ok"] and res["total"] == 10 and res["truncated"] is True
    assert time.monotonic() - t0 < 5


def test_project_files_are_bounded_too(tmp_path):
    d = _project(tmp_path)
    for i in range(40):
        (d / "src" / f"m{i}.v").write_text("")
    res = projectfiles.list_files(d, max_files=5)
    assert len(res["files"]) == 5 and res["truncated"] is True
