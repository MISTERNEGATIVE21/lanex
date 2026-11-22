// sweeps.js — sweeps inside Runs (what the DSE tab used to be): the "New
// sweep" sheet and the summary of a sweep under its row.
//
// A sweep runs the same design with one or more settings at several values,
// one full run per point, one at a time (controller/dse.py, /api/dse/*). Each
// point is named by what it tried (sweep-util-65) and its real outcome is kept.
// Sweeps are a last resort after the RTL and constraints are right; the sheet
// keeps the default small and says so.
//
// Before Start, the server plans the sweep (/api/dse/plan): each setting's
// value in this design and where it comes from, every value checked the way
// LibreLane reads it, the one-off Setup settings that ride along on every
// point, and what would make every point build the same chip (a fixed die).

import { api, fmt } from "./api.js";
import { state } from "./state.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { confirmDialog, customDialog } from "./dialog.js";
import { openLayer, closeLayer } from "./overlay.js";
import { fmtDur } from "./reportcard.js";
import * as FS from "./flowstages.js";
import * as F from "./metricfmt.js";
import { toCsv, downloadCsv } from "./csvutil.js";
import { localeNum } from "./intlcache.js";

const esc = (s) => fmt.escape(s == null ? "" : String(s));
const MAX_RUNS = 64;               // controller/dse.py MAX_COMBOS
export const COMPARE_MAX = 12;     // compare.js MAX

// Goals in plain words -> the settings that move them. Their values are
// filled from this design's own settings when the sheet opens (fillGoal).
const GOALS = [
  { id: "clock", title: "Fastest clock that meets timing", sub: "Shorter clock periods from the one you use now. Every one runs.",
    axes: [{ var: "CLOCK_PERIOD", values: "" }] },
  { id: "area", title: "Smallest die that routes", sub: "Pack the core fuller until routing or placement fails.",
    axes: [{ var: "FP_CORE_UTIL", values: "40:60:10" }] },
  { id: "density", title: "Placement density", sub: "How tightly the placer packs cells (%).",
    axes: [{ var: "PL_TARGET_DENSITY_PCT", values: "50, 60, 70" }] },
  { id: "synth", title: "Synthesis strategies", sub: "Yosys/ABC recipes, area- or delay-first.",
    axes: [{ var: "SYNTH_STRATEGY", values: "AREA 0, DELAY 0, DELAY 2" }] },
  { id: "own", title: "Your own", sub: "Any setting LibreLane has.", axes: [{ var: "", values: "" }] },
];
// What the sheet asks the server for when it opens, so the goals can start
// from this design's values.
const CONTEXT_KEYS = ["CLOCK_PERIOD", "FP_CORE_UTIL", "FP_SIZING", "DIE_AREA", "CORE_AREA", "PL_TARGET_DENSITY_PCT", "SYNTH_STRATEGY"];

const S = { el: null, goal: "area", axes: [], mode: "grid", stop: false, vars: null, busy: false,
  plan: null, planSeq: 0, planTimer: 0, ctx: {}, touched: false, note: "" };

// ------------------------------------------------------------------ values
// "35, 50, 65" or "35:65:15" (start:stop:step, inclusive) -> { values, error }.
// Text that starts like a range but is not one ("35:65:x") is an error, never
// one text value; `kind` (introspect's: int, number, bool, choice, numbers,
// text...) checks each value the way LibreLane will read it.
export function parseValuesStrict(text, kind = "", choices = []) {
  const t = String(text || "").trim();
  if (!t) return { values: [], error: "" };
  let values;
  if (!/::/.test(t) && /^-?[\d.]+\s*:/.test(t)) {
    const m = /^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return { values: [], error: "'" + t + "' isn't a range. Write start:stop:step with numbers, like 35:65:10." };
    const [a, b, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!(s > 0)) return { values: [], error: "A range's step must be above 0." };
    if (Math.abs(b - a) / s > 999) return { values: [], error: "That range has more than a thousand values." };
    const dec = Math.max(...[m[1], m[2], m[3]].map((x) => (x.split(".")[1] || "").length));
    values = [];
    for (let v = a, i = 0; (a <= b ? v <= b + 1e-9 : v >= b - 1e-9) && i < 1000; v = a + (++i) * (a <= b ? s : -s)) values.push(String(Number(v.toFixed(dec))));
  } else {
    values = t.split(",").map((x) => x.trim()).filter(Boolean);
  }
  for (const v of values) {
    const why = valueError(v, kind, choices);
    if (why) return { values, error: why };
  }
  return { values, error: "" };
}
export function parseValues(text) { return parseValuesStrict(text).values; }

function valueError(v, kind, choices) {
  const isnum = (x) => x !== "" && Number.isFinite(Number(x));
  if (kind === "int" && !/^[+-]?\d+$/.test(v)) return "'" + v + "' isn't a whole number.";
  if (kind === "number" && !isnum(v)) return "'" + v + "' isn't a number.";
  if (kind === "bool" && !/^(true|false|1|0)$/i.test(v)) return "'" + v + "': this setting takes true or false.";
  if (kind === "choice" && choices && choices.length && !choices.includes(v)) return "'" + v + "' isn't one of " + choices.slice(0, 6).join(", ") + (choices.length > 6 ? ", …" : "") + ".";
  if (kind === "numbers" && !v.split(/[;\s]+/).filter(Boolean).every(isnum)) return "'" + v + "' should be numbers separated by spaces, like 0 0 200 200.";
  return "";
}

// How many runs the axes make: grid = product, paired = the common length.
export function countRuns(axes, mode) {
  const lens = axes.map((a) => parseValues(a.values).length);
  if (!lens.length || lens.some((n) => !n)) return 0;
  if (mode === "list") return lens.every((n) => n === lens[0]) ? lens[0] : -1;
  return lens.reduce((x, y) => x * y, 1);
}

// Clock periods from the one the design uses now, downward. With the slack a
// past run had at a known period, the steps reach about where it should stop
// meeting timing (period - slack); a design failing timing now gets periods
// above the current one instead. Round numbers, the current one first.
export function clockValues(cur, hint = null) {
  cur = Number(cur);
  if (!(cur > 0)) return [];
  const step = cur >= 20 ? 1 : cur >= 4 ? 0.5 : 0.1;
  const round = (x) => Number((Math.round(x / step) * step).toFixed(2));
  let pts = [1, 0.9, 0.8, 0.7].map((f) => cur * f);
  if (hint && Number.isFinite(hint.limit) && hint.limit > 0) {
    if (hint.limit < cur) {
      const lo = Math.max(cur * 0.3, Math.min(cur * 0.9, hint.limit));
      pts = [0, 1, 2, 3].map((i) => cur - (cur - lo) * i / 3);
    } else {
      const hi = Math.max(hint.limit, cur * 1.1) * 1.1;
      pts = [0, 1, 2, 3].map((i) => cur + (hi - cur) * i / 3);
    }
  }
  const out = [];
  for (const p of pts) { const r = p === cur ? cur : round(p); if (r > 0 && !out.includes(r)) out.push(r); }
  return out;
}

// A die area ("0 0 300 300" or [0, 0, 300, 300]) shrunk by each factor (per
// side), from its lower-left corner.
export function dieValues(die, factors = [1, 0.9, 0.8]) {
  const n = (Array.isArray(die) ? die : String(die || "").split(/[,;\s]+/)).filter((x) => x !== "").map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite) || n[2] <= n[0] || n[3] <= n[1]) return [];
  const [x0, y0, x1, y1] = n;
  const r = (v) => (Math.abs(v) >= 50 ? Math.round(v) : Number(v.toFixed(1)));
  return factors.map((f) => [x0, y0, r(x0 + (x1 - x0) * f), r(y0 + (y1 - y0) * f)].join(" "));
}

// Typical full-run time of this design: the median of its passed runs.
function typicalRunSecs() {
  const t = (state.runs || []).filter((r) => r.success && r.wall_time_s).map((r) => r.wall_time_s).sort((a, b) => a - b);
  return t.length ? t[Math.floor(t.length / 2)] : null;
}

const varMeta = (name) => (S.vars || []).find((v) => v.name === name) || null;
const ctxOf = (name) => (S.plan && S.plan.context && S.plan.context[name]) || S.ctx[name] || null;
const kindOf = (name) => (ctxOf(name) && ctxOf(name).kind) || (varMeta(name) && varMeta(name).kind) || "";
const choicesOf = (name) => (ctxOf(name) && ctxOf(name).choices) || (varMeta(name) && varMeta(name).choices) || [];
const blank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());
const asText = (v) => (Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v));

