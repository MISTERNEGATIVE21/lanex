# LanEx UI redesign (2026-11-15)

> **Direction changed on 2026-11-15, after the first build.** The owner saw the flat
> Project page and rejected the restyle. The scope is now: **the LanEx look stays
> (sharper, never a new style); the Setup page is left alone; polished tabs get light
> fixes; weak or missing things (Runs, sweeps, Compare, Settings, overlays) get the
> full effort.** Section 1 (the audit) still holds. Sections 3 to 8 describe the
> rejected direction and are to be rewritten. What "the LanEx look" means: big bold
> Barlow text, blue-tinted near-black surfaces with blue borders, glow and depth (rail
> spine and via, gradient Run button, lit card edges), spaced mono caps labels, the
> grid texture and the layer-colour hairline. Clutter to remove is duplicated content
> (repeated verdict cards, duplicate controls, chip walls), not style.

Branch `claude/ui-redesign-2026-11-90b33b`, cut from `main` at b3664e0 (v1.0.0).
Read with `docs/audit-2026-11-15.md` (sections 6 and 10) and `PRODUCT.md`.

This file has four parts: what the screens look like today (the visual audit), the
principles, the decisions (information architecture, design system, templates, copy,
overlays, Settings), and the design of every page. Section 9 is the handover for the
feature phases. "As built" notes are added per page as each one lands.

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

## 2. Principles

The ten in audit section 10.2 stand. Three working rules follow from them and are
used to settle every choice below:

1. **Subtract first.** When two good options exist, take the one that removes more.
2. **One of each.** One button set, one tab style, one panel, one table, one menu,
   one overlay behaviour, one verdict presentation. A page may not bring its own.
3. **A page is a tool, not a brochure.** The header is one line. A page that needs a
   paragraph to explain itself is redesigned until it does not.

---

## 3. Information architecture

### 3.1 The frame

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ LanEx   spm ▾   Run  sweep-clk-10 · Clean ▾        Search  Ctrl K   ▶ Run ▾  ⋯ │
├──────┬───────────────────────────────────────────────────────────────────────┤
│ Proj │                                                                       │
│ Code │                              the page                                 │
│ Conf │                                                                       │
│ ──── │                                                                       │
│ Flow │                                                                       │
│ Runs │                                                                       │
│ ──── │                                                                       │
│ Resu │                                                                       │
│ Layo │                                                                       │
│ Libr │                                                                       │
│      │                                                                       │
│ Tool │                                                                       │
│ Sett │                                                                       │
├──────┴───────────────────────────────────────────────────────────────────────┤
│ ● Idle · last run Clean 49 s      sky130A · Container · Full auto   Console  │
│                                                          Not a sign-off tool │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rail: ten places, no group labels.** Project, Code, Config · Flow, Runs · Results,
Layout, Library · (foot) Tools, Settings. Groups are separated by a gap, not a label:
the labels were decoration that named what the order already says.

| Today | Now | Why |
|---|---|---|
| Setup | **Project** | It is the project's home, not a wizard step. The hero, the steps and the second project list go. |
| RTL IDE | **Code** | Shorter; the page holds constraints and the config file too, not only RTL. |
| (in Setup) Common settings, All settings | **Config** | Audit 6.1: configuration is a destination of its own with search and views. It also takes 58 of Setup's 60 screens with it. |
| Flow | **Flow** | Kept. "Run" beside a Run button and a Runs tab would give three near-identical words. |
| Runs | **Runs** | Kept. |
| Analytics + Verify | **Results** | They show the same run and the same checks twice. One page, one verdict, eight views. |
| Layout | **Layout** | Kept. |
| Cells | **Library** | It holds cells, macros and flow rules. |
| Tools | **Tools** | Kept, at the foot. |
| (spread over the top bar, Run menu, Console, IDE) | **Settings** | One place for preferences. |

Sub-places go from about 38 to 14: Results has eight views, Library three, Config
three. Project, Flow, Runs, Layout, Tools and Settings have none.

