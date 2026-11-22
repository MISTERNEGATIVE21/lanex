// config.js — All settings: every LibreLane variable by flow stage, and the
// one-off settings a run from LanEx sends with it.
//
// One model with the config file at its centre:
// - Each field shows the value a run gets NOW: the one-off setting when there
//   is one, else what the project's config sets for the selected PDK (the
//   most specific pdk::/scl:: section wins, as in LibreLane), else
//   LibreLane's default. So touching a field never silently replaces the
//   file's value with the default.
// - A change here is a one-off setting (state.varsValues): it goes with runs
//   started from LanEx as a -c override and is never written into the file.
//   Every one-off setting is shown as a chip next to Run (paintOneOffChip), so
//   nothing can reach a run unseen. They are kept per project (G13) and stay
//   until cleared. A one-off can be saved into the config from its trail.
// - Rows are built once per variable list; search, the "Show" filter and
//   value changes update them in place.

import { api, fmt } from "./api.js";
import { state, safeStorage } from "./state.js";
import { toast } from "./toast.js";
import { wireJumpNav } from "./jumpnav.js";

const STAGE_GROUPS = [
  {
    id: "pdk",
    name: "Tech / PDK",
    description: "Process design kit version, standard cell library, IO pads.",
    pdk_only: true,
  },
  {
    id: "synth",
    name: "Synthesis",
    description: "Yosys: how aggressively to optimise for delay vs area vs power.",
    keys: ["SYNTH_", "YOSYS_", "VERILOG_", "EXTRA_VERILOG_"],
  },
  {
    id: "lint",
    name: "Linting",
    description: "Verilator static checks (latch inference, blocking in always_ff, widths).",
    keys: ["LINT_"],
  },
  {
    id: "floorplan",
    name: "Floorplan",
    description: "Die/core area, utilisation, aspect ratio, macro placement.",
    keys: ["FP_"],
  },
  {
    id: "pdn",
    name: "Power Delivery",
    description: "Strap widths / spacing on the VDD/VSS grid.",
    keys: ["PDN_"],
  },
  {
    id: "placement",
    name: "Placement",
    description: "Where standard cells go (global + detailed placement).",
    keys: ["PL_", "GLOBAL_PLACEMENT", "PLACE_", "IO_"],
  },
  {
    id: "cts",
    name: "Clock Tree",
    description: "Clock buffer insertion strategy, CTS branch allowance, target skew.",
    keys: ["CTS_", "CLOCK_"],
  },
  {
    id: "antenna",
    name: "Antenna & Diodes",
    description: "Charge-discharge protection on long routes.",
    keys: ["DIODE_", "ANTENNA_"],
  },
  {
    id: "routing",
    name: "Routing",
    description: "Global + detailed router settings; design-rule-aware.",
    keys: ["RT_", "ROUTING_"],
  },
  {
    id: "sta",
    name: "Static Timing",
    description: "STA corners, slack targets, clock periods, hold/setup expectations.",
    keys: ["STA_", "TIMING_", "RCX_"],
  },
  {
    id: "signoff",
    name: "Signoff",
    description: "DRC, LVS, XOR, IR drop, and density reports generated at flow signoff.",
    // NB: no "LVS_" here — LVS_* vars belong to the dedicated "lvs" group below.
    // Listing it in both made the first-match win send every LVS_* to Signoff and
    // left the LVS group empty (B5).
    keys: ["DRC_", "XOR_", "KI_", "MAGIC_"],
  },
  {
    id: "lvs",
    name: "LVS",
    description: "Layout-vs-Schematic verification.",
    keys: ["LVS_"],
  },
  {
    id: "ir",
    name: "IR Drop",
    description: "Voltage drop on the power grid.",
    keys: ["IR_"],
  },
  {
    id: "clockgating",
    name: "Clock gating / retention",
    description: "Optional low-power cells (sky130 hs variants etc).",
    keys: ["CLOCK_GATING", "RETENTION"],
  },
  {
    id: "misc",
    name: "Misc",
    description: "Log thresholds, exporter options, and other rare knobs.",
    keys: [],
  },
];

// Presets only set REAL LibreLane variables (verified against the live
// variable registry). PL_TARGET_DENSITY_PCT is a percentage (0–100), FP_CORE_UTIL
// is a percentage, SYNTH_STRATEGY is the Literal 'AREA n' / 'DELAY n', and
// DIODE_ON_PORTS is the Literal 'none|in|out|both'. "Clear" drops every
// one-off setting, so each field is back to what the config file sets.
const PRESETS = {
  default: {
    label: "Clear",
    reset: true,
    values: {},
  },
  lowpower: {
    // Honest label: these are AREA-optimising knobs. Smaller area tends to lower
    // dynamic power (shorter wires), but LibreLane 3.0.4 has no direct
    // power-driven synthesis strategy — calling it "Low Power" overstated it (B2).
    label: "Area-lean (lower power)",
    values: {
      SYNTH_STRATEGY: "AREA 2",
      FP_CORE_UTIL: 40,
      PL_TARGET_DENSITY_PCT: 55,
    },
  },
  perfpush: {
    label: "Performance",
    values: {
      SYNTH_STRATEGY: "DELAY 3",
      FP_CORE_UTIL: 60,
      PL_TARGET_DENSITY_PCT: 60,
    },
  },
  minimalarea: {
    label: "Min area",
    values: {
      SYNTH_STRATEGY: "AREA 3",
      FP_CORE_UTIL: 70,
      PL_TARGET_DENSITY_PCT: 78,
    },
  },
  antenna: {
    label: "Antenna-hardened",
    values: {
      DIODE_ON_PORTS: "both",
      // 5 > the LibreLane default of 3 — a genuinely stronger antenna-repair
      // pass. (At the default value this preset member was a no-op, B1.)
      GRT_ANTENNA_REPAIR_ITERS: 5,
    },
  },
};

