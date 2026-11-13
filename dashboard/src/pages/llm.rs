use maud::{Markup, html};

use crate::ch::ChError;
use crate::ctx::{App, Ctx, bucket, dense, scope};
use crate::fmt;
use crate::layout::{card, chart, empty, kpi};

/// Calls per cost basis, from `cost_source` and `pricing_version`. An
/// estimated row with no `pricing_version` was priced by an ingester before
/// 1.16.0, which charged every input token, cache hits included, at the full
/// input rate: "estimated before cache pricing".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Basis {
    pub reported: u64,
    pub estimated: u64,
    pub legacy: u64,
    pub unpriced: u64,
}

/// SQL columns that count a group's calls per basis, in `Basis` field order.
pub const BASIS_COLUMNS: &str = "countIf(cost_source = 'reported'), \
     countIf(cost_source = 'estimated' AND pricing_version != ''), \
     countIf(cost_source = 'estimated' AND pricing_version = ''), \
     countIf(cost_source NOT IN ('reported', 'estimated'))";

impl Basis {
    pub fn from_row(r: &crate::ch::Row<'_>, first: usize) -> Self {
        Self {
            reported: r.u(first),
            estimated: r.u(first + 1),
            legacy: r.u(first + 2),
            unpriced: r.u(first + 3),
        }
    }

    /// "reported", "estimated", "estimated before cache pricing" or
    /// "unpriced" when every call shares one basis; otherwise each basis
    /// with its share, largest first.
    pub fn label(&self) -> String {
        let total = self.reported + self.estimated + self.legacy + self.unpriced;
        let mut parts: Vec<(u64, &str)> = [
            (self.reported, "reported"),
            (self.estimated, "estimated"),
            (self.legacy, "estimated before cache pricing"),
            (self.unpriced, "unpriced"),
        ]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .collect();
        match parts.len() {
            0 => String::new(),
            1 => parts[0].1.to_string(),
            _ => {
                parts.sort_by(|a, b| b.0.cmp(&a.0));
                parts
                    .iter()
                    .map(|(n, name)| format!("{} {name}", fmt::pct(*n, total)))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        }
    }
}

/// One call's cost basis (the recent-calls table).
pub fn cost_basis(cost_source: &str, pricing_version: &str) -> &'static str {
    match cost_source {
        "reported" => "reported",
        "estimated" if pricing_version.is_empty() => "estimated before cache pricing",
        "estimated" => "estimated",
        _ => "unpriced",
    }
}

