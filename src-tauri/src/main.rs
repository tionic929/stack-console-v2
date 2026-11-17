//! StackConsole desktop app: windows, tray, notifications and dialogs around the engine.
//! The interface in `src/` is loaded unchanged; `src/tauri-api.js` gives it the `window.api` it had
//! under Electron. Engine API: `docs/ENGINE-API.md`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secrets;

use serde_json::{Value, json};
use stackconsole_engine::{Engine, EngineOptions, Event, Timings};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Injected into every window before its own scripts.
const SHIM: &str = include_str!("../../src/tauri-api.js");
const SHELL_PROJECT: &str = stackconsole_engine::engine::SHELL_PROJECT;
/// How long quitting waits for services to stop before killing what's left.
const QUIT_TIMEOUT: Duration = Duration::from_secs(5);

struct AppState {
    engine: Engine,
    quitting: AtomicBool,
}

fn engine(app: &AppHandle) -> Engine {
    app.state::<Arc<AppState>>().engine.clone()
}

// ── Windows ──────────────────────────────────────────────────────

fn window_builder<'a>(app: &'a AppHandle, label: &str, page: &str, size: (f64, f64), min: (f64, f64), resizable: bool) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title("StackConsole")
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(resizable)
        .decorations(false)
        .background_color(tauri::window::Color(11, 13, 14, 255))
        .initialization_script(SHIM)
        // Pages never navigate away; local dev-server links go through openExternal
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn url_encode(v: &str) -> String {
    v.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Opens a tool window locked to its target (P5, D1): the window reads `?projectId=&commandId=` from its
/// URL instead of whatever project is active when it saves. No target given: the active project now.
async fn open_tool_window_for(app: &AppHandle, label: &str, project_id: Option<String>, command_id: Option<String>) -> Result<(), String> {
    let project_id = match project_id.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None if label == "add-project" => None,
        None => engine(app).config().await.ok().map(|db| db.active_project).filter(|p| !p.is_empty()),
    };
    let mut query = Vec::new();
    if let Some(p) = &project_id {
        query.push(format!("projectId={}", url_encode(p)));
    }
    if let Some(c) = command_id.filter(|c| !c.is_empty()) {
        query.push(format!("commandId={}", url_encode(&c)));
    }
    open_tool_window(app, label, &query.join("&"))
}

/// The six tool windows of the Electron app, as separate windows for now (moving them in-window is B-5).
fn open_tool_window(app: &AppHandle, label: &str, query: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let (page, size, min, resizable) = match label {
        "add-command" => ("components/modals/add-command.html", (560.0, 760.0), (560.0, 600.0), true),
        "edit-command" => ("components/modals/edit-command.html", (560.0, 760.0), (560.0, 600.0), true),
        "add-project" => ("components/modals/add-project.html", (480.0, 340.0), (480.0, 340.0), false),
        "project-manager" => ("components/project-manager.html", (760.0, 540.0), (760.0, 540.0), false),
        "edit-project-name" => ("components/modals/edit-project-name.html", (480.0, 220.0), (480.0, 220.0), false),
        "import-commands" => ("components/modals/import-commands.html", (520.0, 600.0), (520.0, 600.0), false),
        _ => return Err("Unknown window.".into()),
    };
    let page = if query.is_empty() { page.to_string() } else { format!("{page}?{query}") };
    let w = window_builder(app, label, &page, size, min, resizable).build().map_err(|e| e.to_string())?;
    if label == "edit-command" {
        let eng = engine(app);
        w.on_window_event(move |e| {
            if matches!(e, WindowEvent::Destroyed) {
                let eng = eng.clone();
                tauri::async_runtime::spawn(async move {
                    eng.request("clearEditHint", json!({})).await;
                });
            }
        });
    }
    Ok(())
}

// ── Quit (P4) ────────────────────────────────────────────────────

/// Every quit path ends here: stop all services (waiting at most QUIT_TIMEOUT), then exit.
fn quit(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        state.engine.shutdown(QUIT_TIMEOUT).await;
        app.exit(0);
    });
}

// ── Dialogs ──────────────────────────────────────────────────────

