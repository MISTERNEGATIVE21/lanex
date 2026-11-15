# LanEx UI redesign (2026-11-15)

Branch `claude/ui-redesign-2026-11-90b33b`, cut from `main` at b3664e0 (v1.0.0).
Nothing is pushed. Read with `docs/audit-2026-11-15.md` (sections 4.7, 6 and 10).

**What this is.** The first plan was a full restyle on a new frame. It was built as
far as the frame and one page, shown to the owner, and rejected: the app looked
flatter and thinner than the one he likes. The scope then became:

- **The LanEx look stays**: sharper and more consistent, never a new style.
- **The Setup page is left alone** (hero, layer stack, step cards, layout).
- **Polished tabs get light fixes**: real defects only.
- **Weak or missing things get the full effort**: Runs, sweeps, Compare, a Settings
  page, one overlay behaviour.

Section 1 is the visual audit of the app before this work (still true for the tabs
that were left alone). Section 2 says what the LanEx look is and what counts as
clutter. Section 3 is what was built, page by page. Section 4 is the behaviour layer
(overlays, Settings, theme, verdict words). Section 5 is the handover for the
feature phases of the audit's plan. Section 6 is the harness.

The two rejected commits (`ddf09fd`, `6cd271b`) stay in the branch history for
reference; `37b1673` puts every static file back to `main`, and everything after it
is the work described here.

---

## 1. Visual audit of today's UI

### 1.1 How it was captured

Private servers on ports 8801 (a project with 13 runs, three sweeps, a failed run, a
stopped run) and 8802 (no project), each with its own `LANEX_HOME`. 77 scenes per
pass, six passes: 1366×768, 1920×1080 and 2560×1440, dark and light. Full-page
captures for the long pages. A script counted, for every scene, the controls, the
long text blocks, the headings and the primary-styled buttons visible in the window.
The harness is in section 10.

### 1.2 What every screen shares

The frame alone carries 24 controls before any page draws: the wordmark, the project
switcher, search, Run and its menu, Tools, Help, three zoom controls, theme, nine
rail tabs under four letter-spaced group labels, and a status line with PDK, Engine,
Mode, Console, Logs and the sign-off notice. A rainbow hairline runs under the top
bar and the rail's active tab has a glow, a spine and a square "via".

Then each page adds its own opening: an eyebrow, a heading, a two- or three-line
paragraph, and usually a verdict hero. The numbers below are what is visible at
1920×1080 without scrolling.

| Screen | Came to do | Page controls | Long text blocks | Primary buttons | Page height |
|---|---|---|---|---|---|
| Setup, project open | check the project, run | 29 | 3 | 2 | 2.4 screens |
| Setup, no project | start a project | 13 | 7 | 1 | 1.8 screens |
| Flow, clean run | see how the run went | 34 | 2 | 2 | 1 |
| Flow, failed run | find the cause, fix it | 58 | 2 | 2 | 1 |
| Runs | find a run, compare, sweep | 50 | 1 | 2 | 1 |
| Runs, a row open | read one run | 67 | 3 | 3 | 1.1 |
| Analytics | read the numbers | 33 | 4 | 1 | 6.6 screens |
| Verify | see what passed | 67 | 8 | 1 | 6.8 screens |
| Layout | look at the chip | 57 | 1 | 3 | 1.3 |
| Cells | look up a cell | 45 | 1 | 1 | 4.1 screens |
| Tools | check or install | 45 | 1 | 1 | 1.5 |
| RTL IDE | edit, lint, simulate | 31 | 1 | 3 | 1 |
| RTL IDE, waveform | read a waveform | 63 | 0 | 3 | 1 |

Setup with "All settings" open is 60 screens tall.

### 1.3 Per screen

