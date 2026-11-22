// addfiles.js — "Add files…" (Setup's Sources card and the RTL IDE's upload):
// copy files from the computer into the project. Verilog goes to src/,
// testbenches to verify/, anything else to the top of the project.
//
// A project file of the same name is never replaced silently: the server
// refuses (409 {exists, suggested}) and the person picks Replace, or Keep both
// (theirs is saved next to it as name_2.v).

import { api, fmt } from "./api.js";

// Where a file from the computer goes in the project.
export function targetRel(name) {
  const isTb = /(^tb_|_tb\.|testbench)/i.test(name);
  const isHdl = /\.(s?v|vh|svh)$/i.test(name);
  return (isHdl ? (isTb ? "verify/" : "src/") : "") + name;
}

// The dialog's words for the files that already exist.
export function existsText(conflicts) {
  const n = conflicts.length;
  const title = n === 1 ? conflicts[0].rel.split("/").pop() + " is already in the project" : n + " files are already in the project";
  const first = conflicts[0];
  const hdl = conflicts.some((c) => /^src\/.*\.s?v$/i.test(c.rel));
  const body = (n === 1 ? "The project already has " + first.rel + "." : "The project already has " + conflicts.map((c) => c.rel).join(", ") + ".") +
    " Replace overwrites " + (n === 1 ? "it" : "them") + " with yours. Keep both adds yours next to " + (n === 1 ? "it" : "each") +
    " as " + (first.suggested ? first.suggested.split("/").pop() : "a numbered copy") + (n > 1 ? " and so on" : "") + "." +
    (hdl ? " A config that builds every .v in src/ then builds both copies, and modules of the same name clash." : "");
  return { title, body };
}

// files: File objects (an <input type=file>'s). report(msg, bad): how to tell
// the person about a file that couldn't be added.
// -> { added: [rel], replaced: [rel], copies: [rel], skipped: [rel],
//      forConfig: [rel] (new or replaced, never a kept copy) }
export async function addProjectFiles(files, { report = () => {} } = {}) {
  const out = { added: [], replaced: [], copies: [], skipped: [], forConfig: [] };
  const conflicts = [];
  for (const f of files) {
    const rel = targetRel(f.name);
    let text;
    try { text = await f.text(); } catch (ex) { report("Could not read " + f.name + ": " + (ex.message || ex), true); continue; }
    try {
      const r = await api.fileWrite(rel, text, { on_exists: "error" });
      if (r && r.ok === false) { report("Could not add " + f.name + ": " + (r.error || "refused"), true); continue; }
      out.added.push(rel);
      out.forConfig.push(rel);
    } catch (ex) {
      const b = ex && ex.status === 409 && ex.body;
      if (b && b.exists) conflicts.push({ rel, text, suggested: b.suggested || null });
      else report("Could not add " + f.name + ": " + (ex.message || ex), true);
    }
  }
  if (!conflicts.length) return out;
  const { title, body } = existsText(conflicts);
  const { customDialog } = await import("./dialog.js");
  const choice = await customDialog({
    title,
    bodyHtml: "<p>" + fmt.escape(body) + "</p>",
    buttons: [
      { label: "Cancel", value: null, cls: "btn-ghost" },
      { label: "Keep both", value: "keep_both", cls: "btn-ghost" },
      // Overwrites the project's file: a danger button, so Cancel has the focus.
      { label: "Replace", value: "replace", cls: "btn-warn" },
    ],
  });
  for (const c of conflicts) {
    if (choice !== "replace" && choice !== "keep_both") { out.skipped.push(c.rel); continue; }
    try {
      const r = await api.fileWrite(c.rel, c.text, { on_exists: choice });
      const rel = (r && r.path) || c.rel;
      out.added.push(rel);
      if (choice === "replace") { out.replaced.push(rel); out.forConfig.push(rel); }
      else out.copies.push(rel);
    } catch (ex) {
      report("Could not add " + c.rel.split("/").pop() + ": " + (ex.message || ex), true);
    }
  }
  if (out.skipped.length) report("Not added (already in the project): " + out.skipped.join(", "), false);
  return out;
}
