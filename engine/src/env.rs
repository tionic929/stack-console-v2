//! Environment for a command: its `.env` file plus its own key/value pairs (reference: `main/env.js`).
//! Secrets are decrypted only here, at spawn time, and their values are returned so the log can
//! mask them (X2).

use crate::model::{Command, EnvEntry};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct EnvSummary {
    pub count: usize,
    pub file: Option<String>,
    pub secrets: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
pub struct CommandEnv {
    pub vars: BTreeMap<String, String>,
    pub summary: EnvSummary,
    /// Plain values of the secrets that were set, for masking output.
    pub secret_values: Vec<String>,
}

/// `KEY=value`, `export KEY=value`, quotes, `#` comments, `\n` inside double quotes.
pub fn parse_dotenv(text: &str) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = match line.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
            _ => line,
        };
        let key_len = line
            .char_indices()
            .take_while(|(i, c)| {
                if *i == 0 { c.is_ascii_alphabetic() || *c == '_' } else { c.is_ascii_alphanumeric() || "_.-".contains(*c) }
            })
            .count();
        if key_len == 0 {
            continue;
        }
        let (key, rest) = line.split_at(key_len);
        let Some(value) = rest.trim_start().strip_prefix('=') else { continue };
        let value = value.trim_start();
        let value = if let Some(body) = value.strip_prefix('"') {
            match closing_double_quote(body) {
                Some(end) => body[..end].replace("\\n", "\n").replace("\\\"", "\""),
                None => value.to_string(),
            }
        } else if let Some(body) = value.strip_prefix('\'') {
            match body.find('\'') {
                Some(end) => body[..end].to_string(),
                None => value.to_string(),
            }
        } else {
            strip_inline_comment(value).trim().to_string()
        };
        vars.insert(key.to_string(), value);
    }
    vars
}

fn closing_double_quote(body: &str) -> Option<usize> {
    let mut escaped = false;
    for (i, c) in body.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some(i);
        }
    }
    None
}

/// `value # comment` -> `value` (a `#` with whitespace before it starts a comment).
fn strip_inline_comment(v: &str) -> &str {
    let bytes = v.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return &v[..i];
        }
    }
    v
}

/// Is `child` inside `root`, after following links on both (X10)? Both must exist.
pub fn within_real(child: &Path, root: &Path) -> bool {
    match (dunce_canonical(child), dunce_canonical(root)) {
        (Some(c), Some(r)) => c.starts_with(&r),
        _ => false,
    }
}

fn dunce_canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Builds the env for a spawn. `decrypt` turns a stored secret into its value (None = can't).
pub fn build_command_env(
    cmd: &Command,
    working_dir: &Path,
    project_dir: Option<&Path>,
    decrypt: &dyn Fn(&EnvEntry) -> Option<String>,
) -> CommandEnv {
    let mut out = CommandEnv::default();

    if let Some(env_file) = cmd.env_file() {
        let file = working_dir.join(&env_file);
        let roots: Vec<&Path> = std::iter::once(working_dir).chain(project_dir).collect();
        if !file.is_file() {
            out.summary.warnings.push(format!(".env file not found: {}", file.display()));
        } else if !roots.iter().any(|r| within_real(&file, r)) {
            out.summary.warnings.push(format!(".env file ignored: {env_file} is outside the project folder"));
        } else {
            match std::fs::read(&file) {
                Ok(bytes) => {
                    out.vars.extend(parse_dotenv(&String::from_utf8_lossy(&bytes)));
                    out.summary.file = Some(env_file);
                }
                Err(e) => out.summary.warnings.push(format!(".env file could not be read: {e}")),
            }
        }
    }

    for entry in cmd.env() {
        if entry.secret {
            match decrypt(&entry) {
                Some(value) => {
                    if !value.is_empty() {
                        out.secret_values.push(value.clone());
                    }
                    out.vars.insert(entry.key.clone(), value);
                    out.summary.secrets += 1;
                }
                None => out
                    .summary
                    .warnings
                    .push(format!("Secret {} could not be decrypted and was skipped", entry.key)),
            }
        } else {
            out.vars.insert(entry.key.clone(), entry.value.clone().unwrap_or_default());
        }
    }

    out.summary.count = out.vars.len();
    out
}

/// "3 variables, from .env, 1 secret hidden"
pub fn describe_env(s: &EnvSummary) -> String {
    if s.count == 0 {
        return String::new();
    }
    let mut parts = vec![format!("{} variable{}", s.count, if s.count == 1 { "" } else { "s" })];
    if let Some(f) = &s.file {
        parts.push(format!("from {f}"));
    }
    if s.secrets > 0 {
        parts.push(format!("{} secret{} hidden", s.secrets, if s.secrets == 1 { "" } else { "s" }));
    }
    parts.join(", ")
}

/// Replaces each secret value in `text` with a fixed mask. Values shorter than 4 characters are
/// left alone: masking "1" or "on" would garble ordinary output and hide nothing.
pub fn mask_secrets(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.chars().count() >= 4 && out.contains(s.as_str()) {
            out = out.replace(s.as_str(), MASK);
        }
    }
    out
}

