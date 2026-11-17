//! Watching instead of polling (D4, D5). The old app stat-ed every folder and git HEAD every 5 s and
//! rescanned master folders every minute. Now the engine watches, non-recursively:
//! - the parent of every project and command folder (a folder created, deleted or renamed),
//! - every repo's git folder (HEAD changes on a branch switch),
//! - every master folder and the folders its scan listed (a new clone, a deleted repo).
//!
//! Events are debounced; then the folder signature is compared and `FoldersChanged` is sent only when
//! something visible changed. A slow fallback (once a minute) covers drives where events don't arrive.

use super::*;
use crate::paths::{command_folder, is_dir, key};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::collections::HashSet;

const DEBOUNCE: Duration = Duration::from_millis(250);
const FALLBACK: Duration = Duration::from_secs(60);

pub(crate) struct Watching {
    watcher: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
    /// A debounced check is scheduled.
    pending: bool,
    /// Master folders touched since the last check (root keys).
    dirty_roots: HashSet<String>,
}

impl Watching {
    pub(crate) fn new() -> Self {
        Watching { watcher: None, watched: HashSet::new(), pending: false, dirty_roots: HashSet::new() }
    }
}

impl Core {
    /// Creates the watcher and starts the fallback timer. Called once, on the engine task.
    pub(crate) fn start_watching(&mut self) {
        let tx = self.tx.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            let paths = ev.paths;
            let _ = tx.send(Msg::Call(Box::new(move |c: &mut Core| c.on_fs_event(paths))));
        });
        self.watch.watcher = watcher.ok();
        self.folder_signature = self.compute_signature();
        self.rewatch();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(FALLBACK).await;
                let sent = tx.send(Msg::Call(Box::new(|c: &mut Core| {
                    for r in crate::roots::root_paths(c.store.db()) {
                        c.rescan(&r, None);
                    }
                    c.check_folders();
                })));
                if sent.is_err() {
                    break;
                }
            }
        });
    }

    /// The folders that should be watched for the current config and scans.
    fn wanted_watches(&self) -> HashSet<PathBuf> {
        let mut out = HashSet::new();
        let add_folder = |f: &str, out: &mut HashSet<PathBuf>| {
            let p = PathBuf::from(f);
            if let Some(parent) = p.parent().filter(|pp| pp.is_dir()) {
                out.insert(parent.to_path_buf());
            }
            if p.is_dir()
                && let Some((git_dir, _)) = crate::git::find_git_dir(&p)
                    && git_dir.is_dir() {
                        out.insert(git_dir);
                    }
        };
        for p in &self.store.db().projects {
            if let Some(b) = p.base_dir() {
                add_folder(b, &mut out);
            }
            for c in &p.commands {
                if let Some(f) = command_folder(p, c) {
                    add_folder(&f, &mut out);
                }
            }
        }
        for r in crate::roots::root_paths(self.store.db()) {
            if is_dir(&r) {
                out.insert(PathBuf::from(&r));
            }
            if let Some(scan) = self.root_scans.get(&key(&r)) {
                for w in scan["watch"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if is_dir(w) {
                        out.insert(PathBuf::from(w));
                    }
                }
            }
        }
        out
    }

    /// Brings the watched set in line with the config (after a config change or a scan).
    pub(crate) fn rewatch(&mut self) {
        let wanted = self.wanted_watches();
        let Some(w) = self.watch.watcher.as_mut() else { return };
        for gone in self.watch.watched.difference(&wanted).cloned().collect::<Vec<_>>() {
            let _ = w.unwatch(&gone);
            self.watch.watched.remove(&gone);
        }
        for new in wanted.difference(&self.watch.watched.clone()).cloned().collect::<Vec<_>>() {
            if w.watch(&new, RecursiveMode::NonRecursive).is_ok() {
                self.watch.watched.insert(new);
            }
        }
    }

    fn on_fs_event(&mut self, paths: Vec<PathBuf>) {
        let roots = crate::roots::root_paths(self.store.db());
        for p in &paths {
            let pk = key(&p.to_string_lossy());
            for r in &roots {
                let rk = key(r);
                // Something directly in the master folder or in one of its first-level folders
                if crate::paths::contains(&rk, &pk) && pk[rk.len()..].matches(['/', '\\']).count() <= 2 {
                    self.watch.dirty_roots.insert(r.clone());
                }
            }
        }
        if self.watch.pending {
            return;
        }
        self.watch.pending = true;
        let tx = self.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(DEBOUNCE).await;
            let _ = tx.send(Msg::Call(Box::new(|c: &mut Core| {
                c.watch.pending = false;
                for r in std::mem::take(&mut c.watch.dirty_roots) {
                    c.rescan(&r, None);
                }
                c.check_folders();
            })));
        });
    }

    /// Existence of every project/command folder and the content of every git HEAD.
    pub(crate) fn compute_signature(&self) -> String {
        let mut sig = String::new();
        let mut heads = HashSet::new();
        for p in &self.store.db().projects {
            let folders = p.base_dir().map(str::to_string).into_iter().chain(p.commands.iter().filter_map(|c| command_folder(p, c)));
            for f in folders {
                let exists = is_dir(&f);
                sig.push_str(&format!("{f}={exists};"));
                if exists
                    && let Some(g) = crate::git::branch_info(Path::new(&f))
                        && heads.insert(g.head.clone()) {
                            sig.push_str(&format!("{}@{}{};", g.head.display(), g.branch, g.detached));
                        }
            }
        }
        sig
    }

    /// Sends `FoldersChanged` when a folder appeared or went, or a branch changed.
    pub(crate) fn check_folders(&mut self) {
        let sig = self.compute_signature();
        if sig != self.folder_signature {
            self.folder_signature = sig;
            self.emit(Event::FoldersChanged {});
            self.rewatch();
        }
    }
}
