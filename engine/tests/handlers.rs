//! The window requests (`Engine::request`), end to end on a temp config and temp folders.
#![cfg(unix)]

use serde_json::{Value, json};
use stackconsole_engine::secrets::SecretStore;
use stackconsole_engine::{Engine, EngineOptions, Timings};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Reversible fake "encryption", so tests can see what was sealed.
struct FakeVault;
impl SecretStore for FakeVault {
    fn available(&self) -> bool {
        true
    }
    fn encrypt(&self, plain: &str) -> Option<String> {
        Some(format!("sealed:{}", plain.chars().rev().collect::<String>()))
    }
    fn decrypt(&self, sealed: &str) -> Option<String> {
        sealed.strip_prefix("sealed:").map(|s| s.chars().rev().collect())
    }
}

struct H {
    e: Engine,
    data: tempfile::TempDir,
    root: tempfile::TempDir,
}

async fn h() -> H {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (e, _) = Engine::start(EngineOptions {
        data_dir: data.path().into(),
        secrets: Arc::new(FakeVault),
        timings: Timings { flush: Duration::from_millis(20), stop_grace: Duration::from_millis(500), ..Timings::default() },
        home_dir: Some(root.path().into()),
    })
    .unwrap();
    H { e, data, root }
}

impl H {
    async fn req(&self, name: &str, args: Value) -> Value {
        self.e.request(name, args).await
    }
    fn path(&self, rel: &str) -> String {
        self.root.path().join(rel).to_string_lossy().into_owned()
    }
    fn mkdir(&self, rel: &str) {
        std::fs::create_dir_all(self.root.path().join(rel)).unwrap();
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.data.path().join("projects.json")).unwrap()).unwrap()
    }
    async fn wait(&self, what: &str, mut f: impl FnMut(&Value) -> bool) -> Value {
        let start = Instant::now();
        loop {
            let snap = self.req("snapshot", json!({})).await;
            if f(&snap) {
                return snap;
            }
            if start.elapsed() > Duration::from_secs(5) {
                panic!("timed out waiting for {what}: {snap:#}");
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
}

fn cmd(snap: &Value, p: usize, c: usize) -> &Value {
    &snap["projects"][p]["commands"][c]
}

#[tokio::test(flavor = "multi_thread")]
async fn save_config_seals_secrets_and_snapshot_hides_them() {
    let h = h().await;
    h.mkdir("shop/.git");
    h.write("shop/.git/HEAD", "ref: refs/heads/main\n");
    let base = h.path("shop");
    let data = json!({ "activeProject": "shop", "activeCommandToEdit": "api", "projects": [{ "id": "shop", "name": "Shop", "baseDirectory": base,
        "commands": [{ "id": "api", "displayName": "API", "command": "echo $TOKEN; sleep 30", "port": "8000",
            "env": [{ "key": "A", "value": 1 }, { "key": "TOKEN", "secret": true, "value": "tok-12345" }, { "key": "" }] }] }] });
    assert_eq!(h.req("saveConfig", json!({ "data": data })).await, json!(true));

    let saved = h.saved();
    let env = &saved["projects"][0]["commands"][0]["env"];
    assert_eq!(env, &json!([{ "key": "A", "value": "1" }, { "key": "TOKEN", "secret": true, "enc": "sealed:54321-kot" }]));
    assert!(saved.get("activeCommandToEdit").is_none(), "UI hint is not saved");
    assert_eq!(saved["version"], 1);

    let snap = h.req("snapshot", json!({})).await;
    assert_eq!(cmd(&snap, 0, 0)["env"][1], json!({ "key": "TOKEN", "secret": true, "hasValue": true }));
    assert_eq!(cmd(&snap, 0, 0)["status"], "offline");
    assert_eq!(cmd(&snap, 0, 0)["folder"], base);
    assert_eq!(snap["projects"][0]["branch"], "main");
    assert_eq!(snap["projects"][0]["folderMissing"], false);
    assert_eq!(snap["projects"][0]["identity"]["mono"], "SH");
    assert_eq!(snap["activeCommandToEdit"], "api");
    assert_eq!(snap["secretsEncrypted"], true);
    assert_eq!(snap["workspace"]["placement"]["shop"]["section"], "other");
    assert!(snap["workspace"]["prompt"].is_object());

    // The form sends the secret back without a value ("keep"): the sealed one stays
    let mut again = data.clone();
    again["projects"][0]["commands"][0]["env"] = json!([{ "key": "TOKEN", "secret": true, "keep": true }]);
    assert_eq!(h.req("saveConfig", json!({ "data": again })).await, json!(true));
    assert_eq!(h.saved()["projects"][0]["commands"][0]["env"], json!([{ "key": "TOKEN", "secret": true, "enc": "sealed:54321-kot" }]));

    // It decrypts at spawn time and is masked in the log
    h.req("start", json!({ "projectId": "shop", "commandId": "api" })).await;
    let snap = h.wait("running", |s| cmd(s, 0, 0)["status"] == "running").await;
    assert_eq!(cmd(&snap, 0, 0)["envSummary"]["secrets"], 1);
    let start = Instant::now();
    loop {
        let logs = h.req("logs", json!({ "projectId": "shop", "commandId": "api" })).await;
        let lines: Vec<&str> = logs["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
        if lines.contains(&"••••••\n") {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "{lines:?}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // Removing the command in a whole-config save stops it
    let pid = cmd(&snap, 0, 0)["pid"].as_u64().unwrap() as i32;
    let mut removed = data.clone();
    removed["projects"][0]["commands"] = json!([]);
    h.req("saveConfig", json!({ "data": removed })).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(unsafe { libc::kill(pid, 0) } != 0, "process of a removed command keeps running");
    assert_eq!(h.req("saveConfig", json!({ "data": { "nope": 1 } })).await, json!(false));
}

#[tokio::test(flavor = "multi_thread")]
async fn master_folders_scan_setup_and_hide() {
    let h = h().await;
    h.write("projects/blog/package.json", r#"{"scripts":{"dev":"vite","build":"vite build"}}"#);
    h.mkdir("projects/blog/.git");
    h.write("projects/automart/api/artisan", "");
    h.write("projects/automart/web/package.json", r#"{"scripts":{"dev":"next dev"}}"#);
    let root = h.path("projects");
    // A projects folder inside it, then the parent: it replaces the inner one
    assert_eq!(h.req("rootsAddPath", json!({ "path": h.path("projects/automart") })).await["ok"], true);
    let r = h.req("rootsAddPath", json!({ "path": root })).await;
    assert_eq!(r["needsReplace"], true);
    assert_eq!(h.req("rootsConfirmReplace", json!({})).await["ok"], true);
    assert_eq!(h.saved()["projectRoots"], json!([{ "path": root }]));
    assert_eq!(h.req("rootsConfirmReplace", json!({})).await["error"], "Pick the folder again.");

    h.req("rootsRescan", json!({ "root": root })).await;
    let snap = h.wait("scan", |s| s["workspace"]["roots"][0]["scanning"] == false).await;
    let items = snap["workspace"]["roots"][0]["items"].as_array().unwrap();
    assert_eq!(items.iter().map(|i| i["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["automart", "blog"]);

    let r = h.req("repoSetup", json!({ "path": h.path("projects/automart"), "mode": "separate" })).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["projectIds"], json!(["api", "web"]));
    let r = h.req("repoSetup", json!({ "path": h.path("projects/blog"), "mode": "repo" })).await;
    assert_eq!(r["commands"], 1, "only the dev server is pre-ticked");
    let snap = h.req("snapshot", json!({})).await;
    assert_eq!(snap["activeProject"], "blog");
    assert_eq!(snap["workspace"]["placement"]["api"]["section"], "root");
    assert_eq!(snap["workspace"]["placement"]["api"]["container"]["name"], "automart");
    assert!(snap["workspace"]["roots"][0]["items"].as_array().unwrap().is_empty(), "set-up repos leave the list");
    assert!(snap["workspace"]["prompt"].is_null());
    assert_eq!(h.req("repoSetup", json!({ "path": h.path("projects/blog") })).await["ok"], false);

    assert_eq!(h.req("rootsRemove", json!({ "root": root })).await["ok"], true);
    assert_eq!(h.req("rootsRemove", json!({ "root": root })).await["error"], "Unknown folder.");
}

#[tokio::test(flavor = "multi_thread")]
async fn import_apply_validates_and_dedupes() {
    let h = h().await;
    h.write("lms/backend/artisan", "");
    h.write("lms/package.json", r#"{"scripts":{"dev":"vite"}}"#);
    let base = h.path("lms");
    h.req("saveConfig", json!({ "data": { "activeProject": "lms", "projects": [{ "id": "lms", "name": "LMS", "baseDirectory": base, "commands": [] }] } })).await;
    let scan = h.req("importScan", json!({})).await;
    assert_eq!(scan["ok"], true);
    assert_eq!(scan["groups"].as_array().unwrap().len(), 2);
    let items = json!([
        { "name": "Vite", "command": "npm run dev", "icon": "vite", "workingDirectory": "" },
        { "name": "Vite again", "command": "npm run dev", "workingDirectory": "" },
        { "name": "Serve", "command": "php artisan serve", "icon": "BAD ICON", "workingDirectory": "backend" },
        { "name": "Escape", "command": "x", "workingDirectory": "../etc" },
        { "name": "Missing", "command": "y", "workingDirectory": "nope" },
        { "name": "  ", "command": "   " }
    ]);
    let r = h.req("importApply", json!({ "items": items })).await;
    assert_eq!(r, json!({ "ok": true, "added": 2 }));
    let saved = h.saved();
    let cmds = saved["projects"][0]["commands"].as_array().unwrap();
    assert_eq!(cmds[0]["icon"], "vite");
    assert_eq!(cmds[1]["icon"], Value::Null);
    assert_eq!(cmds[1]["workingDirectory"], "backend");
    assert_eq!(cmds[1]["port"], "");
    assert!(cmds[0]["id"].as_str().unwrap().starts_with("cmd_"));
    assert_ne!(cmds[0]["id"], cmds[1]["id"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn relink_moves_only_paths_inside_the_old_folder() {
    // P10
    let h = h().await;
    h.mkdir("new/app");
    let old = h.path("old/app");
    let data = json!({ "projects": [
        { "id": "x", "name": "X", "baseDirectory": h.path("new") },
        { "id": "app", "name": "App", "baseDirectory": old, "commands": [
            { "id": "a", "command": "x", "workingDirectory": format!("{old}/api") },
            { "id": "b", "command": "y", "workingDirectory": format!("{old}2/api") }]}]});
    h.req("saveConfig", json!({ "data": data })).await;
    let snap = h.req("snapshot", json!({})).await;
    assert_eq!(snap["projects"][1]["folderMissing"], true);
    assert_eq!(snap["projects"][1]["relinkTo"], h.path("new/app"));
    let r = h.req("projectRelink", json!({ "projectId": "app" })).await;
    assert_eq!(r["folder"], h.path("new/app"));
    let saved = h.saved();
    assert_eq!(saved["projects"][1]["commands"][0]["workingDirectory"], format!("{}/api", h.path("new/app")));
    assert_eq!(saved["projects"][1]["commands"][1]["workingDirectory"], format!("{old}2/api"), "app2 must not move");
}

#[tokio::test(flavor = "multi_thread")]
async fn split_keeps_logs_and_refuses_while_running() {
    let h = h().await;
    h.mkdir("lms/backend");
    h.mkdir("lms/frontend");
    let data = json!({ "activeProject": "lms", "projects": [{ "id": "lms", "name": "LMS", "baseDirectory": h.path("lms"), "commands": [
        { "id": "api", "displayName": "API", "command": "echo api-log; sleep 30", "workingDirectory": "backend" },
        { "id": "web", "displayName": "Web", "command": "sleep 30", "workingDirectory": "frontend" }]}]});
    h.req("saveConfig", json!({ "data": data })).await;
    h.req("start", json!({ "projectId": "lms", "commandId": "api" })).await;
    let p = h.req("splitPreview", json!({ "projectId": "lms" })).await;
    assert_eq!(p["live"], true);
    assert_eq!(h.req("splitApply", json!({ "projectId": "lms" })).await["error"], "Stop its running services first.");
    assert_eq!(h.req("projectArchive", json!({ "projectId": "lms", "archived": true })).await["ok"], false);
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.req("stopProject", json!({ "projectId": "lms" })).await;
    let r = h.req("splitApply", json!({ "projectId": "lms" })).await;
    assert_eq!(r["created"], json!(["backend", "frontend"]));
    let logs = h.req("logs", json!({ "projectId": "backend", "commandId": "api" })).await;
    assert!(logs["lines"].as_array().unwrap().iter().any(|l| l["text"] == "api-log\n"), "logs follow the command");
    assert_eq!(h.saved()["activeProject"], "backend");
    let c = h.req("combineCandidates", json!({ "projectId": "backend" })).await;
    assert_eq!(c["projects"][0]["id"], "frontend");
    let r = h.req("combineApply", json!({ "projectIds": ["backend", "frontend"], "name": "LMS" })).await;
    assert_eq!(r["projectId"], "backend");
    assert_eq!(h.saved()["projects"][0]["name"], "LMS");
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_pin_archive() {
    let h = h().await;
    h.mkdir("a");
    h.req("saveConfig", json!({ "data": { "projects": [{ "id": "a", "name": "Alpha", "baseDirectory": h.path("a"), "commands": [{"id": "c", "command": "x"}] }, { "id": "e", "name": "Empty" }] } })).await;
    assert_eq!(h.req("projectIdentity", json!({ "projectId": "a", "color": "red" })).await["error"], "Unknown colour.");
    assert_eq!(h.req("projectIdentity", json!({ "projectId": "a", "color": "cyan", "icon": "letters", "mono": "zq" })).await["ok"], true);
    let snap = h.req("snapshot", json!({})).await;
    assert_eq!(snap["projects"][0]["identity"]["color"], "cyan");
    assert_eq!(snap["projects"][0]["identity"]["mono"], "ZQ");
    h.req("projectIdentity", json!({ "projectId": "a", "color": null, "icon": null })).await;
    assert!(h.saved()["projects"][0].get("color").is_none());
    h.req("projectPin", json!({ "projectId": "a", "pinned": true })).await;
    assert_eq!(h.req("snapshot", json!({})).await["workspace"]["placement"]["a"]["section"], "pinned");
    assert_eq!(h.req("projectsArchiveEmpty", json!({})).await, json!({ "ok": true, "archived": 1 }));
    assert_eq!(h.saved()["projects"][1]["archived"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn port_check_and_free() {
    let h = h().await;
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = l.local_addr().unwrap().port();
    h.req("saveConfig", json!({ "data": { "projects": [{ "id": "p", "name": "P", "baseDirectory": h.path(""), "commands": [{"id": "c", "command": "x", "port": port.to_string()}] }] } })).await;
    let r = h.req("portCheck", json!({ "projectId": "p", "commandId": "c" })).await;
    assert_eq!(r["inUse"], true, "{r}");
    assert_eq!(r["pid"], std::process::id());
    // The engine refuses a pid it wasn't just shown, and its own process isn't StackConsole's service
    assert_eq!(h.req("portFree", json!({ "pid": 1 })).await["ok"], false);
    drop(l);
    let r = h.req("portCheck", json!({ "projectId": "p", "commandId": "c" })).await;
    assert_eq!(r["inUse"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn shell_opens_takes_input_and_survives_stop_everything() {
    let h = h().await;
    h.req("saveConfig", json!({ "data": { "projects": [] } })).await;
    assert_eq!(h.req("openShell", json!({})).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(500)).await;
    h.req("input", json!({ "commandId": null, "text": "echo shell-$((40+2))" })).await;
    let start = Instant::now();
    loop {
        let logs = h.req("logs", json!({ "projectId": null, "commandId": null })).await;
        if logs["lines"].as_array().unwrap().iter().any(|l| l["text"].as_str().unwrap().contains("shell-42")) {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "{logs:#}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    h.req("stopEverything", json!({})).await;
    assert_eq!(h.req("input", json!({ "commandId": null, "text": "true" })).await["ok"], true, "shell still open");
    h.e.shutdown(Duration::from_secs(3)).await;
    let _ = Path::new("");
}

/// Waits for a FoldersChanged event (no polling by the engine; C-6).
async fn folders_changed(rx: &mut tokio::sync::broadcast::Receiver<stackconsole_engine::Event>, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Ok(stackconsole_engine::Event::FoldersChanged {})) => return,
            Ok(_) => continue,
            Err(_) => panic!("no FoldersChanged after {what}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_branches_folders_and_master_folders() {
    let h = h().await;
    h.write("work/shop/.git/HEAD", "ref: refs/heads/main\n");
    h.mkdir("work/blog");
    h.mkdir("projects");
    let data = json!({ "projectRoots": [{ "path": h.path("projects") }], "projects": [
        { "id": "shop", "name": "Shop", "baseDirectory": h.path("work/shop"), "commands": [{ "id": "c", "command": "x" }] },
        { "id": "blog", "name": "Blog", "baseDirectory": h.path("work/blog"), "commands": [{ "id": "c", "command": "x" }] }]});
    h.req("saveConfig", json!({ "data": data })).await;
    h.req("rootsRescan", json!({ "root": h.path("projects") })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut rx = h.e.subscribe();

    // Branch switch, written the way git does it (new file renamed over HEAD)
    h.write("work/shop/.git/HEAD.lock", "ref: refs/heads/feature/x\n");
    std::fs::rename(h.root.path().join("work/shop/.git/HEAD.lock"), h.root.path().join("work/shop/.git/HEAD")).unwrap();
    folders_changed(&mut rx, "branch switch").await;
    assert_eq!(h.req("snapshot", json!({})).await["projects"][0]["branch"], "feature/x");

    // A project folder deleted
    std::fs::remove_dir_all(h.root.path().join("work/blog")).unwrap();
    folders_changed(&mut rx, "folder deleted").await;
    assert_eq!(h.req("snapshot", json!({})).await["projects"][1]["folderMissing"], true);

    // A new clone in the master folder
    h.write("projects/newrepo/package.json", "{}");
    folders_changed(&mut rx, "new repo").await;
    let snap = h.wait("new repo listed", |s| s["workspace"]["roots"][0]["items"].as_array().is_some_and(|i| !i.is_empty())).await;
    assert_eq!(snap["workspace"]["roots"][0]["items"][0]["name"], "newrepo");
}

#[tokio::test(flavor = "multi_thread")]
async fn specific_requests_replace_whole_config_saves() {
    // Phase B (B-2): P5, P6, P7
    let h = h().await;
    h.mkdir("a");
    let r = h.req("projectAdd", json!({ "name": "My Shop", "baseDirectory": h.path("a") })).await;
    assert_eq!(r, json!({ "ok": true, "projectId": "my-shop" }));
    assert_eq!(h.req("projectAdd", json!({ "name": "my  shop" })).await["error"], "A project called \"my  shop\" already exists.");
    assert_eq!(h.req("projectAdd", json!({ "name": "  " })).await["error"], "Give the project a name.");
    h.req("projectAdd", json!({ "name": "Blog" })).await;
    assert_eq!(h.saved()["activeProject"], "blog");

    // P5: the command goes to the project named in the request, whatever is active now
    let form = json!({ "displayName": "API", "command": "php artisan serve", "port": "8000", "status": "running", "pid": 9,
        "env": [{ "key": "TOKEN", "secret": true, "value": "tok-12345" }, { "key": "A", "value": "1" }] });
    let r = h.req("commandAdd", json!({ "projectId": "my-shop", "command": form })).await;
    let cid = r["commandId"].as_str().unwrap().to_string();
    let saved = h.saved();
    let shop = &saved["projects"][0];
    assert_eq!(shop["commands"][0]["displayName"], "API");
    assert!(shop["commands"][0].get("status").is_none() && shop["commands"][0].get("pid").is_none(), "runtime fields dropped");
    assert_eq!(shop["commands"][0]["env"][0]["enc"], "sealed:54321-kot");
    assert!(saved["projects"][1]["commands"].as_array().is_none_or(|c| c.is_empty()), "nothing lands in the active project");
    assert_eq!(h.req("commandAdd", json!({ "projectId": "my-shop", "command": { "displayName": "x" } })).await["error"], "Enter the command to run.");

    // Update merges over the stored command and keeps an untouched secret
    let r = h.req("commandUpdate", json!({ "projectId": "my-shop", "commandId": cid,
        "command": { "displayName": "API server", "command": "php artisan serve --port=8001", "env": [{ "key": "TOKEN", "secret": true, "keep": true }] } })).await;
    assert_eq!(r["ok"], true, "{r}");
    let c = &h.saved()["projects"][0]["commands"][0];
    assert_eq!(c["displayName"], "API server");
    assert_eq!(c["port"], "8000", "fields the form didn't send are kept");
    assert_eq!(c["env"], json!([{ "key": "TOKEN", "secret": true, "enc": "sealed:54321-kot" }]));

    // P7: a duplicate keeps its secrets and sits right after the original
    let r = h.req("commandDuplicate", json!({ "projectId": "my-shop", "commandId": cid })).await;
    let dup = r["commandId"].as_str().unwrap().to_string();
    assert_ne!(dup, cid);
    let saved = h.saved();
    let cmds = saved["projects"][0]["commands"].as_array().unwrap();
    assert_eq!(cmds[1]["displayName"], "API server (copy)");
    assert_eq!(cmds[1]["env"], cmds[0]["env"]);
    let snap = h.req("snapshot", json!({})).await;
    assert_eq!(snap["projects"][0]["commands"][1]["env"][0]["hasValue"], true);

    // Remove clears "start after" links to it; a stale edit is refused instead of silently dropped
    h.req("commandUpdate", json!({ "projectId": "my-shop", "commandId": dup, "command": { "command": "x", "startAfter": cid } })).await;
    assert_eq!(h.req("commandRemove", json!({ "projectId": "my-shop", "commandId": cid })).await["ok"], true);
    assert!(h.saved()["projects"][0]["commands"][0].get("startAfter").is_none());
    let r = h.req("commandUpdate", json!({ "projectId": "my-shop", "commandId": cid, "command": { "command": "y" } })).await;
    assert!(r["error"].as_str().unwrap().contains("no longer exists"));

    // Rename and delete
    assert_eq!(h.req("projectRename", json!({ "projectId": "blog", "name": " Journal " })).await["ok"], true);
    assert_eq!(h.saved()["projects"][1]["name"], "Journal");
    assert_eq!(h.req("projectDelete", json!({ "projectId": "blog" })).await["ok"], true);
    assert_eq!(h.saved()["activeProject"], "my-shop");
    assert_eq!(h.saved()["projects"].as_array().unwrap().len(), 1);
}
