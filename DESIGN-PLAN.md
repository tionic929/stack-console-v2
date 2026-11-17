# StackConsole design plan (2026-11-17)

Companion to `AUDIT.md`. That file covers what is broken; this one covers how the app should look, move and be laid out.

Basis: `src/tokens.css`, `src/index.css`, and the real screens rendered in a browser with sample data (main window, Edit command, Project manager). The running Electron app was not used. Recommendations here are proposals; nothing is mocked or built yet.

Stack context: the target is Tauri 2 with a Rust core. The renderer ports as-is, so all of this can be built in the current HTML/CSS/JS and carried over.

## 1. Where the design stands

**What is solid and should be kept**
- Token discipline: every colour, size and radius is a variable in `tokens.css`. This is what makes theming cheap.
- Status language: jade / amber / ruby plus a separate indigo for "waiting", never reused for anything else.
- Project identity: a colour and tile per project, with rules so neighbours never share a colour.
- Accessibility basics: focus rings, ARIA roles on tree, menus and dialogs, reduced-motion respected.
- Resizable workbench: every edge drags, takes the keyboard and resets on double-click.

**What makes it look generic or unfinished**

| # | Concern | Evidence |
|---|---|---|
| V1 | **No visual identity.** Radix Slate + indigo accent + system font is the default look of most dev tools. Nothing on screen says "StackConsole". | `tokens.css` palette; `--font-ui` is Segoe UI / system |
| V2 | **One theme.** Dark only, no light or high-contrast, no following the OS. | no `prefers-color-scheme`, a single `:root` |
| V3 | **Almost no motion.** 4 transitions and 1 keyframe (the status pulse) in 1,374 lines of CSS. Dialogs, menus, banners and rows appear and vanish instantly. | `index.css` |
| V4 | **Flat depth.** Two shadows, one border colour doing most of the separation, every surface nearly the same grey. | `--shadow-float`, `--shadow-dialog`, slate1-slate4 |
| V5 | **Type hierarchy is narrow.** Six sizes between 11 and 20 px, most text at 11-13 px; the densest information is the smallest. | `--text-xs` to `--text-xl` |
| V6 | **Components are styled, not designed.** Buttons, inputs, selects and checkboxes are neutral boxes; the native `<select>` and checkbox show through. | Edit command, Project manager |
| V7 | **Overlays are inconsistent.** Confirms and menus are in-window; Add, Edit, Import, Rename, New project and Project manager are six separate OS windows with their own title bars. | `main.js:1450-1484` |
| V8 | **Log pane is the product but gets the least design.** Plain text rows; errors, URLs and stack traces look the same as everything else. | rendered Laravel crash sample |
| V9 | **Empty and loading states are text-only.** | "No output yet…", "Looking for repos…" |

## 2. Art direction

One recommended direction and two alternates. These should be mocked side by side before choosing (see section 8).

### Recommended: "Rack"
The name is literally a *stack* and a *console*. Lean into it: the app is a rack of equipment, each service a unit with a status light, powered on and off.

- **Signature element: the status light.** A real LED, not a dot: a soft glow when running, a slow breathe while starting, a hard red when crashed, dark glass when off. It is the one place the app spends visual richness.
- **Signal trace.** A thin live line per service showing log activity over the last minute. Quiet service, flat line; busy or erroring service, visible at a glance without opening it.
- **Mono-forward typography.** Names and labels in a characterful UI face, every machine value (port, pid, branch, path, uptime, command) in mono with tabular figures. The split between "human" and "machine" text becomes the hierarchy.
- **Surfaces as panels.** Sidebar, header and log read as separate mounted panels with a hairline bevel and distinct elevation, instead of regions of one grey.
- **Project colour tints the room.** The selected project's identity colour lightly washes the header band and focus ring (an identity band already exists), so you always know which project you are in.
- **Restraint.** No skeuomorphic screws or brushed metal. The metaphor shows in light, labels and motion only.

### Alternate A: "Blueprint"
Schematic look: fine grid, thin connector lines, the start order drawn as wiring between services. Strongest if the dependency map (section 6) becomes the home screen.

### Alternate B: "Phosphor"
Terminal-native: mono everywhere, box-drawing rules, themes named after terminal palettes. Cheapest to build, most distinctive to terminal users, least approachable to others.

## 3. Theme system

