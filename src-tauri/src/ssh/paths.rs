//! Remote POSIX path helpers and human-facing name ordering.
//!
//! Remote paths are plain strings on purpose: `PathBuf` would apply the local
//! OS's rules, and on Windows that means backslashes on a Linux server.

use std::cmp::Ordering;

/// Joins a remote path segment onto a base directory, POSIX rules only.
pub fn posix_join(base: &str, name: &str) -> String {
    if name.starts_with('/') {
        return posix_normalize(name);
    }
    if base == "/" {
        posix_normalize(&format!("/{name}"))
    } else {
        posix_normalize(&format!("{base}/{name}"))
    }
}

/// Lexically resolves `.` and `..` in a remote path. The server canonicalizes
/// authoritatively via SFTP REALPATH; this keeps client-side joins consistent.
pub fn posix_normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            component => parts.push(component),
        }
    }
    if parts.is_empty() {
        return "/".to_string();
    }
    format!("/{}", parts.join("/"))
}

/// The last segment of a POSIX path (`""` stays `""` — caller decides).
pub fn parent_of(path: &str) -> String {
    let cut = path.rfind('/').unwrap_or(0);
    if cut == 0 {
        "/".to_string()
    } else {
        path[..cut].to_string()
    }
}

pub fn base_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// Splits a name into digit / non-digit chunks for natural ordering.
fn natural_chunks(s: &str) -> Vec<(bool, String)> {
    let mut chunks: Vec<(bool, String)> = Vec::new();
    let mut current = String::new();
    let mut current_digit: Option<bool> = None;
    for char in s.chars() {
        let digit = char.is_ascii_digit();
        if Some(digit) != current_digit && !current.is_empty() {
            chunks.push((current_digit.unwrap_or(false), std::mem::take(&mut current)));
        }
        current_digit = Some(digit);
        current.push(char);
    }
    if !current.is_empty() {
        chunks.push((current_digit.unwrap_or(false), current));
    }
    chunks
}

/// Orders names the way humans expect: embedded numbers compare by value, so
/// `file2` sorts before `file10`. Non-digits compare by character value, which
/// also gives stable ordering for CJK names and names with spaces.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let chunk_a = natural_chunks(a);
    let chunk_b = natural_chunks(b);
    for index in 0..chunk_a.len().min(chunk_b.len()) {
        let (digit_a, text_a) = &chunk_a[index];
        let (digit_b, text_b) = &chunk_b[index];
        let ordering = match (digit_a, digit_b) {
            (true, true) => text_a
                .parse::<u64>()
                .unwrap_or(u64::MAX)
                .cmp(&text_b.parse::<u64>().unwrap_or(u64::MAX)),
            _ => text_a.cmp(text_b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
        if digit_a != digit_b {
            return digit_b.cmp(digit_a); // digits before letters
        }
    }
    chunk_a.len().cmp(&chunk_b.len())
}

/// `1.5 MB` style, for error messages.
pub fn format_size_human(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = "B";
    for next in units {
        value /= 1024.0;
        unit = next;
        if value < 1024.0 {
            break;
        }
    }
    format!("{value:.1} {unit}")
}
