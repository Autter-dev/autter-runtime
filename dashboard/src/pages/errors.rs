use std::collections::HashMap;

use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, P, bucket, dense, opt, scope};
use crate::fmt;
use crate::layout::{card, chart, empty, seg, sev, spark, when};

const SPARK_BUCKETS: u32 = 24;

pub const SEVERITIES: [(&str, &str); 5] = [
    ("", "All"),
    ("fatal", "Fatal"),
    ("error", "Error"),
    ("warning", "Warning"),
    ("info", "Info"),
];

fn filters(p: &P) -> [(&'static str, String); 4] {
    [
        ("sev", opt(&p.sev).to_string()),
        ("src", opt(&p.src).to_string()),
        ("q", opt(&p.q).to_string()),
        ("sort", opt(&p.sort).to_string()),
    ]
}

pub fn keep(p: &P) -> Vec<(&'static str, String)> {
    filters(p)
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

const FILTER_SQL: &str = "({sev:String} = '' OR severity = {sev:String})
    AND ({src:String} = '' OR source = {src:String})
    AND ({q:String} = '' OR positionCaseInsensitiveUTF8(message, {q:String}) > 0
         OR positionCaseInsensitiveUTF8(error_type, {q:String}) > 0
         OR positionCaseInsensitiveUTF8(route_normalized, {q:String}) > 0
         OR fingerprint = {q:String})";

pub async fn list(app: &App, ctx: &Ctx, p: &P) -> Result<Markup, ChError> {
    let f = filters(p);
    let (sev_f, src_f, q, sort) = (&f[0].1, &f[1].1, &f[2].1, &f[3].1);
    let mut params = ctx.params();
    params.extend(f.iter().map(|(k, v)| (*k, v.as_str())));
    let sst = (ctx.range.secs / SPARK_BUCKETS).to_string();
    params.push(("sst", &sst));

    let order = if sort == "recent" {
        "last DESC"
    } else {
        "c DESC"
    };
    let w = scope("occurred_at");
    let list_sql = format!(
        "SELECT fingerprint, any(severity), any(source), any(error_type), any(message_normalized),
                any(service), any(route_normalized), (uniq(occurrence_id) + sum(collapsed_count)) AS c, uniqIf(session_id, session_id != ''),
                toUnixTimestamp64Milli(min(occurred_at)), toUnixTimestamp64Milli(max(occurred_at)) AS last
         FROM runtime_error_occurrences WHERE {w} AND {FILTER_SQL}
         GROUP BY fingerprint ORDER BY {order} LIMIT 100"
    );
    // Sparklines for the same top-100, computed in one grouped pass.
    let spark_sql = format!(
        "SELECT fingerprint, intDiv(toUnixTimestamp(occurred_at) - {{s:UInt32}}, {{sst:UInt32}}) AS b, (uniq(occurrence_id) + sum(collapsed_count))
         FROM runtime_error_occurrences WHERE {w} AND {FILTER_SQL}
           AND fingerprint IN (
             SELECT fingerprint FROM runtime_error_occurrences WHERE {w} AND {FILTER_SQL}
             GROUP BY fingerprint ORDER BY {o} LIMIT 100)
         GROUP BY fingerprint, b",
        o = if sort == "recent" { "max(occurred_at) DESC" } else { "(uniq(occurrence_id) + sum(collapsed_count)) DESC" }
    );
    let series_sql = format!(
        "SELECT {b} AS b, (uniq(occurrence_id) + sum(collapsed_count)) FROM runtime_error_occurrences
         WHERE {w} AND {FILTER_SQL} GROUP BY b ORDER BY b",
        b = bucket("occurred_at")
    );
    let sev_sql = format!(
        "SELECT severity, (uniq(occurrence_id) + sum(collapsed_count)) FROM runtime_error_occurrences WHERE {w} GROUP BY severity"
    );

    let (rows, sparks, series, sevs) = tokio::try_join!(
        app.ch.query(&list_sql, &params),
        app.ch.query(&spark_sql, &params),
        app.ch.query(&series_sql, &params),
        app.ch.query(&sev_sql, &params),
    )?;

    let mut spark_map: HashMap<String, Vec<f64>> = HashMap::new();
    for r in sparks.iter() {
        let b = r.i(1);
        if (0..SPARK_BUCKETS as i64).contains(&b) {
            spark_map
                .entry(r.s(0).into_owned())
                .or_insert_with(|| vec![0.0; SPARK_BUCKETS as usize])[b as usize] = r.f(2);
        }
    }
    let sev_counts: HashMap<String, u64> =
        sevs.iter().map(|r| (r.s(0).into_owned(), r.u(1))).collect();
    let total: u64 = sev_counts.values().sum();
    let series = dense(&series, ctx.buckets(), 1);

    let keep_all: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let sev_opts: Vec<(String, String)> = SEVERITIES
        .iter()
        .map(|(k, label)| {
            let c = if k.is_empty() {
                total
            } else {
                *sev_counts.get(*k).unwrap_or(&0)
            };
            (k.to_string(), format!("{label} {}", fmt::compact(c)))
        })
        .collect();
    let sev_opts_ref: Vec<(&str, &str)> = sev_opts
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();

    Ok(html! {
        div.bar {
            (seg(ctx, "/errors", "sev", sev_f, &sev_opts_ref, &keep_all))
            (seg(ctx, "/errors", "src", src_f, &[("", "All sources"), ("server", "Server"), ("browser", "Browser")], &keep_all))
            (seg(ctx, "/errors", "sort", sort, &[("", "Most frequent"), ("recent", "Most recent")], &keep_all))
            form.search method="get" action="/errors" {
                @for (k, v) in &keep_all { @if *k != "q" && !v.is_empty() { input type="hidden" name=(k) value=(v); } }
                @for (k, v) in [("org", ctx.org.as_str()), ("repo", ctx.repo.as_str()), ("range", ctx.range.key), ("service", ctx.service.as_str()), ("env", ctx.env.as_str())] {
                    @if !v.is_empty() { input type="hidden" name=(k) value=(v); }
                }
                input type="search" name="q" value=(q) placeholder="Search message, type, route or fingerprint";
            }
        }
        (card("Occurrences", None, chart(ctx, &[("Occurrences", &series[0])], "")))
        (card("Issues", Some(html! { span.dim { "grouped by fingerprint · top 100" } }), html! {
            @if rows.is_empty() { (empty("No matching errors in this window.")) } @else {
                table.t {
                    thead { tr {
                        th { "Issue" } th { "Where" } th.n { "Trend" } th.n { "Events" } th.n { "Sessions" } th.n { "First seen" } th.n { "Last seen" }
                    } }
                    tbody {
                        @for r in rows.iter() {
                            @let fp = r.s(0);
                            tr.link {
                                td.clip.wide {
                                    (sev(&r.s(1))) " "
                                    a href=(ctx.href(&format!("/errors/{fp}"), &[])) {
                                        b { (r.s(3)) } " " span.dim { (r.s(4)) }
                                    }
                                }
                                td.dim.clip {
                                    span.tag { (r.s(2)) } " " (r.s(5))
                                    @if !r.s(6).is_empty() { " · " span.mono { (r.s(6)) } }
                                }
                                td.n { (spark(spark_map.get(fp.as_ref()).map(Vec::as_slice).unwrap_or(&[]))) }
                                td.n { b { (fmt::compact(r.u(7))) } }
                                td.n.dim { (fmt::compact(r.u(8))) }
                                td.n.dim { (when(r.i(9), ctx.now_ms)) }
                                td.n.dim { (when(r.i(10), ctx.now_ms)) }
                            }
                        }
                    }
                }
            }
        }))
    })
}

pub async fn detail(app: &App, ctx: &Ctx, fingerprint: &str, p: &P) -> Result<Markup, ChError> {
    let occ = opt(&p.occ);
    let mut params = ctx.params();
    params.push(("fp", fingerprint));
    params.push(("occ", occ));

    const KEY: &str =
        "org_id = {o:String} AND repository_id = {r:String} AND fingerprint = {fp:String}";
    // Fingerprint is the third ORDER BY column: every query here is a
    // narrow primary-key range, independent of the selected window.
    let summary_sql = format!(
        "SELECT any(severity), any(source), any(error_type), any(message_normalized),
                (uniq(occurrence_id) + sum(collapsed_count)), uniqIf(session_id, session_id != ''),
                toUnixTimestamp64Milli(min(occurred_at)), toUnixTimestamp64Milli(max(occurred_at)),
                arrayStringConcat(groupUniqArray(8)(service), '\\n'),
                arrayStringConcat(groupUniqArray(8)(release), '\\n'),
                arrayStringConcat(groupUniqArray(8)(route_normalized), '\\n'),
                arrayStringConcat(groupUniqArray(8)(environment), '\\n')
         FROM runtime_error_occurrences WHERE {KEY}"
    );
    let latest_sql = format!(
        "SELECT occurrence_id, message, stack, arrayStringConcat(top_frames, '\\n'), route, method,
                status_code, trace_id, session_id, release, environment, service, attributes,
                toUnixTimestamp64Milli(occurred_at)
         FROM runtime_error_occurrences
         WHERE {KEY} AND ({{occ:String}} = '' OR occurrence_id = {{occ:String}})
         ORDER BY occurred_at DESC LIMIT 1"
    );
    let recent_sql = format!(
        "SELECT occurrence_id, toUnixTimestamp64Milli(occurred_at), service, release, environment,
                route, status_code, trace_id, session_id
         FROM runtime_error_occurrences WHERE {KEY}
         ORDER BY occurred_at DESC LIMIT 1 BY occurrence_id LIMIT 30"
    );
    let series_sql = format!(
        "SELECT {b} AS b, (uniq(occurrence_id) + sum(collapsed_count)) FROM runtime_error_occurrences
         WHERE {KEY} AND occurred_at >= toDateTime({{s:UInt32}}) AND occurred_at < toDateTime({{e:UInt32}})
         GROUP BY b ORDER BY b",
        b = bucket("occurred_at")
    );

    let (summary, latest, recent, series) = tokio::try_join!(
        app.ch.query(&summary_sql, &params),
        app.ch.query(&latest_sql, &params),
        app.ch.query(&recent_sql, &params),
        app.ch.query(&series_sql, &params),
    )?;

    let Some(s) = summary.first().filter(|s| s.u(4) > 0) else {
        return Ok(html! {
            p { a href=(ctx.href("/errors", &[])) { "← Errors" } }
            (empty("This issue has no occurrences left — it may have aged out of retention."))
        });
    };
    let series = dense(&series, ctx.buckets(), 1);
    let lines = |i: usize| -> Vec<String> {
        s.s(i)
            .split('\n')
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect()
    };

    Ok(html! {
        p.crumb { a href=(ctx.href("/errors", &[])) { "← Errors" } }
        div.card.issue-h {
            div { (sev(&s.s(0))) " " span.tag { (s.s(1)) } }
            h1 { (s.s(2)) }
            p.msg { (s.s(3)) }
            div.facts {
                div { span.dim { "Events" } b { (fmt::compact(s.u(4))) } }
                div { span.dim { "Sessions" } b { (fmt::compact(s.u(5))) } }
                div { span.dim { "First seen" } b { (when(s.i(6), ctx.now_ms)) } }
                div { span.dim { "Last seen" } b { (when(s.i(7), ctx.now_ms)) } }
                div { span.dim { "Services" } b { (lines(8).join(", ")) } }
                div { span.dim { "Environments" } b { (lines(11).join(", ")) } }
            }
            @let routes = lines(10);
            @if !routes.is_empty() { div.chips { span.dim { "Routes " } @for r in &routes { span.chip.mono { (r) } } } }
            @let releases = lines(9);
            @if !releases.is_empty() { div.chips { span.dim { "Releases " } @for r in &releases { span.chip.mono { (r) } } } }
            div.dim.mono.small { "fingerprint " (fingerprint) }
        }
        (card("Occurrences in window", None, chart(ctx, &[("Occurrences", &series[0])], "")))
        @if let Some(o) = latest.first() {
            @let picked = !occ.is_empty();
            (card(if picked { "Selected occurrence" } else { "Latest occurrence" }, Some(html! { (when(o.i(13), ctx.now_ms)) " · " span.mono { (fmt::utc(o.i(13))) } }), html! {
                div.facts.tight {
                    @for (label, val) in [("Service", o.s(11)), ("Release", o.s(9)), ("Env", o.s(10)), ("Method", o.s(5)), ("Route", o.s(4))] {
                        @if !val.is_empty() { div { span.dim { (label) } b.mono { (val) } } }
                    }
                    @if o.u(6) > 0 { div { span.dim { "Status" } b { (o.u(6)) } } }
                    @if !o.s(7).is_empty() { div { span.dim { "Trace" } a.mono href=(ctx.href(&format!("/traces/{}", o.s(7)), &[])) { (fmt::short(&o.s(7), 16)) } } }
                }
                @if !o.s(1).is_empty() { pre.code.msg-full { (o.s(1)) } }
                @if !o.s(2).is_empty() {
                    h3 { "Stack trace" }
                    pre.code.stack { (o.s(2)) }
                } @else if !o.s(3).is_empty() {
                    h3 { "Top frames" }
                    pre.code.stack { (o.s(3)) }
                }
                @let attrs = fmt::pretty_json(&o.s(12));
                @if !attrs.is_empty() {
                    details { summary { "Attributes" } pre.code { (attrs) } }
                }
            }))
        }
        (card("Recent occurrences", Some(html! { span.dim { "newest 30, all time" } }), html! {
            table.t {
                thead { tr { th { "When" } th { "Service" } th { "Release" } th { "Env" } th { "Route" } th.n { "Status" } th { "Trace" } th { "Session" } } }
                tbody {
                    @for r in recent.iter() {
                        @let id = r.s(0);
                        tr.link.sel[id == occ] {
                            td.nw { a href=(ctx.href(&format!("/errors/{fingerprint}"), &[("occ", &id)])) { (fmt::clock(r.i(1))) } }
                            td.dim { (r.s(2)) }
                            td.mono.dim.clip { (r.s(3)) }
                            td.dim { (r.s(4)) }
                            td.mono.clip { (r.s(5)) }
                            td.n { @if r.u(6) > 0 { (r.u(6)) } }
                            td.mono { @if !r.s(7).is_empty() { a href=(ctx.href(&format!("/traces/{}", r.s(7)), &[])) { (fmt::short(&r.s(7), 10)) } } }
                            td.mono.dim { (fmt::short(&r.s(8), 10)) }
                        }
                    }
                }
            }
        }))
    })
}
