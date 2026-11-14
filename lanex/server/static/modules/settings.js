// settings.js — the Settings page: every preference in one place.
//
// The page is drawn from the registry (prefs.js). Each control writes the
// same key the owning module reads, then tells that module (a few of them
// keep a control of their own in the Run menu or the Code toolbar, so both
// stay in step).

import { fmt } from "./api.js";
import { safeStorage } from "./state.js";
import { PREFS, getPref, setPref, resetPrefs } from "./prefs.js";
import { setTheme, themeChoice } from "./theme.js";
import { currentZoom, isAutoZoom, setZoom, resetZoom, zoomBy } from "./zoom.js";
import { SHORTCUTS, IDE_SHORTCUTS } from "./hotkeys.js";
import { toast } from "./toast.js";

const esc = (s) => fmt.escape(s == null ? "" : String(s));
const GROUPS = ["Appearance", "Runs", "Editor", "Keyboard"];

// What changing a preference does beyond storing it.
const APPLY = {
  theme: (v) => setTheme(v),
  density: (v) => document.body.classList.toggle("density-compact", v === "compact"),
  engine: async (v) => (await import("./runmode.js")).setRunMode(v),
  notify: async (v) => {
    const r = await (await import("./runend.js")).enableNotifications(v === "1");
    if (!r.ok) { setPref("notify", "0"); toast.show(r.why, "warn"); }
  },
  showFlow: () => syncMirror("run-pref-show", getPref("showFlow") === "1"),
  chime: () => syncMirror("run-pref-chime", getPref("chime") === "1"),
  lintOnSave: () => syncMirror("ide-autolint", getPref("lintOnSave") === "1"),
};

function syncMirror(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = on;
}

function rowHtml(p) {
  const v = getPref(p.id);
  let control = "";
  if (p.type === "bool") {
    control = "<button class='switch' role='switch' id='st-" + p.id + "' data-pref='" + p.id + "' aria-checked='" + (v === p.on) + "' aria-labelledby='st-l-" + p.id + "'></button>";
  } else if (p.type === "choice") {
    control = "<div class='seg' role='group' aria-labelledby='st-l-" + p.id + "'" + (p.id === "theme" ? " data-theme-seg" : "") + ">" +
      p.options.map(([val, label]) =>
        "<button data-pref='" + p.id + "' data-val='" + esc(val) + "'" + (p.id === "theme" ? " data-theme='" + esc(val) + "'" : "") +
        " aria-pressed='" + (v === val) + "'>" + esc(label) + "</button>").join("") + "</div>";
  } else if (p.id === "zoom") {
    control = "<span class='st-zoom'><button class='btn btn-sm' data-zoom='auto' aria-pressed='" + isAutoZoom() + "'>Automatic</button>" +
      "<button class='btn-icon btn-sm' data-zoom='-' aria-label='Smaller'>" + minus() + "</button>" +
      "<output id='st-zoom-pct' class='mono'>" + Math.round(currentZoom() * 100) + "%</output>" +
      "<button class='btn-icon btn-sm' data-zoom='+' aria-label='Larger'>" + plus() + "</button></span>";
  }
  return "<div class='st-row'><div class='st-row-l'><span class='st-row-t' id='st-l-" + p.id + "'>" + esc(p.label) + "</span>" +
    (p.hint ? "<span class='st-row-h'>" + esc(p.hint) + "</span>" : "") + "</div><div class='st-row-c'>" + control + "</div></div>";
}

const minus = () => "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' aria-hidden='true'><path d='M5 12h14'/></svg>";
const plus = () => "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' aria-hidden='true'><path d='M12 5v14M5 12h14'/></svg>";

function keysHtml() {
  const row = (k, d) => "<div class='keys-row'><span>" + k.split(" / ").map((x) => "<kbd>" + esc(x) + "</kbd>").join(" ") +
    "</span><span class='keys-desc'>" + esc(d) + "</span></div>";
  return "<details class='st-keys'><summary>Every shortcut</summary><div class='keys'>" +
    SHORTCUTS.map((s) => row(s.keys, s.desc)).join("") + "</div>" +
    "<h4>Code</h4><div class='keys'>" + IDE_SHORTCUTS.map((s) => row(s.keys, s.desc)).join("") + "</div></details>";
}

async function aboutHtml() {
  let about = null;
  try {
    const r = await fetch("/api/about", { headers: { "X-Requested-With": "XMLHttpRequest" } });
    about = r.ok ? await r.json() : null;
  } catch (_e) {}
  const ver = about && about.version, ll = about && about.librelane;
  return "<dl class='st-about'>" +
    (ver ? "<dt>LanEx</dt><dd>" + esc(ver) + "</dd>" : "") +
    (ll ? "<dt>LibreLane</dt><dd>" + esc(ll) + "</dd>" : "") +
    "<dt>Licence</dt><dd>Apache License 2.0, provided AS IS, without warranty</dd>" +
    "<dt>Built on</dt><dd>LibreLane, OpenROAD, Yosys, Magic, KLayout and Netgen, run as separate programs</dd>" +
    "<dt>Affiliation</dt><dd>Independent project, not affiliated with or endorsed by LibreLane</dd></dl>" +
    "<div class='note note-warn'><span><b>Not a sign-off tool.</b> Every number LanEx shows comes from the EDA tools. " +
    "Before you fabricate, check your design against your foundry's official sign-off decks.</span></div>" +
    "<div class='st-acts'><button class='btn btn-sm' data-st='notices'>Licence and notices</button>" +
    "<a class='btn btn-sm btn-quiet' href='https://librelane.org/' target='_blank' rel='noopener'>LibreLane docs</a>" +
    "<a class='btn btn-sm btn-quiet' href='https://github.com/AkshatIsWired/lanex' target='_blank' rel='noopener'>LanEx on GitHub</a></div>";
}

