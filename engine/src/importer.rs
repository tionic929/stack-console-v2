//! Finds runnable commands in a project folder: npm and composer scripts, Procfile, Laravel artisan,
//! Django. Read-only: only fixed file names directly inside the folder are read, each must resolve
//! (links included) to a regular file inside it, files over 1 MB are skipped. Reference: `main/importer.js`.

use crate::model::Command;
use crate::paths::natural_cmp;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const MAX_FILE_BYTES: u64 = 1024 * 1024;

static SERVER_SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(dev|start|serve|server|watch|preview|storybook)(:|$)").unwrap());
static TASK_SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(build|lint|test|e2e|coverage|format|fmt|typecheck|type-check|check|prepare|clean|release|deploy|migrate|seed|generate|codegen|ci)(:|$)").unwrap()
});
// The JS pattern also has `vite(?!\s+build)(?=\s|$)`, handled in server_body() (no lookaround here)
static SERVER_BODY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(next dev|nuxt dev|nodemon|webpack serve|webpack-dev-server|astro dev|remix dev|tsx watch|--watch|-w(\s|$)|http-server)").unwrap()
});
static VITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bvite(\s+|$)").unwrap());
static NOT_PRESELECTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(preview|storybook)(:|$)|:(prod|production|debug|inspect)$").unwrap());
static LIFECYCLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(preinstall|install|postinstall|prepare|prepublish|prepublishOnly|prepack|postpack|preversion|version|postversion)$").unwrap()
});
static PROCFILE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([\w-]+):\s*(.+)$").unwrap());

fn server_body(body: &str) -> bool {
    if SERVER_BODY.is_match(body) {
        return true;
    }
    VITE.find_iter(body).any(|m| {
        let after = &body[m.end()..];
        // `vite build` is a build, not a server
        !(m.as_str().len() > 4 && after.to_ascii_lowercase().starts_with("build"))
    })
}

const FRIENDLY_DEV: [(&str, &str); 5] = [
    (r"(?i)\bvite\b", "Vite Dev Server"),
    (r"(?i)\bnext dev\b", "Next.js Dev Server"),
    (r"(?i)\bnuxt dev\b", "Nuxt Dev Server"),
    (r"(?i)\bastro dev\b", "Astro Dev Server"),
    (r"(?i)\bremix dev\b", "Remix Dev Server"),
];

fn within(child: &Path, root: &Path) -> bool {
    child.starts_with(root)
}

fn skip(skipped: &mut Option<&mut Vec<Value>>, file: &str, reason: &str) {
    if let Some(s) = skipped {
        s.push(json!({ "file": file, "reason": reason }));
    }
}

/// Real path of `name` inside `real_dir` if it is a regular file there.
fn safe_file(real_dir: &Path, name: &str, mut skipped: Option<&mut Vec<Value>>) -> Option<PathBuf> {
    let file = real_dir.join(name);
    if std::fs::symlink_metadata(&file).is_err() {
        return None;
    }
    let real = match std::fs::canonicalize(&file) {
        Ok(r) => r,
        Err(_) => {
            skip(&mut skipped, name, "could not be read");
            return None;
        }
    };
    if !within(&real, real_dir) {
        skip(&mut skipped, name, "points outside the project folder");
        return None;
    }
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() > MAX_FILE_BYTES {
        skip(&mut skipped, name, "larger than 1 MB");
        return None;
    }
    Some(real)
}

fn read_text(real_dir: &Path, name: &str, skipped: &mut Vec<Value>) -> Option<String> {
    let file = safe_file(real_dir, name, Some(skipped))?;
    match std::fs::read(&file) {
        Ok(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Err(_) => {
            skipped.push(json!({ "file": name, "reason": "could not be read" }));
            None
        }
    }
}

fn read_json(real_dir: &Path, name: &str, skipped: &mut Vec<Value>) -> Option<Value> {
    let text = read_text(real_dir, name, skipped)?;
    match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => Some(v),
        Err(_) => {
            skipped.push(json!({ "file": name, "reason": "is not valid JSON" }));
            None
        }
    }
}

/// `build:prod` -> `Build Prod` (JS: replace [:_-]+ by a space, capitalise each word start).
pub fn title_case(name: &str) -> String {
    let mut spaced = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c == ':' || c == '_' || c == '-' {
            if !in_run {
                spaced.push(' ');
            }
            in_run = true;
        } else {
            spaced.push(c);
            in_run = false;
        }
    }
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut prev_word = false;
    for c in spaced.chars() {
        if word(c) && !prev_word {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        prev_word = word(c);
    }
    out.trim().to_string()
}

