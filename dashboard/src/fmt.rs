//! Formatting helpers. Hand-rolled so the binary carries no date or
//! encoding crates for the handful of things a dashboard needs.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RFC 3986 unreserved characters pass through; everything else is %XX.
pub fn url_encode_into(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
}

pub fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 1234 -> "1.2k", 5_600_000 -> "5.6M".
pub fn compact(n: u64) -> String {
    let f = n as f64;
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => trim(format!("{:.1}", f / 1e3)) + "k",
        1_000_000..=999_999_999 => trim(format!("{:.1}", f / 1e6)) + "M",
        _ => trim(format!("{:.1}", f / 1e9)) + "B",
    }
}

fn trim(s: String) -> String {
    match s.strip_suffix(".0") {
        Some(t) => t.to_string(),
        None => s,
    }
}

pub fn ms(v: f64) -> String {
    if v <= 0.0 {
        "0 ms".into()
    } else if v < 10.0 {
        format!("{v:.1} ms")
    } else if v < 1000.0 {
        format!("{v:.0} ms")
    } else if v < 60_000.0 {
        format!("{:.2} s", v / 1000.0)
    } else {
        format!("{:.1} min", v / 60_000.0)
    }
}

pub fn pct(part: u64, whole: u64) -> String {
    if whole == 0 {
        return "–".into();
    }
    let p = part as f64 * 100.0 / whole as f64;
    if p == 0.0 {
        "0%".into()
    } else if p < 0.1 {
        "<0.1%".into()
    } else if p < 10.0 {
        format!("{p:.1}%")
    } else {
        format!("{p:.0}%")
    }
}

pub fn usd(v: f64) -> String {
    if v == 0.0 {
        "$0".into()
    } else if v < 0.0001 {
        "<$0.0001".into()
    } else if v < 0.01 {
        format!("${v:.4}")
    } else if v < 100.0 {
        format!("${v:.2}")
    } else {
        format!("${v:.0}")
    }
}

/// First `n` characters (char-boundary safe), with "…" when cut.
pub fn short(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// "12s ago", "4m ago", "3h ago", "2d ago".
pub fn ago(ts_ms: i64, now_ms: i64) -> String {
    let s = ((now_ms - ts_ms) / 1000).max(0);
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86_399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86_400),
    }
}

/// "2026-11-08 14:03:22.123" in UTC.
pub fn utc(ts_ms: i64) -> String {
    let (y, mo, d, h, mi, s, milli) = civil(ts_ms);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{milli:03}")
}

/// "14:03:22" in UTC — compact column for lists.
pub fn clock(ts_ms: i64) -> String {
    let (_, mo, d, h, mi, s, _) = civil(ts_ms);
    format!("{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// Days-to-civil from Howard Hinnant's date algorithms.
fn civil(ts_ms: i64) -> (i64, u32, u32, u32, u32, u32, u32) {
    let milli = ts_ms.rem_euclid(1000) as u32;
    let secs = ts_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, sod / 3600, (sod / 60) % 60, sod % 60, milli)
}

/// Pretty-print a JSON object string for display. Falls back to the input.
/// Only re-indents; never reorders or re-encodes values.
pub fn pretty_json(src: &str) -> String {
    let src = src.trim();
    if src.is_empty() || src == "{}" {
        return String::new();
    }
    let mut out = String::with_capacity(src.len() + src.len() / 4);
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    for c in src.chars() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '{' | '[' => {
                depth += 1;
                out.push(c);
                newline(&mut out, depth);
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(compact(999), "999");
        assert_eq!(compact(1000), "1k");
        assert_eq!(compact(1260), "1.3k");
        assert_eq!(compact(5_600_000), "5.6M");
        assert_eq!(ms(0.42), "0.4 ms");
        assert_eq!(ms(1532.0), "1.53 s");
        assert_eq!(pct(1, 2000), "<0.1%");
        assert_eq!(pct(5, 100), "5.0%");
        assert_eq!(usd(0.00123), "$0.0012");
        assert_eq!(utc(0), "1970-01-01 00:00:00.000");
        assert_eq!(utc(1_793_000_000_123), "2026-10-26 07:33:20.123");
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64(b"ab"), "YWI=");
        let mut s = String::new();
        url_encode_into(&mut s, "a b/é");
        assert_eq!(s, "a%20b%2F%C3%A9");
    }

    #[test]
    fn pretty_json_indents_without_touching_strings() {
        assert_eq!(
            pretty_json(r#"{"a":1,"b":"x, {y}"}"#),
            "{\n  \"a\": 1,\n  \"b\": \"x, {y}\"\n}"
        );
        assert_eq!(pretty_json("{}"), "");
    }
}
