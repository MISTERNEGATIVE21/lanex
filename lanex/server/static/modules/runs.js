// runs.js — the Runs page: one sortable table of every run, where runs are
// managed, compared and swept. A row is one run; a sweep is one parent row
// that lines up with the columns (the best number of its clean runs in each)
// and opens to its summary and its points (sweeps.js draws the sheet and the
// summary).
//
//   click a row        it becomes the run every results page shows
//   open a row (▸)     the run panel beside the table: how it ended, its
//                      numbers against the baseline, its settings and actions
//   ★                  the design's baseline: every number is coloured better
//                      or worse than it (direction from the metric registry)
//   tick 2–6 rows      Compare (Analytics › Compare, pre-filled) or Delete

import { api, fmt } from "./api.js";
import { state, safeStorage } from "./state.js";
import { confirmDialog, alertDialog, checklistDialog, choiceDialog, customDialog } from "./dialog.js";
import { openLayer, closeLayer, isLayerOpen, layerCount } from "./overlay.js";
import { toast } from "./toast.js";
import { gatherRunsScoped, normDir, getRunScope, setRunScope, setRun, setBaseline, contextRun, contextDesign, onContext, designLabel } from "./context.js";
import { go } from "./nav.js";
import * as FS from "./flowstages.js";
import { icon } from "./icons.js";
import { verdictOf as cardVerdict, warningsHtml, fmtDur } from "./reportcard.js";
import { localeNum, localeTime, localeDate } from "./intlcache.js";
import { loadingStart, pageSkeleton } from "./loading.js";

// The last step of a stage in the Classic flow (matches setup.js's --to).
function lastStepOfStage(stageId) {
  const flow = (state.flows || []).find((f) => f.name === "Classic");
  const ids = (flow && flow.steps) || [];
  const st = FS.stagesOf(ids.map((id) => ({ id })));
  let last = "";
  st.forEach((s, i) => { if (s === stageId) last = ids[i]; });
  return last;
}

// Lightweight "make this run's design active" — needed before any run-scoped
// call (delete / files) since they resolve against the server's active design
// dir. It does not switch tabs.
async function focusDesign(designDir) {
  if (designDir && normDir(designDir) !== normDir(state.designDir)) {
    try { await api.setDesignDir(designDir); state.designDir = designDir; } catch (_e) {}
  }
}

const esc = (s) => fmt.escape(s == null ? "" : String(s));
const num = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e20 ? v : null);
const km = (r, k) => num((r.key_metrics || {})[k]);
// "|" joins them: a NUL would not survive an HTML attribute (data-key).
const keyOf = (r) => normDir(r._design) + "|" + r.tag;

// ------------------------------------------------------------------ columns
// dir: +1 higher is better, -1 lower is better, 0 no direction (no colour).
// Directions follow LibreLane's metric registry (compare.js higher_is_better).
function checksOf(r) {
  const m = r.key_metrics || {};
  const drc = ["magic__drc_error__count", "klayout__drc_error__count", "route__drc_errors"]
    .map((k) => num(m[k])).filter((v) => v != null);
  const lvs = num(m.design__lvs_error__count), ant = num(m.antenna__violating__nets);
  if (!drc.length && lvs == null && ant == null) return null;
  const d = drc.length ? Math.max(...drc) : null;
  return { drc: d, lvs, ant, total: (d || 0) + (lvs || 0) + (ant || 0) };
}
const COLS = [
  { id: "name", label: "Run", fixed: true, sort: (r) => r.tag.toLowerCase() },
  { id: "verdict", label: "Result", fixed: true, sort: (r) => VERDICT_ORDER[verdictOf(r).state] ?? 9 },
  { id: "when", label: "When", sort: (r) => r.started_at || "", def: true },
  { id: "origin", label: "Origin", sort: (r) => originText(r), def: 2000 },
  { id: "design", label: "Design", sort: (r) => designLabel(r._design), allOnly: true, def: true },
  { id: "pdk", label: "PDK", sort: (r) => r.pdk || "", def: false },
  { id: "wns", label: "Setup WNS", unit: "ns", dir: 1, get: (r) => km(r, "timing__setup__ws"), f: (v) => signed(v), def: true,
    tip: "Worst setup slack in any corner (ns). Positive: the design meets its clock." },
  { id: "tns", label: "Setup TNS", unit: "ns", dir: 1, get: (r) => km(r, "timing__setup__tns"), f: (v) => signed(v), def: 1500,
    tip: "Total negative setup slack (ns). 0 when every path meets timing." },
  { id: "hold", label: "Hold WNS", unit: "ns", dir: 1, get: (r) => km(r, "timing__hold__ws"), f: (v) => signed(v), def: 1500,
    tip: "Worst hold slack in any corner (ns)." },
  { id: "die", label: "Die area", unit: "µm²", dir: -1, get: (r) => km(r, "design__die__area"), f: (v) => grp(v), def: 1500,
    tip: "design__die__area: the whole die, in µm²." },
  { id: "cells", label: "Std-cell area", unit: "µm²", dir: -1, get: (r) => km(r, "design__instance__area__stdcell"), f: (v) => grp(v), def: true,
    tip: "design__instance__area__stdcell: the standard cells' area in µm², without fill, tap or decap cells." },
  { id: "util", label: "Util", unit: "%", dir: 0, get: (r) => { const u = km(r, "design__instance__utilization"); return u == null ? null : u * 100; },
    f: (v) => (Math.round(v * 10) / 10).toFixed(1), def: true, tip: "How full the core is with cells at the end (design__instance__utilization)." },
  { id: "power", label: "Power", unit: "mW", dir: -1, get: (r) => { const p = km(r, "power__total"); return p == null ? null : p * 1e3; },
    f: (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(3)), def: true, tip: "Total power OpenROAD estimated (power__total), in mW." },
  { id: "checks", label: "DRC · LVS · Ant", dir: -1, get: (r) => { const c = checksOf(r); return c ? c.total : null; }, def: true,
    tip: "Design-rule errors (worst of Magic, KLayout and the router), LVS errors and antenna violations. Not checked: blank." },
  { id: "runtime", label: "Runtime", dir: -1, get: (r) => num(r.wall_time_s), f: (v) => fmtDur(v), def: 1300, tip: "The sum of every step's time." },
  { id: "changed", label: "Changed vs baseline", sort: (r) => (CHANGES.get(keyOf(r)) || []).length, def: true },
  { id: "note", label: "Note", sort: (r) => r.note || "", def: 2100 },
];
// The column heads: one line each, short enough that none wraps.
const HEADS = { die: "Die", cells: "Std cells", checks: "Checks", changed: "Changed" };
const VERDICT_ORDER = { running: 0, passed: 1, warning: 2, incomplete: 3, stopped: 4, failed: 5 };
const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const grp = (v) => localeNum(Math.round(v));

const COLS_KEY = "ll.runsCols", SORT_KEY = "ll.runsSort", BASE_KEY = "ll.runsBaseline", OPEN_KEY = "ll.runsOpenSweeps";
function visibleCols(scope) {
  const saved = safeStorage.getJSON(COLS_KEY, null);
  return COLS.filter((c) => (c.allOnly ? scope === "all" : true) &&
    (c.fixed || (saved && saved[c.id] != null ? saved[c.id] : defOn(c) && !_autoHide.has(c.id))));
}
// Columns that fit: when the default set is wider than the room the table
// has, the least needed ones step aside, in this order (never a column the
// person turned on themselves; Columns brings any of them back).
const DROP_ORDER = ["note", "origin", "pdk", "changed", "tns", "hold", "die", "runtime", "util", "power", "checks", "cells", "when"];
let _autoHide = new Set(), _autoKey = "";
function fitColumns(table, scope) {
  const wrap = document.getElementById("rn-wrap");
  const saved = safeStorage.getJSON(COLS_KEY, null) || {};
  const key = scope + "|" + (wrap ? wrap.clientWidth : 0) + "|" + JSON.stringify(saved);
  if (key !== _autoKey) {
    _autoKey = key;
    if (_autoHide.size) { _autoHide = new Set(); _model.cols = visibleCols(scope); paintTable(table, _model); }
  }
  for (let i = 0; wrap && i < DROP_ORDER.length && wrap.scrollWidth > wrap.clientWidth + 1; i++) {
    const next = DROP_ORDER.find((id) => _model.cols.some((c) => c.id === id) && saved[id] !== true);
    if (!next) break;
    _autoHide.add(next);
    _model.cols = visibleCols(scope);
    paintTable(table, _model);
  }
}
// A column whose default is a width shows by default only when the table has
// that much room, so the default set fits the screen (1366: the essentials).
function defOn(c) {
  if (typeof c.def !== "number") return !!c.def;
  // The room the table has (less when the run panel sits beside it).
  const w = (document.querySelector("#sec-runs .rn-main")?.clientWidth || document.getElementById("sec-runs")?.clientWidth || window.innerWidth) + 30;
  return w >= c.def - 120;
}

// ------------------------------------------------------------------ verdict
// The run's verdict (agent TRUST adds run.verdict from Verify's own reading);
// until then: passed / failed (at a stage, once its reason is read) / stopped /
// running, from the summary and the run's explanation.
const RX = new Map();          // keyOf(run) -> runExplain result (failed runs only)
function verdictOf(r) {
  if (r.verdict && r.verdict.state) return r.verdict;
  if (state.status && state.status.running && state.liveTag && r.tag === state.liveTag && normDir(r._design) === normDir(state.designDir)) {
    return { state: "running", label: "running" };
  }
  if (r.success) return { state: "passed", label: "passed" };
  const rx = RX.get(keyOf(r));
  if (rx) {
    if (rx.kind === "stopped") return { state: "stopped", label: "stopped" };
    if (rx.kind === "incomplete") return { state: "incomplete", label: "incomplete" };
    if (rx.kind === "checks-failed") return { state: "failed", label: "checks failed", stage: "signoff" };
    if (rx.stage) return { state: "failed", label: "failed at " + FS.stageLabel(rx.stage), stage: rx.stage };
  }
  return { state: "failed", label: "failed" };
}
const VERDICT_TONE = { passed: "pass", warning: "warn", failed: "fail", stopped: "warn", incomplete: "warn", running: "live" };

// ------------------------------------------------------------------ origin
let SWEEPS = [];               // this design's sweep manifests (newest first)
// run.origin (history.run_origin), else the summary's branched_from (TRUST).
function originOf(r) {
  if (r.origin && r.origin.kind) return r.origin;
  // The run summary carries branched_from as the parent's tag (a string).
  const b = r.branched_from;
  if (typeof b === "string" && b) return { kind: "fix", parent: b, changes: [] };
  if (b && b.tag) return { kind: "fix", parent: b.tag, stage: b.stage, changes: b.changes || [] };
  return {};
}
function sweepOf(r) {
  const o = originOf(r);
  if (o.kind === "sweep") return SWEEPS.find((s) => s.id === o.sweep_id) || { id: o.sweep_id, axes: [], tags: [], _design: r._design };
  if (normDir(r._design) !== normDir(state.designDir)) return null;
  return SWEEPS.find((s) => (s.tags || []).includes(r.tag)) || null;
}
function pointValues(r, sw) {
  const o = originOf(r);
  if (o.kind === "sweep" && o.values && Object.keys(o.values).length) return o.values;
  if (sw) {
    const i = (sw.tags || []).indexOf(r.tag);
    if (sw.points && sw.points[i]) return sw.points[i];
    if (i >= 0 && sw.axes && sw.axes.length) {
      // Old manifests carry axes only: a one-axis sweep maps index -> value.
      if (sw.axes.length === 1) return { [sw.axes[0].var]: sw.axes[0].values[i] };
    }
  }
  return null;
}
const valuesText = (v) => Object.entries(v || {}).map(([k, x]) => k + " " + x).join(", ");
function originText(r) {
  const o = originOf(r);
  if (o.kind === "fix") return "fix of " + o.parent;
  if (sweepOf(r)) return "sweep";
  if (r.imported) return "imported";
  return "manual";
}
function lineageHtml(r) {
  const o = originOf(r);
  if (o.kind !== "fix") return "";
  const ch = (o.changes || []).map((c) => c.var + " " + c.from + "→" + c.to).join(", ");
  return "<span class='rn-lineage' title='Resumed from " + esc(o.parent) + (o.stage ? " at " + esc(FS.stageLabel(o.stage)) : "") +
    " with a changed setting'>fix of " + esc(o.parent) + (ch ? " · " + esc(ch) : "") + "</span>";
}

