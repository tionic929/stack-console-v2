//! Turns raw terminal output into log lines.
//!
//! Rules (reference: `services/stream_worker.py`, audit P1, P2, P8, F7):
//! - Only `\n` (or `\r\n`) ends a line. `>`, `->` and `=>` never do.
//! - A lone `\r` means "back to the start of the line": what came before it on that line is dropped,
//!   so a progress bar ends up as its last state instead of one row per update.
//! - Bytes are collected per line and decoded once the line is complete, so a character split across
//!   two reads survives; invalid UTF-8 becomes U+FFFD and capture carries on.
//! - Colour codes (SGR, `ESC[...m`) are kept; every other escape sequence (cursor moves, clears,
//!   window titles) is removed, as are stray control characters.

/// A line longer than this many bytes is sent in pieces, each cut on a character boundary.
pub const MAX_LINE_BYTES: usize = 8192;

#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    pending_cr: bool,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds raw bytes; returns finished lines, each ending in `\n` (pieces of an over-long line don't).
    pub fn push(&mut self, data: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in data {
            if self.pending_cr {
                self.pending_cr = false;
                if b == b'\n' {
                    out.push(self.take_line(true));
                    continue;
                }
                // Lone carriage return: the line is being redrawn from its start
                self.buf.clear();
            }
            match b {
                b'\r' => self.pending_cr = true,
                b'\n' => out.push(self.take_line(true)),
                _ => {
                    self.buf.push(b);
                    if self.buf.len() >= MAX_LINE_BYTES {
                        let cut = self.buf.len() - incomplete_tail_len(&self.buf);
                        let rest = self.buf.split_off(cut);
                        let piece = std::mem::replace(&mut self.buf, rest);
                        out.push(clean(&piece, false));
                    }
                }
            }
        }
        out
    }

    /// True when text is waiting for a newline (a prompt, a question, a progress bar).
    pub fn has_partial(&self) -> bool {
        !self.buf.is_empty() || self.pending_cr
    }

    /// Called after a quiet period: sends what is buffered so prompts still show.
    /// A trailing incomplete character stays buffered for the next read.
    pub fn flush_partial(&mut self) -> Option<String> {
        if self.pending_cr {
            // "text\r" followed by silence: treat the carriage return as the end of the line
            self.pending_cr = false;
            if self.buf.is_empty() {
                return None;
            }
            return Some(self.take_line(true));
        }
        if self.buf.is_empty() {
            return None;
        }
        let keep = incomplete_tail_len(&self.buf);
        let rest = self.buf.split_off(self.buf.len() - keep);
        let piece = std::mem::replace(&mut self.buf, rest);
        if piece.is_empty() {
            return None;
        }
        let text = clean(&piece, false);
        if text.is_empty() { None } else { Some(text) }
    }

    /// The stream ended: whatever is left, incomplete characters included (as U+FFFD).
    pub fn finish(&mut self) -> Option<String> {
        self.pending_cr = false;
        if self.buf.is_empty() {
            return None;
        }
        let piece = std::mem::take(&mut self.buf);
        let text = clean(&piece, true);
        if text.trim().is_empty() { None } else { Some(text) }
    }

    fn take_line(&mut self, newline: bool) -> String {
        let piece = std::mem::take(&mut self.buf);
        clean(&piece, newline)
    }
}

/// How many bytes at the end of `b` start a UTF-8 character that isn't complete yet.
pub fn incomplete_tail_len(b: &[u8]) -> usize {
    let n = b.len();
    for back in 1..=3.min(n) {
        let byte = b[n - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte, keep looking for the lead byte
        }
        let need = if byte & 0b1110_0000 == 0b1100_0000 {
            2
        } else if byte & 0b1111_0000 == 0b1110_0000 {
            3
        } else if byte & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            return 0; // ASCII or an invalid byte: nothing to wait for
        };
        return if back < need { back } else { 0 };
    }
    0
}

fn clean(bytes: &[u8], newline: bool) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = strip_terminal_controls(&text);
    if newline {
        out.push('\n');
    }
    out
}