// Picked in Setup's PDK card and always sent from there: never a one-off.
const PLUMBING = new Set(["PDK", "STD_CELL_LIBRARY"]);

function groupFor(name, v) {
  if (v?.pdk && STAGE_GROUPS[0].pdk_only) return "pdk";
  // Longest-matching-key wins, NOT first-match. First-match sent e.g.
  // CLOCK_GATING_* to "Clock Tree" (it matched the shorter "CLOCK_") instead of
  // "Clock gating" (B5). The LVS/Signoff duplicate is fixed at the data level
  // above (only the lvs group carries "LVS_").
  const upper = name.toUpperCase();
  let best = null, bestLen = 0;
  for (const g of STAGE_GROUPS) {
    for (const k of (g.keys || [])) {
      const ku = k.toUpperCase();
      if (upper.includes(ku) && ku.length > bestLen) {
        best = g.id;
        bestLen = ku.length;
      }
    }
  }
  return best || "misc";
}

// ---------------------------------------------------------------- values (pure)

export function shownValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(shownValue).join(v.every((x) => typeof x === "number" || /^-?[\d.]+$/.test(String(x))) ? " " : ", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const NUM_RX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function listItems(s) {
  return (s.includes(",") ? s.split(",") : s.split(/\s+/)).map((x) => x.trim()).filter(Boolean);
}

// A field's text as the value a run would send, by the variable's kind
// (introspect.py: bool, int, number, numbers, choice, list, path, dict, text).
// {empty} for a blank field, {error} for a value LibreLane would refuse, else
// {value} (a string the server passes as -c, or a boolean).
export function parseValue(v, raw) {
  const s = String(raw == null ? "" : raw).trim();
  const name = (v && v.name) || "This setting";
  const kind = (v && v.kind) || (v && /bool/i.test(v.type || "") ? "bool" : "text");
  if (s === "") return { empty: true };
  if (kind === "bool") {
    if (/^(true|1|yes|on)$/i.test(s)) return { value: true };
    if (/^(false|0|no|off)$/i.test(s)) return { value: false };
    return { error: name + " is true or false." };
  }
  if (kind === "int") {
    if (!/^[+-]?\d+$/.test(s)) return { error: name + " takes a whole number." };
    return { value: String(parseInt(s, 10)) };
  }
  if (kind === "number") {
    if (!NUM_RX.test(s)) return { error: name + " takes a number" + (v.units ? " (" + v.units + ")" : "") + "." };
    return { value: s };
  }
  if (kind === "numbers") {
    const parts = s.replace(/^[[(]|[\])]$/g, "").split(/[\s,]+/).filter(Boolean);
    if (!parts.length || parts.some((p) => !NUM_RX.test(p))) return { error: name + " takes numbers, separated by spaces (like 0 0 200 200)." };
    return { value: parts.join(" ") };
  }
  if (kind === "choice") {
    const choices = (v.choices || []).map(String);
    if (choices.length && !choices.includes(s)) return { error: name + " is one of " + choices.join(", ") + "." };
    return { value: s };
  }
  if (kind === "list") {
    const items = listItems(s);
    if (!items.length) return { empty: true };
    return { value: items.some((x) => /\s/.test(x)) ? items.join(",") : items.join(" ") };
  }
  if (kind === "dict") {
    try {
      const o = JSON.parse(s);
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    } catch (_e) {
      return { error: name + " is a JSON object, like {\"key\": \"value\"}." };
    }
    return { value: s };
  }
  return { value: s };
}

// True when a parsed field value is the value the run gets without it, so
// it isn't a one-off setting at all.
export function sameValue(v, value, baseText) {
  if (baseText === "" || baseText === undefined || baseText === null) return false;
  const b = parseValue(v, baseText);
  if (b.error || b.empty) return false;
  const kind = (v && v.kind) || "text";
  if (kind === "int" || kind === "number") return Number(value) === Number(b.value);
  if (kind === "numbers") {
    const x = String(value).split(" ").map(Number), y = String(b.value).split(" ").map(Number);
    return x.length === y.length && x.every((n, i) => n === y[i]);
  }
  if (kind === "list") return listItems(String(value)).join("\0") === listItems(String(b.value)).join("\0");
  return String(value) === String(b.value);
}

// ---------------------------------------------------------------- module state

let _wired = false;
let _builtFor = null;          // the variables array the rows were built from
const _rows = new Map();       // name -> { v, row, input, src, err, reset }
const _groups = [];            // { def, heading, hint, grid, chip, names }
let _search = "";
let _show = "all";             // all | file | oneoff
let _eff = { dir: null, key: "", map: {}, name: null, loaded: false };
let _effSeq = 0;

// ---------------------------------------------------------------- one-off settings per project (G13)

const _byProject = new Map();  // project dir -> its one-off settings
let _ovDir = null;

