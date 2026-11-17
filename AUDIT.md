# StackConsole audit (2026-11-17)

Scope: all of `main.js`, `main/*`, `preload.js`, `services/stream_worker.py`, the renderer's log and state code, the roadmap (`.design-engine/suggestions.json`) and the campaign handoff.

How it was checked: code reading, `node --check` on every JS file (all pass), `npm audit` (0 vulnerabilities), and two live runs of the stream worker on macOS. The Electron app itself was not launched (no `node_modules`, Windows-only build). For sections 7-8 the real renderer files were loaded in a browser with a stubbed `window.api` and sample data (main window, Edit command, Project manager, at 1100x700 and the 900x560 minimum); that shows layout and copy, not live behaviour.

## 1. Problems (most severe first)

| # | Problem | Where | Status |
|---|---|---|---|
| P1 | **Output that isn't valid UTF-8 kills log capture.** The reader thread dies on the first bad byte; later output is lost, and a long-running service will hang once its pipe fills. Windows tools that print in the console code page (php, cmd, older CLIs) hit this. | `services/stream_worker.py` `Popen(... encoding='utf-8')`, no `errors=` | Reproduced |
| P2 | **Every `>` splits a log line.** The Windows-prompt heuristic runs for services too, so `App->handle() => 200 <div>ok</div>` arrives as 4 fragments plus a blank line. Each fragment is its own row, timestamp and level; ready-line matching and the 5,000-line cap are affected as well. PHP stack traces and HTML are the worst cases. | `services/stream_worker.py:92` | Reproduced |
| P3 | **A corrupt `projects.json` is silently replaced with an empty one.** Writes are not atomic, so a crash or power loss mid-write leaves a truncated file, and the next read wipes every project. | `main.js:252-260` (read), `main.js:271` (write) | From code |
| P4 | **The app cannot quit unless you use its own Quit.** The main window's `close` is always cancelled unless the in-app flag is set, and there is no `before-quit` handler. An installer upgrade or OS-initiated quit is blocked, and services are not stopped on that path. | `main.js:1392-1399` | From code |
| P5 | **Add/Edit command saves into whichever project is active at submit time**, not the one the window was opened for. Switch project while the window is open and an edit is silently dropped, or a new command lands in the wrong project. | `src/components/modals/edit-command.js:26`, `add-command.js:20` | From code |
| P6 | **Windows save the whole database back** (`db-set`), so a window holding an older copy can undo changes made elsewhere (pins, hidden repos, master folders). | `main.js:1547`, Project Manager's `dbContext` | From code |
| P7 | **Duplicating a command loses its secrets.** The copy gets a new id, so the stored encrypted value is not found; the copy starts with "Secret X could not be decrypted and was skipped". | `main.js:155-168`, `project-manager.js` duplicate | From code |
| P8 | Multi-byte characters can be garbled when a chunk boundary falls inside one (`data.toString()` per chunk). | `main.js:439` | From code |
| P9 | A failed spawn after the startup delay, and a wait that times out, don't block the services waiting on them; those sit in "waiting" until their own 60s timeout. | `main.js:706-709`, `main.js:625-630` | From code |
| P10 | Project relink matches the old folder by prefix without a separator, so `C:\proj\app` also rewrites paths under `C:\proj\app2`. | `main.js:1285` | From code |
| P11 | No handler for a crashed renderer (`render-process-gone`) or for uncaught main-process errors; either leaves a blank window with services still running. | `main.js` | From code |
| P12 | Tray icon has no click handler; only the right-click menu opens the app. | `main.js:1569` | From code |
| P13 | Default Electron menu is still active, so Ctrl+R reloads and Ctrl+W closes in the packaged app. | no `Menu.setApplicationMenu` | From code |
| P14 | `open-external` tests the URL with an unanchored pattern; `https://other.site/#http://localhost:1` passes. Low risk today (URLs come from main), but worth anchoring. | `main.js:842` | From code |
| P15 | macOS/Linux: stopping a service only kills the Python worker, not the service's own children (no process group, job object is Windows-only). Only matters if the app goes cross-platform. | `main.js:457-468` | From code |

## 2. Performance

