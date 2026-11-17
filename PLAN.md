# StackConsole v2: plan record

Everything done and decided on the StackConsole rework, from the first look at the project to now. Last updated 2026-11-17 (Phase C: engine and Tauri app running on macOS).

This is the overview. The detail lives in two companion files:

| File | Holds |
|---|---|
| [AUDIT.md](AUDIT.md) | Every finding, with file and line references (sections 1-11) |
| [DESIGN-PLAN.md](DESIGN-PLAN.md) | Visual direction, themes, motion, and where each section of the UI goes |
| `.design-engine/suggestions.json` | The existing feature roadmap (S-001 to S-016) |

## 1. What StackConsole is

A desktop dashboard that starts, watches and stops the local services a project needs (PHP Artisan, Vite, Node, Python and so on) from one window, with live logs, port and status tracking, and a tray icon.

Today it is an Electron app with a plain HTML/CSS/JS interface, a Python helper process per service for reading output, and a Windows-only build (version 1.0.0-beta.1).

## 2. Timeline

All on 2026-11-17.

| Step | What happened | Result |
|---|---|---|
| 1 | Looked for the project. It was not on this machine yet; only a "StackConsole Banner Concepts" artifact existed. | Project then placed at `prototypes/stack-console-v2` |
| 2 | **First audit**: problems, improvements, long-run features, user features, performance, roadmap regressions. Read the whole main process, the Python worker, the roadmap and handoff, and the renderer's log and save paths. Ran the worker against tricky output. | `AUDIT.md` sections 1-6 |
| 3 | **Second audit**: other tech stacks, design flaws, UI/UX and developer ease, security, and adjacent sectors (database, repository, branching, third-party services, dev tools). Rendered the real screens in a browser with sample data. | `AUDIT.md` sections 7-11 |
| 4 | **Decisions** on stack and architecture (section 4 below). | Recorded in `AUDIT.md` section 10 |
| 5 | **Design plan**: visual identity, themes, components, motion, overlay rules, and a section-by-section map of what lives where. | `DESIGN-PLAN.md` |
| 6 | This record. | `PLAN.md` |
| 7 | **Phase C started**: Rust installed, engine crate `engine/` built with tests, engine API drafted. | `engine/`, `docs/ENGINE-API.md`, checklist below |
| 8 | **Engine API approved**; all handlers ported; file/git watching; Tauri app (`src-tauri/`) running the current interface through `src/tauri-api.js`. Checked on macOS with 78 engine tests and an in-app self-test (15/15). | `engine/`, `src-tauri/`, `src/tauri-api.js`, section 10 |
| 9 | **Phase B**: B-2 (specific requests; P5-P7 fixed), B-8 (one log view), B-7 (semantic and motion tokens), B-3 (overlay primitives). Stopped after B-3; B-4 to B-6 reverted. First commit of the rework. | `src/`, `engine/src/engine/handlers.rs`, checklist |

Steps 1-6 changed no application code. Step 7 changed `services/stream_worker.py` (P1/P2 reference fix) and added the Rust workspace (`Cargo.toml`, `engine/`) and `docs/ENGINE-API.md`; the Electron files stay until the Tauri app reaches parity.

## 3. What the audits found

Counts and the items that drive the plan. Identifiers (P1, F1, D1, X1, V1) match the companion files.

| Area | Count | The ones that matter most |
|---|---|---|
| Problems | 15 | **P1** non-UTF-8 output kills log capture · **P2** every `>` splits a log line · **P3** a corrupt config file is replaced with an empty one · **P4** the app can only quit through its own Quit · **P5** Add/Edit command saves into whichever project is active |
| Performance | 8 | **F1** every status change re-reads the config from disk and rebuilds everything · **F2** one message and one forced layout per log line · **F4** stopping services blocks the main thread |
| Roadmap drift | 5 | S-001 and S-002 are built but marked `new` · the test suites were never committed · the last commit is 8,404 lines with no tests · the README describes an older app |
| Architecture flaws | 10 | **D1** a global "active project" · **D2** windows own the data · **D3** every dialog is a separate OS window · **D7** a Python process per service · **D10** engine and UI are one process |
| Security | 11 | **X1** repo-supplied commands run on one click · **X2** secrets can appear in logs · **X4** unsigned installer, no updates · **X5** bundled Python downloaded without a checksum |
| Visual design | 9 | **V1** no visual identity · **V2** one theme · **V3** almost no motion · **V7** inconsistent overlays · **V8** the log pane gets the least design |

