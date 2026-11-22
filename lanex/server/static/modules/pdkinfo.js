// pdkinfo.js — what a PDK is, in one line, and its layer stack for the Setup
// hero. Facts come from the open PDKs' own documentation; the stack shows layer
// order and count, not to scale.
//
// Layer names are the PDK's own, exactly as its technology LEF spells them:
// LibreLane variables such as RT_MAX_LAYER take them as written, and the case
// matters (sky130 met4, gf180mcu Metal4, IHP Metal4 and TopMetal1; "metal4"
// is no layer at all, audit G17). Checked against the tech LEFs of sky130A,
// gf180mcuA-D (gf180mcu_fd_sc_mcu7t5v0) and ihp-sg13g2 (sg13g2_tech.lef). The
// Setup card asks the server for the installed PDK's own list
// (/api/pdk-layers) and uses this table only when that is not available.

const FAMILIES = [
  {
    match: /^sky130/,
    about: (n) => "SkyWater 130 nm" + (n === "sky130B" ? ", with the ReRAM option" : "") +
      ". Polysilicon, a local interconnect layer (li1) and five metal layers.",
    stack: ["poly", "li1", "met1", "met2", "met3", "met4", "met5"],
    node: "130 nm",
  },
  {
    match: /^gf180mcu/,
    about: (n) => {
      const m = { gf180mcuA: 3, gf180mcuB: 4, gf180mcuC: 5, gf180mcuD: 5 }[n] || 5;
      return "GlobalFoundries 180 nm MCU, " + m + " metal layers" +
        (n === "gf180mcuD" ? " with a thicker top metal" : "") + ".";
    },
    stack: (n) => {
      const m = { gf180mcuA: 3, gf180mcuB: 4, gf180mcuC: 5, gf180mcuD: 5 }[n] || 5;
      return ["Poly2"].concat(Array.from({ length: m }, (_, i) => "Metal" + (i + 1)));
    },
    node: "180 nm",
  },
  {
    match: /^ihp-sg13g2/,
    about: () => "IHP 130 nm SiGe BiCMOS. Five thin metal layers and two thick top metals.",
    stack: ["GatPoly", "Metal1", "Metal2", "Metal3", "Metal4", "Metal5", "TopMetal1", "TopMetal2"],
    node: "130 nm",
  },
];

// Layer colour by name: poly, local interconnect, then metal N in the metN hue
// (top metals share the highest metal colours).
function hue(layer) {
  if (/poly/i.test(layer)) return "--poly";
  if (layer === "li1") return "--li";
  if (/^topmetal/i.test(layer)) return layer.endsWith("2") ? "--met5" : "--met4";
  const n = parseInt(layer.replace(/\D+/g, ""), 10);
  return "--met" + Math.min(Math.max(n || 1, 1), 5);
}

// The routing layers RT_MAX_LAYER / RT_MIN_LAYER may name, bottom up, from
// this table (sky130's li1 is a routing layer in its LEF but not one a design
// limits routing to, so it is left out).
export const isMetal = (l) => /^(met\d|metal\d|topmetal\d)$/i.test(String(l || ""));

export function routingLayers(name) {
  return (pdkFacts(name).stack || []).filter(isMetal);
}

// A value a config sets that names a layer only in another case ("metal4"
// for Metal4): the exact name, or "" when it is no such near miss.
export function layerCaseFix(value, layers) {
  const v = String(value || "");
  if (!v || (layers || []).includes(v)) return "";
  return (layers || []).find((l) => l.toLowerCase() === v.toLowerCase()) || "";
}

export function pdkFacts(name) {
  const fam = FAMILIES.find((f) => f.match.test(name || ""));
  if (!fam) return { about: "", stack: [], node: "" };
  const stack = typeof fam.stack === "function" ? fam.stack(name) : fam.stack;
  return { about: fam.about(name), stack, node: fam.node };
}

// The Setup hero's layer stack: one glowing bar per layer, top metal first,
// each a little narrower going down, then the substrate line.
export function stackHtml(name) {
  const { stack, node } = pdkFacts(name);
  if (!stack.length) return "";
  const n = stack.length;
  const rows = stack.slice().reverse().map((layer, i) => {
    const w = n > 1 ? Math.round(90 - (i * 54) / (n - 1)) : 90;
    return "<div class='ls-layer' style='--lc:var(" + hue(layer) + ");--lsw:" + w + "%' title='" + layer +
      "'><span class='ls-bar'></span><span class='ls-tag'>" + layer + "</span></div>";
  });
  return rows.join("") + "<div class='ls-sub'>substrate · " + node + "</div>";
}
