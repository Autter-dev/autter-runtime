//! Autter Runtime dashboard: a single small binary that reads the
//! self-hosted ingester's ClickHouse tables and serves server-rendered
//! pages for telemetry, errors, events, traces and LLM usage.
//!
//! Design notes (why it's fast and cheap):
//! - single-threaded tokio runtime: the work is I/O-bound, a page is a few
//!   concurrent ClickHouse queries plus microseconds of templating;
//! - every query filters on the tables' leading ORDER BY columns and only
//!   reads the columns it shows; heavy aggregation happens in ClickHouse;
//! - pages are complete HTML on arrival (no client-side fetch waterfall);
//!   the only script is ~4 KB, cached forever under a content hash.

mod ch;
mod ctx;
mod fmt;
mod layout;
mod pages;

use std::io::Write as _;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::{
    ACCEPT_ENCODING, AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE, VARY,
    WWW_AUTHENTICATE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use flate2::Compression;
use flate2::write::GzEncoder;
use maud::Markup;

use crate::ch::{Ch, ChConfig, ChError};
use crate::ctx::{App, P};
use crate::layout::{Shell, Tab};

/// Everything the browser ever loads besides the page itself, compiled into
/// the binary and served from `/s/<name>` with immutable caching. Brand
/// assets come from the Autter website (logo, favicon, Quattrocento Sans /
/// Quattrocento / Inconsolata under the SIL OFL — see assets/fonts/OFL.txt).
const FILES: [(&str, &str, &[u8]); 9] = [
    (
        "app.css",
        "text/css; charset=utf-8",
        include_bytes!("../assets/app.css"),
    ),
    (
        "app.js",
        "text/javascript; charset=utf-8",
        include_bytes!("../assets/app.js"),
    ),
    (
        "logo-light.png",
        "image/png",
        include_bytes!("../assets/brand/logo-light.png"),
    ),
    (
        "logo-dark.png",
        "image/png",
        include_bytes!("../assets/brand/logo-dark.png"),
    ),
    (
        "favicon.png",
        "image/png",
        include_bytes!("../assets/brand/favicon.png"),
    ),
    (
        "qs-400.woff2",
        "font/woff2",
        include_bytes!("../assets/fonts/qs-400.woff2"),
    ),
    (
        "qs-700.woff2",
        "font/woff2",
        include_bytes!("../assets/fonts/qs-700.woff2"),
    ),
    (
        "q-700.woff2",
        "font/woff2",
        include_bytes!("../assets/fonts/q-700.woff2"),
    ),
    (
        "inc-400.woff2",
        "font/woff2",
        include_bytes!("../assets/fonts/inc-400.woff2"),
    ),
];

const HELP: &str = "autter-runtime-dashboard — local UI for a self-hosted Autter Runtime

Reads the ClickHouse tables written by the OTLP ingester. Configure with
environment variables (same names as the ingester where they overlap):

  CLICKHOUSE_URL           default http://localhost:8123
  CLICKHOUSE_USER          default `default`
  CLICKHOUSE_PASSWORD      default empty
  CLICKHOUSE_DATABASE      default autter_runtime
  DASHBOARD_ADDR           listen address, default 127.0.0.1:4319
  DASHBOARD_BASIC_AUTH     optional `user:password` to require HTTP basic auth
  DASHBOARD_ORG_ID         optional: pin the dashboard to one org …
  DASHBOARD_REPOSITORY_ID  … and repository (otherwise a picker is shown)
";

struct Config {
    ch: ChConfig,
    addr: SocketAddr,
    basic_auth: Option<String>,
    pin: Option<(String, String)>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let database = env("CLICKHOUSE_DATABASE").unwrap_or_else(|| "autter_runtime".into());
        let valid_db = database
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && database
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_db {
            return Err(format!("invalid CLICKHOUSE_DATABASE name: {database}"));
        }
        let addr_raw = env("DASHBOARD_ADDR").unwrap_or_else(|| "127.0.0.1:4319".into());
        let addr = addr_raw.parse().map_err(|_| {
            format!("invalid DASHBOARD_ADDR {addr_raw:?} (expected e.g. 127.0.0.1:4319)")
        })?;
        let basic_auth = match env("DASHBOARD_BASIC_AUTH") {
            Some(v) if v.contains(':') => Some(format!("Basic {}", fmt::base64(v.as_bytes()))),
            Some(_) => return Err("DASHBOARD_BASIC_AUTH must look like user:password".into()),
            None => None,
        };
        let pin = match (env("DASHBOARD_ORG_ID"), env("DASHBOARD_REPOSITORY_ID")) {
            (Some(o), Some(r)) => Some((o, r)),
            (None, None) => None,
            _ => {
                return Err(
                    "set both DASHBOARD_ORG_ID and DASHBOARD_REPOSITORY_ID, or neither".into(),
                );
            }
        };
        Ok(Self {
            ch: ChConfig {
                url: env("CLICKHOUSE_URL").unwrap_or_else(|| "http://localhost:8123".into()),
                user: env("CLICKHOUSE_USER").unwrap_or_else(|| "default".into()),
                password: std::env::var("CLICKHOUSE_PASSWORD").unwrap_or_default(),
                database,
            },
            addr,
            basic_auth,
            pin,
        })
    }
}

