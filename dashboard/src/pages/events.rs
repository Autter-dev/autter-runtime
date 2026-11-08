use std::collections::HashMap;

use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, P, bucket, dense, opt, scope};
use crate::fmt;
use crate::layout::{card, chart, empty, seg, sev};

const PAGE: usize = 100;

fn filters(p: &P) -> [(&'static str, String); 3] {
    [
        ("sev", opt(&p.sev).to_string()),
        ("kind", opt(&p.kind).to_string()),
        ("q", opt(&p.q).to_string()),
    ]
}

pub fn keep(p: &P) -> Vec<(&'static str, String)> {
    filters(p)
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

const FILTER_SQL: &str = "({sev:String} = '' OR severity = {sev:String})
    AND ({kind:String} = '' OR event_type = {kind:String})
    AND ({q:String} = '' OR positionCaseInsensitiveUTF8(message, {q:String}) > 0
         OR positionCaseInsensitiveUTF8(operation, {q:String}) > 0
         OR trace_id = {q:String} OR operation_id = {q:String})";

pub async fn render(app: &App, ctx: &Ctx, p: &P) -> Result<Markup, ChError> {
    let f = filters(p);
    let before: i64 = opt(&p.before).parse().unwrap_or(0);
    let before_s = before.to_string();
    let mut params = ctx.params();
    params.extend(f.iter().map(|(k, v)| (*k, v.as_str())));
    params.push(("before", &before_s));

    let w = scope("occurred_at");
    // runtime_logs is ordered by (org, repo, occurred_at, event_id). Sorting
    // by the exact reverse of that key lets ClickHouse read in index order
    // and stop after the newest granules (~10x fewer rows than a mixed
    // ASC/DESC sort, which forces a full read of the window).
    let list_sql = format!(
        "SELECT event_id, toUnixTimestamp64Milli(occurred_at), service, environment, event_type,
                severity, operation, message, outcome, duration_ms, trace_id,
                substring(attributes, 1, 4000)
         FROM runtime_logs
         WHERE {w} AND {FILTER_SQL}
           AND ({{before:Int64}} = 0 OR occurred_at < fromUnixTimestamp64Milli({{before:Int64}}))
         ORDER BY occurred_at DESC, event_id DESC LIMIT {limit}",
        limit = PAGE + 20
    );
    let series_sql = format!(
        "SELECT {b} AS b, count(), countIf(severity IN ('error', 'fatal'))
         FROM runtime_logs WHERE {w} AND {FILTER_SQL} GROUP BY b ORDER BY b",
        b = bucket("occurred_at")
    );
    let sev_sql = format!("SELECT severity, count() FROM runtime_logs WHERE {w} GROUP BY severity");
    let custom_sql = format!(
        "SELECT substring(route, 7) AS name, sum(request_count) AS n, any(service)
         FROM runtime_metrics_1m WHERE {w} AND startsWith(route, 'event:')
         GROUP BY name ORDER BY n DESC LIMIT 40",
        w = scope("bucket_at")
    );

    let (rows, series, sevs, custom) = tokio::try_join!(
        app.ch.query(&list_sql, &params),
        app.ch.query(&series_sql, &params),
        app.ch.query(&sev_sql, &params),
        app.ch.query(&custom_sql, &params),
    )?;

    // ReplacingMergeTree may still hold not-yet-merged duplicates; they sort
    // adjacent (same time, same id), so a single pass drops them.
    let mut seen_last = String::new();
    let mut events = Vec::with_capacity(PAGE);
    for r in rows.iter() {
        let id = r.s(0);
        if id == seen_last {
            continue;
        }
        seen_last = id.into_owned();
        events.push(r);
        if events.len() == PAGE {
            break;
        }
    }
    let next_before = if events.len() == PAGE {
        events.last().map(|r| r.i(1))
    } else {
        None
    };

    let series = dense(&series, ctx.buckets(), 2);
    let sev_counts: HashMap<String, u64> =
        sevs.iter().map(|r| (r.s(0).into_owned(), r.u(1))).collect();
    let total: u64 = sev_counts.values().sum();
    let sev_opts: Vec<(String, String)> = [
        ("", "All"),
        ("fatal", "Fatal"),
        ("error", "Error"),
        ("warning", "Warning"),
        ("info", "Info"),
        ("debug", "Debug"),
    ]
    .iter()
    .filter(|(k, _)| k.is_empty() || sev_counts.contains_key(*k) || *k == f[0].1)
    .map(|(k, label)| {
        let c = if k.is_empty() {
            total
        } else {
            *sev_counts.get(*k).unwrap_or(&0)
        };
        (k.to_string(), format!("{label} {}", fmt::compact(c)))
    })
    .collect();
    let sev_ref: Vec<(&str, &str)> = sev_opts
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let keep_all: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();

    Ok(html! {
        div.bar {
            (seg(ctx, "/events", "sev", &f[0].1, &sev_ref, &keep_all))
            (seg(ctx, "/events", "kind", &f[1].1, &[("", "Logs + operations"), ("log", "Logs"), ("operation", "Operations")], &keep_all))
            form.search method="get" action="/events" {
                @for (k, v) in &keep_all { @if *k != "q" && !v.is_empty() { input type="hidden" name=(k) value=(v); } }
                @for (k, v) in [("org", ctx.org.as_str()), ("repo", ctx.repo.as_str()), ("range", ctx.range.key), ("service", ctx.service.as_str()), ("env", ctx.env.as_str())] {
                    @if !v.is_empty() { input type="hidden" name=(k) value=(v); }
                }
                input type="search" name="q" value=(f[2].1) placeholder="Search message or operation, or paste a trace id";
            }
        }
        div.grid-main {
            div {
                (card("Volume", None, chart(ctx, &[("Events", &series[0]), ("Errors", &series[1])], "")))
                (card("Events", Some(html! {
                    @if before > 0 { a href=(ctx.href("/events", &keep_all)) { "↑ Newest" } }
                }), html! {
                    @if events.is_empty() { (empty("No log events in this window. Logs arrive via OTLP /v1/logs or the SDK's operation logging.")) } @else {
                        div.log {
                            @for r in &events {
                                @let attrs = fmt::pretty_json(&r.s(11));
                                @let trace = r.s(10);
                                details.ev {
                                    summary {
                                        span.ts.mono title=(fmt::utc(r.i(1))) { (fmt::clock(r.i(1))) }
                                        (sev(&r.s(5)))
                                        span.svc { (r.s(2)) }
                                        @if r.s(4) == "operation" {
                                            span.op.mono { (r.s(6)) }
                                            @if !r.s(8).is_empty() { span class={ "tag out-" (r.s(8)) } { (r.s(8)) } }
                                            @if r.f(9) > 0.0 { span.dim { (fmt::ms(r.f(9))) } }
                                        }
                                        span.m { (r.s(7)) }
                                    }
                                    div.ev-b {
                                        div.facts.tight {
                                            div { span.dim { "Time" } b.mono { (fmt::utc(r.i(1))) } }
                                            div { span.dim { "Env" } b { (r.s(3)) } }
                                            div { span.dim { "Type" } b { (r.s(4)) } }
                                            @if !trace.is_empty() { div { span.dim { "Trace" } a.mono href=(ctx.href(&format!("/traces/{trace}"), &[])) { (fmt::short(&trace, 16)) } } }
                                        }
                                        @if !r.s(7).is_empty() { pre.code { (r.s(7)) } }
                                        @if !attrs.is_empty() { pre.code { (attrs) } }
                                    }
                                }
                            }
                        }
                        @if let Some(nb) = next_before {
                            @let nbs = nb.to_string();
                            @let extra: Vec<(&str, &str)> = keep_all.iter().cloned().chain([("before", nbs.as_str())]).collect();
                            p.more { a href=(ctx.href("/events", &extra)) { "Older →" } }
                        }
                    }
                }))
            }
            (card("Custom events", Some(html! { span.dim { "trackEvent()" } }), html! {
                @if custom.is_empty() { (empty("No trackEvent() calls in this window.")) } @else {
                    table.t {
                        thead { tr { th { "Event" } th.n { "Count" } } }
                        tbody {
                            @for r in custom.iter() {
                                tr { td.mono.clip title=(r.s(2)) { (r.s(0)) } td.n { (fmt::compact(r.u(1))) } }
                            }
                        }
                    }
                }
            }))
        }
    })
}