// ------------------------------------------------------------------ sheet
// `goal` (a GOALS id such as "clock") opens the sheet on that preset;
// `values` fills its first setting's values (e.g. "12.5, 10, 8").
export async function openSweepSheet(goal, { values } = {}) {
  if (!state.designDir) { toast.show("Open a project first: a sweep runs the open design.", "info"); return; }
  if (!S.el) build();
  S.ctx = {};
  S.plan = null;
  S.touched = !!values;
  pickGoal(GOALS.some((g) => g.id === goal) ? goal : S.goal);
  if (values && S.axes[0]) { S.axes[0].values = values; paintAxes(); }
  S.el.hidden = false;
  // A dialog on the overlay stack: Tab stays in the sheet, Esc closes it (and
  // only it), closing puts focus back.
  openLayer(S.el, { kind: "dialog", labelledBy: "sw-title", onClose: hideSheet, focus: () => S.el.querySelector(".sw-goal.is-on") });
  requestAnimationFrame(() => S.el.classList.add("is-open"));
  S.el.querySelector(".sw-goal.is-on")?.focus();
  const varsP = S.vars ? Promise.resolve() : api.variables().then((v) => { S.vars = (v && (v.data || v)) || []; }).catch(() => { S.vars = state.variables || []; })
    .then(() => {
      const dl = S.el.querySelector("#sw-vars");
      dl.innerHTML = (S.vars || []).map((v) => "<option value='" + esc(v.name) + "'>" + esc((v.description || "").slice(0, 80)) + "</option>").join("");
    });
  // This design's own values, so the goals start from them.
  const ctxP = api.dsePlan({ axes: [], keys: CONTEXT_KEYS, base_overrides: baseOverrides() })
    .then((p) => { S.ctx = (p && p.context) || {}; }).catch(() => { S.ctx = {}; });
  await Promise.all([varsP, ctxP]);
  if (S.el.hidden) return;
  if (!S.touched) pickGoal(S.goal);
  else requestPlan();
}

export function closeSweepSheet() {
  if (!S.el) return;
  closeLayer(S.el);
  hideSheet();
}

function hideSheet() {
  if (!S.el) return;
  S.el.classList.remove("is-open");
  setTimeout(() => { if (S.el && !S.el.classList.contains("is-open")) S.el.hidden = true; }, 180);
}

function baseOverrides() {
  // Setup's one-off settings (the per-run layer) and the picked PDK: what
  // every point of the sweep carries.
  const o = {};
  for (const [k, v] of Object.entries(state.varsValues || {})) if (!blank(v)) o[k] = v;
  if (state.selectedPdk) o.PDK = state.selectedPdk;
  if (state.selectedScl) o.STD_CELL_LIBRARY = state.selectedScl;
  return o;
}

function build() {
  const el = document.createElement("div");
  el.className = "sw-back";
  el.hidden = true;
  el.innerHTML =
    "<aside class='sw-sheet' role='dialog' aria-modal='true' aria-labelledby='sw-title'>" +
    "<header class='sw-head'><div><div class='an-eyebrow'>New sweep</div><h2 class='an-title' id='sw-title'>Run this design at several settings</h2>" +
    "<p class='an-lede'>One full run per point, one after another. Fix the RTL and the constraints first: a sweep finds a better setting, it doesn't fix a design. Keep it small.</p></div>" +
    "<button class='iconbtn sw-x' data-sw='close' aria-label='Close'>" + icon("x", { size: 16 }) + "</button></header>" +
    "<div class='sw-body'>" +
    "<div class='sw-lbl'>What are you after?</div><div class='sw-goals' role='radiogroup'>" +
    GOALS.map((g) => "<button class='sw-goal' role='radio' data-goal='" + g.id + "'><b>" + esc(g.title) + "</b><span>" + esc(g.sub) + "</span></button>").join("") + "</div>" +
    "<div class='sw-lbl'>Settings and values <span class='muted'>A list like 35, 50, 65, or start:stop:step like 35:65:15.</span></div>" +
    "<div id='sw-axes'></div><datalist id='sw-vars'></datalist>" +
    "<button class='btn btn-ghost btn-sm' data-sw='add'>" + icon("plus", { size: 12 }) + " Another setting</button>" +
    "<p class='sw-note' id='sw-note' hidden></p>" +
    "<div class='sw-mode' id='sw-mode' hidden><span class='sw-lbl'>Combine</span>" +
    "<label><input type='radio' name='sw-mode' value='grid' checked/> Every combination</label>" +
    "<label><input type='radio' name='sw-mode' value='list'/> Paired, value by value</label></div>" +
    "<label class='sw-stop' id='sw-stop-row'><input type='checkbox' id='sw-stop'/> Stop at the first run that is clean (timing met and every check passed)</label>" +
    "<div class='sw-riders' id='sw-riders' aria-live='polite'></div>" +
    "</div>" +
    "<footer class='sw-foot'><div class='sw-est' id='sw-est' aria-live='polite'></div><span class='sw-spacer'></span>" +
    "<button class='btn btn-ghost' data-sw='close'>Cancel</button><button class='btn btn-primary' id='sw-start'>" + icon("play", { size: 13 }) + " Start sweep</button></footer>" +
    "</aside>";
  document.body.appendChild(el);
  S.el = el;
  el.addEventListener("click", (e) => {
    if (e.target === el) return closeSweepSheet();
    const b = e.target.closest("[data-sw], [data-goal], [data-rm]");
    if (!b) return;
    if (b.dataset.sw === "close") closeSweepSheet();
    else if (b.dataset.sw === "add") { if (S.axes.length < 3) { S.axes.push({ var: "", values: "" }); S.touched = true; paintAxes(); } }
    else if (b.dataset.goal) { S.touched = false; pickGoal(b.dataset.goal); }
    else if (b.dataset.rm != null) { S.axes.splice(+b.dataset.rm, 1); if (!S.axes.length) S.axes.push({ var: "", values: "" }); S.touched = true; paintAxes(); }
  });
  el.querySelectorAll("input[name='sw-mode']").forEach((r) => r.addEventListener("change", () => { S.mode = r.value; paintEst(); requestPlan(); }));
  el.querySelector("#sw-stop").addEventListener("change", (e) => { S.stop = e.target.checked; });
  el.querySelector("#sw-start").addEventListener("click", start);
}

function pickGoal(id) {
  S.goal = id;
  const g = GOALS.find((x) => x.id === id) || GOALS[0];
  S.axes = g.axes.map((a) => ({ ...a }));
  S.note = "";
  fillGoal(id);
  // "Fastest clock" runs every period: the headline is the fastest that met
  // timing, which a stop at the first clean run could never find.
  S.stop = false;
  S.el.querySelector("#sw-stop").checked = false;
  S.el.querySelector("#sw-stop-row").hidden = id === "clock";
  S.el.querySelectorAll(".sw-goal").forEach((b) => { const on = b.dataset.goal === id; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", on); });
  paintAxes();
}

// The goal's values, from this design's own settings (S.ctx, the server's
// reading of its config: a pdk:: section, a one-off setting, the default).
function fillGoal(id) {
  const c = (k) => S.ctx[k] || null;
  const src = (e) => !e ? "" : e.source === "override" ? "a one-off setting on Setup" : e.source === "config" ? (e.config_source || "the config")
    : e.source === "pdk" ? "the PDK" : "LibreLane's default";
  if (id === "clock") {
    const e = c("CLOCK_PERIOD");
    const cur = e && Number(asText(e.value));
    if (!(cur > 0)) { S.note = e ? "This design sets no clock period LanEx can read. Type the periods to try, in ns." : ""; return; }
    const hint = clockHint(cur);
    S.axes[0].values = clockValues(cur, hint).join(", ");
    S.note = "The clock now: " + cur + " ns (" + mhz(cur) + "), from " + src(e) + "." +
      (hint ? " " + hint.text : "") + " Every period runs; the summary names the fastest that met timing.";
    return;
  }
  if (id === "area") {
    const sz = c("FP_SIZING"), die = c("DIE_AREA"), core = c("CORE_AREA");
    if (sz && String(asText(sz.value)).toLowerCase() === "absolute") {
      const vals = !blank(asText(core && core.value)) ? [] : dieValues(die && die.value);
      if (vals.length) {
        S.axes = [{ var: "DIE_AREA", values: vals.join(", ") }];
        S.note = "This design has a fixed die (FP_SIZING absolute, DIE_AREA " + asText(die.value) + " in " + src(die) +
          "), so FP_CORE_UTIL would change nothing: the sweep shrinks the die itself, to 100 %, 90 % and 80 % of each side.";
      }
      return;
    }
    const u = c("FP_CORE_UTIL");
    const cur = u && Number(asText(u.value));
    if (cur > 0 && cur < 90) {
      const vals = [cur, cur + 10, cur + 20].filter((x) => x <= 95).map((x) => +x.toFixed(1));
      S.axes[0].values = vals.join(", ");
      S.note = "The core is " + cur + " % full now (" + src(u) + "). Each point packs it fuller; the die shrinks with it.";
    }
  }
}

// What a past run says about the clock: its slack at a period LanEx knows
// (a sweep point's own value, else the period the design uses now).
function clockHint(cur) {
  const runs = (state.runs || []).filter((r) => /passed|warning/.test((r.verdict && r.verdict.state) || (r.success ? "passed" : "")));
  for (const r of runs.slice().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))) {
    const ws = r.key_metrics && r.key_metrics.timing__setup__ws;
    if (typeof ws !== "number" || !Number.isFinite(ws)) continue;
    const o = r.origin || {};
    const p = Number(o.kind === "sweep" && o.values && o.values.CLOCK_PERIOD != null ? o.values.CLOCK_PERIOD : cur);
    if (!(p > 0)) continue;
    const limit = p - ws;
    return { limit, text: "The last finished run, " + r.tag + ", had " + F.showText("timing__setup__ws", ws) + " of setup slack at " + p + " ns, so the limit looks near " + +limit.toFixed(2) + " ns." };
  }
  return null;
}
const mhz = (ns) => (ns > 0 ? localeNum(Number((1000 / ns).toPrecision(4)), "en-US", { maximumFractionDigits: 2 }) + " MHz" : "");

