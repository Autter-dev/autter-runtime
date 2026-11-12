use std::collections::HashMap;

use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, P, opt, scope};
use crate::fmt;
use crate::layout::{card, empty, seg, sev};

pub fn keep(p: &P) -> Vec<(&'static str, String)> {
    [
        ("errors", opt(&p.errors)),
        ("min", opt(&p.min)),
        ("q", opt(&p.q)),
    ]
    .into_iter()
    .filter(|(_, v)| !v.is_empty())
    .map(|(k, v)| (k, v.to_string()))
    .collect()
}

pub async fn list(app: &App, ctx: &Ctx, p: &P) -> Result<Markup, ChError> {
    let errors_only = opt(&p.errors) == "1";
    let min_ms: u32 = opt(&p.min).parse().unwrap_or(0);
    let q = opt(&p.q);
    let (e_s, m_s) = (if errors_only { "1" } else { "0" }, min_ms.to_string());
    let mut params = ctx.params();
    params.extend([("err", e_s), ("min", m_s.as_str()), ("q", q)]);

    let w = scope("started_at");
    // Two stages so memory stays flat however many traces the window holds:
    // a top-N sort picks the newest 1000 matching spans (a bounded heap, not
    // a GROUP BY over every trace), then only the ≤100 traces they belong to
    // are aggregated, via trace_id — a primary-key lookup. Grouping the whole
    // window instead needed >1 GB of ClickHouse memory on 7 days × 10M spans.
    let traces_sql = format!(
        "SELECT trace_id, toUnixTimestamp64Milli(min(started_at)) AS t,
                argMin(name, started_at), argMin(service, started_at), max(duration_ms),
                count(), countIf(status = 'error'), argMin(route, started_at), max(status_code)
         FROM runtime_spans
         WHERE org_id = {{o:String}} AND repository_id = {{r:String}} AND trace_id IN (
             SELECT trace_id FROM (
                 SELECT trace_id, started_at FROM runtime_spans
                 WHERE {w}
                   AND ({{err:UInt8}} = 0 OR status = 'error')
                   AND duration_ms >= {{min:UInt32}}
                   AND ({{q:String}} = '' OR trace_id = {{q:String}}
                        OR positionCaseInsensitiveUTF8(name, {{q:String}}) > 0
                        OR positionCaseInsensitiveUTF8(route, {{q:String}}) > 0)
                 ORDER BY started_at DESC LIMIT 1000)
             GROUP BY trace_id ORDER BY max(started_at) DESC LIMIT 100)
         GROUP BY trace_id ORDER BY t DESC LIMIT 100"
    );
    // Counts and percentiles from random samples only: spans the SDK kept
    // because their trace was slow or failed (`autter.retention_reason`
    // slow / error, or `autter.tail_retained`) would skew them.
    let ops_sql = format!(
        "SELECT name, service, count() AS n, quantileTDigest(0.5)(duration_ms), quantileTDigest(0.95)(duration_ms),
                countIf(status = 'error')
         FROM runtime_spans WHERE {w} AND kind IN ('server', 'consumer', 'internal')
           AND JSONExtractString(attributes, 'autter.retention_reason') NOT IN ('slow', 'error')
           AND NOT JSONExtractBool(attributes, 'autter.tail_retained')
         GROUP BY name, service ORDER BY n DESC LIMIT 15"
    );
    let (traces, ops) = tokio::try_join!(
        app.ch.query(&traces_sql, &params),
        app.ch.query(&ops_sql, &params),
    )?;

    let k = keep(p);
    let keep_all: Vec<(&str, &str)> = k.iter().map(|(a, b)| (*a, b.as_str())).collect();
    Ok(html! {
        div.bar {
            (seg(ctx, "/traces", "errors", opt(&p.errors), &[("", "All traces"), ("1", "With errors")], &keep_all))
            (seg(ctx, "/traces", "min", opt(&p.min), &[("", "Any duration"), ("100", "≥ 100 ms"), ("500", "≥ 500 ms"), ("1000", "≥ 1 s"), ("5000", "≥ 5 s")], &keep_all))
            form.search method="get" action="/traces" {
                @for (k, v) in &keep_all { @if *k != "q" { input type="hidden" name=(k) value=(v); } }
                @for (k, v) in [("org", ctx.org.as_str()), ("repo", ctx.repo.as_str()), ("range", ctx.range.key), ("service", ctx.service.as_str()), ("env", ctx.env.as_str())] {
                    @if !v.is_empty() { input type="hidden" name=(k) value=(v); }
                }
                input type="search" name="q" value=(q) placeholder="Span name, route, or trace id";
            }
        }
        div.grid-main {
            (card("Recent traces", Some(html! { span.dim { "newest 100 · traces are head-sampled upstream; error and slow traces are kept in full" } }), html! {
                @if traces.is_empty() { (empty("No spans match in this window.")) } @else {
                    table.t {
                        thead { tr { th { "Started" } th { "Root span" } th { "Service" } th.n { "Spans" } th.n { "Duration" } th.n { "Status" } } }
                        tbody {
                            @for r in traces.iter() {
                                @let errs = r.u(6);
                                tr.link {
                                    td.mono.dim.nw { a href=(ctx.href(&format!("/traces/{}", r.s(0)), &[])) { (fmt::clock(r.i(1))) } }
                                    td.clip.wide {
                                        a href=(ctx.href(&format!("/traces/{}", r.s(0)), &[])) { b { (r.s(2)) } }
                                        @if !r.s(7).is_empty() && !r.s(2).ends_with(r.s(7).as_ref()) { " " span.dim.mono { (r.s(7)) } }
                                    }
                                    td.dim { (r.s(3)) }
                                    td.n { (r.u(5)) }
                                    td.n { (fmt::ms(r.f(4))) }
                                    td.n {
                                        @if errs > 0 { span.sev.error { (errs) " err" } }
                                        @else if r.u(8) > 0 { span.dim { (r.u(8)) } }
                                        @else { span.dim { "ok" } }
                                    }
                                }
                            }
                        }
                    }
                }
            }))
            (card("Operations", Some(html! { span.dim { "by span count · random samples only" } }), html! {
                @if ops.is_empty() { (empty("No spans.")) } @else {
                    table.t {
                        thead { tr { th { "Span" } th.n { "Count" } th.n { "p50" } th.n { "p95" } } }
                        tbody {
                            @for r in ops.iter() {
                                tr {
                                    td.clip title=(r.s(1)) {
                                        a href=(ctx.href("/traces", &[("q", &r.s(0))])) { (r.s(0)) }
                                        @if r.u(5) > 0 { " " span.sev.error { (fmt::compact(r.u(5))) } }
                                    }
                                    td.n { (fmt::compact(r.u(2))) }
                                    td.n.dim { (fmt::ms(r.f(3))) }
                                    td.n { (fmt::ms(r.f(4))) }
                                }
                            }
                        }
                    }
                }
            }))
        }
    })
}

