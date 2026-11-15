// compare.js — run against run (Analytics › Compare).
//
// The runs being compared sit in one row; the first is the reference, and
// every other number says how far it moved from it (green: better, red:
// worse, by each metric's own direction from LibreLane's registry). Under it:
// the headline numbers, the settings that differ, a few charts, and every
// metric (only the ones that differ, until asked for all).
import { api, fmt } from "./api.js";
import { state } from "./state.js";
import { toCsv, downloadCsv } from "./csvutil.js";
import { gatherRunsScoped, designLabel, contextRun, contextBaseline, contextDesign, normDir } from "./context.js";
import { icon } from "./icons.js";
import { localeNum } from "./intlcache.js";
import { verdictOfRun } from "./verdict.js";
import { openLayer, closeLayer, isLayerOpen } from "./overlay.js";
import { toast } from "./toast.js";

const esc = (s) => fmt.escape(s == null ? "" : String(s));
const MAX = 6;

// The run's verdict as the Runs page reads it: a square mark and its word.
function verdictMark(r) {
  const v = verdictOfRun(r);
  return "<span class='rb-mark is-" + v.cls + "' title='" + esc(v.word) + "'></span>";
}

let _runs = [];              // every run of every design opened (newest first)
let _sel = [];               // the run_dirs being compared; the first is the reference
let _data = null;            // the last /api/compare answer
let _allMetrics = false;     // the metrics table: every metric, or only the ones that differ
let _seq = 0;

// Runs picked on the Runs page (by run_dir): the next render compares them
// straight away, so Runs' "Compare" lands on the answer.
let _preselect = null;
export function preselectCompare(runDirs) { _preselect = (runDirs || []).slice(0, MAX); }

const rowOf = (dir) => _runs.find((r) => r.run_dir === dir) || null;

export async function renderCompare() {
  const root = document.getElementById("compare-body");
  if (!root) return;
  // Compare is cross-design: every known design's runs, each carrying its own
  // absolute run_dir, which the backend resolves directly.
  try { _runs = await gatherRunsScoped("all"); } catch (_e) { _runs = state.runs || []; }
  _runs = _runs.filter((r) => r.run_dir);
  if (!_runs.length) {
    root.innerHTML = "<div class='empty'><h3>No runs to compare</h3><p>Finish at least two runs, then come back.</p></div>";
    return;
  }
  if (_preselect && _preselect.length) { _sel = _preselect; _preselect = null; }
  _sel = _sel.filter((d) => rowOf(d));
  // Nothing picked yet: the run in view against its baseline, when there are both.
  if (!_sel.length) {
    const d = normDir(contextDesign());
    const find = (tag) => tag && _runs.find((r) => r.tag === tag && normDir(r._design) === d);
    const a = find(contextBaseline()), b = find(contextRun());
    if (a && b && a !== b) _sel = [a.run_dir, b.run_dir];
    else if (b) _sel = [b.run_dir];
  }
  root.innerHTML =
    "<div class='cmp-bar'><div class='cmp-sel' id='cmp-sel' role='list' aria-label='Runs being compared'></div>" +
    "<div class='cmp-add-wrap'><button class='btn btn-sm' id='cmp-add' aria-haspopup='true' aria-expanded='false'>" + icon("plus", { size: 13 }) + " Add a run</button>" +
    "<div class='cmp-pop' id='cmp-pop' role='dialog' aria-label='Add a run to the comparison' hidden></div></div>" +
    "<span class='cmp-spacer'></span>" +
    "<button class='btn btn-ghost btn-sm' id='cmp-export-csv' disabled>" + icon("download", { size: 13 }) + " Export CSV</button></div>" +
    "<div id='cmp-out'></div>";
  wirePicker(root);
  paintSel(root);
  compare(root);
}