function paintAxes() {
  const host = S.el.querySelector("#sw-axes");
  host.innerHTML = S.axes.map((a, i) =>
    "<div class='sw-axis'><input class='sw-var' list='sw-vars' data-i='" + i + "' placeholder='Setting, e.g. FP_CORE_UTIL' value='" + esc(a.var) + "' aria-label='Setting " + (i + 1) + "' spellcheck='false'/>" +
    "<input class='sw-vals' data-i='" + i + "' placeholder='" + (a.var === "CLOCK_PERIOD" ? "e.g. 10, 9, 8" : "e.g. 35, 50, 65") + "' value='" + esc(a.values) + "' aria-label='Values for setting " + (i + 1) + "' aria-describedby='sw-info-" + i + "' spellcheck='false'/>" +
    "<span class='sw-n' data-n='" + i + "'></span>" +
    (S.axes.length > 1 ? "<button class='iconbtn iconbtn-sm' data-rm='" + i + "' aria-label='Remove this setting'>" + icon("x", { size: 13 }) + "</button>" : "") +
    "<div class='sw-info' id='sw-info-" + i + "' data-info='" + i + "'></div></div>").join("");
  host.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
    const a = S.axes[+inp.dataset.i];
    if (inp.classList.contains("sw-var")) a.var = inp.value.trim().toUpperCase(); else a.values = inp.value;
    S.touched = true;
    paintEst();
    requestPlan();
  }));
  S.el.querySelector("#sw-mode").hidden = S.axes.length < 2;
  S.el.querySelector("[data-sw='add']").hidden = S.axes.length >= 3;
  const note = S.el.querySelector("#sw-note");
  note.hidden = !S.note;
  note.textContent = S.note;
  paintEst();
  requestPlan();
}

// The setting's description, its default and its value in this design.
function infoHtml(name) {
  if (!name) return "";
  const e = ctxOf(name), m = varMeta(name);
  if (!e && !m) return "";
  const desc = String((e && e.description) || (m && m.description) || "").replace(/\s+/g, " ").trim();
  const first = desc.split(/(?<=\.)\s/)[0];
  const unit = (e && e.units) || (m && m.units) || "";
  const u = (v) => esc(asText(v)) + (unit ? " " + esc(unit) : "");
  const kind = kindOf(name), ch = choicesOf(name);
  const takes = kind === "int" ? "a whole number" : kind === "number" ? "a number" : kind === "bool" ? "true or false"
    : kind === "choice" && ch.length ? "one of " + ch.slice(0, 6).join(", ") + (ch.length > 6 ? ", …" : "") : kind === "numbers" ? "numbers like 0 0 200 200" : "";
  const def = e ? e.default : m && m.default;
  let now = "";
  if (e) {
    now = e.source === "override" ? u(e.value) + " <span class='muted'>(a one-off setting on Setup" + (e.config_source ? "; " + esc(e.config_source) + " says " + u(e.config) : "") + ")</span>"
      : e.source === "config" ? u(e.value) + " <span class='muted'>(" + esc(e.config_source || "the config") + ")</span>"
      : e.source === "pdk" ? "<span class='muted'>set by the PDK</span>"
      : (blank(asText(e.value)) ? "<span class='muted'>not set</span>" : u(e.value) + " <span class='muted'>(LibreLane's default)</span>");
  }
  return (first ? "<span class='sw-desc'>" + esc(first.length > 160 ? first.slice(0, 157) + "…" : first) + "</span>" : "") +
    "<span class='sw-facts'>" + (takes ? "<span>Takes " + esc(takes) + "</span>" : "") +
    (def != null && def !== "" ? "<span>Default " + u(def) + "</span>" : "") +
    (now ? "<span>In this design " + now + "</span>" : "") + "</span>";
}

function clientProblem() {
  const names = new Set((S.vars || []).map((v) => v.name));
  for (const a of S.axes) {
    if (!a.var) return "Pick a setting.";
    if (names.size && !names.has(a.var)) return a.var + " isn't a LibreLane setting.";
    const p = parseValuesStrict(a.values, kindOf(a.var), choicesOf(a.var));
    if (p.error) return a.var + ": " + p.error;
    if (!p.values.length) return "Give " + a.var + " some values.";
  }
  if (new Set(S.axes.map((a) => a.var)).size < S.axes.length) return "Each setting once.";
  const n = countRuns(S.axes, S.mode);
  if (n < 0) return "Paired settings need the same number of values.";
  if (n > MAX_RUNS) return n + " runs is too many (at most " + MAX_RUNS + "). Narrow it down.";
  return "";
}

function serverProblem() {
  const p = S.plan;
  if (!p || p._for !== planKey()) return "";
  if (p.value_problems && p.value_problems.length) return p.value_problems[0].message;
  return (p.problems || [])[0] || "";
}

function problems() { return clientProblem() || serverProblem(); }

function planKey() { return JSON.stringify([S.axes, S.mode]); }

// Ask the server what this sweep would do (debounced): value checks the
// browser cannot make, the fixed-die guard, the riders and each setting's
// value in this design.
function requestPlan() {
  clearTimeout(S.planTimer);
  S.planTimer = setTimeout(async () => {
    const key = planKey();
    const my = ++S.planSeq;
    const axes = S.axes.filter((a) => a.var).map((a) => ({ var: a.var, values: parseValuesStrict(a.values, kindOf(a.var), choicesOf(a.var)).values }));
    let p = null;
    try { p = await api.dsePlan({ axes, mode: S.axes.length > 1 ? S.mode : "grid", base_overrides: baseOverrides(), keys: CONTEXT_KEYS }); } catch (_e) { p = null; }
    if (my !== S.planSeq || !S.el || S.el.hidden) return;
    if (p) { p._for = key; S.plan = p; }
    paintEst();
  }, 220);
}

function paintEst() {
  S.axes.forEach((a, i) => {
    const el = S.el.querySelector("[data-n='" + i + "']");
    if (el) {
      const p = parseValuesStrict(a.values, kindOf(a.var), choicesOf(a.var));
      el.classList.toggle("is-bad", !!p.error);
      el.textContent = p.error ? "check" : p.values.length ? p.values.length + " value" + (p.values.length === 1 ? "" : "s") : "";
    }
    const info = S.el.querySelector("[data-info='" + i + "']");
    if (info) info.innerHTML = infoHtml(a.var);
  });
  const n = countRuns(S.axes, S.mode);
  const err = problems();
  const secs = typicalRunSecs();
  const est = S.el.querySelector("#sw-est");
  const warns = (S.plan && S.plan._for === planKey() && S.plan.warnings) || [];
  if (err) est.innerHTML = "<span class='sw-err'>" + esc(err) + "</span>";
  else est.innerHTML = "<b>" + n + " run" + (n === 1 ? "" : "s") + (secs ? ", about " + esc(fmtDur(n * secs)) : "") + "</b>" +
    (secs ? " <span class='muted'>from this design's past runs</span>" : "") +
    (n > 8 ? "<div class='sw-warn'>That's a lot of runs. Two or three values usually show the trend.</div>" : "") +
    warns.map((w) => "<div class='sw-warn'>" + esc(w) + "</div>").join("");
  paintRiders();
  const b = S.el.querySelector("#sw-start");
  const running = state.status && state.status.running;
  b.disabled = !!err || S.busy || running;
  b.title = running ? "A run is going: start the sweep when it ends." : "";
}