How much of this is confirmed:

- **Reproduced by running code:** P1 and P2 (the Python worker, run on macOS).
- **Seen in rendered screens:** the UI and visual findings, using the real interface files with sample data. That shows layout and copy, not live behaviour.
- **From reading the code only:** everything else. The Electron app itself has not been launched (it is a Windows build and its dependencies are not installed here).

## 4. Decisions made

| # | Decision | Why |
|---|---|---|
| 1 | **Move to Tauri 2 with a Rust core.** | The interface has no framework or bundler, so it carries over almost unchanged. Rust gives proper process supervision, a real terminal, and file watching instead of polling. The installer and idle memory shrink considerably (estimated, not measured). |
| 2 | **Build the engine as a headless service with a small API** (start, stop, status, log stream). | The interface, a command-line tool, and later editor or AI integrations all use the same API. A crash in the interface no longer ends the services. |
| 3 | **Keep the design work as its own plan.** | Visual direction and layout are separate from the engine work and can proceed in the current interface. |
| 4 | **Go straight to the Rust engine; do not fix the Electron build first.** (2026-11-17) | The main process and Python worker are being replaced, so fixes there would be thrown away. Phase A's Electron fixes are dropped except where the code survives (the interface). |

## 5. Still to decide

| # | Question | Notes |
|---|---|---|
| 1 | ~~Fix the Electron version first, or go straight to Rust?~~ | **Answered: straight to Rust** (decision 4). |
| 2 | **Which art direction?** | Three proposed: "Rack" (recommended), "Blueprint", "Phosphor". The plan is to mock them side by side before choosing. |
| 3 | **Window controls.** | The macOS-style dots were a deliberate earlier choice; the chosen art direction may replace them. |
| 4 | **Windows only, or macOS and Linux too?** | Affects the engine design (process groups, shells) and all the Windows-specific wording. |
| 5 | **Which adjacent features, and in what order?** | Git awareness, database, environment checks, Docker Compose, tunnels, command-line tool, stack file, AI integration. See `AUDIT.md` section 11. |

## 6. Target shape

```
            ┌─────────────────────────────────────┐
            │  Engine (Rust, headless)            │
            │  processes · terminals · ports      │
            │  config store · git and folder watch│
            └───────────────┬─────────────────────┘
                            │  small API: start, stop, status, log stream
        ┌───────────────────┼───────────────────┬──────────────┐
        ▼                   ▼                   ▼              ▼
   Desktop UI          Command line        Editor / AI     Mini mode
   (Tauri window,      tool                integration     window
   current HTML/CSS/JS)
```

What changes compared with today:

- The Python helper goes away; the engine reads output through a real terminal.
- The config has one owner (the engine), is written atomically, and carries a version.
- The interface sends small, specific requests ("update this command in this project") instead of saving the whole config back.
- Dialogs live inside the main window instead of in six separate ones.

Only the four API verbs are agreed. The exact request and event shapes are not designed yet.

## 7. Proposed order of work

This sequence combines the engineering and design plans. It is a proposal and depends on the open questions above.

| Phase | Work | Closes |
|---|---|---|
| **A. Safety net** | Commit the test suites and wire `npm test`. Correct the roadmap statuses and README. If the Electron build stays in use: fix P1-P4. | Roadmap drift; P1-P4 |
| **B. Draw the boundary** (in the current app) | Define the engine API. Change the interface to specific requests naming their project. Build the overlay primitives (modal, drawer, popover, toast) and move the six windows into them. Add semantic and motion tokens. | D1, D2, D3, P5-P7, V7 |
| **C. Rust engine under Tauri** | Process supervisor, terminals, process-tree cleanup, config store, watchers, batched log and status events. Port the interface. Signed installer and updater. | D4, D5, D7, D9, D10, F1-F8, X4, X5 |
| **D. Layout and look** | Bottom dock for Shell and "Everything running", inspector drawer for commands, retire Project manager, tree ordering. Then the chosen art direction, themes, and the log redesign. | V1-V6, V8, V9 and the UX findings |
| **E. Reach** | Command-line tool, stack file in the repo (with the first-run confirmation from X1), secret masking in logs, then the adjacent features chosen in question 5. | X1, X2, roadmap S-008, S-009 |