struct Assets {
    version: String,
    /// Pre-gzipped bodies for the text files (index into FILES).
    gz: [Option<Vec<u8>>; FILES.len()],
}

static ASSETS: OnceLock<Assets> = OnceLock::new();

fn assets() -> &'static Assets {
    ASSETS.get_or_init(|| {
        // FNV-1a over every file: one content hash for cache-busting URLs.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in FILES.iter().flat_map(|f| f.2.iter()) {
            h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
        }
        Assets {
            version: format!("{:08x}", h as u32),
            gz: FILES.map(|(_, ctype, body)| {
                ctype
                    .starts_with("text/")
                    .then(|| gzip(body, Compression::best()))
            }),
        }
    })
}

fn gzip(data: &[u8], level: Compression) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::with_capacity(data.len() / 3), level);
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

fn accepts_gzip(h: &HeaderMap) -> bool {
    h.get(ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"))
}

const CSP: &str = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; \
                   img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; \
                   frame-ancestors 'none'; base-uri 'none'";

fn respond(h: &HeaderMap, status: StatusCode, markup: Markup) -> Response {
    let body = markup.into_string();
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert("content-security-policy", HeaderValue::from_static(CSP));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(VARY, HeaderValue::from_static("accept-encoding"));
    // Fast gzip level: ~5x smaller pages for well under a millisecond.
    if body.len() > 1400 && accepts_gzip(h) {
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        return (status, headers, gzip(body.as_bytes(), Compression::fast())).into_response();
    }
    (status, headers, body).into_response()
}

fn ch_error(h: &HeaderMap, e: ChError) -> Response {
    eprintln!("clickhouse error: {e}");
    respond(
        h,
        StatusCode::BAD_GATEWAY,
        layout::error_page(&assets().version, &e.0),
    )
}

type Keep = Vec<(&'static str, String)>;

/// Shared page pipeline: resolve context, run the page's queries, wrap in
/// the shell. A macro rather than a fn so each page's future can borrow
/// the context without boxing.
macro_rules! page {
    ($app:expr, $p:expr, $h:expr, $tab:expr, $title:expr, $keep:expr, |$ctx:ident| $body:expr) => {{
        let app: &App = &$app;
        let ctx = match app.ctx(&$p).await {
            Ok(c) => c,
            Err(e) => return ch_error(&$h, e),
        };
        let $ctx = &ctx;
        let body = if ctx.has_tenant() {
            $body.await
        } else {
            Ok(layout::no_data())
        };
        match body {
            Ok(b) => {
                let keep: Keep = $keep;
                let keep_ref: Vec<(&str, &str)> =
                    keep.iter().map(|(k, v)| (*k, v.as_str())).collect();
                let title: &str = $title;
                let shell = Shell {
                    ctx: &ctx,
                    asset_version: &app.asset_version,
                    tab: $tab,
                    title,
                    keep: &keep_ref,
                };
                respond(&$h, StatusCode::OK, layout::page(&shell, b))
            }
            Err(e) => ch_error(&$h, e),
        }
    }};
}

type AppState = State<Arc<App>>;

async fn overview(State(app): AppState, Query(p): Query<P>, h: HeaderMap) -> Response {
    page!(app, p, h, Tab::Overview, "Overview", vec![], |ctx| {
        pages::overview::render(&app, ctx)
    })
}

async fn errors(State(app): AppState, Query(p): Query<P>, h: HeaderMap) -> Response {
    page!(
        app,
        p,
        h,
        Tab::Errors,
        "Errors",
        pages::errors::keep(&p),
        |ctx| pages::errors::list(&app, ctx, &p)
    )
}

async fn error_detail(
    State(app): AppState,
    Path(fp): Path<String>,
    Query(p): Query<P>,
    h: HeaderMap,
) -> Response {
    if !is_id(&fp) {
        return not_found(h).await;
    }
    page!(app, p, h, Tab::Errors, "Issue", vec![], |ctx| {
        pages::errors::detail(&app, ctx, &fp, &p)
    })
}

async fn events(State(app): AppState, Query(p): Query<P>, h: HeaderMap) -> Response {
    page!(
        app,
        p,
        h,
        Tab::Events,
        "Events",
        pages::events::keep(&p),
        |ctx| pages::events::render(&app, ctx, &p)
    )
}

async fn traces(State(app): AppState, Query(p): Query<P>, h: HeaderMap) -> Response {
    page!(
        app,
        p,
        h,
        Tab::Traces,
        "Traces",
        pages::traces::keep(&p),
        |ctx| pages::traces::list(&app, ctx, &p)
    )
}

async fn trace_detail(
    State(app): AppState,
    Path(id): Path<String>,
    Query(p): Query<P>,
    h: HeaderMap,
) -> Response {
    if !is_id(&id) {
        return not_found(h).await;
    }
    page!(app, p, h, Tab::Traces, "Trace", vec![], |ctx| {
        pages::traces::detail(&app, ctx, &id)
    })
}

async fn llm(State(app): AppState, Query(p): Query<P>, h: HeaderMap) -> Response {
    page!(
        app,
        p,
        h,
        Tab::Llm,
        "LLM",
        vec![],
        |ctx| pages::llm::render(&app, ctx)
    )
}

/// Fingerprints and trace ids are hex; allow a little more, but bounded.
fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn not_found(h: HeaderMap) -> Response {
    respond(
        &h,
        StatusCode::NOT_FOUND,
        layout::not_found(&assets().version),
    )
}

async fn static_file(Path(name): Path<String>, h: HeaderMap) -> Response {
    let Some(i) = FILES.iter().position(|f| f.0 == name) else {
        return not_found(h).await;
    };
    let (_, ctype, body) = FILES[i];
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(ctype));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if let Some(gz) = &assets().gz[i] {
        headers.insert(VARY, HeaderValue::from_static("accept-encoding"));
        if accepts_gzip(&h) {
            headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            return (headers, gz.as_slice()).into_response();
        }
    }
    (headers, body).into_response()
}

async fn health(State(app): AppState) -> Response {
    let ok = app.ch.ping().await;
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        [(CONTENT_TYPE, "application/json")],
        format!("{{\"ok\":{ok},\"clickhouse\":{ok}}}"),
    )
        .into_response()
}