| # | Finding | Where |
|---|---|---|
| F1 | **Every status change rebuilds everything.** `setRuntime` → `broadcastState` → reads and parses `projects.json` from disk, stats every project and command folder, rebuilds the workspace, sends the full state to up to 7 windows and rebuilds the tray menu. "Start all" on 5 services does this 20+ times in a burst. Keep the config in memory and coalesce broadcasts to one per frame. | `main.js:136-140`, `280-331` |
| F2 | **One IPC message and one forced layout per log line.** The renderer reads `scrollHeight`, appends, then scrolls, for each line. A chatty service (test run, `npm install`) will stall the window. Batch in main (flush every ~50 ms) and append once per animation frame. | `main.js:350`, `src/main.js:1591-1630` |
| F3 | The worker reads one character at a time and flushes a JSON line per fragment (worse with P2). | `stream_worker.py:80-110` |
| F4 | `taskkill` runs synchronously on the main thread for every stop and every exit, so "Stop everything" freezes the UI for N kills in a row. | `main.js:461` |
| F5 | The renderer is limited to a 32 MB JS heap with a 1 MB young generation. It holds up to 5,000 lines per open log with no per-line length cap, so one service printing large JSON can crash the window (see P11). Measure, then raise to ~128 MB and cap line length. | `main.js:16` |
| F6 | The sidebar is rebuilt from scratch on every state message (45+ repos). Fine once F1 coalesces; otherwise diff by project. | `src/main.js:258-266` |
| F7 | `\r` progress bars become one row per update and push real output out of the 5,000-line cap. | `stream_worker.py:91` |
| F8 | Log trimming is `splice(0, n)` on a 5,000-item array for every line once full. Minor; a ring buffer or trimming in blocks of 500 removes it. | `main.js:348` |

## 3. Roadmap regressions and drift

- **Roadmap status is wrong.** S-001 (auto-restart) and S-002 (env vars) are still marked `new` in `suggestions.json`, but both are in the code (`main.js:492`, `main/env.js`). The handoff lists them as "built; live check pending", along with window controls (step 1) and the log find bar (step 7). Nobody has confirmed these four in the running app.
- **Regression step never finished.** Handoff step 8 is "in progress", and the suites it cites (20/20, 33/33, 27/27, importer 14/14) lived in a session scratchpad. None are in the repo; `npm test` is still the placeholder that exits 1.
- **One 8,404-line commit** (`4e1707f`) carries the module split, the UI redesign and the Python bundling together, with no tests alongside. Anything from sections 1-2 could have arrived with it and there is no way to bisect.
- **Docs describe an older app.** README says Python must be on PATH (it is bundled now), lists none of the features since beta.1, and links two different repo names. `GUIDE.md` has no `main/` folder and shows a `release/` folder that is gitignored.
- **Missing references.** `.design-engine/project.json` points at `obsidian/Architecture.md` and `video/src/theme.ts`; both folders are gitignored and absent here, so the architecture notes and decisions don't travel with the repo.
- **Upcoming items with a hidden cost:**
  - S-015 / S-016 (second log): the main log and `LogView` are two separate append implementations. Merge them into one class first, or every log fix (F2, P2) is done twice.
  - S-008 (stack file in the repo): must exclude secrets and absolute paths; also needs the schema version below.
  - S-009 (restore what was running): depends on P4, since today a non-app quit never records or stops anything.

## 4. Improvements to apply

1. Worker: `errors='replace'`, prompt heuristic only for the shell, flush partial lines on a short idle timer instead (fixes P1, P2, F3, F7).
2. Config store: one in-memory copy, atomic write (temp file + rename), keep `projects.json.bak`, move an unreadable file aside instead of overwriting, add a `version` field for migrations (fixes P3, most of F1).
3. Replace whole-database saves with small intent calls (`command-add`, `command-update`, `project-delete`), each naming its project; windows receive `projectId`/`commandId` when opened (fixes P5, P6, P7 and removes the "active project" coupling).
4. Quit path: `before-quit` sets the flag and stops everything; add tray click, `render-process-gone` reload, and remove the default menu in packaged builds (P4, P11-P13).
5. Batch logs and coalesce state broadcasts (F1, F2); async `taskkill` (F4).
6. Commit the test suites and wire `npm test`; add a CI run on Windows.

## 5. Features for the long run

