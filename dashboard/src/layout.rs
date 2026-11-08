//! Page shell and shared components. Everything is rendered server-side by
//! maud (templates compile to plain string pushes); the browser gets HTML
//! that is complete on arrival, plus one small cached script for charts.

use std::fmt::Write as _;

use maud::{DOCTYPE, Markup, html};

use crate::ctx::{Ctx, RANGES};
use crate::fmt;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Overview,
    Errors,
    Events,
    Traces,
    Llm,
}

const TABS: [(Tab, &str, &str); 5] = [
    (Tab::Overview, "Overview", "/"),
    (Tab::Errors, "Errors", "/errors"),
    (Tab::Events, "Events", "/events"),
    (Tab::Traces, "Traces", "/traces"),
    (Tab::Llm, "LLM", "/llm"),
];

pub struct Shell<'a> {
    pub ctx: &'a Ctx,
    pub asset_version: &'a str,
    pub tab: Tab,
    pub title: &'a str,
    /// Page-specific query params the filter form should carry along.
    pub keep: &'a [(&'a str, &'a str)],
}

pub fn page(shell: &Shell, body: Markup) -> Markup {
    let ctx = shell.ctx;
    let v = shell.asset_version;
    let path = TABS
        .iter()
        .find(|t| t.0 == shell.tab)
        .map(|t| t.2)
        .unwrap_or("/");
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width,initial-scale=1";
                title { (shell.title) " · Autter Runtime" }
                (head_assets(v))
                script defer src={ "/s/app.js?v=" (v) } {}
            }
            body {
                header.top {
                    a.brand href=(ctx.href("/", &[])) aria-label="Autter Runtime — overview" {
                        (logo(v))
                        span.product { "Runtime" }
                    }
                    nav.tabs {
                        @for (tab, label, href) in TABS {
                            a.on[tab == shell.tab] href=(ctx.href(href, &[])) { (label) }
                        }
                    }
                    form.filters method="get" action=(path) {
                        @for (k, val) in shell.keep {
                            @if !val.is_empty() { input type="hidden" name=(k) value=(val); }
                        }
                        @if ctx.tenants.len() > 1 {
                            select data-nav aria-label="Repository" {
                                @for (o, r) in ctx.tenants.iter() {
                                    @let href = format!("{path}?org={}&repo={}", enc(o), enc(r));
                                    option value=(href) selected[*o == ctx.org && *r == ctx.repo] {
                                        (r) " · " (o)
                                    }
                                }
                            }
                        }
                        @if ctx.tenants.len() > 1 || !ctx.org.is_empty() {
                            input type="hidden" name="org" value=(ctx.org);
                            input type="hidden" name="repo" value=(ctx.repo);
                        }
                        select name="service" data-auto aria-label="Service" {
                            option value="" { "All services" }
                            @for s in &ctx.facets.services {
                                option value=(s) selected[*s == ctx.service] { (s) }
                            }
                        }
                        select name="env" data-auto aria-label="Environment" {
                            option value="" { "All envs" }
                            @for e in &ctx.facets.envs {
                                option value=(e) selected[*e == ctx.env] { (e) }
                            }
                        }
                        select name="range" data-auto aria-label="Time range" {
                            @for r in &RANGES {
                                option value=(r.key) selected[r.key == ctx.range.key] { "Last " (r.label) }
                            }
                        }
                        select #refresh aria-label="Auto refresh" title="Auto refresh" {
                            option value="0" { "Live: off" }
                            option value="5" { "Live: 5s" }
                            option value="15" { "Live: 15s" }
                            option value="60" { "Live: 1m" }
                        }
                        noscript { button type="submit" { "Apply" } }
                    }
                }
                main #main { (body) }
                footer.foot {
                    "Rendered in " span #rt { (format!("{:.1}", ctx.started.elapsed().as_secs_f64() * 1000.0)) } " ms"
                    @if !ctx.org.is_empty() { " · " (ctx.org) " / " (ctx.repo) }
                    " · times in UTC"
                }
            }
        }
    }
}

/// Standalone page for when ClickHouse itself is the problem.
pub fn error_page(asset_version: &str, message: &str) -> Markup {
    let hint = if message.contains("UNKNOWN_TABLE") || message.contains("UNKNOWN_DATABASE") {
        Some(
            "The ingester creates the schema when it boots. Start it once against this ClickHouse (and check CLICKHOUSE_DATABASE matches).",
        )
    } else if message.contains("cannot reach") {
        Some(
            "Check CLICKHOUSE_URL, and that ClickHouse is running and reachable from the dashboard.",
        )
    } else if message.contains("AUTHENTICATION_FAILED") || message.contains("REQUIRED_PASSWORD") {
        Some("Check CLICKHOUSE_USER and CLICKHOUSE_PASSWORD — use the same values as the ingester.")
    } else {
        None
    };
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width,initial-scale=1";
                title { "ClickHouse error · Autter Runtime" }
                (head_assets(asset_version))
            }
            body {
                main.narrow {
                    div.card.err-card {
                        h1 { "Can't load data from ClickHouse" }
                        @if let Some(h) = hint { p { (h) } }
                        pre.code { (message) }
                        p { a href="" { "Retry" } }
                    }
                }
            }
        }
    }
}