Internal ids: `pipeline` becomes `flow` (alias kept); `analytics` and `verify` become
`results` (aliases kept: `go("verify", {check})` opens Results on Checks and reveals
the check); `config` and `settings` are new. `setup`, `ide` and `cells` keep their
ids (tests, the guide and about forty `go()` callers use them); only the label and
the address change (`#project`, `#code`, `#library`, old addresses accepted).

**Top bar.** Left to right: the wordmark; the project switcher; the **run in view**;
the "Back to" chip when a link was followed; search; Run with its menu; one app menu.

- *Run in view* is the one shared control for "which run am I looking at" and "what
  is it compared with". It replaces the RUN / COMPARED WITH pair that Flow, Analytics,
  Verify and Layout each drew. It shows the run's name and verdict; its popover lists
  the runs, and holds "Compare with" as a second row.
- *One-off settings chip.* When the per-run override layer holds values, a chip
  beside Run says "2 one-off settings" and opens Config on Changed. Nothing may
  affect a run without being visible next to the Run button (audit 6.1).
- *App menu (⋯).* Help and glossary, Keyboard shortcuts, First-chip guide, Tour,
  theme (System / Dark / Light), interface size, Settings, About. Zoom −/100 %/+,
  theme, Help and Tools leave the top bar: five controls become one.

**Status line.** One line. Left: the run state (idle, or stage, step count, elapsed
and Stop while running; the last result when idle) and the problem count. Right: what
the next run will use (PDK · engine · mode, one item that opens the Run menu), the
Console toggle, and the sign-off notice. The Logs drawer becomes a tab of the Console
("Installs"), so there is one drawer and one button.

**The sign-off notice** stays in the status line on every page, closes the Summary
view of Results, and is in About.

### 3.2 What moved where

| Function | Was | Is |
|---|---|---|
| Project list, New, Open folder, Manage, Show in Explorer | top-bar menu and Setup hub | top-bar menu; the Project page's no-project state |
| Top module, clock, period, PDK, cell library | two Setup cards | one "Design" row on Project |
| Sources | Setup card | Project |
| Ready to run, run name, Run flow | Setup, 1.5 screens down | Project, right column, first screen |
| Common settings, All settings, presets, synthesis diagrams toggle | Setup | Config (Common / All / Changed) |
| Verdict hero | Flow, Runs, Analytics, Verify | one verdict line component; a card only when a run failed |
| Run and compared-with selectors | each results page | top bar |
| Analytics sections | 9 anchors | Results: Summary, Timing, Area & power, Routing, Trends, Metrics |
| Verify sections | 7 anchors | Results: Summary, Checks, Timing, Reports |
| Compare | Analytics anchor | Results compare mode (from the run-in-view popover and from Runs) |
| Settings used, CSV, Copy summary, Open in KLayout with markers | results page toolbars | Results "More" menu |
| Run detail | card inside the Runs table | side panel |
| Sweep summary | card inside the Runs table | side panel (the study view) |
| Desktop viewers | cards under the Layout canvas | Layout "Open in" menu |
| Run files | section under the Layout canvas | sheet from Layout's and the run panel's "Files" |
| 3D | two buttons | the 2D / 3D switch |
| Zoom, theme | top bar | app menu and Settings |
| Notifications, chime, show Flow on run | Run menu | Run menu "When" section and Settings |
| Install log | Logs drawer | Console, Installs tab |
| Density (`d`) | hidden hotkey | Settings, "Compact spacing" |

Nothing is removed. Everything reachable today is reachable after.

---

## 4. Design system

All of it is in `static/ui/tokens.css` and `static/ui/ui.css`. Page stylesheets may
use tokens and components; they may not define colours, sizes, radii or their own
buttons, tabs, cards or menus.

### 4.1 Colour