fn npm_runner(real_dir: &Path) -> &'static str {
    if safe_file(real_dir, "pnpm-lock.yaml", None).is_some() {
        "pnpm"
    } else if safe_file(real_dir, "yarn.lock", None).is_some() {
        "yarn"
    } else if safe_file(real_dir, "bun.lockb", None).is_some() || safe_file(real_dir, "bun.lock", None).is_some() {
        "bun"
    } else {
        "npm"
    }
}

fn icon_for(command: &str, body: &str) -> Value {
    let s = format!("{command} {body}").to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| s.contains(w));
    let icon = if has(&["vite"]) {
        "vite"
    } else if has(&["artisan", "laravel"]) {
        "laravel"
    } else if has(&["python", "uvicorn", "django", "manage.py", "flask"]) {
        "python"
    } else if has(&["react", "next"]) {
        "react"
    } else if has(&["vue", "nuxt"]) {
        "vue"
    } else if has(&["node", "npm", "pnpm", "yarn", "bun"]) {
        "node"
    } else {
        return Value::Null;
    };
    json!(icon)
}

fn item(name: String, command: String, detail: String, kind: &str, icon: Value, preselect: bool) -> Value {
    json!({ "name": name, "command": command, "detail": detail, "kind": kind, "icon": icon, "preselect": preselect })
}

fn npm_items(real_dir: &Path, scripts: &Map<String, Value>) -> Vec<Value> {
    let runner = npm_runner(real_dir);
    let names: Vec<&String> = scripts.keys().collect();
    let is_hook = |name: &str| {
        for prefix in ["pre", "post"] {
            if let Some(rest) = name.strip_prefix(prefix)
                && !rest.is_empty() && names.iter().any(|n| n.as_str() == rest) {
                    return true;
                }
        }
        false
    };
    scripts
        .iter()
        .filter_map(|(name, body)| {
            let body = body.as_str()?;
            if LIFECYCLE.is_match(name) || is_hook(name) {
                return None;
            }
            let server = !TASK_SCRIPT.is_match(name) && (SERVER_SCRIPT.is_match(name) || server_body(body));
            let has = |n: &str| names.iter().any(|x| x.as_str() == n);
            let preselect = server && !NOT_PRESELECTED.is_match(name) && !(name == "start" && (has("dev") || has("start:dev")));
            let command = if runner == "npm" { format!("npm run {name}") } else { format!("{runner} {name}") };
            let friendly = if name == "dev" {
                FRIENDLY_DEV.iter().find(|(re, _)| Regex::new(re).unwrap().is_match(body)).map(|(_, f)| f.to_string())
            } else {
                None
            };
            let icon = icon_for(&command, body);
            Some(item(friendly.unwrap_or_else(|| title_case(name)), command, body.to_string(), if server { "server" } else { "task" }, icon, preselect))
        })
        .collect()
}

fn composer_items(scripts: &Map<String, Value>) -> Vec<Value> {
    scripts
        .iter()
        .filter(|(name, _)| !(name.starts_with("pre-") || name.starts_with("post-")))
        .map(|(name, body)| {
            let detail = match body {
                Value::Array(parts) => parts.iter().map(js_string).collect::<Vec<_>>().join(" && "),
                other => js_string(other),
            };
            let kind = if name == "dev" || name == "serve" { "server" } else { "task" };
            // Laravel's composer "dev" starts serve + queue + vite together: offered, not pre-ticked
            item(title_case(name), format!("composer run {name}"), detail, kind, json!("php"), false)
        })
        .collect()
}

/// `String(value)` for the JSON values a manifest can hold.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

pub struct FolderScan {
    pub dir: PathBuf,
    pub groups: Vec<Value>,
    pub skipped: Vec<Value>,
}

