// sweeps.js — sweeps inside Runs (what the DSE tab used to be): the "New
// sweep" sheet and the summary card of a finished sweep.
//
// A sweep runs the same design with one or more settings at several values,
// one full run per point, one at a time (controller/dse.py, /api/dse/*). Each
// point is named by what it tried (sweep-util-65) and its real outcome is kept.
// Sweeps are a last resort after the RTL and constraints are right; the sheet
// keeps the default small and says so.

import { api, fmt } from "./api.js";
import { state } from "./state.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { confirmDialog } from "./dialog.js";
import { openLayer, closeLayer } from "./overlay.js";
import { fmtDur } from "./reportcard.js";
import * as FS from "./flowstages.js";
import { localeNum } from "./intlcache.js";

const esc = (s) => fmt.escape(s == null ? "" : String(s));
const MAX_RUNS = 64;               // controller/dse.py MAX_COMBOS

// Goals in plain words -> the settings that move them.
const GOALS = [
  { id: "clock", title: "Fastest clock that meets timing", sub: "Try shorter clock periods (ns).",
    axes: [{ var: "CLOCK_PERIOD", values: "" }], stop: true },
  { id: "area", title: "Smallest die that routes", sub: "Pack the core fuller until routing or placement fails.",
    axes: [{ var: "FP_CORE_UTIL", values: "40:60:10" }] },
  { id: "density", title: "Placement density", sub: "How tightly the placer packs cells (%).",
    axes: [{ var: "PL_TARGET_DENSITY_PCT", values: "50, 60, 70" }] },
  { id: "synth", title: "Synthesis strategies", sub: "Yosys/ABC recipes, area- or delay-first.",
    axes: [{ var: "SYNTH_STRATEGY", values: "AREA 0, DELAY 0, DELAY 2" }] },
  { id: "own", title: "Your own", sub: "Any setting LibreLane has.", axes: [{ var: "", values: "" }] },
];

const S = { el: null, goal: "area", axes: [], mode: "grid", stop: false, vars: null, busy: false };

// "35, 50, 65" or "35:65:15" (start:stop:step, inclusive) -> values.
export function parseValues(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const m = /^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (m) {
    const [a, b, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!(s > 0)) return [];
    const dec = Math.max(...[m[1], m[2], m[3]].map((x) => (x.split(".")[1] || "").length));
    const out = [];
    for (let v = a, i = 0; (a <= b ? v <= b + 1e-9 : v >= b - 1e-9) && i < 1000; v = a + (++i) * (a <= b ? s : -s)) out.push(Number(v.toFixed(dec)));
    return out.map(String);
  }
  return t.split(",").map((x) => x.trim()).filter(Boolean);
}

// How many runs the axes make: grid = product, paired = the common length.
export function countRuns(axes, mode) {
  const lens = axes.map((a) => parseValues(a.values).length);
  if (!lens.length || lens.some((n) => !n)) return 0;
  if (mode === "list") return lens.every((n) => n === lens[0]) ? lens[0] : -1;
  return lens.reduce((x, y) => x * y, 1);
}

// Typical full-run time of this design: the median of its passed runs.
function typicalRunSecs() {
  const t = (state.runs || []).filter((r) => r.success && r.wall_time_s).map((r) => r.wall_time_s).sort((a, b) => a - b);
  return t.length ? t[Math.floor(t.length / 2)] : null;
}

