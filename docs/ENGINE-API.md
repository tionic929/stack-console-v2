# StackConsole engine API

Approved 2026-11-17 (checklist B-1), with the recommendations in section 5. Implemented: `engine/src/engine.rs` (services, events) and `engine/src/engine/handlers.rs` (every request by name).

The engine is the Rust crate `engine/` (`stackconsole-engine`). It has no Tauri dependency. The desktop app, a command-line tool and later integrations all talk to it through the requests and events below. Inside the desktop app the calls are in-process Rust calls; the JS shim (`src/tauri-api.js`) maps the existing `window.api` names onto one Tauri command, `api(method, args)`, and Tauri events; `src-tauri/src/main.rs` maps each method to an engine request (table in section 6).

## 1. Names and shapes

- **Target**: `{ projectId, commandId }`. Every service request names its project. There is no "active project" inside the engine (D1). `commandId: null` means the shared shell.
- **Result**: requests that can fail return `{ ok: true, ... }` or `{ ok: false, error: "plain sentence" }`, the same shape the interface already handles.
- **Status** of a service: `offline` · `waiting` · `starting` · `running` · `crashed`.
- Field names stay camelCase, as in `projects.json` and the interface today.

## 2. Requests

### Services (the four agreed verbs, plus their group forms)

| Request | Params | Returns | Replaces |
|---|---|---|---|
| `start` | target, `now?: bool` (skip start order) | `ok` | `cmd-start`, `cmd-start-now` |
| `stop` | target | `ok` (returns at once; the kill finishes in the background, F4) | `cmd-stop` |
| `restart` | target | `ok` | `cmd-restart` |
| `startProject` | `projectId` | `ok` | `cmd-launch-all` |
| `stopProject` | `projectId` | `ok` | `cmd-stop-all` |
| `stopEverything` | none | `ok` | `cmd-stop-everything`, tray item |
| `sendInput` | target, `text` | `ok` | `cmd-terminal-input` (now works for services too, not only the shell) |
| `openShell` | `projectId?` (folder to open in) | `ok` | `route-command-prompt` |
| `shutdown` | `timeoutMs` | after every process tree is gone or the timeout passed | quit paths (P4) |

### Status and logs