- **Tests + CI in the repo** (engine with mock Electron and real Python, importer, regroup, roots). Prerequisite for everything else.
- **Auto-update** (electron-updater + GitHub Releases); there is no update path after install.
- **Drop the Python worker** for a Node implementation (or node-pty). Removes the bundled runtime, the per-character reader and most of the ~200 MB install; a pty also gives real colours and progress bars.
- **Schema version and migrations** for `projects.json`.
- **Cross-platform** (macOS/Linux process groups, shell choice) if the audience grows beyond Windows.

## 6. Features that help users

- Already on the roadmap and still worth doing: S-009 restore on launch, S-008 stack file, S-014 Ctrl+1-9, S-011 set up several repos, S-016 remembered log pairs.
- **Type into a running service** (answer "port in use, use another? y/n"); stdin is wired in the worker but only the shell uses it.
- **Save or export a log to a file**, and optionally keep the last run's log after a restart.
- **Named groups inside a project** ("backend only", "full stack") to start a subset.
- **CPU and memory per service** in the Everything-running panel.
- **Health check URL** as a ready signal alongside port and log line.
- **Bright ANSI colours (90-97) and 256-colour codes**; Vite and chalk output currently renders partly uncoloured.
- **Shell per project** instead of one shared session that keeps the first project's folder.
- **Start with Windows**, minimised to tray.

## 7. Design flaws (architecture)

| # | Flaw | Effect |
|---|---|---|
| D1 | **A global "active project" decides where tool windows read and write.** Add, Edit, Import and Rename all act on it rather than on the project they were opened for. | Source of P5; the Edit window also falls back to the *first* command when no target is set, so it can open the wrong command without saying so (seen in the harness). |
| D2 | **Windows own the data.** They fetch the whole config, mutate it and send it back; main only strips fields. | P6, P7; no validation point; every new field risks being lost by an older window. |
| D3 | **Every dialog is its own OS window** (6 extra `BrowserWindow`s). They are not modal to the main window, can hide behind it, and each is a full renderer process. | Works against the memory flags at the top of `main.js`; forces D1 because the window can't be handed its target. In-window dialogs (already used for confirms and menus) would remove both. |
| D4 | **State is recomputed, not stored.** Folder health, git branch, placement and colours are derived from disk on every broadcast. | F1. A cached model updated by events (file watcher, process events) is the fix. |
| D5 | **Polling instead of watching**: a 5 s timer stats every folder and HEAD; a 1 s timer polls ports. | Idle CPU and disk wake-ups in a tray app; branch changes show up to 5 s late. |
| D6 | **Two log views with separate code**, and a 2,000-line `src/main.js` of module-level globals. | Every log fix is done twice; hard to test. |
| D7 | **A Python sidecar per service** just to read pipes and hold a job object. | One extra process per service, per-character reads, a bundled runtime, and the bugs in P1/P2. |
| D8 | **No difference between a service and a task.** `migrate`, `build` and `test` are modelled as long-running services, so a clean exit reads as "Stopped" and "Start all" runs them. | Imports pre-tick only servers to work around it; users can't keep one-off commands next to their services. |
| D9 | **No config version, no single writer.** | P3; blocks S-008 (stack file) and any future migration. |
| D10 | **Engine and UI are one process.** | A UI crash or quit ends every service; no CLI or editor integration can talk to it. |

## 8. UI/UX, hierarchy, usability, developer ease

Seen in the rendered screens unless marked (code).

**Hierarchy**
- **The tree is strictly A-Z**, so a broken, unused project ("Folder not found" + two buttons, about 100 px) sits above the project you are working in, which is pushed below the fold at the minimum window size. Running and crashed projects should float up; a missing-folder project should collapse to one line.
- **Edit command leads with a 43-icon grid.** The command itself, the one required field, is below it; start order and environment are off-screen. Put Command and Working directory first, collapse the icon to a single picker button, fold "Start order" and "Environment" into closed sections.
- **Two places manage projects**: the tree's "..." menu (13 items) and the older Project manager window (dropdown, Rename, Archive, Delete, Duplicate). Delete and Duplicate exist only in the second; Split, Combine, Pin and Colour only in the first. Pick the tree and retire the window.
- **The project menu mixes daily and rare actions** in one list (Open folder next to Split/Combine/Archive). Group the rare ones under "Organise".
- The footer repeats the counts the sidebar and the "Everything running" toggle already show.

