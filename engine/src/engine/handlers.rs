//! Every request the windows make, by name (`Engine::request`). Arguments and results are JSON in the
//! shapes the interface already uses. Reference: the `ipcMain` handlers in `main.js`.

use super::*;
use crate::identity;
use crate::importer::scan_project_tree;
use crate::model::Project;
use crate::paths::{self, command_folder, contains, is_dir, key, relink_candidate};
use crate::regroup;
use crate::roots::{self, Overlap, ScanView};
use serde_json::{Value, json};
use std::collections::HashSet;

/// The shared shell's log and process live under this project id (`commandId: null`).
pub const SHELL_PROJECT: &str = "__shell__";

const LIVE_ERROR: &str = "Stop its running services first.";
const SCAN_TIMEOUT: Duration = Duration::from_secs(10);
const PICK_TTL: Duration = Duration::from_secs(120);

pub(crate) enum RootPickPurpose {
    Add { contains: Vec<String> },
    Change { root: String, relink: bool },
}

pub(crate) struct RootPick {
    purpose: RootPickPurpose,
    path: String,
    at: Instant,
}

fn shell_target() -> Target {
    Target { project_id: SHELL_PROJECT.into(), command_id: None }
}

fn ok() -> Value {
    json!({ "ok": true })
}

fn err(e: impl Into<String>) -> Value {
    json!({ "ok": false, "error": e.into() })
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str)
}

fn new_command_id(commands: &[Command]) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let salt = NEXT.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
        let suffix: String = to_base36(salt % (36u64.pow(4)) + 36u64.pow(4)).chars().skip(1).collect();
        let id = format!("cmd_{}{}", to_base36(now_ms()), suffix);
        if !commands.iter().any(|c| c.id == id) {
            return id;
        }
    }
}

fn to_base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn import_key(wd: &str, command: &str) -> String {
    format!("{}|{}", wd.trim().to_lowercase(), command.trim().to_lowercase())
}

/// An app folder must be a plain folder name directly inside the project folder.
fn plain_folder_name(wd: &str) -> bool {
    let bad = |c: char| "\\/:*?\"<>|".contains(c);
    let mut chars = wd.chars();
    match chars.next() {
        None => false,
        Some(first) => !bad(first) && first != '.' && wd.chars().count() <= 100 && chars.all(|c| !bad(c)),
    }
}

impl Engine {
    /// One entry point for the interface: `name` and JSON `args`, JSON result.
    pub async fn request(&self, name: &str, args: Value) -> Value {
        let gone = || err("The engine has stopped.");
        match name {
            "portCheck" => return self.port_check(args).await,
            "portFree" => return self.port_free(args).await,
            "rootsRescan" => {
                let root = s(&args, "root").unwrap_or("").to_string();
                let found = self.call(move |c| c.find_root(&root)).await.ok().flatten();
                let Some(found) = found else { return json!({ "ok": false }) };
                let (tx, rx) = oneshot::channel();
                let _ = self.call(move |c| c.rescan(&found, Some(tx))).await;
                let _ = rx.await;
                return ok();
            }
            "shutdown" => {
                let ms = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(5000);
                self.shutdown(Duration::from_millis(ms)).await;
                return ok();
            }
            _ => {}
        }
        let name = name.to_string();
        self.call(move |c| c.handle(&name, &args)).await.unwrap_or_else(|_| gone())
    }

    async fn port_check(&self, args: Value) -> Value {
        let found = self
            .call(move |c| {
                let t = c.resolve_target(&args)?;
                let (_, cmd) = c.command_for(&t)?;
                let port = cmd.port()?;
                let mut owner = Value::Null;
                for p in &c.store.db().projects {
                    for oc in &p.commands {
                        let ot = Target::new(&p.id, &oc.id);
                        if !owner.is_null() || ot == t {
                            continue;
                        }
                        let rt = c.services.get(&ot).map(|s| s.rt.clone()).unwrap_or_default();
                        let on_port = rt.detected_port.as_deref() == Some(&port.to_string())
                            || (rt.detected_port.is_none() && oc.port() == Some(port));
                        if matches!(rt.status, Status::Running | Status::Starting) && on_port {
                            owner = json!({ "id": oc.id, "name": oc.display_name, "projectId": p.id, "projectName": p.name });
                        }
                    }
                }
                Some((port, owner))
            })
            .await
            .ok()
            .flatten();
        let Some((port, owner)) = found else { return json!({ "checked": false }) };
        let listener = tokio::task::spawn_blocking(move || crate::ports::find_listener(port)).await.ok().flatten();
        if listener.is_none() && owner.is_null() {
            return json!({ "checked": true, "inUse": false, "port": port.to_string() });
        }
        if let Some((pid, _)) = &listener {
            let pid = *pid;
            let _ = self.call(move |c| c.last_port_check = Some((pid, Instant::now()))).await;
        }
        json!({
            "checked": true, "inUse": true, "port": port.to_string(),
            "pid": listener.as_ref().map(|l| l.0), "name": listener.map(|l| l.1), "owner": owner,
        })
    }

    async fn port_free(&self, args: Value) -> Value {
        let pid = args.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
        let check = self
            .call(move |c| {
                let fresh = c.last_port_check.is_some_and(|(p, at)| p == pid && at.elapsed() < Duration::from_secs(120));
                if !fresh {
                    return Err("Check the port again before stopping a process.");
                }
                if c.services.values().any(|s| s.run.as_ref().is_some_and(|r| r.pid == pid)) {
                    return Err("That process belongs to StackConsole; stop the service instead.");
                }
                c.last_port_check = None;
                Ok(())
            })
            .await;
        match check {
            Ok(Ok(())) => {
                let _ = tokio::task::spawn_blocking(move || crate::ports::kill_pid(pid)).await;
                ok()
            }
            Ok(Err(e)) => err(e),
            Err(_) => err("The engine has stopped."),
        }
    }
}