Identity kept: blue-tinted dark surfaces, the met1 blue as the accent family, the
layer palette. Depth is five tones of one hue, no gradients and no glows.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--tone-0` | `#080b11` | `#e9edf3` | rail, status line, wells, canvas ground |
| `--tone-1` | `#0c1017` | `#f3f5f9` | page |
| `--tone-2` | `#121822` | `#ffffff` | panel, table, input |
| `--tone-3` | `#19212e` | `#eef1f6` | raised: menu, popover, hover |
| `--tone-4` | `#222d3e` | `#e1e6ee` | pressed, selected |
| `--line` | `#242f40` | `#d3dae5` | the one border |
| `--line-ctl` | `#63738f` | `#6c7c93` | form-control outline (3:1 on tones 0 to 3) |
| `--text` | `#c6d0df` | `#2a3547` | body |
| `--text-strong` | `#f2f6fc` | `#0c1524` | titles, values |
| `--text-muted` | `#8a97ab` | `#566378` | labels, secondary |
| `--text-faint` | `#6e7c94` | `#707d92` | placeholder, disabled (3:1) |
| `--accent` | `#2f6fe0` | `#2259c7` | the one action fill |
| `--accent-hover` | `#2861cc` | `#1c4db0` | |
| `--accent-text` | `#6cabff` | `#1d52bd` | links, focus ring, selected marks |
| `--pass` | `#3ebd7e` | `#136c3f` | verdict text and marks |
| `--warn` | `#e2a630` | `#855604` | |
| `--fail` | `#f26a72` | `#b82931` | |

Checked by script (WCAG 2.1 relative luminance): every text colour is at least 4.5:1
on every tone it can sit on (muted on the darkest pairing: 4.69 dark, 5.18 light);
faint is at least 3:1 on tones 0 to 3; white on accent is 4.70 (dark) and 6.3
(light); the control outline is at least 3:1 on tones 0 to 3.

Rules: one accent, for the primary action, links, focus and selection. Green, amber
and red only for verdicts and check states. Layer colours (`--met1` … `--poly`) only
inside the layout canvas, the 3D view, the layer list and charts. Soft fills are
`color-mix` of the status colour at 14 % on the surface.

Theme: Settings offers System, Dark, Light. System follows `prefers-color-scheme`
and is the default (today the app ignores the OS).

### 4.2 Type

Barlow for the interface, JetBrains Mono for code, paths, names of runs and settings,
and every number.

| Token | Size / line | Use |
|---|---|---|
| `--fs-1` | 12 / 16 | captions, table headers, meta |
| `--fs-2` | 13 / 18 | controls, tables, lists: the default |
| `--fs-3` | 14 / 21 | reading text: help, failure cards, empty states |
| `--fs-4` | 16 / 22 | panel and section titles |
| `--fs-5` | 20 / 26 | page title, the key number |
| `--fs-6` | 28 / 34 | the one headline of an empty or first-run state |

Weights 400, 500, 600. No uppercase letter-spaced labels: a label is `--fs-1`,
muted, weight 500, sentence case. Numbers use tabular figures; units are muted and
set after a thin space.

### 4.3 Space, shape, depth

