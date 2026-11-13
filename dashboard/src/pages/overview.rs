use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, bucket, dense, scope};
use crate::fmt;
use crate::layout::{card, chart, empty, kpi, sev, when};
use crate::pages::llm;

/// "120 calls · 64% cached · estimated": call count, the share of input
/// tokens served from the prompt cache, and how the spend was priced.
pub fn llm_spend_sub(calls: u64, input: u64, cached: u64, basis: &llm::Basis) -> String {
    let mut parts = vec![format!("{} calls", fmt::compact(calls))];
    if input > 0 {
        parts.push(format!("{} cached", llm::cache_share(cached, input)));
    }
    let label = basis.label();
    if !label.is_empty() {
        parts.push(label);
    }
    parts.join(" · ")
}

pub async fn render(app: &App, ctx: &Ctx) -> Result<Markup, ChError> {
    let p = ctx.params();
    let ch = &app.ch;
    let n = ctx.buckets();

    let http_sql = format!(
        "SELECT {b} AS b, sum(request_count), sum(error_count), sum(duration_sum_ms), sum(session_count)
         FROM runtime_metrics_1m WHERE {w} AND NOT startsWith(route, 'event:')
         GROUP BY b ORDER BY b",
        b = bucket("bucket_at"),
        w = scope("bucket_at")
    );
    let err_sql = format!(
        "SELECT {b} AS b, (uniq(occurrence_id) + sum(collapsed_count)), (uniqIf(occurrence_id, severity IN ('fatal', 'error')) + sumIf(collapsed_count, severity IN ('fatal', 'error')))
         FROM runtime_error_occurrences WHERE {w} GROUP BY b ORDER BY b",
        b = bucket("occurred_at"),
        w = scope("occurred_at")
    );
    // Latency percentiles come from runtime_route_latency_1m: unsampled
    // (every request's duration, or its histogram buckets) and mergeable,
    // so any window and grouping are exact as the t-digest allows.
    let p95_sql = format!(
        "SELECT arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(duration_quantiles), 2), sum(request_count)
         FROM runtime_route_latency_1m WHERE {w} AND NOT startsWith(route, 'event:')",
        w = scope("bucket_at")
    );
    let routes_sql = format!(
        "SELECT m.route, m.service, m.n, m.e, m.avg, l.p95 FROM (
             SELECT route, service, sum(request_count) AS n, sum(error_count) AS e,
                    sum(duration_sum_ms) / greatest(n, 1) AS avg
             FROM runtime_metrics_1m WHERE {w} AND NOT startsWith(route, 'event:')
             GROUP BY route, service ORDER BY n DESC LIMIT 12) AS m
         LEFT JOIN (
             SELECT route, service,
                    arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(duration_quantiles), 2) AS p95
             FROM runtime_route_latency_1m WHERE {w} GROUP BY route, service) AS l
         ON m.route = l.route AND m.service = l.service
         ORDER BY m.n DESC",
        w = scope("bucket_at")
    );
    let issues_sql = format!(
        "SELECT fingerprint, any(severity), any(error_type), any(message_normalized),
                (uniq(occurrence_id) + sum(collapsed_count)) AS c, toUnixTimestamp64Milli(max(occurred_at)), any(service)
         FROM runtime_error_occurrences WHERE {w}
         GROUP BY fingerprint ORDER BY c DESC LIMIT 8",
        w = scope("occurred_at")
    );
    let llm_sql = format!(
        "SELECT count(), sum(cost_usd), sum(input_tokens), sum(cache_read_tokens), {basis}
         FROM runtime_llm_calls WHERE {w}",
        basis = llm::BASIS_COLUMNS,
        w = scope("started_at")
    );

    // All six run concurrently over the pooled connections; page latency is
    // the slowest single query, not the sum.
    let (http, errs, p95, routes, issues, llm) = tokio::try_join!(
        ch.query(&http_sql, &p),
        ch.query(&err_sql, &p),
        ch.query(&p95_sql, &p),
        ch.query(&routes_sql, &p),
        ch.query(&issues_sql, &p),
        ch.query(&llm_sql, &p),
    )?;

    let hs = dense(&http, n, 4);
    let (reqs, req_errs, dur, sessions) = (
        hs[0].iter().sum::<f64>() as u64,
        hs[1].iter().sum::<f64>() as u64,
        hs[2].iter().sum::<f64>(),
        hs[3].iter().sum::<f64>() as u64,
    );
    let es = dense(&errs, n, 2);
    let occ_total = es[0].iter().sum::<f64>() as u64;
    let occ_err = es[1].iter().sum::<f64>() as u64;
    let (p95v, timed) = p95.first().map(|r| (r.f(0), r.u(1))).unwrap_or((0.0, 0));
    let (llm_calls, llm_cost, llm_in, llm_cached, llm_basis) = llm
        .first()
        .map(|r| (r.u(0), r.f(1), r.u(2), r.u(3), llm::Basis::from_row(&r, 4)))
        .unwrap_or_default();
    let llm_sub = llm_spend_sub(llm_calls, llm_in, llm_cached, &llm_basis);
    let avg = if reqs > 0 { dur / reqs as f64 } else { 0.0 };

    let req_tone = if reqs > 0 && req_errs * 100 >= reqs * 5 {
        "bad"
    } else {
        ""
    };
    let err_tone = if occ_err > 0 { "bad" } else { "" };

    Ok(html! {
        div.kpis {
            (kpi("Requests", &fmt::compact(reqs), (sessions > 0).then(|| format!("{} browser sessions", fmt::compact(sessions))).as_deref(), ""))
            (kpi("Failure rate", &fmt::pct(req_errs, reqs), Some(&format!("{} failed", fmt::compact(req_errs))), req_tone))
            (kpi("Avg latency", &fmt::ms(avg), Some(&if timed > 0 { format!("p95 {}", fmt::ms(p95v)) } else { "no latency data yet".into() }), ""))
            (kpi("Errors", &fmt::compact(occ_err), Some(&format!("{} incl. warnings", fmt::compact(occ_total))), err_tone))
            (kpi("LLM spend", &fmt::usd(llm_cost), Some(&llm_sub), ""))
        }
        div.grid2 {
            (card("Requests", None, chart(ctx, &[("Requests", &hs[0]), ("Failed", &hs[1])], "")))
            (card("Error occurrences", Some(html! { a href=(ctx.href("/errors", &[])) { "All errors →" } }),
                chart(ctx, &[("All severities", &es[0]), ("Errors", &es[1])], "")))
        }
        div.grid2 {
            (card("Top routes", None, html! {
                @if routes.is_empty() { (empty("No request metrics in this window.")) } @else {
                    table.t {
                        thead { tr { th { "Route" } th { "Service" } th.n { "Requests" } th.n { "Failed" } th.n { "Avg" } th.n { "p95" } } }
                        tbody {
                            @for r in routes.iter() {
                                @let (n, e) = (r.u(2), r.u(3));
                                tr {
                                    td.mono.clip title=(r.s(0)) { @if r.s(0).is_empty() { span.dim { "(no route)" } } @else { (r.s(0)) } }
                                    td.dim { (r.s(1)) }
                                    td.n { (fmt::compact(n)) }
                                    td.n.bad[e > 0] { (fmt::compact(e)) span.dim { " " (fmt::pct(e, n)) } }
                                    td.n { (fmt::ms(r.f(4))) }
                                    td.n { @if r.f(5) > 0.0 { (fmt::ms(r.f(5))) } @else { span.dim { "–" } } }
                                }
                            }
                        }
                    }
                }
            }))
            (card("Top issues", None, html! {
                @if issues.is_empty() { (empty("No errors in this window. 🎉")) } @else {
                    table.t {
                        thead { tr { th { "Issue" } th.n { "Events" } th.n { "Last seen" } } }
                        tbody {
                            @for r in issues.iter() {
                                tr.link {
                                    td.clip {
                                        (sev(&r.s(1))) " "
                                        a href=(ctx.href(&format!("/errors/{}", r.s(0)), &[])) {
                                            b { (r.s(2)) } " " span.dim { (r.s(3)) }
                                        }
                                    }
                                    td.n { (fmt::compact(r.u(4))) }
                                    td.n.dim { (when(r.i(5), ctx.now_ms)) }
                                }
                            }
                        }
                    }
                }
            }))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_spend_sub_says_calls_cache_share_and_basis() {
        let estimated = llm::Basis {
            estimated: 4,
            ..Default::default()
        };
        assert_eq!(
            llm_spend_sub(120, 10_000, 6_400, &estimated),
            "120 calls · 64% cached · estimated"
        );
        assert_eq!(llm_spend_sub(0, 0, 0, &llm::Basis::default()), "0 calls");
        let legacy = llm::Basis {
            legacy: 1,
            ..Default::default()
        };
        assert_eq!(
            llm_spend_sub(1, 10, 0, &legacy),
            "1 calls · 0% cached · estimated before cache pricing"
        );
    }
}