// ------------------------------------------------------------------ state
let _wired = false;
const F = { q: "", status: "", origin: "", pdk: "" };
const _picked = new Set();     // keyOf(run)
let _open = null;              // keyOf(run) whose report row is open
let _openSweeps = new Set(safeStorage.getJSON(OPEN_KEY, []) || []);
let _sort = safeStorage.getJSON(SORT_KEY, null) || { col: "when", dir: -1 };
let _shown = { key: "", runs: [] };
let _renderSeq = 0;
const CHANGES = new Map();     // keyOf(run) -> [{var, from, to}] vs the baseline
let _changesKey = "";

function baselineTag(design) { return (safeStorage.getJSON(BASE_KEY, {}) || {})[normDir(design)] || ""; }
function setBaselineTag(design, tag) {
  const m = safeStorage.getJSON(BASE_KEY, {}) || {};
  if (tag) m[normDir(design)] = tag; else delete m[normDir(design)];
  safeStorage.setJSON(BASE_KEY, m);
}

function wire() {
  if (_wired) return;
  _wired = true;
  document.querySelectorAll("#sec-runs .runs-scope[data-scope]").forEach((b) =>
    b.addEventListener("click", () => { setRunScope(b.dataset.scope); renderRuns(); }));
  onContext(() => paintViewing());
  const fi = document.getElementById("runs-filter");
  if (fi) fi.addEventListener("input", () => { F.q = fi.value.toLowerCase(); renderRuns({ cached: true }); });
  document.getElementById("runs-import")?.addEventListener("click", () => importRunFlow());
  document.getElementById("runs-new-sweep")?.addEventListener("click", () => import("./sweeps.js").then((m) => m.openSweepSheet()));
  // The column picker: a popover on the overlay stack (Esc, an outside press).
  const cb = document.getElementById("rn-cols-btn"), cp = document.getElementById("rn-cols");
  cb?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isLayerOpen(cp)) { closeLayer(cp); return; }
    cp.hidden = false;
    paintColPicker();
    openLayer(cp, { kind: "popover", owner: cb, onClose: () => { cp.hidden = true; }, focus: () => cp.querySelector("input") });
  });
  // Esc closes the run panel when nothing is open above it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || !_open || layerCount()) return;
    if (!document.getElementById("sec-runs")?.classList.contains("section-active")) return;
    const t = e.target;
    if (t && t.matches && t.matches("input[type=search]") && t.value) return;
    closeSide();
  });
  // A sweep running anywhere shows its progress here.
  // Default columns follow the room the table has.
  let rz = 0;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (document.getElementById("sec-runs")?.classList.contains("section-active")) renderRuns({ cached: true }); }, 250); });
  document.addEventListener("g:sweep", () => {
    if (document.getElementById("sec-runs")?.classList.contains("section-active")) renderRuns();
  });
}

function paintColPicker() {
  const cp = document.getElementById("rn-cols");
  const saved = safeStorage.getJSON(COLS_KEY, {}) || {};
  cp.innerHTML = "<div class='rn-cols-h'>Columns</div>" + COLS.filter((c) => !c.fixed && !c.allOnly).map((c) => {
    const on = saved[c.id] != null ? saved[c.id] : defOn(c) && !_autoHide.has(c.id);
    return "<label class='rn-col-opt'><input type='checkbox' data-col='" + c.id + "'" + (on ? " checked" : "") + "/> " + esc(c.label) + "</label>";
  }).join("") + "<button class='btn btn-ghost btn-sm' data-cols-reset>Reset to default</button>";
  cp.querySelectorAll("input[data-col]").forEach((i) => i.addEventListener("change", () => {
    const m = safeStorage.getJSON(COLS_KEY, {}) || {};
    m[i.dataset.col] = i.checked;
    safeStorage.setJSON(COLS_KEY, m);
    renderRuns({ cached: true });
  }));
  cp.querySelector("[data-cols-reset]").addEventListener("click", () => { safeStorage.remove(COLS_KEY); paintColPicker(); renderRuns({ cached: true }); });
}

// Segmented filter chips (no native <select>), counts from the unfiltered list.
function paintChips(runs) {
  const chip = (host, key, all) => {
    const el = document.getElementById(host);
    if (!el) return;
    // A choice with nothing behind it is left out (unless it is the one in force).
    const opts = all.filter(([v, , n]) => v === "" || n == null || n > 0 || F[key] === v);
    el.hidden = opts.length <= 1 || (opts.length <= 2 && key !== "status");
    el.innerHTML = opts.map(([v, label, n]) =>
      "<button class='rn-segb" + (F[key] === v ? " is-on" : "") + "' data-v='" + esc(v) + "' aria-pressed='" + (F[key] === v) + "'>" +
      esc(label) + (n != null ? " <span class='rn-n'>" + n + "</span>" : "") + "</button>").join("");
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { F[key] = b.dataset.v; renderRuns({ cached: true }); }));
  };
  const cnt = (fn) => runs.filter(fn).length;
  chip("rn-status", "status", [["", "All", runs.length], ["passed", "Clean", cnt((r) => verdictOf(r).state === "passed")],
    ["warning", "Warnings", cnt((r) => verdictOf(r).state === "warning")], ["failed", "Failed", cnt((r) => verdictOf(r).state === "failed")], ["stopped", "Stopped", cnt((r) => /stopped|incomplete/.test(verdictOf(r).state))],
    ["pinned", "Pinned", cnt((r) => r.pinned)]]);
  chip("rn-origin", "origin", [["", "Any origin", null], ["manual", "Manual", cnt((r) => originText(r) === "manual")],
    ["sweep", "Sweeps", cnt((r) => originText(r) === "sweep")], ["fix", "Fixes", cnt((r) => originOf(r).kind === "fix")]]);
  const pdks = [...new Set(runs.map((r) => r.pdk).filter(Boolean))];
  chip("rn-pdk", "pdk", pdks.length > 1 ? [["", "Any PDK", null], ...pdks.map((p) => [p, p, cnt((r) => r.pdk === p)])] : []);
  document.querySelectorAll("#sec-runs .runs-scope[data-scope]").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.scope === getRunScope()));
}

function matches(r) {
  const v = verdictOf(r).state;
  if (F.status === "pinned" && !r.pinned) return false;
  if (F.status === "passed" && v !== "passed") return false;
  if (F.status === "failed" && v !== "failed") return false;
  if (F.status === "warning" && v !== "warning") return false;
  if (F.status === "stopped" && !/stopped|incomplete/.test(v)) return false;
  if (F.origin === "fix" && originOf(r).kind !== "fix") return false;
  if (F.origin && F.origin !== "fix" && originText(r) !== F.origin) return false;
  if (F.pdk && r.pdk !== F.pdk) return false;
  if (!F.q) return true;
  const sw = sweepOf(r);
  const hay = [r.tag, r.pdk, r.scl, r.note, originText(r), designLabel(r._design), valuesText(pointValues(r, sw)),
    (CHANGES.get(keyOf(r)) || []).map((c) => c.var).join(" ")].join(" ").toLowerCase();
  return hay.includes(F.q);
}

function sortRuns(list) {
  const col = COLS.find((c) => c.id === _sort.col) || COLS[2];
  const val = col.sort || col.get || (() => 0);
  return list.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;          // blanks last, either way
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * _sort.dir;
  });
}

// ------------------------------------------------------------------ render
export async function renderRuns({ cached = false } = {}) {
  const table = document.getElementById("runs-table");
  if (!table) return;
  wire();
  const scope = getRunScope();
  const key = scope + "\0" + normDir(state.designDir);
  const my = ++_renderSeq;
  let runs;
  if (cached && _shown.key === key) runs = _shown.runs;
  else {
    // A list not shown yet: the page skeleton after 300 ms, never "No runs" before the answer.
    const job = _shown.key !== key ? loadingStart(document.getElementById("sec-runs"), { skeleton: pageSkeleton("runs"), label: "Runs",
      hasContent: () => !!document.querySelector("#runs-table tbody tr") }) : null;
    try {
      const [rs, sw] = await Promise.all([gatherRunsScoped(scope, { strict: true }),
        state.designDir ? api.dseSweeps().catch(() => null) : Promise.resolve(null)]);
      runs = rs;
      if (sw) SWEEPS = (sw.data || sw).sweeps || [];
    } catch (_e) {
      if (my !== _renderSeq) return;
      if (_shown.key === key && _shown.runs.length) { note("Couldn't refresh the list. Trying again…"); setTimeout(() => { if (my === _renderSeq) renderRuns(); }, 4000); return; }
      runs = null;
    } finally { if (job) job.done(); }
  }
  if (my !== _renderSeq) return;
  const empty = document.getElementById("rn-empty"), wrap = document.getElementById("rn-wrap");
  const title = document.getElementById("rn-title");
  if (title) title.textContent = scope === "all" ? "Every run of every design you've opened" : (state.designDir ? "Every run of " + designLabel(state.designDir) : "Runs");
  const foot = document.getElementById("rn-foot");
  if (runs === null) {
    wrap.hidden = true; empty.hidden = false; if (foot) foot.hidden = true;
    empty.innerHTML = "<h3>Couldn't load your runs</h3><p>LanEx didn't answer in time. Trying again…</p>";
    setTimeout(() => { if (my === _renderSeq) renderRuns(); }, 4000);
    return;
  }
  note("");
  _shown = { key, runs };
  if (scope !== "all") state.runs = runs;
  paintChips(runs);
  paintLive();
  syncSide();
  if (!runs.length) {
    wrap.hidden = true; empty.hidden = false; if (foot) foot.hidden = true;
    empty.innerHTML = state.designDir || scope === "all"
      ? "<h3>No runs yet</h3><p>Run the flow once and every run appears here, one row each, with its timing, area, power and checks.</p>" +
        "<button class='btn btn-primary' data-go='setup'>Go to Setup</button>"
      : "<h3>Open a project first</h3><p>Runs lists the runs of the project you have open.</p><button class='btn btn-primary' data-go='setup'>Go to Setup</button>";
    syncSelection();
    return;
  }
  const shown = runs.filter(matches);
  if (!shown.length) {
    wrap.hidden = true; empty.hidden = false; if (foot) foot.hidden = true;
    empty.innerHTML = "<h3>No runs match</h3><p>Nothing fits the search and filters. There are " + runs.length + " runs in all.</p>" +
      "<button class='btn' id='rn-clear-filters'>Clear the filters</button>";
    empty.querySelector("#rn-clear-filters").onclick = () => {
      F.q = F.status = F.origin = F.pdk = "";
      const fi = document.getElementById("runs-filter"); if (fi) fi.value = "";
      renderRuns({ cached: true });
    };
    syncSelection();
    return;
  }
  wrap.hidden = false; empty.hidden = true;
  const cols = visibleCols(scope);
  _baseMemo = new Map();
  _model = { items: buildItems(sortRuns(shown)), cols, a: 0, b: 0, windowed: false };
  paintTable(table, _model);
  fitColumns(table, scope);
  wireTable(table, runs);
  paintFoot(runs, shown);
  syncSelection();
  paintViewing();
  explainFailed(runs);
  loadChanges(runs);
}