**Usability**
- **Fragmented log rows** (P2) are the most visible defect: one stack-trace line becomes four rows.
- **Bright ANSI colours (90-97) render uncoloured**; the Vite-style `ready` line came out plain.
- **"Changes apply the next time the service starts"** with no "Save and restart" on a running service.
- **Window controls are macOS-style dots on the right** with glyphs only on hover. This was a deliberate choice; the cost is that Windows users get no close/minimise affordance by shape, and colour alone carries the meaning.
- **Copy is Windows-specific** ("Show a Windows notification", "%NAME%") (code) and will need a pass if other platforms are added.
- Secondary text is 11 px grey throughout the sidebar; legible, but the densest information (status, port, branch) is in the smallest type.
- **No undo** for Delete project or Remove command (code); a confirm is the only guard.

**Developer ease**
- **Keyboard**: only Ctrl+F, Ctrl+B and tree arrows exist. No start/stop/restart keys, no command palette (Ctrl+K: "restart api", "go to vite"), no project jump (S-014).
- **Logs are not actionable**: URLs and `file:line` in stack traces are plain text. Click-to-open in the browser or in VS Code at the line is the single biggest time-saver available.
- **No line-wrap toggle, no export**, no search across all services.
- **No CLI** (`stackconsole up automart`, `stackconsole logs api`) and no config file in the repo (S-008), so the setup is click-only and per machine.
- **Onboarding is good**: master-folder scan, one-click "Set up", import from manifests. The gap is after setup: missing `node_modules` or `vendor`, a missing `.env`, or a wrong runtime version only surface as a crash.

## 9. Security

The app runs arbitrary commands by design, so the question is what widens that beyond "what the user typed".

| # | Concern | Detail | Severity |
|---|---|---|---|
| X1 | **Repo-supplied commands run on one click.** "Set up" creates a project from a cloned repo's scripts and "Start all" runs them. Same trust as `npm run`, but S-008 (stack file in the repo) would make it "open a repo, press Start". | Show the commands and require a per-repo confirmation the first time; never auto-start from a repo file; flag a stack file that changed after a pull. | High once S-008 lands |
| X2 | **Secrets can appear in logs, the clipboard and notifications' neighbours.** Values are encrypted at rest and kept from windows, but output is not masked. | Redact known secret values in `appendLog`; that also covers Copy. | Medium |
| X3 | **Plaintext fallback for secrets** when OS encryption is unavailable, in a file with default permissions. | Already warned in the UI; consider refusing to store instead, or restrict the file's ACL. | Medium |
| X4 | **Unsigned installer, no auto-update, no Electron fuses.** No code-signing config; users stay on whatever Electron shipped; `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` are not disabled, and there is no asar integrity. | Sign, add an updater, set fuses in electron-builder. | Medium |
| X5 | **The bundled Python is downloaded without a checksum** at build time. | Pin a SHA-256 in `build/fetch-python.js`. | Medium (supply chain) |
| X6 | **Services inherit StackConsole's whole environment**, including anything in the launching shell (cloud credentials, tokens). | Expected for a dev tool; offer a "clean environment" option per command. | Low |
| X7 | **No warning when a service listens on all interfaces.** `0.0.0.0` is rewritten to `localhost` for display, which hides that the dev server is reachable from the network. | Show an "exposed on LAN" badge. | Low-Medium |
| X8 | **"Stop that process" kills any PID that holds the port**, tree-wide and forced. | Confirmation exists; add the full path and owner, and refuse system processes. | Low |
| X9 | **IPC handlers don't check the sender**, `db-set` takes any object, `project-set-folder` and `folder-info` take any path. | Low today: windows only load local files, navigation and new windows are blocked, CSP forbids remote scripts and all network. Becomes real if a window ever loads remote content. | Low |
| X10 | The `.env` path check uses `path.resolve`, not the real path, so a link inside the project can point outside it. Same for P14. | Resolve links first. | Low |
| X11 | Default menu leaves DevTools reachable in the packaged app (P13); no `setPermissionRequestHandler`. | Remove the menu; deny all permission requests. | Low |

Already done well: sandboxed, context-isolated windows; strict CSP; secrets never sent to a window; folders resolved in main from saved config; folder pickers owned by main; no shell when opening VS Code or a terminal; log text escaped before it becomes HTML; logs never written to disk.