Phases B and D can overlap with C, because the interface work is done in plain HTML/CSS/JS and moves across unchanged.

## 8. Immediate next steps

Updated 2026-11-17, after the Tauri app first ran on macOS.

1. **Phase B, continuing.** B-2 (P5-P7 fixed) and B-8 (one log view) are done. B-7 (tokens) and B-3 (overlay primitives) done; **stopped after B-3 at the owner's request (2026-11-17)**. B-4 to B-6 had been started past that point and were reverted. Next in Phase B: B-4 (command drawer), B-5 (New project / Import modals, inline rename), B-6 (retire Project manager), all on top of `window.overlay`.
2. **Answer open questions 2-5** (section 5). Question 4 (Windows only, or macOS/Linux too) decides how much goes into Windows CI versus macOS polish.
3. **Windows**: a CI job on Windows running `cargo test -p stackconsole-engine` and building the app. This replaces A-9 and closes C-W1, which can't be done from the Mac.
4. **Click-through (C-16)** of what the self-test can't reach: folder pickers, tray, notifications, the other tool windows, window controls. Needs screen access or a person.
5. **Re-scope Phase A**: A-1 to A-5 and X5 test or fix Electron/Python code that is being retired; the engine tests replace them. Still worth doing: A-6 (README), A-8 (roadmap statuses), U-1 (bright ANSI colours), F6, X11.
6. **Design (Phase D)** waits on the art direction (question 2).

## 9. Checklist

Legend: `[x]` done and checked · `[~]` changed in code, not yet checked in the running app · `[ ]` not started. Ids match `AUDIT.md` and `DESIGN-PLAN.md`. Update this list with every change.

For the Rust engine (Phase C), `[x]` on a P/F/D/X item means **verified by the engine's own tests running real processes on macOS** (`cargo test` in `engine/`). It does not yet mean checked inside the Tauri app or on Windows; those checks are their own items (C-1, C-W1) and each item notes what is left.

Work happens on the branch `rework/phase-a` (nothing committed yet).

Engine progress (2026-11-17): crate `engine/` (`stackconsole-engine`, no Tauri dependency) with 79 tests (50 unit, 19 supervisor with real processes, 10 handler), all passing on macOS; the engine type-checks for Windows (`cargo check --target x86_64-pc-windows-msvc`), not run there. Desktop app `src-tauri/` (binary `stackconsole`): debug and release builds on macOS (release binary 16 MB, no Python), 1 unit test, in-app self-tests 15/15 (Phase C), 9/9 (Phase B tool windows with their URL targets), 7/7 (logs) and 9/9 (overlay primitives); clippy clean across the workspace. API draft: [docs/ENGINE-API.md](docs/ENGINE-API.md). Manual run: `cargo run -p stackconsole-engine --example run -- "<command>" [seconds] [folder]`.

**Tauri app status (2026-11-17):** runs on macOS with the current interface and passes the in-app self-test; Windows build, installer and the clicks that need a screen are what is left before parity (C-W1, C-9, items marked `[~]`).

**Order changed by decision 4:** Phase C (Rust engine under Tauri) now comes first. Phase A items that live in the Electron main process or the Python worker are closed by the port, not fixed in place; they stay listed so the Rust engine is checked against each one. Only one Electron-side change was made before the switch: the Python worker fix for P1 and P2 (`services/stream_worker.py`, checked by running it), which is harmless and stays as reference behaviour.

### Phase A: safety net (current Electron app)

Tests and docs
- [ ] A-1 Test folder in the repo and `npm test` wired
- [ ] A-2 Tests: stream worker (bad bytes, `>` in output, shell prompt)
- [ ] A-3 Tests: config store (atomic write, backup, corrupt file kept)
- [ ] A-4 Tests: env, git, regroup, importer modules
- [ ] A-5 Tests: engine smoke test (stubbed Electron, real Python)
- [ ] A-6 README: Python is bundled; feature list; one repo URL
- [x] A-7 `GUIDE.md` matches the current folders (rewritten for engine/, src-tauri/, docs/, the shim)
- [ ] A-8 Confirm S-001 / S-002 in the running app, then mark them done in the roadmap
- [ ] A-9 CI run on Windows