**Setup.** The marketing hero ("Take Verilog all the way to silicon"), a layer-stack
illustration and four "done" step cards fill the first 580 px on every visit. The
open project starts below them, beside a second copy of the project list (the first
is the top-bar switcher). Sources, PDK, Common settings, Ready to run and All
settings follow as one scroll with six anchor tabs. The Run button the page exists
for is 1.5 screens down. With no project the three ways to start are below the fold
at 1366×768. Decoration: blueprint grid, corner brackets, glowing card edges, a
provenance magnifier beside each field label.

**Flow.** The best screen. A clean run still gets a 215 px verdict card (headline,
sentence, six stat tiles, three buttons, a warnings row) above the seven stage tiles,
so the steps and the log get the bottom half. Empty stage tiles carry the blueprint
grid and a ghost number. A failed run's card is right: cause, fix, Apply.

**Runs.** Eyebrow, heading and a three-line instruction, then a toolbar with a scope
toggle, search, five status chips, four origin chips and Columns, then fourteen
columns. Sweep rows hide their swept values. A run's detail opens inside the table as
a card that repeats Flow's verdict hero, then ten action buttons and a note field.
Selecting rows adds a second bar. The sweep summary has no table of value against
result.

**Analytics.** Nine anchor tabs over one 6.6-screen scroll. Opens with the same
"Clean" hero as Flow and Verify, then 17 check chips (a second copy of Verify), then
four stat cards each with two sparklines and a magnifier per row. Every section
starts with eyebrow + question heading + paragraph. Compare is a wall of chips for
every run of every design.

**Verify.** Seven anchor tabs over 6.8 screens. The same hero, with 23 decorative
green squares; four pillar cards; then every check as a two-line row in two columns
with a "Passed" pill and a "limit 0" caption each. Eight long text blocks in the
first screen. Timing paths, DRC, LVS, antenna and reports follow, each with its own
header block.

**Layout.** About 57 controls around the canvas: a run selector, a "3D view" button
and a second 2D/3D toggle, Open in KLayout (primary), Save image, Command, six stage
tiles with thumbnails, Play, "Other snapshot", four side tabs, three layer presets,
nine toolbar icons, a hint bar and a caption. Desktop viewers and Run files sit below
the canvas, so the page scrolls. The canvas gets about 55 % of the window.

**Cells.** Eyebrow, heading and paragraph; a library selector row; five stat tiles;
then a list with search, twelve category chips, two checkboxes and a sort, beside a
detail with six more tiles. Macros and Flow rules are further down the same scroll,
each with its own header block.

**Tools.** A "Ready to run" hero with 17 decorative green squares on a healthy
system, then sections whose cards mix four layouts (hero cards, family cards,
four-up cards, a folded table).

**RTL IDE.** Sound structure. An extra title bar ("RTL IDE" + path + Pop out) above
the editor's own bars; uppercase letter-spaced group labels in the tree; three
primary-styled buttons (Run in the top bar, Simulate, the testbench picker).

**Overlays.** Four implementations: `dialog.js` (focus trap, no accessible name),
shell menus and the help sheet (light dismiss, no trap), the wizard and the fix and
sweep sheets (their own), and the Tools install modal. Corner brackets on the
first-launch card. The Run menu is a 700 px column with ten explanations. Console and
Logs are two separate bottom drawers with two status-line buttons.

**Empty states.** Flow, Runs, Analytics, Verify and Layout each say "No runs yet"
or "Open a project first" with a primary "Go to Setup" button under a top bar whose
Run button is disabled; Cells and Tools show full content with no project.

**Three widths.** At 1366 the top bar is full and page headers eat a third of the
height. At 2560 the automatic 125 % zoom keeps text readable but most pages stretch
single cards across the full width. Light theme works but keeps dark islands in
Cells and Layout and loses the border contrast on cards.

### 1.4 The system underneath

From the stylesheets (17 files, 6,646 lines) and the markup:

- **Type:** 42 distinct font sizes in 825 declarations (12.5, 13, 12, 14, 11, 13.5 px
  lead); 18 letter-spacings; weights 400 to 700.
