// configscope.js — write one setting into the project's config file where it
// takes effect. A value that a pdk::/scl:: section sets for the selected PDK
// wins over the top level (LibreLane resolves the sections first), so an edit
// of the top level alone would change nothing for that PDK (LibreLane's own
// SPM example keeps its clock in pdk::sky130*). Such an edit asks once per
// project and setting: that section only ("for sky130* only"), or every PDK
// (the top level, taken out of the sections). Used by the Design row
// (projectcard.js), Common settings (mostused.js) and All settings' "Save to
// the config" (config.js).

import { api } from "./api.js";
import { state } from "./state.js";
import { toast } from "./toast.js";

const _choice = new Map();   // "<project>\0<KEY>" -> "scope" | "all"

// The most specific section that sets the key for the selected PDK and
// library (entries as design-info reports them, each with `applies`).
export function applyingEntry(entries) {
  let best = null;
  for (const e of entries || []) {
    if (e.applies !== true) continue;
    const depth = String(e.scope || "").split(" / ").length;
    if (!best || depth >= best.depth) best = { ...e, depth };
  }
  return best;
}

// "sky130*", "sky130* with sky130_fd_sc_hs": who a section applies to.
export function sectionWho(entry) {
  const parts = String((entry && entry.scope) || "").split(" / ").map((s) => s.split("::")[1] || s);
  return parts.join(" with ") || "that PDK";
}

export function shownValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(v.every((x) => typeof x === "number") ? " " : ", ");
  return String(v);
}

// The body the save sends for a key with this applying section and choice.
export function scopeExtra(hit, how) {
  const base = { pdk: state.selectedPdk || null, scl: state.selectedScl || null };
  if (!hit) return base;
  return how === "all" ? { ...base, all_pdks: true } : { ...base, scope: String(hit.scope).split(" / ") };
}

const _asking = new Map();   // one question per key at a time
function askWhere(key, label, hit, cfgName) {
  const id = state.designDir + "\0" + key;
  if (_asking.has(id)) return _asking.get(id);
  const p = askWhereOnce(key, label, hit, cfgName).finally(() => _asking.delete(id));
  _asking.set(id, p);
  return p;
}

async function askWhereOnce(key, label, hit, cfgName) {
  const mem = _choice.get(state.designDir + "\0" + key);
  if (mem) return mem;
  const { choiceDialog } = await import("./dialog.js");
  const who = sectionWho(hit);
  const how = await choiceDialog({
    title: "Where should the " + label + " go?",
    body: cfgName + " sets " + key + " to " + shownValue(hit.value) + " in its " + hit.scope +
      " section, and that wins over the top level for " + (state.selectedPdk || "this PDK") +
      ". Change it in that section (" + who + " only), or for every PDK (the top level, and " +
      key + " comes out of every pdk::/scl:: section that sets it)?",
    choices: [{ label: "Only for " + who, value: "scope" }, { label: "For every PDK", value: "all" }],
  });
  if (how) _choice.set(state.designDir + "\0" + key, how);
  return how || null;
}

// Set (or with remove, take out) one key. `entries` are the key's pdk::/scl::
// sections from design-info. Resolves with the server's answer, null when the
// person cancelled; throws when the server refused (its words).
export async function writeSetting({ key, value, remove = false, entries = [], label = key, cfgName = "the config" }) {
  const hit = applyingEntry(entries);
  let how = null;
  if (hit) {
    how = await askWhere(key, label, hit, cfgName);
    if (!how) return null;
  }
  const r = await api.configSet(remove ? {} : { [key]: value }, remove ? [key] : [], scopeExtra(hit, how));
  // A one-off setting (All settings) of the same key would silently win over
  // what was just saved: it goes.
  if (state.varsValues && key in state.varsValues) delete state.varsValues[key];
  if (r.changed && r.changed.length) {
    const where = hit ? (how === "all" ? " for every PDK" : " (" + hit.scope + " section)") : "";
    const undo = r.undo && r.undo.backup ? { label: "Undo", run: () => undoWrite(r.undo, r.name) } : null;
    toast.show((remove ? "Removed " + key + " from " : "Saved " + key + " to ") + (r.name || "the config") + where + ".",
      "success", undo ? 6000 : 2200, undo);
  }
  return r;
}

export async function undoWrite(u, name) {
  try {
    await api.configUndo({ backup: u.backup, after: u.after });
    toast.show((name || "The config") + " is back as it was.", "success", 4000);
  } catch (ex) {
    toast.show("Undo: " + (ex.message || String(ex)), "warn", 8000);
  }
  document.dispatchEvent(new CustomEvent("g:config_changed", { detail: { from: "undo" } }));
}

export const _test = { clearChoices: () => _choice.clear() };
