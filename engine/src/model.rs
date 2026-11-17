//! The saved configuration (`projects.json`).
//!
//! Only the fields the engine needs are typed. Everything else (icons, colours, pins, roots ...) is
//! kept in `extra` and written back unchanged, so a field the engine doesn't know is never lost.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// Current config format. 0 = files written by the Electron app (no `version` field).
pub const CONFIG_VERSION: u64 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    #[serde(default)]
    pub version: u64,
    #[serde(default, deserialize_with = "lenient_string")]
    pub active_project: String,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub projects: Vec<Project>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_directory: Option<String>,
    #[serde(default, deserialize_with = "lenient_vec")]
    pub commands: Vec<Command>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub display_name: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One entry of a command's environment. Secret values are stored encrypted (`enc`) when the OS
/// offers encryption, else as plain `value` (the interface warns about that).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvEntry {
    pub key: String,
    pub value: Option<String>,
    pub secret: bool,
    pub enc: Option<String>,
}

/// Fields that only exist while the app runs. Old Electron builds sometimes saved them; they are
/// removed on load (migration 0 -> 1) and never written.
pub const RUNTIME_FIELDS: &[&str] = &[
    "status", "pid", "logs", "startedAt", "url", "detectedPort", "exitCode", "ready", "waitingFor",
    "blockedBy", "restartAttempt", "restartGaveUp", "envSummary", "folder", "folderMissing", "branch",
    "detached", "repoRoot",
];
pub const PROJECT_DERIVED_FIELDS: &[&str] =
    &["folderMissing", "branch", "detached", "repoRoot", "relinkTo", "identity"];
pub const DB_DERIVED_FIELDS: &[&str] = &["activeCommandToEdit", "secretsEncrypted", "workspace"];

impl Database {
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }
    pub fn project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
    }
    pub fn command(&self, project_id: &str, command_id: &str) -> Option<(&Project, &Command)> {
        let p = self.project(project_id)?;
        let c = p.commands.iter().find(|c| c.id == command_id)?;
        Some((p, c))
    }

    /// Removes everything that is derived or runtime-only.
    pub fn strip_runtime(&mut self) {
        for f in DB_DERIVED_FIELDS {
            self.extra.remove(*f);
        }
        for p in &mut self.projects {
            for f in PROJECT_DERIVED_FIELDS {
                p.extra.remove(*f);
            }
            for c in &mut p.commands {
                for f in RUNTIME_FIELDS {
                    c.extra.remove(*f);
                }
            }
        }
    }
}

impl Project {
    pub fn command(&self, id: &str) -> Option<&Command> {
        self.commands.iter().find(|c| c.id == id)
    }
    pub fn base_dir(&self) -> Option<&str> {
        self.base_directory.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
    pub fn flag(&self, name: &str) -> bool {
        matches!(self.extra.get(name), Some(Value::Bool(true)))
    }
}

impl Command {
    fn text(&self, name: &str) -> Option<String> {
        match self.extra.get(name)? {
            Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    }

    pub fn name(&self) -> &str {
        if self.display_name.is_empty() { &self.command } else { &self.display_name }
    }

    /// The port the user set (a string in the file today), if it's a valid number.
    pub fn port(&self) -> Option<u16> {
        self.text("port").and_then(|s| s.parse::<u16>().ok()).filter(|p| *p > 0)
    }

    pub fn startup_delay_secs(&self) -> f64 {
        self.text("startupDelay")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0)
    }

    pub fn restarts_on_crash(&self) -> bool {
        self.text("onCrash").as_deref() == Some("restart")
    }

    /// 1-10, default 3 (as `parseInt(cmd.restartLimit) || 3`, clamped).
    pub fn restart_limit(&self) -> u32 {
        let n = self
            .text("restartLimit")
            .and_then(|s| s.trim_start().split(|c: char| !c.is_ascii_digit()).next().map(str::to_string))
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(3);
        n.clamp(1, 10)
    }

    /// The command's own "ready" text, lowercased, or empty.
    pub fn ready_pattern(&self) -> String {
        self.text("readyPattern").unwrap_or_default().to_lowercase()
    }

    pub fn start_after(&self) -> Option<String> {
        self.text("startAfter")
    }

    pub fn env_file(&self) -> Option<String> {
        self.text("envFile")
    }

    /// Crash notifications are on unless turned off.
    pub fn notify(&self) -> bool {
        !matches!(self.extra.get("notify"), Some(Value::Bool(false)))
    }

    pub fn env(&self) -> Vec<EnvEntry> {
        let Some(Value::Array(items)) = self.extra.get("env") else { return Vec::new() };
        items
            .iter()
            .filter_map(|v| {
                let o = v.as_object()?;
                let key = o.get("key")?.as_str()?.to_string();
                if key.is_empty() {
                    return None;
                }
                Some(EnvEntry {
                    key,
                    value: match o.get("value") {
                        Some(Value::String(s)) => Some(s.clone()),
                        Some(Value::Number(n)) => Some(n.to_string()),
                        Some(Value::Bool(b)) => Some(b.to_string()),
                        _ => None,
                    },
                    secret: o.get("secret").and_then(Value::as_bool).unwrap_or(false),
                    enc: o.get("enc").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect()
    }
}

fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    })
}

/// A list where one malformed item (say, a project without an id) is skipped instead of making the
/// whole file unreadable.
fn lenient_vec<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(match Value::deserialize(d)? {
        Value::Array(items) => items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect(),
        _ => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_fields_round_trip() {
        let input = json!({
            "activeProject": "p1",
            "projectRoots": [{"path": "D:\\projects"}],
            "projects": [{
                "id": "p1", "name": "Shop", "baseDirectory": "D:\\projects\\shop", "pinned": true, "color": "teal",
                "commands": [{"id": "c1", "displayName": "API", "command": "php artisan serve", "port": "8000",
                    "icon": "php", "onCrash": "restart", "restartLimit": "5",
                    "env": [{"key": "A", "value": "1"}, {"key": "S", "secret": true, "enc": "abc"}]}]
            }]
        });
        let db: Database = serde_json::from_value(input.clone()).unwrap();
        let (_, c) = db.command("p1", "c1").unwrap();
        assert_eq!(c.port(), Some(8000));
        assert!(c.restarts_on_crash());
        assert_eq!(c.restart_limit(), 5);
        assert_eq!(c.env().len(), 2);
        assert!(c.env()[1].secret);
        let back = serde_json::to_value(&db).unwrap();
        let mut expected = input;
        expected["version"] = json!(0);
        assert_eq!(back, expected);
    }

    #[test]
    fn lenient_values() {
        let db: Database = serde_json::from_value(json!({
            "activeProject": null,
            "projects": [{"id": "p", "commands": [
                {"id": "a", "command": "x", "port": 3000, "startupDelay": "1.5", "restartLimit": 99},
                {"id": "b", "command": "y", "port": "abc", "restartLimit": "0"},
                {"command": "no id, skipped"}
            ]}, "not a project"]
        }))
        .unwrap();
        assert_eq!(db.projects.len(), 1);
        let cmds = &db.projects[0].commands;
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].port(), Some(3000));
        assert_eq!(cmds[0].startup_delay_secs(), 1.5);
        assert_eq!(cmds[0].restart_limit(), 10);
        assert_eq!(cmds[1].port(), None);
        assert_eq!(cmds[1].restart_limit(), 3);
    }
}
