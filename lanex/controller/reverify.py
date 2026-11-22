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
"""Targeted re-verification (Phase 2.A): re-run a single signoff step.

Re-running just ``Magic.DRC`` or ``OpenROAD.STAPostPNR`` against an existing run
takes seconds instead of a full RTL→GDS. The re-run is a new run resumed from
the old one (``plan_rerun``), never a write into the finished run:

* it starts from the old run's last saved state (``-i <its last
  state_out.json> --from STEP --to STEP``), so the step reads the old run's
  layout and every later metric stays as it was;
* it runs with the old run's flow, PDK, library and settings "for this run
  only", and a setting the config file changed since is pinned back to the
  value the old run used, so only what the user asks for differs;
* the changes come as ``{setting: value}``, each checked against the
  variable's own type (a list stays a list);
* a run made with another LibreLane, image or PDK is refused (``branch``).

The actual execution goes through the existing :class:`runner.FlowRunner`
(container or local), started like a fix-loop resume.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import branch, configedit, flowstages, history, introspect


class RerunError(Exception):
    """A re-run that can't be planned (no such step, run or saved state)."""


@lru_cache(maxsize=1)
def _known_step_ids() -> frozenset:
    return frozenset(s["id"] for s in introspect.list_steps())


@lru_cache(maxsize=1)
def _known_var_names() -> frozenset:
    return frozenset(v["name"] for v in introspect.list_variables())


def validate(step_id: str, overrides: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Reject unknown steps and unknown override variables (so a bad var can
    never be injected into a re-run). Returns ``{ok}`` or ``{ok: False, error}``.
    Skips a check only when introspection is unavailable (no librelane)."""
    steps = _known_step_ids()
    if steps and step_id not in steps:
        return {"ok": False, "error": f"unknown step id '{step_id}'"}
    names = _known_var_names()
    if names:
        for k in (overrides or {}):
            if k not in names:
                return {"ok": False, "error": f"unknown config variable '{k}'"}
    return {"ok": True}


def plan_rerun(design_dir: str | Path, tag: str, step_id: str, sets: Optional[Dict[str, Any]] = None,
               *, new_tag: Optional[str] = None) -> Dict[str, Any]:
    """What re-running *step_id* of run *tag* would do (module doc). Changes
    nothing. ``{ok, blocked, tag, step, stage, parent, state, overrides,
    changes, pinned, notes, branched_from}``."""
    design_dir = Path(design_dir)
    run_dir = design_dir / "runs" / str(tag or "")
    if not tag or "/" in tag or "\\" in tag or not run_dir.is_dir():
        raise RerunError(f"There is no run '{tag}' in this project.")
    if new_tag and (design_dir / "runs" / new_tag).exists():
        raise RerunError(f"A run named '{new_tag}' exists already.")
    info = branch.run_info(run_dir)
    info["gui"].setdefault("tag", tag)
    flow = info["flow"]
    steps = [s["id"] for s in introspect.flow_steps(flow)]
    if steps and step_id not in steps:
        raise RerunError(f"{step_id} isn't a step of the {flow} flow {tag} ran.")
    known = branch._vars()
    sets = dict(sets or {})
    values: Dict[str, Any] = {}
    for var, raw in sets.items():
        if known and var not in known:
            raise RerunError(f"{var} isn't a setting this LibreLane knows.")
        try:
            values[var] = branch.coerce(raw, dict(known.get(var) or {}, name=var))
        except branch.BranchError as ex:
            raise RerunError(str(ex)) from None
    # The step reads the old run's results as they ended: its newest state.
    lineage = history.lineage_steps(run_dir)
    state = branch.state_before(lineage, steps, len(steps)) if steps else None
    if state is None:
        raise RerunError(f"{tag} saved no results to re-run {step_id} on.")
    blocked = None
    gone = branch.missing_paths(state["path"])
    if gone:
        blocked = f"Files {tag} needs for the re-run are gone ({gone[0]})."
    vdrift = branch.version_drift(info)
    if vdrift and blocked is None:
        blocked = (f"{tag} was made with other tools than a re-run now would use ("
                   + "; ".join("%s %s then, %s now" % (d["label"], branch._short(d["was"]), branch._short(d["now"]))
                               for d in vdrift)
                   + "). The re-run reads its results, so one run would mix the two: run the whole flow again instead.")
    # The old run's settings: its own -c values, and every value the config
    # file changed since pinned back to what it used.
    cfg_info = configedit.read_config(design_dir)
    cfg = cfg_info.get("data") or {}
    pinned = branch.changed_settings(cfg, info, sets, set(known) if known else None)
    overrides = {k: v for k, v in info["overrides"].items() if k not in sets}
    for d in pinned:
        overrides[d["var"]] = d["was"]
    for var, v in values.items():
        overrides[var] = branch.show(v)
    files = branch.changed_files(run_dir, info["resolved"], design_dir, state["path"].stat().st_mtime)
    notes = ["%s changed after %s ran; the re-run reads it as it is now (%s)." % (f["path"], tag, ", ".join(f["vars"]))
             for f in files]
    stage = flowstages.stages_of(steps)[steps.index(step_id)] if steps else None
    changes = [{"var": var, "from": branch.show(info["resolved"].get(var)), "to": branch.show(v), "saved": "run"}
               for var, v in values.items()]
    rel = state["path"].relative_to(design_dir).as_posix()
    out_tag = new_tag or branch._new_tag(design_dir / "runs", tag)
    return {
        "ok": blocked is None, "blocked": blocked, "tag": out_tag, "step": step_id, "stage": stage,
        "parent": {"tag": tag, "flow": flow, "pdk": info["pdk"], "scl": info["scl"]},
        "state": rel, "state_step": state["step"], "overrides": overrides, "changes": changes,
        "pinned": pinned, "notes": notes, "versions": vdrift,
        "sources": list(info["gui"].get("sources") or []), "extras": list(info["gui"].get("extras") or []),
        "branched_from": {"tag": tag, "step": step_id, "stage": stage, "state": rel, "changes": changes,
                          "rerun": True},
    }