struct Span {
    id: String,
    parent: String,
    name: String,
    service: String,
    kind: String,
    status: String,
    route: String,
    code: u64,
    dur: f64,
    start: i64,
    attrs: String,
}

pub async fn detail(app: &App, ctx: &Ctx, trace_id: &str) -> Result<Markup, ChError> {
    let base = [
        ("o", ctx.org.as_str()),
        ("r", ctx.repo.as_str()),
        ("t", trace_id),
    ];
    // trace_id is the third ORDER BY column of runtime_spans: point lookup.
    let spans = app
        .ch
        .query(
            "SELECT span_id, parent_span_id, name, service, kind, status, route, status_code,
                    duration_ms, toUnixTimestamp64Milli(started_at), substring(attributes, 1, 4000)
             FROM runtime_spans
             WHERE org_id = {o:String} AND repository_id = {r:String} AND trace_id = {t:String}
             ORDER BY started_at LIMIT 1 BY span_id LIMIT 3000",
            &base,
        )
        .await?;
    let spans: Vec<Span> = spans
        .iter()
        .map(|r| Span {
            id: r.s(0).into_owned(),
            parent: r.s(1).into_owned(),
            name: r.s(2).into_owned(),
            service: r.s(3).into_owned(),
            kind: r.s(4).into_owned(),
            status: r.s(5).into_owned(),
            route: r.s(6).into_owned(),
            code: r.u(7),
            dur: r.f(8),
            start: r.i(9),
            attrs: r.s(10).into_owned(),
        })
        .collect();

    // Errors and logs aren't keyed by trace, so bound them by the trace's
    // own time span (±10 min) to keep them partition- and range-pruned.
    let (t0, t1) = spans.iter().fold((i64::MAX, i64::MIN), |(a, b), s| {
        (a.min(s.start), b.max(s.start + s.dur as i64))
    });
    let (lo, hi) = if spans.is_empty() {
        (ctx.now_ms - 14 * 86_400_000, ctx.now_ms)
    } else {
        (t0 - 600_000, t1 + 600_000)
    };
    let (lo_s, hi_s) = (lo.to_string(), hi.to_string());
    let p = [
        ("o", ctx.org.as_str()),
        ("r", ctx.repo.as_str()),
        ("t", trace_id),
        ("lo", &lo_s),
        ("hi", &hi_s),
    ];
    let (errs, logs) = tokio::try_join!(
        app.ch.query(
            "SELECT fingerprint, severity, error_type, message, toUnixTimestamp64Milli(occurred_at)
             FROM runtime_error_occurrences
             WHERE org_id = {o:String} AND repository_id = {r:String} AND trace_id = {t:String}
               AND occurred_at >= fromUnixTimestamp64Milli({lo:Int64}) AND occurred_at <= fromUnixTimestamp64Milli({hi:Int64})
             ORDER BY occurred_at LIMIT 1 BY occurrence_id LIMIT 100",
            &p,
        ),
        app.ch.query(
            "SELECT toUnixTimestamp64Milli(occurred_at), severity, service, event_type, operation, message, span_id
             FROM runtime_logs
             WHERE org_id = {o:String} AND repository_id = {r:String} AND trace_id = {t:String}
               AND occurred_at >= fromUnixTimestamp64Milli({lo:Int64}) AND occurred_at <= fromUnixTimestamp64Milli({hi:Int64})
             ORDER BY occurred_at LIMIT 1 BY event_id LIMIT 300",
            &p,
        ),
    )?;

    if spans.is_empty() && errs.is_empty() && logs.is_empty() {
        return Ok(html! {
            p.crumb { a href=(ctx.href("/traces", &[])) { "← Traces" } }
            (empty("No spans, errors or logs for this trace. Healthy traces are sampled upstream, and spans age out after 7 days."))
        });
    }

    let ordered = tree_order(&spans);
    let total = (t1 - t0).max(1) as f64;
    let services: std::collections::BTreeSet<&str> =
        spans.iter().map(|s| s.service.as_str()).collect();
    let err_spans = spans.iter().filter(|s| s.status == "error").count();

    Ok(html! {
        p.crumb { a href=(ctx.href("/traces", &[])) { "← Traces" } }
        div.card.issue-h {
            h1.mono { "Trace " (trace_id) }
            div.facts {
                @if !spans.is_empty() {
                    div { span.dim { "Started" } b.mono { (fmt::utc(t0)) } }
                    div { span.dim { "Duration" } b { (fmt::ms(total)) } }
                }
                div { span.dim { "Spans" } b { (spans.len()) } }
                div { span.dim { "Errors" } b.bad[err_spans + errs.iter().count() > 0] { (err_spans) " spans · " (errs.iter().count()) " occurrences" } }
                div { span.dim { "Services" } b { (services.into_iter().collect::<Vec<_>>().join(", ")) } }
            }
        }
        @if !errs.is_empty() {
            (card("Errors in this trace", None, html! {
                table.t { tbody {
                    @for r in errs.iter() {
                        tr.link {
                            td.mono.dim.nw { (fmt::clock(r.i(4))) }
                            td.clip.wide { (sev(&r.s(1))) " " a href=(ctx.href(&format!("/errors/{}", r.s(0)), &[])) { b { (r.s(2)) } " " span.dim { (r.s(3)) } } }
                        }
                    }
                } }
            }))
        }
        @if !spans.is_empty() {
            (card("Waterfall", None, html! {
                div.wf {
                    @for (i, depth) in &ordered {
                        @let s = &spans[*i];
                        @let left = (s.start - t0) as f64 / total * 100.0;
                        @let width = (s.dur / total * 100.0).max(0.3);
                        @let attrs = fmt::pretty_json(&s.attrs);
                        details.wf-row.err[s.status == "error"] {
                            summary {
                                span.wf-name style={ "padding-left:" (depth * 14) "px" } {
                                    span.k { (s.kind.chars().next().unwrap_or('·')) } " "
                                    (s.name)
                                    span.dim { " " (s.service) }
                                }
                                span.wf-track {
                                    span.wf-bar style={ "left:" (format!("{left:.3}")) "%;width:" (format!("{:.3}", width.min(100.0 - left).max(0.3))) "%" } {}
                                }
                                span.wf-d { (fmt::ms(s.dur)) }
                            }
                            div.ev-b {
                                div.facts.tight {
                                    div { span.dim { "Span" } b.mono { (s.id) } }
                                    div { span.dim { "Kind" } b { (s.kind) } }
                                    div { span.dim { "Status" } b { (s.status) @if s.code > 0 { " · " (s.code) } } }
                                    @if !s.route.is_empty() { div { span.dim { "Route" } b.mono { (s.route) } } }
                                    div { span.dim { "Offset" } b { "+" (fmt::ms((s.start - t0) as f64)) } }
                                }
                                @if !attrs.is_empty() { pre.code { (attrs) } }
                            }
                        }
                    }
                }
            }))
        }
        @if !logs.is_empty() {
            (card("Logs in this trace", None, html! {
                div.log.flat {
                    @for r in logs.iter() {
                        div.ev-line {
                            span.ts.mono { (fmt::clock(r.i(0))) }
                            (sev(&r.s(1)))
                            span.svc { (r.s(2)) }
                            @if r.s(3) == "operation" { span.op.mono { (r.s(4)) } }
                            span.m { (r.s(5)) }
                        }
                    }
                }
            }))
        }
    })
}

/// Depth-first order of spans by parent link, children by start time.
/// Orphans (parent not in this trace) are treated as roots.
fn tree_order(spans: &[Span]) -> Vec<(usize, usize)> {
    let index: HashMap<&str, usize> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (i, s) in spans.iter().enumerate() {
        match index.get(s.parent.as_str()) {
            Some(&p) if !s.parent.is_empty() && p != i => children.entry(p).or_default().push(i),
            _ => roots.push(i),
        }
    }
    let mut out = Vec::with_capacity(spans.len());
    let mut stack: Vec<(usize, usize)> = roots.into_iter().rev().map(|i| (i, 0)).collect();
    let mut visited = vec![false; spans.len()];
    while let Some((i, d)) = stack.pop() {
        if std::mem::replace(&mut visited[i], true) {
            continue;
        }
        out.push((i, d.min(20)));
        if let Some(kids) = children.get(&i) {
            for &k in kids.iter().rev() {
                stack.push((k, d + 1));
            }
        }
    }
    // Spans in a parent cycle never reached from a root: append flat.
    for (i, v) in visited.iter().enumerate() {
        if !v {
            out.push((i, 0));
        }
    }
    out
}