// ------------------------------------------------------------------ the runs compared
function paintSel(root) {
  const host = root.querySelector("#cmp-sel");
  const designs = new Set(_sel.map((d) => (rowOf(d) || {})._design));
  host.innerHTML = _sel.map((d, i) => {
    const r = rowOf(d);
    const name = (designs.size > 1 ? designLabel(r._design) + " · " : "") + r.tag;
    return "<span class='cmp-chip" + (i === 0 ? " is-ref" : "") + "' role='listitem'>" +
      (i === 0 ? "<span class='cmp-ref' title='Every other run is measured against this one'>Reference</span>"
        : "<button class='cmp-mkref' data-ref='" + i + "' title='Measure the others against this run' aria-label='Make " + esc(name) + " the reference'>" + icon("star", { size: 12 }) + "</button>") +
      verdictMark(r) + "<span class='cmp-chip-t'>" + esc(name) + "</span>" +
      "<button class='cmp-x' data-rm='" + i + "' aria-label='Take " + esc(name) + " out of the comparison'>" + icon("x", { size: 12 }) + "</button></span>";
  }).join("") || "<span class='muted'>No runs picked yet.</span>";
  host.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { _sel.splice(+b.dataset.rm, 1); paintSel(root); compare(root); }));
  host.querySelectorAll("[data-ref]").forEach((b) => b.addEventListener("click", () => {
    const [d] = _sel.splice(+b.dataset.ref, 1);
    _sel.unshift(d);
    paintSel(root);
    compare(root);
  }));
  const add = root.querySelector("#cmp-add");
  add.disabled = _sel.length >= MAX;
  add.title = _sel.length >= MAX ? "Compare takes up to six runs" : "";
}

function wirePicker(root) {
  const btn = root.querySelector("#cmp-add"), pop = root.querySelector("#cmp-pop");
  let q = "";
  const fill = () => {
    const left = _runs.filter((r) => !_sel.includes(r.run_dir) &&
      (!q || (r.tag + " " + designLabel(r._design) + " " + (r.note || "")).toLowerCase().includes(q)));
    const multi = new Set(_runs.map((r) => r._design)).size > 1;
    let last = null;
    const rows = left.slice(0, 80).map((r) => {
      const head = multi && r._design !== last ? "<div class='rb-group'>" + esc(designLabel(r._design)) + "</div>" : "";
      last = r._design;
      const v = verdictOfRun(r);
      return head + "<button class='cmp-opt' data-dir='" + esc(r.run_dir) + "'><span class='rb-mark is-" + v.cls + "'></span>" +
        "<span class='cmp-opt-n'>" + esc(r.tag) + "</span><span class='cmp-opt-v'>" + esc(v.word) + "</span></button>";
    }).join("");
    pop.querySelector(".cmp-list").innerHTML = rows || "<div class='rb-none'>" + (q ? "No run matches." : "Every run is already in the comparison.") + "</div>";
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isLayerOpen(pop)) { closeLayer(pop); return; }
    q = "";
    pop.innerHTML = "<input class='rb-q cmp-q' type='search' placeholder='Find a run' aria-label='Find a run'/><div class='cmp-list'></div>";
    pop.hidden = false;
    fill();
    pop.querySelector(".cmp-q").addEventListener("input", (ev) => { q = ev.target.value.trim().toLowerCase(); fill(); });
    openLayer(pop, { kind: "popover", owner: btn, onClose: () => { pop.hidden = true; }, focus: () => pop.querySelector(".cmp-q") });
  });
  pop.addEventListener("click", (e) => {
    const o = e.target.closest(".cmp-opt");
    if (!o) return;
    if (_sel.length >= MAX) { toast.show("Compare takes up to six runs.", "info"); return; }
    _sel.push(o.dataset.dir);
    paintSel(root);
    compare(root);
    // The list stays open for the next one, until there is no room left.
    if (_sel.length >= MAX) closeLayer(pop); else fill();
  });
  root.querySelector("#cmp-export-csv").addEventListener("click", () => { if (_data) exportCompareCsv(_data, buildCols(_data.runs || [])); });
}