// Setup's one-off settings go with every point: the sheet says so, by name.
function paintRiders() {
  const host = S.el.querySelector("#sw-riders");
  const riders = Object.entries((S.plan && S.plan.riders) || {});
  const cfg = (S.plan && S.plan.config) || "the config";
  host.innerHTML = riders.length
    ? "<div class='sw-lbl'>Also on every point</div><p>These one-off settings from Setup ride along on every run of the sweep, on top of " + esc(cfg) + ":</p>" +
      "<ul>" + riders.map(([k, v]) => "<li><code>" + esc(k) + " = " + esc(asText(v)) + "</code></li>").join("") + "</ul>" +
      "<p class='muted'>Clear them on Setup to sweep from the config alone.</p>"
    : "<p class='muted'>Each point is " + esc(cfg) + " with the values above, nothing else.</p>";
}

async function start() {
  if (problems() || S.busy) return;
  // The server still has the previous project active: a sweep now would run there.
  if (state.designMissing) {
    toast.show("Project folder not found: " + state.designMissing + ". Locate it or remove it from the list on Setup.", "warn");
    return;
  }
  const n = countRuns(S.axes, S.mode);
  if (!(await roomForRuns(n))) return;
  S.busy = true;
  paintEst();
  try {
    const { collectRunPayload } = await import("./setup.js");
    const base = collectRunPayload();
    const axes = S.axes.map((a) => ({ var: a.var, values: parseValuesStrict(a.values, kindOf(a.var), choicesOf(a.var)).values }));
    const r = await api.dseStart({
      axes, mode: S.axes.length > 1 ? S.mode : "grid", run_mode: state.runMode, flow_name: base.flow || null,
      base_overrides: base.overrides, sources: base.sources, extras: base.extras,
      stop_when_good: S.goal !== "clock" && S.stop, goal: S.goal,
    });
    const d = r && (r.data || r);
    toast.show("Sweep started: " + d.count + " run" + (d.count === 1 ? "" : "s") + ", " + (d.run_tags || []).join(", ") + ".", "success", 8000);
    closeSweepSheet();
    document.dispatchEvent(new CustomEvent("g:sweep", { detail: { started: d } }));
  } catch (ex) {
    toast.show("The sweep didn't start: " + (ex.message || ex), "error", 0);
  } finally {
    S.busy = false;
    if (S.el) paintEst();
  }
}

// Each point is a full flow: warn when the machine is short on memory.
async function roomForRuns(n) {
  let res = null;
  try { res = await api.systemResources(); res = res && (res.data || res); } catch (_e) { res = null; }
  if (res && res.ok && res.risk === "high") {
    return confirmDialog({ title: "Start " + n + " runs on a tight machine?", confirmText: "Start anyway",
      body: "This PC has " + (res.reasons || []).join("; ") + ". A run that runs out of memory can freeze Windows. Close other programs first." });
  }
  return true;
}

// ------------------------------------------------------------------ summary
// The numbers a sweep is read by: key, label, the metric (for the shared
// formatter), better direction.
const METRICS = [
  { id: "wns", key: "timing__setup__ws", label: "Setup WNS", short: "WNS", dir: 1 },
  { id: "tns", key: "timing__setup__tns", label: "Setup TNS", short: "TNS", dir: 1 },
  { id: "hold", key: "timing__hold__ws", label: "Hold WNS", short: "Hold", dir: 1 },
  { id: "die", key: "design__die__area", label: "Die area", short: "Die", dir: -1 },
  { id: "cells", key: "design__instance__area__stdcell", label: "Std-cell area", short: "Cells", dir: -1 },
  { id: "util", key: "design__instance__utilization", label: "Utilisation", short: "Util", dir: 0 },
  { id: "power", key: "power__total", label: "Power", short: "Power", dir: -1 },
  { id: "runtime", key: "", label: "Runtime", short: "Time", dir: -1 },
];
const M_BY = Object.fromEntries(METRICS.map((m) => [m.id, m]));
// The settings that size the die: a sweep of one of them is judged by the die.
const DIE_SIZERS = ["FP_CORE_UTIL", "DIE_AREA", "CORE_AREA", "FP_SIZING", "FP_ASPECT_RATIO"];
const _chartPick = new Map();     // sweep id -> the second chart's metric