1. **Add a semantic layer** over the raw scales: `--surface-0..3`, `--text`, `--text-muted`, `--border`, `--accent`, `--status-*`, `--elevation-1..3`. Components use only these; a theme is one block that remaps them.
2. **Ship four themes**: Dark (default), Light, High contrast, and "Dim" (lower contrast for long sessions). Default follows the OS.
3. **Separate log palette.** The 16 ANSI colours (including bright 90-97, missing today) are their own set, so a user can pick a terminal scheme without changing the app theme.
4. **Accent source**: fixed brand accent, or "follow the selected project".
5. **Fonts are bundled** (the CSP only allows local files): one UI face, one mono. Raise the floor from 11 px to 12 px and widen the scale so the service name, status and command read as three clear levels.
6. **Density setting**: comfortable / compact, driven by spacing tokens. The sidebar already has three densities; extend the idea to the log and lists.

## 4. Component upgrades

| Component | Now | Proposed |
|---|---|---|
| Status indicator | 8 px dot, one pulse | LED with glow, breathe, crash flash; same component everywhere (tree, header, tray panel, footer) |
| Service row | avatar, name, sub-line, dot | adds signal trace and a hover action cluster (start/stop/restart) so the header isn't required |
| Buttons | flat boxes, three variants | clear primary / quiet / danger, pressed state, loading state (spinner replaces icon), icon-only size |
| Inputs, select, checkbox | native-looking | custom select and checkbox, inline validation message under the field, mono variant for commands and paths |
| Segmented control | "Leave it stopped / Restart automatically" | keep; add sliding thumb |
| Icon picker | 43-icon grid always open | one button showing the current icon; grid in a popover with search |
| State banner | static bar | slides in under the header; tone stripe on the left; actions right-aligned |
| Log row | plain text | gutter with level mark, clickable URLs and `file:line`, collapsed stack traces ("12 more frames"), run separators with time and exit code |
| Empty states | one line of text | short illustration in the app's own line style, one sentence, one primary action |
| Toast | none | bottom-right stack for results ("Imported 4 commands", "Port 8000 freed") with undo where it applies |
| Tooltip | native `title` | styled tooltip with the shortcut shown |

## 5. Motion

Principles: motion explains a change of state or place; it never delays an action; everything honours reduced-motion (already in place for the three existing transitions).

Tokens: `--dur-fast` 120 ms (hover, press), `--dur-base` 180 ms (menus, toasts, banners), `--dur-slow` 260 ms (drawers, dialogs), one standard ease and one "enter" ease. The curve already used for the sidebar (`cubic-bezier(0.2, 0.8, 0.2, 1)`) becomes the standard.

| Where | Motion |
|---|---|
| Start a service | LED warms from dark to amber breathe, then settles to green; the row's trace begins drawing |
| Crash | one red flash on the row, banner slides down, tray panel count ticks |
| "Start all" | services light in start order, staggered, so the dependency order is visible |
| Waiting on a dependency | a slow travelling dash between the two rows |
| Menu / popover | scale from the anchor, 120 ms; out is faster than in |
| Dialog | backdrop fades, panel rises 8 px; closing reverses |
| Drawer (inspector) | slides from the right, log pane resizes with it |
| Toast | slides up, auto-dismiss with a thin countdown line, pauses on hover |
| Tree expand / collapse | height + caret rotate (caret exists) |
| New log lines while scrolled up | "N new lines" pill counts up instead of jumping |
| Drag (service onto log, reorder) | row lifts with a shadow, drop zones highlight |
| Selection change | header text cross-fades; log does not animate (it must feel instant) |

## 6. Section map: what lives where, and as what

Surface types used below:
- **Region**: a fixed, resizable part of the main window.
- **Drawer**: a panel that slides over or beside the log; the rest stays visible and usable.
- **Popover**: small, anchored to its trigger, dismisses on outside click.
- **Modal**: blocks the window; only for decisions that must be made before continuing.
- **Inline**: edited in place.
- **Floating**: free-moving, draggable panel.
- **Page**: replaces the main panel.

