// results.js — the Results page: how the run in view came out.
//
// One page for what Analytics and Verify used to show twice. Its views are
// tabs in the page header (views.js): Summary, Timing, Checks, Area and power,
// Routing, Trends, Metrics, Reports, and Compare. analytics.js and verify.js
// still draw their own sections; this module owns the page around them.

import { setupViews, showView, viewOf } from "./views.js";
import { wireMenu } from "./overlay.js";

let _wired = false;
let _an = null, _vf = null;

function wire() {
  _wired = true;
  setupViews("results", { first: "summary", onShow });
  wireMenu(document.getElementById("rs-more-btn"), document.getElementById("rs-more"));
  // Reload reads the run again for the whole page.
  document.getElementById("btn-refresh-analytics")?.addEventListener("click", () => { if (_vf) _vf.renderVerify(); });
}

// A view that just showed: charts are drawn at their box's real width, and a
// hidden box has none.
function onShow(view) {
  requestAnimationFrame(() => {
    if (_an && _an.redrawCharts) _an.redrawCharts();
    window.dispatchEvent(new Event("resize"));
  });
  if (view === "compare") import("./compare.js").then((c) => c.renderCompare()).catch(() => {});
}

export async function renderResults() {
  if (!_wired) wire();
  [_an, _vf] = await Promise.all([import("./analytics.js"), import("./verify.js")]);
  _vf.renderVerify();
  _an.renderAnalyticsFull();
  if (viewOf("results") === "compare") import("./compare.js").then((c) => c.renderCompare());
  import("./watch.js").then((w) => w.renderWatch());
}

// Open Results on the comparison of the runs picked on Runs.
export function showCompare() {
  showView("results", "compare");
  import("./compare.js").then((c) => c.renderCompare()).catch(() => {});
}
