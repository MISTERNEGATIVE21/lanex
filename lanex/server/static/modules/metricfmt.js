// metricfmt.js — one way to show a LibreLane metric, used by Runs, Compare,
// the sweep views and Analytics, so the same number reads the same
// everywhere: power with an SI prefix (never raw W, never a fixed mW that
// turns a few µW into 0.000), utilisation as a percentage (never the 0–1
// fraction), slack signed in ns, areas in µm². Pure (no DOM): node tests
// import it.
//
// LibreLane names metrics METRICS2.1-style: `category__name__stat` plus
// optional `__modifier:value` parts (`__corner:max_ss_100C_1v60`,
// `__net:VPWR`, `__class:fill_cell`, `__iter:3`). LanEx only converts units
// (W -> mW, V -> mV, ratio -> %) and never derives a new silicon number.

import { localeNum } from "./intlcache.js";

// ---------- key anatomy ----------------------------------------------------

// "timing__setup__ws__corner:max_ss_100C_1v60" ->
//   { base: "timing__setup__ws", mods: { corner: "max_ss_100C_1v60" } }
// Most modifiers are their own `__name:value` part. A few are glued onto the
// stat itself (`flow__warnings__count:DRT-0349`, `design__rows:unithd`): the
// stat stays in the base name and the value becomes `mods.code`.
const MOD_NAMES = ["corner", "net", "class", "iter"];
export function parseKey(key) {
  const parts = String(key).split("__");
  const base = [];
  const mods = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i > 0) {
      const name = p.slice(0, i);
      const val = p.slice(i + 1);
      if (MOD_NAMES.includes(name)) {
        mods[name] = val;
      } else {
        base.push(name);
        mods.code = val;
      }
    } else {
      base.push(p);
    }
  }
  return { base: base.join("__"), mods };
}

// ---------- numbers -----------------------------------------------------------

export function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// Non-finite values are real LibreLane output (e.g. reg-to-reg slack is +inf
// when a design has no register-to-register paths). Keep them distinct from
// "absent".
export function nonFinite(v) {
  return v === "Infinity" || v === "-Infinity" || v === "NaN" ||
    (typeof v === "number" && !Number.isFinite(v));
}

const US = "en-US";

// Fixed decimals, grouped, trailing zeros trimmed only when `trim`.
function fixed(n, d, trim) {
  let s = localeNum(n, US, { minimumFractionDigits: trim ? 0 : d, maximumFractionDigits: d });
  if (s === "-0") s = "0";
  return s.replace(/^-/, "−");
}

// Integer-aware general formatting: 1226 -> "1,226", 64 -> "64",
// 7214.42 -> "7,214.42", 0.0445963 -> "0.0446".
export function num(v, { digits } = {}) {
  if (v === null || v === undefined || v === "") return "—";
  if (nonFinite(v)) return v === "-Infinity" || v === -Infinity ? "−∞" : (v === "NaN" || Number.isNaN(v) ? "NaN" : "∞");
  if (typeof v !== "number") return String(v);
  // OpenSTA writes 1e30 for "no constrained path"; never spell that out.
  if (Math.abs(v) >= 1e12) return v.toExponential(2).replace(/^-/, "−");
  if (Number.isInteger(v)) return fixed(v, 0, true);
  if (digits !== undefined) return fixed(v, digits, false);
  const a = Math.abs(v);
  if (a >= 100) return fixed(v, 2, true);
  if (a >= 1) return fixed(v, 3, true);
  if (a >= 0.001) return fixed(v, 4, true);
  return v.toExponential(2).replace(/^-/, "−");
}