- Spacing: 4 px step. `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24,
  `--s-6` 32, `--s-7` 48.
- Radii: `--r-1` 4 px for controls and chips; `--r-2` 6 px for panels, menus,
  dialogs. Round only for status dots and the switch.
- Border: 1 px, `--line`. Controls use `--line-ctl`.
- Depth by tone. One shadow token, `--shadow-float`, for things that float over the
  page (menu, popover, dialog, sheet, toast). Panels have no shadow.
- Control heights: 32 px default, 26 px small, 22 px for chips. Table rows 32 px.
- Focus: 2 px `--accent-text` outline, 2 px offset, on `:focus-visible`, everywhere.
- Motion: 120 ms for hover and press, 160 ms for overlays; none under
  `prefers-reduced-motion`.
- Z-index: six named layers (`--z-sticky`, `--z-chrome`, `--z-drawer`, `--z-overlay`,
  `--z-toast`, `--z-splash`).

### 4.4 Components

One of each, in `ui.css`. States for every interactive one: rest, hover, focus,
pressed, selected, disabled, busy.

| Component | Class | Variants |
|---|---|---|
| Button | `.btn` | default, `.btn-primary` (one per page), `.btn-quiet`, `.btn-danger`; `.btn-sm`; icon-only `.btn-icon`; busy |
| Split button | `.split` | main + menu half |
| Link button | `.link` | inline action in text |
| Field | `.field` | label, control, hint, error |
| Input, select, textarea | `.inp` | `.inp-sm`, with unit suffix, invalid |
| Checkbox, radio, switch | native + `.switch` | |
| Segmented control | `.seg` | two to five exclusive options |
| Tabs | `.tabs` | one underline style for page views, panel tabs, sheet tabs |
| Chip | `.chip` | filter toggle (pressed state), removable |
| Tag | `.tag` | static label; `.tag-pass/warn/fail/info` |
| Verdict | `.verdict` | dot + word: clean, warnings, failed, stopped, running, incomplete; `.verdict-line` adds name, time and key numbers |
| Count | `.count` | number after a label |
| Menu | `.menu` | item, radio item, check item, label, separator, field row |
| Panel | `.panel` | optional `.panel-h` header row; `.panel-flush` |
| Table | `.tbl` | dense; sticky header; numeric columns right-aligned mono; row hover, selected; group rows |
| Key-value list | `.kv` | label left, value right, optional delta |
| Toolbar | `.bar` | one row; `.bar-spacer` |
| Page header | `.page-h` | title, optional count, optional tabs, actions: one line |
| Note | `.note` | info, warn, fail; one line or a short block with an action |
| Empty state | `.empty` | title, one sentence, one action |
| Skeleton | `.skel` | shown after 300 ms |
| Progress | `.progress` | determinate and indeterminate |
| Toast | `.toast` | info, ok, warn, error |
| Dialog | `.dlg` | confirm, danger, prompt, choice, checklist, custom |
| Sheet | `.sheet` | right side, 440 or 640 px |
| Popover | `.pop` | anchored, non-modal |
| Tooltip | `[data-tip]` | text only |
| Code and keys | `code`, `.codeblock`, `kbd` | |

Old class names that survive in the modules (`.btn-ghost`, `.pill`, `.card`,
`.iconbtn`, `.linklike`, `.chip-clickable`, `.menu-item` and so on) are mapped onto
this set in one place, `ui.css` section "legacy names", and removed page by page.

### 4.5 Widths and zoom

Three named widths, measured on the work area with container queries, never on the
window with media queries. That is what makes zoom and layout agree: under CSS zoom
a container query sees zoomed pixels, a media query sees the real window.

| Name | Work area | What changes |
|---|---|---|
| `narrow` | under 900 px | rail shows icons only; side panels become sheets; two-column pages stack |
| `regular` | 900 to 1700 px | the default layouts |
| `wide` | over 1700 px | reading columns stay capped at 1440 px; tables take the width; master-detail pages give the detail the extra room |

1280 CSS px wide (work area 1210) is `regular`. Text never stretches: prose is capped
at 72 characters, forms at 720 px, and a page's content at 1440 px unless it is a
table or a canvas.

Zoom: one size control. Automatic by screen as today (unchanged maths in `zoom.js`),
or a manual size in Settings and the app menu. Density is one token switch
(`Compact spacing` in Settings): rows 28 px, controls 28 px, paddings one step down.
Zoom scales everything; density changes how much fits. They compose.

---

## 5. Page templates

- **List page** (Runs, Tools, Library's list): page header; one toolbar row (search,
  one filter control, view options); the table or list takes the remaining height and
  scrolls inside itself; a row opens a detail panel on the right.
- **Detail page** (Results, Project, Config): page header with view tabs; content in
  a capped column or an auto-fill grid of panels; no anchors, no scroll-spy.
- **Canvas page** (Flow, Layout, Code): no page header; the work fills the window
  edge to edge; toolbars sit inside; side panels collapse.
- **Form page** (Settings, the wizard, sheets): one column, 720 px, labelled groups.
- **Empty:** a title, one sentence, one action. No illustration. With no project open
  every page shows the same state with the same action (New project / Open folder).
- **Loading:** the skeleton of the template after 300 ms; never a spinner in the
  middle of an empty page.
- **Error:** a `.note` in place, with what went wrong, the next step and Retry.

---

## 6. Copy

- A page header is the page's name and, where it helps, a count: "Runs · 13". No
  eyebrow, no subtitle, no instruction paragraph.
- Teaching text lives in four places: the empty state, hover (`data-tip`), the
  failure card, and Help. A panel may carry one muted line when the default would
  mislead without it.
- Sentence case everywhere. No uppercase labels. No exclamation marks.
- Buttons are verbs: "Run flow", "Open folder", "Compare". A button that opens a
  dialog ends in an ellipsis.
- Numbers: one formatter per quantity, the same on every page (`fmt` in
  `modules/units.js`): time in ns with sign, area in µm², power with an SI prefix,
  utilisation as a percentage.

One vocabulary:

| Thing | Word | Not |
|---|---|---|
| a design folder | project | design, design directory |
| one execution of the flow | run | flow run, job |
| several runs over a setting | sweep | DSE, study (kept for later) |
| the PDK | PDK (first use: "process (PDK)") | process, technology |
| the SCL | cell library | standard-cell library, SCL |
| one of the seven | stage | phase |
| one of the ~76 | step | substep |
| run verdict | Clean, Warnings, Failed, Stopped, Running, Incomplete | Passed, Done, completed, PASS, "finished, with problems" |
| check state | Passed, Warning, Failed, Info, Off | clean, ok |
| the page for one run's stages | Flow | Pipeline |
| a value for the next run only | one-off setting | override |

The verdict words come from one module (`modules/verdict.js`), which maps the
server's `verdict.state` to the word, the colour class and the mark, and is the only
place that does.

---

## 7. Overlays and Settings

### 7.1 One overlay behaviour (`modules/overlay.js`)

Every dialog, sheet, menu and popover opens through one stack.

- **Kinds:** `dialog` (modal, centred), `sheet` (modal-lite, right side), `menu` and
  `popover` (anchored, not modal), `drawer` (the Console, not modal).
- **Focus:** a dialog or sheet moves focus inside when it opens (to the first field,
  or to Cancel when the action is destructive) and traps Tab. Closing returns focus
  to the element that opened it.
- **Esc** closes only the top of the stack. One press, one layer.
- **Outside click** closes menus, popovers and sheets; a dialog only by its buttons
  or Esc.
- **Names:** every dialog and sheet has `role="dialog"`, `aria-modal` where it traps,
  and `aria-labelledby` its title. Menus are `role="menu"` with arrow keys, Home, End
  and type-ahead.
- **Scrim:** dialogs dim the page; sheets and menus do not.
- One open menu at a time; opening a dialog from a sheet stacks on it.

Migrated onto it: `dialog.js`, the shell menus, the help sheet, the wizard, the fix
sheet, the sweep sheet, the palette, the run picker, provenance, final settings, the
folder browser, the Tools install modal, the Console.

### 7.2 Settings page (`modules/settings.js`, `modules/prefs.js`)

`prefs.js` is the registry: every preference has a key, a default, a type and a
label, and is read and written through it. The page is generated from it.

- **Appearance:** theme (System, Dark, Light); interface size (Automatic, or 80 to
  150 %); compact spacing.
- **Runs:** engine (Container, Local tools); mode (Full auto, Step by step); show
  Flow when a run starts; tell me when a run finishes; play a sound. (Keep the PC
  awake arrives with phase 2b and has its slot here.)
- **Editor:** check syntax on save.
- **Keyboard:** single-key shortcuts on or off (WCAG 2.1.4); the shortcut list.
- **First run:** show the first-launch card again; start the first-chip guide; take
  the tour.
- **Data:** reset every preference; clear recent projects.
- **About:** version, LibreLane version, licence, the sign-off notice, links.

---

## 8. Every page

Each entry: the job, the one primary action, the layout, what was removed.

### 8.1 Project (`setup`)

*Job:* open or start a project; see that it is ready; run it. *Primary:* Run flow
(with a project), New project (without).

No project: a centred column. "Start a project" (`--fs-6`), one sentence, three
actions in a row (New project is primary, Open folder, Try the Blinky example), then
Recent projects as a plain list, then "Paste a folder path". Nothing else on screen.

Project open, at `regular`:

```
spm   \\wsl.localhost\lanex\home\…\spm                     Open in Code   Show in Explorer
┌ Design ─────────────────────────────────────────────┐  ┌ Ready to run ───────────────┐
│ Top module  Clock port  Period      PDK      Cells  │  │ ● Design and config          │
│ [spm ▾]     [clk ▾]     [10] ns     [sky130A▾] [hd▾]│  │ ● PDK and cell library       │
│ note: pdk::sky130* sets the period to 10 ns          │  │ ● Container engine           │
├ Sources ───────────────────── New file  Add files  ⟳ ┤  │ Run name [first-try     ]    │
│ ☑ src/spm.v                top                  1 kB │  │ [        ▶ Run flow        ] │
│ ☐ verify/spm_tb.v          testbench            2 kB │  │ 5 to 60 minutes              │
│ …                                                    │  ├ Last run ────────────────────┤
└──────────────────────────────────────────────────────┘  │ sweep-clk-10 · Clean · 49 s  │
                                                          ├ Configuration ───────────────┤
                                                          │ 6 settings in config.yaml →  │
                                                          └──────────────────────────────┘