function note(text) {
  const el = document.getElementById("runs-note");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

// The line under the table: how many, and what the colours mean.
function paintFoot(runs, shown) {
  const foot = document.getElementById("rn-foot");
  if (!foot) return;
  foot.hidden = false;
  const sweeps = new Set(shown.map((r) => { const sw = sweepOf(r); return sw ? normDir(r._design) + "|" + sw.id : ""; }).filter(Boolean)).size;
  const n = shown.length === runs.length ? runs.length + " run" + (runs.length === 1 ? "" : "s") : shown.length + " of " + runs.length + " runs";
  const base = getRunScope() === "all" ? "" : baselineTag(state.designDir);
  foot.innerHTML = "<span>" + n + (sweeps ? " · " + sweeps + " sweep" + (sweeps === 1 ? "" : "s") : "") + "</span>" +
    (base
      ? "<span>Baseline <code>" + esc(base) + "</code></span><span class='rn-key'><i style='background:var(--pass)'></i>better than it</span><span class='rn-key'><i style='background:var(--fail)'></i>worse</span>"
      : "<span>Star a run to make it the baseline: every number is then coloured better or worse than it.</span>");
}

function headHtml(cols) {
  const th = (c) => {
    const on = _sort.col === c.id;
    return "<th scope='col' class='rn-th rn-c-" + c.id + (c.dir != null || c.get ? " is-num" : "") + "'" +
      (on ? " aria-sort='" + (_sort.dir > 0 ? "ascending" : "descending") + "'" : "") +
      "><button class='rn-sort" + (on ? " is-on" : "") + "' data-sort='" + c.id + "' title='" + esc(c.tip || "Sort by " + c.label) + "'>" +
      esc(HEADS[c.id] || c.label) + (c.unit ? " <small>" + esc(c.unit) + "</small>" : "") +
      "<span class='rn-arrow' aria-hidden='true'>" + (on ? (_sort.dir > 0 ? "▲" : "▼") : "") + "</span></button></th>";
  };
  return "<thead><tr><th class='rn-th rn-c-pick'><span class='sr-only'>Select</span></th>" +
    "<th class='rn-th rn-c-base' title='Baseline: every number is coloured against it'>★</th>" + cols.map(th).join("") + "</tr></thead>";
}

// Rows: sweeps fold under one parent row (in the position of their newest point).
// One item per table row (a run, with its report row when open, or a sweep).
function buildItems(list) {
  const groups = new Map();
  const order = [];
  for (const r of list) {
    const sw = sweepOf(r);
    if (sw) {
      const gk = normDir(r._design) + "|sweep:" + sw.id;
      if (!groups.has(gk)) { groups.set(gk, { sw, runs: [] }); order.push({ group: gk }); }
      groups.get(gk).runs.push(r);
    } else order.push({ run: r });
  }
  const items = [];
  for (const o of order) {
    if (o.run) { items.push({ key: keyOf(o.run), run: o.run }); continue; }
    const g = groups.get(o.group);
    const open = _openSweeps.has(o.group);
    items.push({ key: o.group, group: g, gk: o.group, open });
    if (open) for (const r of g.runs) items.push({ key: keyOf(r), run: r, child: g.sw });
  }
  return items;
}

function itemHtml(it, cols, i) {
  const html = it.group ? sweepRowHtml(it.group, cols, it.gk, it.open) : rowHtml(it.run, cols, { child: it.child || null });
  return html.replace(/<tr /g, "<tr data-vi='" + i + "' aria-rowindex='" + (i + 2) + "' ");
}

// One baseline lookup per design and render (was a scan of every run per row).
let _baseMemo = new Map();
function baselineRowFor(r) {
  const t = baselineTag(r._design);
  if (!t || t === r.tag) return null;
  const d = normDir(r._design);
  const mk = d + "|" + t;
  if (_baseMemo.has(mk)) return _baseMemo.get(mk);
  const b = _shown.runs.find((x) => x.tag === t && normDir(x._design) === d) || null;
  _baseMemo.set(mk, b);
  return b;
}

// ------------------------------------------------------------------ windowed rows
// Past WINDOW_MIN rows only the rows near the view are in the DOM, with a
// spacer row above and below for the rest: 300 runs were 9k nodes, and every
// sort, tick or baseline change laid all of them out again (a second at a time
// on a slow laptop). Collapsed "sizer" rows carry the widest cell of every
// column, so the columns are exactly as wide as with every row drawn and do not
// move while scrolling. Tab past the last drawn row draws the next ones first.
const WINDOW_MIN = 100, OVERSCAN = 24, MARGIN = 8;
const _heights = new Map();    // item key -> measured height in px (kept across renders)
let _rowH = 34.5;              // a plain run row, as measured
let _model = null;             // { items, cols, a, b, windowed }
const _stash = new Map();      // item key -> its <tr>s, kept while scrolled away (open report, sweep summary)

// The element that scrolls the table up and down (not .rn-wrap: its sideways
// scroll makes its overflow-y compute to auto too, but it never scrolls down).
function scrollerOf(table) {
  const from = table.closest(".rn-wrap") || table;
  for (let e = from.parentElement; e && e !== document.body; e = e.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
  }
  return document.scrollingElement;
}

function estimate(it) {
  const h = _heights.get(it.key);
  if (h != null) return h;
  if (it.group) return it.open ? _rowH + 240 : _rowH;
  return _rowH + (originOf(it.run).kind === "fix" ? 17 : 0);
}

function prefix(m) {
  const cum = new Float64Array(m.items.length + 1);
  for (let i = 0; i < m.items.length; i++) cum[i + 1] = cum[i] + estimate(m.items[i]);
  return cum;
}

// Items [i, j) under the scroller's viewport (from the heights known so far).
function visibleRange(table, m, cum) {
  const sc = scrollerOf(table);
  const head = table.tHead ? table.tHead.getBoundingClientRect().height : 0;
  const tr = table.getBoundingClientRect();
  const vr = sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
  const top = vr.top - tr.top - head, bot = vr.bottom - tr.top - head;
  const n = m.items.length;
  let i = 0;
  while (i < n && cum[i + 1] <= top) i++;
  let j = i;
  while (j < n && cum[j] < bot) j++;
  return [Math.min(i, n), Math.max(j, Math.min(i + 1, n))];
}

function spacerHtml(which, cols, h) {
  return "<tr class='rn-spacer' data-sp='" + which + "' aria-hidden='true'><td colspan='" + (cols.length + 2) + "' style='height:" + h.toFixed(1) + "px'></td></tr>";
}

function paintTable(table, m) {
  const cols = m.cols, n = m.items.length;
  _stash.clear();
  table.setAttribute("aria-rowcount", String(n + 1));
  m.windowed = n > WINDOW_MIN;
  if (!m.windowed) {
    m.a = 0; m.b = n;
    table.innerHTML = headHtml(cols) + "<tbody>" + m.items.map((it, i) => itemHtml(it, cols, i)).join("") + "</tbody>";
    afterInsert(table, m, 0, n);
    return;
  }
  const cum = prefix(m);
  let a = 0, b = Math.min(n, 40 + OVERSCAN);
  if (table.tBodies[0] && table.offsetParent) {
    const [i, j] = visibleRange(table, m, cum);
    a = Math.max(0, i - OVERSCAN); b = Math.min(n, j + OVERSCAN);
  }
  m.a = a; m.b = b;
  let body = "";
  for (let k = a; k < b; k++) body += itemHtml(m.items[k], cols, k);
  table.innerHTML = headHtml(cols) + "<tbody>" + sizerHtml(m) + spacerHtml("top", cols, cum[a]) + body + spacerHtml("bot", cols, cum[n] - cum[b]) + "</tbody>";
  afterInsert(table, m, a, b);
  wireWindow(table);
  requestAnimationFrame(() => paintWindow());
}

// Heights of the drawn items (one layout read for all of them).
function measure(table, m) {
  const tb = table.tBodies[0];
  if (!tb) return;
  const acc = new Map();
  for (const tr of tb.rows) {
    const vi = tr.dataset.vi;
    if (vi == null) continue;
    acc.set(+vi, (acc.get(+vi) || 0) + tr.getBoundingClientRect().height);
  }
  for (const [i, h] of acc) {
    const it = m.items[i];
    if (!it || !h) continue;
    _heights.set(it.key, h);
    if (!it.group && originOf(it.run).kind !== "fix") _rowH = h;
  }
}

let _winRaf = 0;
function paintWindow() {
  _winRaf = 0;
  const m = _model, table = document.getElementById("runs-table");
  if (!m || !m.windowed || !table || !table.tBodies[0] || !table.offsetParent) return;
  measure(table, m);
  const cum = prefix(m), n = m.items.length;
  const [i, j] = visibleRange(table, m, cum);
  const ok = (m.a === 0 || i >= m.a + MARGIN) && (m.b === n || j <= m.b - MARGIN);
  if (!ok) moveWindow(table, m, Math.max(0, i - OVERSCAN), Math.min(n, j + OVERSCAN));
  setSpacers(table, m, cum);
}

function setSpacers(table, m, cum) {
  const n = m.items.length;
  const top = table.querySelector("tr[data-sp='top'] > td"), bot = table.querySelector("tr[data-sp='bot'] > td");
  if (top) top.style.height = cum[m.a].toFixed(1) + "px";
  if (bot) bot.style.height = (cum[n] - cum[m.b]).toFixed(1) + "px";
}

function htmlOf(m, from, to) {
  let s = "";
  for (let k = from; k < to; k++) if (!_stash.has(m.items[k].key)) s += itemHtml(m.items[k], m.cols, k);
  return s;
}

// Draw items [a, b): drop the rows that left, add the ones that came in.
function moveWindow(table, m, a, b) {
  const tb = table.tBodies[0];
  const topSp = tb.querySelector("tr[data-sp='top']"), botSp = tb.querySelector("tr[data-sp='bot']");
  if (!topSp || !botSp || (a === m.a && b === m.b)) return;
  const keep = (k) => k >= a && k < b;
  for (const tr of [...tb.rows]) {
    const vi = tr.dataset.vi;
    if (vi == null || keep(+vi)) continue;
    const it = m.items[+vi];
    // An open sweep's summary keeps its rows (and what they show).
    if (it && it.group && it.open) {
      const list = _stash.get(it.key) || [];
      list.push(tr);
      _stash.set(it.key, list);
    }
    tr.remove();
  }
  const overlap = a < m.b && b > m.a;
  const ins = (anchor, where, from, to) => {
    if (from >= to) return;
    anchor.insertAdjacentHTML(where, htmlOf(m, from, to));
    // Kept rows (a sweep's summary) go back where they belong.
    for (let k = from; k < to; k++) restore(tb, m, k);
  };
  if (overlap) {
    ins(topSp, "afterend", a, Math.min(m.a, b));
    ins(botSp, "beforebegin", Math.max(m.b, a), b);
  } else ins(botSp, "beforebegin", a, b);
  const was = [m.a, m.b];
  m.a = a; m.b = b;
  paintViewing();
  // Only the newly drawn items need their summary or report painted.
  const fresh = [];
  for (let k = a; k < b; k++) if (!overlap || k < was[0] || k >= was[1]) fresh.push(k);
  if (fresh.length) afterInsert(table, m, fresh[0], fresh[fresh.length - 1] + 1, new Set(fresh));
}

function restore(tb, m, k) {
  const it = m.items[k];
  const list = _stash.get(it.key);
  if (!list) return;
  _stash.delete(it.key);
  // Put the kept rows right after the row before them (or the top spacer).
  let before = null;
  for (let p = k - 1; p >= 0 && !before; p--) {
    const rows = tb.querySelectorAll("tr[data-vi='" + p + "']");
    if (rows.length) before = rows[rows.length - 1];
  }
  if (!before) before = tb.querySelector("tr[data-sp='top']");
  let at = before;
  for (const tr of list) { at.after(tr); at = tr; }
  it._kept = true;
}

// After rows are drawn: the open sweeps' summaries.
function afterInsert(table, m, from, to, only = null) {
  for (let k = from; k < to; k++) {
    if (only && !only.has(k)) continue;
    const it = m.items[k];
    if (it._kept) { it._kept = false; continue; }
    if (it.group && it.open) {
      const el = table.querySelector(".rn-sw-sum[data-sum='" + CSS.escape(it.gk) + "']");
      const g = it.group.runs;
      if (el && g.length) import("./sweeps.js").then((mod) => mod.paintSweepSummary(el, it.group.sw, g, { verdictOf, failCode, baseline: baselineTag(g[0]._design) }));
    }
  }
}

// The widest cell of each column, from every row: up to three collapsed rows.
function cellWidthKey(c, it) {
  const r = it.run;
  if (c.id === "verdict") { const v = verdictOf(r); return String(v.label || v.state).length; }
  if (c.id === "when") return when(r.started_at).length;
  if (c.id === "origin") return originText(r).length;
  if (c.id === "design") return designLabel(r._design).length;
  if (c.id === "pdk") return (r.pdk || "").length;
  if (c.id === "note") return Math.min(26, (r.note || "").split("\n")[0].length);
  if (c.id === "changed" || c.id === "checks") return Math.min(c.id === "changed" ? 26 : 99, cellHtml(c, r, baselineRowFor(r)).replace(/<[^>]*>/g, "").length);
  const v = c.get ? c.get(r) : null;
  if (v == null) return 0;
  const neg = (c.id === "wns" || c.id === "tns" || c.id === "hold") && v < 0 ? 0.5 : 0;
  return String(c.f ? c.f(v) : v).length + neg;
}
function nameWidthKey(it, cols) {
  const r = it.run;
  const vals = it.child ? pointValues(r, it.child) : null;
  return r.tag.length + (vals ? valuesText(vals).length * 0.9 + 1 : 0) + (r.pinned ? 2 : 0) + (r.imported ? 9 : 0) +
    (r.note && !cols.some((c) => c.id === "note") ? 2 : 0) + (isViewingRun(r) ? 7 : 0) + (vals ? 3 : 0);
}
function isViewingRun(r) { return r.tag === contextRun() && normDir(r._design) === normDir(contextDesign()); }

function sizerHtml(m) {
  const cols = m.cols, N = 3;
  _viewingKey = normDir(contextDesign()) + "|" + contextRun();
  const top = new Map(cols.map((c) => [c.id, []]));
  const push = (id, score, it) => {
    const l = top.get(id);
    if (!score) return;
    if (l.length < N || score > l[l.length - 1][0]) {
      l.push([score, it]); l.sort((x, y) => y[0] - x[0]); if (l.length > N) l.pop();
    }
  };
  top.set("_lineage", []); top.set("_sweep", []);
  for (const it of m.items) {
    if (it.group) { push("_sweep", sweepNameText(it.group).length, it); continue; }
    for (const c of cols) push(c.id, c.id === "name" ? nameWidthKey(it, cols) : cellWidthKey(c, it), it);
    if (originOf(it.run).kind === "fix") push("_lineage", lineageHtml(it.run).replace(/<[^>]*>/g, "").length, it);
  }
  let out = "";
  for (let k = 0; k < N; k++) {
    let any = false;
    const tds = cols.map((c) => {
      // The third row's name cell is the longest "fix of …" line, if any.
      const pick = c.id === "name" && k === N - 1 && top.get("_lineage").length ? top.get("_lineage")[0] : top.get(c.id)[k];
      if (!pick) return "<td class='rn-c-" + c.id + "'></td>";
      any = true;
      const it = pick[1];
      if (c.id === "name") return nameCellHtml(it.run, cols, it.child || null, isViewingRun(it.run));
      return cellHtml(c, it.run, baselineRowFor(it.run));
    }).join("");
    if (any) out += "<tr class='rn-sizer' aria-hidden='true'><td class='rn-c-pick'></td><td class='rn-c-base'></td>" + tds + "</tr>";
  }
  const sw = top.get("_sweep")[0];
  if (sw) out += sweepRowHtml(sw[1].group, cols, sw[1].gk, false).replace("<tr class='rn-sweep", "<tr aria-hidden='true' class='rn-sizer rn-sweep");
  return out;
}

function repaintSizer() {
  const m = _model, table = document.getElementById("runs-table");
  if (!m || !m.windowed || !table || !table.tBodies[0]) return;
  const tb = table.tBodies[0];
  tb.querySelectorAll("tr.rn-sizer").forEach((tr) => tr.remove());
  tb.insertAdjacentHTML("afterbegin", sizerHtml(m));
}

let _winWired = null;
function wireWindow(table) {
  const sc = scrollerOf(table);
  if (_winWired !== sc) {
    if (_winWired) _winWired.removeEventListener("scroll", onWinScroll);
    (sc === document.scrollingElement ? window : sc).addEventListener("scroll", onWinScroll, { passive: true });
    _winWired = sc;
  }
  if (table._winKeys) return;
  table._winKeys = true;
  // Tab / Shift+Tab off the last / first drawn row: draw the next rows first,
  // so focus moves into them as if every row were there.
  table.addEventListener("keydown", (e) => {
    const m = _model;
    if (e.key !== "Tab" || !m || !m.windowed) return;
    const tr = e.target.closest && e.target.closest("tr[data-vi]");
    if (!tr) return;
    const vi = +tr.dataset.vi, n = m.items.length;
    if (!e.shiftKey && vi >= m.b - 1 && m.b < n) moveWindow(table, m, m.a, Math.min(n, m.b + OVERSCAN));
    else if (e.shiftKey && vi <= m.a && m.a > 0) moveWindow(table, m, Math.max(0, m.a - OVERSCAN), m.b);
    else return;
    setSpacers(table, m, prefix(m));
  });
}
function onWinScroll() {
  if (!_winRaf && _model && _model.windowed) _winRaf = requestAnimationFrame(paintWindow);
}

function cellHtml(c, r, base) {
  if (c.id === "verdict") {
    const v = verdictOf(r);
    return "<td class='rn-c-verdict'><span class='rn-v is-" + (VERDICT_TONE[v.state] || "warn") + "'><i aria-hidden='true'></i>" + esc(v.label || v.state) + "</span></td>";
  }
  if (c.id === "name") return "";        // drawn by rowHtml
  if (c.id === "when") return "<td class='rn-c-when' title='" + esc(r.started_at || "") + "'>" + esc(when(r.started_at)) + "</td>";
  if (c.id === "origin") return "<td class='rn-c-origin'>" + esc(originText(r) === "fix" ? "fix" : originText(r)) + "</td>";
  if (c.id === "design") return "<td class='rn-c-design'>" + esc(designLabel(r._design)) + "</td>";
  if (c.id === "pdk") return "<td class='rn-c-pdk'>" + esc(r.pdk || "") + "</td>";
  if (c.id === "note") return "<td class='rn-c-note' title='" + esc(r.note || "") + "'>" + esc((r.note || "").split("\n")[0]) + "</td>";
  if (c.id === "changed") {
    const ch = CHANGES.get(keyOf(r));
    if (!baselineTag(r._design)) return "<td class='rn-c-changed muted'></td>";
    if (baselineTag(r._design) === r.tag) return "<td class='rn-c-changed'><span class='rn-basetag'>baseline</span></td>";
    if (!ch) return "<td class='rn-c-changed muted'>…</td>";
    if (!ch.length) return "<td class='rn-c-changed muted'>same settings</td>";
    const txt = ch.slice(0, 2).map((x) => x.var + " " + short(x.from) + "→" + short(x.to)).join(", ") + (ch.length > 2 ? " +" + (ch.length - 2) : "");
    return "<td class='rn-c-changed' title='" + esc(ch.map((x) => x.var + ": " + x.from + " → " + x.to).join("\n")) + "'>" + esc(txt) + "</td>";
  }
  if (c.id === "checks") {
    const k = checksOf(r);
    if (!k) return "<td class='rn-c-checks is-num muted'></td>";
    // LibreLane's metric says clean; a DRC report listing markers anyway is
    // flagged (verdict.drc_disagree), with Verify's DRC section one click away.
    const dd = r.verdict && r.verdict.drc_disagree;
    if (!k.total && dd && dd.markers) {
      return "<td class='rn-c-checks is-num'><span class='rn-clean'>clean</span> <button class='rn-drcflag' data-act='drc' title='" +
        esc("The DRC report files list " + dd.markers + " markers but LibreLane's metric says 0. Open Verify's Design rules.") + "'>· report: " + dd.markers + "</button></td>";
    }
    if (!k.total) return "<td class='rn-c-checks is-num'><span class='rn-clean'>clean</span></td>";
    const parts = [k.drc ? "DRC " + k.drc : "", k.lvs ? "LVS " + k.lvs : "", k.ant ? "ant " + k.ant : ""].filter(Boolean);
    return "<td class='rn-c-checks is-num'><span class='rn-bad'>" + esc(parts.join(" · ")) + "</span></td>";
  }
  const v = c.get(r);
  if (v == null) return "<td class='rn-c-" + c.id + " is-num muted'></td>";
  let cls = "", delta = "";
  // Only finished runs are measured against the baseline (a stopped run is "faster").
  if (c.dir && base && /passed|warning/.test(verdictOf(r).state)) {
    const b = c.get(base);
    if (b != null) {
      const d = v - b;
      const same = Math.abs(d) <= Math.max(Math.abs(b) * 5e-4, c.id === "runtime" ? 1 : 0.005);
      if (!same) {
        cls = (d > 0) === (c.dir > 0) ? " is-better" : " is-worse";
        delta = " (baseline " + (c.f ? c.f(b) : b) + ")";
      }
    }
  }
  const neg = (c.id === "wns" || c.id === "tns" || c.id === "hold") && v < 0 ? " is-neg" : "";
  // The tooltip has more digits than the cell, not all sixteen of the float.
  const exact = c.id === "runtime" ? fmtDur(v) : String(Number(v.toPrecision(6))) + (c.unit ? " " + c.unit : "");
  return "<td class='rn-c-" + c.id + " is-num" + cls + neg + "' title='" + esc(c.label + ": " + exact + delta) + "'>" + esc(c.f ? c.f(v) : v) + "</td>";
}
const short = (s) => { s = String(s ?? "—"); return s.length > 14 ? s.slice(0, 13) + "…" : s; };

function rowHtml(r, cols, { child = null } = {}) {
  const k = keyOf(r);
  const base = baselineRowFor(r);
  const isBase = baselineTag(r._design) === r.tag;
  const name = nameCellHtml(r, cols, child);
  const cells = cols.map((c) => (c.id === "name" ? name : cellHtml(c, r, base))).join("");
  return "<tr class='rn-row" + (child ? " is-child" : "") + (_picked.has(k) ? " is-picked" : "") + (_open === k ? " is-open" : "") + "' data-key='" + esc(k) + "' data-tag='" + esc(r.tag) + "' data-design='" + esc(r._design || "") + "'>" +
    "<td class='rn-c-pick'><input type='checkbox' class='rn-pick' aria-label='Select " + esc(r.tag) + "'" + (_picked.has(k) ? " checked" : "") + "/></td>" +
    "<td class='rn-c-base'><button class='rn-star" + (isBase ? " is-on" : "") + "' data-act='base' aria-pressed='" + isBase + "' title='" +
      (isBase ? "The baseline of " + esc(designLabel(r._design)) + ". Click to clear." : "Make this the baseline") + "'>" + icon("star", { size: 13 }) + "</button></td>" +
    cells + "</tr>";
}

// viewing: show the "shown" chip as the row that has it would (sizer rows only).
function nameCellHtml(r, cols, child, viewing = false) {
  const k = keyOf(r);
  const vals = child ? pointValues(r, child) : null;
  return "<td class='rn-c-name'><div class='rn-name'>" +
    "<button class='rn-exp' data-act='expand' aria-expanded='" + (_open === k) + "' title='Numbers, settings and actions' aria-label='Details of " + esc(r.tag) + "'>" + icon("chevron", { size: 12 }) + "</button>" +
    "<span class='rn-tag'>" + esc(r.tag) + "</span>" +
    (vals ? Object.entries(vals).map(([kk, x]) => "<span class='rn-kv'>" + esc(kk) + " <b>" + esc(x) + "</b></span>").join("") : "") +
    (r.pinned ? "<span class='rn-pin' title='Pinned'>" + icon("star", { size: 11 }) + "</span>" : "") +
    (r.imported ? "<span class='rn-chip'>imported</span>" : "") +
    (r.note && !cols.some((c) => c.id === "note") ? "<span class='rn-hasnote' title='" + esc(r.note) + "'>" + icon("file", { size: 11 }) + "</span>" : "") +
    "<span class='rn-viewing' title='Flow, Layout, Analytics and Verify show this run'" + (viewing ? " style='display:inline-block'" : "") + ">shown</span></div>" + lineageHtml(r) + "</td>";
}

// "FP_CORE_UTIL 40–70" (a range when the values are numbers), axes joined by ×.
function sweepAxesText(sw) {
  return (sw.axes || []).map((a) => {
    const vs = (a.values || []).map(String);
    const nums = vs.map(Number);
    const range = nums.every(Number.isFinite) && vs.length > 2 ? Math.min(...nums) + "–" + Math.max(...nums) : vs.join(", ");
    return a.var + " " + range;
  }).join(" × ") || "settings";
}
const sweepNameText = (g) => "Sweep " + sweepAxesText(g.sw) + " 00";

// A sweep's row lines up with the columns: how many runs and how they went
// under Result, and under each number the best of its clean runs (hover says
// which run). Its runs, and the summary, show when it is open.
function sweepRowHtml(g, cols, gk, open) {
  const sw = g.sw, rs = g.runs;
  const failed = rs.filter((r) => verdictOf(r).state === "failed");
  const reasons = [...new Set(failed.map((r) => failCode(r)).filter(Boolean))];
  const passed = rs.filter((r) => verdictOf(r).state === "passed");
  const running = rs.some((r) => verdictOf(r).state === "running");
  // Fewer runs than planned: say why (a Stop, or "stop at the first clean").
  const short = Number.isFinite(sw.count) && rs.length < sw.count;
  const stopped = rs.some((r) => verdictOf(r).state === "stopped");
  const why = running ? "Running now" : short ? (stopped ? "You stopped it" : sw.stop_when_good && passed.length ? "Stopped at the first clean run" : "") : "";
  const tone = running ? "live" : failed.length && !passed.length ? "fail" : failed.length || (short && stopped) ? "warn" : passed.length ? "pass" : "warn";
  const count = rs.length + (short ? " of " + sw.count : "") + " run" + ((short ? sw.count : rs.length) === 1 ? "" : "s");
  const cell = (c) => {
    if (c.id === "name") {
      return "<td class='rn-c-name'><div class='rn-name'>" +
        "<button class='rn-exp' data-act='group' aria-expanded='" + open + "' aria-label='" + (open ? "Hide" : "Show") + " the runs of this sweep'>" + icon("chevron", { size: 12 }) + "</button>" +
        "<span class='rn-swtag'>Sweep</span><span class='rn-sw-axes'>" + esc(sweepAxesText(sw)) + "</span></div></td>";
    }
    if (c.id === "verdict") {
      return "<td class='rn-c-verdict'" + (why ? " title='" + esc(why) + "'" : "") + "><span class='rn-v is-" + tone + "'><i aria-hidden='true'></i>" + esc(count) +
        (failed.length ? "<span class='rn-sw-n'>· <span class='rn-bad'>" + failed.length + " failed</span></span>" : why && !running ? "<span class='rn-sw-n'>· " + esc(stopped ? "stopped" : "first clean") + "</span>" : "") + "</span></td>";
    }
    // An old manifest's time had no zone: the server read it as its own clock
    // (dse.load_sweeps) and says so; the dotted line shows it is assumed.
    if (c.id === "when") {
      return "<td class='rn-c-when'><span class='rn-sw-when" + (sw.created_at_note ? " is-assumed" : "") + "'" +
        (sw.created_at_note ? " title='" + esc(sw.created_at_note) + "'" : "") + ">" + esc(when(sw.created_at)) + "</span></td>";
    }
    if (c.id === "origin") return "<td class='rn-c-origin'>sweep</td>";
    if (c.id === "design") return "<td class='rn-c-design'>" + esc(designLabel(rs[0] && rs[0]._design)) + "</td>";
    if (c.id === "checks") {
      if (failed.length) return "<td class='rn-c-checks is-num'><span class='rn-bad'>" + esc(reasons.length ? "failed: " + reasons.join(", ") : failed.length + " failed") + "</span></td>";
      const ks = passed.map(checksOf).filter(Boolean);
      return "<td class='rn-c-checks is-num'>" + (ks.length && ks.every((k) => !k.total) ? "<span class='rn-clean'>clean</span>" : "") + "</td>";
    }
    if (c.id === "runtime") {
      const t = rs.map((r) => num(r.wall_time_s)).filter((v) => v != null);
      return "<td class='rn-c-runtime is-num rn-best'" + (t.length ? " title='" + esc("All " + rs.length + " runs together") + "'" : "") + ">" + (t.length ? esc(fmtDur(t.reduce((a, b) => a + b, 0))) : "") + "</td>";
    }
    if (c.dir && c.get) {
      let best = null;
      for (const r of passed) { const v = c.get(r); if (v != null && (!best || (c.dir > 0 ? v > best.v : v < best.v))) best = { v, r }; }
      if (!best) return "<td class='rn-c-" + c.id + " is-num'></td>";
      return "<td class='rn-c-" + c.id + " is-num rn-best' title='" + esc("Best of this sweep's clean runs: " + best.r.tag) + "'>" + esc(c.f ? c.f(best.v) : best.v) + "</td>";
    }
    return "<td class='rn-c-" + c.id + (c.get ? " is-num" : "") + "'></td>";
  };
  const n = cols.length + 2;
  return "<tr class='rn-sweep" + (open ? " is-open" : "") + "' data-group='" + esc(gk) + "'><td class='rn-c-pick'></td><td class='rn-c-base'></td>" +
    cols.map(cell).join("") + "</tr>" +
    (open ? "<tr class='rn-sweep-sum'><td colspan='" + n + "'><div class='rn-sw-sum' data-sum='" + esc(gk) + "'></div></td></tr>" : "");
}

// "DPL-0036": the error code in the failed run's reason, else its stage.
function failCode(r) {
  const sw = sweepOf(r);
  const res = sw && sw.results && sw.results[r.tag];
  const rx = RX.get(keyOf(r));
  const text = (res && res.reason) || (rx && ((rx.card && rx.card.title) || (rx.errors || [])[0])) || "";
  const m = /\b([A-Z]{2,4}-\d{4})\b/.exec(text) || /\b([A-Z]{2,4}-\d{4})\b/.exec(((rx && rx.errors) || []).join(" "));
  if (m) return m[1];
  const st = (res && res.stage) || (rx && rx.stage);
  return st ? FS.stageLabel(st) : "";
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const hm = localeTime(d, [], { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return "today " + hm;
  if (days === 1) return "yesterday " + hm;
  if (days < 7) return days + " days ago";
  return localeDate(d, [], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// ------------------------------------------------------------------ table events
function rowOf(el, runs) {
  const tr = el.closest("tr[data-key]");
  return tr ? runs.find((r) => keyOf(r) === tr.dataset.key) : null;
}

function wireTable(table, runs) {
  table.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.sort;
    _sort = _sort.col === id ? { col: id, dir: -_sort.dir } : { col: id, dir: ["name", "pdk", "origin", "design", "note"].includes(id) ? 1 : -1 };
    safeStorage.setJSON(SORT_KEY, _sort);
    renderRuns({ cached: true });
  }));
  table.onclick = (e) => {
    const t = e.target;
    if (t.closest("tr.rn-sweep-sum")) return;
    const grp = t.closest("tr.rn-sweep");
    if (grp) {
      const gk = grp.dataset.group;
      if (_openSweeps.has(gk)) _openSweeps.delete(gk); else _openSweeps.add(gk);
      safeStorage.setJSON(OPEN_KEY, [..._openSweeps]);
      renderRuns({ cached: true });
      return;
    }
    const r = rowOf(t, runs);
    if (!r) return;
    if (t.closest(".rn-pick")) {
      const k = keyOf(r);
      if (t.checked) {
        if (_picked.size >= 6) { t.checked = false; toast.show("Compare takes up to six runs.", "info"); return; }
        _picked.add(k);
      } else _picked.delete(k);
      t.closest("tr").classList.toggle("is-picked", t.checked);
      syncSelection();
      return;
    }
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "base") {
      const isBase = baselineTag(r._design) === r.tag;
      setBaselineTag(r._design, isBase ? "" : r.tag);
      // The results pages compare with it too, when it isn't the run they show.
      if (!isBase && normDir(r._design) === normDir(contextDesign()) && r.tag !== contextRun()) setBaseline(r.tag);
      _changesKey = "";
      renderRuns({ cached: true });
      return;
    }
    if (act === "expand") { toggleOpen(r); return; }
    // The DRC "report disagrees" flag: this run, in Verify's Design rules.
    if (act === "drc") { e.stopPropagation(); Promise.resolve(setRun(r.tag, r._design)).then(() => go("verify", { section: "vf-drc" })); return; }
    setRun(r.tag, r._design);
    // The run panel follows the row you click while it is open.
    if (_open && _open !== keyOf(r)) openSide(r);
  };
  table.ondblclick = (e) => { const r = rowOf(e.target, runs); if (r && !e.target.closest(".rn-pick, [data-act]")) toggleOpen(r); };
  // The open sweeps' summaries: paintTable / afterInsert.
}

function toggleOpen(r) {
  if (_open === keyOf(r)) { closeSide(); return; }
  setRun(r.tag, r._design);
  openSide(r);
}

let _viewingKey = "";
function paintViewing() {
  const run = contextRun(), design = normDir(contextDesign());
  document.querySelectorAll("#runs-table tr.rn-row").forEach((tr) =>
    tr.classList.toggle("is-viewing", tr.dataset.tag === run && normDir(tr.dataset.design) === design));
  // The "shown" chip widens its row's name: the sizer rows follow it.
  const vk = design + "|" + run;
  if (vk !== _viewingKey) { _viewingKey = vk; repaintSizer(); }
}

// ------------------------------------------------------------------ selection
function pickedRuns() { return _shown.runs.filter((r) => _picked.has(keyOf(r))); }
function syncSelection() {
  const bar = document.getElementById("rn-selbar");
  if (!bar) return;
  // Runs that are gone (deleted, filtered by scope) leave the selection.
  const live = new Set(_shown.runs.map(keyOf));
  for (const k of [..._picked]) if (!live.has(k)) _picked.delete(k);
  const n = _picked.size;
  bar.hidden = n === 0;
  if (!n) return;
  bar.innerHTML = "<b>" + n + " run" + (n === 1 ? "" : "s") + " selected</b>" +
    "<button class='btn btn-primary btn-sm' data-sel='compare'" + (n < 2 ? " disabled title='Pick at least two'" : "") + ">" + icon("diff", { size: 13 }) + " Compare</button>" +
    "<button class='btn btn-ghost btn-sm' data-sel='delete'>" + icon("trash", { size: 13 }) + " Delete</button>" +
    "<button class='btn btn-ghost btn-sm' data-sel='clear'>Clear</button>" +
    (n < 2 ? "<span class='muted'>Tick one more to compare.</span>" : "");
  bar.querySelector("[data-sel='compare']").onclick = () => compareRuns(pickedRuns());
  bar.querySelector("[data-sel='delete']").onclick = () => batchDelete();
  bar.querySelector("[data-sel='clear']").onclick = () => { _picked.clear(); renderRuns({ cached: true }); };
}

export async function compareRuns(runs) {
  if (runs.length < 2) return;
  const m = await import("./compare.js");
  m.preselectCompare(runs.map((r) => r.run_dir).filter(Boolean));
  // Showing Analytics renders Compare, which ticks the pick and compares.
  go("analytics", { section: "analytics-compare" });
}

// ------------------------------------------------------------------ lazy facts
// Why each failed run failed (the same reading Flow uses), for "failed at
// Placement" and the sweep's "(DPL-0036)". Active design only (the endpoint
// resolves against it); a dozen at most per render.
let _rxBusy = false;
async function explainFailed(runs) {
  if (_rxBusy) return;
  const todo = runs.filter((r) => !r.success && !(r.verdict && r.verdict.stage) && !RX.has(keyOf(r)) &&
    normDir(r._design) === normDir(state.designDir)).slice(0, 12);
  if (!todo.length) return;
  _rxBusy = true;
  try {
    for (const r of todo) {
      try { RX.set(keyOf(r), await api.runExplain(r.tag)); } catch (_e) { RX.set(keyOf(r), {}); }
    }
  } finally { _rxBusy = false; }
  renderRuns({ cached: true });
}

// What each run changed against its design's baseline: one /api/compare over
// the design's runs (resolved configs), keys that are run paths left out.
const NOISE = /^(meta|DESIGN_DIR|.*_PATH|.*_FILE|.*_FILES|RUN_TAG|.*_DIR)$/;
async function loadChanges(runs) {
  const byDesign = new Map();
  for (const r of runs) {
    const b = baselineTag(r._design);
    if (!b) continue;
    if (!byDesign.has(r._design)) byDesign.set(r._design, []);
    byDesign.get(r._design).push(r);
  }
  const key = [...byDesign].map(([d, rs]) => d + ":" + baselineTag(d) + ":" + rs.map((r) => r.tag + r.started_at).join(",")).join("|");
  if (!key || key === _changesKey) return;
  _changesKey = key;
  for (const [d, rs] of byDesign) {
    const base = rs.find((r) => r.tag === baselineTag(d));
    if (!base) continue;
    const list = rs.slice(0, 40);
    try {
      const data = await api.compare(list.map((r) => r.tag), list.map((r) => r.run_dir));
      const diff = (data && (data.config_diff || (data.data || {}).config_diff)) || {};
      for (const r of list) {
        const out = [];
        for (const [k, per] of Object.entries(diff)) {
          if (NOISE.test(k)) continue;
          const a = per[r.run_dir], b = per[base.run_dir];
          if (JSON.stringify(a) !== JSON.stringify(b) && !/\/runs\//.test(JSON.stringify(a) + JSON.stringify(b))) out.push({ var: k, from: show(b), to: show(a) });
        }
        CHANGES.set(keyOf(r), out);
      }
    } catch (_e) { /* the column stays "…"; nothing else depends on it */ }
  }
  if (key === _changesKey) renderRuns({ cached: true });
}
const show = (v) => (v == null ? "unset" : typeof v === "object" ? JSON.stringify(v) : String(v));

// ------------------------------------------------------------------ live sweep
let _poll = null;
async function paintLive() {
  const el = document.getElementById("rn-live");
  if (!el) return;
  let st = null;
  try { st = await api.dseStatus(); st = st && (st.data || st); } catch (_e) { st = null; }
  if (!st || !st.active) {
    el.hidden = true;
    if (_poll) { clearInterval(_poll); _poll = null; renderRuns(); }
    return;
  }
  const done = (st.done || []).length + (st.failed || []).length;
  el.hidden = false;
  el.innerHTML = "<span class='rn-live-dot' aria-hidden='true'></span><b>Sweep running</b> · run " + Math.min(done + 1, st.total || done + 1) + " of " + (st.total || "?") +
    (st.running ? " · <code>" + esc(st.running) + "</code>" : "") +
    ((st.failed || []).length ? " · <span class='rn-bad'>" + st.failed.length + " failed</span>" : "") +
    "<span class='rn-spacer'></span><button class='btn btn-ghost btn-sm' data-go='pipeline'>" + icon("flow", { size: 13 }) + " Watch in Flow</button>" +
    "<button class='btn btn-ghost btn-sm' id='rn-sweep-stop'>" + icon("stop", { size: 13 }) + " Stop sweep</button>";
  el.querySelector("#rn-sweep-stop").onclick = async () => {
    if (!(await confirmDialog({ title: "Stop the sweep?", confirmText: "Stop sweep", danger: true,
      body: "The run that is going stops now and the rest are not run. Finished runs are kept." }))) return;
    try { await api.dseCancel(); toast.show("Sweep stopped.", "success"); } catch (ex) { toast.show("Couldn't stop: " + (ex.message || ex), "error"); }
    paintLive();
  };
  if (!_poll) _poll = setInterval(() => { if (document.getElementById("sec-runs")?.classList.contains("section-active")) paintLive(); }, 4000);
}

// ------------------------------------------------------------------ the run panel
// One run, beside the table: how it ended, its numbers against the baseline,
// where it came from, and everything you can do with it. On a narrow window
// it sits over the table's right side (runs.css).
const SIDE_NUMS = ["wns", "tns", "hold", "die", "cells", "util", "power", "runtime"];
const sideEl = () => document.getElementById("rn-side");
let _sideRow = null, _sideSeq = 0;

function markOpen() {
  document.querySelectorAll("#runs-table tr.rn-row").forEach((tr) => {
    const on = tr.dataset.key === _open;
    tr.classList.toggle("is-open", on);
    tr.querySelector(".rn-exp")?.setAttribute("aria-expanded", on ? "true" : "false");
  });
}

function openSide(r) {
  const el = sideEl();
  if (!el || !r) return;
  const was = !!_open;
  _open = keyOf(r);
  _sideRow = r;
  el.hidden = false;
  document.getElementById("rn-split")?.classList.add("has-side");
  // The table has less room now: its default columns follow.
  if (!was) renderRuns({ cached: true }); else markOpen();
  paintSide(r);
}

function closeSide() {
  const el = sideEl();
  if (!_open && (!el || el.hidden)) return;
  _open = null; _sideRow = null; _sideSeq++;
  if (el) { el.hidden = true; el.innerHTML = ""; }
  document.getElementById("rn-split")?.classList.remove("has-side");
  if (document.getElementById("sec-runs")?.classList.contains("section-active")) renderRuns({ cached: true }); else markOpen();
}

// After a render: the open run may be gone, or its row may be a fresh one
// (pinned, renamed note); the baseline or the settings read may have changed.
function syncSide() {
  if (!_open) return;
  const r = _shown.runs.find((x) => keyOf(x) === _open);
  if (!r) { closeSide(); return; }
  const host = sideEl();
  if (r !== _sideRow && !(host && host.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA")) { paintSide(r); return; }
  const base = baselineRowFor(r);
  const nums = host && host.querySelector("#rn-side-nums");
  if (nums) nums.innerHTML = sideNumsHtml(r, base);
  const ch = host && host.querySelector("#rn-side-set");
  if (ch) ch.innerHTML = sideSettingsHtml(r);
}

function deltaHtml(c, v, b, r) {
  if (b == null || !/passed|warning/.test(verdictOf(r).state)) return "<span class='rn-d'></span>";
  const d = v - b;
  const same = Math.abs(d) <= Math.max(Math.abs(b) * 5e-4, c.id === "runtime" ? 1 : 0.005);
  if (same) return "<span class='rn-d'>same</span>";
  const sign = d > 0 ? "+" : "−";
  const text = c.unit === "ns" ? sign + Math.abs(d).toFixed(2) + " ns"
    : c.id === "runtime" ? sign + fmtDur(Math.abs(d))
    : c.id === "util" ? sign + Math.abs(d).toFixed(1) + " pt"
    : sign + Math.abs((d / (b || 1)) * 100).toFixed(1) + " %";
  const cls = !c.dir ? "" : (d > 0) === (c.dir > 0) ? " is-better" : " is-worse";
  return "<span class='rn-d" + cls + "' title='" + esc("Baseline: " + (c.f ? c.f(b) : b) + (c.unit ? " " + c.unit : "")) + "'>" + esc(text) + "</span>";
}

function sideNumsHtml(r, base) {
  const rows = COLS.filter((c) => SIDE_NUMS.includes(c.id)).map((c) => {
    const v = c.get(r);
    if (v == null) return "";
    const neg = c.unit === "ns" && v < 0 ? " class='is-neg'" : "";
    const exact = c.id === "runtime" ? fmtDur(v) : String(Number(v.toPrecision(6))) + (c.unit ? " " + c.unit : "");
    return "<div class='rn-num'><dt title='" + esc(c.tip || "") + "'>" + esc(c.label) + "</dt><dd" + neg + " title='" + esc(exact) + "'>" + esc(c.f ? c.f(v) : v) +
      (c.unit ? "<small>" + esc(c.unit) + "</small>" : "") + "</dd>" + (base ? deltaHtml(c, v, c.get(base), r) : "<span class='rn-d'></span>") + "</div>";
  }).join("");
  const k = checksOf(r);
  const checks = !k ? "" : "<div class='rn-num'><dt title='Design-rule errors (worst of Magic, KLayout and the router), LVS errors and antenna violations'>DRC · LVS · Antenna</dt><dd class='" +
    (k.total ? "is-neg" : "") + "'>" + (k.total ? esc([k.drc ? "DRC " + k.drc : "", k.lvs ? "LVS " + k.lvs : "", k.ant ? "ant " + k.ant : ""].filter(Boolean).join(" · ")) : "<span class='rn-clean'>clean</span>") + "</dd><span class='rn-d'></span></div>";
  if (!rows && !checks) return "<p class='rn-side-line muted'>This run ended before it had numbers to show.</p>";
  return "<h4 class='rn-side-h'>Numbers" + (base ? " <small>against the baseline <code>" + esc(base.tag) + "</code></small>" : "") + "</h4><dl class='rn-nums'>" + rows + checks + "</dl>";
}

// Where the run came from and which settings it changed.
function sideSettingsHtml(r) {
  const o = originOf(r), sw = sweepOf(r);
  let from = "";
  if (o.kind === "fix") {
    const ch = (o.changes || []).map((c) => "<li>" + esc(c.var) + " <i>" + esc(c.from) + " →</i> " + esc(c.to) + "</li>").join("");
    from = "<p class='rn-side-line'>A fix of <code>" + esc(o.parent) + "</code>" + (o.stage ? ", resumed at " + esc(FS.stageLabel(o.stage)) : "") + (ch ? " with:" : ".") + "</p>" +
      (ch ? "<ul class='rn-changes'>" + ch + "</ul>" : "");
  } else if (sw) {
    const vals = pointValues(r, sw);
    from = "<p class='rn-side-line'>A point of the sweep " + esc(sweepAxesText(sw)) + (vals ? ":" : ".") + "</p>" +
      (vals ? "<ul class='rn-changes'>" + Object.entries(vals).map(([k, x]) => "<li>" + esc(k) + " <i>=</i> " + esc(x) + "</li>").join("") + "</ul>" : "");
  } else if (r.imported) from = "<p class='rn-side-line'>Imported from elsewhere.</p>";
  const bt = baselineTag(r._design);
  let changed = "";
  if (bt && bt !== r.tag) {
    const ch = CHANGES.get(keyOf(r));
    changed = "<h4 class='rn-side-h' style='margin-top:14px'>Changed <small>against the baseline</small></h4>" +
      (!ch ? "<p class='rn-side-line muted'>Reading the settings…</p>"
        : !ch.length ? "<p class='rn-side-line muted'>The same settings as the baseline.</p>"
        : "<ul class='rn-changes'>" + ch.map((x) => "<li>" + esc(x.var) + " <i>" + esc(x.from) + " →</i> " + esc(x.to) + "</li>").join("") + "</ul>");
  } else if (bt === r.tag) changed = "<p class='rn-side-line muted' style='margin-top:6px'>This run is the baseline.</p>";
  if (!from && !changed) return "";
  return (from ? "<h4 class='rn-side-h'>Where it came from</h4>" + from : "") + changed;
}

// How it ended, in the words Flow and Verify use for the same run.
function sideTopHtml(r, rx, vf) {
  const v = verdictOf(r);
  const tone = VERDICT_TONE[v.state] || "warn";
  let title = v.label || v.state, why = "", act = "", extra = "";
  const flowBtn = (label) => "<button class='btn btn-primary btn-sm' data-ra='flow'>" + icon("flow", { size: 13 }) + " " + label + "</button>";
  if (rx && (rx.kind === "clean" || rx.kind === "checks-failed")) {
    const cv = cardVerdict(vf, rx);
    if (cv) { title = rx.kind === "checks-failed" ? "The layout is done, but " + (cv.short || "checks failed") : cv.title; why = cv.sub || ""; }
    // Verify didn't answer (another design, or it failed): don't promise a reading.
    if (!vf && /Reading the sign-off checks/.test(why)) why = "No step failed. Open Verify for the sign-off checks.";
    if (rx.kind === "checks-failed") act = "<button class='btn btn-primary btn-sm' data-ra='verify'>" + icon("alert", { size: 13 }) + " Show the problems</button>";
    if (rx.warnings && rx.warnings.total) extra = warningsHtml(rx.warnings);
  } else if (rx) {
    const c = rx.card || {};
    // Flow's wording: "You stopped this run" only when it was cancelled; a run
    // that just ended early (no error, no Stop) may have lost LanEx mid-run.
    const cancelled = rx.kind === "stopped";
    const early = !cancelled && (v.state === "stopped" || v.state === "incomplete");
    const at = rx.step ? (rx.step.id || rx.step.dir) + (rx.step.n ? " (step " + rx.step.n + ")" : "") : "";
    title = cancelled ? "You stopped this run" : early ? "This run ended before the last step" : c.title ? c.title : title;
    why = c.plain ? c.plain
      : cancelled ? (at ? "It stopped at " + at + ". " : "") + "Everything before it is kept; run again whenever you're ready."
      : early ? (at ? "Its folder ends at " + at + " with no error" : "It has no error") + ": LanEx may have been closed while it ran. Run it again to finish."
      : at ? "It stopped at " + at + "." : "";
    if (v.state === "failed") act = flowBtn("Why, and how to fix it");
  } else if (v.state === "failed") act = flowBtn("Why, and how to fix it");
  return "<div class='rn-side-verdict is-" + tone + "'><span class='rn-v is-" + tone + "'><i aria-hidden='true'></i>" + esc(title) + "</span>" +
    (why ? "<p>" + esc(why) + "</p>" : "") + act + extra + "</div>";
}

function sideHtml(r, base) {
  const b = (id, label, ic, cls = "btn-ghost") => "<button class='btn " + cls + " btn-sm' data-ra='" + id + "'>" + (ic ? icon(ic, { size: 13 }) + " " : "") + esc(label) + "</button>";
  const d = r.started_at ? new Date(r.started_at) : null;
  const meta = [d && !isNaN(d) ? localeDate(d, [], { day: "numeric", month: "short", year: "numeric" }) + ", " + localeTime(d, [], { hour: "2-digit", minute: "2-digit" }) : "",
    [r.pdk, r.scl].filter(Boolean).join(" / "), getRunScope() === "all" ? designLabel(r._design) : ""].filter(Boolean).join(" · ");
  return "<div class='rn-side-head'><div><div class='an-eyebrow'>Run</div><h3 class='rn-side-tag'>" + esc(r.tag) + "</h3>" +
    (meta ? "<div class='rn-side-meta'>" + esc(meta) + "</div>" : "") + "</div>" +
    "<button class='iconbtn' data-side='close' aria-label='Close the run details (Esc)' title='Close (Esc)'>" + icon("x", { size: 16 }) + "</button></div>" +
    "<div class='rn-side-body'>" +
    "<div id='rn-side-top'>" + sideTopHtml(r, RX.get(keyOf(r)) || null, null) + "</div>" +
    "<section id='rn-side-nums'>" + sideNumsHtml(r, base) + "</section>" +
    "<section id='rn-side-set'>" + sideSettingsHtml(r) + "</section>" +
    "<section><h4 class='rn-side-h'>Open this run in</h4><div class='rn-open-in'>" +
      b("flow", "Flow", "flow", "") + b("layout", "Layout", "grid", "") + b("analytics", "Analytics", "chart", "") + b("verify", "Verify", "check", "") + "</div></section>" +
    "<section><h4 class='rn-side-h'>Actions</h4><div class='rn-actions'>" +
      b("again", "Run again with changes", "play") + b("cmd", "Copy command", "command") + b("pin", r.pinned ? "Unpin" : "Pin", "star") +
      b("bundle", "Bundle…", "download") + b("export", "Report…", "file") + b("files", "Files", "folder") + b("delete", "Delete…", "trash", "btn-ghost rn-del") + "</div></section>" +
    "<section><h4 class='rn-side-h'><label for='rn-note-ta'>Note</label></h4>" +
    "<textarea id='rn-note-ta' class='rn-note-ta' rows='2' placeholder='What you tried, what you saw…'></textarea></section>" +
    "</div>";
}

async function paintSide(r) {
  const host = sideEl();
  if (!host || !r) return;
  const my = ++_sideSeq;
  _sideRow = r;
  const base = baselineRowFor(r);
  const active = normDir(r._design) === normDir(state.designDir);
  host.innerHTML = sideHtml(r, base);
  const ta = host.querySelector("#rn-note-ta");
  ta.value = r.note || "";
  ta.addEventListener("blur", async () => {
    if (ta.value === (r.note || "")) return;
    try { await focusDesign(r._design); await api.setRunNote(r.tag, ta.value); r.note = ta.value; toast.show("Note saved.", "success", 2500); }
    catch (ex) { toast.show("Couldn't save the note: " + (ex.message || ex), "error"); }
  });
  host.querySelector("[data-side='close']").addEventListener("click", () => closeSide());
  host.onclick = (e) => {
    const b = e.target.closest("[data-ra]");
    if (b) { e.stopPropagation(); runAction(b.dataset.ra, r); }
  };
  // How it ended, in Flow's and Verify's words (the same reading both use).
  let rx = RX.get(keyOf(r));
  const [rx2, vfr] = await Promise.all([
    rx || !active ? Promise.resolve(rx || null) : api.runExplain(r.tag, base ? base.tag : undefined).catch(() => null),
    active && (r.success || (r.verdict && r.verdict.state !== "running")) ? api.verify(r.tag).catch(() => null) : Promise.resolve(null),
  ]);
  if (my !== _sideSeq || _open !== keyOf(r)) return;
  rx = rx2;
  const vf = vfr && (vfr.verdict ? vfr : vfr.data && vfr.data.verdict ? vfr.data : null);
  const top = host.querySelector("#rn-side-top");
  if (top) top.innerHTML = sideTopHtml(r, rx, vf);
}

async function runAction(id, r) {
  const d = r._design;
  if (["flow", "layout", "analytics", "verify"].includes(id)) { await setRun(r.tag, d); go(id === "flow" ? "pipeline" : id); return; }
  await focusDesign(d);
  if (id === "again") return reproduceRun(r.tag);
  if (id === "cmd") return copyCommand(r.tag);
  if (id === "pin") return togglePin(r.tag, d, !r.pinned);
  if (id === "bundle") return bundleDownloadFlow(r.tag);
  if (id === "export") return exportRunFlow(r.tag);
  if (id === "files") return showFilesModal(r.tag);
  if (id === "delete") return deleteRunFlow(r.tag);
}

async function copyCommand(tag) {
  let meta;
  try { meta = await api.runGuiMeta(tag); } catch (_e) { meta = null; }
  const cc = meta && meta.cli_command;
  const cli = String((cc && typeof cc === "object" ? (cc[cc.recommended] || cc.container || cc.local) : cc) || "").trim();
  if (!cli) { await alertDialog({ title: "No saved command", body: "LanEx didn't record the command for " + tag + " (it was started elsewhere, or by a sweep before LanEx kept it)." }); return; }
  try { await navigator.clipboard.writeText(cli); toast.show("Command copied.", "success"); }
  catch (_e) { await alertDialog({ title: "The command of " + tag, body: cli }); }
}

// Batch delete every ticked run, grouped by design so each resolves against
// the right active design. One confirm for the whole set.
async function batchDelete() {
  const items = pickedRuns();
  const n = items.length;
  if (!n) return;
  const ok = await confirmDialog({
    title: "Delete " + n + " run" + (n === 1 ? "" : "s") + "?", danger: true,
    confirmText: "Delete " + n + " run" + (n === 1 ? "" : "s"),
    body: items.map((r) => r.tag).join(", ") + "\n\nThis permanently deletes " + (n === 1 ? "this run" : "these runs") + " and all their files. This cannot be undone.",
  });
  if (!ok) return;
  let failed = 0, done = 0;
  const byDesign = new Map();
  for (const r of items) { if (!byDesign.has(r._design)) byDesign.set(r._design, []); byDesign.get(r._design).push(r.tag); }
  for (const [designDir, tags] of byDesign) {
    await focusDesign(designDir);
    for (const tag of tags) {
      try { if (await deleteGuarded(tag)) { if (state.selectedRunTag === tag) state.selectedRunTag = null; done++; } }
      catch (_e) { failed++; }
    }
  }
  _picked.clear();
  await renderRuns();
  if (failed) await alertDialog({ title: "Some deletes failed", body: failed + " run(s) could not be deleted." });
  else toast.show("Deleted " + done + " run" + (done === 1 ? "" : "s") + ".", "success");
}

// Download a support bundle — the user ticks exactly what goes in. Keys match
// bundle.ALL_PARTS on the backend.
const BUNDLE_PARTS = [
  { key: "config", label: "Used config", hint: "config.json + resolved.json + GUI overrides/preset" },
  { key: "sources", label: "RTL source files" },
  { key: "metrics_csv", label: "Metrics CSV" },
  { key: "settings_csv", label: "Settings / constraints / PDK CSV" },
  { key: "analytics_csv", label: "Analytics CSV", hint: "summary + report counts + all metrics" },
  { key: "reports", label: "Signoff reports", hint: ".rpt / .drc / .lvs" },
  { key: "logs", label: "Step logs" },
  // Heavy binary deliverables — off by default (each can be tens–hundreds of MB).
  { key: "gds", label: "GDSII layout", hint: "final .gds / OASIS stream", checked: false },
  { key: "layout_views", label: "Other layout views", hint: "DEF / LEF / OpenDB / Magic", checked: false },
  { key: "netlists", label: "Netlists", hint: "gate-level + powered Verilog, SPICE/CDL, JSON header", checked: false },
  { key: "timing", label: "Timing models", hint: "Liberty .lib / SDF / SPEF / SDC", checked: false },
  { key: "images", label: "Layout images", hint: "KLayout render(s), PNG/SVG", checked: false },
  { key: "diagrams", label: "Yosys diagrams", hint: ".dot schematics + rendered .svg", checked: false },
];
async function bundleDownloadFlow(tag) {
  const picked = await checklistDialog({
    title: "Download bundle: " + tag,
    body: "Select components to include in the .zip archive. Text and report data are selected by default. " +
      "Binary deliverables like GDS, netlists, timing models, and images are large, so select only what you need.",
    items: BUNDLE_PARTS,
    confirmText: "Download .zip",
  });
  if (!picked || !picked.length) return;
  const url = api.runBundleUrl(tag, picked);
  const a = document.createElement("a");
  a.href = url; a.download = tag + "-bundle.zip";
  document.body.appendChild(a); a.click(); a.remove();
  toast.show("Preparing bundle…", "info");
}

// E3 — download a formatted run report (CSV / Markdown / HTML). The backend
// (history.export_run + /api/run-export) already exists; this is the UI for it.
async function exportRunFlow(tag) {
  const fmt = await choiceDialog({
    title: "Export run report: " + tag,
    body: "Download a formatted report for this run. (For the raw metrics table, use Analytics > Metrics CSV.)",
    choices: [
      { label: "CSV", value: "csv" },
      { label: "Markdown", value: "md" },
      { label: "HTML", value: "html" },
    ],
  });
  if (!fmt) return;
  const a = document.createElement("a");
  a.href = api.runExportUrl(tag, fmt);
  a.download = tag + "-report." + fmt;
  document.body.appendChild(a); a.click(); a.remove();
}

// E2 — load a run's saved settings back into Setup so it can be re-run. Reads
// gui-run.json (persisted per run); never auto-starts the run.
async function reproduceRun(tag) {
  let meta;
  try {
    meta = await api.runGuiMeta(tag);
  } catch (ex) {
    await alertDialog({
      title: "Can't reproduce this run",
      body: (ex && ex.message) ||
        "No saved settings found for this run. It was created before reproduce support was available or generated outside the GUI.",
    });
    return;
  }
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  // PDK / SCL — set state + the pickers; refresh the SCL list off the PDK.
  if (meta.pdk) {
    state.selectedPdk = meta.pdk;
    const ps = document.getElementById("pdk-select");
    if (ps) { ps.value = meta.pdk; ps.dispatchEvent(new Event("change")); }
  }
  if (meta.scl) {
    state.selectedScl = meta.scl;
    // The PDK change above repopulates SCLs asynchronously; set after a tick.
    setTimeout(() => { const sc = document.getElementById("scl-select"); if (sc) sc.value = meta.scl; }, 0);
  }
  if (meta.run_mode) state.runMode = meta.run_mode;
  // Config overrides.
  state.varsValues = {};
  for (const [k, v] of Object.entries(meta.overrides || {})) {
    state.varsValues[k] = (typeof v === "boolean") ? v : String(v);
  }
  // Where it stopped: the Run menu's "Run up to" stage, when --to was a stage's
  // last step. (--from and --skip are no longer set from LanEx; see below.)
  const stopSel = document.getElementById("run-stop-after");
  if (stopSel) {
    stopSel.value = "";
    if (meta.to) for (const o of stopSel.options) if (o.value && lastStepOfStage(o.value) === meta.to) stopSel.value = o.value;
    stopSel.dispatchEvent(new Event("change"));
  }
  // Full-auto vs step-by-step.
  const modeVal = meta.mode === "semi" ? "semi" : "auto";
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("mode-btn-active", b.dataset.mode === modeVal));
  // Run name.
  const rn = (meta.tag || tag) + "-repro";
  setVal("run-name-input", rn);
  // Sources (best-effort — files may have moved/been deleted since the run).
  if (Array.isArray(meta.sources) && meta.sources.length) state.selectedFiles = meta.sources.slice();
  // Repaint the config panel + jump to Setup.
  try { const cfg = await import("./config.js"); cfg.renderConfig(); } catch (_e) { /* ignore */ }
  go("setup");
  const summary = "Loaded " + Object.keys(meta.overrides || {}).length + " override(s), " +
    (meta.sources || []).length + " source(s), " + (meta.run_mode || "container") +
    " mode, flow " + (meta.flow || "Classic") + ". Review your settings in Setup, then click Run flow when ready. " +
    "Nothing has started yet." +
    (meta.frm || (meta.skip || []).length ? " That run also used --from or --skip; LanEx runs the whole flow (or up to a stage) instead." : "");
  // E4.4 — offer the EXACT CLI command this run was launched with (persisted in
  // gui-run.json, not rebuilt), so a terminal user can reproduce it verbatim.
  // gui-run.json keeps the command per engine ({container, local, recommended}).
  const cc = meta.cli_command;
  const cli = String((cc && typeof cc === "object" ? (cc[cc.recommended] || cc.container || cc.local) : cc) || "").trim();
  const choices = cli ? [{ label: "Copy the run's CLI command", value: "copy" }] : [];
  const pick = await choiceDialog({
    title: "Loaded " + tag + " into Setup",
    body: summary + (cli ? "\n\nThat run's exact command:\n" + cli : ""),
    choices,
  });
  if (pick === "copy" && cli) {
    try { await navigator.clipboard.writeText(cli); toast.show("CLI command copied.", "success"); }
    catch (_e) { toast.show("Copy failed. The command is shown above: select it and copy it.", "warn"); }
  }
}

// E4.5 — pin/star a run so it's easy to find in a long history. Just a bookmark
// marker; never touches run data.
async function togglePin(tag, designDir, pinned) {
  try {
    await focusDesign(designDir);
    await api.setRunPin(tag, pinned);
    await renderRuns();
  } catch (ex) {
    toast.show("Could not " + (pinned ? "pin" : "unpin") + ": " + (ex.message || ex), "error");
  }
}

// E1 — import a run from elsewhere: adopt a run directory, or restore a LanEx
// export bundle (.zip). Both land under the active design's runs/.
async function importRunFlow() {
  if (!state.designDir) {
    await alertDialog({
      title: "No active design",
      body: "Set a design directory first. Imported runs are saved into its runs directory.",
    });
    return;
  }
  const kind = await choiceDialog({
    title: "Import a run",
    body: "Adopt an existing LibreLane run directory, or restore a LanEx export bundle (.zip). It is copied into this design's runs/ so it survives deletion of the source.",
    choices: [
      { label: "Run folder", value: "dir" },
      { label: "LanEx bundle (.zip)", value: "bundle" },
    ],
  });
  if (!kind) return;
  const path = await importPathDialog(kind);
  if (!path || !path.trim()) return;
  try {
    const res = kind === "dir"
      ? await api.importRunDir(path.trim())
      : await api.importRunBundle({ path: path.trim() });
    await renderRuns();
    let msg = "Imported as '" + res.tag + "'.";
    if (res.warnings && res.warnings.length) msg += " " + res.warnings.join(" ");
    toast.show(msg, "success");
  } catch (ex) {
    await alertDialog({ title: "Import failed", body: (ex && ex.message) || String(ex) });
  }
}

// Where the import comes from: Browse opens the system picker (or the built-in
// browser), and the field still takes a typed or pasted path for remote and
// headless setups where no picker can appear.
async function importPathDialog(kind) {
  const isDir = kind === "dir";
  const seed = (state.designDir || "").replace(/[\\/]+$/, "") + (isDir ? "/runs" : "");
  let inputEl = null;
  const esc = fmt.escape;
  const v = await customDialog({
    title: esc(isDir ? "Adopt a run directory" : "Import a bundle (.zip)"),
    bodyHtml:
      "<label class='dlg-label' for='import-path'>" + esc(isDir
        ? "The run folder (a runs/<tag> folder). Browse to it, or type or paste its full path."
        : "The LanEx bundle (.zip). Browse to it, or type or paste its full path.") + "</label>" +
      "<div class='picker-row'><input class='dlg-input' id='import-path' type='text' autocomplete='off' spellcheck='false'/>" +
      "<button type='button' class='btn btn-ghost' id='import-browse'>Browse…</button></div>",
    buttons: [
      { label: "Cancel", value: null, cls: "btn-ghost" },
      { label: "Import", value: "__GO__", cls: "btn-primary" },
    ],
    onMount: (back, close) => {
      inputEl = back.querySelector("#import-path");
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && inputEl.value.trim()) { e.preventDefault(); close("__GO__"); }
      });
      back.querySelector("#import-browse").addEventListener("click", async () => {
        const m = await import("./fs.js");
        const start = inputEl.value.trim() || seed;
        // Step aside while the picker is up: the built-in browser is an
        // earlier modal in the page and would sit underneath this one.
        back.hidden = true;
        const got = isDir
          ? await m.pickFolder({ title: "Choose the run folder", use: "Import this run", seed: start })
          : await m.pickFile({ title: "Choose the LanEx bundle", use: "Import this bundle", seed: start, exts: [".zip"] });
        back.hidden = false;
        if (got) inputEl.value = got;
        inputEl.focus();
      });
      setTimeout(() => inputEl.focus(), 0);
    },
  });
  return v === "__GO__" && inputEl ? inputEl.value : null;
}