## 10. Tech stack

What the app needs: reliable process trees, a real terminal, low idle memory (it lives in the tray), a small installer, tray, notifications, updates.

| Option | Fit | Cost |
|---|---|---|
| **Tauri 2 (Rust core, keep the current HTML/CSS/JS UI)** | **Best long-term fit.** The renderer has no framework or bundler, so it ports almost as-is. Rust gives a proper supervisor (tokio processes, ConPTY via `portable-pty`, Windows job objects, file watching instead of polling, per-process CPU/RAM) and Tauri ships tray, single-instance, notifications, autostart and a signed updater. Installer drops from ~200 MB to roughly 10-15 MB and idle memory falls sharply because it uses the system WebView2. | Rewrite of the ~2,300-line main process in a harder language; WebView differences if macOS/Linux are added. |
| **Stay on Electron, replace Python with `node-pty`, render logs with xterm.js** | **Best next step.** Removes D7, P1, P2, F3, F7 and the bundled runtime; a real terminal handles colours, `\r` progress bars and interactive prompts. Roughly a fifth of the Tauri effort. | Native module to build per Electron version; memory stays Electron-sized. |
| Wails (Go core, same UI) | Same shape as Tauri with an easier language; good process handling. | Smaller ecosystem for ConPTY, tray and updater. |
| Rust or Go terminal UI (ratatui, Bubble Tea) | A different product (like `mprocs` or `process-compose`): tiny and fast, but loses the tree, forms and onboarding. | Not a replacement; useful as a second front end. |
| .NET/WinUI, Qt, Flutter | Native, but the whole UI is rebuilt and Windows-only remains. | Not recommended. |

**Decided 2026-11-17:** the target is **Tauri 2 with a Rust core**, and the engine is built as a **headless service with a small API** (start, stop, status, log stream) that the UI, a CLI and later integrations use. The design work is planned separately in `DESIGN-PLAN.md`.

Original recommendation, kept for context: do the Electron + `node-pty` step now, and shape it as a **headless engine with a small API** (start, stop, status, log stream). That boundary is what a later Rust core, a CLI and an editor or AI integration all plug into, and it fixes D10. Move the engine to Rust under Tauri once the tests in section 4 exist to port against.

## 11. Adjacent sectors worth covering

Ordered by fit with the goal "one place to run and watch a local stack".

**Repository and branching** (today: branch name only, read from `.git/HEAD`)
- Dirty / ahead / behind counts and a Pull button per repo.
- **After a branch switch or pull**: "lockfile changed, run install?", "new migrations, run them?", "restart affected services?". This is the daily failure the app is best placed to catch.
- Worktrees: run the same project from two worktrees on different ports (the scan already recognises worktrees).
- Ticket link from the branch name (the UI already preserves ids like `QP1522`).
- PR and CI status for the current branch through the `gh` CLI if installed.

**Database**
- Read `DB_CONNECTION` / `DATABASE_URL` from the service's `.env` and show the database as a dependency with its own status dot (port check exists already).
- One-click tasks: migrate, seed, fresh; a "pending migrations" badge.
- Open in the installed client (TablePlus, DBeaver, HeidiSQL); do not build a client.
- Later: per-branch snapshot and restore.

**Environment and runtime checks**
- `.env` vs `.env.example`: missing keys listed before start.
- Missing `node_modules` / `vendor` / virtualenv: offer the install as a task.
- Runtime version mismatch against `.nvmrc`, `.php-version`, `.python-version`, `engines`.

**Third-party and local services**
- **Docker Compose**: import services from `compose.yaml` and show containers as services. The largest gap against comparable tools.
- **Tunnels** (ngrok, cloudflared): detect and show the public URL; today only local URLs are recognised.
- Local stacks: detect Laragon, XAMPP or Herd and their MySQL/Redis.
- Webhook and mail helpers (Stripe CLI, Mailpit) as ready-made command templates.

**Developer tooling**
- **Tasks alongside services** (D8): test, lint, build, with last result and duration.
- **CLI** over the engine API, and a **stack file** in the repo (S-008, with X1's guard).
- **MCP server** over the same API so an AI coding assistant can list services, read recent logs and restart one. Small to build once the engine API exists.
- A port map of everything listening, and search across all logs.