impl Core {
    fn handle(&mut self, name: &str, a: &Value) -> Value {
        match name {
            // ── Services ────────────────────────────────────────
            "start" | "startNow" => match self.resolve_target(a) {
                Some(t) => {
                    let now = name == "startNow" || a.get("now").and_then(Value::as_bool).unwrap_or(false);
                    self.start(&t, StartOpts { force: now, is_restart: false });
                    ok()
                }
                None => err("Unknown command."),
            },
            "stop" => match self.resolve_target(a) {
                Some(t) => {
                    self.stop(&t);
                    ok()
                }
                None => err("Unknown command."),
            },
            "restart" => match self.resolve_target(a) {
                Some(t) => {
                    self.stop(&t);
                    self.start(&t, StartOpts { force: true, is_restart: false });
                    ok()
                }
                None => err("Unknown command."),
            },
            "startProject" | "stopProject" => {
                let pid = s(a, "projectId").map(str::to_string).unwrap_or_else(|| self.store.db().active_project.clone());
                let Ok(targets) = self.project_targets(&pid) else { return err("Unknown project.") };
                for t in targets {
                    if name == "startProject" {
                        self.start(&t, StartOpts::default());
                    } else {
                        self.stop(&t);
                    }
                }
                ok()
            }
            "stopEverything" => {
                // Services only; the shared shell stays open (as before)
                let targets: Vec<Target> = self.services.keys().filter(|t| t.command_id.is_some()).cloned().collect();
                for t in targets {
                    if self.services[&t].run.as_ref().is_some_and(|r| !r.stopping)
                        || self.services[&t].pending.is_some()
                        || self.services[&t].waiter.is_some()
                    {
                        self.stop(&t);
                    }
                }
                ok()
            }
            "setActiveProject" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                self.save(move |db| db.active_project = pid)
            }
            "logs" => {
                let t = self.log_target(a);
                let (seq, lines) = self.services.get(&t).map(|s| (s.logs.seq(), s.logs.lines())).unwrap_or((0, Vec::new()));
                json!({ "seq": seq, "lines": lines })
            }
            "clearLogs" => {
                let t = self.log_target(a);
                if let Some(svc) = self.services.get_mut(&t) {
                    svc.logs.clear();
                }
                ok()
            }
            "input" => {
                let t = match s(a, "commandId") {
                    None => shell_target(),
                    Some(cid) => {
                        let pid = s(a, "projectId").map(str::to_string).unwrap_or_else(|| self.store.db().active_project.clone());
                        Target::new(pid, cid)
                    }
                };
                let text = s(a, "text").unwrap_or("").to_string();
                match self.send_input(&t, &text) {
                    Ok(()) => ok(),
                    Err(e) => err(e),
                }
            }
            "openShell" => self.open_shell(),

            // ── State ───────────────────────────────────────────
            "snapshot" => self.snapshot(),
            "saveConfig" => self.save_config(a.get("data").unwrap_or(&Value::Null)),
            "clearEditHint" => {
                self.active_command_to_edit = None;
                ok()
            }

            // ── Projects ────────────────────────────────────────
            "projectIdentity" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                let v = match identity::validate(a) {
                    Ok(v) => v,
                    Err(e) => return err(e),
                };
                self.save(move |db| {
                    let p = db.project_mut(&pid).unwrap();
                    for (k, val) in [("color", v.color), ("icon", v.icon), ("mono", v.mono)] {
                        match val {
                            Some(x) => {
                                p.extra.insert(k.into(), json!(x));
                            }
                            None => {
                                p.extra.remove(k);
                            }
                        }
                    }
                })
            }
            "projectPin" | "projectArchive" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                let field = if name == "projectPin" { "pinned" } else { "archived" };
                let on = a.get(field).and_then(Value::as_bool).unwrap_or(false);
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                if name == "projectArchive" && on && self.project_live(&pid) {
                    return err("Stop its services before archiving it.");
                }
                self.save(move |db| {
                    let p = db.project_mut(&pid).unwrap();
                    if on {
                        p.extra.insert(field.into(), json!(true));
                    } else {
                        p.extra.remove(field);
                    }
                })
            }
            "projectsArchiveEmpty" => {
                let mut n = 0;
                let r = self.save(|db| {
                    for p in &mut db.projects {
                        if p.flag("archived") || (p.base_dir().is_some() && !p.commands.is_empty()) {
                            continue;
                        }
                        p.extra.insert("archived".into(), json!(true));
                        n += 1;
                    }
                });
                if r["ok"] == true { json!({ "ok": true, "archived": n }) } else { r }
            }
            "projectSetFolder" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                let Some(folder) = s(a, "folder").filter(|f| is_dir(f)).map(str::to_string) else {
                    return err("That folder doesn't exist.");
                };
                self.save(move |db| db.project_mut(&pid).unwrap().base_directory = Some(folder))
            }
            "projectRelink" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Nothing to relink.") };
                let db = self.store.db();
                let Some(old) = db.project(&pid).and_then(|p| p.base_dir()).filter(|b| !is_dir(b)).map(str::to_string) else {
                    return err("Nothing to relink.");
                };
                let known: Vec<String> = db.projects.iter().filter_map(|p| p.base_dir().map(str::to_string)).collect();
                let Some(target) = relink_candidate(&old, &known) else {
                    return err("No matching folder found. Use \"Change folder…\".");
                };
                let t2 = target.clone();
                let r = self.save(move |db| {
                    let p = db.project_mut(&pid).unwrap();
                    // Absolute working directories under the old folder move with it (P10: on a path boundary)
                    for c in &mut p.commands {
                        let wd = c.working_directory.as_deref().map(str::trim).unwrap_or("").to_string();
                        if !wd.is_empty() && Path::new(&wd).is_absolute()
                            && let Some(n) = paths::rebase(&wd, &old, &t2) {
                                c.working_directory = Some(n);
                            }
                    }
                    p.base_directory = Some(t2);
                });
                if r["ok"] == true { json!({ "ok": true, "folder": target }) } else { r }
            }
            "folderInfo" => {
                let folder = s(a, "folder").unwrap_or("");
                if folder.is_empty() || !is_dir(folder) {
                    return json!({ "exists": false });
                }
                let g = crate::git::branch_info(Path::new(folder));
                json!({ "exists": true, "branch": g.as_ref().map(|g| g.branch.clone()), "detached": g.as_ref().is_some_and(|g| g.detached),
                        "repoRoot": g.map(|g| g.root.to_string_lossy().into_owned()) })
            }
            "folderOpen" => {
                let Some(pid) = s(a, "projectId") else { return err("Unknown project.") };
                let db = self.store.db();
                let Some(p) = db.project(pid) else { return err("Unknown project.") };
                let cmd = match s(a, "commandId") {
                    Some(cid) => match p.command(cid) {
                        Some(c) => Some(c),
                        None => return err("Unknown command."),
                    },
                    None => None,
                };
                let folder = match cmd {
                    Some(c) => command_folder(p, c),
                    None => p.base_dir().map(str::to_string),
                };
                let Some(folder) = folder else { return err("This project has no folder yet. Use \"Change folder…\".") };
                let target = s(a, "target").unwrap_or("");
                if !["explorer", "vscode", "terminal"].contains(&target) {
                    return err("Unknown action.");
                }
                match crate::open::open_folder(target, &folder) {
                    Ok(()) => ok(),
                    Err(e) => err(e),
                }
            }

            // ── Regroup ─────────────────────────────────────────
            "splitPreview" => {
                let Some(p) = s(a, "projectId").and_then(|id| self.store.db().project(id)) else { return err("Unknown project.") };
                let mut plan = regroup::split_preview(p);
                if plan["ok"] == true {
                    let live = self.project_live(&p.id.clone());
                    plan["live"] = json!(live);
                    plan.as_object_mut().unwrap().remove("keeps");
                }
                plan
            }
            "splitApply" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                if self.project_live(&pid) {
                    return err(LIVE_ERROR);
                }
                let mut db = self.store.db().clone();
                match regroup::apply_split(&mut db, &pid) {
                    Err(e) => err(e),
                    Ok((created, moved)) => {
                        self.move_runtime(&moved);
                        let r = self.save(move |d| *d = db);
                        if r["ok"] == true { json!({ "ok": true, "created": created }) } else { r }
                    }
                }
            }
            "combineCandidates" => {
                let db = self.store.db();
                let Some(p) = s(a, "projectId").and_then(|id| db.project(id)) else { return err("Unknown project.") };
                let list: Vec<Value> = regroup::combine_candidates(db, p, &roots::root_paths(db))
                    .iter()
                    .map(|o| json!({ "id": o.id, "name": o.name, "folder": o.base_directory, "commands": o.commands.len() }))
                    .collect();
                json!({ "ok": true, "projects": list })
            }
            "combinePreview" => {
                let ids = string_list(a.get("projectIds"));
                let Some(ids) = ids else { return json!({ "ok": false }) };
                let db = self.store.db();
                match regroup::combine_plan(db, &ids, &roots::root_paths(db)) {
                    Err(e) => err(e),
                    Ok(mut plan) => {
                        let live = ids.iter().any(|id| self.project_live(id));
                        plan["live"] = json!(live);
                        plan
                    }
                }
            }
            "combineApply" => {
                let Some(ids) = string_list(a.get("projectIds")) else { return json!({ "ok": false }) };
                if ids.iter().any(|id| self.project_live(id)) {
                    return err(LIVE_ERROR);
                }
                let mut db = self.store.db().clone();
                let roots = roots::root_paths(&db);
                match regroup::apply_combine(&mut db, &ids, s(a, "name"), &roots) {
                    Err(e) => err(e),
                    Ok((keep, moved)) => {
                        self.move_runtime(&moved);
                        let r = self.save(move |d| *d = db);
                        if r["ok"] == true { json!({ "ok": true, "projectId": keep }) } else { r }
                    }
                }
            }

            // ── Import ──────────────────────────────────────────
            "importScan" => {
                let db = self.store.db();
                let pid = s(a, "projectId").map(str::to_string).unwrap_or_else(|| db.active_project.clone());
                let Some(p) = db.project(&pid) else { return err("No active project.") };
                scan_project_tree(p.base_dir().unwrap_or(""), &p.commands)
            }
            "importApply" => self.import_apply(a),

            // ── Master folders ──────────────────────────────────
            "rootsSuggestion" => json!({ "path": roots::suggest_root(self.store.db()) }),
            "rootsAddPath" => self.roots_add(s(a, "path").unwrap_or("")),
            "rootsConfirmReplace" => self.roots_confirm_replace(),
            "rootsRemove" => {
                let Some(found) = self.find_root(s(a, "root").unwrap_or("")) else { return err("Unknown folder.") };
                let k = key(&found);
                self.save(move |db| set_roots(db, root_list(db).into_iter().filter(|r| key(r) != k).collect()))
            }
            "rootsMove" => {
                let root = s(a, "root").unwrap_or("").to_string();
                let delta = a.get("delta").and_then(Value::as_i64).unwrap_or(1);
                let list = root_list(self.store.db());
                let Some(i) = list.iter().position(|r| key(r) == key(&root)) else { return json!({ "ok": false }) };
                let j = if delta < 0 { i.checked_sub(1) } else { Some(i + 1) };
                let Some(j) = j.filter(|j| *j < list.len()) else { return json!({ "ok": false }) };
                self.save(move |db| {
                    let mut l = root_list(db);
                    l.swap(i, j);
                    set_roots(db, l)
                })
            }
            "rootsFind" => match self.find_root(s(a, "root").unwrap_or("")) {
                Some(r) => json!({ "ok": true, "root": r, "exists": is_dir(&r) }),
                None => err("Unknown folder."),
            },
            "rootsDismissPrompt" => self.save(|db| {
                db.extra.insert("rootsPromptDismissed".into(), json!(true));
            }),
            "rootsChangePreview" => self.roots_change_preview(s(a, "root").unwrap_or(""), s(a, "path").unwrap_or("")),
            "rootsChangeApply" => {
                let Some(RootPick { purpose: RootPickPurpose::Change { root, relink }, path, .. }) = self.take_pick(false) else {
                    return err("Pick the folder again.");
                };
                let mut moved = 0;
                let r = self.save(|db| moved = replace_root(db, &root, &path, relink));
                if r["ok"] == true { json!({ "ok": true, "moved": moved }) } else { r }
            }
            "rootsRelink" => {
                let Some(root) = self.find_root(s(a, "root").unwrap_or("")).filter(|r| !is_dir(r)) else {
                    return err("Nothing to relink.");
                };
                let Some(target) = relink_candidate(&root, &[]) else {
                    return err("No matching folder found. Use \"Change folder…\".");
                };
                let mut moved = 0;
                let t2 = target.clone();
                let r = self.save(|db| moved = replace_root(db, &root, &t2, true));
                if r["ok"] == true { json!({ "ok": true, "path": target, "moved": moved }) } else { r }
            }
            "repoHide" => {
                let folder = s(a, "path").unwrap_or("").to_string();
                let hidden = a.get("hidden").and_then(Value::as_bool).unwrap_or(false);
                if hidden && self.find_open_item(&folder).is_none() {
                    return err("Unknown folder.");
                }
                let k = key(&folder);
                self.save(move |db| {
                    let mut list: Vec<String> = db
                        .extra
                        .get("hiddenRepos")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    if hidden {
                        if !list.iter().any(|p| key(p) == k) {
                            list.push(folder);
                        }
                    } else {
                        list.retain(|p| key(p) != k);
                    }
                    db.extra.insert("hiddenRepos".into(), json!(list));
                })
            }
            "repoSetup" => self.repo_setup(s(a, "path").unwrap_or(""), s(a, "mode").unwrap_or("")),

            // ── Specific config changes (Phase B: replace whole-config saves) ─
            "projectAdd" => self.project_add(a),
            "projectRename" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                let name: String = s(a, "name").unwrap_or("").trim().chars().take(80).collect();
                if name.is_empty() {
                    return err("The project needs a name.");
                }
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                self.save(move |db| db.project_mut(&pid).unwrap().name = name)
            }
            "projectDelete" => {
                let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
                if self.store.db().project(&pid).is_none() {
                    return err("Unknown project.");
                }
                // Its running services are stopped by the save (removed commands are always stopped)
                self.save(move |db| {
                    db.projects.retain(|p| p.id != pid);
                    if db.active_project == pid {
                        db.active_project = db.projects.first().map(|p| p.id.clone()).unwrap_or_default();
                    }
                })
            }
            "commandAdd" => self.command_add(a),
            "commandUpdate" => self.command_update(a),
            "commandRemove" => {
                let (Some(pid), Some(cid)) = (s(a, "projectId").map(str::to_string), s(a, "commandId").map(str::to_string)) else {
                    return err("Unknown command.");
                };
                if self.store.db().command(&pid, &cid).is_none() {
                    return err("Unknown command.");
                }
                self.save(move |db| {
                    let p = db.project_mut(&pid).unwrap();
                    p.commands.retain(|c| c.id != cid);
                    for c in &mut p.commands {
                        if c.start_after().as_deref() == Some(cid.as_str()) {
                            c.extra.remove("startAfter");
                        }
                    }
                })
            }
            "commandDuplicate" => {
                let (Some(pid), Some(cid)) = (s(a, "projectId").map(str::to_string), s(a, "commandId").map(str::to_string)) else {
                    return err("Unknown command.");
                };
                let Some((p, c)) = self.store.db().command(&pid, &cid) else { return err("Unknown command.") };
                // P7: the copy keeps the stored (sealed) secret values, so nothing has to be re-entered
                let mut copy = c.clone();
                copy.id = new_command_id(&p.commands);
                copy.display_name = format!("{} (copy)", c.display_name);
                let new_id = copy.id.clone();
                let index = p.commands.iter().position(|x| x.id == cid).unwrap();
                let r = self.save(move |db| db.project_mut(&pid).unwrap().commands.insert(index + 1, copy));
                if r["ok"] == true { json!({ "ok": true, "commandId": new_id }) } else { r }
            }
            _ => err(format!("Unknown request: {name}")),
        }
    }

    /// `{ projectId, commandId }`, or a bare command id (older windows) meaning the active project.
    fn resolve_target(&self, a: &Value) -> Option<Target> {
        let target = a.get("target").unwrap_or(a);
        let db = self.store.db();
        let t = match target {
            Value::String(cid) => Target::new(db.active_project.clone(), cid.clone()),
            Value::Object(_) => Target::new(s(target, "projectId")?, s(target, "commandId")?),
            _ => return None,
        };
        self.command_for(&t).map(|_| t)
    }

    fn log_target(&self, a: &Value) -> Target {
        match s(a, "commandId") {
            None => shell_target(),
            Some(cid) => Target::new(s(a, "projectId").unwrap_or(""), cid),
        }
    }

    fn project_live(&self, project_id: &str) -> bool {
        self.services.iter().any(|(t, s)| t.project_id == project_id && t.command_id.is_some() && s.rt.status.live())
    }

    /// Saves a config change; `{ ok }` or `{ ok: false, error }`.
    fn save(&mut self, f: impl FnOnce(&mut Database)) -> Value {
        match self.update_config(f) {
            Ok(()) => ok(),
            Err(e) => err(e),
        }
    }

    /// Logs and last status follow a command that moves to another project (split / combine).
    fn move_runtime(&mut self, moved: &regroup::Moves) {
        for ((fp, fc), (tp, tc)) in moved {
            let from = Target::new(fp, fc);
            let to = Target::new(tp, tc);
            if from == to {
                continue;
            }
            if let Some(mut svc) = self.services.remove(&from) {
                svc.restart_attempts = 0;
                self.services.insert(to, svc);
            }
        }
    }

    // ── Snapshot ─────────────────────────────────────────────────

    /// The state the windows render: config without secret values, plus runtime, folder health,
    /// git branch, identity and the master-folder workspace.
    pub(crate) fn snapshot(&mut self) -> Value {
        let db = self.store.db().clone();
        let workspace = self.workspace(&db);
        let mut out = serde_json::to_value(&db).unwrap_or_default();
        let all_folders: Vec<String> = db.projects.iter().filter_map(|p| p.base_dir().map(str::to_string)).collect();
        let placement = workspace["placement"].clone();
        let group_of = |p: &Project| -> String {
            match placement.get(&p.id) {
                None => p.base_dir().map(|b| paths::dirname(&key(b))).unwrap_or_else(|| "(no folder)".into()),
                Some(pl) if pl["section"] == "root" => {
                    let c = pl["container"]["path"].as_str().or(pl["root"].as_str()).unwrap_or("");
                    format!("root:{}", key(c))
                }
                Some(pl) => pl["section"].as_str().unwrap_or("").to_string(),
            }
        };
        let ids = identity::identities(&db.projects, group_of);
        let projects = out["projects"].as_array_mut().cloned().unwrap_or_default();
        let mut new_projects = Vec::new();
        for (pv, p) in projects.into_iter().zip(&db.projects) {
            let mut pv = pv;
            if let Some(base) = p.base_dir() {
                let exists = is_dir(base);
                pv["folderMissing"] = json!(!exists);
                if exists {
                    if let Some(g) = crate::git::branch_info(Path::new(base)) {
                        pv["branch"] = json!(g.branch);
                        pv["detached"] = json!(g.detached);
                        pv["repoRoot"] = json!(g.root.to_string_lossy());
                    }
                } else {
                    pv["relinkTo"] = json!(relink_candidate(base, &all_folders));
                }
            }
            let cmds = pv["commands"].as_array().cloned().unwrap_or_default();
            let mut new_cmds = Vec::new();
            for (mut cv, c) in cmds.into_iter().zip(&p.commands) {
                if let Some(env) = cv.get("env").and_then(Value::as_array).cloned() {
                    let masked: Vec<Value> = env
                        .into_iter()
                        .map(|e| {
                            if e.get("secret").and_then(Value::as_bool) == Some(true) {
                                let has = e.get("enc").is_some_and(|v| !v.is_null() && v != "")
                                    || e.get("value").is_some_and(|v| !v.is_null() && v != "");
                                json!({ "key": e["key"], "secret": true, "hasValue": has })
                            } else {
                                e
                            }
                        })
                        .collect();
                    cv["env"] = json!(masked);
                }
                match command_folder(p, c) {
                    None => cv["folder"] = Value::Null,
                    Some(f) => {
                        cv["folder"] = json!(f);
                        let exists = is_dir(&f);
                        cv["folderMissing"] = json!(!exists);
                        if exists
                            && let Some(g) = crate::git::branch_info(Path::new(&f)) {
                                cv["branch"] = json!(g.branch);
                                cv["detached"] = json!(g.detached);
                                cv["repoRoot"] = json!(g.root.to_string_lossy());
                            }
                    }
                }
                let rt = self.services.get(&Target::new(&p.id, &c.id)).map(|s| s.rt.clone()).unwrap_or_default();
                if let Value::Object(m) = serde_json::to_value(rt).unwrap_or_default() {
                    for (k, v) in m {
                        cv[k] = v;
                    }
                }
                new_cmds.push(cv);
            }
            pv["commands"] = json!(new_cmds);
            pv["identity"] = ids.get(&p.id).cloned().unwrap_or(Value::Null);
            new_projects.push(pv);
        }
        out["projects"] = json!(new_projects);
        out["secretsEncrypted"] = json!(self.secrets.available());
        if let Some(edit) = &self.active_command_to_edit {
            out["activeCommandToEdit"] = json!(edit);
        }
        out["workspace"] = workspace;
        out
    }

    fn workspace(&mut self, db: &Database) -> Value {
        let paths_list = roots::root_paths(db);
        self.sync_scans(&paths_list);
        let mut ws = roots::build_workspace(db, Some(&ScanView { scans: &self.root_scans, scanning: &self.scanning }));
        if let Some(list) = ws["roots"].as_array_mut() {
            for r in list {
                if r["exists"] == false {
                    r["relinkTo"] = json!(relink_candidate(r["path"].as_str().unwrap_or(""), &[]));
                }
            }
        }
        let dismissed = db.extra.get("rootsPromptDismissed").and_then(Value::as_bool).unwrap_or(false);
        ws["prompt"] = if paths_list.is_empty() && !dismissed { json!({ "suggestion": roots::suggest_root(db) }) } else { Value::Null };
        ws
    }

    /// Make the scans match the configured master folders.
    fn sync_scans(&mut self, paths_list: &[String]) {
        let wanted: HashSet<String> = paths_list.iter().map(|p| key(p)).collect();
        self.root_scans.retain(|k, _| wanted.contains(k));
        for p in paths_list {
            let k = key(p);
            if !self.root_scans.contains_key(&k) && !self.scanning.contains(&k) {
                self.rescan(p, None);
            }
        }
    }

    /// Scans one master folder off the engine task; `done` is told when the result is stored.
    pub(crate) fn rescan(&mut self, root: &str, done: Option<oneshot::Sender<()>>) {
        let k = key(root);
        if !self.scanning.insert(k.clone()) {
            if let Some(d) = done {
                let _ = d.send(());
            }
            return;
        }
        let tx = self.tx.clone();
        let root = root.to_string();
        tokio::spawn(async move {
            let r2 = root.clone();
            let job = tokio::task::spawn_blocking(move || roots::scan_root(&r2));
            let result = match tokio::time::timeout(SCAN_TIMEOUT, job).await {
                Ok(Ok(v)) => v,
                _ => json!({ "path": root, "exists": true, "timedOut": true, "items": [], "other": 0, "watch": [root] }),
            };
            let _ = tx.send(Msg::Call(Box::new(move |c: &mut Core| {
                c.scanning.remove(&k);
                let changed = c.root_scans.get(&k).is_none_or(|before| roots::shape(before) != roots::shape(&result));
                c.root_scans.insert(k, result);
                c.rewatch();
                if changed {
                    c.emit(Event::FoldersChanged {});
                }
                if let Some(d) = done {
                    let _ = d.send(());
                }
            })));
        });
    }

    // ── saveConfig (the whole-config save windows still use) ─────

    fn save_config(&mut self, data: &Value) -> Value {
        let Some(projects) = data.get("projects").and_then(Value::as_array) else {
            self.emit(Event::ConfigChanged { revision: self.store.revision() });
            return json!(false);
        };
        if let Some(edit) = data.get("activeCommandToEdit").and_then(Value::as_str) {
            self.active_command_to_edit = Some(edit.to_string());
        }
        let previous = self.store.db().clone();
        let mut sealed = data.clone();
        let mut new_projects = Vec::new();
        for p in projects {
            let mut p = p.clone();
            let pid = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(cmds) = p.get_mut("commands").and_then(Value::as_array_mut) {
                for c in cmds.iter_mut() {
                    let cid = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let Some(env) = c.get("env").and_then(Value::as_array).cloned() else { continue };
                    let old = previous.command(&pid, &cid).map(|(_, oc)| oc.env()).unwrap_or_default();
                    c["env"] = json!(self.seal_env(&env, &old));
                }
            }
            new_projects.push(p);
        }
        sealed["projects"] = json!(new_projects);
        let db: Database = match serde_json::from_value(sealed) {
            Ok(d) => d,
            Err(e) => return err(format!("The project list could not be read: {e}")),
        };
        match self.update_config(move |d| {
            let version = d.version;
            *d = db;
            d.version = version;
        }) {
            Ok(()) => json!(true),
            Err(e) => err(e),
        }
    }

    /// Window -> disk: encrypt new secret values; keep the stored one when the form left it untouched.
    fn project_add(&mut self, a: &Value) -> Value {
        let name: String = s(a, "name").unwrap_or("").trim().chars().take(80).collect();
        if name.is_empty() {
            return err("Give the project a name.");
        }
        // Same id rule as the Electron app: spaces to dashes, lowercased
        let id = name.split_whitespace().collect::<Vec<_>>().join("-").to_lowercase();
        if self.store.db().project(&id).is_some() {
            return err(format!("A project called \"{name}\" already exists."));
        }
        let dir = s(a, "baseDirectory").map(str::trim).filter(|d| !d.is_empty()).map(str::to_string);
        let pid = id.clone();
        let r = self.save(move |db| {
            db.projects.push(Project { id: pid.clone(), name, base_directory: dir, ..Default::default() });
            db.active_project = pid;
        });
        if r["ok"] == true { json!({ "ok": true, "projectId": id }) } else { r }
    }

    /// The fields a command form may set; runtime and derived fields are ignored.
    fn command_fields(&self, values: &Value, old_env: &[EnvEntry]) -> Result<serde_json::Map<String, Value>, String> {
        let Some(obj) = values.as_object() else { return Err("Nothing to save.".into()) };
        let mut out = serde_json::Map::new();
        for (k, v) in obj {
            if k == "id" || crate::model::RUNTIME_FIELDS.contains(&k.as_str()) {
                continue;
            }
            if k == "env" {
                let env = v.as_array().cloned().unwrap_or_default();
                out.insert(k.clone(), json!(self.seal_env(&env, old_env)));
            } else {
                out.insert(k.clone(), v.clone());
            }
        }
        let command = out.get("command").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if command.is_empty() {
            return Err("Enter the command to run.".into());
        }
        if command.chars().count() > 4000 {
            return Err("That command is too long.".into());
        }
        Ok(out)
    }

    fn command_add(&mut self, a: &Value) -> Value {
        let Some(pid) = s(a, "projectId").map(str::to_string) else { return err("Unknown project.") };
        let Some(p) = self.store.db().project(&pid) else { return err("Unknown project.") };
        let fields = match self.command_fields(a.get("command").unwrap_or(&Value::Null), &[]) {
            Ok(f) => f,
            Err(e) => return err(e),
        };
        let id = new_command_id(&p.commands);
        let mut obj = fields;
        obj.insert("id".into(), json!(id));
        let cmd: Command = match serde_json::from_value(Value::Object(obj)) {
            Ok(c) => c,
            Err(e) => return err(format!("The command could not be read: {e}")),
        };
        let r = self.save(move |db| db.project_mut(&pid).unwrap().commands.push(cmd));
        if r["ok"] == true { json!({ "ok": true, "commandId": id }) } else { r }
    }

    fn command_update(&mut self, a: &Value) -> Value {
        let (Some(pid), Some(cid)) = (s(a, "projectId").map(str::to_string), s(a, "commandId").map(str::to_string)) else {
            return err("Unknown command.");
        };
        let Some((_, old)) = self.store.db().command(&pid, &cid) else {
            return err("That command no longer exists. It may have been removed in another window.");
        };
        let fields = match self.command_fields(a.get("command").unwrap_or(&Value::Null), &old.env()) {
            Ok(f) => f,
            Err(e) => return err(e),
        };
        // Merge over the stored command (fields the form doesn't send are kept)
        let mut obj = match serde_json::to_value(old) {
            Ok(Value::Object(o)) => o,
            _ => return err("The command could not be read."),
        };
        for (k, v) in fields {
            obj.insert(k, v);
        }
        let cmd: Command = match serde_json::from_value(Value::Object(obj)) {
            Ok(c) => c,
            Err(e) => return err(format!("The command could not be read: {e}")),
        };
        self.save(move |db| {
            if let Some(c) = db.project_mut(&pid).and_then(|p| p.commands.iter_mut().find(|c| c.id == cid)) {
                *c = cmd;
            }
        })
    }

    fn seal_env(&self, env: &[Value], old: &[EnvEntry]) -> Vec<Value> {
        env.iter()
            .filter(|e| e.get("key").and_then(Value::as_str).is_some_and(|k| !k.is_empty()))
            .map(|e| {
                let k = e["key"].as_str().unwrap().to_string();
                let secret = e.get("secret").and_then(Value::as_bool).unwrap_or(false);
                if !secret {
                    let v = match e.get("value") {
                        None | Some(Value::Null) => String::new(),
                        Some(Value::String(s)) => s.clone(),
                        Some(other) => other.to_string(),
                    };
                    return json!({ "key": k, "value": v });
                }
                if let Some(v) = e.get("value").and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    return match self.secrets.encrypt(v).filter(|_| self.secrets.available()) {
                        Some(enc) => json!({ "key": k, "secret": true, "enc": enc }),
                        None => json!({ "key": k, "secret": true, "value": v }),
                    };
                }
                match old.iter().find(|o| o.secret && o.key == k) {
                    Some(o) if o.enc.is_some() => json!({ "key": k, "secret": true, "enc": o.enc }),
                    Some(o) if o.value.is_some() => json!({ "key": k, "secret": true, "value": o.value }),
                    _ => json!({ "key": k, "secret": true }),
                }
            })
            .collect()
    }

    // ── Import ──────────────────────────────────────────────────

    fn import_apply(&mut self, a: &Value) -> Value {
        let Some(items) = a.get("items").and_then(Value::as_array) else { return json!({ "ok": false }) };
        let db = self.store.db();
        let pid = s(a, "projectId").map(str::to_string).unwrap_or_else(|| db.active_project.clone());
        let Some(p) = db.project(&pid) else { return err("No active project.") };
        let base = p.base_dir().map(str::to_string);
        let mut existing: HashSet<String> =
            p.commands.iter().map(|c| import_key(c.working_directory.as_deref().unwrap_or(""), &c.command)).collect();
        let ok_folder = |wd: &str| wd.is_empty() || (plain_folder_name(wd) && base.as_ref().is_some_and(|b| is_dir(Path::new(b).join(wd))));
        let mut clean = Vec::new();
        for i in items {
            let (Some(cmd), Some(name)) = (s(i, "command"), s(i, "name")) else { continue };
            let command = cmd.trim().to_string();
            let name: String = name.trim().chars().take(80).collect();
            let icon = s(i, "icon").filter(|ic| (1..=20).contains(&ic.len()) && ic.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
            let wd = s(i, "workingDirectory").map(str::trim).unwrap_or("").to_string();
            if command.is_empty() || command.chars().count() > 2000 || !ok_folder(&wd) || !existing.insert(import_key(&wd, &command)) {
                continue;
            }
            clean.push((name, command, icon.map(str::to_string), wd));
            if clean.len() == 50 {
                break;
            }
        }
        let added = clean.len();
        let r = self.save(move |db| {
            let p = db.project_mut(&pid).unwrap();
            for (name, command, icon, wd) in clean {
                let id = new_command_id(&p.commands);
                let mut c = Command {
                    id,
                    display_name: if name.is_empty() { "Unnamed Command".into() } else { name },
                    command,
                    working_directory: Some(wd),
                    ..Default::default()
                };
                c.extra.insert("icon".into(), json!(icon));
                c.extra.insert("port".into(), json!(""));
                c.extra.insert("startupDelay".into(), json!("0"));
                p.commands.push(c);
            }
        });
        if r["ok"] == true { json!({ "ok": true, "added": added }) } else { r }
    }

    // ── Master folders ──────────────────────────────────────────

    fn find_root(&self, root: &str) -> Option<String> {
        let k = key(root);
        root_list(self.store.db()).into_iter().find(|p| key(p) == k)
    }

    fn take_pick(&mut self, add: bool) -> Option<RootPick> {
        let p = self.pending_root_pick.take()?;
        let right = matches!((&p.purpose, add), (RootPickPurpose::Add { .. }, true) | (RootPickPurpose::Change { .. }, false));
        (right && p.at.elapsed() < PICK_TTL).then_some(p)
    }

    fn roots_add(&mut self, folder: &str) -> Value {
        if folder.is_empty() {
            return json!({ "ok": false, "canceled": true });
        }
        if !is_dir(folder) {
            return err("That folder doesn't exist.");
        }
        match roots::check_overlap(folder, &root_list(self.store.db())) {
            Overlap::Error(e) => err(e),
            Overlap::Contains(inside) => {
                self.pending_root_pick =
                    Some(RootPick { purpose: RootPickPurpose::Add { contains: inside.clone() }, path: folder.into(), at: Instant::now() });
                json!({ "ok": false, "needsReplace": true, "path": folder, "contains": inside })
            }
            Overlap::Ok => {
                let f = folder.to_string();
                let r = self.save(move |db| {
                    let mut l = root_list(db);
                    l.push(f);
                    set_roots(db, l)
                });
                if r["ok"] == true { json!({ "ok": true, "path": folder }) } else { r }
            }
        }
    }

    fn roots_confirm_replace(&mut self) -> Value {
        let Some(RootPick { purpose: RootPickPurpose::Add { contains: inside }, path, .. }) = self.take_pick(true) else {
            return err("Pick the folder again.");
        };
        let drop: HashSet<String> = inside.iter().map(|p| key(p)).collect();
        let p2 = path.clone();
        let r = self.save(move |db| {
            let list = root_list(db);
            let at = list.iter().position(|r| drop.contains(&key(r)));
            let mut rest: Vec<String> = list.into_iter().filter(|r| !drop.contains(&key(r))).collect();
            let at = at.unwrap_or(rest.len()).min(rest.len());
            rest.insert(at, p2);
            set_roots(db, rest)
        });
        if r["ok"] == true { json!({ "ok": true, "path": path }) } else { r }
    }

    fn roots_change_preview(&mut self, root: &str, folder: &str) -> Value {
        let Some(root) = self.find_root(root) else { return err("Unknown folder.") };
        if folder.is_empty() || key(folder) == key(&root) {
            return json!({ "ok": false, "canceled": true });
        }
        let db = self.store.db();
        let others: Vec<String> = root_list(db).into_iter().filter(|p| key(p) != key(&root)).collect();
        match roots::check_overlap(folder, &others) {
            Overlap::Error(e) => return err(e),
            Overlap::Contains(c) => {
                return err(format!("It holds {}, which is already in the list. Remove that first.", c.join(", ")));
            }
            Overlap::Ok => {}
        }
        let old_missing = !is_dir(&root);
        let rk = key(&root);
        let under: Vec<&Project> = db.projects.iter().filter(|p| p.base_dir().is_some_and(|b| contains(&rk, &key(b)))).collect();
        let fk = key(folder);
        let relinkable: Vec<&&Project> = if old_missing {
            under.iter().filter(|p| is_dir(Path::new(folder).join(paths::relative(&root, p.base_dir().unwrap())))).collect()
        } else {
            Vec::new()
        };
        let stay: Vec<&&Project> = under.iter().filter(|p| contains(&fk, &key(p.base_dir().unwrap()))).collect();
        let names = |v: &[&&Project]| v.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
        let mv: Vec<&&Project> = if old_missing {
            under.iter().filter(|p| !relinkable.iter().any(|r| r.id == p.id)).collect()
        } else {
            under.iter().filter(|p| !stay.iter().any(|r| r.id == p.id)).collect()
        };
        let result = json!({
            "ok": true, "root": root, "path": folder, "oldMissing": old_missing, "found": is_dir(folder),
            "stay": if old_missing { names(&relinkable) } else { names(&stay) },
            "move": names(&mv),
            "relink": if old_missing { relinkable.len() } else { 0 },
        });
        self.pending_root_pick = Some(RootPick {
            purpose: RootPickPurpose::Change { root, relink: old_missing && !relinkable.is_empty() },
            path: folder.into(),
            at: Instant::now(),
        });
        result
    }

    /// The repo (or container) a window names must be one the scan found and no project covers.
    fn find_open_item(&mut self, folder: &str) -> Option<Value> {
        let k = key(folder);
        let db = self.store.db().clone();
        let ws = self.workspace(&db);
        for r in ws["roots"].as_array()? {
            for it in r["items"].as_array()? {
                if key(it["path"].as_str().unwrap_or("")) == k {
                    return Some(it.clone());
                }
                if it["kind"] == "folder"
                    && let Some(repo) = it["repos"].as_array().and_then(|rs| rs.iter().find(|rp| key(rp["path"].as_str().unwrap_or("")) == k)) {
                        return Some(repo.clone());
                    }
            }
        }
        None
    }

    fn repo_setup(&mut self, folder: &str, mode: &str) -> Value {
        let Some(item) = self.find_open_item(folder) else {
            return err("That folder is already set up, or it moved. Try again after the list refreshes.");
        };
        let mut taken: HashSet<String> = self.store.db().projects.iter().map(|p| p.id.clone()).collect();
        let mut made: Vec<(Project, usize, usize)> = Vec::new();
        if item["kind"] == "folder" && mode == "separate" {
            for r in item["repos"].as_array().into_iter().flatten() {
                if r["runnable"] == true && r["hidden"] != true {
                    made.push(project_from_folder(r["path"].as_str().unwrap_or(""), r["name"].as_str().unwrap_or(""), &mut taken));
                }
            }
        } else {
            made.push(project_from_folder(item["path"].as_str().unwrap_or(""), item["name"].as_str().unwrap_or(""), &mut taken));
        }
        if made.is_empty() {
            return err("Nothing runnable found in that folder.");
        }
        let ids: Vec<String> = made.iter().map(|m| m.0.id.clone()).collect();
        let commands: usize = made.iter().map(|m| m.2).sum();
        let needs_review = made.len() == 1 && made[0].2 == 0 && made[0].1 > 0;
        let first = ids[0].clone();
        let projects: Vec<Project> = made.into_iter().map(|m| m.0).collect();
        let r = self.save(move |db| {
            db.projects.extend(projects);
            db.active_project = first;
        });
        if r["ok"] != true {
            return r;
        }
        json!({ "ok": true, "projectIds": ids, "commands": commands, "needsReview": needs_review })
    }

    // ── Shell ───────────────────────────────────────────────────

    /// Opens the shared shell; a running one is kept, so its session and history survive.
    fn open_shell(&mut self) -> Value {
        let t = shell_target();
        if self.services.get(&t).is_some_and(|s| s.run.is_some()) {
            return ok();
        }
        let db = self.store.db();
        let home = self.home_dir.clone().unwrap_or_else(|| PathBuf::from("."));
        let mut dir = db.project(&db.active_project).and_then(|p| p.base_dir()).map(PathBuf::from).unwrap_or_else(|| home.clone());
        if !dir.is_dir() {
            self.system(&t, &format!("[info] Project folder not found ({}). Opening the shell in your home folder instead.\n", dir.display()));
            dir = home;
        }
        let svc = self.services.entry(t.clone()).or_default();
        svc.splitter = LineSplitter::new();
        svc.secrets.clear();
        self.spawn_now(&t, SpawnSpec { command: None, cwd: dir, env: Default::default() });
        ok()
    }
}