| Section | Now | Proposed surface | Draggable / resizable | Design notes |
|---|---|---|---|---|
| Title bar | custom bar, logo, window dots | Region | window drag | Add the command palette trigger and a global "what's running" count; keep it thin |
| Project rail (icons) | part of sidebar at smallest width | Region | reorder projects by drag | Tile + LED badge; Ctrl+1-9 jumps (S-014) |
| Service tree | A-Z tree | Region | sidebar width (exists); drag a service to reorder or to another project | Live and crashed projects float to the top; a missing-folder project collapses to one warning line |
| Running now | strip above the tree | Region, merged with the tree's top group | no | One "Active" group replaces both the strip and the footer counts |
| Service header | name, status, command, buttons | Region | header height (exists) | Three levels: name, status + uptime + URL button, command in mono. "Open in browser" becomes a real button |
| State banner | bar under header | Region (transient) | no | Slides in; one line, one action |
| Log pane | main area, optional second log | Region | split sash (exists); drag a service in to split (exists); **tabs** you can drag to reorder or pull into a split | The centrepiece: gutter, clickable links, folded traces |
| Log tools (find, levels, copy) | toolbar above log | Region; find becomes a **popover bar** that appears on Ctrl+F | no | Fewer permanent controls; level chips stay |
| Shell | replaces the log when selected | **Bottom dock** | height by drag; can be **popped out as a floating panel** | A shell you can use while watching a log, like an editor's terminal; one per project |
| Everything running | bottom panel toggle | Bottom dock tab next to Shell | height by drag | Same dock, second tab; add CPU / memory here |
| Add / Edit command | separate OS window, one long form | **Drawer (inspector)** on the right | width by drag; can be pinned open | Tabs: Command · Start order · Environment · Behaviour. Log stays visible, so "Save and restart" shows its result immediately |
| Environment variables | bottom of the command form | Tab in the inspector | no | Table with secret toggle; shows `.env` keys read-only with overrides marked |
| Start order | a select in the command form | Tab in the inspector, plus a **Stack map page** | nodes draggable on the map | Draw services and their "starts after" links; drag a link to set order |
| Icon and colour picker | popover (project), grid in form (command) | Popover for both | no | One component, with search |
| New project | separate OS window | Modal (small) or inline row at the top of the tree | no | Name + folder; scanning feedback inline |
| Rename project / command | separate OS window | Inline, in the tree row | no | F2 or double-click; Enter saves, Esc cancels |
| Import commands | separate OS window | Modal with checklist | no | A focused decision with a preview: correct use of a modal |
| Split / Combine projects | in-window dialog | Modal, two steps with preview | no | Show before and after side by side |
| Port in use | in-window dialog | Modal (alert) | no | Process name, path and owner; danger action clearly separated |
| Quit / delete confirm | in-window dialog | Modal (alert); delete gets a toast with Undo instead | no | Reserve confirms for irreversible actions |
| Project manager window | separate OS window | **Retire.** Its actions move to the tree menu and inspector | — | Removes the duplicate surface |
| Master folders | "..." menu in the tree header | Settings page section | reorder by drag | Rarely changed; does not belong in the daily view |
| Settings | none | Page | no | Theme, log palette, density, notifications, startup, shortcuts |
| Command palette | none | Floating, centred, Ctrl+K | no | Start/stop/restart, jump to service, open folder, switch theme |
| Notifications | OS toast when unfocused | In-app toast + OS toast | no | Same wording in both |
| Mini mode | none | **Floating always-on-top window** | yes | Just the LEDs and names, for keeping an eye on a stack while in the editor |

### Overlay rules
- **Modal** only when the app cannot continue without an answer (confirm destructive action, resolve a port conflict, choose what to import).
- **Drawer** for anything you edit while wanting to see the result (command settings, environment).
- **Popover** for a single small choice (icon, colour, a short menu).
- **Inline** for one field (rename).
- Never a separate OS window, except mini mode and a popped-out log or shell.

### States every modal and drawer needs
Opening → idle → dirty (unsaved changes: closing asks first, backdrop click does nothing) → validating (inline field errors, first invalid field focused) → saving (primary button shows progress, inputs locked) → error (message stays in the surface, nothing lost) → done (closes, toast confirms). Focus is trapped while open and returns to the trigger on close; Esc closes unless dirty.

## 7. Order of work

| Phase | What | Why first |
|---|---|---|
| 0 | Semantic tokens, motion tokens, bundled fonts | Everything else builds on these; no visible risk |
| 1 | Overlay primitives (modal, drawer, popover, toast, tooltip) and move the six windows into them | Also removes the "active project" bug class and six renderer processes (`AUDIT.md` D1, D3) |
| 2 | Section moves: bottom dock for Shell and Everything running, inspector drawer, retire Project manager, tree ordering | The structural UX gain |
| 3 | Art direction pass: LED, signal trace, panels, type; then themes | Needs phases 0-2 so it is applied once |
| 4 | Log redesign: gutter, links, folded traces, tabs | Depends on the terminal work in the engine |
| 5 | Command palette, Stack map, mini mode | New surfaces, after the basics are consistent |

## 8. Before committing

- Mock the three directions (Rack, Blueprint, Phosphor) as clickable prototypes of the main window and the inspector drawer, and pick one.
- Decide the window controls question at the same time: the current macOS-style dots were a deliberate choice; a custom look in the chosen direction may replace them.
- Check the chosen direction at the 900x560 minimum size and in the light theme before building components.