// The project in view changed: keep the last one's one-off settings with it
// and bring this one's back (none for a project not opened before). A
// one-off setting never follows the person into another project.
export function switchOverridesTo(dir) {
  const next = dir || "";
  if (_ovDir === next) return;
  if (_ovDir !== null && _ovDir !== "") {
    const cur = activeOverrides();
    if (Object.keys(cur).length) _byProject.set(_ovDir, cur); else _byProject.delete(_ovDir);
  }
  _ovDir = next;
  state.varsValues = Object.assign({}, (next && _byProject.get(next)) || {});
  // The last project's config values are not this one's; they are read
  // again once the server has this project open (setup.js).
  _eff = { dir: null, key: "", map: {}, name: null, loaded: false };
}

// What will actually be sent to the engine besides the PDK picks: every
// one-off setting with a value.
export function activeOverrides() {
  const out = {};
  for (const [k, v] of Object.entries(state.varsValues || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

// The one-off settings shown next to Run: everything sent with the run that
// Setup's PDK card didn't pick.
export function oneOffSettings(values = state.varsValues) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (PLUMBING.has(k) || v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- effective values

function effKey() { return [state.designDir || "", state.selectedPdk || "", state.selectedScl || ""].join("\0"); }

export async function refreshEffective({ force = false } = {}) {
  const key = effKey();
  if (!force && _eff.loaded && _eff.key === key) return _eff;
  const seq = ++_effSeq;
  let next = { dir: state.designDir || null, key, map: {}, name: null, editable: false, loaded: true };
  if (state.designDir) {
    try {
      const r = await api.designInfo({ effective: true, pdk: state.selectedPdk || null, scl: state.selectedScl || null });
      next = { ...next, map: (r && r.effective) || {}, name: (r && r.config && r.config.name) || null,
        editable: !!(r && r.config && r.config.editable) };
    } catch (_e) { /* no config to read: defaults only */ }
  }
  if (seq !== _effSeq) return _eff;
  _eff = next;
  paintFileName();
  refreshRows();
  renderOverridesSummary();
  return _eff;
}

function cfgName() { return _eff.name || "the config"; }

// The value a run gets without a one-off setting, and where it comes from.
function baseOf(v) {
  const e = _eff.map[v.name];
  if (e) return { text: shownValue(e.value), from: "config", scope: e.scope || null };
  const d = v.default;
  if (d !== undefined && d !== null && shownValue(d) !== "") return { text: shownValue(d), from: "default" };
  return { text: "", from: v.pdk ? "pdk" : "none" };
}

function hasOverride(name) {
  const ov = (state.varsValues || {})[name];
  return ov !== undefined && ov !== null && !(typeof ov === "string" && ov.trim() === "");
}

// ---------------------------------------------------------------- render

export function renderConfig() {
  const root = document.getElementById("vars-form");
  if (!root) return;
  wireOnce();
  build();
  refreshEffective();
  syncReportToggles();
  renderOverridesSummary();
  paintOneOffChip();
}

function wireOnce() {
  if (_wired) return;
  _wired = true;
  const search = document.getElementById("var-search");
  let t = 0;
  search?.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { _search = search.value.trim().toUpperCase(); applyFilter(); }, 120);
  });
  const show = document.getElementById("var-show");
  show?.addEventListener("change", () => { _show = show.value || "all"; applyFilter(); });
  // The preset chips of this card only: the jump links elsewhere share the
  // chip classes. Wired once, so a preset click opens one dialog however
  // often the config changed.
  document.querySelectorAll("#cfg-card [data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => onPreset(btn));
  });
  const saveBtn = document.getElementById("config-save-preset");
  saveBtn?.addEventListener("click", onSavePreset);
  paintUserPresets();
  // Quick SYNTH_SHOW toggle (surfaces the most-asked-for diagram knob without
  // hunting the full variable list). Drives the same one-off setting the form would.
  const ss = document.getElementById("cfg-synth-show");
  ss?.addEventListener("change", () => {
    const v = (state.variables || []).find((x) => x.name === "SYNTH_SHOW") || { name: "SYNTH_SHOW", kind: "bool" };
    setOneOff(v, ss.checked);
  });
  // Any change to the one-off settings, from any page (a run's settings
  // loaded from Runs, a sweep's "Use this", a save that dropped one).
  document.addEventListener("g:overrides_changed", () => {
    refreshRows();
    syncReportToggles();
    renderOverridesSummary();
    paintOneOffChip();
  });
  document.addEventListener("g:config_changed", (e) => {
    const d = (e && e.detail) || {};
    // The fix sheet saved these into the config: a one-off of the same key
    // would win over it on the next Run and bring the error back.
    if (d.from === "fixsheet" && Array.isArray(d.keys)) {
      for (const k of d.keys) if (state.varsValues && k in state.varsValues) delete state.varsValues[k];
    }
    refreshEffective({ force: true });
  });
  document.addEventListener("g:pdk_confirmed", () => refreshEffective());
}

