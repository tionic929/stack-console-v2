//! Master folders (D:\projects): the folders repos are listed from, and where each project sits.
//! Discovery is read-only and looks at names only (never opens a manifest, so cloud placeholders
//! aren't downloaded), goes folder -> container -> repo -> app, skips dependency and system folders,
//! never follows links and stops after a time budget. Reference: `main/roots.js`.

use crate::model::Database;
use crate::paths::{basename, canon, command_folder, contains, dirname, is_dir, is_drive_root, key, natural_cmp, relative};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MARKERS: [&str; 5] = ["package.json", "composer.json", "artisan", "manage.py", "procfile"];
const SKIP: [&str; 17] = [
    "node_modules", "vendor", "bower_components", "__pycache__", "venv", "dist", "build", "target", "bin", "obj", "appdata",
    "windows", "program files", "program files (x86)", "programdata", "system volume information", "recovery",
];
const SKIP_MORE: [&str; 1] = ["perflogs"];
const SCAN_BUDGET: Duration = Duration::from_millis(4000);
const MAX_DIRS: usize = 4000;
const MAX_APPS: usize = 12;

struct Budget {
    start: Instant,
    count: usize,
    unreadable: usize,
    truncated: bool,
}

impl Budget {
    fn expired(&self) -> bool {
        self.start.elapsed() > SCAN_BUDGET || self.count > MAX_DIRS
    }
}

struct Listing {
    dirs: Vec<(String, String)>,
    files: HashSet<String>,
    git: Option<&'static str>,
}

fn list_dir(dir: &str, b: &mut Budget) -> Option<Listing> {
    if b.expired() {
        b.truncated = true;
        return None;
    }
    b.count += 1;
    let Ok(entries) = std::fs::read_dir(dir) else {
        b.unreadable += 1;
        return None;
    };
    let mut l = Listing { dirs: Vec::new(), files: HashSet::new(), git: None };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if name == ".git" {
            l.git = Some(if ft.is_dir() { "dir" } else { "file" });
            continue;
        }
        if ft.is_symlink() {
            continue; // never follow links or junctions
        }
        if ft.is_dir() {
            let lower = name.to_lowercase();
            if name.starts_with('.') || name.starts_with('$') || SKIP.contains(&lower.as_str()) || SKIP_MORE.contains(&lower.as_str()) {
                continue;
            }
            let path = Path::new(dir).join(&name).to_string_lossy().into_owned();
            l.dirs.push((name, path));
        } else if ft.is_file() {
            l.files.insert(name.to_lowercase());
        }
    }
    Some(l)
}

fn markers_of(l: &Listing) -> Vec<&'static str> {
    MARKERS.iter().copied().filter(|m| l.files.contains(*m)).collect()
}

fn is_repo(l: &Listing) -> bool {
    l.git.is_some() || !markers_of(l).is_empty()
}

fn describe_repo(dir: &str, l: &Listing, b: &mut Budget) -> Value {
    let mut apps = Vec::new();
    for (name, path) in &l.dirs {
        if apps.len() >= MAX_APPS {
            break;
        }
        if let Some(sub) = list_dir(path, b)
            && !markers_of(&sub).is_empty() {
                apps.push(name.clone());
            }
    }
    let markers = markers_of(l);
    json!({
        "kind": "repo", "name": basename(dir), "path": dir,
        "git": l.git.is_some(), "worktree": l.git == Some("file"),
        "runnable": !markers.is_empty() || !apps.is_empty(),
        "markers": markers, "apps": apps,
    })
}

fn by_name(a: &Value, b: &Value) -> std::cmp::Ordering {
    natural_cmp(a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""))
}