// ------------------------------------------------------------------ the comparison
async function compare(root) {
  const out = root.querySelector("#cmp-out");
  const exp = root.querySelector("#cmp-export-csv");
  const my = ++_seq;
  _data = null;
  if (exp) exp.disabled = true;
  disposeCharts();
  if (_sel.length < 2) {
    out.innerHTML = "<div class='an-none cmp-hint'><b>" + (_sel.length ? "Add one more run." : "Pick two runs.") + "</b> " +
      "The first is the reference; the others show how far each number moved from it. Up to six runs, from any design you have opened. " +
      "Ticking runs on the Runs page and pressing Compare brings them here.</div>";
    return;
  }
  if (!out.querySelector(".cmp-grid")) out.innerHTML = "<p class='muted cmp-wait'>Comparing…</p>";
  else out.classList.add("is-loading");
  // Absolute run_dirs, so a run from ANY design resolves on the backend.
  const picked = _sel.map(rowOf).filter(Boolean);
  let data;
  try { data = await api.compare(picked.map((r) => r.tag), picked.map((r) => r.run_dir)); } catch (ex) {
    if (my !== _seq) return;
    out.classList.remove("is-loading");
    out.innerHTML = "<div class='cmp-error'>Compare failed: " + esc(ex.message || ex) + "</div>";
    return;
  }
  if (my !== _seq) return;
  out.classList.remove("is-loading");
  // The backend answers in its own order: put the runs back in the picked one.
  const order = new Map(_sel.map((d, i) => [d, i]));
  data.runs = (data.runs || []).slice().sort((a, b) => (order.get(a.run_dir) ?? 99) - (order.get(b.run_dir) ?? 99));
  _data = data;
  if (exp) exp.disabled = false;

  // Columns are keyed by the backend's per-run ``col`` (the unique run_dir), NOT
  // the tag: two designs can each hold a run named "baseline", and a tag-keyed
  // table would silently collapse them onto one column (Fear F/M).
  const cols = buildCols(data.runs || []);
  out.innerHTML =
    "<div class='cmp-grid'><section class='cmp-block'>" + summaryHtml(data, cols) + "</section>" +
    "<section class='cmp-block'>" + settingsHtml(data, cols) + "</section></div>" +
    "<h3 class='cmp-h'>Charts</h3><div id='cmp-charts' class='cmp-charts'></div>" +
    "<div class='cmp-mhead'><h3 class='cmp-h'>Every metric</h3>" +
    "<div class='rn-seg' role='group' aria-label='Which metrics'><button class='rn-segb' data-all='0'>That differ <span class='rn-n' id='cmp-n-diff'></span></button>" +
    "<button class='rn-segb' data-all='1'>All <span class='rn-n' id='cmp-n-all'></span></button></div>" +
    "<input id='cmp-search' type='search' placeholder='Filter metrics' aria-label='Filter metrics'/></div>" +
    "<div class='cmp-scroll' id='cmp-metrics'></div>";
  const search = out.querySelector("#cmp-search");
  const paint = () => paintMetrics(out, data, cols, search.value.trim().toLowerCase());
  search.oninput = paint;
  out.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => { _allMetrics = b.dataset.all === "1"; paint(); }));
  paint();
  renderCompareCharts(out.querySelector("#cmp-charts"), data, cols);
}

// Build the column descriptors for a comparison from the backend's run rows.
// ``col`` is the unique lookup key (run_dir); ``label`` disambiguates same-named
// runs by prefixing the design whenever a tag repeats or multiple designs are in
// play, so no two columns are ambiguous.
export function buildCols(runs) {
  const tagCount = {};
  for (const r of runs) tagCount[r.tag] = (tagCount[r.tag] || 0) + 1;
  const designs = new Set(runs.map((r) => r.design).filter(Boolean));
  const multiDesign = designs.size > 1;
  return runs.map((r) => {
    const dup = (tagCount[r.tag] || 0) > 1;
    const label = ((multiDesign || dup) && r.design) ? (r.design + " · " + r.tag) : (r.tag || r.col);
    return { col: r.col, tag: r.tag, design: r.design || "", label };
  });
}

function colHeaders(cols) {
  return cols.map((c, i) => "<th" + (i === 0 ? " class='is-ref'" : "") + ">" + esc(c.label) + (i === 0 ? " <small>reference</small>" : "") + "</th>").join("");
}