function build() {
  const root = document.getElementById("vars-form");
  const nav = document.getElementById("config-nav");
  if (!root || !nav) return;
  const vars = state.variables || [];
  if (_builtFor === vars && _rows.size) return;
  _builtFor = vars;
  _rows.clear();
  _groups.length = 0;
  root.innerHTML = "";
  nav.innerHTML = "";
  const buckets = new Map(STAGE_GROUPS.map((g) => [g.id, []]));
  for (const v of [...vars].sort((a, b) => a.name.localeCompare(b.name))) buckets.get(groupFor(v.name, v)).push(v);
  for (const [stageId, vs] of buckets) {
    if (!vs.length) continue;
    const def = STAGE_GROUPS.find((g) => g.id === stageId);
    const heading = document.createElement("h3");
    heading.id = "cfg-section-" + stageId;
    heading.className = "config-anchor";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.marginBottom = "var(--s-3)";
    hint.textContent = def.description || "";
    // Category tabs; jumpnav's scroll-spy underlines the one in view.
    const chip = document.createElement("button");
    chip.className = "nav-chip";
    chip.type = "button";
    chip.dataset.jump = heading.id;
    nav.appendChild(chip);
    const grid = document.createElement("div");
    grid.className = "vars-form";
    for (const v of vs) grid.appendChild(buildRow(v));
    root.appendChild(heading);
    if (def.description) root.appendChild(hint);
    root.appendChild(grid);
    _groups.push({ def, heading, hint, grid, chip, names: vs.map((v) => v.name) });
  }
  const empty = document.createElement("p");
  empty.className = "muted";
  empty.id = "vars-empty";
  empty.hidden = true;
  root.appendChild(empty);
  wireJumpNav(nav);
  refreshRows();
  applyFilter();
}

function inputHtml(v, id) {
  const kind = v.kind || (/bool/i.test(v.type || "") ? "bool" : "text");
  if (kind === "bool") {
    return "<select id='" + id + "'><option value=''>(not set)</option><option value='true'>true</option><option value='false'>false</option></select>";
  }
  // Literal / Enum variables expose their allowed values in `choices` (from the
  // backend's typing introspection): a real dropdown, so no invalid value.
  if (Array.isArray(v.choices) && v.choices.length) {
    return "<select id='" + id + "'><option value=''>(not set)</option>" +
      v.choices.map((s) => "<option value='" + fmt.escape(s) + "'>" + fmt.escape(s) + "</option>").join("") + "</select>";
  }
  const ph = kind === "numbers" ? "numbers, like 0 0 200 200" : kind === "list" ? "values, separated by spaces or commas" : "";
  return "<input type='text' id='" + id + "' spellcheck='false' autocomplete='off' placeholder='" + fmt.escape(ph) + "' />";
}

function buildRow(v) {
  const row = document.createElement("div");
  row.className = "var-row";
  row.dataset.var = v.name;
  const id = "var-" + v.name;
  // B4: LibreLane's own default for every field, so a value is never
  // mistaken for something the user typed. No default = required or
  // derived from the PDK/flow, which is itself information.
  const defStr = shownValue(v.default);
  const defaultChip = defStr !== ""
    ? "<span class='vdefault' title='LibreLane default'>default: " + fmt.escape(defStr) + "</span>"
    : "<span class='vdefault vdefault-none' title='No LibreLane default (required, or derived from the PDK/flow)'>no default</span>";
  row.innerHTML =
    "<div class='vname'>" +
    "<span class='name'>" + fmt.escape(v.name) + "</span>" +
    (v.type ? "<span class='type'>" + fmt.escape(v.type) + "</span>" : "") +
    (v.pdk ? "<span class='flag'>PDK</span>" : "") +
    (v.units ? "<span class='units'>" + fmt.escape(v.units) + "</span>" : "") +
    defaultChip +
    "</div>" +
    "<div class='vdesc'>" + fmt.escape(v.description || "") + "</div>" +
    inputHtml(v, id) +
    "<small class='var-err' role='alert' hidden></small>" +
    "<button type='button' class='var-reset' title='Drop this one-off setting' aria-label='Drop the one-off setting of " +
      fmt.escape(v.name) + "' hidden>↺</button>";
  const input = row.querySelector("#" + cssEscape(id));
  const reset = row.querySelector(".var-reset");
  const err = row.querySelector(".var-err");
  // A config chip goes before the default chip: the file's value is what a
  // run gets, the default is what it would get without it.
  const src = document.createElement("button");
  src.type = "button";
  src.className = "vconfig";
  src.hidden = true;
  src.addEventListener("click", async () => {
    const prov = await import("./provenance.js");
    prov.openProvenance({ kind: "input", key: v.name }, { title: "Your config's own " + v.name + " line" });
  });
  row.querySelector(".vdefault")?.before(src);
  // A text field commits on change (Enter or leaving it), never per keystroke.
  input?.addEventListener("change", () => setOneOff(v, input.value, { from: "field" }));
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.tagName === "INPUT") input.blur(); });
  reset?.addEventListener("click", () => { delete state.varsValues[v.name]; setErr(v.name, ""); });
  _rows.set(v.name, { v, row, input, src, err, reset });
  return row;
}

function setErr(name, text) {
  const r = _rows.get(name);
  if (!r) return;
  r.err.textContent = text;
  r.err.hidden = !text;
  r.row.classList.toggle("is-invalid", !!text);
}

