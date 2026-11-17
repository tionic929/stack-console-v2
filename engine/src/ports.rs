//! Port checks.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::Duration;

/// Is something accepting connections on this port on the local machine (IPv4 or IPv6)?
/// Blocks for at most ~2 x `timeout`; call it off the engine's main task.
pub fn port_open(port: u16, timeout: Duration) -> bool {
    let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&v4, timeout).is_ok() || TcpStream::connect_timeout(&v6, timeout).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_listener() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_open(port, Duration::from_millis(200)));
        drop(l);
        assert!(!port_open(port, Duration::from_millis(200)));
    }
}

/// Who is listening on a TCP port: (pid, process name). Blocking (runs lsof / netstat).
pub fn find_listener(port: u16) -> Option<(u32, String)> {
    let pid = listener_pid(port)?;
    let name = process_name(pid).unwrap_or_else(|| format!("pid {pid}"));
    Some((pid, name))
}

fn run(cmd: &str, args: &[&str]) -> String {
    let mut c = std::process::Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Option<u32> {
    for proto in ["tcp", "tcpv6"] {
        let out = run("netstat", &["-ano", "-p", proto]);
        for line in out.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            // Proto  Local Address  Foreign Address  State  PID
            if cols.len() >= 5 && cols[3].to_ascii_uppercase().contains("LISTEN") {
                let local = cols[1];
                if local.ends_with(&format!(":{port}")) || local.ends_with(&format!(".{port}")) {
                    return cols[4].parse().ok();
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn listener_pid(port: u16) -> Option<u32> {
    let out = run("lsof", &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"]);
    out.split_whitespace().next()?.parse().ok()
}

#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    let out = run("tasklist", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    let first = out.lines().next()?;
    first.strip_prefix('"')?.split('"').next().map(str::to_string)
}

#[cfg(not(windows))]
fn process_name(pid: u32) -> Option<String> {
    let out = run("ps", &["-p", &pid.to_string(), "-o", "comm="]);
    Some(out.trim().to_string()).filter(|s| !s.is_empty())
}

/// Stops a process (and on Windows its tree) that holds a port, after the user confirmed.
pub fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        run("taskkill", &["/pid", &pid.to_string(), "/t", "/f"]);
    }
    #[cfg(unix)]
    // SAFETY: plain syscall on a pid the user confirmed
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(test)]
mod listener_tests {
    #[test]
    fn finds_own_listener() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let (pid, _name) = super::find_listener(port).expect("lsof should see the listener");
        assert_eq!(pid, std::process::id());
    }
}