function group(title, body) {
  return "<section class='st-group'><h2>" + esc(title) + "</h2><div class='panel st-panel'>" + body + "</div></section>";
}

export async function renderSettings() {
  const host = document.getElementById("settings-body");
  if (!host) return;
  wireOnce(host);
  let html = "";
  for (const g of GROUPS) {
    const rows = PREFS.filter((p) => p.group === g).map(rowHtml).join("");
    html += group(g, rows + (g === "Keyboard" ? keysHtml() : ""));
  }
  html += group("Getting started",
    "<div class='st-row'><div class='st-row-l'><span class='st-row-t'>First-chip guide</span><span class='st-row-h'>Build the Blinky example step by step: simulate it, run the flow, see the layout.</span></div>" +
    "<div class='st-row-c'><button class='btn btn-sm' data-st='first-chip'>Start</button></div></div>" +
    "<div class='st-row'><div class='st-row-l'><span class='st-row-t'>Tour</span><span class='st-row-h'>Five stops: where everything is.</span></div>" +
    "<div class='st-row-c'><button class='btn btn-sm' data-st='tour'>Start</button></div></div>" +
    "<div class='st-row'><div class='st-row-l'><span class='st-row-t'>First-launch card</span><span class='st-row-h'>Show the welcome choice again the next time LanEx starts.</span></div>" +
    "<div class='st-row-c'><button class='btn btn-sm' data-st='reset-start'>Show again</button></div></div>");
  html += group("Data",
    "<div class='st-row'><div class='st-row-l'><span class='st-row-t'>Preferences</span><span class='st-row-h'>Back to the defaults: everything on this page, plus column choices, sort orders and panel sizes. Projects and runs are not touched.</span></div>" +
    "<div class='st-row-c'><button class='btn btn-sm' data-st='reset'>Reset…</button></div></div>" +
    "<div class='st-row'><div class='st-row-l'><span class='st-row-t'>Recent projects</span><span class='st-row-h'>Clear the list in this window. The folders stay where they are.</span></div>" +
    "<div class='st-row-c'><button class='btn btn-sm' data-st='clear-recent'>Clear</button></div></div>");
  html += group("About", "<div class='st-about-host' id='st-about'><span class='muted'>Loading…</span></div>");
  host.innerHTML = html;
  aboutHtml().then((h) => { const el = document.getElementById("st-about"); if (el) el.innerHTML = h; });
}

function repaintZoom(host) {
  const o = host.querySelector("#st-zoom-pct");
  if (o) o.textContent = Math.round(currentZoom() * 100) + "%";
  host.querySelector("[data-zoom='auto']")?.setAttribute("aria-pressed", isAutoZoom() ? "true" : "false");
}

function wireOnce(host) {
  if (host._wired) return;
  host._wired = true;
  host.addEventListener("click", async (e) => {
    const sw = e.target.closest(".switch[data-pref]");
    if (sw) {
      const p = PREFS.find((x) => x.id === sw.dataset.pref);
      const on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", on ? "true" : "false");
      setPref(p.id, on ? p.on : p.off);
      if (APPLY[p.id]) await APPLY[p.id](on ? p.on : p.off);
      if (p.id === "notify") sw.setAttribute("aria-checked", getPref("notify") === "1" ? "true" : "false");
      return;
    }
    const ch = e.target.closest("[data-pref][data-val]");
    if (ch) {
      const id = ch.dataset.pref, val = ch.dataset.val;
      setPref(id, val);
      ch.parentElement.querySelectorAll("[data-pref]").forEach((b) => b.setAttribute("aria-pressed", b === ch ? "true" : "false"));
      if (APPLY[id]) await APPLY[id](val);
      return;
    }
    const z = e.target.closest("[data-zoom]");
    if (z) {
      if (z.dataset.zoom === "auto") resetZoom(); else zoomBy(z.dataset.zoom === "+" ? 1 : -1);
      repaintZoom(host);
      return;
    }
    const a = e.target.closest("[data-st]");
    if (!a) return;
    const act = a.dataset.st;
    if (act === "first-chip" || act === "tour") document.dispatchEvent(new CustomEvent("g:guide", { detail: { action: act } }));
    else if (act === "reset-start") document.dispatchEvent(new CustomEvent("g:guide", { detail: { action: "reset" } }));
    else if (act === "notices") (await import("./shell.js")).openHelp("about");
    else if (act === "clear-recent") { safeStorage.remove("ll.recentDesigns"); toast.show("Recent projects cleared in this window.", "success"); document.dispatchEvent(new CustomEvent("g:projects_changed")); }
    else if (act === "reset") {
      const { confirmDialog } = await import("./dialog.js");
      const ok = await confirmDialog({ title: "Reset every preference?",
        body: "Theme, size, run preferences, column choices and panel sizes go back to their defaults. Projects, runs and files are not touched.",
        confirmText: "Reset", danger: true });
      if (!ok) return;
      resetPrefs();
      setTheme(themeChoice());
      resetZoom();
      document.body.classList.remove("density-compact");
      (await import("./runmode.js")).setRunMode("container");
      renderSettings();
      toast.show("Preferences are back to their defaults.", "success");
    }
  });
  window.addEventListener("g:zoom", () => repaintZoom(host));
}