pub fn scan_project_folder(dir: &str, existing: &[&Command]) -> Result<FolderScan, String> {
    let real_dir = (!dir.is_empty())
        .then(|| std::fs::canonicalize(dir).ok())
        .flatten()
        .filter(|d| d.is_dir())
        .ok_or_else(|| if dir.is_empty() { "This project has no folder set.".to_string() } else { format!("Folder not found: {dir}") })?;

    let mut known: HashSet<String> = existing.iter().map(|c| c.command.trim().to_lowercase()).collect();
    let mut groups = Vec::new();
    let mut skipped = Vec::new();
    let mut add = |source: &str, items: Vec<Value>| {
        let fresh: Vec<Value> = items
            .into_iter()
            .filter(|i| {
                let k = i["command"].as_str().unwrap_or("").to_lowercase();
                known.insert(k)
            })
            .collect();
        if !fresh.is_empty() {
            groups.push(json!({ "source": source, "items": fresh }));
        }
    };

    if let Some(Value::Object(scripts)) = read_json(&real_dir, "package.json", &mut skipped).and_then(|p| p.get("scripts").cloned()) {
        add("package.json", npm_items(&real_dir, &scripts));
    }
    if let Some(Value::Object(scripts)) = read_json(&real_dir, "composer.json", &mut skipped).and_then(|p| p.get("scripts").cloned()) {
        add("composer.json", composer_items(&scripts));
    }
    if safe_file(&real_dir, "artisan", Some(&mut skipped)).is_some() {
        add(
            "Laravel (artisan)",
            vec![
                item("Laravel Dev Server".into(), "php artisan serve".into(), String::new(), "server", json!("laravel"), true),
                item("Queue Worker".into(), "php artisan queue:work".into(), String::new(), "worker", json!("laravel"), true),
                item("Scheduler".into(), "php artisan schedule:work".into(), String::new(), "worker", json!("laravel"), false),
            ],
        );
    }
    if safe_file(&real_dir, "manage.py", Some(&mut skipped)).is_some() {
        add(
            "Django (manage.py)",
            vec![item("Django Dev Server".into(), "python manage.py runserver".into(), String::new(), "server", json!("python"), true)],
        );
    }
    if let Some(procfile) = read_text(&real_dir, "Procfile", &mut skipped) {
        let items = procfile
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .take(100)
            .filter_map(|l| PROCFILE_LINE.captures(l))
            .map(|m| {
                let cmd = m[2].trim().to_string();
                let icon = icon_for(&cmd, "");
                item(title_case(&m[1]), cmd, String::new(), if &m[1] == "web" { "server" } else { "worker" }, icon, true)
            })
            .collect();
        add("Procfile", items);
    }
    Ok(FolderScan { dir: real_dir, groups, skipped })
}

const APP_MARKERS: [&str; 5] = ["package.json", "composer.json", "artisan", "manage.py", "Procfile"];
const NOT_APPS: [&str; 10] = ["node_modules", "vendor", "bower_components", "__pycache__", "venv", "dist", "build", "target", "bin", "obj"];

/// App folders one level down (backend + frontend). Real folders only, no links.
pub fn app_folders(real_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(real_dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && !NOT_APPS.iter().any(|x| x.eq_ignore_ascii_case(n)))
        .filter(|n| APP_MARKERS.iter().any(|m| real_dir.join(n).join(m).exists()))
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names.truncate(12);
    names
}

fn norm_wd(wd: &str) -> String {
    let s = wd.trim();
    let s = s.strip_prefix("./").or_else(|| s.strip_prefix(".\\")).unwrap_or(s);
    s.trim_end_matches(['/', '\\']).to_lowercase()
}

/// Short labels that still tell folders apart: "automart-3.0-admin-api" next to
/// "automart-3.0-admin-web" -> "admin-api" / "admin-web".
pub fn short_folder_labels(names: &[String]) -> HashMap<String, String> {
    // JS: n.split(/(?=[-_ .])/) - pieces start at each separator
    let words = |n: &str| -> Vec<String> {
        let mut out = vec![String::new()];
        for (i, c) in n.chars().enumerate() {
            if i > 0 && "-_ .".contains(c) {
                out.push(String::new());
            }
            out.last_mut().unwrap().push(c);
        }
        out
    };
    let ending = |n: &str, k: usize| -> String {
        let w = words(n);
        let joined: String = w[w.len().saturating_sub(k)..].concat();
        joined.strip_prefix(['-', '_', ' ', '.']).map(str::to_string).unwrap_or(joined)
    };
    let mut out = HashMap::new();
    for n in names {
        let total = words(n).len();
        for k in total.min(2)..=total {
            let label = ending(n, k);
            if k == total || !names.iter().any(|o| o != n && ending(o, k).to_lowercase() == label.to_lowercase()) {
                out.insert(n.clone(), label);
                break;
            }
        }
    }
    out
}