// Set or drop one one-off setting from a field's text (or a boolean).
function setOneOff(v, raw, { from = "" } = {}) {
  const p = typeof raw === "boolean" ? { value: raw } : parseValue(v, raw);
  if (p.empty) { delete state.varsValues[v.name]; setErr(v.name, ""); refreshRow(v.name, { force: true }); return; }
  if (p.error) {
    const base = baseOf(v);
    setErr(v.name, "Not used: " + p.error + (hasOverride(v.name) ? " Runs keep " + shownValue(state.varsValues[v.name]) + "." :
      base.text ? " Runs keep " + base.text + "." : ""));
    return;
  }
  setErr(v.name, "");
  if (sameValue(v, p.value, baseOf(v).text)) delete state.varsValues[v.name];
  else state.varsValues[v.name] = p.value;
  if (from === "field") refreshRow(v.name, { force: true });
}

function refreshRow(name, { force = false } = {}) {
  const r = _rows.get(name);
  if (!r) return;
  const base = baseOf(r.v);
  const has = hasOverride(name);
  const cur = has ? shownValue(state.varsValues[name]) : base.text;
  if (r.input && (force || document.activeElement !== r.input) && !r.row.classList.contains("is-invalid")) {
    if (r.input.tagName === "SELECT") {
      if (cur && ![...r.input.options].some((o) => o.value === cur)) {
        const o = document.createElement("option");
        o.value = cur; o.textContent = cur;
        r.input.appendChild(o);
      }
      r.input.value = cur;
    } else {
      r.input.value = cur;
    }
  }
  r.row.classList.toggle("modified", has);
  r.reset.hidden = !has;
  r.src.hidden = base.from !== "config";
  if (base.from === "config") {
    const where = base.scope ? cfgName() + " " + base.scope.join(" / ") : cfgName();
    r.src.textContent = where + ": " + base.text;
    r.src.classList.toggle("vconfig-scoped", !!base.scope);
    r.src.title = (base.scope
      ? "Set in the " + base.scope.join(" / ") + " section of " + cfgName() + ", which applies to the selected PDK."
      : "Set in " + cfgName() + ".") + (has ? " This run's one-off setting replaces it." : "") + " Click to open the file at that line.";
  }
}

function refreshRows() {
  for (const name of _rows.keys()) refreshRow(name);
  if (_show !== "all") applyFilter();
}

function rowVisible(name) {
  const r = _rows.get(name);
  if (!r) return false;
  if (_search && !name.toUpperCase().includes(_search) && !(r.v.description || "").toUpperCase().includes(_search)) return false;
  if (_show === "oneoff") return hasOverride(name);
  if (_show === "file") return !!_eff.map[name];
  return true;
}

function applyFilter() {
  let total = 0;
  for (const g of _groups) {
    let n = 0;
    for (const name of g.names) {
      const vis = rowVisible(name);
      _rows.get(name).row.hidden = !vis;
      if (vis) n++;
    }
    total += n;
    g.heading.textContent = g.def.name + " · " + n;
    g.heading.hidden = g.hint.hidden = g.grid.hidden = !n;
    g.chip.hidden = !n;
    g.chip.innerHTML = fmt.escape(g.def.name) + " <span class='nav-count'>" + n + "</span>";
  }
  const empty = document.getElementById("vars-empty");
  if (empty) {
    empty.hidden = total > 0 || !_rows.size;
    empty.textContent = _show === "oneoff" ? "No one-off settings: every run uses " + cfgName() + " as it is."
      : _show === "file" ? cfgName() + " sets nothing that matches."
      : "No setting matches the filter.";
  }
}

function paintFileName() {
  const el = document.getElementById("cfg-file-name");
  if (el) el.textContent = cfgName();
}

// ---------------------------------------------------------------- presets

async function onPreset(btn) {
  const p = PRESETS[btn.dataset.preset];
  if (!p) return;
  const { confirmDialog } = await import("./dialog.js");
  // B3 — preview exactly what the preset changes BEFORE applying it, so a
  // preset can never silently overwrite a field the user tuned by hand.
  const changes = [];
  if (p.reset) {
    const n = Object.keys(oneOffSettings()).length;
    changes.push(n ? "drop " + n + " one-off setting" + (n === 1 ? "" : "s") + ", so every field is back to what " + cfgName() + " sets"
      : "change nothing: there are no one-off settings");
  }
  const vars = new Map((state.variables || []).map((v) => [v.name, v]));
  for (const [k, val] of Object.entries(p.values)) {
    const v = vars.get(k) || { name: k };
    const cur = hasOverride(k) ? shownValue(state.varsValues[k]) : (baseOf(v).text || "unset");
    changes.push(k + ": " + cur + " → " + String(val));
  }
  const ok = await confirmDialog({
    title: p.reset ? "Clear the one-off settings?" : "Apply preset " + (p.label || btn.dataset.preset) + "?",
    body: (p.reset ? "This will " : "This preset will ") + changes.join("; ") + "." +
      (p.reset ? "" : " These are one-off settings for runs from LanEx; " + cfgName() + " stays as it is. Other one-off settings are kept."),
    confirmText: p.reset ? "Clear them" : "Apply preset",
  });
  if (!ok) return;
  document.querySelectorAll("#cfg-card [data-preset], #cfg-card .user-preset").forEach((b) => b.classList.remove("chip-active"));
  if (!p.reset) btn.classList.add("chip-active");
  if (p.reset) state.varsValues = {};
  for (const [k, val] of Object.entries(p.values)) state.varsValues[k] = String(val);
}

// ---- User-defined presets (localStorage, per-browser) ---------------------
const USER_PRESETS_KEY = "ll.userPresets";
function userPresets() {
  const p = safeStorage.getJSON(USER_PRESETS_KEY, {});
  return (p && typeof p === "object") ? p : {};
}