async fn pick_folder(app: &AppHandle, window: &WebviewWindow, title: &str, start: Option<String>, create: bool) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = app.dialog().file().set_title(title).set_parent(window).set_can_create_directories(create);
    if let Some(dir) = start.filter(|d| std::path::Path::new(d).is_dir()) {
        d = d.set_directory(dir);
    }
    d.pick_folder(move |f| {
        let _ = tx.send(f.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.ok().flatten()
}

/// P14: only local dev-server URLs, matched from the start of the string.
fn is_local_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://")) else { return false };
    for host in ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"] {
        if let Some(after) = rest.strip_prefix(host).and_then(|r| r.strip_prefix(':')) {
            let digits = after.chars().take_while(char::is_ascii_digit).count();
            let tail = &after[digits..];
            return (2..=5).contains(&digits) && (tail.is_empty() || tail.starts_with(['/', '?', '#']));
        }
    }
    false
}

// ── The one command the shim calls ───────────────────────────────

fn str_arg(args: &Value, k: &str) -> Option<String> {
    args.get(k).and_then(Value::as_str).map(str::to_string)
}

#[tauri::command]
async fn api(app: AppHandle, window: WebviewWindow, method: String, args: Value) -> Result<Value, String> {
    let eng = engine(&app);
    // Window methods, routed windows, dialogs and quitting are the app's; the rest is the engine's
    let engine_call = |name: &'static str, a: Value| {
        let eng = eng.clone();
        async move { Ok::<Value, String>(eng.request(name, a).await) }
    };
    match method.as_str() {
        "minimize" => {
            let _ = window.minimize();
            Ok(Value::Null)
        }
        "maximize" => {
            if window.is_resizable().unwrap_or(false) {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
            Ok(Value::Null)
        }
        "close" => {
            let _ = window.close();
            Ok(Value::Null)
        }
        "minimizeToTray" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok(Value::Null)
        }
        "confirmAppExit" => {
            quit(&app);
            Ok(Value::Null)
        }
        "openAddCommand" | "editProjectName" | "openImportCommands" | "newProjectCommand" | "openProjectManager" => {
            let label = match method.as_str() {
                "openAddCommand" => "add-command",
                "editProjectName" => "edit-project-name",
                "openImportCommands" => "import-commands",
                "newProjectCommand" => "add-project",
                _ => "project-manager",
            };
            let pid = if label == "project-manager" { None } else { str_arg(&args, "projectId") };
            if label == "project-manager" {
                open_tool_window(&app, label, "").map(|_| Value::Null)
            } else {
                open_tool_window_for(&app, label, pid, None).await.map(|_| Value::Null)
            }
        }
        "openEditCommand" => {
            let t = args.get("target").cloned().unwrap_or(Value::Null);
            let (pid, cid) = (str_arg(&t, "projectId"), str_arg(&t, "commandId"));
            if cid.is_none() {
                return Err("Which command? (openEditCommand needs { projectId, commandId })".into());
            }
            open_tool_window_for(&app, "edit-command", pid, cid).await.map(|_| Value::Null)
        }
        "openExternal" => {
            let url = str_arg(&args, "url").unwrap_or_default();
            if is_local_url(&url) {
                let _ = app.opener().open_url(url, None::<&str>);
            }
            Ok(Value::Null)
        }
        "selectDirectory" => {
            let picked = pick_folder(&app, &window, "Select Project Base Directory", None, true).await;
            Ok(picked.map(Value::from).unwrap_or(Value::Null))
        }
        "addRoot" => {
            let suggestion = eng.request("rootsSuggestion", json!({})).await["path"].as_str().map(str::to_string);
            let folder = if args.get("suggested").and_then(Value::as_bool).unwrap_or(false) {
                suggestion
            } else if args.get("pick").and_then(Value::as_bool).unwrap_or(false) {
                pick_folder(&app, &window, "Choose a folder that holds your projects", suggestion, false).await
            } else {
                None
            };
            match folder {
                None => Ok(json!({ "ok": false, "canceled": true })),
                Some(path) => engine_call("rootsAddPath", json!({ "path": path })).await,
            }
        }
        "changeRootPick" => {
            let found = eng.request("rootsFind", json!({ "root": args["root"] })).await;
            let Some(root) = found["root"].as_str().map(str::to_string) else { return Ok(found) };
            let start = (found["exists"] == true).then(|| PathBuf::from(&root).parent().map(|p| p.to_string_lossy().into_owned())).flatten();
            match pick_folder(&app, &window, &format!("Replace {root}"), start, false).await {
                None => Ok(json!({ "ok": false, "canceled": true })),
                Some(path) => engine_call("rootsChangePreview", json!({ "root": root, "path": path })).await,
            }
        }
        "openRoot" => {
            let found = eng.request("rootsFind", json!({ "root": args["root"] })).await;
            let Some(root) = found["root"].as_str() else { return Ok(found) };
            Ok(match stackconsole_engine::open::open_folder("explorer", root) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            })
        }
        "getStore" => engine_call("snapshot", json!({})).await,
        "setStore" => engine_call("saveConfig", args).await,
        "getLogs" => engine_call("logs", args).await,
        other => {
            let name: &'static str = match other {
                "openCommandPrompt" => "openShell",
                "sendTerminalInput" => "input",
                "startCommand" => "start",
                "startCommandNow" => "startNow",
                "stopCommand" => "stop",
                "restartCommand" => "restart",
                "launchAll" => "startProject",
                "stopAll" => "stopProject",
                "stopEverything" => "stopEverything",
                "setActiveProject" => "setActiveProject",
                "openFolder" => "folderOpen",
                "setProjectFolder" => "projectSetFolder",
                "relinkProject" => "projectRelink",
                "archiveProject" => "projectArchive",
                "folderInfo" => "folderInfo",
                "pinProject" => "projectPin",
                "setProjectIdentity" => "projectIdentity",
                "archiveEmptyProjects" => "projectsArchiveEmpty",
                "confirmRootReplace" => "rootsConfirmReplace",
                "removeRoot" => "rootsRemove",
                "moveRoot" => "rootsMove",
                "rescanRoot" => "rootsRescan",
                "changeRootApply" => "rootsChangeApply",
                "relinkRoot" => "rootsRelink",
                "dismissRootPrompt" => "rootsDismissPrompt",
                "hideRepo" => "repoHide",
                "setUpRepo" => "repoSetup",
                "splitPreview" => "splitPreview",
                "splitApply" => "splitApply",
                "combineCandidates" => "combineCandidates",
                "combinePreview" => "combinePreview",
                "combineApply" => "combineApply",
                "checkPort" => "portCheck",
                "freePort" => "portFree",
                "importScan" => "importScan",
                "importApply" => "importApply",
                "clearLogs" => "clearLogs",
                "addProject" => "projectAdd",
                "renameProject" => "projectRename",
                "deleteProject" => "projectDelete",
                "addCommand" => "commandAdd",
                "updateCommand" => "commandUpdate",
                "removeCommand" => "commandRemove",
                "duplicateCommand" => "commandDuplicate",
                _ => return Err(format!("Unknown method: {other}")),
            };
            engine_call(name, args).await
        }
    }
}

