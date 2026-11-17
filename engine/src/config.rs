//! The config store: the only reader and writer of `projects.json` (audit P3, D9, F1).
//!
//! - Loaded once and kept in memory; every change is written straight away.
//! - Writes go to a temp file that is flushed and then renamed over the real one, so a crash or
//!   power cut leaves either the old file or the new one, never half of one.
//! - The previous file is kept as `projects.json.bak`.
//! - A file that can't be read is moved aside (`projects.json.unreadable-<ms>`) and never
//!   overwritten; the backup is loaded instead when it reads.
//! - The file carries `version`. Older versions are migrated on load. A newer version (written by
//!   a later StackConsole) is opened read-only so a downgrade can't destroy it.

use crate::model::{CONFIG_VERSION, Database};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "projects.json";

/// Something worth telling the user about after loading.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadNote {
    /// No config yet; an empty one was created.
    Created,
    /// The config couldn't be read. It was moved to `moved_to`; `restored_from_backup` says whether
    /// the backup was loaded instead of starting empty.
    Unreadable { moved_to: PathBuf, reason: String, restored_from_backup: bool },
    /// The config was missing but its backup was there and has been restored.
    RestoredFromBackup,
    /// Migrated from an older format.
    Migrated { from: u64 },
    /// Written by a newer StackConsole; opened read-only.
    NewerVersion { found: u64 },
}

#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    db: Database,
    read_only: bool,
    revision: u64,
}

#[derive(Debug)]
pub enum SaveError {
    ReadOnly,
    Io(io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::ReadOnly => write!(
                f,
                "The project list was saved by a newer StackConsole, so this version won't change it."
            ),
            SaveError::Io(e) => write!(f, "The project list could not be saved: {e}"),
        }
    }
}

impl std::error::Error for SaveError {}

impl From<io::Error> for SaveError {
    fn from(e: io::Error) -> Self {
        SaveError::Io(e)
    }
}

impl ConfigStore {
    /// Opens (or creates) `<dir>/projects.json`.
    pub fn open(dir: &Path) -> io::Result<(Self, Vec<LoadNote>)> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let bak = backup_path(&path);
        let mut notes = Vec::new();

        let mut db = match fs::read(&path) {
            Ok(bytes) => match parse(&bytes) {
                Ok(db) => db,
                Err(reason) => {
                    let moved_to = move_aside(&path)?;
                    let restored = fs::read(&bak).ok().and_then(|b| parse(&b).ok());
                    notes.push(LoadNote::Unreadable {
                        moved_to,
                        reason,
                        restored_from_backup: restored.is_some(),
                    });
                    restored.unwrap_or_else(empty)
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                match fs::read(&bak).ok().and_then(|b| parse(&b).ok()) {
                    Some(db) => {
                        notes.push(LoadNote::RestoredFromBackup);
                        db
                    }
                    None => {
                        notes.push(LoadNote::Created);
                        empty()
                    }
                }
            }
            Err(e) => return Err(e),
        };

        let mut read_only = false;
        // Created, restored or recovered: write it out so the main file exists and is valid again
        let mut needs_write = !notes.is_empty();
        if db.version > CONFIG_VERSION {
            read_only = true;
            needs_write = false;
            notes.push(LoadNote::NewerVersion { found: db.version });
        } else if db.version < CONFIG_VERSION {
            let from = db.version;
            migrate(&mut db);
            notes.push(LoadNote::Migrated { from });
            needs_write = true;
        }

        let store = ConfigStore { path, db, read_only, revision: 0 };
        if needs_write {
            store.write()?;
        }
        Ok((store, notes))
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Goes up by one with every saved change.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Changes the config and saves it. The change is undone in memory if the save fails.
    pub fn update<R>(&mut self, f: impl FnOnce(&mut Database) -> R) -> Result<R, SaveError> {
        if self.read_only {
            return Err(SaveError::ReadOnly);
        }
        let before = self.db.clone();
        let out = f(&mut self.db);
        self.db.version = CONFIG_VERSION;
        self.db.strip_runtime();
        if self.db == before {
            return Ok(out);
        }
        if let Err(e) = self.write() {
            self.db = before;
            return Err(e.into());
        }
        self.revision += 1;
        Ok(out)
    }

    fn write(&self) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(&self.db).map_err(io::Error::other)?;
        let tmp = self.path.with_file_name(format!("{FILE_NAME}.tmp"));
        {
            let mut f = File::create(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
        }
        // Keep the previous good file as the backup (itself replaced atomically)
        if let Ok(prev) = fs::read(&self.path)
            && parse(&prev).is_ok() {
                let bak = backup_path(&self.path);
                let bak_tmp = self.path.with_file_name(format!("{FILE_NAME}.bak.tmp"));
                fs::write(&bak_tmp, &prev)?;
                fs::rename(&bak_tmp, &bak)?;
            }
        fs::rename(&tmp, &self.path)?;
        sync_dir(&self.path);
        Ok(())
    }
}

fn empty() -> Database {
    Database { version: CONFIG_VERSION, ..Default::default() }
}

pub fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{FILE_NAME}.bak"))
}

