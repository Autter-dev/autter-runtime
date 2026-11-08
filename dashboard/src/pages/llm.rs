use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, bucket, dense, scope};
use crate::fmt;
use crate::layout::{card, chart, empty, kpi};

pub async fn render(app: &App, ctx: &Ctx) -> Result<Markup, ChError> {
    let p = ctx.params();
    let w = scope("started_at");
    let series_sql = format!(
        "SELECT {b} AS b, sum(cost_usd), count(), countIf(status = 'error'),
                sum(input_tokens), sum(output_tokens), sum(duration_ms)
         FROM runtime_llm_calls WHERE {w} GROUP BY b ORDER BY b",
        b = bucket("started_at")
    );
    let models_sql = format!(
        "SELECT provider, model, count() AS n, sum(input_tokens), sum(output_tokens), sum(cost_usd) AS c,
                avg(duration_ms), countIf(status = 'error'), arrayStringConcat(groupUniqArray(3)(cost_source), ', ')
         FROM runtime_llm_calls WHERE {w} GROUP BY provider, model ORDER BY c DESC, n DESC LIMIT 30"
    );
    let recent_sql = format!(
        "SELECT toUnixTimestamp64Milli(started_at), service, model, operation, input_tokens, output_tokens,
                cost_usd, duration_ms, status, error_type, user_id, trace_id
         FROM runtime_llm_calls WHERE {w} ORDER BY started_at DESC LIMIT 50"
    );
    let (series, models, recent) = tokio::try_join!(
        app.ch.query(&series_sql, &p),
        app.ch.query(&models_sql, &p),
        app.ch.query(&recent_sql, &p),
    )?;

    let s = dense(&series, ctx.buckets(), 6);
    let sum = |i: usize| s[i].iter().sum::<f64>();
    let (cost, calls, errs, tin, tout, dur) = (
        sum(0),
        sum(1) as u64,
        sum(2) as u64,
        sum(3) as u64,
        sum(4) as u64,
        sum(5),
    );

    Ok(html! {
        div.kpis {
            (kpi("Spend", &fmt::usd(cost), Some(&format!("{} per call", fmt::usd(if calls > 0 { cost / calls as f64 } else { 0.0 }))), ""))
            (kpi("Calls", &fmt::compact(calls), Some(&format!("{} failed ({})", fmt::compact(errs), fmt::pct(errs, calls))), ""))
            (kpi("Input tokens", &fmt::compact(tin), None, ""))
            (kpi("Output tokens", &fmt::compact(tout), None, ""))
            (kpi("Avg latency", &fmt::ms(if calls > 0 { dur / calls as f64 } else { 0.0 }), None, ""))
        }
        div.grid2 {
            (card("Spend", None, chart(ctx, &[("Cost", &s[0])], "$")))
            (card("Calls", None, chart(ctx, &[("Calls", &s[1]), ("Failed", &s[2])], "")))
        }
        (card("By model", None, html! {
            @if models.is_empty() { (empty("No LLM calls in this window. Instrument a client with instrumentLlmClient() or send GenAI spans.")) } @else {
                table.t {
                    thead { tr { th { "Model" } th { "Provider" } th.n { "Calls" } th.n { "Input" } th.n { "Output" } th.n { "Cost" } th.n { "Avg" } th.n { "Failed" } } }
                    tbody {
                        @for r in models.iter() {
                            tr {
                                td.mono { (r.s(1)) }
                                td.dim { (r.s(0)) }
                                td.n { (fmt::compact(r.u(2))) }
                                td.n { (fmt::compact(r.u(3))) }
                                td.n { (fmt::compact(r.u(4))) }
                                td.n title={ "cost source: " (r.s(8)) } { b { (fmt::usd(r.f(5))) } }
                                td.n.dim { (fmt::ms(r.f(6))) }
                                td.n.bad[r.u(7) > 0] { (r.u(7)) }
                            }
                        }
                    }
                }
            }
        }))
        (card("Recent calls", None, html! {
            @if recent.is_empty() { (empty("Nothing yet.")) } @else {
                table.t {
                    thead { tr { th { "When" } th { "Service" } th { "Model" } th { "Op" } th.n { "Tokens in/out" } th.n { "Cost" } th.n { "Latency" } th { "Status" } th { "User" } } }
                    tbody {
                        @for r in recent.iter() {
                            tr {
                                td.mono.dim.nw {
                                    @if r.s(11).is_empty() { (fmt::clock(r.i(0))) }
                                    @else { a href=(ctx.href(&format!("/traces/{}", r.s(11)), &[])) { (fmt::clock(r.i(0))) } }
                                }
                                td.dim { (r.s(1)) }
                                td.mono { (r.s(2)) }
                                td.dim { (r.s(3)) }
                                td.n { (fmt::compact(r.u(4))) " / " (fmt::compact(r.u(5))) }
                                td.n { (fmt::usd(r.f(6))) }
                                td.n { (fmt::ms(r.f(7))) }
                                td { @if r.s(8) == "error" { span.sev.error { "error" } " " span.dim { (r.s(9)) } } @else { span.dim { "ok" } } }
                                td.mono.dim { (fmt::short(&r.s(10), 14)) }
                            }
                        }
                    }
                }
            }
        }))
    })
}