function num(r, k) { const v = (r.key_metrics || {})[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; }
function metricOf(p, id) { return id === "runtime" ? (typeof p.r.wall_time_s === "number" ? p.r.wall_time_s : null) : num(p.r, M_BY[id].key); }
function cellText(id, v, scale, unit = true) {
  if (v == null) return "";
  if (id === "runtime") return fmtDur(v);
  const s = id === "power" ? F.showAt("power__total", v, scale) : F.show(M_BY[id].key, v, { compact: true });
  return s.text + (unit && s.unit ? " " + s.unit : "");
}

// The points of a sweep in the order they were planned: one entry per run,
// plus each planned point that has no run (stopped, or LanEx closed first).
export function sweepPoints(sw, runs, verdictOf) {
  const tags = sw.tags || [];
  const reruns = sw.reruns || {};
  const byTag = new Map(runs.map((r) => [r.tag, r]));
  const idx = (t) => { const i = tags.indexOf(t); return i < 0 ? 1e9 : i; };
  const pts = runs.slice().sort((a, b) => idx(a.tag) - idx(b.tag) || String(a.started_at).localeCompare(String(b.started_at)))
    .map((r) => {
      const st = verdictOf(r).state;
      return { r, tag: r.tag, v: valuesOf(r, sw), state: st, ok: st === "passed", failed: st === "failed",
        finished: /passed|warning/.test(st), superseded: reruns[r.tag] && byTag.has(reruns[r.tag]) ? reruns[r.tag] : "" };
    });
  tags.forEach((t, i) => {
    if (byTag.has(t)) return;
    if (reruns[t] && byTag.has(reruns[t])) return;
    pts.push({ r: null, tag: t, v: (sw.points || [])[i] || null, state: "notrun", ok: false, failed: false, finished: false, missing: true });
  });
  return pts;
}

// "Fastest that met timing": a finished run with no negative setup or hold slack.
const metTiming = (p) => p.r && p.finished && num(p.r, "timing__setup__ws") != null && num(p.r, "timing__setup__ws") >= 0 &&
  !(num(p.r, "timing__hold__ws") != null && num(p.r, "timing__hold__ws") < 0);

// Why a sweep has fewer runs than it planned, in plain words ("" when it
// ran them all or is still running).
export function endReason(sw, pts) {
  if (sw.active) return "";
  const live = pts.filter((p) => !p.missing && !p.superseded);
  const ran = live.length;
  const left = pts.filter((p) => p.missing).length;
  const e = sw.ended || {};
  if (!left) {
    // Every point has a run, but LanEx stopped while one of them ran.
    const cut = live.filter((p) => p.state === "incomplete").length;
    return e.reason === "interrupted" && cut
      ? "LanEx was closed or restarted while it ran: " + cut + " point" + (cut === 1 ? "" : "s") + " ended before the last step." : "";
  }
  const of = ran + " of " + (ran + left) + " points ran";
  if (e.reason === "stopped") return "You stopped it: " + of + ".";
  if (e.reason === "first-clean") return "It stopped at the first clean run, as asked: " + of + ".";
  if (e.reason === "done") return of + ": the others' runs were deleted.";
  if (e.reason === "failed-fast") return "It stopped after two points failed the same way before any step ran (" + (e.detail || "the run would not start") + "): the rest would have too. " + of + ".";
  if (e.reason === "interrupted" && !e.assumed) return "LanEx was closed or restarted while it ran: " + of + ".";
  if (pts.some((p) => p.state === "stopped")) return "It was stopped: " + of + ".";
  // Recorded before LanEx noted why a sweep ended: "stop at the first clean run".
  if (sw.stop_when_good && pts.some((p) => p.ok)) return "It stopped at the first clean run, as asked: " + of + ".";
  return "LanEx was closed or restarted while it ran: " + of + ".";
}

// A sweep's summary, under its row: the headline (the fastest clock that met
// timing, or the best for timing and for area, each with "Use this
// configuration"), what failed and why, why it ended short, the results by
// value, the trend charts and its actions.
export function paintSweepSummary(el, sw, runs, { verdictOf, failCode, openRun, selectRuns } = {}) {
  const pts = sweepPoints(sw, runs, verdictOf);
  const live = pts.filter((p) => p.r && !p.superseded);
  const passed = live.filter((p) => p.ok);
  const axes = sw.axes || [];
  const one = axes.length === 1 ? axes[0].var : "";
  const scale = F.scaleOf("power__total", live.map((p) => metricOf(p, "power")));
  // The area that moves for the swept setting: the die for a die-sizing
  // sweep, else whichever of die and std-cell area moved more.
  const areaId = areaMetric(axes, passed);
  const tile = (label, p, text, extra = "") => !p ? "" :
    "<div class='sw-best'><div class='sw-best-k'>" + esc(label) + "</div><div class='sw-best-v'>" + text + "</div>" +
    "<div class='sw-best-m'><code>" + esc(p.tag) + "</code>" + extra + "</div>" +
    (p.v ? "<button class='btn btn-sm' data-use='" + esc(p.tag) + "' title='Review what it would change in the config first'>Use this configuration</button>" : "") + "</div>";
  let head = "";
  if (one === "CLOCK_PERIOD") {
    const met = live.filter(metTiming).filter((p) => p.v && Number(p.v.CLOCK_PERIOD) > 0).sort((a, b) => Number(a.v.CLOCK_PERIOD) - Number(b.v.CLOCK_PERIOD))[0];
    if (met) {
      const ns = Number(met.v.CLOCK_PERIOD);
      head = tile("Fastest that met timing", met, "<b>" + esc(ns) + " ns</b> <span class='muted'>(" + esc(mhz(ns)) + ")</span>",
        " · " + esc(F.showText("timing__setup__ws", num(met.r, "timing__setup__ws"))) + " slack");
    } else if (live.some((p) => p.finished)) {
      const slow = live.filter((p) => p.finished && p.v).sort((a, b) => Number(b.v.CLOCK_PERIOD) - Number(a.v.CLOCK_PERIOD))[0];
      head = "<div class='sw-best is-fail'><div class='sw-best-k'>None met timing</div><div class='sw-best-m'>" +
        (slow ? "The slowest tried, " + esc(slow.v.CLOCK_PERIOD) + " ns, has " + esc(F.showText("timing__setup__ws", num(slow.r, "timing__setup__ws"))) + " of setup slack. Try longer periods." : "") + "</div></div>";
    }
  } else {
    const bestT = passed.filter((p) => num(p.r, "timing__setup__ws") != null).sort((a, b) => num(b.r, "timing__setup__ws") - num(a.r, "timing__setup__ws"))[0];
    if (bestT) head = tile("Best for timing", bestT, "<b>" + esc(F.showText("timing__setup__ws", num(bestT.r, "timing__setup__ws"))) + "</b> <span class='muted'>setup WNS</span>", valsText(bestT.v));
  }
  // A "best" only when the number moved: every point with the same area has
  // no best for area.
  const areas = passed.map((p) => metricOf(p, areaId)).filter((v) => v != null);
  const moved = areas.length > 1 && Math.max(...areas) - Math.min(...areas) > Math.max(...areas.map(Math.abs)) * 1e-4;
  const bestA = !moved ? null : passed.filter((p) => metricOf(p, areaId) != null).sort((a, b) => metricOf(a, areaId) - metricOf(b, areaId))[0];
  const areaTile = bestA ? tile("Best for area", bestA, "<b>" + esc(cellText(areaId, metricOf(bestA, areaId), scale)) + "</b> <span class='muted'>" + esc(M_BY[areaId].label.toLowerCase()) + "</span>", valsText(bestA.v)) : "";
  const failed = live.filter((p) => p.failed);
  const failTile = failed.length
    ? "<div class='sw-best is-fail'><div class='sw-best-k'>" + failed.length + " failed</div><div class='sw-best-m'>" +
      failed.map((p) => "<code>" + esc(p.tag) + "</code>" + (failCode && failCode(p.r) ? " at " + esc(failCode(p.r)) : "")).join("<br>") + "</div></div>"
    : "";
  const why = endReason(sw, pts);
  const redo = live.filter((p) => !p.ok && !p.finished && p.state !== "running").map((p) => p.tag);
  const left = pts.filter((p) => p.missing).map((p) => p.tag);
  const busy = !!(state.status && state.status.running) || !!sw.active;
  const busyT = busy ? " disabled title='A run or sweep is going'" : "";
  const toCompare = live.map((p) => p.r);
  const plots = plotsHtml(pts.filter((p) => p.r && !p.superseded), sw, scale);
  el.innerHTML = "<div class='sw-sum" + (plots ? "" : " no-plot") + "'><div class='sw-sum-l'>" +
    (why ? "<p class='sw-why'>" + icon("alert", { size: 14 }) + " " + esc(why) + "</p>" : "") +
    "<div class='sw-bests'>" + head + areaTile + failTile + "</div>" +
    (passed.length || one === "CLOCK_PERIOD" ? "" : "<p class='muted sw-none'>No point finished clean. Open a failed one for why, or fix the design before sweeping again.</p>") +
    "<div class='sw-sum-act'>" +
      "<button class='btn btn-ghost btn-sm' data-cmp" + (toCompare.length < 2 ? " disabled title='A sweep with one run has nothing to compare'" : "") + ">" + icon("diff", { size: 13 }) + " Compare " +
        (toCompare.length > 2 ? (toCompare.length > COMPARE_MAX ? COMPARE_MAX + " of " + toCompare.length : "all " + toCompare.length) : "these runs") + "</button>" +
      (selectRuns ? "<button class='btn btn-ghost btn-sm' data-sel-sweep>" + icon("check", { size: 13 }) + " Select its runs</button>" : "") +
      (left.length ? "<button class='btn btn-ghost btn-sm' data-redo='left'" + busyT + ">" + icon("play", { size: 13 }) + " Run the " + left.length + " left</button>" : "") +
      (redo.length ? "<button class='btn btn-ghost btn-sm' data-redo='failed'" + busyT + ">" + icon("play", { size: 13 }) + " " +
        (live.filter((p) => redo.includes(p.tag)).every((p) => p.failed) ? "Rerun " + redo.length + " failed" : "Run " + redo.length + " again") + "</button>" : "") +
      (one ? "<button class='btn btn-ghost btn-sm' data-add" + busyT + ">" + icon("plus", { size: 13 }) + " Add values</button>" : "") +
      "<button class='btn btn-ghost btn-sm' data-csv>" + icon("download", { size: 13 }) + " Export CSV</button>" +
    "</div></div>" + plots + "</div>" +
    resultsHtml(pts, sw, { scale, areaId, failCode });
  const ptOf = (tag) => pts.find((p) => p.tag === tag);
  el.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); useConfig(ptOf(b.dataset.use), sw); }));
  el.querySelector("[data-cmp]").addEventListener("click", async (e) => {
    e.stopPropagation();
    const m = await import("./runs.js");
    m.compareRuns(toCompare);
  });
  el.querySelector("[data-sel-sweep]")?.addEventListener("click", (e) => { e.stopPropagation(); selectRuns(runs); });
  el.querySelector("[data-csv]").addEventListener("click", (e) => { e.stopPropagation(); exportSweepCsv(sw, pts, failCode); });
  el.querySelectorAll("[data-redo]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    continueSweep(sw, { rerun: b.dataset.redo === "left" ? left : redo });
  }));
  el.querySelector("[data-add]")?.addEventListener("click", (e) => { e.stopPropagation(); addValues(sw); });
  el.querySelectorAll("tr[data-open]").forEach((tr) => tr.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = ptOf(tr.dataset.open);
    if (p && p.r && openRun) openRun(p.r);
  }));
  el.querySelectorAll("[data-chart]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    _chartPick.set(sw.id, b.dataset.chart);
    paintSweepSummary(el, sw, runs, { verdictOf, failCode, openRun, selectRuns });
  }));
}