pub const MASK: &str = "••••••";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cmd(extra: serde_json::Value) -> Command {
        serde_json::from_value(json!({"id": "c", "command": "x"}).as_object().unwrap().clone().into_iter().chain(extra.as_object().unwrap().clone()).collect::<serde_json::Map<_, _>>().into()).unwrap()
    }

    #[test]
    fn dotenv_parsing_matches_electron() {
        let vars = parse_dotenv(
            "# comment\nA=1\nexport B = two \nC=\"line\\nnext \\\"q\\\"\" # c\nD='single # kept'\nE=value # comment\nF=a#b\n9BAD=x\nexported=y\nG=\"unclosed\n",
        );
        assert_eq!(vars["A"], "1");
        assert_eq!(vars["B"], "two");
        assert_eq!(vars["C"], "line\nnext \"q\"");
        assert_eq!(vars["D"], "single # kept");
        assert_eq!(vars["E"], "value");
        assert_eq!(vars["F"], "a#b");
        assert_eq!(vars["exported"], "y");
        assert_eq!(vars["G"], "\"unclosed");
        assert!(!vars.contains_key("9BAD"));
    }

    #[test]
    fn env_file_inside_project_is_loaded_and_secrets_counted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "APP_KEY=base64:abc\nPORT=8000\n").unwrap();
        let c = cmd(json!({"envFile": ".env", "env": [
            {"key": "PORT", "value": "9000"},
            {"key": "TOKEN", "secret": true, "enc": "sealed"},
            {"key": "BROKEN", "secret": true, "enc": "bad"}
        ]}));
        let decrypt = |e: &EnvEntry| (e.enc.as_deref() == Some("sealed")).then(|| "s3cr3t-value".to_string());
        let env = build_command_env(&c, dir.path(), Some(dir.path()), &decrypt);
        assert_eq!(env.vars["PORT"], "9000", "explicit values win over the file");
        assert_eq!(env.vars["APP_KEY"], "base64:abc");
        assert_eq!(env.vars["TOKEN"], "s3cr3t-value");
        assert_eq!(env.secret_values, vec!["s3cr3t-value"]);
        assert_eq!(env.summary.secrets, 1);
        assert_eq!(env.summary.warnings, vec!["Secret BROKEN could not be decrypted and was skipped"]);
        assert_eq!(describe_env(&env.summary), "3 variables, from .env, 1 secret hidden");
    }

    #[cfg(unix)]
    #[test]
    fn env_file_link_pointing_outside_is_refused() {
        // X10: a link inside the project that points at a file outside it
        let outside = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secrets.env"), "AWS_KEY=stolen\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secrets.env"), project.path().join(".env")).unwrap();
        let c = cmd(json!({"envFile": ".env"}));
        let env = build_command_env(&c, project.path(), Some(project.path()), &|_| None);
        assert!(env.vars.is_empty());
        assert_eq!(env.summary.warnings, vec![".env file ignored: .env is outside the project folder"]);
        // and an absolute path elsewhere
        let c = cmd(json!({"envFile": outside.path().join("secrets.env").to_string_lossy()}));
        let env = build_command_env(&c, project.path(), Some(project.path()), &|_| None);
        assert!(env.vars.is_empty());
    }

    #[test]
    fn masking() {
        let secrets = vec!["s3cr3t-value".to_string(), "on".to_string()];
        assert_eq!(mask_secrets("token=s3cr3t-value; mode on", &secrets), "token=••••••; mode on");
    }
}
