// filesync.js — the IDE's open files against the files on disk. Pure (no DOM),
// so the frontend test runs it.
//
// Every tab carries the hash the server gave when it read the file (routes.py
// h_read_text, editor.text_hash). A save sends it back; when the file changed
// on disk since (Setup wrote the config, a terminal, another window), the
// server answers 409 and the IDE asks what to keep instead of overwriting.

// What to do with an open tab when the file on disk has `diskHash`:
//   "same"   nothing changed
//   "reload" the tab has no edits of its own: show the disk's text
//   "flag"   the tab has edits: keep them, and the next save asks
//   "gone"   the file isn't on disk any more (leave the tab as it is)
export function refreshAction(tab, diskHash) {
  if (!tab) return "same";
  if (diskHash === null || diskHash === undefined) return "gone";
  if (!tab.hash || diskHash === tab.hash) return "same";
  return tab.text === tab.saved ? "reload" : "flag";
}

// A 409 from /api/file/write: which kind it is.
export function conflictKind(err) {
  const b = err && err.status === 409 && err.body;
  if (!b) return null;
  if (b.conflict) return "changed";
  if (b.exists) return "exists";
  return null;
}

// The lines that differ between `a` (on disk) and `b` (in the editor), as
// [{op: "-"|"+", line, text}] (line numbers in a for "-", in b for "+"),
// the shape configedit.diff_lines gives the fix sheet. The common start and
// end are skipped first; the middle is compared line by line when it is small
// enough (an LCS table), else it shows as one replaced block. null when the
// texts are the same.
export function lineDiff(a, b, maxCells = 4e6) {
  const A = String(a || "").replace(/\r\n?/g, "\n").split("\n");
  const B = String(b || "").replace(/\r\n?/g, "\n").split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e);
  if (!a2.length && !b2.length) return null;
  const out = [];
  if (a2.length * b2.length > maxCells) {
    a2.forEach((t, i) => out.push({ op: "-", line: s + i + 1, text: t }));
    b2.forEach((t, j) => out.push({ op: "+", line: s + j + 1, text: t }));
    return out;
  }
  const n = a2.length, m = b2.length;
  // L[i][j]: the longest common run of a2[i..] and b2[j..].
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { i++; j++; continue; }
    if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { out.push({ op: "-", line: s + i + 1, text: a2[i] }); i++; }
    else { out.push({ op: "+", line: s + j + 1, text: b2[j] }); j++; }
  }
  return out;
}

// Is this project file the flow's config (the file Setup writes)?
export function isConfigFile(rel) {
  return /^config\.(json|ya?ml|tcl)$/i.test(String(rel || ""));
}