async function deleteRunFlow(tag) {
  const ok = await confirmDialog({
    title: "Delete run " + tag + "?", danger: true, confirmText: "Delete run",
    body: "This permanently deletes run '" + tag + "' and all its files. Consider downloading a bundle first. This cannot be undone.",
  });
  if (!ok) return;
  try {
    if (!(await deleteGuarded(tag))) return;
    if (state.selectedRunTag === tag) state.selectedRunTag = null;
    await renderRuns();
    toast.show("Deleted run '" + tag + "'.", "success");
  } catch (ex) {
    await alertDialog({ title: "Delete failed", body: ex.message || String(ex) });
  }
}

// Runs resumed from another one read that run's earlier steps from its folder:
// the server refuses to delete it while they exist, and this asks once more.
async function deleteGuarded(tag) {
  try {
    await api.deleteRun(tag);
    return true;
  } catch (ex) {
    const kids = ex && ex.status === 409 && ex.body && ex.body.children;
    if (!kids || !kids.length) throw ex;
    const ok = await confirmDialog({
      title: "Other runs were resumed from " + tag, danger: true, confirmText: "Delete it anyway",
      body: kids.join(", ") + (kids.length === 1 ? " was" : " were") + " resumed from '" + tag + "' and " + (kids.length === 1 ? "reads" : "read") +
        " its earlier steps from its folder. Deleted, " + (kids.length === 1 ? "that run" : "those runs") +
        " keep their own results and final GDS, but their earlier steps, pictures and checks go with it.",
    });
    if (!ok) return false;
    await api.deleteRun(tag, true);
    return true;
  }
}