pub fn not_found(asset_version: &str) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                title { "Not found · Autter Runtime" }
                (head_assets(asset_version))
            }
            body { main.narrow { div.card { h1 { "Not found" } p { a href="/" { "Back to overview" } } } } }
        }
    }
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    fmt::url_encode_into(&mut out, s);
    out
}

/// Favicon, theme colour, the stylesheet, and a preload for the body font
/// so first paint uses the brand face without a visible swap.
fn head_assets(v: &str) -> Markup {
    html! {
        link rel="icon" type="image/png" href={ "/s/favicon.png?v=" (v) };
        meta name="theme-color" content="#f6f3ef" media="(prefers-color-scheme: light)";
        meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)";
        link rel="preload" href="/s/qs-400.woff2" as="font" type="font/woff2" crossorigin;
        link rel="stylesheet" href={ "/s/app.css?v=" (v) };
    }
}

/// The Autter logo (otter + wordmark), light or dark to match the theme.
fn logo(v: &str) -> Markup {
    html! {
        picture.logo {
            source srcset={ "/s/logo-dark.png?v=" (v) } media="(prefers-color-scheme: dark)";
            img src={ "/s/logo-light.png?v=" (v) } alt="autter" width="97" height="28";
        }
    }
}

pub fn no_data() -> Markup {
    html! {
        div.card.empty-state {
            h2 { "No telemetry yet" }
            p { "ClickHouse is reachable and the schema exists, but no repository has sent anything in the last 14 days." }
            p {
                "Point an SDK or any OpenTelemetry exporter at the ingester ("
                code { "http://localhost:4318" } " with the local key " code { "autter_rt_local_dev_only" }
                " from the repo's compose file), then reload. New repositories show up within a minute."
            }
        }
    }
}

pub fn card(title: &str, right: Option<Markup>, body: Markup) -> Markup {
    html! {
        section.card {
            div.card-h {
                h2 { (title) }
                @if let Some(r) = right { div.card-r { (r) } }
            }
            (body)
        }
    }
}

pub fn kpi(label: &str, value: &str, sub: Option<&str>, tone: &str) -> Markup {
    html! {
        div class={ "kpi " (tone) } {
            div.kpi-l { (label) }
            div.kpi-v { (value) }
            @if let Some(s) = sub { div.kpi-s { (s) } }
        }
    }
}

/// Bar chart drawn by app.js on a canvas. Series overlay in order, so pass
/// the total first and its subset (e.g. errors) after.
pub fn chart(ctx: &Ctx, series: &[(&str, &[f64])], unit: &str) -> Markup {
    let mut data = String::with_capacity(series.len() * ctx.buckets() * 4);
    for (i, (label, values)) in series.iter().enumerate() {
        if i > 0 {
            data.push(';');
        }
        data.push_str(&label.replace(['|', ';'], " "));
        data.push('|');
        for (j, v) in values.iter().enumerate() {
            if j > 0 {
                data.push(',');
            }
            if *v != 0.0 {
                let _ = write!(data, "{}", (v * 1e6).round() / 1e6);
            }
        }
    }
    html! {
        div.chart {
            canvas data-start=(ctx.start) data-step=(ctx.range.step) data-u=(unit) data-s=(data) {}
        }
    }
}

/// Tiny inline-SVG trend line — no script needed for list sparklines.
pub fn spark(values: &[f64]) -> Markup {
    let max = values.iter().cloned().fold(0.0_f64, f64::max);
    if max <= 0.0 || values.len() < 2 {
        return html! { svg.spark viewBox="0 0 100 20" {} };
    }
    let step = 100.0 / (values.len() - 1) as f64;
    let mut pts = String::with_capacity(values.len() * 10);
    for (i, v) in values.iter().enumerate() {
        let _ = write!(pts, "{:.1},{:.1} ", i as f64 * step, 19.0 - v / max * 17.0);
    }
    let area = format!("0,20 {pts}100,20");
    html! {
        svg.spark viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true" {
            polygon points=(area) {}
            polyline points=(pts.trim_end()) {}
        }
    }
}

pub fn sev(severity: &str) -> Markup {
    let class = match severity {
        "fatal" => "sev fatal",
        "error" => "sev error",
        "warning" | "warn" => "sev warning",
        "debug" => "sev debug",
        _ => "sev info",
    };
    html! { span class=(class) { (severity) } }
}

/// Relative time with the exact UTC timestamp on hover.
pub fn when(ts_ms: i64, now_ms: i64) -> Markup {
    html! { time title=(fmt::utc(ts_ms)) { (fmt::ago(ts_ms, now_ms)) } }
}

pub fn empty(msg: &str) -> Markup {
    html! { div.empty { (msg) } }
}

/// Segmented filter control (links, so it works without script).
pub fn seg(
    ctx: &Ctx,
    path: &str,
    key: &str,
    current: &str,
    opts: &[(&str, &str)],
    keep: &[(&str, &str)],
) -> Markup {
    html! {
        div.seg {
            @for (val, label) in opts {
                @let extra: Vec<(&str, &str)> = keep.iter().filter(|(k, _)| *k != key).cloned().chain([(key, *val)]).collect();
                a.on[*val == current] href=(ctx.href(path, &extra)) { (label) }
            }
        }
    }
}