fn string_list(v: Option<&Value>) -> Option<Vec<String>> {
    v?.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

fn root_list(db: &Database) -> Vec<String> {
    roots::root_paths(db)
}

fn set_roots(db: &mut Database, list: Vec<String>) {
    // Keep any other fields stored with each root
    let old: Vec<Value> = db.extra.get("projectRoots").and_then(Value::as_array).cloned().unwrap_or_default();
    let out: Vec<Value> = list
        .into_iter()
        .map(|p| {
            old.iter()
                .find(|r| r.get("path").and_then(Value::as_str) == Some(p.as_str()))
                .cloned()
                .unwrap_or_else(|| json!({ "path": p }))
        })
        .collect();
    db.extra.insert("projectRoots".into(), json!(out));
}

/// Change a master folder; when the old one is gone, the projects under it can move with it.
fn replace_root(db: &mut Database, old: &str, new: &str, relink: bool) -> usize {
    let mut list = root_list(db);
    let Some(i) = list.iter().position(|r| key(r) == key(old)) else { return 0 };
    let mut moved = 0;
    if relink {
        for p in &mut db.projects {
            let Some(base) = p.base_dir().map(str::to_string) else { continue };
            let Some(next) = paths::rebase(&base, old, new) else { continue };
            if next == base || !is_dir(&next) {
                continue;
            }
            p.base_directory = Some(next);
            moved += 1;
            for c in &mut p.commands {
                let wd = c.working_directory.as_deref().map(str::trim).unwrap_or("").to_string();
                if !wd.is_empty() && Path::new(&wd).is_absolute()
                    && let Some(n) = paths::rebase(&wd, old, new) {
                        c.working_directory = Some(n);
                    }
            }
        }
    }
    let old_entry = db.extra.get("projectRoots").and_then(Value::as_array).and_then(|a| a.get(i).cloned());
    list[i] = new.to_string();
    let mut entries: Vec<Value> = db.extra.get("projectRoots").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(mut e) = old_entry {
        e["path"] = json!(new);
        if i < entries.len() {
            entries[i] = e;
        }
    }
    db.extra.insert("projectRoots".into(), json!(entries));
    moved
}

/// A project for `folder` with the commands the scan pre-ticks: (project, found, picked).
fn project_from_folder(folder: &str, name: &str, taken: &mut HashSet<String>) -> (Project, usize, usize) {
    let res = scan_project_tree(folder, &[]);
    let items: Vec<Value> = res["groups"].as_array().into_iter().flatten().flat_map(|g| g["items"].as_array().cloned().unwrap_or_default()).collect();
    let mut commands: Vec<Command> = Vec::new();
    for i in items.iter().filter(|i| i["preselect"] == true).take(50) {
        let mut c = Command {
            id: new_command_id(&commands),
            display_name: i["name"].as_str().unwrap_or("").into(),
            command: i["command"].as_str().unwrap_or("").into(),
            working_directory: Some(i["workingDirectory"].as_str().unwrap_or("").into()),
            ..Default::default()
        };
        c.extra.insert("icon".into(), i["icon"].clone());
        c.extra.insert("port".into(), json!(""));
        c.extra.insert("startupDelay".into(), json!("0"));
        commands.push(c);
    }
    let picked = commands.len();
    let id = regroup::unique_id(name, taken);
    (Project { id, name: name.into(), base_directory: Some(folder.into()), commands, ..Default::default() }, items.len(), picked)
}