// ------------------------------------------------------------------ sheet
// `goal` (a GOALS id such as "clock") opens the sheet on that preset;
// `values` fills its first setting's values (e.g. "12.5, 10, 8").
export async function openSweepSheet(goal, { values } = {}) {
  if (!state.designDir) { toast.show("Open a project first: a sweep runs the open design.", "info"); return; }
  if (!S.el) build();
  pickGoal(GOALS.some((g) => g.id === goal) ? goal : S.goal);
  if (values && S.axes[0]) { S.axes[0].values = values; paintAxes(); }
  S.el.hidden = false;
  // A dialog on the overlay stack: Tab stays in the sheet, Esc closes it (and
  // only it), closing puts focus back.
  openLayer(S.el, { kind: "dialog", labelledBy: "sw-title", onClose: hideSheet, focus: () => S.el.querySelector(".sw-goal.is-on") });
  requestAnimationFrame(() => S.el.classList.add("is-open"));
  if (!S.vars) {
    try { const v = await api.variables(); S.vars = (v && (v.data || v)) || []; } catch (_e) { S.vars = state.variables || []; }
    const dl = S.el.querySelector("#sw-vars");
    dl.innerHTML = (S.vars || []).map((v) => "<option value='" + esc(v.name) + "'>" + esc((v.description || "").slice(0, 80)) + "</option>").join("");
  }
  S.el.querySelector(".sw-goal.is-on")?.focus();
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
    "<div class='sw-mode' id='sw-mode' hidden><span class='sw-lbl'>Combine</span>" +
    "<label><input type='radio' name='sw-mode' value='grid' checked/> Every combination</label>" +
    "<label><input type='radio' name='sw-mode' value='list'/> Paired, value by value</label></div>" +
    "<label class='sw-stop'><input type='checkbox' id='sw-stop'/> Stop at the first run that is clean (timing met and every check passed)</label>" +
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
    else if (b.dataset.sw === "add") { if (S.axes.length < 3) { S.axes.push({ var: "", values: "" }); paintAxes(); } }
    else if (b.dataset.goal) pickGoal(b.dataset.goal);
    else if (b.dataset.rm != null) { S.axes.splice(+b.dataset.rm, 1); if (!S.axes.length) S.axes.push({ var: "", values: "" }); paintAxes(); }
  });
  el.querySelectorAll("input[name='sw-mode']").forEach((r) => r.addEventListener("change", () => { S.mode = r.value; paintEst(); }));
  el.querySelector("#sw-stop").addEventListener("change", (e) => { S.stop = e.target.checked; });
  el.querySelector("#sw-start").addEventListener("click", start);
}

function pickGoal(id) {
  S.goal = id;
  const g = GOALS.find((x) => x.id === id) || GOALS[0];
  S.axes = g.axes.map((a) => ({ ...a }));
  if (id === "clock") S.axes[0].values = clockGuess();
  S.stop = !!g.stop;
  S.el.querySelector("#sw-stop").checked = S.stop;
  S.el.querySelectorAll(".sw-goal").forEach((b) => { const on = b.dataset.goal === id; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", on); });
  paintAxes();
}

// Clock periods around the one the design uses now (Setup's value), tighter first.
function clockGuess() {
  const cur = Number((state.varsValues || {}).CLOCK_PERIOD);
  if (!(cur > 0)) return "";
  return [1, 0.9, 0.8].map((f) => +(cur * f).toFixed(2)).join(", ");
}

function paintAxes() {
  const host = S.el.querySelector("#sw-axes");
  host.innerHTML = S.axes.map((a, i) =>
    "<div class='sw-axis'><input class='sw-var' list='sw-vars' data-i='" + i + "' placeholder='Setting, e.g. FP_CORE_UTIL' value='" + esc(a.var) + "' aria-label='Setting " + (i + 1) + "' spellcheck='false'/>" +
    "<input class='sw-vals' data-i='" + i + "' placeholder='" + (a.var === "CLOCK_PERIOD" ? "e.g. 10, 9, 8" : "e.g. 35, 50, 65") + "' value='" + esc(a.values) + "' aria-label='Values for setting " + (i + 1) + "' spellcheck='false'/>" +
    "<span class='sw-n' data-n='" + i + "'></span>" +
    (S.axes.length > 1 ? "<button class='iconbtn iconbtn-sm' data-rm='" + i + "' aria-label='Remove this setting'>" + icon("x", { size: 13 }) + "</button>" : "") + "</div>").join("");
  host.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
    const a = S.axes[+inp.dataset.i];
    if (inp.classList.contains("sw-var")) a.var = inp.value.trim().toUpperCase(); else a.values = inp.value;
    paintEst();
  }));
  S.el.querySelector("#sw-mode").hidden = S.axes.length < 2;
  S.el.querySelector("[data-sw='add']").hidden = S.axes.length >= 3;
  paintEst();
}

function problems() {
  const names = new Set((S.vars || []).map((v) => v.name));
  for (const a of S.axes) {
    if (!a.var) return "Pick a setting.";
    if (names.size && !names.has(a.var)) return a.var + " isn't a LibreLane setting.";
    if (!parseValues(a.values).length) return "Give " + a.var + " some values.";
  }
  if (new Set(S.axes.map((a) => a.var)).size < S.axes.length) return "Each setting once.";
  const n = countRuns(S.axes, S.mode);
  if (n < 0) return "Paired settings need the same number of values.";
  if (n > MAX_RUNS) return n + " runs is too many (at most " + MAX_RUNS + "). Narrow it down.";
  return "";
}