- **Radii:** 28 distinct values.
- **Spacing:** 26 distinct px values; 6, 8, 10, 4, 2, 12, 14, 5, 3 px in that order.
- **Breakpoints:** 41 distinct widths across media and container queries.
- **Colour:** 154 hard-coded colours in CSS, 76 more in JS; 73 box-shadows.
- **Z-index:** 21 values, some raw (10001, 9000, 900).
- **Buttons:** `.btn` with ghost, primary, warn, cta, sm, xs; plus `iconbtn`,
  `lx-tb`, `lx-chipbtn`, `rn-segb`, `seg-btn`, `chip-clickable`, `start-tile`,
  `linklike`, `step-act`, `menu-item`, `tl-menu-item`: twelve button families.
- **Cards:** `card`, `picker`, `an-card`, `tl-card`, `tl-tile`, `tl-fam`,
  `cl-tile`, `cl-card`, `rn-card`, `vf-pillar`, `hero`, `fl-hero`, `tl-verdict`.
- **Tabs and segments:** `section-jump`, `sheet-tab`, `ide-ptab`, `ide-view-seg`,
  `rn-seg`, `seg`, `lx-side-tabs`, `lx-seg`, `lx-mode`, `cn-tab`, `config-nav`,
  `fl-tab`, `rf-seg`: thirteen.
- **Menus:** `menu`, `lx-menu`, `tl-menu`, `ide-sim-menu`, `rn-cols`, `rb-pop`.
- **Status marks:** `pill-*`, `vf-mark`, `rb-mark`, `tag`, `chip`, `badge`, `rb-tag`,
  `ms-tag`, `tl-tag`.
- **Text:** 31 eyebrows, 25 lede paragraphs, 17 hints in the markup.

---

## 2. The look, and what counts as clutter

### 2.1 The LanEx look (kept, and used for everything new)

- Big, bold Barlow text: 15 px base, 14 px in tables and controls, heavy headings.
  Mono (JetBrains Mono) for names, numbers and labels.
- Near-black surfaces with a blue tint and blue borders (`--bg`, `--bg-2`,
  `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-strong`).
- Depth and glow: the rail's active tab (gradient, met1 spine, square via), the
  gradient Run button, cards with a gradient fill and a thin accent line on top
  (`.an-card`), `--accent-glow` on the things that are "on".
- Spaced mono caps labels (`.an-eyebrow`, rail group names, card names).
- Texture where it already is: the grid in the hero, the layer-colour hairline
  under the top bar, the layer stack.
- Status is a square via plus a word (`.rn-v`, `.rb-mark`), never colour alone.

New surfaces are built from the existing classes first (`an-head`, `an-eyebrow`,
`an-title`, `an-lede`, `an-card`, `btn`, `iconbtn`, `seg`, `rn-seg`, `sheet`,
`menu`) and add only what those do not cover.

### 2.2 Clutter is duplicated content, not style

What was removed or folded: the wall of run chips in Compare; the instruction
paragraph on Runs; the report card repeated inside every opened run; sweep rows that
did not line up with the table; metric columns that scrolled off the edge; filters
with nothing behind them; settings tables padded out with folder paths; a boxed
magnifier on every dialog row.

What was left on purpose: the verdict cards on Flow, Analytics and Verify (each tab
is polished and the owner did not want them touched); the two 3D controls on Layout
(the big one is the guide's target and the owner's showpiece).

---

## 3. What was built

### 3.1 Runs (`modules/runs.js`, `runs.css`)

- **One panel**: toolbar, table, footer. The toolbar is one row (scope, search,
  result, origin, PDK when there is more than one, Columns). A filter choice with
  no runs behind it is left out. The footer says how many runs and sweeps are
  shown and what green and red mean (or how to set a baseline).
- **The table** reads at the app's size: 14 px rows, 42 px tall, one-line mono
  caps heads with the unit in small type. The run in view carries the met1 spine
  the rail uses; an opened run is tinted.
- **Columns that fit** (`fitColumns`): when the default set is wider than the
  room, columns step aside in a fixed order (`DROP_ORDER`) until it fits. A column
  the person turned on in Columns is never dropped. Nothing scrolls off the edge
  by default at 1280, 1366, 1920 or 2560.