// How far a number moved from the reference: text, and whether that is better.
// `meta` is the metric's entry in metric_meta (higher_is_better, direction_known).
export function deltaOf(v, ref, meta, unit = "") {
  if (typeof v !== "number" || typeof ref !== "number" || !Number.isFinite(v) || !Number.isFinite(ref)) return null;
  const d = v - ref;
  if (Math.abs(d) <= Math.max(Math.abs(ref) * 5e-4, 1e-12)) return { text: "same", cls: "is-same" };
  const sign = d > 0 ? "+" : "−";
  const abs = Math.abs(d);
  // Slack and counts read best as a difference; sizes and power as a percentage.
  const asDiff = unit === "ns" || ref === 0 || (Number.isInteger(v) && Number.isInteger(ref) && Math.abs(ref) < 1000);
  const text = asDiff ? sign + localeNum(Number(abs.toPrecision(3)), "en-US", { maximumFractionDigits: 3 }) + (unit === "ns" ? " ns" : "")
    : sign + (abs / Math.abs(ref) * 100).toFixed(abs / Math.abs(ref) < 0.1 ? 1 : 0) + " %";
  const known = meta && meta.direction_known !== false && typeof meta.higher_is_better === "boolean";
  const cls = !known ? "" : (d > 0) === meta.higher_is_better ? "is-better" : "is-worse";
  return { text, cls };
}
const deltaHtml = (d) => (d ? "<span class='cmp-d " + d.cls + "'>" + esc(d.text) + "</span>" : "");

// Render config values readably (lists → comma list, bool/None → text).
function fmtCfg(v) {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => String(x).split(/[/\\]/).pop()).join(", ");
  return String(v);
}

// ------------------------------------------------------------------ headline numbers
// Side-by-side headline summary, built from each run's design_summary rows
// (already returned by /api/compare). Rows are the union of labels seen. Keyed
// by the unique per-run column, so same-named runs never merge.
function summaryHtml(data, cols) {
  const runs = data.runs || [], meta = data.metric_meta || {};
  const byCol = {};
  const order = [];
  for (const r of runs) {
    byCol[r.col] = {};
    for (const row of (r.summary || [])) {
      byCol[r.col][row.label] = row;
      if (!order.includes(row.label)) order.push(row.label);
    }
  }
  if (!order.length) return "<h3 class='cmp-h'>Headline numbers</h3><p class='muted'>These runs have no summary numbers (they ended before the layout was built).</p>";
  const ref = cols[0];
  return "<h3 class='cmp-h'>Headline numbers</h3>" +
    "<div class='cmp-scroll'><table class='cmp-table cmp-sum'><thead><tr><th>Metric</th>" + colHeaders(cols) + "</tr></thead><tbody>" +
    order.map((label) => {
      const base = byCol[ref.col] && byCol[ref.col][label];
      return "<tr><td>" + esc(label) + "</td>" + cols.map((c, i) => {
        const row = byCol[c.col] && byCol[c.col][label];
        const d = i && row && base ? deltaOf(row.value, base.value, meta[row.key], row.unit) : null;
        return summaryCellHtml(row, d);
      }).join("") + "</tr>";
    }).join("") + "</tbody></table></div>";
}

// One side-by-side summary cell. Exported + pure so the "rounded display never
// hides the real value" invariant is directly testable. fmt.metric() rounds for
// readability; fmt.titleAttr() carries the EXACT tool value in the cell's title
// so a tape-out comparison can never rest on a number the user cannot verify
// (Fear A/G). An absent row stays "—" (never a fabricated 0). `delta` (from
// deltaOf) adds how far the value moved from the reference run.
export function summaryCellHtml(row, delta = null) {
  if (!row) return "<td>—</td>";
  const unit = row.unit ? " " + fmt.escape(row.unit) : "";
  const cls = row.status ? " class='" + (row.status === "pass" ? "cmp-num pass" : row.status === "fail" ? "cmp-num fail" : "cmp-num") + "'" : " class='cmp-num'";
  return "<td" + cls + fmt.titleAttr(row.value) + ">" + fmt.escape(shortMetric(row.value)) + unit + deltaHtml(delta) + "</td>";
}

// fmt.metric() pads to 3 decimals, which turns a count of 64 into "64.000".
// When the value has no more digits than that, show it as written (64, 66.4);
// otherwise keep the rounded display (the exact value is in the title).
function shortMetric(v) {
  const r = fmt.metric(v);
  if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100 && Number(r) === v) {
    return localeNum(v, "en-US", { maximumFractionDigits: 3 });
  }
  return r;
}

// ------------------------------------------------------------------ settings
// Paths and file lists differ between any two run folders: they are not what
// someone means by "which settings changed".
const PATHISH = /^(meta|DESIGN_DIR|.*_PATH|.*_FILE|.*_FILES|RUN_TAG|.*_DIR|.*_CFG)$/;
const same = (per, cols) => new Set(cols.map((c) => JSON.stringify(per[c.col] ?? null))).size <= 1;
// A metric differs when the runs that have it disagree (a run that stopped
// early has no metrics at all: that is not a difference in every one of them).
const differ = (per, cols) => new Set(cols.map((c) => per[c.col]).filter((v) => v !== undefined && v !== null).map((v) => JSON.stringify(v))).size > 1;

