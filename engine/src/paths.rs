//! Folder helpers shared by the handlers (reference: `main/folders.js`, the path half of `main/roots.js`).

use crate::model::{Command, Project};
use std::cmp::Ordering;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};

pub fn is_dir(p: impl AsRef<Path>) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

/// Real path (links resolved), without trailing separators; a drive root keeps its slash.
pub fn canon(p: &str) -> String {
    let real = std::fs::canonicalize(p)
        .map(|r| strip_verbatim(&r))
        .unwrap_or_else(|_| absolute(p));
    let mut s = real.trim_end_matches(is_sep).to_string();
    // The filesystem root, or a drive root (C:), keeps its separator
    if s.is_empty() || (s.len() == 2 && s.ends_with(':')) {
        s.push(MAIN_SEPARATOR);
    }
    s
}

/// `\\?\C:\x` (what canonicalize gives on Windows) -> `C:\x`
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| s.into_owned())
}

fn absolute(p: &str) -> String {
    let path = Path::new(p);
    if path.is_absolute() {
        return p.to_string();
    }
    std::env::current_dir().map(|d| d.join(path).to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

/// Comparison key: real path, lowercased (Windows paths are case-insensitive; matches the old app).
pub fn key(p: &str) -> String {
    if p.is_empty() { String::new() } else { canon(p).to_lowercase() }
}

/// Is `child_key` the same folder as, or inside, `parent_key`? On a separator boundary only.
pub fn contains(parent_key: &str, child_key: &str) -> bool {
    if parent_key.is_empty() || child_key.is_empty() {
        return false;
    }
    if parent_key == child_key {
        return true;
    }
    match child_key.strip_prefix(parent_key) {
        Some(rest) => parent_key.ends_with(is_sep) || rest.starts_with(is_sep),
        None => false,
    }
}

/// `child` inside `root`, by path components (no links resolved).
pub fn within(child: &Path, root: &Path) -> bool {
    normalize(child).starts_with(normalize(root))
}

/// Removes `.` and `..` without touching the disk.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The folder a command runs in: its working directory, relative to the project folder or absolute.
pub fn command_folder(project: &Project, cmd: &Command) -> Option<String> {
    let base = project.base_dir();
    let wd = cmd.working_directory.as_deref().map(str::trim).unwrap_or("");
    if wd.is_empty() {
        return base.map(str::to_string);
    }
    if Path::new(wd).is_absolute() {
        return Some(wd.to_string());
    }
    base.map(|b| Path::new(b).join(wd).to_string_lossy().into_owned())
}

/// `p` moved from `old` to `new` when it is `old` or inside it, on a separator boundary (P10:
/// `C:\proj\app` must not rewrite `C:\proj\app2`). Case-insensitive, like Windows.
pub fn rebase(p: &str, old: &str, new: &str) -> Option<String> {
    let old_t = old.trim_end_matches(is_sep);
    let new_t = new.trim_end_matches(is_sep);
    if p.len() < old_t.len() || !p.is_char_boundary(old_t.len()) {
        return None;
    }
    let (head, rest) = p.split_at(old_t.len());
    if !head.eq_ignore_ascii_case(old_t) && head.to_lowercase() != old_t.to_lowercase() {
        return None;
    }
    if rest.is_empty() || rest.starts_with(is_sep) {
        Some(format!("{new_t}{rest}"))
    } else {
        None
    }
}

/// Where did a missing folder go? 1) the same path on another drive (C:\projects -> D:\projects),
/// 2) a folder with the same name next to the user's other project folders.
pub fn relink_candidate(missing: &str, known_folders: &[String]) -> Option<String> {
    if missing.is_empty() {
        return None;
    }
    let b = missing.as_bytes();
    if b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        let rest = &missing[3..];
        for letter in 'C'..='Z' {
            if letter.eq_ignore_ascii_case(&(b[0] as char)) {
                continue;
            }
            let candidate = format!("{letter}:\\{rest}");
            if is_dir(&candidate) {
                return Some(candidate);
            }
        }
    }
    let name = Path::new(missing).file_name()?.to_os_string();
    let mut roots: Vec<PathBuf> = Vec::new();
    for f in known_folders.iter().filter(|f| is_dir(f)) {
        let f = PathBuf::from(f);
        if let Some(parent) = f.parent()
            && !roots.contains(&parent.to_path_buf()) {
                roots.push(parent.to_path_buf());
            }
        if !roots.contains(&f) {
            roots.push(f);
        }
    }
    roots
        .into_iter()
        .map(|r| r.join(&name))
        .find(|c| c.to_string_lossy() != missing && is_dir(c))
        .map(|c| c.to_string_lossy().into_owned())
}

pub fn is_drive_root(p: &str) -> bool {
    let b = p.as_bytes();
    if (b.len() == 2 || b.len() == 3) && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || is_sep(b[2] as char)) {
        return true;
    }
    let path = Path::new(p);
    path.is_absolute() && path.parent().is_none()
}

