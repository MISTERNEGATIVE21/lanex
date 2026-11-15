// theme.js — Dark, Light or System.
//
// Dark is the default (the LanEx look). System follows the OS's
// prefers-color-scheme and changes with it. The choice is one preference
// (ll.theme); index.html applies it before the first paint, so the page never
// flashes the other theme.

const KEY = "ll.theme";
export const THEMES = ["dark", "light", "system"];

export function themeChoice() {
  try {
    const s = localStorage.getItem(KEY);
    return THEMES.includes(s) ? s : "dark";
  } catch (_e) { return "dark"; }
}

function systemIsLight() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches); } catch (_e) { return false; }
}

// "dark" or "light": what the choice comes to on this machine right now.
export function resolvedTheme(choice = themeChoice()) {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return systemIsLight() ? "light" : "dark";
}

function apply() {
  const t = resolvedTheme();
  const was = document.body.classList.contains("theme-light") ? "light" : "dark";
  document.body.classList.toggle("theme-dark", t === "dark");
  document.body.classList.toggle("theme-light", t === "light");
  document.documentElement.dataset.theme = t;
  paintControls();
  // Charts read their colours from the tokens (theme-echarts.js): tell them.
  if (was !== t) document.dispatchEvent(new CustomEvent("g:theme_changed", { detail: { dark: t === "dark" } }));
}

function paintControls() {
  const c = themeChoice();
  document.querySelectorAll("[data-theme]").forEach((b) => {
    if (b.closest("#theme-seg, [data-theme-seg]")) b.setAttribute("aria-pressed", b.dataset.theme === c ? "true" : "false");
  });
}

export function setTheme(choice) {
  const c = THEMES.includes(choice) ? choice : "dark";
  try { localStorage.setItem(KEY, c); } catch (_e) {}
  apply();
}

// The `t` key: dark and light, whatever the system says.
export function toggleTheme() {
  setTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

export function setupTheme() {
  apply();
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (themeChoice() === "system") apply();
    });
  } catch (_e) {}
  // Any [data-theme] button inside a theme control sets the theme.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#theme-seg [data-theme], [data-theme-seg] [data-theme]");
    if (b) setTheme(b.dataset.theme);
  });
  // Another window changed it.
  window.addEventListener("storage", (e) => { if (!e || e.key === KEY) apply(); });
}