function paintEst() {
  S.axes.forEach((a, i) => { const el = S.el.querySelector("[data-n='" + i + "']"); if (el) { const n = parseValues(a.values).length; el.textContent = n ? n + " value" + (n === 1 ? "" : "s") : ""; } });
  const n = countRuns(S.axes, S.mode);
  const err = problems();
  const secs = typicalRunSecs();
  const est = S.el.querySelector("#sw-est");
  if (err) est.innerHTML = "<span class='sw-err'>" + esc(err) + "</span>";
  else est.innerHTML = "<b>= " + n + " run" + (n === 1 ? "" : "s") + "</b>" +
    (secs ? " · about " + esc(fmtDur(n * secs)) + " <span class='muted'>(from this design's past runs)</span>" : "") +
    (n > 8 ? "<div class='sw-warn'>That's a lot of runs. Two or three values usually show the trend.</div>" : "");
  const b = S.el.querySelector("#sw-start");
  const running = state.status && state.status.running;
  b.disabled = !!err || S.busy || running;
  b.title = running ? "A run is going: start the sweep when it ends." : "";
}

async function start() {
  if (problems() || S.busy) return;
  // The server still has the previous project active: a sweep now would run there.
  if (state.designMissing) {
    toast.show("Project folder not found: " + state.designMissing + ". Locate it or remove it from the list on Setup.", "warn");
    return;
  }
  const n = countRuns(S.axes, S.mode);
  // Each point is a full flow: warn when the machine is short on memory.
  let res = null;
  try { res = await api.systemResources(); res = res && (res.data || res); } catch (_e) { res = null; }
  if (res && res.ok && res.risk === "high") {
    const ok = await confirmDialog({ title: "Start " + n + " runs on a tight machine?", confirmText: "Start anyway",
      body: "This PC has " + (res.reasons || []).join("; ") + ". A run that runs out of memory can freeze Windows. Close other programs first." });
    if (!ok) return;
  }
  S.busy = true;
  paintEst();
  try {
    const { collectRunPayload } = await import("./setup.js");
    const base = collectRunPayload();
    const axes = S.axes.map((a) => ({ var: a.var, values: parseValues(a.values) }));
    const r = await api.dseStart({
      axes, mode: S.axes.length > 1 ? S.mode : "grid", run_mode: state.runMode, flow_name: "Classic",
      base_overrides: base.overrides, sources: base.sources, extras: base.extras,
      pdk: base.pdk, scl: base.scl, stop_when_good: S.stop, goal: S.goal,
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

// ------------------------------------------------------------------ summary
// A sweep's summary, under its row: the best point for timing and for area
// (each with "Use this configuration"), what failed and why, and a picture of
// the trend: slack and area against the swept value when one number was
// swept, else area against slack for every point.
export function paintSweepSummary(el, sw, runs, { verdictOf, failCode }) {
  const pts = runs.map((r) => ({ r, v: valuesOf(r, sw), ok: verdictOf(r).state === "passed", failed: verdictOf(r).state === "failed",
    wns: num(r, "timing__setup__ws"), area: num(r, "design__instance__area__stdcell") }));
  const passed = pts.filter((p) => p.ok);
  const failed = pts.filter((p) => p.failed);
  const bestT = passed.filter((p) => p.wns != null).sort((a, b) => b.wns - a.wns)[0];
  const bestA = passed.filter((p) => p.area != null).sort((a, b) => a.area - b.area)[0];
  const tile = (label, p, val) => !p ? "" :
    "<div class='sw-best'><div class='sw-best-k'>" + esc(label) + "</div><div class='sw-best-v'><code>" + esc(p.r.tag) + "</code></div>" +
    "<div class='sw-best-m'" + fmt.titleAttr(val.raw) + ">" + esc(val.text) + "</div>" +
    (p.v ? "<button class='btn btn-sm' data-use='" + esc(p.r.tag) + "' title='" + esc("Write " + Object.entries(p.v).map(([k, x]) => k + " = " + x).join(", ") + " into the design's config") + "'>Use this configuration</button>" : "") + "</div>";
  const failTile = failed.length
    ? "<div class='sw-best is-fail'><div class='sw-best-k'>" + failed.length + " failed</div><div class='sw-best-m'>" +
      failed.map((p) => "<code>" + esc(p.r.tag) + "</code>" + (failCode(p.r) ? " at " + esc(failCode(p.r)) : "")).join("<br>") + "</div></div>"
    : "";
  const plots = plotsHtml(pts, sw);
  el.innerHTML = "<div class='sw-sum" + (plots ? "" : " no-plot") + "'><div>" +
    "<div class='sw-bests'>" +
    tile("Best for timing", bestT, bestT ? { raw: bestT.wns, text: "setup WNS " + (bestT.wns >= 0 ? "+" : "") + fmt.metric(bestT.wns) + " ns" } : null) +
    tile("Best for area", bestA, bestA ? { raw: bestA.area, text: "std-cell area " + fmt.metric(bestA.area) + " µm²" } : null) +
    failTile + "</div>" +
    "<div class='sw-sum-act'><button class='btn btn-ghost btn-sm' data-cmp" + (runs.length < 2 ? " disabled title='A sweep with one run has nothing to compare'" : "") + ">" + icon("diff", { size: 13 }) + " Compare these runs</button>" +
    (passed.length ? "" : "<span class='muted'>No point finished clean. Open a failed one for why, or fix the design before sweeping again.</span>") + "</div></div>" +
    plots + "</div>";
  el.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); useConfig(pts.find((p) => p.r.tag === b.dataset.use)); }));
  el.querySelector("[data-cmp]").addEventListener("click", async (e) => {
    e.stopPropagation();
    const m = await import("./runs.js");
    m.compareRuns(runs.slice(0, 6));
  });
}