pub fn basename(p: &str) -> String {
    Path::new(p.trim_end_matches(is_sep)).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn dirname(p: &str) -> String {
    Path::new(p.trim_end_matches(is_sep)).parent().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// `path.relative(from, to)` for the cases used here (to inside from, or not).
pub fn relative(from: &str, to: &str) -> String {
    let f = normalize(Path::new(from));
    let t = normalize(Path::new(to));
    if let Ok(rest) = t.strip_prefix(&f) {
        return rest.to_string_lossy().into_owned();
    }
    let fc: Vec<_> = f.components().collect();
    let tc: Vec<_> = t.components().collect();
    let common = fc.iter().zip(&tc).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..fc.len() {
        out.push("..");
    }
    for c in &tc[common..] {
        out.push(c.as_os_str());
    }
    out.to_string_lossy().into_owned()
}

/// Name order like `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`:
/// case-insensitive, digit runs compared as numbers.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n1 = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    n1.push(c);
                    x.next();
                }
                let mut n2 = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    n2.push(d);
                    y.next();
                }
                let (t1, t2) = (n1.trim_start_matches('0'), n2.trim_start_matches('0'));
                let o = t1.len().cmp(&t2.len()).then_with(|| t1.cmp(t2));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebase_respects_separator_boundary() {
        // P10
        assert_eq!(rebase(r"C:\proj\app\api", r"C:\proj\app", r"D:\proj\app").as_deref(), Some(r"D:\proj\app\api"));
        assert_eq!(rebase(r"C:\proj\app", r"C:\proj\app\", r"D:\x").as_deref(), Some(r"D:\x"));
        assert_eq!(rebase(r"C:\proj\app2\api", r"C:\proj\app", r"D:\proj\app"), None);
        assert_eq!(rebase(r"c:\PROJ\app\x", r"C:\proj\app", r"E:\a").as_deref(), Some(r"E:\a\x"));
        assert_eq!(rebase("/home/me/app-old/x", "/home/me/app", "/srv/app"), None);
        assert_eq!(rebase("/home/me/app/x", "/home/me/app", "/srv/app").as_deref(), Some("/srv/app/x"));
    }

    #[test]
    fn contains_on_boundary() {
        assert!(contains("/a/b", "/a/b/c"));
        assert!(contains("/a/b", "/a/b"));
        assert!(!contains("/a/b", "/a/bc"));
        assert!(contains("c:\\", "c:\\x"));
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["app10", "App2", "app1", "beta", "Alpha"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Alpha", "app1", "App2", "app10", "beta"]);
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative("/a/b", "/a/b/c/d"), "c/d");
        assert_eq!(relative("/a/b", "/a/b"), "");
        assert_eq!(relative("/a/b", "/a/x"), "../x");
    }

    #[test]
    fn relink_by_sibling_name() {
        let dir = tempfile::tempdir().unwrap();
        let known = dir.path().join("projects/shop");
        let moved = dir.path().join("projects/blog");
        std::fs::create_dir_all(&known).unwrap();
        std::fs::create_dir_all(&moved).unwrap();
        let missing = dir.path().join("old/blog").to_string_lossy().into_owned();
        assert_eq!(relink_candidate(&missing, &[known.to_string_lossy().into_owned()]), Some(moved.to_string_lossy().into_owned()));
    }
}