- **A sweep is a row that lines up**: a SWEEP tag and the setting with its range
  in the name cell; "3 runs · 1 failed" under Result; under each number the best
  of its clean runs (hover names the run); the failure reason under Checks; the
  total time under Runtime. Its points show the setting and value each one tried
  as a chip.
- **Opening a sweep** shows its summary under the row (`sweeps.js
  paintSweepSummary`): best for timing and best for area, each with "Use this
  configuration"; a tile for what failed and where; and the trend. One number
  swept: two small charts, setup slack and std-cell area against the swept value,
  best point green, failed points a red cross on the axis. Several settings swept:
  area against slack, one dot per run.
- **Opening a run** puts its details in a panel beside the table (`#rn-side`;
  440 px, 372 px under 1500 px, over the table under 1180 px). The table stays
  usable and the panel follows the row you click. It holds: how the run ended, in
  the words Flow and Verify use (`reportcard.js verdictOf`) with its warnings;
  its numbers with the change against the baseline; where it came from (a fix, a
  sweep point, an import) and what it changed against the baseline; the four
  pages it opens in; its actions; its note. Esc closes it.
- The column picker, the file list and the sweep sheet open through the overlay
  stack. The sweep sheet keeps its fields; it was restyled, not redesigned (the
  typed variable picker and guards belong to phase 3b).

Not done here, on purpose (they are behaviour, owned by the feature phases): a
queue of planned points, pause and resume, bulk actions past six, archive, tags,
saved views, export of the table, a heatmap and Pareto view.

### 3.2 Compare (`modules/compare.js`, the Compare block of `analytics.css`)

- The runs compared sit in one row of chips. The first is the **reference**; the
  star on any other chip makes it the reference. "Add a run" opens a searchable
  list (grouped by design when there are several), and stays open while you add.
  Opening the tab with nothing picked compares the run in view with its baseline.
- **Headline numbers** and **every metric** carry how far each value moved from
  the reference (`deltaOf`): a difference for slack and counts, a percentage for
  sizes and power, green or red by the metric's own direction from the server's
  `metric_meta`, no colour when the direction is not known.
- **Settings that differ** come first, with the cells that differ from the
  reference marked. Settings that are the same in every run, and folder and file
  paths (which differ between any two run folders), fold away under them.
- **Every metric** shows only the ones that differ until "All" is pressed, with
  a filter. A run that stopped early has no metrics: that is not counted as a
  difference in every one of them.
- Tests: `summaryCellHtml` and `buildCols` keep their contracts; `deltaOf` is
  covered.

### 3.3 Settings (`modules/settings.js`, `modules/prefs.js`, `settings.css`; new)

A page on the rail (System, key 0) drawn from one registry of preferences:
theme (Dark, Light, System), interface size, compact spacing; engine, show Flow
when a run starts, notify, chime; check syntax on save; single-key shortcuts on or
off (WCAG 2.1.4) with the full shortcut list; the guides; reset preferences and
clear recent projects; about, with the not-a-sign-off notice. Each control writes
the key the owning module already reads, so the Run menu and the IDE toolbar stay
in step. These are app preferences only; the design's configuration stays on Setup.

### 3.4 Light fixes on the other tabs

| Where | What changed |
|---|---|
| Top bar | Run picker: a run of today shows its time alone, so the line is not cut; the result word is the server's ("Clean"), the same as Runs. Project menu: the end of each path, the full path on hover. |
| Rail | Settings entry (key 0). |
| Flow | On a narrow steps pane the step name gets the room; full name on hover. |
| Layout | The fitted chip clears the floating toolbar and the scale bar on a short window. Its menus open through the overlay stack. |
| Cells | Family descriptions that are cut carry the full text on hover. |
| Dialogs | Section names are mono caps labels; the provenance magnifier is a quiet icon. |
| Projects dialog | One row per project, actions on the right. |
| Folder browser | File sizes read 85 B, 9.3 kB (they showed as 85.000 B); shortcut places are chips. |
| Auto-generate config | The same header, close button and labels as every dialog; footer on one line. |

