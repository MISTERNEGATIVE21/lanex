// views.js — a page's views: the tabs in its header and the panels they show.
//
// A page with views is one screen per view, never one long scroll with anchors.
//   <header class="page-h"> <div class="tabs" data-views="results"> <button class="tab" data-view="timing">…
//   <div data-view-panel="timing"> …            (a panel may list several: "timing checks")
//
//   setupViews("results", { first: "summary", onShow })
//   showView("results", "checks")               returns true if the view exists
//   viewOf("results")                           the view on screen
//   revealIn("vf-drc")                          shows the view an element lives in
//
// Keyboard: the tabs follow the WAI-ARIA tabs pattern (arrows, Home, End).
// The view on screen is remembered per page for the session.

const _pages = new Map();   // page -> { tabs, panels, cur, onShow }

const KEY = (page) => "ll.view." + page;

function panelsOf(sec) {
  return Array.from(sec.querySelectorAll("[data-view-panel]"));
}

export function setupViews(page, { first = "", onShow = null } = {}) {
  if (_pages.has(page)) return _pages.get(page);
  const sec = document.getElementById("sec-" + page);
  const bar = sec && sec.querySelector('[data-views="' + page + '"]');
  if (!sec || !bar) return null;
  const tabs = Array.from(bar.querySelectorAll("[data-view]"));
  bar.setAttribute("role", "tablist");
  const P = { sec, bar, tabs, cur: "", onShow };
  _pages.set(page, P);
  tabs.forEach((t) => {
    t.setAttribute("role", "tab");
    t.addEventListener("click", () => showView(page, t.dataset.view));
    t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      else return;
      e.preventDefault();
      showView(page, tabs[j].dataset.view);
      tabs[j].focus();
    });
  });
  let start = first || (tabs[0] && tabs[0].dataset.view) || "";
  try { const s = sessionStorage.getItem(KEY(page)); if (s && tabs.some((t) => t.dataset.view === s)) start = s; } catch (_e) {}
  showView(page, start, { quiet: true });
  return P;
}

export function viewOf(page) {
  const P = _pages.get(page);
  return P ? P.cur : "";
}

export function showView(page, view, { quiet = false } = {}) {
  const P = _pages.get(page);
  if (!P || !P.tabs.some((t) => t.dataset.view === view)) return false;
  const changed = P.cur !== view;
  P.cur = view;
  P.tabs.forEach((t) => {
    const on = t.dataset.view === view;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.setAttribute("tabindex", on ? "0" : "-1");
  });
  for (const p of panelsOf(P.sec)) p.hidden = !p.dataset.viewPanel.split(/\s+/).includes(view);
  P.sec.dataset.view = view;
  try { sessionStorage.setItem(KEY(page), view); } catch (_e) {}
  if (changed) {
    const w = document.querySelector("main.work");
    if (w && P.sec.classList.contains("section-active")) w.scrollTop = 0;
    if (P.onShow && !quiet) P.onShow(view);
    document.dispatchEvent(new CustomEvent("g:view", { detail: { page, view } }));
  }
  return true;
}

// Show the view that holds an element (a link to a section, a check, a card).
// A panel that serves several views shows on the first it names.
export function revealIn(id) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  const panel = el && el.closest("[data-view-panel]");
  const sec = el && el.closest(".section");
  if (!panel || !sec) return false;
  const page = sec.id.replace(/^sec-/, "");
  const views = panel.dataset.viewPanel.split(/\s+/);
  if (views.includes(viewOf(page))) return true;
  return showView(page, views[0]);
}