async fn auth(State(expected): State<Option<Arc<str>>>, req: Request, next: Next) -> Response {
    if let Some(expected) = expected
        && req.uri().path() != "/healthz"
    {
        let given = req
            .headers()
            .get(AUTHORIZATION)
            .map(HeaderValue::as_bytes)
            .unwrap_or(b"");
        if !ct_eq(given, expected.as_bytes()) {
            return (
                StatusCode::UNAUTHORIZED,
                [(
                    WWW_AUTHENTICATE,
                    "Basic realm=\"Autter Runtime\", charset=\"UTF-8\"",
                )],
                "Authentication required",
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// Constant-time comparison (length is not secret).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let arg = std::env::args().nth(1);
    match arg.as_deref() {
        Some("-h" | "--help") => {
            print!("{HELP}");
            return;
        }
        Some("-V" | "--version") => {
            println!("autter-runtime-dashboard {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }

    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}\n\n{HELP}");
            std::process::exit(2);
        }
    };
    let ch = match Ch::new(&cfg.ch) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };
    let app = Arc::new(App::new(ch, cfg.pin, assets().version.clone()));

    if !cfg.addr.ip().is_loopback() && cfg.basic_auth.is_none() {
        eprintln!(
            "warning: listening on {} without DASHBOARD_BASIC_AUTH — anyone who can reach this port can read your telemetry",
            cfg.addr
        );
    }
    if app.ch.ping().await {
        eprintln!(
            "clickhouse: connected ({}, database {})",
            cfg.ch.url, cfg.ch.database
        );
    } else {
        eprintln!(
            "clickhouse: not reachable yet at {} — pages will show the error until it is",
            cfg.ch.url
        );
    }

    let auth_state: Option<Arc<str>> = cfg.basic_auth.map(Arc::from);
    let router = Router::new()
        .route("/", get(overview))
        .route("/errors", get(errors))
        .route("/errors/{fingerprint}", get(error_detail))
        .route("/events", get(events))
        .route("/traces", get(traces))
        .route("/traces/{trace_id}", get(trace_detail))
        .route("/llm", get(llm))
        .route("/s/{name}", get(static_file))
        .route("/healthz", get(health))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(auth_state, auth))
        .with_state(app);

    let listener = match tokio::net::TcpListener::bind(cfg.addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {}: {e}", cfg.addr);
            std::process::exit(1);
        }
    };
    eprintln!("dashboard: http://{}", cfg.addr);
    if let Err(e) = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
