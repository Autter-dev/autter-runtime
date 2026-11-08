//! Request context: which tenant, which time window, which filters — plus
//! the small in-memory caches (tenant list, service/env facets) that keep
//! every page down to the queries it actually needs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::ch::{Ch, ChError};
use crate::fmt::{now_ms, url_encode_into};

/// Every query-string parameter any page understands. Empty == unset.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct P {
    pub org: Option<String>,
    pub repo: Option<String>,
    pub range: Option<String>,
    pub service: Option<String>,
    pub env: Option<String>,
    pub sev: Option<String>,
    pub src: Option<String>,
    pub q: Option<String>,
    pub sort: Option<String>,
    pub before: Option<String>,
    pub kind: Option<String>,
    pub errors: Option<String>,
    pub min: Option<String>,
    pub occ: Option<String>,
}

pub fn opt(v: &Option<String>) -> &str {
    v.as_deref().map(str::trim).unwrap_or("")
}

pub struct Range {
    pub key: &'static str,
    pub label: &'static str,
    pub secs: u32,
    pub step: u32,
}

/// Bucket sizes chosen so charts land at 60–100 bars. Never below one
/// minute: `runtime_metrics_1m` can't be split finer than that.
pub const RANGES: [Range; 6] = [
    Range {
        key: "15m",
        label: "15 min",
        secs: 900,
        step: 60,
    },
    Range {
        key: "1h",
        label: "1 hour",
        secs: 3600,
        step: 60,
    },
    Range {
        key: "6h",
        label: "6 hours",
        secs: 21_600,
        step: 300,
    },
    Range {
        key: "24h",
        label: "24 hours",
        secs: 86_400,
        step: 900,
    },
    Range {
        key: "7d",
        label: "7 days",
        secs: 604_800,
        step: 7200,
    },
    Range {
        key: "14d",
        label: "14 days",
        secs: 1_209_600,
        step: 14_400,
    },
];
const DEFAULT_RANGE: usize = 3;

pub struct Facets {
    pub services: Vec<String>,
    pub envs: Vec<String>,
}

type Tenant = (String, String);

pub struct App {
    pub ch: Ch,
    pub pin: Option<Tenant>,
    pub asset_version: String,
    tenants: Mutex<Option<(Instant, Arc<Vec<Tenant>>)>>,
    facets: Mutex<HashMap<Tenant, (Instant, Arc<Facets>)>>,
}

const CACHE_TTL: Duration = Duration::from_secs(60);

impl App {
    pub fn new(ch: Ch, pin: Option<Tenant>, asset_version: String) -> Self {
        Self {
            ch,
            pin,
            asset_version,
            tenants: Mutex::new(None),
            facets: Mutex::new(HashMap::new()),
        }
    }

    async fn tenants(&self) -> Result<Arc<Vec<Tenant>>, ChError> {
        if let Some((at, list)) = &*self.tenants.lock().unwrap()
            && at.elapsed() < CACHE_TTL
            && !list.is_empty()
        {
            return Ok(list.clone());
        }
        // Only the two leading ORDER BY columns are read, and only from
        // recent partitions, so this stays cheap even on a large database.
        let rows = self
            .ch
            .query(
                "SELECT org_id, repository_id FROM (
                    SELECT org_id, repository_id, sum(request_count) AS n FROM runtime_metrics_1m
                      WHERE bucket_at >= now() - INTERVAL 14 DAY GROUP BY org_id, repository_id
                    UNION ALL SELECT org_id, repository_id, count() FROM runtime_error_occurrences
                      WHERE occurred_at >= now() - INTERVAL 14 DAY GROUP BY org_id, repository_id
                    UNION ALL SELECT org_id, repository_id, count() FROM runtime_logs
                      WHERE occurred_at >= now() - INTERVAL 14 DAY GROUP BY org_id, repository_id
                    UNION ALL SELECT org_id, repository_id, count() FROM runtime_spans
                      WHERE started_at >= now() - INTERVAL 7 DAY GROUP BY org_id, repository_id
                 ) GROUP BY org_id, repository_id ORDER BY sum(n) DESC LIMIT 200",
                &[],
            )
            .await?;
        let list: Arc<Vec<Tenant>> = Arc::new(
            rows.iter()
                .map(|r| (r.s(0).into_owned(), r.s(1).into_owned()))
                .collect(),
        );
        *self.tenants.lock().unwrap() = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    async fn facets(&self, tenant: &Tenant) -> Result<Arc<Facets>, ChError> {
        if let Some((at, f)) = self.facets.lock().unwrap().get(tenant)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(f.clone());
        }
        let p = [("o", tenant.0.as_str()), ("r", tenant.1.as_str())];
        let rows = self
            .ch
            .query(
                "SELECT k, v FROM (
                    SELECT 's' AS k, service AS v FROM runtime_metrics_1m
                      WHERE org_id = {o:String} AND repository_id = {r:String}
                        AND bucket_at >= now() - INTERVAL 14 DAY GROUP BY v
                    UNION ALL SELECT 's', service FROM runtime_error_occurrences
                      WHERE org_id = {o:String} AND repository_id = {r:String}
                        AND occurred_at >= now() - INTERVAL 14 DAY GROUP BY service
                    UNION ALL SELECT 's', service FROM runtime_logs
                      WHERE org_id = {o:String} AND repository_id = {r:String}
                        AND occurred_at >= now() - INTERVAL 14 DAY GROUP BY service
                    UNION ALL SELECT 'e', environment FROM runtime_metrics_1m
                      WHERE org_id = {o:String} AND repository_id = {r:String}
                        AND bucket_at >= now() - INTERVAL 14 DAY GROUP BY environment
                    UNION ALL SELECT 'e', environment FROM runtime_error_occurrences
                      WHERE org_id = {o:String} AND repository_id = {r:String}
                        AND occurred_at >= now() - INTERVAL 14 DAY GROUP BY environment
                 ) WHERE v != '' GROUP BY k, v ORDER BY k, v LIMIT 500",
                &p,
            )
            .await?;
        let mut services = Vec::new();
        let mut envs = Vec::new();
        for r in rows.iter() {
            let v = r.s(1).into_owned();
            if r.s(0) == "s" {
                services.push(v)
            } else {
                envs.push(v)
            }
        }
        let f = Arc::new(Facets { services, envs });
        let mut cache = self.facets.lock().unwrap();
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(tenant.clone(), (Instant::now(), f.clone()));
        Ok(f)
    }

    pub async fn ctx(&self, p: &P) -> Result<Ctx, ChError> {
        let started = Instant::now();
        let tenants = match &self.pin {
            Some(pin) => Arc::new(vec![pin.clone()]),
            None => self.tenants().await?,
        };
        let asked = (opt(&p.org), opt(&p.repo));
        let tenant = if !asked.0.is_empty() && !asked.1.is_empty() && self.pin.is_none() {
            Some((asked.0.to_string(), asked.1.to_string()))
        } else {
            tenants.first().cloned()
        };
        let facets = match &tenant {
            Some(t) => self.facets(t).await?,
            None => Arc::new(Facets {
                services: vec![],
                envs: vec![],
            }),
        };
        let range_idx = RANGES
            .iter()
            .position(|r| r.key == opt(&p.range))
            .unwrap_or(DEFAULT_RANGE);
        let range = &RANGES[range_idx];
        let now = now_ms();
        let now_s = (now / 1000) as u32;
        let end = now_s.div_ceil(range.step) * range.step;
        let start = end - range.secs;
        let (org, repo) = tenant.unwrap_or_default();
        Ok(Ctx {
            org,
            repo,
            explicit_tenant: !asked.0.is_empty(),
            range,
            range_is_default: range_idx == DEFAULT_RANGE,
            start,
            s: start.to_string(),
            e: end.to_string(),
            st: range.step.to_string(),
            service: opt(&p.service).to_string(),
            env: opt(&p.env).to_string(),
            tenants,
            facets,
            now_ms: now,
            started,
        })
    }
}