Problems
- [x] P1 Non-UTF-8 output no longer kills log capture (Python worker fixed; Rust engine: lines decoded after assembly, bad bytes become `�`; tests `invalid_utf8_*`, `start_and_stop_with_correct_lines`)
- [x] P2 `>`, `->`, `=>` no longer split log lines (Python worker fixed; Rust engine splits on `\n` only, prompts flushed after 150 ms of quiet; tests `arrows_and_tags_*`, `start_and_stop_with_correct_lines`)
- [x] P3 Config: atomic write (temp + flush + rename), `.bak`, unreadable or empty file moved aside and never overwritten, backup loaded instead, `version` field (engine `config.rs`, 10 tests)
- [x] P4 Every quit path stops services and lets the app close: in-app Quit, an OS exit request (what Cmd+Q / shutdown send), tray Quit (same `quit()`); and a hard kill (`kill -9`) still ends the services because their terminals close. All checked in the running Tauri app on macOS with services running (no processes left). Windows: job objects do the hard-kill part (unverified, C-W1)
- [x] P5 Add/Edit command (and Rename, Import) save to the project they were opened for: the target travels in the window's URL and the save names it. Checked in the Tauri app: active project switched while Add command was open, the command still went to its own project
- [x] P6 Whole-config saves replaced by specific requests; the interface no longer calls `setStore` (kept in the API, deprecated)
- [x] P7 Duplicated command keeps its secrets: the engine copies the stored command, sealed values included (test `specific_requests_replace_whole_config_saves`)
- [x] P8 Multi-byte characters survive chunk boundaries (test `multibyte_character_split_across_reads_survives`; long lines cut on a character boundary)
- [x] P9 Failed spawn, crash, stop and wait timeout block their waiters at once, down the chain (tests `failed_dependency_*`, `crashing_dependency_*`, `wait_timeout_blocks_down_the_chain`)
- [x] P10 Relink matches the old folder on a path boundary (`paths::rebase`, used by project relink and master-folder change; tests `rebase_respects_separator_boundary`, `relink_moves_only_paths_inside_the_old_folder`)
- [~] P11 Crashed window: the Tauri window process (WKWebView / WebView2) is separate from the engine, so a crash no longer touches services; an automatic reload is not wired (Tauri has no crash event to hook), so the user reopens it from the tray
- [~] P12 Tray icon click opens the app (left click handler in `src-tauri/src/main.rs`; built, not clicked, since screen access was declined)
- [~] P13 Default menu: the Electron menu is gone. macOS keeps Tauri's standard app menu (needed for copy/paste); release builds have no DevTools. WebView2's own reload keys on Windows unverified
- [x] P14 `open-external` URL check anchored (`is_local_url` in the app; test `local_url_check_is_anchored`)
- [x] P15 macOS/Linux: stop kills the whole process group (pty session leader + `killpg`; test `stop_ends_the_whole_process_group`)

Performance
- [x] F1 Config kept in memory; state broadcasts coalesced: engine sends runtime changes once per 50 ms, the app turns each burst into one `db-refreshed` (no disk reads per change). Checked in the app: start order of 2 services gave 2 refreshes
- [x] F2 Log lines batched (engine) and appended per batch in the window (`onTerminalLogBatch`, `LogView.pushMany`). Checked in the app: 9 lines arrived in 3 batches
- [x] F3 Worker per-character reads: gone; the Tauri app reads terminals in 16 KB chunks and has no Python
- [x] F4 Stop never blocks: polite signal, forced kill after a 3 s grace in the background (tests: stop returns in < 100 ms, `stop_never_blocks_and_forces_after_grace`). Windows path (`TerminateJobObject`) unverified
- [x] F5 Per-line length cap (8 KB, cut on a character boundary); the 32 MB heap flag was Electron's and does not exist in Tauri
- [ ] F6 Sidebar no longer rebuilt per status change (covered by F1; diffing later)
- [x] F7 `\r` progress bars: a lone `\r` overwrites the line (test `lone_carriage_return_overwrites_progress`)
- [x] F8 Log trimming costs nothing per line (ring buffer of 5,000; test `ring_buffer_caps_and_keeps_counting`)

Security
- [x] X2 Secret values masked in logs (values of 4+ characters replaced by `••••••` before storing or sending; test `secret_values_are_masked_in_output`)
- [ ] X5 Checksum for the bundled Python download
- [x] X10 `.env` path resolved through links (test `env_file_link_pointing_outside_is_refused`)
- [ ] X11 Permission requests denied by default (camera/mic prompts of the WebView; not yet handled in Tauri)
- [ ] X1, X3, X4, X6-X9 (Phase C / E)
- [ ] C-16 Click through the parts the self-test can't reach without a screen: folder pickers, tray menu, notifications, the five tool windows besides Add command, window controls