fn parse(bytes: &[u8]) -> Result<Database, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "not valid text".to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        // An empty file is what an interrupted write leaves behind; don't treat it as "no projects".
        return Err("the file is empty".into());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("not a project list".into());
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

fn move_aside(path: &Path) -> io::Result<PathBuf> {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut target = path.with_file_name(format!("{FILE_NAME}.unreadable-{ms}"));
    let mut n = 1;
    while target.exists() {
        target = path.with_file_name(format!("{FILE_NAME}.unreadable-{ms}-{n}"));
        n += 1;
    }
    fs::rename(path, &target)?;
    Ok(target)
}

/// Version 0 (Electron) -> 1: runtime fields that old builds saved are dropped.
fn migrate(db: &mut Database) {
    db.strip_runtime();
    db.version = CONFIG_VERSION;
}

#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent()
        && let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Command, Project};
    use serde_json::json;

    fn project(id: &str) -> Project {
        Project { id: id.into(), name: id.into(), ..Default::default() }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn creates_versioned_file() {
        let dir = tempfile::tempdir().unwrap();
        let (store, notes) = ConfigStore::open(dir.path()).unwrap();
        assert_eq!(notes, vec![LoadNote::Created]);
        assert!(store.db().projects.is_empty());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(saved["version"], json!(CONFIG_VERSION));
    }

    #[test]
    fn writes_atomically_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = ConfigStore::open(dir.path()).unwrap();
        store.update(|db| db.projects.push(project("a"))).unwrap();
        store.update(|db| db.projects.push(project("b"))).unwrap();
        assert_eq!(store.revision(), 2);
        // No temp files left behind
        assert_eq!(files(dir.path()), vec!["projects.json", "projects.json.bak"]);
        let main: Database = serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        let bak: Database = serde_json::from_slice(&fs::read(dir.path().join("projects.json.bak")).unwrap()).unwrap();
        assert_eq!(main.projects.len(), 2);
        assert_eq!(bak.projects.len(), 1);
    }

    #[test]
    fn unchanged_update_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = ConfigStore::open(dir.path()).unwrap();
        store.update(|_| ()).unwrap();
        assert_eq!(store.revision(), 0);
    }

    #[test]
    fn corrupt_file_is_moved_aside_and_backup_loaded() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (mut store, _) = ConfigStore::open(dir.path()).unwrap();
            store.update(|db| db.projects.push(project("a"))).unwrap();
            store.update(|db| db.projects.push(project("b"))).unwrap();
        }
        // Simulate a write cut short
        let main = dir.path().join(FILE_NAME);
        fs::write(&main, b"{\"projects\": [{\"id\": \"a\"").unwrap();

        let (store, notes) = ConfigStore::open(dir.path()).unwrap();
        let LoadNote::Unreadable { moved_to, restored_from_backup, .. } = &notes[0] else { panic!("{notes:?}") };
        assert!(*restored_from_backup);
        assert_eq!(fs::read(moved_to).unwrap(), b"{\"projects\": [{\"id\": \"a\"");
        assert_eq!(store.db().projects.len(), 1, "backup holds the state one save earlier");
        // The restored data is written back as the main file
        let main_db: Database = serde_json::from_slice(&fs::read(&main).unwrap()).unwrap();
        assert_eq!(main_db.projects.len(), 1);
    }

    #[test]
    fn empty_file_counts_as_unreadable_not_as_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), b"").unwrap();
        let (store, notes) = ConfigStore::open(dir.path()).unwrap();
        assert!(matches!(notes[0], LoadNote::Unreadable { restored_from_backup: false, .. }));
        assert!(store.db().projects.is_empty());
        // The unreadable file is kept, and nothing was written over it
        let names = files(dir.path());
        assert!(names.iter().any(|n| n.starts_with("projects.json.unreadable-")), "{names:?}");
    }

    #[test]
    fn unreadable_without_backup_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join(FILE_NAME);
        fs::write(&main, b"not json at all").unwrap();
        let (mut store, notes) = ConfigStore::open(dir.path()).unwrap();
        let LoadNote::Unreadable { moved_to, .. } = &notes[0] else { panic!() };
        store.update(|db| db.projects.push(project("new"))).unwrap();
        assert_eq!(fs::read(moved_to).unwrap(), b"not json at all");
    }

    #[test]
    fn missing_file_restores_backup() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (mut store, _) = ConfigStore::open(dir.path()).unwrap();
            store.update(|db| db.projects.push(project("a"))).unwrap();
            store.update(|db| db.projects.push(project("b"))).unwrap();
        }
        fs::remove_file(dir.path().join(FILE_NAME)).unwrap();
        let (store, notes) = ConfigStore::open(dir.path()).unwrap();
        assert_eq!(notes, vec![LoadNote::RestoredFromBackup]);
        assert_eq!(store.db().projects.len(), 1);
        assert!(dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn electron_file_is_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let old = json!({
            "activeProject": "p", "activeCommandToEdit": "c", "secretsEncrypted": true,
            "projects": [{"id": "p", "name": "P", "branch": "main", "identity": {"color": "x"},
                "commands": [{"id": "c", "command": "npm run dev", "status": "running", "pid": 42, "logs": ["x"], "port": "3000"}]}]
        });
        fs::write(dir.path().join(FILE_NAME), serde_json::to_vec(&old).unwrap()).unwrap();
        let (store, notes) = ConfigStore::open(dir.path()).unwrap();
        assert_eq!(notes, vec![LoadNote::Migrated { from: 0 }]);
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(saved["version"], json!(1));
        assert!(saved.get("activeCommandToEdit").is_none());
        assert!(saved["projects"][0].get("branch").is_none());
        let cmd = &saved["projects"][0]["commands"][0];
        assert!(cmd.get("status").is_none() && cmd.get("pid").is_none() && cmd.get("logs").is_none());
        assert_eq!(cmd["port"], json!("3000"));
        // The original survives as the backup
        let bak: serde_json::Value = serde_json::from_slice(&fs::read(dir.path().join("projects.json.bak")).unwrap()).unwrap();
        assert_eq!(bak, old);
        assert_eq!(store.db().projects[0].commands[0].command, "npm run dev");
    }

    #[test]
    fn newer_version_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"{"version": 99, "projects": [{"id": "p", "commands": []}], "futureField": 1}"#;
        fs::write(dir.path().join(FILE_NAME), text).unwrap();
        let (mut store, notes) = ConfigStore::open(dir.path()).unwrap();
        assert_eq!(notes, vec![LoadNote::NewerVersion { found: 99 }]);
        assert!(store.read_only());
        assert!(matches!(store.update(|db| db.projects.clear()), Err(SaveError::ReadOnly)));
        assert_eq!(fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(), text);
        assert_eq!(store.db().projects.len(), 1);
    }

    #[test]
    fn failed_write_rolls_back_memory() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = ConfigStore::open(dir.path()).unwrap();
        // A directory where the temp file should go makes the write fail
        fs::create_dir(dir.path().join("projects.json.tmp")).unwrap();
        let res = store.update(|db| db.projects.push(Project { commands: vec![Command::default()], ..project("x") }));
        assert!(matches!(res, Err(SaveError::Io(_))));
        assert!(store.db().projects.is_empty());
    }
}