/// One master folder: `{ path, exists, items: [repo | folder{repos}], other, truncated, unreadable, watch }`.
pub fn scan_root(root: &str) -> Value {
    let mut b = Budget { start: Instant::now(), count: 0, unreadable: 0, truncated: false };
    let scanned_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut watch = vec![root.to_string()];
    let Some(top) = list_dir(root, &mut b) else {
        return json!({ "path": root, "exists": is_dir(root), "items": [], "other": 0, "truncated": false, "unreadable": 0, "watch": watch, "scannedAt": scanned_at });
    };
    let mut items = Vec::new();
    let mut other = 0;
    for (name, path) in &top.dirs {
        let Some(listing) = list_dir(path, &mut b) else { continue };
        watch.push(path.clone());
        if is_repo(&listing) {
            items.push(describe_repo(path, &listing, &mut b));
            continue;
        }
        let mut repos = Vec::new();
        let mut others = 0;
        for (_, cpath) in &listing.dirs {
            match list_dir(cpath, &mut b) {
                Some(sub) if is_repo(&sub) => repos.push(describe_repo(cpath, &sub, &mut b)),
                _ => others += 1,
            }
        }
        if repos.is_empty() {
            other += 1;
        } else {
            repos.sort_by(by_name);
            items.push(json!({ "kind": "folder", "name": name, "path": path, "repos": repos, "others": others }));
        }
    }
    items.sort_by(by_name);
    json!({ "path": root, "exists": true, "items": items, "other": other, "truncated": b.truncated,
            "unreadable": b.unreadable, "watch": watch, "scannedAt": scanned_at })
}

/// The scan's shape, to tell whether a rescan changed anything.
pub fn shape(scan: &Value) -> String {
    json!([scan["exists"], scan["items"], scan["other"], scan["truncated"], scan["timedOut"], scan["unreadable"]]).to_string()
}

/// Folders a project already covers: its folder and each command's folder (exact matches only).
pub fn covered_keys(db: &Database) -> HashSet<String> {
    let mut covered = HashSet::new();
    for p in &db.projects {
        if let Some(b) = p.base_dir() {
            covered.insert(key(b));
        }
        for c in &p.commands {
            if let Some(f) = command_folder(p, c) {
                covered.insert(key(&f));
            }
        }
    }
    covered
}

pub fn root_paths(db: &Database) -> Vec<String> {
    db.extra
        .get("projectRoots")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| r.get("path").and_then(Value::as_str)).filter(|p| !p.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn root_index_for(folder_key: &str, root_keys: &[String]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, rk) in root_keys.iter().enumerate() {
        if contains(rk, folder_key) && best.is_none_or(|b| rk.len() > root_keys[b].len()) {
            best = Some(i);
        }
    }
    best
}

/// What a scan knows for the sidebar: `scans` by root key, `scanning` = root keys being rescanned.
pub struct ScanView<'a> {
    pub scans: &'a HashMap<String, Value>,
    pub scanning: &'a HashSet<String>,
}