function cfgTable(keys, table, cols, mark) {
  return "<div class='cmp-scroll'><table class='cmp-table cmp-cfg'><thead><tr><th>Setting</th>" + colHeaders(cols) + "</tr></thead><tbody>" +
    keys.map((k) => "<tr><td><code>" + esc(k) + "</code></td>" + cols.map((c, i) => {
      const v = table[k][c.col];
      const diff = mark && i && JSON.stringify(v ?? null) !== JSON.stringify(table[k][cols[0].col] ?? null);
      return "<td" + (diff ? " class='cmp-diff'" : "") + " title='" + esc(fmtCfg(v)) + "'>" + esc(fmtCfg(v)) + "</td>";
    }).join("") + "</tr>").join("") + "</tbody></table></div>";
}

function settingsHtml(data, cols) {
  const kc = data.key_config || {}, cd = data.config_diff || {};
  const diffKeys = Object.keys(cd).filter((k) => !PATHISH.test(k) && !same(cd[k], cols));
  const pathKeys = Object.keys(cd).filter((k) => PATHISH.test(k) && !same(cd[k], cols));
  const sameKeys = Object.keys(kc).filter((k) => !diffKeys.includes(k) && same(kc[k], cols));
  const fold = (title, n, body) => "<details class='cmp-fold'><summary>" + esc(title) + " <span class='rn-n'>" + n + "</span></summary>" + body + "</details>";
  return "<h3 class='cmp-h'>Settings that differ</h3>" +
    (diffKeys.length ? cfgTable(diffKeys, cd, cols, true)
      : "<p class='cmp-same'>" + icon("check", { size: 14 }) + " These runs used the same settings.</p>") +
    (sameKeys.length ? fold("The same in every run", sameKeys.length, cfgTable(sameKeys, kc, cols, false)) : "") +
    (pathKeys.length ? fold("Folders and files", pathKeys.length, cfgTable(pathKeys, cd, cols, true)) : "");
}