// The SI prefixes used for W and V, largest first.
const STEPS = [[1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
function stepFor(a) {
  if (a === 0) return [1e-3, "m"];
  for (const s of STEPS) if (a >= s[0]) return s;
  return STEPS[STEPS.length - 1];
}
const digitsFor = (ax) => (ax >= 100 ? 1 : ax >= 10 ? 2 : 3);

// Pick an SI prefix for a quantity given in base units (W, V). Returns
// { text, unit } — e.g. power 0.0014772 W -> { "1.477", "mW" }.
export function si(v, unit) {
  if (!isNum(v)) return { text: num(v), unit };
  const [scale, pre] = stepFor(Math.abs(v));
  const x = v / scale;
  return { text: fixed(x, digitsFor(Math.abs(x)), false), unit: pre + unit };
}

// ---------- units per metric ------------------------------------------------------

// The unit each LibreLane metric is reported in (by its base name). LibreLane
// writes STA times in ns, power in W, IR drop/voltages in V, areas in µm²,
// lengths in µm; utilisation is a 0–1 ratio.
export function unitOf(base) {
  if (/^timing__.*__(ws|wns|tns)$/.test(base) || /^clock__skew/.test(base)) return "ns";
  if (/^power__/.test(base)) return "W";
  if (/(drop|voltage)/.test(base) && /^(ir__|design_powergrid__)/.test(base)) return "V";
  if (/__utilization/.test(base)) return "ratio";
  if (/__area/.test(base)) return "µm²";
  if (/wirelength/.test(base) || /__displacement__/.test(base) || /__hpwl$/.test(base)) return "µm";
  if (/__bbox$/.test(base)) return "µm";
  return "";
}

// One value formatted for display in its natural unit.
// -> { text, unit, title } (title = the exact raw value for hover).
// `compact` (tables): areas and lengths of 100 or more as whole numbers.
// It never changes the unit.
export function show(key, v, { compact = false } = {}) {
  const { base } = parseKey(key);
  const u = unitOf(base);
  const title = v === null || v === undefined ? "" : String(v);
  if (!isNum(v)) {
    if (u === "µm" && typeof v === "string" && /__bbox$/.test(base)) return { text: v, unit: u, title };
    return { text: num(v), unit: nonFinite(v) && u !== "ratio" ? u : "", title };
  }
  if (u === "W") { const r = si(v, "W"); return { text: r.text, unit: r.unit, title: title + " W" }; }
  if (u === "V") {
    // Drops and ground bounce are millivolt-scale; supply voltages read better
    // in V. `design_powergrid__drop__average` holds OpenROAD's *average
    // voltage* (1.79997 on VPWR, see its IR report), so it is shown as a
    // voltage, never converted as if it were a drop.
    const isDrop = /drop/.test(base) && base !== "design_powergrid__drop__average";
    if (isDrop || Math.abs(v) < 0.1) return { text: sig(v * 1000, 4), unit: "mV", title: title + " V" };
    return { text: sig(v, 6), unit: "V", title: title + " V" };
  }
  if (u === "ratio") return { text: fixed(v * 100, 1, false), unit: "%", title: title + " (ratio)" };
  if (u === "ns") return { text: signed(v, compact ? 2 : 3), unit: "ns", title: title + " ns" };
  if (compact && (u === "µm²" || u === "µm") && Math.abs(v) >= 100 && Math.abs(v) < 1e12) {
    return { text: fixed(Math.round(v), 0, true), unit: u, title: title + " " + u };
  }
  return { text: num(v), unit: u, title: u ? title + " " + u : title };
}

// "1.477 mW": the value and its unit in one string.
export function showText(key, v, opts) {
  const s = show(key, v, opts);
  return s.unit && s.text !== "—" ? s.text + " " + s.unit : s.text;
}

// One prefix for a column or row of power values (a table reads down one
// unit, not mW in one row and µW in the next): the prefix of the largest
// value. `null` for metrics whose unit has no prefix to choose.
export function scaleOf(key, values) {
  const u = unitOf(parseKey(key).base);
  if (u !== "W") return null;
  const a = Math.max(0, ...values.filter(isNum).map(Math.abs));
  const [div, pre] = stepFor(a);
  return { div, unit: pre + u };
}

// A value at a scale from scaleOf (or as show() would, without one).
export function showAt(key, v, scale, opts) {
  if (!scale || !isNum(v)) return show(key, v, opts);
  const x = v / scale.div;
  return { text: fixed(x, digitsFor(Math.abs(x)), false), unit: scale.unit, title: String(v) + " W" };
}

// Up to `n` significant digits, trailing zeros dropped, never exponential for
// the magnitudes LibreLane reports in V/mV.
function sig(v, n) {
  if (v === 0) return "0";
  const d = Math.max(0, n - 1 - Math.floor(Math.log10(Math.abs(v))));
  return fixed(Number(v.toFixed(Math.min(d, 12))), Math.min(d, 12), true);
}

// Slack-style signed number: +4.100 / −0.250 / 0.000.
export function signed(v, d = 3) {
  if (!isNum(v) || Math.abs(v) >= 1e12) return (isNum(v) && v > 0 ? "+" : "") + num(v);
  if (v === 0) return fixed(0, d, false);
  return (v > 0 ? "+" : "−") + fixed(Math.abs(v), d, false);
}