// ── Self-test (debug builds only) ─────────────────────────────────
// STACKCONSOLE_SELFTEST=<file.js> runs that script in the main window once it has loaded and prints
// what it reports. Used to check the real window, shim and IPC without looking at the screen.

#[cfg(debug_assertions)]
#[tauri::command]
fn selftest_report(app: AppHandle, line: String, done: Option<bool>, exit_request: Option<bool>) -> Value {
    println!("[selftest] {line}");
    if exit_request == Some(true) {
        // What Cmd+Q or the OS asking the app to quit does: an exit request, not our own quit()
        app.exit(0);
    }
    let windows: Vec<String> = app.webview_windows().keys().cloned().collect();
    if done == Some(true) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            quit(&app);
        });
    }
    json!({ "windows": windows })
}

/// Runs a script in another window (by label), so the self-test can drive the tool windows too.
#[cfg(debug_assertions)]
#[tauri::command]
fn selftest_eval(app: AppHandle, label: String, script: String) -> Result<(), String> {
    let w = app.get_webview_window(&label).ok_or(format!("no window {label}"))?;
    w.eval(&script).map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
fn selftest_script() -> Option<String> {
    std::env::var("STACKCONSOLE_SELFTEST").ok().and_then(|p| std::fs::read_to_string(p).ok())
}

// ── Engine events -> windows, tray, notifications ────────────────

const TRAY_STATUS: [(&str, &str); 5] = [("running", "🟢"), ("starting", "🟡"), ("waiting", "⏳"), ("crashed", "🔴"), ("offline", "⚫")];

/// Every project with something running, starting, waiting or crashed (reference: updateTrayMenu).
fn update_tray(app: &AppHandle, snap: &Value) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        let mut live = 0;
        let mut any = false;
        for p in snap["projects"].as_array().into_iter().flatten() {
            let shown: Vec<&Value> = p["commands"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| ["running", "starting", "waiting", "crashed"].contains(&c["status"].as_str().unwrap_or("")))
                .collect();
            if shown.is_empty() {
                continue;
            }
            any = true;
            menu.append(&MenuItem::new(app, p["name"].as_str().unwrap_or(""), false, None::<&str>)?)?;
            for c in shown {
                let status = c["status"].as_str().unwrap_or("offline");
                if status != "crashed" {
                    live += 1;
                }
                let dot = TRAY_STATUS.iter().find(|(s, _)| *s == status).map(|(_, d)| *d).unwrap_or("⚫");
                let port = c["detectedPort"].as_str().filter(|s| !s.is_empty()).or(c["port"].as_str().filter(|s| !s.is_empty()));
                let label = format!("   {dot} {}{}", c["displayName"].as_str().unwrap_or(""), port.map(|p| format!(" (:{p})")).unwrap_or_default());
                menu.append(&MenuItem::new(app, label, false, None::<&str>)?)?;
            }
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        if !any {
            menu.append(&MenuItem::new(app, "Nothing running", false, None::<&str>)?)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        menu.append(&MenuItem::with_id(app, "show", "Show App", true, None::<&str>)?)?;
        if live > 0 {
            menu.append(&MenuItem::with_id(app, "stop-all", format!("Stop everything ({live})"), true, None::<&str>)?)?;
        }
        menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
        Ok(menu)
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

fn pump_events(app: AppHandle, eng: Engine) {
    let mut rx = eng.subscribe();
    let (dirty_tx, mut dirty_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(Event::Logs { lines }) => {
                    let batch: Vec<Value> = lines
                        .into_iter()
                        .filter_map(|l| serde_json::to_value(l).ok())
                        .map(|mut v| {
                            if v["projectId"] == SHELL_PROJECT {
                                v["projectId"] = Value::Null; // the interface keys the shell by commandId null
                            }
                            v
                        })
                        .collect();
                    let _ = app2.emit("terminal-logs", batch);
                }
                Ok(Event::Notice(n)) => notify(&app2, &n),
                Ok(_) => {
                    let _ = dirty_tx.send(());
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = dirty_tx.send(());
                }
                Err(_) => break,
            }
        }
    });
    // One fresh state per burst of changes (the engine already coalesces runtime changes, F1)
    tauri::async_runtime::spawn(async move {
        while dirty_rx.recv().await.is_some() {
            tokio::time::sleep(Duration::from_millis(30)).await;
            while dirty_rx.try_recv().is_ok() {}
            let snap = eng.request("snapshot", json!({})).await;
            let _ = app.emit("db-refreshed", &snap);
            update_tray(&app, &snap);
        }
    });
}