/// "prices as of 2026-11-14", plus the override file's day(s) when the
/// window has calls priced from one, from the window's distinct
/// `pricing_version`s of estimated calls ("" = before cache pricing).
pub fn prices_note(versions: &[String]) -> Option<String> {
    let builtin = versions
        .iter()
        .filter(|v| !v.is_empty() && !v.starts_with("override:"))
        .max();
    let mut overrides: Vec<&str> = versions
        .iter()
        .filter_map(|v| v.strip_prefix("override:"))
        .collect();
    overrides.sort_unstable();
    overrides.dedup();
    let mut parts = Vec::new();
    if let Some(day) = builtin {
        parts.push(format!("prices as of {day}"));
    }
    if !overrides.is_empty() {
        parts.push(format!("override prices as of {}", overrides.join(", ")));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Cache reads as a share of input ("–" without input).
pub fn cache_share(cache_read: u64, input: u64) -> String {
    fmt::pct(cache_read.min(input), input)
}

pub async fn render(app: &App, ctx: &Ctx) -> Result<Markup, ChError> {
    let p = ctx.params();
    let w = scope("started_at");
    let series_sql = format!(
        "SELECT {b} AS b, sum(cost_usd), count(), countIf(status = 'error'),
                sum(input_tokens), sum(output_tokens), sum(duration_ms),
                sum(cache_read_tokens), sum(cache_write_tokens)
         FROM runtime_llm_calls WHERE {w} GROUP BY b ORDER BY b",
        b = bucket("started_at")
    );
    let totals_sql = format!("SELECT {BASIS_COLUMNS} FROM runtime_llm_calls WHERE {w}");
    let versions_sql = format!(
        "SELECT DISTINCT pricing_version FROM runtime_llm_calls
         WHERE {w} AND cost_source = 'estimated' ORDER BY pricing_version LIMIT 20"
    );
    let models_sql = format!(
        "SELECT provider, model, count() AS n, sum(input_tokens), sum(output_tokens), sum(cost_usd) AS c,
                avg(duration_ms), countIf(status = 'error'),
                sum(cache_read_tokens), sum(cache_write_tokens), {BASIS_COLUMNS}
         FROM runtime_llm_calls WHERE {w} GROUP BY provider, model ORDER BY c DESC, n DESC LIMIT 30"
    );
    let recent_sql = format!(
        "SELECT toUnixTimestamp64Milli(started_at), service, model, operation, input_tokens, output_tokens,
                cost_usd, duration_ms, status, error_type, user_id, trace_id,
                cache_read_tokens, cache_write_tokens, cost_source, pricing_version
         FROM runtime_llm_calls WHERE {w} ORDER BY started_at DESC LIMIT 50"
    );
    let (series, totals, versions, models, recent) = tokio::try_join!(
        app.ch.query(&series_sql, &p),
        app.ch.query(&totals_sql, &p),
        app.ch.query(&versions_sql, &p),
        app.ch.query(&models_sql, &p),
        app.ch.query(&recent_sql, &p),
    )?;

    let s = dense(&series, ctx.buckets(), 8);
    let sum = |i: usize| s[i].iter().sum::<f64>();
    let (cost, calls, errs, tin, tout, dur, cread, cwrite) = (
        sum(0),
        sum(1) as u64,
        sum(2) as u64,
        sum(3) as u64,
        sum(4) as u64,
        sum(5),
        sum(6) as u64,
        sum(7) as u64,
    );
    let basis = totals
        .first()
        .map(|r| Basis::from_row(&r, 0))
        .unwrap_or_default();
    let versions: Vec<String> = versions.iter().map(|r| r.s(0).into_owned()).collect();
    let note = prices_note(&versions);
    let per_call = fmt::usd(if calls > 0 { cost / calls as f64 } else { 0.0 });
    let spend_sub = match basis.label() {
        l if l.is_empty() => format!("{per_call} per call"),
        l => format!("{per_call} per call · {l}"),
    };

    Ok(html! {
        div.kpis {
            (kpi("Spend", &fmt::usd(cost), Some(&spend_sub), ""))
            (kpi("Calls", &fmt::compact(calls), Some(&format!("{} failed ({})", fmt::compact(errs), fmt::pct(errs, calls))), ""))
            (kpi("Input tokens", &fmt::compact(tin), Some(&format!("{} cached", cache_share(cread, tin))), ""))
            (kpi("Cached input", &fmt::compact(cread), Some(&format!("{} cache writes", fmt::compact(cwrite))), ""))
            (kpi("Output tokens", &fmt::compact(tout), None, ""))
            (kpi("Avg latency", &fmt::ms(if calls > 0 { dur / calls as f64 } else { 0.0 }), None, ""))
        }
        div.grid2 {
            (card("Spend", note.as_ref().map(|n| html! { span.dim { (n) } }), chart(ctx, &[("Cost", &s[0])], "$")))
            (card("Calls", None, chart(ctx, &[("Calls", &s[1]), ("Failed", &s[2])], "")))
        }
        (card("By model", note.as_ref().map(|n| html! { span.dim { "Estimated costs: " (n) } }), html! {
            @if models.is_empty() { (empty("No LLM calls in this window. Instrument a client with instrumentLlmClient() or send GenAI spans.")) } @else {
                table.t {
                    thead { tr {
                        th { "Model" } th { "Provider" } th.n { "Calls" } th.n { "Input" }
                        th.n title="Cache reads (cache hits) and their share of input" { "Cached" }
                        th.n title="Tokens written to the prompt cache" { "Cache writes" }
                        th.n { "Output" } th.n { "Cost" } th.n { "Avg" } th.n { "Failed" }
                    } }
                    tbody {
                        @for r in models.iter() {
                            @let row_basis = Basis::from_row(&r, 10);
                            tr {
                                td.mono { (r.s(1)) }
                                td.dim { (r.s(0)) }
                                td.n { (fmt::compact(r.u(2))) }
                                td.n { (fmt::compact(r.u(3))) }
                                td.n { (fmt::compact(r.u(8))) span.dim { " " (cache_share(r.u(8), r.u(3))) } }
                                td.n { (fmt::compact(r.u(9))) }
                                td.n { (fmt::compact(r.u(4))) }
                                td.n { b { (fmt::usd(r.f(5))) } br; span.tag { (row_basis.label()) } }
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
                    thead { tr {
                        th { "When" } th { "Service" } th { "Model" } th { "Op" } th.n { "Tokens in/out" }
                        th.n title="Cache reads / cache writes" { "Cached / written" }
                        th.n { "Cost" } th.n { "Latency" } th { "Status" } th { "User" }
                    } }
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
                                td.n { (fmt::compact(r.u(12))) " / " (fmt::compact(r.u(13))) }
                                td.n { (fmt::usd(r.f(6))) " " span.tag { (cost_basis(&r.s(14), &r.s(15))) } }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_basis_is_named_plainly_mixed_ones_with_shares() {
        let only = |b: Basis| b.label();
        assert_eq!(
            only(Basis {
                reported: 3,
                ..Default::default()
            }),
            "reported"
        );
        assert_eq!(
            only(Basis {
                estimated: 3,
                ..Default::default()
            }),
            "estimated"
        );
        assert_eq!(
            only(Basis {
                legacy: 2,
                ..Default::default()
            }),
            "estimated before cache pricing"
        );
        assert_eq!(
            only(Basis {
                unpriced: 1,
                ..Default::default()
            }),
            "unpriced"
        );
        assert_eq!(only(Basis::default()), "");
        assert_eq!(
            Basis {
                reported: 1,
                estimated: 3,
                legacy: 0,
                unpriced: 0
            }
            .label(),
            "75% estimated, 25% reported"
        );
        assert_eq!(
            Basis {
                reported: 0,
                estimated: 6,
                legacy: 2,
                unpriced: 2
            }
            .label(),
            "60% estimated, 20% estimated before cache pricing, 20% unpriced"
        );
    }

    #[test]
    fn a_call_estimated_without_pricing_version_predates_cache_pricing() {
        assert_eq!(cost_basis("reported", ""), "reported");
        assert_eq!(cost_basis("estimated", "2026-11-14"), "estimated");
        assert_eq!(cost_basis("estimated", "override:2026-12-01"), "estimated");
        assert_eq!(
            cost_basis("estimated", ""),
            "estimated before cache pricing"
        );
        assert_eq!(cost_basis("none", ""), "unpriced");
    }

    #[test]
    fn prices_note_names_the_newest_table_and_any_override() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(prices_note(&v(&[])), None);
        assert_eq!(prices_note(&v(&[""])), None, "only pre-cache-pricing rows");
        assert_eq!(
            prices_note(&v(&["", "2026-11-14", "2026-12-20"])).as_deref(),
            Some("prices as of 2026-12-20")
        );
        assert_eq!(
            prices_note(&v(&["2026-11-14", "override:2026-12-01"])).as_deref(),
            Some("prices as of 2026-11-14 · override prices as of 2026-12-01")
        );
    }

    #[test]
    fn cache_share_is_a_share_of_input() {
        assert_eq!(cache_share(9_000, 10_000), "90%");
        assert_eq!(cache_share(0, 10_000), "0%");
        assert_eq!(cache_share(5, 0), "–");
        assert_eq!(cache_share(20, 10), "100%", "capped at input");
    }

    #[test]
    fn basis_columns_follow_the_struct_order() {
        let cols: Vec<&str> = BASIS_COLUMNS.split("), ").collect();
        assert_eq!(cols.len(), 4);
        assert!(cols[0].contains("'reported'"));
        assert!(cols[1].contains("pricing_version != ''"));
        assert!(cols[2].contains("pricing_version = ''"));
        assert!(cols[3].contains("NOT IN"));
    }
}