function num(r, k) { const v = (r.key_metrics || {})[k]; return typeof v === "number" && Number.isFinite(v) ? v : null; }
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

// The pictures of a sweep. One number swept: two small charts, slack and area
// against it (a failed point is a cross on the axis). Otherwise the trade-off:
// area against slack for every point.
function plotsHtml(pts, sw) {
  const axes = sw.axes || [];
  const one = axes.length === 1 ? axes[0].var : "";
  const xs = one ? pts.map((p) => (p.v ? Number(p.v[one]) : NaN)) : [];
  if (one && xs.every(Number.isFinite) && new Set(xs).size > 1) {
    const P = pts.map((p, i) => ({ ...p, x: xs[i] })).sort((a, b) => a.x - b.x);
    const a = trendSvg(P, one, "wns", "Setup WNS", "ns", 1);
    const b = trendSvg(P, one, "area", "Std-cell area", "µm²", -1);
    return a || b ? "<div class='sw-plots'>" + a + b + "</div>" : "";
  }
  const t = tradeSvg(pts);
  return t ? "<div class='sw-plots'>" + t + "</div>" : "";
}

// One metric against the swept value: a line through the finished points, the
// best one green, failed ones a red cross on the x axis.
function trendSvg(P, xvar, key, label, unit, dir) {
  const D = P.filter((p) => p[key] != null);
  if (D.length < 2) return "";
  const W = 320, H = 180, L = 52, R = 14, T = 12, B = 34;
  const [x0, x1] = pad(Math.min(...P.map((p) => p.x)), Math.max(...P.map((p) => p.x)));
  const [y0, y1] = pad(Math.min(...D.map((p) => p[key])), Math.max(...D.map((p) => p[key])));
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const best = D.filter((p) => p.ok).sort((a, b) => (dir > 0 ? b[key] - a[key] : a[key] - b[key]))[0];
  const line = "<polyline class='sw-line' points='" + D.map((p) => X(p.x).toFixed(1) + "," + Y(p[key]).toFixed(1)).join(" ") + "'/>";
  const dots = P.map((p) => {
    const cx = X(p.x).toFixed(1);
    if (p[key] == null) {
      const cy = H - B;
      return "<g class='sw-pt is-fail'><title>" + esc(p.r.tag + ": " + xvar + " " + p.x + (p.failed ? ", failed" : ", no result")) + "</title>" +
        "<path d='M" + (cx - 4) + " " + (cy - 4) + "l8 8M" + (+cx + 4) + " " + (cy - 4) + "l-8 8'/></g>";
    }
    const cy = Y(p[key]).toFixed(1);
    return "<g class='sw-pt" + (p === best ? " is-best" : "") + (p.ok ? "" : " is-fail") + "'><title>" + esc(p.r.tag + ": " + xvar + " " + p.x + ", " + label.toLowerCase() + " " + p[key] + " " + unit) + "</title>" +
      "<circle cx='" + cx + "' cy='" + cy + "' r='4.5'/></g>";
  }).join("");
  const xt = P.map((p) => "<text class='sw-tk' x='" + X(p.x).toFixed(1) + "' y='" + (H - B + 14) + "' text-anchor='middle'>" + esc(String(p.x)) + "</text>").join("");
  const zero = key === "wns" && y0 < 0 && y1 > 0 ? "<line class='sw-zero' x1='" + L + "' x2='" + (W - R) + "' y1='" + Y(0).toFixed(1) + "' y2='" + Y(0).toFixed(1) + "'/>" : "";
  return "<figure class='sw-plot'><figcaption><b>" + esc(label) + "</b> (" + esc(unit) + ") by " + esc(xvar) + "</figcaption>" +
    "<svg viewBox='0 0 " + W + " " + H + "' role='img' aria-label='" + esc(label + " for each value of " + xvar) + "'>" +
    "<line class='sw-gridl' x1='" + L + "' x2='" + (W - R) + "' y1='" + T + "' y2='" + T + "'/>" +
    "<line class='sw-ax' x1='" + L + "' x2='" + L + "' y1='" + T + "' y2='" + (H - B) + "'/><line class='sw-ax' x1='" + L + "' x2='" + (W - R) + "' y1='" + (H - B) + "' y2='" + (H - B) + "'/>" + zero +
    "<text class='sw-tk' x='" + (L - 6) + "' y='" + (T + 4) + "' text-anchor='end'>" + tick(y1) + "</text><text class='sw-tk' x='" + (L - 6) + "' y='" + (H - B) + "' text-anchor='end'>" + tick(y0) + "</text>" +
    xt + "<text class='sw-axl' x='" + ((L + W - R) / 2) + "' y='" + (H - 4) + "' text-anchor='middle'>" + esc(xvar) + "</text>" + line + dots + "</svg></figure>";
}