// "Save preset": persist the current one-off settings as a named, reusable
// preset (localStorage, per-browser).
async function onSavePreset() {
  const ov = oneOffSettings();
  if (!Object.keys(ov).length) { toast.show("Change at least one setting first.", "warn"); return; }
  const { promptDialog } = await import("./dialog.js");
  const name = await promptDialog({ title: "Save preset", label: "Preset name", defaultValue: "" });
  if (!name || !name.trim()) return;
  const presets = userPresets();
  presets[name.trim()] = { values: ov };
  safeStorage.setJSON(USER_PRESETS_KEY, presets);
  paintUserPresets();
  toast.show("Saved preset '" + name.trim() + "'.", "success");
}

function applyOverrideSet(values, { reset = true } = {}) {
  const next = reset ? {} : { ...activeOverrides() };
  for (const [k, v] of Object.entries(values || {})) next[k] = (typeof v === "boolean") ? v : String(v);
  state.varsValues = next;
}

function paintUserPresets() {
  const host = document.getElementById("config-user-presets");
  if (!host) return;
  const presets = userPresets();
  const names = Object.keys(presets).sort();
  host.innerHTML = names.map((n) =>
    "<span class='chip chip-clickable user-preset' data-uname='" + fmt.escape(n) + "'>" + fmt.escape(n) +
    "<button class='user-preset-del' data-del='" + fmt.escape(n) + "' title='Delete preset' aria-label='Delete preset " + fmt.escape(n) + "'><svg viewBox='0 0 24 24' width='13' height='13' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M6 6l12 12M18 6L6 18'/></svg></button></span>").join("");
  host.querySelectorAll(".user-preset").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".user-preset-del")) return;
      document.querySelectorAll("#cfg-card [data-preset], #cfg-card .user-preset").forEach((b) => b.classList.remove("chip-active"));
      el.classList.add("chip-active");
      const p = userPresets()[el.dataset.uname];
      if (p) applyOverrideSet(p.values);
    });
  });
  host.querySelectorAll(".user-preset-del").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const presets = userPresets();
      delete presets[b.dataset.del];
      safeStorage.setJSON(USER_PRESETS_KEY, presets);
      paintUserPresets();
    });
  });
}

// ---------------------------------------------------------------- the summary in the card

export function renderOverridesSummary() {
  const el = document.getElementById("config-overrides-summary");
  if (!el) return;
  const ov = oneOffSettings();
  const keys = Object.keys(ov).sort();
  // The design's own config file, viewable as-is, plus the merged
  // final-settings preview (config vs one-off settings vs defaults),
  // assembled from the same collectRunPayload() the Run button sends.
  const viewCfg =
    "<button class='btn btn-ghost' id='ov-final-settings' " +
    "title='Complete run configuration: combines one-off settings, the design config and PDK defaults'>Final settings</button> " +
    "<button class='btn btn-ghost' id='ov-view-config' " +
    "title='Open your design&#39;s own config file, exactly as it is on disk'>View config file</button>";
  const wireViewCfg = () => {
    el.querySelector("#ov-view-config")?.addEventListener("click", async () => {
      const { openProvenance } = await import("./provenance.js");
      openProvenance({ kind: "input", key: "" },
        { title: cfgName() + " on disk (Project, Sources, PDK and Common settings save into it; All settings doesn't)" });
    });
    el.querySelector("#ov-final-settings")?.addEventListener("click", async () => {
      const { openFinalSettings } = await import("./finalsettings.js");
      openFinalSettings();
    });
    el.querySelector("#ov-clear-all")?.addEventListener("click", () => { state.varsValues = {}; });
  };
  if (!keys.length) {
    el.innerHTML =
      "<span class='ov-none'>No one-off settings: runs use " + fmt.escape(cfgName()) + " as it is, and LibreLane's defaults for what it doesn't set. " +
      "Change a field or pick a preset to try a value for runs from LanEx without saving it.</span> " + viewCfg;
    wireViewCfg();
    return;
  }
  const chips = keys
    .map((k) => "<button class='ov-chip ov-chip-btn' data-ovvar='" + fmt.escape(k) +
      "' title='Where does this setting go? Click for the trail, or to save it into the config.'><code>" +
      fmt.escape(k) + "</code>=<b>" + fmt.escape(shownValue(ov[k])) + "</b></button>")
    .join("");
  el.innerHTML =
    "<div class='ov-head'><strong>" + keys.length + " one-off setting" + (keys.length === 1 ? "" : "s") +
    " will be sent with the next run</strong> <span class='muted'>(not saved in " + fmt.escape(cfgName()) +
    "; click one to trace it or save it there)</span> " +
    viewCfg + " <button class='btn btn-ghost' id='ov-clear-all'>Clear all</button></div>" +
    "<div class='ov-chips'>" + chips + "</div>";
  wireViewCfg();
  el.querySelectorAll("[data-ovvar]").forEach((b) => {
    b.addEventListener("click", () => showOverrideTrail(b.dataset.ovvar, activeOverrides()[b.dataset.ovvar]));
  });
}

// ---------------------------------------------------------------- the chip next to Run