/// Only when StackConsole isn't in front. Never includes log text (it can hold secrets).
fn notify(app: &AppHandle, n: &stackconsole_engine::Notice) {
    if let Some(w) = app.get_webview_window("main")
        && w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            return;
        }
    let _ = app.notification().builder().title(&n.title).body(&n.body).show();
}

// ── Start-up ─────────────────────────────────────────────────────

/// C-11: a GUI app on macOS/Linux doesn't get the login shell's PATH (nvm, Homebrew, pyenv), so
/// commands like `npm` aren't found. Read it from the login shell once, before any thread starts.
#[cfg(unix)]
fn adopt_login_shell_path() {
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "printf '__SC_PATH__%s__SC_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return;
            }
        }
    }
    let Ok(out) = child.wait_with_output() else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    if let Some(path) = text.split("__SC_PATH__").nth(1).filter(|p| !p.is_empty()) {
        // SAFETY: called first thing in main, before any other thread exists
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg(not(unix))]
fn adopt_login_shell_path() {}

/// First run of the Tauri app: copy the Electron app's project list (never move it), so the old app
/// keeps working until this one replaces it. The engine migrates it on load.
fn import_electron_config(data_dir: &std::path::Path) {
    if data_dir.join("projects.json").exists() {
        return;
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    let Some(old) = base.map(|b| b.join("StackConsole").join("data").join("projects.json")).filter(|p| p.is_file()) else { return };
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::copy(old, data_dir.join("projects.json"));
}

#[cfg(debug_assertions)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![api, selftest_report, selftest_eval]
}