| Request | Params | Returns | Replaces |
|---|---|---|---|
| `status` | `projectId?` | runtime of every service (or one project's) | part of `db-get` |
| `snapshot` | none | config + runtime + derived folder/git fields, secrets reduced to `{ key, secret, hasValue }` | `db-get` |
| `logs` | target | `{ seq, lines: [{ seq, ts, stream, text }] }` | `logs-get` |
| `clearLogs` | target | `ok` | `cmd-clear-logs` |

### Config intents

The engine is the only writer of `projects.json` (D9). Today's whole-config save is kept for parity and replaced by specific requests in Phase B (B-2).

| Request | Params | Replaces |
|---|---|---|
| `saveConfig` (temporary) | the whole config as the window holds it | `db-set` (keeps secrets the form left untouched, stops services whose command was removed) |
| `setActiveProject` | `projectId` | `set-active-project` (stored only as a UI preference) |
| `projectPin`, `projectArchive`, `projectIdentity`, `projectSetFolder`, `projectRelink`, `archiveEmptyProjects` | `projectId` + value | the `project-*` handlers |
| `splitPreview`, `splitApply`, `combineCandidates`, `combinePreview`, `combineApply` | as today | `project-split-*`, `project-combine-*` |
| `importScan`, `importApply` | `projectId` (now explicit), items | `import-scan`, `import-apply` |
| `rootsAdd`, `rootsConfirmReplace`, `rootsRemove`, `rootsMove`, `rootsRescan`, `rootsChangePreview`, `rootsChangeApply`, `rootsRelink`, `rootsDismissPrompt`, `repoHide`, `repoSetup` | as today | `roots-*`, `repo-*` |

Specific changes (Phase B, built; the interface uses these instead of `saveConfig`):

| Request | Params | Returns |
|---|---|---|
| `projectAdd` | `name`, `baseDirectory?` | `{ ok, projectId }` (id from the name; the new project becomes active) |
| `projectRename` | `projectId`, `name` | `ok` |
| `projectDelete` | `projectId` | `ok` (its services are stopped) |
| `commandAdd` | `projectId`, `command` (form values) | `{ ok, commandId }`; new secret values are sealed |
| `commandUpdate` | `projectId`, `commandId`, `command` | `ok`; merges over the stored command, untouched secrets kept; a command that no longer exists is refused with a reason |
| `commandRemove` | `projectId`, `commandId` | `ok`; "start after" links to it are cleared; a running one is stopped |
| `commandDuplicate` | `projectId`, `commandId` | `{ ok, commandId }`; the copy keeps sealed secrets (P7) and sits after the original |

### Ports and folders

| Request | Params | Returns | Replaces |
|---|---|---|---|
| `portCheck` | target | `{ checked, inUse, port, pid, name, owner }` | `port-check` |
| `portFree` | `pid` (must match the last check) | `ok` | `port-free` |
| `folderInfo` | `path` | `{ exists, branch, detached, repoRoot }` | `folder-info` |
| `folderFor` | target or `projectId` | resolved folder; the app opens it | `folder-open`, `roots-open` |

### Owned by the app, not the engine

Window controls (`win-*`, `minimize-to-tray`, `close-window`), the six `route-*` windows, folder pickers (`open-dir-picker`, the pick half of `roots-add` / `roots-change-pick`), `open-external`, `confirm-app-exit`, tray, notifications, single instance. The app passes a picked path to the engine request that needs it.

## 3. Events

All events go to every subscriber (window, CLI, integrations).

| Event | Payload | Rate |
|---|---|---|
| `logs` | `[{ projectId, commandId, seq, ts, stream, text }]` | batched, one event per ~50 ms at most (F2) |
| `runtime` | `[{ projectId, commandId, status, pid, startedAt, url, detectedPort, ready, exitCode, waitingFor, blockedBy, restartAttempt, restartGaveUp, envSummary }]` (only changed services) | coalesced, one event per ~50 ms at most (F1) |
| `configChanged` | `{ revision }` | after each saved change; the app then sends a fresh `snapshot` to the windows (`db-refreshed`) |
| `foldersChanged` | `{}` | when a watched folder appears or goes, a git branch changes, or a master-folder scan changes (D4, D5) |
| `notice` | `{ kind: "crashed" \| "restartPaused" \| "configRecovered" \| ..., projectId?, commandId?, title, body }` | as they happen; the app decides whether to show a notification. Never contains log text. |

## 4. Behaviour the engine guarantees

| Area | Rule | Audit id |
|---|---|---|
| Output | Read through a real terminal (pty on macOS/Linux, ConPTY on Windows). Bytes are split into lines on `\n` only; `>`, `->`, `=>` never split. Text with no newline (a prompt) is sent after 150 ms of quiet. A line longer than 8 KB is sent in pieces, cut on a character boundary. | P2, F3 |
| Encoding | Lines are decoded after they are assembled, so a character split across reads survives; bytes that are not UTF-8 become `�` and capture continues. | P1, P8 |
| Terminal noise | Colour codes (SGR) are kept; cursor movement, screen clearing and title sequences are removed. A lone `\r` overwrites the line so far (progress bars). | F7 |
| Streams | A terminal merges stdout and stderr, so service lines arrive as `stdout`; engine messages are `system`, shell input is `input`. | change from today |
| Secrets | Values of secret env entries are replaced by `••••••` in that service's log lines before they are stored or sent. | X2 |
| Log buffer | 5,000 lines per service in a ring buffer; trimming costs nothing per line. | F8 |
| Stop | Sends a terminate signal to the whole process group (Unix) or job (Windows) and returns; anything still alive after 3 s is killed. Never blocks the caller. | F4, P15 |
| Cleanup on exit | Every service runs in its own process group / kill-on-close job. `shutdown` stops all of them and waits; if the app dies anyway, closing the terminal (Unix) or the job handle (Windows) ends the trees. | P4, D10 |
| Start order | `startAfter` waits for the dependency to be ready (local URL printed, its port listening, or its ready line). A dependency that fails to spawn, crashes, is stopped, or times out blocks everything waiting on it at once, down the chain. | P9 |
| Crash policy | `onCrash: "restart"` retries with 2, 4, 8 ... up to 30 s, at most `restartLimit` times (1-10, default 3); a run longer than 60 s resets the count. | S-001 |
| Config | Kept in memory. Written to a temp file, flushed, then renamed over `projects.json`; the previous file is kept as `projects.json.bak`. An unreadable file is moved aside as `projects.json.unreadable-<time>` and never overwritten; the engine then loads the backup if it reads. The file carries `"version"`; older versions are migrated on load; a newer version is opened read-only. | P3, D9 |
| `.env` files | Resolved through links before the "inside the project" check. | X10 |

## 5. Decisions on the open points (approved)

1. **stderr colouring.** A real terminal loses the stdout/stderr split, so error lines are no longer tinted by stream (level detection by text still works). Alternative: pipes for services and a terminal only for the shell, which brings back P-class problems (buffered output, no colour, no prompts). **Decided: terminal.**
2. **Secrets from the Electron app** are encrypted with Electron's `safeStorage` and cannot be read by the Rust app. Proposal: the new app stores secrets in the OS keychain (Windows Credential Manager / macOS Keychain); existing secret values must be entered again once, and the interface already shows "could not be decrypted" for them. **Decided; built** as AES-256-GCM with a key in the OS credential store (`src-tauri/src/secrets.rs`).
3. **Shell on macOS/Linux** runs commands with `/bin/sh -c`. A GUI app does not get the login shell's `PATH` (nvm, Homebrew), so the app reads it from the login shell once at start. **Built** (checked: a launch through `open` gets nvm and Homebrew paths).
4. **Stop grace period** of 3 s before a forced kill (today: forced kill at once). **Decided; built.**

## 6. Calling it

`Engine::request(name, args) -> JSON` takes these names (arguments in camelCase, results as in section 2). The service verbs also exist as typed Rust methods (`start_service`, `stop_service`, `restart_service`, `start_project`, `stop_project`, `stop_everything`, `send_input`, `logs`, `clear_logs`, `status`, `config`, `update_config`, `shutdown`) for the CLI and tests.

| `window.api` method (preload.js) | Engine request | Done by the app instead |
|---|---|---|
| `startCommand`, `startCommandNow`, `stopCommand`, `restartCommand` | `start`, `startNow`, `stop`, `restart` (`{ target }`) | |
| `launchAll`, `stopAll`, `stopEverything` | `startProject`, `stopProject`, `stopEverything` | |
| `setActiveProject` | `setActiveProject` | |
| `openCommandPrompt`, `sendTerminalInput` | `openShell`, `input` | |
| `getLogs`, `clearLogs` | `logs`, `clearLogs` (`commandId: null` = shell) | |
| `getStore`, `setStore` (deprecated, unused by the interface) | `snapshot`, `saveConfig` (`{ data }`) | |
| `addProject`, `renameProject`, `deleteProject`, `addCommand`, `updateCommand`, `removeCommand`, `duplicateCommand` | `projectAdd`, `projectRename`, `projectDelete`, `commandAdd`, `commandUpdate`, `commandRemove`, `commandDuplicate` | |
| `openFolder`, `folderInfo` | `folderOpen`, `folderInfo` | |
| `setProjectFolder`, `relinkProject`, `archiveProject`, `pinProject`, `setProjectIdentity`, `archiveEmptyProjects` | `projectSetFolder`, `projectRelink`, `projectArchive`, `projectPin`, `projectIdentity`, `projectsArchiveEmpty` | |
| `splitPreview`, `splitApply`, `combineCandidates`, `combinePreview`, `combineApply` | same names | |
| `importScan`, `importApply` | same names (`projectId` optional, defaults to the active project) | |
| `addRoot` | `rootsSuggestion`, then `rootsAddPath` | folder picker |
| `changeRootPick` | `rootsFind`, then `rootsChangePreview` | folder picker |
| `openRoot` | `rootsFind` | opens the folder |
| `confirmRootReplace`, `removeRoot`, `moveRoot`, `rescanRoot`, `changeRootApply`, `relinkRoot`, `dismissRootPrompt` | `rootsConfirmReplace`, `rootsRemove`, `rootsMove`, `rootsRescan`, `rootsChangeApply`, `rootsRelink`, `rootsDismissPrompt` | |
| `hideRepo`, `setUpRepo` | `repoHide`, `repoSetup` | |
| `checkPort`, `freePort` | `portCheck`, `portFree` | |
| `minimize`, `maximize`, `close`, `minimizeToTray`, `confirmAppExit`, `open*` windows, `selectDirectory`, `openExternal` | | window, dialog, quit, URL check (anchored, P14). `openAddCommand(projectId)`, `openEditCommand({ projectId, commandId })`, `editProjectName(projectId)`, `openImportCommands(projectId)` open the window with that target in its URL (`?projectId=&commandId=`) |
| `onDataUpdate`, `onTerminalLog`, `onSelectCommand`, `onRequestCloseConfirmation` | events `runtime` / `configChanged` / `foldersChanged` -> one `db-refreshed` snapshot; `logs` -> `terminal-logs` (a batch) | event forwarding |

`clearEditHint` is sent by the app when the Edit command window closes. `shutdown` (`{ timeoutMs }`) is what every quit path calls.