/// Per project its section (pinned / root / other / empty / archived) and container; per master
/// folder the repos not set up yet. Derived on each read, never saved.
pub fn build_workspace(db: &Database, view: Option<&ScanView>) -> Value {
    let roots = root_paths(db);
    let root_canon: Vec<String> = roots.iter().map(|r| canon(r)).collect();
    let root_keys: Vec<String> = root_canon.iter().map(|c| c.to_lowercase()).collect();
    let covered = covered_keys(db);
    let hidden: HashSet<String> = db
        .extra
        .get("hiddenRepos")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(key).collect())
        .unwrap_or_default();

    let mut by_folder: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in db.projects.iter().enumerate() {
        if let Some(b) = p.base_dir() {
            by_folder.entry(key(b)).or_default().push(i);
        }
    }

    let mut placement = serde_json::Map::new();
    for p in &db.projects {
        let mut place = json!({ "section": "empty", "root": null, "container": null, "hint": null });
        if p.flag("archived") {
            place["section"] = json!("archived");
            placement.insert(p.id.clone(), place);
            continue;
        }
        let base = p.base_dir();
        let k = base.map(key).unwrap_or_default();
        if !k.is_empty()
            && let Some(twin) = by_folder.get(&k).into_iter().flatten().map(|&i| &db.projects[i]).find(|o| o.id != p.id && !o.flag("archived")) {
                place["hint"] = json!("shares its folder");
                place["twin"] = json!(twin.name);
            }
        let idx = if k.is_empty() { None } else { root_index_for(&k, &root_keys) };
        if let (Some(i), Some(b)) = (idx, base) {
            let rel = relative(&root_canon[i], &canon(b));
            let segs: Vec<&str> = if rel.is_empty() { Vec::new() } else { rel.split(['/', '\\']).collect() };
            place["root"] = json!(roots[i]);
            if segs.len() >= 2 {
                place["container"] = json!({ "name": segs[0], "path": Path::new(&roots[i]).join(segs[0]).to_string_lossy() });
            }
            if segs.len() >= 3 && place["hint"].is_null() {
                place["hint"] = json!(segs[1..].join("/"));
            }
        }
        let section = if base.is_none() || p.commands.is_empty() {
            "empty"
        } else if p.flag("pinned") {
            "pinned"
        } else if idx.is_some() {
            "root"
        } else {
            "other"
        };
        place["section"] = json!(section);
        if section == "other" && !roots.is_empty() && place["hint"].is_null() {
            place["hint"] = json!(dirname(&canon(base.unwrap())));
        }
        if section == "pinned" && place["hint"].is_null() {
            place["hint"] = match idx {
                Some(i) => {
                    let r = relative(&roots[i], &dirname(base.unwrap()));
                    json!(if r.is_empty() { roots[i].clone() } else { r })
                }
                None => Value::Null,
            };
        }
        placement.insert(p.id.clone(), place);
    }

    let roots_out: Vec<Value> = roots
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let scan = view.and_then(|v| v.scans.get(&root_keys[i]));
            let mark = |repo: &Value| {
                let mut r = repo.clone();
                r["hidden"] = json!(hidden.contains(&key(repo["path"].as_str().unwrap_or(""))));
                r
            };
            let mut items = Vec::new();
            for it in scan.and_then(|s| s["items"].as_array()).into_iter().flatten() {
                let path = it["path"].as_str().unwrap_or("");
                if it["kind"] == "repo" {
                    if !covered.contains(&key(path)) {
                        items.push(mark(it));
                    }
                } else {
                    let all = it["repos"].as_array().cloned().unwrap_or_default();
                    let open: Vec<Value> =
                        all.iter().filter(|rp| !covered.contains(&key(rp["path"].as_str().unwrap_or("")))).map(mark).collect();
                    if !open.is_empty() {
                        let mut f = it.clone();
                        f["setUp"] = json!(all.len() - open.len());
                        f["repos"] = json!(open);
                        f["hidden"] = json!(hidden.contains(&key(path)));
                        items.push(f);
                    }
                }
            }
            let exists = scan.map(|s| s["exists"].as_bool().unwrap_or(false)).unwrap_or_else(|| is_dir(r));
            let scanning = view.is_some_and(|v| scan.is_none() || v.scanning.contains(&root_keys[i]));
            let name = basename(r);
            json!({
                "path": r, "name": if name.is_empty() { r.clone() } else { name }, "exists": exists, "scanning": scanning,
                "truncated": scan.is_some_and(|s| s["truncated"] == true), "timedOut": scan.is_some_and(|s| s["timedOut"] == true),
                "unreadable": scan.map(|s| s["unreadable"].clone()).unwrap_or(json!(0)),
                "other": scan.map(|s| s["other"].clone()).unwrap_or(json!(0)), "items": items,
            })
        })
        .collect();

    json!({ "enabled": !roots.is_empty(), "roots": roots_out, "placement": placement })
}

/// First run: the folder holding most of the user's projects (never a drive root, never a repo).
pub fn suggest_root(db: &Database) -> Option<String> {
    let mut folders: Vec<String> = Vec::new();
    for b in db.projects.iter().filter_map(|p| p.base_dir()).filter(|b| is_dir(b)) {
        let c = canon(b);
        if !folders.iter().any(|f| f.to_lowercase() == c.to_lowercase()) {
            folders.push(c);
        }
    }
    if folders.is_empty() {
        return None;
    }
    let looks_like_repo = |dir: &str| [".git", "package.json", "composer.json", "artisan", "manage.py", "procfile"].iter().any(|f| Path::new(dir).join(f).exists());
    let mut candidates: Vec<String> = Vec::new();
    for f in &folders {
        let mut dir = f.clone();
        while !dir.is_empty() && !is_drive_root(&dir) {
            if !candidates.contains(&dir) {
                candidates.push(dir.clone());
            }
            let up = dirname(&dir);
            if up == dir {
                break;
            }
            dir = up;
        }
    }
    candidates.retain(|d| !looks_like_repo(d));
    let mut best: Option<(String, usize)> = None;
    for dir in candidates {
        let k = dir.to_lowercase();
        let n = folders.iter().filter(|f| contains(&k, &f.to_lowercase())).count();
        if best.as_ref().is_none_or(|(bd, bn)| n > *bn || (n == *bn && dir.len() > bd.len())) {
            best = Some((dir, n));
        }
    }
    best.map(|(d, _)| d)
}