#[cfg(not(debug_assertions))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![api]
}

fn main() {
    adopt_login_shell_path();

    tauri::Builder::default()
        // One StackConsole at a time: a second launch shows the first
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(handlers())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = std::env::var_os("STACKCONSOLE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            import_electron_config(&data_dir);
            let home = app.path().home_dir().ok();
            let (eng, notes) = tauri::async_runtime::block_on(async {
                Engine::start(EngineOptions {
                    data_dir: data_dir.clone(),
                    secrets: Arc::new(secrets::KeychainSecrets::new()),
                    timings: Timings::default(),
                    home_dir: home,
                })
            })?;
            for n in notes {
                eprintln!("[config] {n:?} ({})", data_dir.display());
            }
            app.manage(Arc::new(AppState { engine: eng.clone(), quitting: AtomicBool::new(false) }));

            #[allow(unused_mut)]
            let mut main_builder = window_builder(&handle, "main", "index.html", (1100.0, 700.0), (900.0, 560.0), true);
            #[cfg(debug_assertions)]
            if let Some(script) = selftest_script() {
                let ran = Arc::new(AtomicBool::new(false));
                main_builder = main_builder.on_page_load(move |w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && !ran.swap(true, Ordering::SeqCst) {
                        let _ = w.eval(&script);
                    }
                });
            }
            let main = main_builder.build()?;
            let h2 = handle.clone();
            main.on_window_event(move |e| {
                // Closing the main window keeps StackConsole in the tray, unless it is quitting
                if let WindowEvent::CloseRequested { api, .. } = e
                    && !h2.state::<Arc<AppState>>().quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        if let Some(w) = h2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
            });

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("StackConsole")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "stop-all" => {
                        let eng = engine(app);
                        tauri::async_runtime::spawn(async move {
                            eng.request("stopEverything", json!({})).await;
                        });
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                // P12: a plain click on the tray icon opens the app
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            pump_events(handle.clone(), eng.clone());
            let h3 = handle.clone();
            tauri::async_runtime::spawn(async move {
                let snap = eng.request("snapshot", json!({})).await;
                update_tray(&h3, &snap);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("StackConsole could not start")
        .run(|app, event| {
            // P4: Cmd+Q, the OS asking the app to quit, the last window closing: all stop services first
            if let RunEvent::ExitRequested { api, .. } = event
                && !app.state::<Arc<AppState>>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app);
                }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_url_check_is_anchored() {
        assert!(super::is_local_url("http://localhost:5173/"));
        assert!(super::is_local_url("https://127.0.0.1:8000"));
        assert!(super::is_local_url("http://[::1]:3000?x"));
        assert!(!super::is_local_url("https://other.site/#http://localhost:1234"));
        assert!(!super::is_local_url("http://localhost.evil.com:80"));
        assert!(!super::is_local_url("http://localhost:1"));
        assert!(!super::is_local_url("file:///etc/passwd"));
    }
}