// ------------------------------------------------------------------ every metric
function paintMetrics(out, data, cols, filter) {
  const table = data.metric_table || {}, meta = data.metric_meta || {}, best = data.best || {};
  const all = Object.keys(table).sort();
  const differs = all.filter((m) => differ(table[m], cols));
  const set = (_allMetrics ? all : differs).filter((m) => !filter || m.toLowerCase().includes(filter));
  out.querySelector("#cmp-n-diff").textContent = differs.length;
  out.querySelector("#cmp-n-all").textContent = all.length;
  out.querySelectorAll("[data-all]").forEach((b) => {
    const on = (b.dataset.all === "1") === _allMetrics;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const host = out.querySelector("#cmp-metrics");
  if (!set.length) {
    host.innerHTML = "<p class='muted cmp-none'>" + (filter ? "No metric matches that filter." : "Every metric is the same in these runs.") + "</p>";
    return;
  }
  const ref = cols[0];
  host.innerHTML = "<table class='cmp-table cmp-all'><thead><tr><th>Metric</th>" + colHeaders(cols) + "</tr></thead><tbody>" +
    set.map((m) => {
      const per = table[m];
      const cells = cols.map((c, i) => {
        const v = per[c.col];
        const d = i ? deltaOf(v, per[ref.col], meta[m]) : null;
        const cls = best[m] && c.col === best[m] && differ(per, cols) ? " class='cmp-best'" : "";
        return "<td" + cls + fmt.titleAttr(v) + ">" + esc(v === undefined || v === null ? "—" : typeof v === "number" ? shortMetric(v) : String(v)) +
          (d && d.cls !== "is-same" ? deltaHtml(d) : "") + "</td>";
      }).join("");
      return "<tr><td><code>" + esc(m) + "</code></td>" + cells + "</tr>";
    }).join("") + "</tbody></table>";
}

// Export the whole comparison (key config + config diffs + every metric) as one
// CSV: column 1 = field, then one column per run (headers are the disambiguated
// labels; values are keyed by the unique per-run column, never the tag).
function exportCompareCsv(data, cols) {
  const rows = [["field", ...cols.map((c) => c.label)]];
  const kc = data.key_config || {};
  for (const k of Object.keys(kc)) rows.push(["config: " + k, ...cols.map((c) => fmtCfg(kc[k][c.col]))]);
  const cd = data.config_diff || {};
  for (const k of Object.keys(cd)) rows.push(["diff: " + k, ...cols.map((c) => fmtCfg(cd[k][c.col]))]);
  const mt = data.metric_table || {};
  for (const m of Object.keys(mt).sort()) rows.push([m, ...cols.map((c) => mt[m][c.col])]);
  downloadCsv("compare-" + (cols[0] ? cols[0].tag : "runs") + ".csv", toCsv(rows));
}

// ------------------------------------------------------------------ charts
// Curated key metrics to chart across runs (one small bar chart each). Only the
// ones actually present in the comparison are drawn — never fabricated.
const _CHART_METRICS = [
  ["design__instance__count", "Cell count"],
  ["design__core__area", "Core area (µm²)"],
  ["design__instance__utilization", "Utilization"],
  ["timing__setup__ws", "Setup WNS (ns)"],
  ["timing__hold__ws", "Hold WNS (ns)"],
  ["power__total", "Total power"],
  ["route__wirelength__estimated", "Wirelength"],
];

// The chart instances of the last render (disposed when it is replaced) and
// one ResizeObserver for all of them (was a new window listener per render).
let _charts = [];
let _chartRO = null;
function disposeCharts() {
  for (const c of _charts) { try { c.dispose(); } catch (_e) { /* already gone */ } }
  _charts = [];
}

async function renderCompareCharts(host, data, cols) {
  if (!host) return;
  disposeCharts();
  if (typeof window.echarts === "undefined") await import("./loading.js").then((m) => m.loadECharts()).catch(() => null);
  if (!host.isConnected) return;
  if (typeof window.echarts === "undefined") { host.innerHTML = "<p class='muted'>Charts need ECharts.</p>"; return; }
  const { runBarsOption, runBarsHeight } = await import("./barchart.js");
  const table = data.metric_table || {};
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  const labels = cols.map((c) => c.label);
  const present = _CHART_METRICS.filter(([k]) => table[k] &&
    cols.some((c) => num(table[k][c.col]) !== null));
  if (!present.length) { host.innerHTML = "<p class='muted'>These runs have no chartable metrics in common.</p>"; return; }
  // Each chart is a small card: the metric named in the page's own type, the
  // runs as bars down the side in the same colours on every card.
  host.innerHTML = present.map(([k, label]) => {
    const um = /\(([^)]+)\)\s*$/.exec(label);
    const name = um ? label.slice(0, um.index).trim() : label;
    return "<figure class='cmp-fig'><figcaption><b>" + fmt.escape(name) + "</b>" + (um ? " <span>" + fmt.escape(um[1]) + "</span>" : "") +
      "<code>" + fmt.escape(k) + "</code></figcaption><div class='cmp-chart' data-k='" + fmt.escape(k) + "' style='height:" + runBarsHeight(cols.length) + "px'></div></figure>";
  }).join("");
  for (const [k, label] of present) {
    const el = host.querySelector(".cmp-chart[data-k='" + (window.CSS && CSS.escape ? CSS.escape(k) : k) + "']");
    if (!el) continue;
    // Split "Cell count" / "Core area (µm²)" into a name + optional unit so the
    // chart clearly states WHICH metric it compares (title) and its unit (y-axis).
    const um = /\(([^)]+)\)\s*$/.exec(label);
    const unit = um ? um[1] : "";
    const name = um ? label.slice(0, um.index).trim() : label;
    const opt = runBarsOption({ labels, values: cols.map((c) => num(table[k][c.col])), unit });
    if (!opt) continue;
    const chart = window.echarts.init(el, null, { renderer: "canvas" });
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", name + " comparison across selected runs, matching the values in the comparison tables above.");
    chart.setOption(opt);
    _charts.push(chart);
  }
  if (typeof ResizeObserver === "undefined") return;
  if (!_chartRO) {
    let t = 0;
    _chartRO = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { for (const c of _charts) { if (!c.isDisposed()) c.resize(); } }, 60);
    });
  }
  _chartRO.disconnect();
  _chartRO.observe(host);
}