Quick UI wins
- [ ] U-1 Bright ANSI colours (90-97)

### Phase B: draw the boundary (current app)
- [x] B-1 Engine API written down (requests and events): `docs/ENGINE-API.md`, approved by the owner 2026-11-17 together with the recommendations in its section 5 (terminal for services, secrets entered again once, login-shell PATH, 3 s stop grace)
- [x] B-2 Interface sends specific requests naming their project (closes P5, P6, P7; D1 and D2 for config changes): `addProject`, `renameProject`, `deleteProject`, `addCommand`, `updateCommand`, `removeCommand`, `duplicateCommand`, plus import with an explicit project. Tool windows open with `?projectId=&commandId=`; Edit never falls back to "the first command". Engine test + app self-test 9/9 (Add/Edit/Rename windows driven for real). The same handlers were added to Electron's `main.js`/`preload.js` so the shared interface keeps working there; that Electron code is unverified (not runnable here)
- [x] B-3 Overlay primitives (`src/util/overlay.js`, styles at the end of `src/index.css`, loaded in the main window): modal, drawer, popover, toast, tooltip, with the design plan's states (dirty: closing asks first and backdrop click does nothing; saving: primary button busy, inputs locked; error: message stays in the surface; focus trapped in modals and returned to the trigger; Esc; reduced motion). Transitions start without animation frames, so they work in a hidden window too. App self-test `b3`: 9/9 in three runs. Not used by any screen yet (that is B-4 to B-6)
- [ ] B-4 Add / Edit command moved into the inspector drawer. (Built past the agreed stop on 2026-11-17, then reverted at the owner's request; the B-3 primitives it needs are in place.)
- [ ] B-5 New project, Rename, Import moved in-window; six OS windows removed (D3). (Built and reverted, as B-4.)
- [ ] B-6 Project manager window retired. Its Delete project, Duplicate and Remove command need a new home first (tree and service menus). (Built and reverted, as B-4.)
- [x] B-7 Semantic colour tokens and motion tokens (`src/tokens.css`): `--surface-0..3`, `--text*`, `--border*`, `--accent*`, `--status-*`, `--elevation-1..3`, `--dur-fast/base/slow`, `--ease-standard/enter/exit`, as aliases of today's values; `index.css` moved onto them (about 230 uses; 18 raw-scale uses left where no semantic name fits yet). Checked in the app: computed styles of all 264 elements of the main window identical before and after. Only intended difference: the sidebar's open/close animation is 180 ms (was 160 ms). Themes (D-4) remap this layer
- [x] B-8 One log view class for both logs (D6): the main log now uses `util/log-view.js` like the log beside it, with hooks for the find bar and the crash banner; the old main-log code in `src/main.js` is gone. App self-test 7/7 (both logs, no mixing, levels, Clear, close beside) plus the earlier 15/15 and 9/9 still pass. Unblocks S-015 / S-016 (second log work)

### Phase C: Rust engine under Tauri
- [x] C-0 Rust toolchain installed: rustup, stable 1.100.0 (aarch64-apple-darwin) plus the Windows std for type-checking. Installed with `--no-modify-path`, so `cargo` is not on the shell PATH yet (C-0b)
- [ ] C-0b Add `. "$HOME/.cargo/env"` to the shell profile (owner's choice)
- [x] C-1 Tauri 2 app (`src-tauri/`, binary `stackconsole`) loads the current interface unchanged through `src/tauri-api.js` (injected, no HTML edits). Tauri app self-test (2026-11-17, `STACKCONSOLE_SELFTEST`, debug builds only: a script run in the real main window through the shim and IPC): 15/15 checks pass: all 60 `window.api` methods present, config through IPC, tree rendered, start order, `App->handle() => 200 <div>ok</div>` as one row, UTF-8 + colour, live batches, crash policy, port check, Add command window, shell input, folder info, Stop everything, Quit. Windows build not yet run
- [x] C-2 Process supervisor: start, stop, restart (waits for the old run to exit so its port is free), start/stop project, stop everything, startup delay and cancel, input to a running service, tree cleanup (Unix process groups; Windows job objects written, unverified). 19 real-process tests
- [x] C-3 Terminal-based output capture (portable-pty; replaces the Python worker): line splitting, encoding, colour kept, cursor/title codes removed, prompts. macOS pty verified; ConPTY unverified (C-W1)
- [x] C-4 Crash policy (2, 4, 8 ... 30 s, limit 1-10, reset after 60 s, notices), start order with cycle check, readiness by local URL, by port (probed only while waited on) and by ready line (tests `crash_policy_*`, `start_order_*`, `ready_by_port`, `ready_line_wins_over_url`)
- [x] C-5 Config store with version and migrations (D9): version 0 (Electron) → 1 drops saved runtime fields; a newer version opens read-only; unknown fields kept on round trip
- [x] C-6 File and git watching instead of polling (D4, D5): non-recursive watches on project/command folder parents, git folders and master folders (+ their first level); debounced 250 ms; `FoldersChanged` only when existence or a branch changed; master folders rescanned on change; one fallback pass a minute instead of every 5 s (test `watches_branches_folders_and_master_folders`: branch switch, deleted folder, new clone). Ready-by-port stays a probe, and only while something waits
- [x] D10 Engine apart from the UI: headless crate with no Tauri dependency (used by tests, a CLI example and the app); the window runs in its own WebView process, and killing the app still ends services cleanly
- [x] C-7 All 57 handlers ported: engine requests for every engine handler (8 handler tests), app-side window controls, the six tool windows, folder pickers, open-external, quit, minimize to tray. Mapping table in `docs/ENGINE-API.md` section 6. Folder pickers and the five other tool windows were not clicked through (no screen access); Add command opening was checked
- [~] C-8 Tray (menu built from state: running services, Show, Stop everything, Quit; left click opens), crash notifications (only when the window isn't in front; no log text), single instance (checked: a second launch exits in 1 s, the first keeps running). Tray and notifications built but not seen (no screen access). Autostart was never in the Electron app; left for E/D as a new feature
- [ ] C-9 Signed installer and updater (X4)
- [ ] C-W1 Run the engine tests and the app on Windows: ConPTY output, job objects, Ctrl+C on stop, the `%STACKCONSOLE_COMMAND%` way of passing a command line to cmd.exe, WebView2. From this Mac the engine type-checks for Windows; the app does not cross-check because its build needs the Windows resource compiler (`llvm-rc`)
- [~] C-10 Secret store in the app: AES-256-GCM, key in the OS credential store (`src-tauri/src/secrets.rs`), read only when a secret is saved or used. Engine side tested with a fake store; the keychain itself not exercised here (it would prompt on this machine). Electron `safeStorage` values must be entered again once
- [x] C-11 macOS/Linux: `PATH` read from the login shell at start. Checked: launched through `open` (launchd's minimal PATH), the app's shell had the nvm and Homebrew paths
- [x] C-12 Shared shell on a terminal: input reaches it, no extra `$ text` line, Stop everything leaves it open (engine test, and checked in the app)
- [x] C-13 stderr tint: decided, terminal for services (API doc section 5); error lines are still found by text
- [x] C-15 Helper modules ported to Rust with tests and wired to the handlers: `paths.rs` (keys, command folder, relink, P10 boundary-safe rebase), `identity.rs` (output identical to `main/identity.js` on a reference set), `importer.rs` (output identical to `main/importer.js` on `engine/tests/fixtures/import-tree`), `roots.rs` (scan, workspace placement, suggest, overlap), `regroup.rs` (split / combine). 49 unit tests pass
- [x] C-14 Engine snapshot for the windows: secrets reduced to `hasValue`, runtime merged, folder/git fields, relink suggestions, identity, workspace (roots, placement, first-run prompt), `secretsEncrypted`, `activeCommandToEdit` kept in memory only. `saveConfig` seals secrets and keeps untouched ones (test `save_config_seals_secrets_and_snapshot_hides_them`)

### Phase D: layout and look
- [ ] D-1 Art direction chosen (Rack / Blueprint / Phosphor mockups)
- [ ] D-2 Bottom dock: Shell and Everything running
- [ ] D-3 Tree ordering: active projects first, missing-folder collapsed
- [ ] D-4 Themes: Dark, Light, High contrast, Dim; log palette
- [ ] D-5 Status light, signal trace, panels, typography
- [ ] D-6 Motion pass
- [ ] D-7 Log redesign: gutter, clickable links, folded traces, tabs
- [ ] D-8 Command palette, Stack map, mini mode
- [ ] D-9 Settings page

### Phase E: reach
- [ ] E-1 Command-line tool
- [ ] E-2 Stack file in the repo, with first-run confirmation (S-008, X1)
- [ ] E-3 Restore what was running (S-009)
- [ ] E-4 Git awareness: dirty / ahead / behind, after-pull prompts
- [ ] E-5 Environment checks: `.env` keys, missing installs, runtime versions
- [ ] E-6 Database status and one-click tasks
- [ ] E-7 Docker Compose import, tunnels
- [ ] E-8 AI assistant integration over the engine API

## 10. Handover: how to pick this up

Updated 2026-11-17 at the end of the session. Branch `rework/phase-a`, committed and pushed (one commit on top of `4e1707f`).

**Where things stand**
- Phase C (Rust engine under Tauri): the engine and the desktop app run on macOS with the current interface; all 57 handlers ported. Left: Windows (C-W1), click-through of tray / pickers / notifications (C-16), keychain check (C-10), installer and updater (C-9, out of scope so far). See the checklist.
- Phase B: B-1, B-2, B-3, B-7, B-8 done. Next: B-4, B-5, B-6.
- Phases A (re-scope), D (needs an art direction) and E: not started. Open questions in section 5.
- The Electron app is still in the repo. It got the same B-2 handlers (`main.js`, `preload.js`) so the shared interface keeps working there, but none of the Electron code was run on this machine.

**Toolchain.** Rust via rustup (stable 1.100.0), installed with `--no-modify-path`: run `export PATH="$HOME/.cargo/bin:$PATH"` (or add `. "$HOME/.cargo/env"` to the shell profile, C-0b). Node 16 is only needed for the old Electron app and for regenerating the JS reference outputs below.

**Commands** (from the repo root)

```bash
cargo test --workspace                       # 79 engine tests + 1 app test (macOS/Linux)
cargo run -p stackconsole-app                # the desktop app (debug), uses the OS app-data folder
STACKCONSOLE_DATA_DIR=/some/dir cargo run -p stackconsole-app   # with a throwaway project list
cargo run -p stackconsole-engine --example run -- "npm run dev" 5 path/to/project
cargo build --release -p stackconsole-app    # 16 MB binary in target/release/stackconsole
```

The interface in `src/` is embedded into the app at build time: rebuild after changing it.

**Where things are**: folder map in `GUIDE.md`; engine requests, events and the `window.api` -> request table in `docs/ENGINE-API.md`.

**How it was verified**
- Engine: `engine/tests/supervisor.rs` (real processes: lines, stop, process groups, crash policy, start order, masking, batching, shutdown), `engine/tests/handlers.rs` (every window request, watching, the B-2 specific requests), unit tests per module.
- Parity with the old JS: `identity.rs` and `importer.rs` compare against outputs produced by `main/identity.js` and `main/importer.js` (`engine/tests/fixtures/import-tree.expected.json`; regenerate with Node if the fixture changes).
- App: debug builds accept `STACKCONSOLE_SELFTEST=<file.js>`, which runs that script in the real main window once it loads; scripts report through the `selftest_report` command (printed as `[selftest] ...`, `done: true` quits the app) and can run code in another window with `selftest_eval(label, script)`. The scripts used on 2026-11-17 lived in the session scratchpad, not the repo: Phase C (15 checks, listed under C-1), Phase B tool windows (9), logs (7), overlay primitives (9), and a computed-style comparison for B-7. Rewrite them from the checklist entries if needed. Screen access to the app was declined, so nothing visual was looked at.

**Known gaps** (all in the checklist): Windows not run (C-W1; the app can't be cross-checked from macOS without `llvm-rc`), click-through (C-16), keychain secret store not exercised (C-10), P11 window reload, X11 permission prompts, installer/updater (C-9).

**Picking up B-4 to B-6**: use `window.overlay.drawer` / `modal` (see `src/util/overlay.js` for the states) and `window.commandForm.mount` (needs `util/command-form.js` loaded in `index.html`; its field ids must be unique in the page). A closing surface stays in the page for its exit animation; `overlay.js` already strips its ids so a new surface can reuse them. Delete, Duplicate and Remove need a place in the tree menus before Project manager can go.

**Rules the owner set**: update the checklist in section 9 with every change, using its legend; commit or push only when asked; no Claude or tool attribution lines in commits or PRs; the visual redesign and new features are separate from the port.