function chipHosts() {
  const out = [];
  const split = document.querySelector(".tb-right .run-split");
  if (split) {
    let c = document.getElementById("oneoff-chip");
    if (!c) {
      c = document.createElement("button");
      c.id = "oneoff-chip";
      c.type = "button";
      c.className = "pill pill-warn chip-clickable oneoff-chip";
      c.hidden = true;
      c.addEventListener("click", () => openOneOffDialog());
      split.before(c);
    }
    out.push(c);
  }
  const pad = document.querySelector("#setup-run .launch-controls");
  if (pad) {
    let c = document.getElementById("oneoff-chip-setup");
    if (!c) {
      c = document.createElement("button");
      c.id = "oneoff-chip-setup";
      c.type = "button";
      c.className = "pill pill-warn chip-clickable oneoff-chip";
      c.hidden = true;
      c.addEventListener("click", () => openOneOffDialog());
      pad.appendChild(c);
    }
    out.push(c);
  }
  return out;
}

export function oneOffLabel(n) {
  return n + " one-off setting" + (n === 1 ? "" : "s");
}

// "2 one-off settings" next to Run (top bar and Setup's launch pad) whenever
// the next run sends any: click to see them and clear them.
export function paintOneOffChip() {
  if (typeof document === "undefined") return;
  const ov = oneOffSettings();
  const n = Object.keys(ov).length;
  for (const c of chipHosts()) {
    c.hidden = !n;
    if (!n) continue;
    c.textContent = oneOffLabel(n);
    c.dataset.tip = "Sent with the next run from LanEx and not saved in " + cfgName() + ": " +
      Object.keys(ov).sort().slice(0, 4).join(", ") + (n > 4 ? "…" : "") + ". Click to see or clear them.";
    c.setAttribute("aria-label", oneOffLabel(n) + " go with the next run. Show them");
  }
}

export async function openOneOffDialog() {
  const { customDialog } = await import("./dialog.js");
  const list = () => {
    const ov = oneOffSettings();
    const keys = Object.keys(ov).sort();
    if (!keys.length) return "<p class='muted'>No one-off settings left. Runs use " + fmt.escape(cfgName()) + " as it is.</p>";
    return "<div class='ov-chips'>" + keys.map((k) =>
      "<span class='ov-chip'><code>" + fmt.escape(k) + "</code>=<b>" + fmt.escape(shownValue(ov[k])) + "</b> " +
      "<button type='button' class='linklike' data-oo-drop='" + fmt.escape(k) + "'>Clear</button></span>").join("") + "</div>";
  };
  const body = () =>
    "<p>These go with every run you start from LanEx in this project, as <code>-c</code> overrides on LibreLane's command line. " +
    "They are not saved in " + fmt.escape(cfgName()) + ", so a terminal run of the folder doesn't use them. " +
    "They stay until you clear them; opening another project doesn't take them along.</p>" +
    "<div class='overrides-summary' data-oo-list>" + list() + "</div>";
  const choice = await customDialog({
    title: "One-off settings for the next run",
    bodyHtml: body(),
    buttons: [
      { label: "Clear all", value: "clear", cls: "btn-ghost" },
      { label: "Open All settings", value: "open", cls: "btn-ghost" },
      { label: "Close", value: undefined, cls: "btn-primary" },
    ],
    onMount: (back) => {
      back.addEventListener("click", (e) => {
        const b = e.target.closest("[data-oo-drop]");
        if (!b) return;
        delete state.varsValues[b.dataset.ooDrop];
        const host = back.querySelector("[data-oo-list]");
        if (host) host.innerHTML = list();
      });
    },
  });
  if (choice === "clear") state.varsValues = {};
  else if (choice === "open") {
    const { go } = await import("./nav.js");
    go("setup", { section: "cfg-card" });
    const sel = document.getElementById("var-show");
    if (sel) { sel.value = "oneoff"; _show = "oneoff"; applyFilter(); }
    const card = document.getElementById("cfg-card");
    if (card && !card.open) card.open = true;
  }
}

// ---------------------------------------------------------------- the trail of one setting