let _filesOverlay = null;
function filesOverlay() {
  if (_filesOverlay) return _filesOverlay;
  const ov = document.createElement("div");
  ov.className = "smodal-backdrop";
  ov.hidden = true;
  ov.innerHTML =
    "<div class='smodal' role='dialog' aria-modal='true' aria-labelledby='files-title'>" +
    "  <div class='smodal-head'><span class='smodal-title' id='files-title'>Files</span>" +
    "  <span class='smodal-spacer'></span><button class='iconbtn' id='files-close' aria-label='Close the file list'><svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M6 6l12 12M18 6L6 18'/></svg></button></div>" +
    "  <div class='smodal-log' id='files-body' style='white-space:normal'></div>" +
    "</div>";
  document.body.appendChild(ov);
  // A dialog on the overlay stack: Esc closes it, Tab stays inside, focus returns.
  const hide = () => { closeLayer(ov); ov.hidden = true; };
  ov.addEventListener("click", (e) => { if (e.target === ov) hide(); });
  ov.querySelector("#files-close").addEventListener("click", hide);
  _filesOverlay = ov;
  return ov;
}

function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function showFilesModal(tag) {
  const ov = filesOverlay();
  ov.hidden = false;
  openLayer(ov, { kind: "dialog", labelledBy: "files-title", onClose: () => { ov.hidden = true; }, focus: () => ov.querySelector("#files-close") });
  ov.querySelector("#files-title").textContent = "Files: " + tag;
  const body = ov.querySelector("#files-body");
  body.textContent = "loading…";
  let r;
  try {
    r = await api.runFiles(tag);
  } catch (ex) {
    body.textContent = "Could not list files: " + (ex.message || ex);
    return;
  }
  const files = (r && r.files) || [];
  // Group by top-level dir (step/final/…) for readability.
  const rows = files
    .filter((f) => !f.dir)
    .map((f) => {
      const url = api.runFileUrl(tag, f.path);
      return (
        "<div class='files-row'><a href='" + url + "' target='_blank' rel='noopener'>" +
        fmt.escape(f.path) + "</a> <span class='muted'>" + fmtBytes(f.size) + "</span></div>"
      );
    });
  body.innerHTML =
    "<div class='muted' style='margin-bottom:8px'>" + rows.length + " files: click to open or download</div>" +
    rows.join("");
}