const valsText = (v) => (v ? " · " + esc(Object.entries(v).map(([k, x]) => k + " " + x).join(", ")) : "");

function areaMetric(axes, passed) {
  if (axes.some((a) => DIE_SIZERS.includes(a.var))) return "die";
  const spread = (id) => {
    const xs = passed.map((p) => metricOf(p, id)).filter((v) => v != null);
    if (xs.length < 2) return 0;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return hi > 0 ? (hi - lo) / hi : 0;
  };
  return spread("die") > spread("cells") ? "die" : "cells";
}

// Points sorted by the swept value (numbers as numbers), then by run order.
function byValue(pts, axes) {
  const key = (p) => axes.map((a) => (p.v ? p.v[a.var] : undefined));
  return pts.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const x = ka[i], y = kb[i];
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      const nx = Number(x), ny = Number(y);
      const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y));
      if (c) return c;
    }
    return 0;
  });
}

const STATE_WORD = { passed: "Clean", warning: "Warnings", failed: "Failed", stopped: "Stopped", incomplete: "Incomplete", running: "Running", notrun: "Not run" };
const STATE_TONE = { passed: "pass", warning: "warn", failed: "fail", stopped: "warn", incomplete: "warn", running: "live", notrun: "warn" };

// The table a sweep exists for: the swept value(s) against how each point
// came out and its key numbers, sorted by value.
function resultsHtml(pts, sw, { scale, areaId, failCode }) {
  const axes = sw.axes || [];
  if (!pts.length || !axes.length) return "";
  const cols = ["wns", "hold", areaId === "die" ? "die" : "cells", areaId === "die" ? "cells" : "die", "util", "power", "runtime"];
  const rows = byValue(pts, axes).map((p) => {
    const reason = p.missing ? "" : p.failed ? (failCode && failCode(p.r)) || "" : "";
    const word = STATE_WORD[p.state] || p.state;
    const sup = p.superseded ? "<span class='muted'> · rerun as " + esc(p.superseded) + "</span>" : "";
    return "<tr" + (p.r ? " data-open='" + esc(p.tag) + "' class='sw-res-row" + (p.superseded ? " is-old" : "") + "' title='" + esc("Open " + p.tag) + "'" : " class='is-missing'") + ">" +
      axes.map((a) => "<td class='sw-res-v'>" + esc(p.v ? p.v[a.var] : "") + (a.var === "CLOCK_PERIOD" && p.v && Number(p.v[a.var]) > 0 ? " <small>" + esc(mhz(Number(p.v[a.var]))) + "</small>" : "") + "</td>").join("") +
      "<td><span class='rn-v is-" + (STATE_TONE[p.state] || "warn") + "'><i aria-hidden='true'></i>" + esc(word) + "</span>" +
        (reason ? " <span class='muted'>" + esc(reason) + "</span>" : "") + sup + "</td>" +
      cols.map((id) => {
        const v = p.r ? metricOf(p, id) : null;
        const neg = (id === "wns" || id === "hold") && v != null && v < 0 ? " is-neg" : "";
        return "<td class='sw-num" + neg + "'" + (v != null && id !== "runtime" ? fmt.titleAttr(v) : "") + ">" + esc(cellText(id, v, scale, false)) + "</td>";
      }).join("") +
      "<td class='sw-res-tag'>" + esc(p.tag) + "</td></tr>";
  }).join("");
  const unit = (id) => id === "runtime" ? "" : id === "power" ? (scale ? scale.unit : "") : F.show(M_BY[id].key, 1).unit;
  return "<div class='sw-res-wrap'><table class='sw-res'><caption>Results by " + esc(axes.map((a) => a.var).join(" × ")) + "</caption><thead><tr>" +
    axes.map((a) => "<th scope='col'>" + esc(a.var) + "</th>").join("") + "<th scope='col'>Result</th>" +
    cols.map((id) => "<th scope='col' class='sw-num'>" + esc(M_BY[id].label) + (unit(id) ? " <small>" + esc(unit(id)) + "</small>" : "") + "</th>").join("") +
    "<th scope='col'>Run</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
}

// The sweep's results as a CSV: the swept values, how each point ended and
// every key number, exact (as LibreLane wrote it), in sweep order.
function exportSweepCsv(sw, pts, failCode) {
  const axes = sw.axes || [];
  const head = [...axes.map((a) => a.var), "run", "result", "reason", ...METRICS.map((m) => m.key ? m.key + " (" + (F.unitOf(m.key) === "ratio" ? "fraction" : F.unitOf(m.key)) + ")" : "runtime (s)")];
  const rows = [head, ...byValue(pts, axes).map((p) => [
    ...axes.map((a) => (p.v ? p.v[a.var] : "")), p.tag, STATE_WORD[p.state] || p.state,
    p.r && p.failed ? (failCode && failCode(p.r)) || "" : p.superseded ? "rerun as " + p.superseded : "",
    ...METRICS.map((m) => (p.r ? metricOf(p, m.id) ?? "" : "")),
  ])];
  downloadCsv("sweep-" + (sw.id || "results") + ".csv", toCsv(rows));
}

function valuesOf(r, sw) {
  const o = r.origin || {};
  if (o.kind === "sweep" && o.values && Object.keys(o.values).length) return o.values;
  const i = (sw.tags || []).indexOf(r.tag);
  if (sw.points && sw.points[i]) return sw.points[i];
  if (i >= 0 && (sw.axes || []).length === 1) return { [sw.axes[0].var]: sw.axes[0].values[i] };
  return null;
}