Setup, Analytics, Verify, Tools and the RTL IDE were checked at four widths in dark
and light and left as they are.

### 3.5 Checked

- No sideways overflow on any tab at 1280, 1366, 1920 and 2560 (auto zoom 125 %),
  and the rail does not scroll at 1280 × 720 with its tenth entry.
- Dark and light: every surface captured at 1920 dark and 1366 light; the new
  pages use the existing tokens only, so there are no dark islands.
- Cut text: a script lists every clipped text element per tab; what is left is
  clipped with the full text on hover (step names, PDK descriptions, cell
  families).
- Tests: `frontend_test.mjs` 143 checks (139 before, 4 added: deltas, the overlay
  stack, verdict words, the preference registry); pytest at the baseline (1384
  passed, the 5 known local failures).

---

## 4. The behaviour layer

### 4.1 One overlay behaviour (`modules/overlay.js`)

One stack for everything that opens over the page.

- Layers stack. Esc closes only the top one.
- A press outside closes a menu, a popover or a side sheet; a sheet that holds
  typed work (the fix sheet) opts out. A dialog closes by its buttons, Esc, or a
  press on its scrim.
- A modal layer (every dialog) takes focus when it opens and keeps Tab inside;
  closing puts focus back on what opened it.
- One menu at a time. A menu owns nothing: closing it does not close the sheet
  or dialog its item opened.
- Menus get arrow keys, Home, End and type-ahead.

On the stack: the project and Run menus, the help sheet, the run picker, the
Layout menus, the command palette, every `dialog.js` dialog, the folder browser,
the new-project wizard, the fix sheet, the sweep sheet, the Runs column picker and
file list, Compare's run list, the auto-config dialog, the logs drawer. Off it, on
purpose: the Console drawer (a docked panel, Esc inside it closes it), the guide's
pointer cards, tooltips, toasts, and the Runs panel (part of the page; Esc closes
it when no layer is open).

`dialog.js` on the stack: dialogs are named by their title (`aria-labelledby`), a
destructive dialog opens with focus on Cancel, a plain one on its action (audit
G7).

### 4.2 Theme

Dark (the default), Light, or System (follows the OS and changes with it). An
inline script in `index.html` applies it before the first paint, so Light no
longer flashes dark. The top-bar button and `t` still flip dark and light.

### 4.3 Verdict words (`modules/verdict.js`)

The run picker, Runs and Compare take a run's result from the server's verdict
(`verdict.state` for the colour, `verdict.label` for the words), so they cannot
disagree. An unknown state is amber, never a guessed pass. Flow, Analytics and
Verify already used Verify's own wording (`verify-model.js`).

---

## 5. Handover: what the feature phases build into which surface

Phases are the ones in `docs/audit-2026-11-15.md` section 8.