// Input-side transparency: for one one-off setting, show exactly (a) how it
// reaches the flow (a `-c VAR=VALUE` argument; All settings never writes the
// file), (b) the config file + line it supersedes, quoted, or the honest
// statement that the file doesn't set it, and (c) after a run, the
// resolved.json line proving the value LibreLane ACTUALLY used. It can also be
// saved into the config, where it then stays for every run.
async function showOverrideTrail(varName, value) {
  const { customDialog } = await import("./dialog.js");
  const { openProvenance } = await import("./provenance.js");
  const runTag = state.selectedRunTag ||
    (Array.isArray(state.runs) && state.runs[0] && state.runs[0].tag) || null;

  const safeLookup = async (params) => {
    try { return await api.provenance(params); }
    catch (ex) { return { ok: false, reason: "lookup failed: " + (ex.message || ex) }; }
  };
  const [inp, run] = await Promise.all([
    safeLookup({ kind: "input", key: varName }),
    runTag ? safeLookup({ kind: "var", key: varName, tag: runTag }) : Promise.resolve(null),
  ]);

  const lineRow = (r) =>
    "<pre class='code ov-trail-line'>" + fmt.escape(r.text || "") + "</pre>";
  let cfgHtml;
  if (inp && inp.ok) {
    cfgHtml =
      "<p><b>" + fmt.escape(inp.rel) + "</b> sets this on <b>line " + inp.line + "</b>. " +
      "The one-off setting wins over that line for runs from LanEx; the file itself stays as it is:</p>" +
      lineRow(inp);
  } else if (inp && inp.rel) {
    cfgHtml =
      "<p><b>" + fmt.escape(inp.rel) + "</b> does <b>not</b> set <code>" + fmt.escape(varName) +
      "</code>. The one-off setting goes on the command line; without it, the flow uses the PDK and flow defaults.</p>";
  } else {
    cfgHtml = "<p class='muted'>" +
      fmt.escape((inp && inp.reason) || "no config file found in the design folder") + "</p>";
  }
  let runHtml;
  if (run && run.ok) {
    runHtml =
      "<p>Run <b>" + fmt.escape(runTag) + "</b> recorded the value it actually used in " +
      "<b>resolved.json</b> (LibreLane's own record), <b>line " + run.line + "</b>:</p>" +
      lineRow(run);
  } else if (runTag) {
    runHtml = "<p class='muted'>Run " + fmt.escape(runTag) + ": " +
      fmt.escape((run && run.reason) || "no resolved.json") + "</p>";
  } else {
    runHtml = "<p class='muted'>No runs recorded yet. After a run completes, LibreLane's <code>resolved.json</code> " +
      "records the exact parameters used, which will appear here.</p>";
  }

  const canSave = !!(_eff.editable && state.designDir);
  const choice = await customDialog({
    title: "Where does " + varName + " go?",
    bodyHtml:
      "<p>This is a one-off setting: runs from LanEx pass it on LibreLane's command line. " +
      "All settings doesn't write it into " + fmt.escape(cfgName()) + ":</p>" +
      "<pre class='code'>-c " + fmt.escape(varName) + "=" + fmt.escape(shownValue(value)) + "</pre>" +
      cfgHtml + runHtml,
    buttons: [
      canSave ? { label: "Save to " + cfgName(), value: "save", cls: "btn-ghost" } : null,
      (inp && inp.ok) ? { label: "Open " + inp.rel + " at line " + inp.line,
                          value: "input", cls: "btn-ghost" } : null,
      (run && run.ok) ? { label: "Open resolved.json at line " + run.line,
                          value: "var", cls: "btn-ghost" } : null,
      { label: "Close", value: undefined, cls: "btn-ghost" },
    ].filter(Boolean),
  });
  if (choice === "save") {
    await saveOneOffToConfig(varName, value);
  } else if (choice === "input") {
    openProvenance({ kind: "input", key: varName },
      { title: "Your config's own " + varName + " line (the one-off setting wins over it)" });
  } else if (choice === "var") {
    openProvenance({ kind: "var", key: varName, tag: runTag },
      { title: varName + " as run '" + runTag + "' actually used it (resolved.json)" });
  }
}

// Turn a one-off setting into the project's own: write it into the config
// (where it takes effect for this PDK), then drop the one-off.
async function saveOneOffToConfig(varName, value) {
  const v = (state.variables || []).find((x) => x.name === varName) || { name: varName };
  let typed = value;
  const kind = v.kind || "text";
  if (kind === "int" || kind === "number") typed = Number(value);
  else if (kind === "bool") typed = value === true || value === "true";
  else if (kind === "numbers") typed = String(value).split(/[\s,]+/).filter(Boolean).map(Number);
  else if (kind === "list") typed = listItems(String(value));
  try {
    const info = await api.designInfo({ keys: [varName], pdk: state.selectedPdk || null, scl: state.selectedScl || null });
    const { writeSetting } = await import("./configscope.js");
    const r = await writeSetting({ key: varName, value: typed, entries: ((info.settings_scoped || {})[varName]) || [],
      label: varName, cfgName: (info.config && info.config.name) || cfgName() });
    if (!r) return;
    document.dispatchEvent(new CustomEvent("g:config_changed", { detail: { keys: [varName], from: "all-settings" } }));
  } catch (ex) {
    toast.show("Couldn't save " + varName + ": " + (ex.message || ex), "error", 8000);
  }
}

// A link to one setting (nav.js go("setup", { setting })): open All settings
// filtered to it, focus its field and flash the row. Returns the row's id so
// nav.js keeps it in view while the page settles.
export async function revealSetting(name) {
  const card = document.getElementById("cfg-card");
  if (card && !card.open) card.open = true;
  build();
  const search = document.getElementById("var-search");
  if (search) search.value = name;
  _search = String(name).toUpperCase();
  const show = document.getElementById("var-show");
  if (show) show.value = "all";
  _show = "all";
  applyFilter();
  const row = _rows.get(name) && _rows.get(name).row;
  if (!row) return null;
  row.id = "var-row-" + name;
  row.classList.add("is-flash");
  setTimeout(() => row.classList.remove("is-flash"), 2600);
  row.querySelector("input, select, textarea")?.focus({ preventScroll: true });
  return row.id;
}

// Reflect SYNTH_SHOW (one-off, else the config's) into the quick toggle.
function syncReportToggles() {
  const ss = document.getElementById("cfg-synth-show");
  if (!ss) return;
  const ov = (state.varsValues || {}).SYNTH_SHOW;
  const e = _eff.map.SYNTH_SHOW;
  const val = ov !== undefined ? ov : e ? e.value : false;
  ss.checked = val === true || val === "true";
}

function cssEscape(s) {
  const _ = typeof CSS !== "undefined" && CSS.escape;
  if (_) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}

export const _test = { groupFor, PRESETS };