const tick = (v) => (Math.abs(v) >= 100 ? localeNum(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const pad = (lo, hi) => { const d = (hi - lo) || Math.abs(hi) * 0.1 || 1; return [lo - d * 0.14, hi + d * 0.14]; };

// The pictures of a sweep. One number swept: setup slack, and a metric you
// pick, against it (a failed point is a cross on the axis). Otherwise the
// trade-off: area against slack for every point.
function plotsHtml(pts, sw, scale) {
  const axes = sw.axes || [];
  const one = axes.length === 1 ? axes[0].var : "";
  const xs = one ? pts.map((p) => (p.v ? Number(p.v[one]) : NaN)) : [];
  if (one && xs.every(Number.isFinite) && new Set(xs).size > 1) {
    const P = pts.map((p, i) => ({ ...p, x: xs[i] })).sort((a, b) => a.x - b.x);
    const pick = _chartPick.get(sw.id) || (one === "CLOCK_PERIOD" ? "power" : DIE_SIZERS.includes(one) ? "die" : "cells");
    const a = trendSvg(P, one, "wns", scale);
    const b = trendSvg(P, one, pick, scale);
    const seg = "<div class='rn-seg sw-mseg' role='group' aria-label='The second chart shows'>" +
      ["tns", "hold", "die", "cells", "util", "power", "runtime"].map((id) =>
        "<button class='rn-segb" + (id === pick ? " is-on" : "") + "' data-chart='" + id + "' aria-pressed='" + (id === pick) + "' title='" + esc(M_BY[id].label + " against " + one) + "'>" + esc(M_BY[id].short) + "</button>").join("") + "</div>";
    return a || b ? "<div class='sw-plots-wrap'><div class='sw-plots'>" + a + b + "</div>" + seg + "</div>" : "";
  }
  const t = tradeSvg(pts);
  return t ? "<div class='sw-plots-wrap'><div class='sw-plots'>" + t + "</div></div>" : "";
}

// One metric against the swept value: a line through the finished points, the
// best one green, failed ones a red cross on the x axis.
function trendSvg(P, xvar, id, scale) {
  const m = M_BY[id];
  const val = (p) => metricOf(p, id);
  const D = P.filter((p) => val(p) != null);
  if (D.length < 2) return "";
  // The y values in the unit the label states (power at its scale, utilisation in %).
  const k = id === "power" && scale ? 1 / scale.div : id === "util" ? 100 : 1;
  const unit = id === "runtime" ? "s" : id === "power" ? (scale ? scale.unit : "W") : id === "util" ? "%" : F.show(m.key, 1).unit;
  const W = 320, H = 180, L = 52, R = 14, T = 12, B = 34;
  const ys = D.map((p) => val(p) * k);
  const [x0, x1] = pad(Math.min(...P.map((p) => p.x)), Math.max(...P.map((p) => p.x)));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const best = m.dir ? D.filter((p) => p.ok).sort((a, b) => (m.dir > 0 ? val(b) - val(a) : val(a) - val(b)))[0] : null;
  const line = "<polyline class='sw-line' points='" + D.map((p) => X(p.x).toFixed(1) + "," + Y(val(p) * k).toFixed(1)).join(" ") + "'/>";
  const dots = P.map((p) => {
    const cx = X(p.x).toFixed(1);
    if (val(p) == null) {
      const cy = H - B;
      return "<g class='sw-pt is-fail'><title>" + esc(p.tag + ": " + xvar + " " + p.x + (p.failed ? ", failed" : ", no result")) + "</title>" +
        "<path d='M" + (cx - 4) + " " + (cy - 4) + "l8 8M" + (+cx + 4) + " " + (cy - 4) + "l-8 8'/></g>";
    }
    const cy = Y(val(p) * k).toFixed(1);
    return "<g class='sw-pt" + (p === best ? " is-best" : "") + (p.ok ? "" : " is-fail") + "'><title>" + esc(p.tag + ": " + xvar + " " + p.x + ", " + m.label.toLowerCase() + " " + cellText(id, val(p), scale)) + "</title>" +
      "<circle cx='" + cx + "' cy='" + cy + "' r='4.5'/></g>";
  }).join("");
  const xt = P.map((p) => "<text class='sw-tk' x='" + X(p.x).toFixed(1) + "' y='" + (H - B + 14) + "' text-anchor='middle'>" + esc(String(p.x)) + "</text>").join("");
  const zero = (id === "wns" || id === "tns" || id === "hold") && y0 < 0 && y1 > 0 ? "<line class='sw-zero' x1='" + L + "' x2='" + (W - R) + "' y1='" + Y(0).toFixed(1) + "' y2='" + Y(0).toFixed(1) + "'/>" : "";
  return "<figure class='sw-plot'><figcaption><b>" + esc(m.label) + "</b>" + (unit ? " (" + esc(unit) + ")" : "") + " by " + esc(xvar) + "</figcaption>" +
    "<svg viewBox='0 0 " + W + " " + H + "' role='img' aria-label='" + esc(m.label + " for each value of " + xvar) + "'>" +
    "<line class='sw-gridl' x1='" + L + "' x2='" + (W - R) + "' y1='" + T + "' y2='" + T + "'/>" +
    "<line class='sw-ax' x1='" + L + "' x2='" + L + "' y1='" + T + "' y2='" + (H - B) + "'/><line class='sw-ax' x1='" + L + "' x2='" + (W - R) + "' y1='" + (H - B) + "' y2='" + (H - B) + "'/>" + zero +
    "<text class='sw-tk' x='" + (L - 6) + "' y='" + (T + 4) + "' text-anchor='end'>" + tick(y1) + "</text><text class='sw-tk' x='" + (L - 6) + "' y='" + (H - B) + "' text-anchor='end'>" + tick(y0) + "</text>" +
    xt + "<text class='sw-axl' x='" + ((L + W - R) / 2) + "' y='" + (H - 4) + "' text-anchor='middle'>" + esc(xvar) + "</text>" + line + dots + "</svg></figure>";
}

// Std-cell area (x) against setup WNS (y). Axes span the data (not from 0),
// points labelled by their value, a label dropped when it would overlap.
function tradeSvg(pts) {
  const P = pts.map((p) => ({ ...p, wns: num(p.r, "timing__setup__ws"), area: num(p.r, "design__instance__area__stdcell") })).filter((p) => p.wns != null && p.area != null);
  if (P.length < 2) return "";
  const W = 460, H = 200, L = 64, R = 16, T = 14, B = 38;
  const xs = P.map((p) => p.area), ys = P.map((p) => p.wns);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const placed = [];
  const dots = P.map((p) => {
    const cx = X(p.area), cy = Y(p.wns);
    const lab = p.v ? Object.values(p.v).join("/") : p.tag;
    const box = [cx - lab.length * 3.4, cy - 20, cx + lab.length * 3.4, cy - 8];
    const hit = placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]));
    if (!hit) placed.push(box);
    return "<g class='sw-pt" + (p.ok ? "" : " is-fail") + "'><title>" + esc(p.tag + ": std-cell area " + F.showText("design__instance__area__stdcell", p.area) + ", setup WNS " + F.showText("timing__setup__ws", p.wns)) + "</title>" +
      "<circle cx='" + cx.toFixed(1) + "' cy='" + cy.toFixed(1) + "' r='5'/>" +
      (hit ? "" : "<text x='" + cx.toFixed(1) + "' y='" + (cy - 10).toFixed(1) + "' text-anchor='middle'>" + esc(lab) + "</text>") + "</g>";
  }).join("");
  const zero = y0 < 0 && y1 > 0 ? "<line class='sw-zero' x1='" + L + "' x2='" + (W - R) + "' y1='" + Y(0).toFixed(1) + "' y2='" + Y(0).toFixed(1) + "'/>" : "";
  return "<figure class='sw-plot'><figcaption><b>Area against slack</b>, one dot per run</figcaption><svg viewBox='0 0 " + W + " " + H + "' role='img' aria-label='Std-cell area against setup slack for each point'>" +
    "<line class='sw-ax' x1='" + L + "' x2='" + L + "' y1='" + T + "' y2='" + (H - B) + "'/><line class='sw-ax' x1='" + L + "' x2='" + (W - R) + "' y1='" + (H - B) + "' y2='" + (H - B) + "'/>" + zero +
    "<text class='sw-tk' x='" + (L - 6) + "' y='" + (T + 4) + "' text-anchor='end'>" + tick(y1) + "</text><text class='sw-tk' x='" + (L - 6) + "' y='" + (H - B) + "' text-anchor='end'>" + tick(y0) + "</text>" +
    "<text class='sw-tk' x='" + L + "' y='" + (H - B + 14) + "'>" + tick(x0) + "</text><text class='sw-tk' x='" + (W - R) + "' y='" + (H - B + 14) + "' text-anchor='end'>" + tick(x1) + "</text>" +
    "<text class='sw-axl' x='" + ((L + W - R) / 2) + "' y='" + (H - 6) + "' text-anchor='middle'>std-cell area (µm²), smaller is better</text>" +
    "<text class='sw-axl' transform='translate(14 " + ((T + H - B) / 2) + ") rotate(-90)' text-anchor='middle'>setup WNS (ns)</text>" + dots + "</svg></figure>";
}

// ------------------------------------------------------------------ continue a sweep
// Run its failed (or never-run) points again, or more values of its one
// setting: the same sweep, with the settings it started with.
async function continueSweep(sw, { rerun = null, values = null }) {
  const n = rerun ? rerun.length : values.length;
  if (!(await roomForRuns(n))) return;
  try {
    const r = await api.dseStart({ continue: { sweep_id: sw.id, ...(rerun ? { rerun } : { values }) } });
    const d = r && (r.data || r);
    toast.show("Sweep continued: " + d.count + " more run" + (d.count === 1 ? "" : "s") + ", " + (d.run_tags || []).join(", ") + ".", "success", 8000);
    document.dispatchEvent(new CustomEvent("g:sweep", { detail: { started: d } }));
  } catch (ex) {
    toast.show("The sweep didn't continue: " + (ex.message || ex), "error", 0);
  }
}

async function addValues(sw) {
  const ax = (sw.axes || [])[0];
  if (!ax) return;
  const have = new Set((ax.values || []).map(String));
  let input = null, out = null;
  const fresh = () => {
    const p = parseValuesStrict(input.value, kindOf(ax.var), choicesOf(ax.var));
    const nv = p.values.filter((v) => !have.has(v));
    return { p, nv };
  };
  const v = await customDialog({
    title: "Add values to the sweep of " + ax.var,
    bodyHtml: "<label class='dlg-label' for='sw-add-in'>More values of <code>" + esc(ax.var) + "</code>. It has tried " + esc([...have].join(", ")) + ".</label>" +
      "<input class='dlg-input' id='sw-add-in' type='text' spellcheck='false' autocomplete='off' placeholder='e.g. 7, 6.5'/>" +
      "<p class='sw-add-out' id='sw-add-out' aria-live='polite'></p>",
    buttons: [{ label: "Cancel", value: null, cls: "btn-ghost" }, { label: "Run them", value: "go", cls: "btn-primary" }],
    onMount: (back, close) => {
      input = back.querySelector("#sw-add-in");
      out = back.querySelector("#sw-add-out");
      const go = back.querySelector(".dlg-actions .btn-primary");
      const paint = () => {
        const { p, nv } = fresh();
        go.disabled = !!p.error || !nv.length;
        out.innerHTML = p.error ? "<span class='sw-err'>" + esc(p.error) + "</span>" : nv.length
          ? esc(nv.length + " new run" + (nv.length === 1 ? "" : "s") + (typicalRunSecs() ? ", about " + fmtDur(nv.length * typicalRunSecs()) : "")) +
            (p.values.length > nv.length ? " <span class='muted'>(" + esc(p.values.filter((x) => have.has(x)).join(", ")) + " already ran)</span>" : "")
          : p.values.length ? "<span class='muted'>Those values already ran.</span>" : "";
      };
      input.addEventListener("input", paint);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !go.disabled) { e.preventDefault(); close("go"); } });
      paint();
    },
  });
  if (v !== "go" || !input) return;
  const { p, nv } = fresh();
  if (p.error || !nv.length) return;
  continueSweep(sw, { values: nv });
}