| Phase | Builds into | Notes for the builder |
|---|---|---|
| 0e Sweep correctness | `sweeps.js`, `runs.js`, `compare.js` | These three files were rebuilt here: rebase, do not merge by hand. The six-run cap now lives in `runs.js` `wireTable` (tick limit) and `compare.js` `MAX`; "Compare these runs" in `paintSweepSummary` still sends the first six. |
| 0c Run safety (G7) | `dialog.js` | Done here: destructive dialogs focus Cancel. G6 (the bare `s` key) is untouched in `hotkeys.js`. |
| 1 One settings model | Setup: the Settings and All settings sections | Not the Settings page: that is app preferences. Use the dialog section style (mono caps `h4` in `.dlg-body`) for any new dialog. |
| 2a Job queue, 2b Run menu | Top bar: the Run split button and `#run-menu` | Menus go through `overlay.wireMenu`. A queue chip belongs left of Run. Run preferences added to the menu also need a row in `prefs.js`. |
| 2f Log view | Flow's inspector | Untouched here. |
| 3a, 3b Studies | The sweep sheet (`sweeps.js`, `.sw-*`) | Already a dialog on the stack. The goal cards and axis rows are the place for the typed variable picker and guards. |
| 3c Study view | The sweep summary under a sweep row (`paintSweepSummary`, `.sw-sum`) | The table by value is the sweep's child rows (they line up with the columns). Add the heatmap and Pareto beside `trendSvg` / `tradeSvg`; "Use this configuration" is on the best tiles. A full-page study view can reuse the same functions. |
| 3e Runs table | `runs.js`: toolbar `.rn-tools`, selection bar `#rn-selbar`, columns `COLS` | Bulk actions go in the selection bar. New columns: add to `COLS`, a short head to `HEADS`, a place in `DROP_ORDER`. Saved views sit beside Columns. The run panel (`sideHtml`) takes new per-run actions. |
| 3f Compare | `compare.js` | Rebuilt here as section 6.2 asks (reference, deltas, differing first). Left for 3f: one metric formatter shared with Runs and Analytics (`shortMetric` here, `fmt.metric`, the `COLS` formatters), power shown in mW in the metric table. |
| 4 Failures and learning | Flow's failure card, Verify, Layout | Untouched here. New sheets: `openLayer(el, { kind: "sheet" })`. |
| 5 Install, update, Tools | Tools; Settings › About for version and update | The About card is the natural home for "what's new" and an update banner link. |
| 6 Pro analysis | Verify (paths), Layout (nets, overlays) | Untouched here. Layout's menus are on the stack (`layout.js wireMenu`). |
| 7a `overlay.js` | Done | Section 4.1. The Tools install modal was not migrated (it was not found as a separate overlay; check when touching Tools). |
| 7b Preferences | Mostly done | Registry, Settings page, OS theme, single keys. Not done: per-window state in sessionStorage, project and run in the URL. |
| 7c Verdict vocabulary | Partly done | `verdict.js` for runs. Not done: the Python parity test, the single `html` template. |
| 7d Dead code, `pipeline` → `flow` | Not done | The landing page is reachable (`/landing` is the PWA `start_url`), so it was kept. |
| 7f Tokens, breakpoints | Not done | The owner rejected a token restyle; if it is ever done it must be value-for-value, with no visual change. |

Follow-ups noticed and left alone: the failed sweep run `sweep-util-70` is labelled
"Clock tree" by the server's verdict stage while its failure card says detailed
placement (backend); "Compare these runs" sends only the first six; the Runs
panel's "Changed" list reads up to 40 runs per design (`loadChanges`).

---

## 6. Harness

Scratchpad of the session that did this work; recreate from these notes if gone.

- `serve.sh <port> <home-name> [code-dir]`: private server in the `lanex` WSL
  distro with `LANEX_HOME=/home/lanex/.lanex-<home-name>`. Ports 8801 (home
  `aud15`, project `/home/lanex/lanex-scratch/aud15/spm`) and 8802 (`aud15-fresh`)
  serve the worktree; 8803 and 8804 serve an untouched copy of `main` for
  "before" pictures. Never port 8765, never the owner's project folder.
- Playwright (`playwright-core`, `channel: "msedge"`): `pw/capture.mjs <width>
  <dark|light> <out> [port] [freshPort] [only]` (78 scenes), `pw/runs-shots.mjs`
  (Runs, sweep and Compare states), `pw/dlg-shots.mjs` (dialogs), `pw/check.mjs`
  (menus, Esc order, focus return, Settings), `pw/widths.mjs` (overflow at four
  widths), `pw/cuts.mjs` (cut text), `pw/sheet.mjs` (contact sheets).
- Tests: `node lanex/tests/frontend_test.mjs`; pytest through `tests.sh` in WSL.
  Baseline on b3664e0: 139 frontend checks; pytest 1384 passed, 5 failed (gds3d
  uninstall ×4, pdk no-env), 55 skipped.
