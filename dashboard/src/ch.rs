//! Minimal ClickHouse HTTP client.
//!
//! One pooled keep-alive connection set, queries sent as POST bodies with
//! server-side bound parameters (`{name:Type}` + `param_name=`), so nothing
//! user-supplied is ever spliced into SQL. Results come back as
//! `TabSeparated`, which is the cheapest format to parse: rows are borrowed
//! slices of one response buffer and only fields that actually contain an
//! escape sequence get copied.

use std::borrow::Cow;
use std::fmt;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper::header::{CONTENT_TYPE, HeaderValue};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::fmt::url_encode_into;

#[cfg(feature = "tls")]
type Connector = hyper_rustls::HttpsConnector<HttpConnector>;
#[cfg(not(feature = "tls"))]
type Connector = HttpConnector;

pub struct ChConfig {
    pub url: String,
    pub user: String,
    pub password: String,
    pub database: String,
}

pub struct Ch {
    client: Client<Connector, Full<Bytes>>,
    prefix: String,
    user: HeaderValue,
    key: HeaderValue,
}

#[derive(Debug)]
pub struct ChError(pub String);

impl fmt::Display for ChError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Ch {
    pub fn new(cfg: &ChConfig) -> Result<Self, String> {
        let base = cfg.url.trim_end_matches('/');
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err(format!(
                "CLICKHOUSE_URL must start with http:// or https:// (got {base})"
            ));
        }
        if base.starts_with("https://") && !cfg!(feature = "tls") {
            return Err(
                "CLICKHOUSE_URL is https:// but this build has no TLS; rebuild with --features tls"
                    .into(),
            );
        }

        let mut http = HttpConnector::new();
        http.set_nodelay(true);
        http.set_keepalive(Some(Duration::from_secs(60)));
        http.set_connect_timeout(Some(Duration::from_secs(5)));
        #[cfg(feature = "tls")]
        let connector = {
            http.enforce_http(false);
            hyper_rustls::HttpsConnectorBuilder::new()
                .with_webpki_roots()
                .https_or_http()
                .enable_http1()
                .wrap_connector(http)
        };
        #[cfg(not(feature = "tls"))]
        let connector = http;

        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(16)
            .build(connector);

        // readonly=2: SELECT only, but per-query settings are still allowed.
        // The dashboard can never write or alter anything even if a query
        // were somehow wrong. Results are capped so a bad filter can't pull
        // a whole table into memory.
        let prefix = format!(
            "{base}/?database={}&readonly=2&max_execution_time=15\
             &max_result_rows=50000&result_overflow_mode=break\
             &max_memory_usage=1000000000",
            cfg.database
        );
        let header = |v: &str, what: &str| {
            HeaderValue::from_str(v).map_err(|_| format!("{what} contains invalid characters"))
        };
        Ok(Self {
            client,
            prefix,
            user: header(&cfg.user, "CLICKHOUSE_USER")?,
            key: header(&cfg.password, "CLICKHOUSE_PASSWORD")?,
        })
    }

    pub async fn query(&self, sql: &str, params: &[(&str, &str)]) -> Result<Rows, ChError> {
        let mut url = String::with_capacity(self.prefix.len() + 64 * params.len());
        url.push_str(&self.prefix);
        for (name, value) in params {
            url.push_str("&param_");
            url.push_str(name);
            url.push('=');
            url_encode_into(&mut url, value);
        }
        let mut body = String::with_capacity(sql.len() + 24);
        body.push_str(sql);
        body.push_str("\nFORMAT TabSeparated");

        let req = Request::post(url)
            .header("X-ClickHouse-User", self.user.clone())
            .header("X-ClickHouse-Key", self.key.clone())
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| ChError(format!("bad request: {e}")))?;

        let resp = tokio::time::timeout(Duration::from_secs(20), self.client.request(req))
            .await
            .map_err(|_| ChError("ClickHouse did not answer within 20s".into()))?
            .map_err(|e| ChError(format!("cannot reach ClickHouse: {e}")))?;
        let status = resp.status();
        let bytes = resp
            .into_body()
            .collect()
            .await
            .map_err(|e| ChError(format!("ClickHouse response broke off: {e}")))?
            .to_bytes();
        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim();
            // Drop the stack-trace tail ClickHouse appends; keep the message.
            let text = text.split(" (version ").next().unwrap_or(text);
            return Err(ChError(text.chars().take(600).collect()));
        }
        Ok(Rows::new(bytes))
    }

    pub async fn ping(&self) -> bool {
        self.query("SELECT 1", &[]).await.is_ok()
    }
}

/// A TabSeparated result. Holds the whole body once; rows borrow from it.
pub struct Rows {
    text: String,
}

impl Rows {
    fn new(bytes: Bytes) -> Self {
        let vec = Vec::from(bytes);
        let text = match String::from_utf8(vec) {
            Ok(s) => s,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        };
        Self { text }
    }

    pub fn iter(&self) -> impl Iterator<Item = Row<'_>> {
        self.text
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(|l| Row(l.split('\t').collect()))
    }

    pub fn first(&self) -> Option<Row<'_>> {
        self.iter().next()
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

pub struct Row<'a>(Vec<&'a str>);

impl<'a> Row<'a> {
    #[inline]
    fn raw(&self, i: usize) -> &'a str {
        self.0.get(i).copied().unwrap_or("")
    }

    /// String field, with TSV escapes decoded only when present.
    pub fn s(&self, i: usize) -> Cow<'a, str> {
        unescape(self.raw(i))
    }

    pub fn u(&self, i: usize) -> u64 {
        self.raw(i).parse().unwrap_or(0)
    }

    pub fn i(&self, i: usize) -> i64 {
        self.raw(i).parse().unwrap_or(0)
    }

    pub fn f(&self, i: usize) -> f64 {
        let v: f64 = self.raw(i).parse().unwrap_or(0.0);
        if v.is_finite() { v } else { 0.0 }
    }
}

fn unescape(field: &str) -> Cow<'_, str> {
    if field == "\\N" {
        return Cow::Borrowed("");
    }
    if !field.contains('\\') {
        return Cow::Borrowed(field);
    }
    let mut out = String::with_capacity(field.len());
    let mut chars = field.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('0') => out.push('\0'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tsv_rows_and_escapes() {
        let rows = Rows::new(Bytes::from_static(
            b"a\\tb\t42\t1.5\nline\\nbreak\t\\N\tnan\n",
        ));
        let all: Vec<_> = rows.iter().collect();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].s(0), "a\tb");
        assert_eq!(all[0].u(1), 42);
        assert_eq!(all[0].f(2), 1.5);
        assert_eq!(all[1].s(0), "line\nbreak");
        assert_eq!(all[1].s(1), "");
        assert_eq!(all[1].f(2), 0.0);
        assert_eq!(all[1].s(9), "");
    }

    #[test]
    fn borrows_when_no_escape() {
        assert!(matches!(unescape("plain"), Cow::Borrowed(_)));
        assert_eq!(unescape("back\\\\slash"), "back\\slash");
    }
}