pub struct Ctx {
    pub org: String,
    pub repo: String,
    explicit_tenant: bool,
    pub range: &'static Range,
    range_is_default: bool,
    pub start: u32,
    s: String,
    e: String,
    st: String,
    pub service: String,
    pub env: String,
    pub tenants: Arc<Vec<Tenant>>,
    pub facets: Arc<Facets>,
    pub now_ms: i64,
    pub started: Instant,
}

impl Ctx {
    pub fn has_tenant(&self) -> bool {
        !self.org.is_empty()
    }

    pub fn buckets(&self) -> usize {
        (self.range.secs / self.range.step) as usize
    }

    /// Bound parameters every page query shares:
    /// `{o}` org, `{r}` repo, `{s}`/`{e}` window (unix seconds),
    /// `{st}` bucket step, `{svc}`/`{env}` filters (empty = all).
    pub fn params(&self) -> Vec<(&str, &str)> {
        vec![
            ("o", &self.org),
            ("r", &self.repo),
            ("s", &self.s),
            ("e", &self.e),
            ("st", &self.st),
            ("svc", &self.service),
            ("env", &self.env),
        ]
    }

    /// Link that keeps tenant, range and filters, plus page extras.
    pub fn href(&self, path: &str, extra: &[(&str, &str)]) -> String {
        let mut url = String::with_capacity(path.len() + 64);
        url.push_str(path);
        let mut sep = '?';
        let mut add = |k: &str, v: &str| {
            if v.is_empty() {
                return;
            }
            url.push(sep);
            sep = '&';
            url.push_str(k);
            url.push('=');
            url_encode_into(&mut url, v);
        };
        if self.explicit_tenant || self.tenants.len() > 1 {
            add("org", &self.org);
            add("repo", &self.repo);
        }
        if !self.range_is_default {
            add("range", self.range.key);
        }
        add("service", &self.service);
        add("env", &self.env);
        for (k, v) in extra {
            add(k, v);
        }
        url
    }
}

/// `WHERE` clause for a table: tenant + time window + service/env filters.
/// Tenant columns lead every ORDER BY, so this is always a key-range read.
pub fn scope(time_col: &str) -> String {
    format!(
        "org_id = {{o:String}} AND repository_id = {{r:String}} \
         AND {time_col} >= toDateTime({{s:UInt32}}) AND {time_col} < toDateTime({{e:UInt32}}) \
         AND ({{svc:String}} = '' OR service = {{svc:String}}) \
         AND ({{env:String}} = '' OR environment = {{env:String}})"
    )
}

/// Bucket index (0-based) of a timestamp within the window.
pub fn bucket(time_col: &str) -> String {
    format!("intDiv(toUnixTimestamp({time_col}) - {{s:UInt32}}, {{st:UInt32}})")
}

/// Turn `(bucket, v1, v2, …)` rows into dense per-series arrays.
pub fn dense(rows: &crate::ch::Rows, n: usize, series: usize) -> Vec<Vec<f64>> {
    let mut out = vec![vec![0.0; n]; series];
    for r in rows.iter() {
        let b = r.i(0);
        if b < 0 || b as usize >= n {
            continue;
        }
        for (i, s) in out.iter_mut().enumerate() {
            s[b as usize] = r.f(i + 1);
        }
    }
    out
}