// ------------------------------------------------------------------ use a point's settings

// A value as the setting's own type (`kind` as LanEx reads LibreLane's
// variables), for writing into a config file: a sweep's values are text, and
// "6" written as text is a quoted string in YAML or JSON. A value that does
// not read as its kind stays as it is. Pure (tested).
export function typedValue(v, kind) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (kind === "int" || kind === "number") {
    const n = Number(s);
    return s !== "" && Number.isFinite(n) ? n : v;
  }
  if (kind === "bool") {
    if (/^(true|yes|on|1)$/i.test(s)) return true;
    if (/^(false|no|off|0)$/i.test(s)) return false;
    return v;
  }
  if (kind === "numbers") {
    const parts = s.replace(/^[[(]\s*|\s*[\])]$/g, "").split(/[\s,]+/).filter(Boolean);
    const ns = parts.map(Number);
    return parts.length && ns.every(Number.isFinite) ? ns : v;
  }
  return v;
}

// The keys of `set` that the config file, after the write, still sets to
// another value for this PDK (`effective`, as /api/config/set answers it).
// Pure (tested).
export function stillWins(set, effective, same) {
  const out = [];
  for (const k of Object.keys(set || {})) {
    const e = (effective || {})[k];
    if (e && !same(e.value, set[k])) out.push(k);
  }
  return out;
}
// Write what a point ran with into the design's config: the sweep's one-off
// settings plus the point's values, only where they differ from the config,
// shown as a diff first. A setting that a pdk:: section of the config sets for
// this PDK is changed in that section (the top level would not take effect).
// Undo puts the config back.
async function useConfig(p, sw) {
  if (!p || !p.v) return;
  const base = sw.base_overrides || {};
  const ran = {};
  for (const [k, v] of Object.entries(base)) if (k !== "PDK" && k !== "STD_CELL_LIBRARY" && !blank(v)) ran[k] = v;
  Object.assign(ran, p.v);
  // The run's own PDK, never the one picked on Setup now.
  const pdk = base.PDK || (p.r && p.r.pdk) || null, scl = base.STD_CELL_LIBRARY || (p.r && p.r.scl) || null;
  let ctx = {}, cfg = "the config";
  try {
    const plan = await api.dsePlan({ axes: [], keys: Object.keys(ran), base_overrides: { ...(pdk ? { PDK: pdk } : {}), ...(scl ? { STD_CELL_LIBRARY: scl } : {}) } });
    ctx = (plan && plan.context) || {};
    cfg = (plan && plan.config) || cfg;
  } catch (ex) { toast.show("Couldn't read the config: " + (ex.message || ex), "error"); return; }
  const same = (a, b) => { const x = asText(a).trim(), y = asText(b).trim(); return x === y || (x !== "" && y !== "" && Number.isFinite(Number(x)) && Number(x) === Number(y)); };
  const rows = Object.entries(ran).map(([k, raw]) => {
    const e = ctx[k] || {};
    // A point's values are text ("6"): the config gets the setting's own type.
    const to = typedValue(raw, e.kind || kindOf(k));
    const scoped = (e.scoped || []).filter((s) => s.applies).pop() || null;
    const from = e.config_source ? e.config : null;
    return { k, to, from, def: e.default, scoped, rider: !(k in p.v), same: e.config_source ? same(e.config, to) : false };
  });
  const change = rows.filter((r) => !r.same);
  if (!change.length) {
    toast.show("The config already has " + p.tag + "'s settings (" + rows.map((r) => r.k + " = " + asText(r.to)).join(", ") + ").", "info", 9000);
    return;
  }
  const v = await customDialog({
    title: "Use " + p.tag + "'s settings?",
    bodyHtml: "<p>This writes what " + esc(p.tag) + " ran with into the config, so a plain Run builds it again:</p>" +
      "<table class='sw-diff'><thead><tr><th>Setting</th><th>Now</th><th></th><th>After</th></tr></thead><tbody>" +
      change.map((r) => "<tr><td><code>" + esc(r.k) + "</code>" + (r.rider ? " <span class='muted'>one-off setting it ran with</span>" : "") +
        (r.scoped ? " <span class='muted'>in " + esc(r.scoped.scope) + "</span>" : "") + "</td>" +
        "<td class='sw-diff-from'>" + (r.from != null ? esc(asText(r.from)) : "<span class='muted'>unset" + (r.def != null && r.def !== "" ? " (default " + esc(asText(r.def)) + ")" : "") + "</span>") + "</td>" +
        "<td aria-hidden='true'>→</td><td class='sw-diff-to'>" + esc(asText(r.to)) + "</td></tr>").join("") + "</tbody></table>" +
      (rows.length > change.length ? "<p class='muted'>Already in the config: " + esc(rows.filter((r) => r.same).map((r) => r.k + " = " + asText(r.to)).join(", ")) + ".</p>" : "") +
      "<p class='muted'>You can undo it from the message that follows.</p>",
    buttons: [{ label: "Cancel", value: null, cls: "btn-ghost" }, { label: "Save to the config", value: "go", cls: "btn-primary" }],
  });
  if (v !== "go") return;
  // One write per place: the top level, then each pdk::/scl:: section.
  const groups = new Map();
  for (const r of change) {
    const g = r.scoped ? r.scoped.scope : "";
    if (!groups.has(g)) groups.set(g, {});
    groups.get(g)[r.k] = r.to;
  }
  const undos = [], said = [], stuck = [];
  try {
    for (const [scope, set] of groups) {
      const extra = { pdk, scl };
      if (scope) extra.scope = scope.split(" / ");
      const r = await api.configSet(set, [], extra);
      const d = (r && (r.data || r)) || {};
      if (d.undo && d.undo.backup) undos.push(d.undo);
      said.push(Object.entries(set).map(([k, x]) => k + " = " + asText(x)).join(", "));
      // A section that still sets the key for this PDK, to another value,
      // wins over what was written. `effective` is the file after the write
      // (`scoped` is the file before it, so it still has the old value).
      stuck.push(...stillWins(set, d.effective, same));
    }
  } catch (ex) {
    toast.show("Couldn't save: " + (ex.message || ex), "error", 0);
    if (!undos.length) return;
  }
  document.dispatchEvent(new CustomEvent("g:config_changed", { detail: { keys: change.map((r) => r.k), from: "sweep" } }));
  // A one-off setting on Setup for the same key still wins over the config.
  const ov = state.varsValues || {};
  const shadow = change.filter((r) => !blank(ov[r.k]) && !same(ov[r.k], r.to)).map((r) => r.k + " = " + asText(ov[r.k]));
  const msg = "Saved in " + cfg + ": " + said.join("; ") + "." +
    (stuck.length ? " A pdk:: section of the config still sets " + stuck.join(", ") + " for this PDK: change it there." : "") +
    (shadow.length ? " Setup still has the one-off " + shadow.join(", ") + ", which wins over the config: clear it there." : "");
  toast.show(msg, stuck.length || shadow.length ? "warn" : "success", 14000, undos.length ? { label: "Undo", run: async () => {
    try {
      for (const u of undos.slice().reverse()) await api.configUndo({ backup: u.backup, after: u.after });
      toast.show("The config is back as it was.", "success");
      document.dispatchEvent(new CustomEvent("g:config_changed", { detail: { keys: change.map((r) => r.k), from: "sweep-undo" } }));
    } catch (ex) { toast.show("Undo: " + (ex.message || ex), "warn", 9000); }
  } } : null);
}

export const _test = { parseValues, parseValuesStrict, countRuns, clockValues, dieValues, endReason, sweepPoints, typedValue, stillWins, stageLabel: FS.stageLabel };
