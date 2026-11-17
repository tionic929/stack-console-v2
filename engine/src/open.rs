//! Opening a folder in the file manager, VS Code or a terminal. The folder is passed as an argument
//! or working directory, never through a shell. Reference: `openFolder` in `main/folders.js`.

use std::path::Path;
use std::process::{Command, Stdio};

fn detached(cmd: &str, args: &[&str], cwd: Option<&str>) -> bool {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c.spawn().is_ok()
}

#[cfg(windows)]
fn find_vscode() -> Option<String> {
    let out = Command::new("where").arg("code").output().ok()?;
    let mut candidates: Vec<std::path::PathBuf> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| Path::new(s.trim()).parent().and_then(Path::parent).map(|p| p.join("Code.exe")).unwrap_or_default())
        .collect();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(Path::new(&local).join("Programs/Microsoft VS Code/Code.exe"));
    }
    candidates.push(Path::new(&std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into())).join("Microsoft VS Code/Code.exe"));
    candidates.into_iter().find(|c| c.is_file()).map(|c| c.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn find_vscode() -> Option<String> {
    let out = Command::new("which").arg("code").output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !p.is_empty() {
        return Some(p);
    }
    let app = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    Path::new(app).is_file().then(|| app.to_string())
}

/// target: "explorer" | "vscode" | "terminal".
pub fn open_folder(target: &str, folder: &str) -> Result<(), String> {
    if !Path::new(folder).is_dir() {
        return Err(format!("Folder not found: {folder}"));
    }
    match target {
        "explorer" => {
            #[cfg(windows)]
            let ok = detached("explorer.exe", &[folder], None);
            #[cfg(target_os = "macos")]
            let ok = detached("open", &[folder], None);
            #[cfg(all(unix, not(target_os = "macos")))]
            let ok = detached("xdg-open", &[folder], None);
            if ok { Ok(()) } else { Err("The folder could not be opened.".into()) }
        }
        "vscode" => {
            let code = find_vscode().ok_or("VS Code wasn't found. Install it, or turn on \"Add to PATH\" in its installer.")?;
            if detached(&code, &[folder], None) { Ok(()) } else { Err("VS Code could not be started.".into()) }
        }
        "terminal" => {
            #[cfg(windows)]
            let ok = detached("wt.exe", &["-d", "."], Some(folder)) || detached("cmd.exe", &["/c", "start", "StackConsole", "cmd.exe"], Some(folder));
            #[cfg(target_os = "macos")]
            let ok = detached("open", &["-a", "Terminal", folder], None);
            #[cfg(all(unix, not(target_os = "macos")))]
            let ok = detached("x-terminal-emulator", &[], Some(folder));
            if ok { Ok(()) } else { Err("No terminal could be started.".into()) }
        }
        _ => Err("Unknown action.".into()),
    }
}
