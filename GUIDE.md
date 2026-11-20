stackconsolev2/
├── engine/                          # Rust engine (headless crate `stackconsole-engine`, no UI dependency)
│   ├── src/
│   │   ├── engine.rs                # Supervisor: start/stop/restart, crash policy, start order, events
│   │   ├── engine/handlers.rs       # Every window request by name (Engine::request)
│   │   ├── engine/watch.rs          # Folder and git HEAD watching (replaces polling)
│   │   ├── process.rs               # Terminal (pty / ConPTY), process groups and job objects
│   │   ├── lines.rs                 # Terminal output -> log lines
│   │   ├── config.rs                # projects.json: atomic writes, backup, version, migrations
│   │   ├── model.rs                 # Config types (unknown fields kept)
│   │   ├── env.rs                   # .env files, secrets, masking
│   │   ├── logs.rs                  # Log ring buffer, local URL detection
│   │   ├── roots.rs                 # Master folders: scan and sidebar placement
│   │   ├── importer.rs              # Find runnable commands in a project folder
│   │   ├── regroup.rs               # Split / combine projects
│   │   ├── identity.rs              # Project colour and icon
│   │   ├── paths.rs, git.rs, ports.rs, open.rs, secrets.rs
│   ├── tests/                       # supervisor.rs (real processes), handlers.rs, fixtures/
│   └── examples/run.rs              # Run one command through the engine from a terminal
├── src-tauri/                       # Tauri 2 desktop app (binary `stackconsole`)
│   ├── src/main.rs                  # Windows, tray, notifications, dialogs, quit path, the `api` command
│   ├── src/secrets.rs               # Secret values sealed with a key in the OS credential store
│   ├── selftest/b4-b6.js            # In-app self-test for the in-window surfaces (run command in its header)
│   ├── tauri.conf.json, capabilities/, icons/
├── src/                             # The interface (plain HTML/CSS/JS), shared by both apps
│   ├── tauri-api.js                 # window.api for Tauri (injected into every window; idle under Electron)
│   ├── index.html, index.css, main.js
│   ├── tokens.css                   # Raw values + semantic layer (surfaces, text, status, elevation) + motion tokens
│   ├── components/
│   │   ├── modals/                  # Old tool windows (add/edit command, new project, rename, import); the main window no longer opens them
│   │   └── project-manager.html/.js # Old Project manager window; retired from the main window (B-6)
│   ├── util/                        # ansi-parser, command-form, icon-map, identity, layout, log-find, log-view (both logs), surfaces (command drawer, New project / Import / Rename modals),
│   │                                # overlay (modal, drawer, popover, toast, tooltip), ui
│   └── assets/logo/                 # stacklogo.ico (32x32), stacklogo-x256.ico
├── docs/
│   └── ENGINE-API.md                # Engine requests and events
├── main.js, main/, preload.js       # Electron main process (kept until the Tauri app reaches parity)
├── services/stream_worker.py        # Electron's Python output helper (reference behaviour; unused by Tauri)
├── build/fetch-python.js            # Electron build: bundled Python download
├── Cargo.toml, Cargo.lock           # Rust workspace (engine + src-tauri)
├── package.json, package-lock.json  # Electron app metadata
├── AUDIT.md, DESIGN-PLAN.md, PLAN.md
├── GUIDE.md, LICENSE, README.md
└── data/projects.json               # Electron dev runs only (gitignored); the Tauri app uses the OS app-data folder
