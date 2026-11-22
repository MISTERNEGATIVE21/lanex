// guide-steps.js — what the first-run guide and the tour say, as data, and the
// pure rules that move them on. No DOM here (guide.js draws it; the frontend
// test runs these).
//
// The first-chip guide is six beats. Each one after the first moves on when the
// app itself says the thing happened (an event on `document`), never on a Next
// click: the project opened, the simulation finished, the PDK was confirmed,
// the run started, the run finished.

export const GUIDE_TEMPLATE = "blinky";   // the fastest clean run of the examples

export const BEATS = [
  { id: "installed", label: "LanEx installed", done: true },
  { id: "project", label: "Make the example", on: "g:project_opened" },
  { id: "sim", label: "Simulate it", on: "g:sim_done" },
  { id: "pdk", label: "Pick the process", on: "g:pdk_confirmed" },
  { id: "run", label: "Run the flow", on: "g:run_started" },
  { id: "flow", label: "Watch it build", on: "g:flow_done" },
];

// The beat an event moves the guide to (the same beat when it doesn't apply).
// A simulation that didn't run to the end, or a run that failed or was
// stopped, does not count: the guide stays on that beat and offers help.
export function advance(beat, type, detail = {}) {
  const b = BEATS[beat];
  if (!b || b.on !== type) return beat;
  if (type === "g:sim_done" && !simOk(detail)) return beat;
  if (type === "g:flow_done" && (detail.error || detail.cancelled)) return beat;
  return beat + 1;
}

// The guide builds one project: once it is made, only events in that project
// move the guide on (a simulation or run in another project doesn't count).
export function sameProject(a, b) {
  const n = (p) => String(p || "").replace(/[\\/]+$/, "");
  return !!a && !!b && n(a) === n(b);
}
export function onGuideProject(g, current) {
  return !g || !g.project || sameProject(g.project, current);
}

// The project the guide just asked for (`expect`: {name}) or one with the
// guide template's files (`files`: the opened folder's relative paths, when
// read) is the guide's. Any other project opened meanwhile is not.
export function isGuideProject(dir, expect, files, tpl) {
  if (!dir) return false;
  const base = String(dir).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (expect && expect.name && base === expect.name) return true;
  if (!Array.isArray(files) || !tpl) return false;
  const need = [].concat(tpl.sources || [], tpl.testbench ? [tpl.testbench] : []);
  return need.length > 0 && need.every((rel) => files.includes(rel));
}

// A project name that isn't taken yet: blinky, then blinky-2, blinky-3 …
export function freeName(base, taken) {
  const have = new Set((taken || []).map((x) => String(x).toLowerCase()));
  if (!have.has(String(base).toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = base + "-" + i;
    if (!have.has(cand.toLowerCase())) return cand;
  }
  return base + "-" + Date.now();
}

// The guide template's own file names (template.json), with Blinky's as the
// fallback when the server's list isn't to hand.
export function guideFiles(tpl) {
  const src = (tpl && Array.isArray(tpl.sources) && tpl.sources[0]) || "src/blinky.v";
  return {
    source: src,
    sourceName: src.split("/").pop(),
    testbench: (tpl && tpl.testbench) || "verify/blinky_tb.v",
    top: (tpl && tpl.top) || "blinky",
    title: (tpl && tpl.title) || "Blinky",
  };
}

export function simOk(d) {
  return !!d && (d.verdict === "passed" || d.verdict === "ran");
}

// "FIRST CHIP 3/6": beats are counted from one, and a finished guide reads 6/6.
export function pillText(beat) {
  const n = Math.min(Math.max(beat, 0) + 1, BEATS.length);
  return "FIRST CHIP " + n + "/" + BEATS.length;
}

// The saved guide state, whatever was stored (missing, old or hand-edited).
export function normState(raw) {
  let s = raw;
  if (typeof s === "string") { try { s = JSON.parse(s); } catch (_e) { s = null; } }
  if (!s || typeof s !== "object") return { active: false, beat: 1 };
  const beat = Number.isInteger(s.beat) ? Math.min(Math.max(s.beat, 1), BEATS.length) : 1;
  const out = { active: !!s.active, beat, project: typeof s.project === "string" ? s.project : "" };
  if (s.expect && typeof s.expect === "object" && typeof s.expect.name === "string") out.expect = { name: s.expect.name };
  return out;
}

// Tour counter, two digits like the rest of the mono labels: "02/05".
export function counter(i, n) {
  const p = (x) => String(x).padStart(2, "0");
  return p(i + 1) + "/" + p(n);
}

// The tour: one stop per rail group, then the command palette. `target` is a
// CSS selector; guide.js resolves it on screen.
export const TOUR = [
  { id: "design", target: ".side-tabs .rail-group:nth-of-type(1)", title: "Design",
    body: "Setup holds your project, the process and the run settings. The RTL IDE edits, checks and simulates Verilog. Cells shows the logic gates the flow builds your design from." },
  { id: "run", target: ".side-tabs .rail-group:nth-of-type(2)", title: "Run",
    body: "Run is top right (or press r). Flow shows the run stage by stage while it goes, and why it stopped if it does. Runs keeps every past run to open, compare or sweep." },
  { id: "results", target: ".side-tabs .rail-group:nth-of-type(3)", title: "Results",
    body: "Layout draws the chip from every stage, flat or in 3D. Analytics has timing, area and power. Verify has the sign-off checks: DRC, LVS, antenna and timing." },
  { id: "system", target: ".side-tabs .rail-foot", title: "System",
    body: "Tools installs and checks the EDA tools and the PDKs." },
  { id: "palette", target: "#palette-btn", title: "Find anything",
    body: "Ctrl+K finds any page, setting, run or command. Both guides are there too, and in Help." },
];

// The finish card's numbers, from the run's own summary rows (history.py
// design_summary: {label, value, unit, key}) and the clock the run used.
// Only numbers that exist are shown; nothing is computed here.
export function chipFacts(summary, clockNs) {
  const rows = Array.isArray(summary) ? summary : [];
  const by = (key) => rows.find((r) => r && r.key === key && r.value !== null && r.value !== "");
  const out = [];
  const size = by("design__die__bbox");
  const area = by("design__die__area");
  if (size) out.push({ label: "Die size", value: String(size.value), unit: size.unit || "µm", key: size.key });
  else if (area) out.push({ label: "Die area", value: String(area.value), unit: area.unit || "µm²", key: area.key });
  const c = parseFloat(clockNs);
  if (c > 0) {
    const f = 1000 / c;
    out.push({ label: "Clock", value: String(c), unit: "ns · " + (f >= 100 ? f.toFixed(0) : f.toFixed(1).replace(/\.0$/, "")) + " MHz", key: "CLOCK_PERIOD" });
  }
  const cells = by("design__instance__count");
  if (cells) out.push({ label: "Cells placed", value: String(cells.value), unit: "fill and tap included", key: cells.key });
  return out;
}