/// Keeps text and SGR colour codes; drops other escape sequences and control characters.
/// Backspace removes the character before it (spinners).
pub fn strip_terminal_controls(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\x1b' {
            match chars.get(i + 1) {
                Some('[') => {
                    // CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E
                    let mut j = i + 2;
                    while j < chars.len() && ('\x20'..='\x3f').contains(&chars[j]) {
                        j += 1;
                    }
                    if j < chars.len() && ('\x40'..='\x7e').contains(&chars[j]) {
                        if chars[j] == 'm' {
                            out.extend(&chars[i..=j]);
                        }
                        i = j + 1;
                    } else {
                        i = j; // unterminated: drop what we saw
                    }
                }
                Some(']') => {
                    // OSC (window title, hyperlinks): ends with BEL or ESC \
                    let mut j = i + 2;
                    while j < chars.len() {
                        if chars[j] == '\x07' {
                            j += 1;
                            break;
                        }
                        if chars[j] == '\x1b' && chars.get(j + 1) == Some(&'\\') {
                            j += 2;
                            break;
                        }
                        j += 1;
                    }
                    i = j;
                }
                Some(_) => {
                    // Two- or three-character escapes (ESC ( B, ESC =, ESC 7 ...)
                    let mut j = i + 1;
                    while j < chars.len() && ('\x20'..='\x2f').contains(&chars[j]) {
                        j += 1;
                    }
                    i = (j + 1).min(chars.len());
                }
                None => i += 1,
            }
            continue;
        }
        if c == '\x08' {
            out.pop();
        } else if c == '\t' || !c.is_control() {
            out.push(c);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = LineSplitter::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(s.push(c));
        }
        out.extend(s.finish());
        out
    }

    #[test]
    fn arrows_and_tags_never_split_a_line() {
        // P2: the exact line from the audit
        let out = all(&[b"App->handle() => 200 <div>ok</div>\n"]);
        assert_eq!(out, vec!["App->handle() => 200 <div>ok</div>\n"]);
        let out = all(&[b"C:\\Users\\Name> echo\r\n", b"a > b\r\n"]);
        assert_eq!(out, vec!["C:\\Users\\Name> echo\n", "a > b\n"]);
    }

    #[test]
    fn invalid_utf8_is_replaced_and_capture_continues() {
        // P1: a Windows code page byte (0x82 = 'é' in cp850) followed by more output
        let out = all(&[b"caf\x82 latte\n", b"next line\n"]);
        assert_eq!(out, vec!["caf\u{fffd} latte\n", "next line\n"]);
    }

    #[test]
    fn multibyte_character_split_across_reads_survives() {
        // P8: "é" is C3 A9, "😀" is F0 9F 98 80
        let out = all(&[b"caf\xc3", b"\xa9 \xf0\x9f", b"\x98\x80 ok\n"]);
        assert_eq!(out, vec!["café 😀 ok\n"]);
    }

    #[test]
    fn crlf_split_across_reads_is_one_newline() {
        let out = all(&[b"one\r", b"\ntwo\r\n"]);
        assert_eq!(out, vec!["one\n", "two\n"]);
    }

    #[test]
    fn lone_carriage_return_overwrites_progress() {
        let out = all(&[b"[==  ] 50%\r[====] 100%\n"]);
        assert_eq!(out, vec!["[====] 100%\n"]);
    }

    #[test]
    fn partial_flush_keeps_incomplete_character() {
        let mut s = LineSplitter::new();
        assert!(s.push(b"Continue? (y/n) \xc3").is_empty());
        assert_eq!(s.flush_partial().as_deref(), Some("Continue? (y/n) "));
        assert!(s.has_partial());
        assert_eq!(s.push(b"\xa9\n"), vec!["é\n"]);
    }

    #[test]
    fn long_line_is_cut_on_char_boundary() {
        let mut data = vec![b'a'; MAX_LINE_BYTES - 1];
        data.extend_from_slice("é".as_bytes()); // crosses the limit
        data.extend_from_slice(b"tail\n");
        let out = all(&[&data]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), MAX_LINE_BYTES - 1);
        assert_eq!(out[1], "étail\n");
    }

    #[test]
    fn colours_kept_cursor_codes_removed() {
        let out = all(&[b"\x1b[?25l\x1b[2K\x1b[1G\x1b[32m  VITE\x1b[39m ready\x1b]0;title\x07\n"]);
        assert_eq!(out, vec!["\x1b[32m  VITE\x1b[39m ready\n"]);
    }

    #[test]
    fn backspace_and_bell_handled() {
        let out = all(&[b"spin |\x08/\x08-\x07 done\n"]);
        assert_eq!(out, vec!["spin - done\n"]);
    }

    #[test]
    fn incomplete_tail() {
        assert_eq!(incomplete_tail_len(b"abc"), 0);
        assert_eq!(incomplete_tail_len(b"ab\xc3"), 1);
        assert_eq!(incomplete_tail_len(b"ab\xc3\xa9"), 0);
        assert_eq!(incomplete_tail_len(b"\xf0\x9f\x98"), 3);
        assert_eq!(incomplete_tail_len(b"\xf0\x9f\x98\x80"), 0);
        assert_eq!(incomplete_tail_len(b"\xff"), 0);
    }
}