/// The project folder and its apps; items carry the working directory they run in ("" = project folder).
pub fn scan_project_tree(dir: &str, existing: &[Command]) -> Value {
    let existing_in = |wd: &str| -> Vec<&Command> {
        existing.iter().filter(|c| norm_wd(c.working_directory.as_deref().unwrap_or("")) == wd.to_lowercase()).collect()
    };
    let top = match scan_project_folder(dir, &existing_in("")) {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let mut groups: Vec<Value> = top
        .groups
        .into_iter()
        .map(|mut g| {
            for i in g["items"].as_array_mut().unwrap() {
                i["workingDirectory"] = json!("");
            }
            json!({ "source": g["source"], "items": g["items"], "folder": "" })
        })
        .collect();
    let mut skipped = top.skipped;
    for app in app_folders(&top.dir) {
        let Ok(res) = scan_project_folder(&top.dir.join(&app).to_string_lossy(), &existing_in(&app)) else { continue };
        if !within(&res.dir, &top.dir) {
            continue;
        }
        for mut g in res.groups {
            for i in g["items"].as_array_mut().unwrap() {
                i["workingDirectory"] = json!(app);
            }
            groups.push(json!({ "source": format!("{app}/{}", g["source"].as_str().unwrap()), "folder": app, "items": g["items"] }));
        }
        for mut s in res.skipped {
            s["file"] = json!(format!("{app}/{}", s["file"].as_str().unwrap()));
            skipped.push(s);
        }
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for g in &groups {
        for i in g["items"].as_array().unwrap() {
            *counts.entry(i["name"].as_str().unwrap().to_string()).or_default() += 1;
        }
    }
    let mut folders: Vec<String> = Vec::new();
    for g in &groups {
        let f = g["folder"].as_str().unwrap().to_string();
        if !f.is_empty() && !folders.contains(&f) {
            folders.push(f);
        }
    }
    let labels = short_folder_labels(&folders);
    for g in &mut groups {
        for i in g["items"].as_array_mut().unwrap() {
            let name = i["name"].as_str().unwrap().to_string();
            let wd = i["workingDirectory"].as_str().unwrap().to_string();
            if counts[&name] > 1 && !wd.is_empty() {
                i["name"] = json!(format!("{name} ({})", labels.get(&wd).unwrap_or(&wd)));
            }
        }
    }
    json!({ "ok": true, "dir": top.dir.to_string_lossy(), "groups": groups, "skipped": skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_case_like_js() {
        assert_eq!(title_case("build:prod"), "Build Prod");
        assert_eq!(title_case("e2e"), "E2e");
        assert_eq!(title_case("start__dev--x"), "Start Dev X");
        assert_eq!(title_case("dev2x"), "Dev2x");
    }

    #[test]
    fn server_bodies() {
        assert!(server_body("vite"));
        assert!(server_body("vite --port 3000"));
        assert!(!server_body("vite build"));
        assert!(!server_body("tsc && vite build --mode x"));
        assert!(server_body("nodemon index.js"));
        assert!(!server_body("vitest"));
    }

    #[test]
    fn labels() {
        let names = vec!["automart-3.0-admin-api".to_string(), "automart-3.0-admin-web".to_string(), "frontend".to_string()];
        let l = short_folder_labels(&names);
        assert_eq!(l["automart-3.0-admin-api"], "admin-api");
        assert_eq!(l["automart-3.0-admin-web"], "admin-web");
        assert_eq!(l["frontend"], "frontend");
    }
}

#[cfg(test)]
mod parity {
    use super::*;

    /// tests/fixtures/import-tree.expected.json is the output of scanProjectTree() from
    /// main/importer.js for the same folder and existing commands.
    #[test]
    fn matches_javascript_importer() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let existing: Vec<Command> = serde_json::from_value(json!([
            {"id": "a", "command": "npm run lint", "workingDirectory": ""},
            {"id": "b", "command": "yarn lint"}
        ]))
        .unwrap();
        let mut got = scan_project_tree(&root.join("import-tree").to_string_lossy(), &existing);
        got.as_object_mut().unwrap().remove("dir");
        let want: Value = serde_json::from_slice(&std::fs::read(root.join("import-tree.expected.json")).unwrap()).unwrap();
        assert_eq!(got, want); // arrays compared in order, object keys in any order
    }
}