```

Removed: the hero, the layer stack, the four step cards, the six anchor tabs, the
second project list, the provenance magnifiers beside labels (the source shows on
hover and in Config), the "Ready to run?" hint paragraph, the launch note.

### 8.2 Code (`ide`)

*Job:* edit, check, simulate. *Primary:* Simulate.

Structure kept. The title bar goes (Pop out moves to the editor toolbar); tree group
labels become sentence case; Check syntax is a default button; the bottom panel uses
the shared tabs. The waveform viewer keeps its own canvas and gets tokens.

### 8.3 Config (`config`, new)

*Job:* see and change what the flow will use. *Primary:* none (edits save on change).

```
Configuration   config.yaml · Open file            [Common | All | Changed]  [Search settings]
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Floorplan                                                                                │
│ Core utilisation   FP_CORE_UTIL      [ 45 ] %          config.yaml                       │
│ Die size           FP_SIZING         [relative ▾]      default                           │
│ …                                                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Common:** the thirteen settings most designs change, grouped by stage. Writes the
  config file (today's `mostused.js`).
- **All:** every variable by stage, with the stage list as a left column. Today these
  are one-off settings for runs started here; the view says so in one line and each
  changed row carries a "one-off" tag. Presets ("Start from") and "Save preset" are in
  this view's toolbar.
- **Changed:** only rows that differ from the default, from either source.
- Each row: plain name, variable name, control, source (config file, PDK section,
  default, one-off).

Wired today: both existing editors, presets, search, reveal-a-setting links, the
synthesis-diagrams toggle. Left for phase 1: one write path with scopes, typed inputs
from LibreLane's variable types, validation, the raw-file toggle, config chooser.

### 8.4 Flow (`flow`, was `pipeline`)

*Job:* watch a run; when it stops, see why. *Primary:* Apply (the fix) on a failure;
none otherwise.

Structure kept. Changes:

- The run selector row goes (top bar).
- A clean or running run gets a **verdict line**, 40 px: mark, word, run name, time,
  the six numbers inline, warnings count, and "Layout" / "Results" links. A failed or
  stopped run keeps the full card with the cause, the evidence and the fix.
- Stage tiles: 96 px thumbnails instead of 140; no grid texture or ghost numerals in
  empty tiles.
- Steps and log panes take everything below.

### 8.5 Runs (`runs`)

*Job:* find a run; open it; compare; sweep. *Primary:* New sweep.

```
Runs · 13                                                        Import…   New sweep
[Search runs]  [All | Clean | Warnings | Failed | Stopped]  Filter ▾  Columns ▾
┌──────────────────────────────────────────────────────────┬───────────────────────┐
│ ▸ Sweep  CLOCK_PERIOD 10, 9, 8     1 of 3 · best +2.36 ns │ sweep-clk-10          │
│ ▾ Sweep  FP_CORE_UTIL 45, 50       2 runs · best +4.54 ns │ ● Clean · 49 s · today │
│     sweep-util-45  ● Clean   +4.54   0.00  …              │ Setup slack  +2.36 ns │
│     sweep-util-50  ● Clean   +4.10   …                    │ Hold slack   +0.28 ns │
│   tuned            ● Clean   +4.10   …                    │ Die          88 × 99  │
│   stopped          ● Stopped after step 37                │ …                     │
│                                                           │ Flow Layout Results   │
│                                                           │ Run again… Files More │
└──────────────────────────────────────────────────────────┴───────────────────────┘
```

- One toolbar row. Origin, PDK, pinned and "all projects" move into one Filter menu.
- A row click selects the run (it becomes the run in view) and opens the **run
  panel**: verdict line, key numbers, lineage, note, actions. No card inside the
  table.
- A sweep row shows its swept values, and opens the **study panel**: the goal
  headline, a table of value against result in sweep order, the chart, and its
  actions. This is the surface phase 3 fills.
- Ticking rows shows the selection actions in the toolbar row, in place of the
  filters.

### 8.6 Results (`results`, was `analytics` + `verify`)

*Job:* read how a run came out. *Primary:* none.

```
Results   [Summary | Timing | Checks | Area & power | Routing | Trends | Metrics | Reports]   Compare   More ▾
● Clean   sweep-clk-10 · 21 of 23 checks passed · 32 warnings
┌ Key numbers ──────────────────────────────┐ ┌ Checks ─────────────────────────────┐
│ Setup slack      +2.362 ns     −2.174     │ │ ● Timing            9 corners        │
│ Hold slack       +0.282 ns      same      │ │ ● Design rules      0 errors         │
│ Die              88.4 × 99.2 µm           │ │ ● Layout vs netlist match            │
│ Utilisation      76.5 %        +5.8 pts   │ │ ● Antenna and power 0 nets           │
│ Power            1.528 mW      +23.5 µW   │ └──────────────────────────────────────┘
│ Wire length      8,571 µm      +794       │
└───────────────────────────────────────────┘
LanEx shows what LibreLane's tools report. It is not a sign-off tool.
```

- **Summary:** the verdict line; key numbers as one table with the change against the
  compared run; the four check groups, one line each, each a link into Checks;
  problems first when there are any; the sign-off line.
- **Timing:** slack by corner, slack through the flow, the corner table, worst paths.
- **Checks:** every check in flow order as one table (state, check, value, limit),
  failed and warning rows open; then DRC, LVS and XOR, antenna and power detail.
- **Area & power**, **Routing:** today's sections without their header blocks.
- **Trends:** by stage, across runs, metric watch.
- **Metrics:** every metric, searchable.
- **Reports:** the report files.
- **Compare:** a mode of the page that replaces the views with the comparison of the
  selected runs. This is the surface phase 3f rebuilds.
- Where a number comes from: click the number. The magnifier beside every value goes.
- The check chips on the old Analytics overview, the 23 squares and the pillar cards
  go; the Checks view is the one list of checks.

### 8.7 Layout (`layout`)

*Job:* look at the chip. *Primary:* none.

The canvas is the page. One row above it: the stage switch (text, no thumbnails),
Play, then on the right Open in ▾, Save image ▾ and More ▾ (Command, Run files,
Other snapshot). One toolbar inside the canvas: panel toggle, 2D / 3D, fit, zoom,
measure, labels, outlines, background, full screen. One side panel with Layers,
Cells, Find, Checks. Scale and coordinates in the bottom-left; what is on screen in
the top-right. No scroll.

Removed: the second 3D button, the stage thumbnails, the desktop-viewer cards (they
are the Open in menu), the hint bar (it shows once, then stays in Help), the page
caption (it is the top-right badge's tooltip).

### 8.8 Library (`cells`)

*Job:* look up a cell; manage macros; say which cells the flow may use. *Primary:*
none.

Three views: Cells, Macros, Flow rules. Cells is a list and a detail. One summary
line replaces five tiles ("445 cells · 192 usable · 236 excluded · 19 used by
sweep-clk-10", each part a filter). One Filter control holds category, the two
toggles and the sort. The detail leads with the cell's name, what it does and the
drive picker, then one facts row, then function and layout side by side, the
drive-strength chart and the pin table.

### 8.9 Tools (`tools`)

*Job:* see that the toolchain is ready; install or fix. *Primary:* the fix for the
first thing that needs one; none on a healthy system.

A status list. Header: "Tools", Check all, Copy diagnostics. A note at the top only
when something needs attention. Then four tables with one row layout (state, name,
version, size, what it is for, action, more): Flow engine, PDKs (grouped by family),
Viewers, Helpers; the local toolchain folded below. The hero and the 17 squares go.

### 8.10 Settings (`settings`, new)

Section 7.2.

### 8.11 Sheets, dialogs and the rest

- **New project wizard:** a dialog, two steps, shared tabs for the step marker,
  shared fields.
- **First-launch card:** a plain dialog with three choices. No brackets.
- **Guide and tour:** Driver.js popovers on the popover tokens.
- **Run menu:** three sections (What, How, When) and the command line under them
  (audit 6.3). What: whole flow, up to a stage, from a stage. How: engine, mode.
  When: show Flow, notify, sound. Flow picker, only/skip, threads, priority,
  keep-awake and "add to queue" are phases 2a and 2b; their slots are in section 9.
- **Queue control:** the status line's run item is the slot. Today it shows the one
  live run; its popover is where the queue goes.
- **Command palette:** one input, one list, prefixes shown as a hint row.
- **Console:** one drawer; tabs Log, Command, Journal, Run a command, Installs.
- **Help:** a sheet; tabs Learn, Shortcuts, About.
- **Fix sheet, sweep sheet, run files, settings used, provenance:** the shared sheet
  and dialog, shared fields, shared tables.

---

## 9. Handover: what the feature phases build into which surface

Filled in at the end of the build (see the bottom of this file).

---

## 10. Harness

Scratchpad of the session that did this work; recreate from these notes if gone.

- `serve.sh <port> <home-name> [code-dir]`: private server in the `lanex` WSL
  distro with `LANEX_HOME=/home/lanex/.lanex-<home-name>`; ports 8801 (home
  `aud15`, project `/home/lanex/lanex-scratch/aud15/spm`) and 8802 (`aud15-fresh`).
- `pw/lib.mjs`, `pw/capture.mjs <width> <dark|light> <out> [port] [freshPort] [only]`:
  Playwright (`playwright-core`, `channel: "msedge"`), 77 scenes; `pw/sheet.mjs`
  builds contact sheets; `cssinv.mjs` counts the values in the stylesheets;
  `contrast.mjs` checks the tokens.
- Tests: `node lanex/tests/frontend_test.mjs`; pytest through `tests.sh` in WSL.
  Baseline on b3664e0: 139 frontend checks pass; pytest 1384 passed, 5 failed
  (gds3d uninstall ×4, pdk no-env), 55 skipped.