// Std-cell area (x) against setup WNS (y). Axes span the data (not from 0),
// points labelled by their value, a label dropped when it would overlap.
function tradeSvg(pts) {
  const P = pts.filter((p) => p.wns != null && p.area != null);
  if (P.length < 2) return "";
  const W = 460, H = 200, L = 64, R = 16, T = 14, B = 38;
  const xs = P.map((p) => p.area), ys = P.map((p) => p.wns);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const placed = [];
  const dots = P.map((p) => {
    const cx = X(p.area), cy = Y(p.wns);
    const lab = p.v ? Object.values(p.v).join("/") : p.r.tag;
    const box = [cx - lab.length * 3.4, cy - 20, cx + lab.length * 3.4, cy - 8];
    const hit = placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]));
    if (!hit) placed.push(box);
    return "<g class='sw-pt" + (p.ok ? "" : " is-fail") + "'><title>" + esc(p.r.tag + ": std-cell area " + p.area + " µm², setup WNS " + p.wns + " ns") + "</title>" +
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

// Write a point's values into the design's config (the same configedit path
// the fix sheet uses), after showing exactly what changes; Undo puts it back.
async function useConfig(p) {
  if (!p || !p.v) return;
  const lines = Object.entries(p.v).map(([k, v]) => k + " = " + v).join("\n");
  const ok = await confirmDialog({ title: "Use " + p.r.tag + "'s settings?", confirmText: "Save to the config",
    body: "This writes these values into your design's config file:\n\n" + lines + "\n\nYour next run uses them. You can undo it from the message that follows." });
  if (!ok) return;
  try {
    const r = await api.configSet(p.v, [], { pdk: state.selectedPdk, scl: state.selectedScl });
    const d = (r && (r.data || r)) || {};
    const diff = (d.diff || []).map((x) => (x.key || x.var || "") + ": " + (x.from ?? x.old ?? "unset") + " → " + (x.to ?? x.new ?? "")).filter((s) => s.length > 4).join(", ");
    const u = d.undo || null;
    toast.show("Saved in " + (d.name || "the config") + (diff ? ": " + diff : "") + ".", "success", 12000,
      u && u.backup ? { label: "Undo", run: async () => {
        try { const x = await api.configUndo({ backup: u.backup, after: u.after }); toast.show(((x && (x.data || x)).name || "The config") + " is back as it was.", "success"); }
        catch (ex) { toast.show("Undo: " + (ex.message || ex), "warn", 9000); }
      } } : null);
    for (const [k, v] of Object.entries(p.v)) { if (state.varsValues) state.varsValues[k] = String(v); }
  } catch (ex) {
    toast.show("Couldn't save: " + (ex.message || ex), "error", 0);
  }
}

export const _test = { parseValues, countRuns, stageLabel: FS.stageLabel };
