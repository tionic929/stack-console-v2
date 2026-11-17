//! Per-service log buffer and "ready" detection.

use serde::Serialize;
use std::collections::VecDeque;

pub const MAX_LOG_LINES: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
    System,
    Input,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogLine {
    pub seq: u64,
    pub ts: u64,
    pub stream: Stream,
    pub text: String,
}

/// The last `MAX_LOG_LINES` lines of one service. A ring buffer, so dropping the oldest line
/// costs nothing (F8).
#[derive(Debug, Default)]
pub struct LogBuffer {
    seq: u64,
    lines: VecDeque<LogLine>,
}

impl LogBuffer {
    pub fn push(&mut self, ts: u64, stream: Stream, text: String) -> LogLine {
        self.seq += 1;
        let line = LogLine { seq: self.seq, ts, stream, text };
        if self.lines.len() == MAX_LOG_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line.clone());
        line
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn lines(&self) -> Vec<LogLine> {
        self.lines.iter().cloned().collect()
    }

    /// Clears the lines; the sequence keeps counting so a window never mistakes new lines for old.
    pub fn clear(&mut self) {
        self.lines.clear();
    }
}

/// Removes every ANSI escape sequence (for matching, not for display).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// A local URL printed by a dev server: Vite "Local: http://localhost:5173/", artisan
/// "[http://127.0.0.1:8000]", uvicorn "http://127.0.0.1:8001". Returns (display url, port);
/// 0.0.0.0 and [::] are shown as localhost.
pub fn find_local_url(plain: &str) -> Option<(String, u16)> {
    let lower = plain.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("http") {
        let start = from + pos;
        from = start + 4;
        let rest = &lower[start..];
        let (scheme, after) = if let Some(a) = rest.strip_prefix("https://") {
            ("https", a)
        } else if let Some(a) = rest.strip_prefix("http://") {
            ("http", a)
        } else {
            continue;
        };
        let hosts = [
            ("localhost", "localhost"),
            ("127.0.0.1", "127.0.0.1"),
            ("0.0.0.0", "localhost"),
            ("[::1]", "[::1]"),
            ("[::]", "localhost"),
        ];
        for (host, shown) in hosts {
            let Some(tail) = after.strip_prefix(host).and_then(|t| t.strip_prefix(':')) else { continue };
            let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
            if (2..=5).contains(&digits.len())
                && let Ok(port) = digits.parse::<u16>() {
                    return Some((format!("{scheme}://{shown}:{port}"), port));
                }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_caps_and_keeps_counting() {
        let mut b = LogBuffer::default();
        for i in 0..MAX_LOG_LINES + 10 {
            b.push(0, Stream::Stdout, format!("{i}\n"));
        }
        let lines = b.lines();
        assert_eq!(lines.len(), MAX_LOG_LINES);
        assert_eq!(lines[0].text, "10\n");
        assert_eq!(b.seq(), (MAX_LOG_LINES + 10) as u64);
        b.clear();
        assert!(b.lines().is_empty());
        assert_eq!(b.push(0, Stream::System, "x".into()).seq, (MAX_LOG_LINES + 11) as u64);
    }

    #[test]
    fn local_urls() {
        let vite = strip_ansi("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m");
        assert_eq!(find_local_url(&vite), Some(("http://localhost:5173".into(), 5173)));
        assert_eq!(
            find_local_url("INFO  Server running on [http://127.0.0.1:8000]."),
            Some(("http://127.0.0.1:8000".into(), 8000))
        );
        assert_eq!(find_local_url("Uvicorn running on http://0.0.0.0:8001 (CTRL+C)"), Some(("http://localhost:8001".into(), 8001)));
        assert_eq!(find_local_url("see https://example.com:443 or HTTP://[::1]:9000"), Some(("http://[::1]:9000".into(), 9000)));
        assert_eq!(find_local_url("http://localhost:1"), None);
        assert_eq!(find_local_url("nothing here"), None);
    }
}
