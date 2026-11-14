// verdict.js — the one vocabulary for how a run or a check came out, and the
// one way it is drawn: a dot and a word (ui.css .verdict).
//
// The state is the server's (verdict.state on /api/runs, the same judgement
// Results shows); this module only says it. No page writes its own word.
//
//   run:    Clean · Warnings · Failed · Stopped · Running · Incomplete
//   check:  Passed · Warning · Failed · Info · Off

const RUN = {
  passed:     { cls: "pass", word: "Clean" },
  warning:    { cls: "warn", word: "Warnings" },
  failed:     { cls: "fail", word: "Failed" },
  stopped:    { cls: "warn", word: "Stopped" },
  incomplete: { cls: "warn", word: "Incomplete" },
  running:    { cls: "run",  word: "Running" },
};

const CHECK = {
  pass:    { cls: "pass", word: "Passed" },
  warn:    { cls: "warn", word: "Warning" },
  fail:    { cls: "fail", word: "Failed" },
  info:    { cls: "none", word: "Info" },
  skipped: { cls: "none", word: "Off" },
  absent:  { cls: "none", word: "Not run" },
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// { state, cls, word } for a verdict state ("passed", "failed", …).
export function runVerdict(st) {
  const v = RUN[st];
  if (v) return { state: st, ...v };
  // A state this build does not know: amber, never a guessed pass or fail.
  return { state: st || "incomplete", cls: "warn", word: st ? st[0].toUpperCase() + st.slice(1) : "Incomplete" };
}

// The verdict of a run row from /api/runs. `live` marks the run going now.
export function verdictOfRun(r, { live = false } = {}) {
  if (live) return runVerdict("running");
  const st = r && r.verdict && r.verdict.state;
  if (st) return runVerdict(st);
  return runVerdict(r && r.success ? "passed" : "failed");
}

export function checkVerdict(status) {
  const v = CHECK[status] || CHECK.absent;
  return { state: status, ...v };
}

// <span class="verdict is-pass">Clean</span>
export function verdictHtml(v, { word = "" } = {}) {
  return "<span class='verdict is-" + v.cls + "'>" + esc(word || v.word) + "</span>";
}

// Only the dot, for a table cell or a list where the word sits beside it.
export function dotHtml(v) {
  return "<span class='vdot is-" + v.cls + "' aria-hidden='true'></span>";
}

export const RUN_STATES = Object.keys(RUN);