pub enum Overlap {
    Ok,
    Error(String),
    /// The candidate holds master folders already in the list.
    Contains(Vec<String>),
}

pub fn check_overlap(candidate: &str, existing: &[String]) -> Overlap {
    let k = key(candidate);
    for p in existing {
        let ek = key(p);
        if ek == k {
            return Overlap::Error(format!("{p} is already in the list."));
        }
        if contains(&ek, &k) {
            return Overlap::Error(format!("It's already inside {p}."));
        }
    }
    let inside: Vec<String> = existing.iter().filter(|p| contains(&k, &key(p))).cloned().collect();
    if inside.is_empty() { Overlap::Ok } else { Overlap::Contains(inside) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Command, Project};

    #[test]
    fn scan_finds_repos_containers_and_apps() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let mk = |p: &str| std::fs::create_dir_all(r.join(p)).unwrap();
        let touch = |p: &str| std::fs::write(r.join(p), "").unwrap();
        mk("shop/.git");
        mk("shop/frontend");
        touch("shop/frontend/package.json");
        mk("automart/api");
        touch("automart/api/composer.json");
        mk("automart/web/.git");
        mk("automart/notes");
        mk("node_modules/x");
        mk("photos/2024");
        #[cfg(unix)]
        std::os::unix::fs::symlink(r.join("shop"), r.join("link-to-shop")).ok();
        let scan = scan_root(&r.to_string_lossy());
        assert_eq!(scan["exists"], true);
        let items = scan["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{scan:#}");
        assert_eq!(items[0]["kind"], "folder");
        assert_eq!(items[0]["name"], "automart");
        assert_eq!(items[0]["repos"].as_array().unwrap().len(), 2);
        assert_eq!(items[0]["others"], 1);
        assert_eq!(items[1]["name"], "shop");
        assert_eq!(items[1]["apps"], json!(["frontend"]));
        assert_eq!(items[1]["runnable"], true);
        assert_eq!(scan["other"], 1, "photos");
    }

    #[test]
    fn workspace_places_projects_and_hides_covered_repos() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("automart/api/.git")).unwrap();
        std::fs::create_dir_all(r.join("automart/web/.git")).unwrap();
        std::fs::create_dir_all(r.join("blog/.git")).unwrap();
        let root = r.to_string_lossy().into_owned();
        let mut db = Database::default();
        db.extra.insert("projectRoots".into(), json!([{ "path": root }]));
        let cmd = Command { id: "c".into(), command: "x".into(), ..Default::default() };
        db.projects.push(Project {
            id: "api".into(),
            name: "API".into(),
            base_directory: Some(r.join("automart/api").to_string_lossy().into()),
            commands: vec![cmd.clone()],
            ..Default::default()
        });
        db.projects.push(Project { id: "none".into(), name: "None".into(), ..Default::default() });
        let scans = HashMap::from([(key(&root), scan_root(&root))]);
        let scanning = HashSet::new();
        let ws = build_workspace(&db, Some(&ScanView { scans: &scans, scanning: &scanning }));
        assert_eq!(ws["placement"]["api"]["section"], "root");
        assert_eq!(ws["placement"]["api"]["container"]["name"], "automart");
        assert_eq!(ws["placement"]["none"]["section"], "empty");
        let items = ws["roots"][0]["items"].as_array().unwrap();
        let automart = items.iter().find(|i| i["name"] == "automart").unwrap();
        assert_eq!(automart["setUp"], 1);
        assert_eq!(automart["repos"].as_array().unwrap().len(), 1);
        assert!(items.iter().any(|i| i["name"] == "blog"));
    }

    #[test]
    fn overlap_rules() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        std::fs::create_dir_all(a.join("b")).unwrap();
        let a_s = a.to_string_lossy().into_owned();
        let b_s = a.join("b").to_string_lossy().into_owned();
        assert!(matches!(check_overlap(&b_s, std::slice::from_ref(&a_s)), Overlap::Error(e) if e.contains("already inside")));
        assert!(matches!(check_overlap(&a_s, std::slice::from_ref(&b_s)), Overlap::Contains(v) if v == vec![b_s.clone()]));
        assert!(matches!(check_overlap(&a_s, std::slice::from_ref(&a_s)), Overlap::Error(_)));
    }
}
