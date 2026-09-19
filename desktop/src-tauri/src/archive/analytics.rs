//! One snapshot and one accounting ladder for the complete usage dashboard.
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::agent_usage::{
    self, CostField, Coverage, EventOutcome, FieldValue, ReportedUsage, UsageAccumulator,
};
use super::{analytics_store, metric_store, store};

const UNKNOWN: &str = "__unknown__";
const WEEKDAY_LABELS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// Range and civil-calendar definition from the viewer's local timezone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsRequest {
    pub bucket_boundaries: Vec<i64>,
    pub day_boundaries: Vec<i64>,
    pub day_labels: Vec<String>,
    #[serde(default)]
    pub agent_pubkeys: Vec<String>,
    #[serde(default)]
    pub select_none: bool,
}

impl AnalyticsRequest {
    fn validate(&self) -> Result<HashSet<String>, String> {
        fn boundaries(values: &[i64], max: usize, interval: i64) -> Result<(), String> {
            if values.len() < 2 || values.len() > max + 1 {
                return Err("invalid boundary count".into());
            }
            for pair in values.windows(2) {
                if pair[1]
                    .checked_sub(pair[0])
                    .is_none_or(|d| d <= 0 || d > interval)
                {
                    return Err("invalid boundary interval".into());
                }
            }
            if values
                .iter()
                .any(|v| chrono::DateTime::from_timestamp(*v, 0).is_none())
            {
                return Err("timestamp out of range".into());
            }
            Ok(())
        }
        boundaries(&self.bucket_boundaries, 2000, 32 * 86400)?;
        boundaries(&self.day_boundaries, 36600, 48 * 3600)?;
        if self.day_boundaries.first() != self.bucket_boundaries.first()
            || self.day_boundaries.last() != self.bucket_boundaries.last()
            || self.day_labels.len() + 1 != self.day_boundaries.len()
        {
            return Err("calendar and timeline ranges must match".into());
        }
        let mut previous = None;
        for label in &self.day_labels {
            let day =
                NaiveDate::parse_from_str(label, "%Y-%m-%d").map_err(|_| "invalid civil date")?;
            if previous.is_some_and(|p| day <= p) {
                return Err("civil dates must increase".into());
            }
            previous = Some(day);
        }
        if self.agent_pubkeys.len() > 1000 {
            return Err("too many agents".into());
        }
        self.agent_pubkeys
            .iter()
            .map(|pk| {
                if pk.len() != 64 || !pk.bytes().all(|c| c.is_ascii_hexdigit()) {
                    Err("agent pubkeys must be 64 hex characters".into())
                } else {
                    Ok(pk.to_ascii_lowercase())
                }
            })
            .collect()
    }
}

/// Distinct cost provenance categories; no blended cost is represented as a bill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Costs {
    pub wire_reported: CostField,
    pub manifest_estimated: CostField,
    pub unknown: CostField,
}

/// Reusable dashboard row, with full unsigned counters represented as strings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricGroup {
    pub key: String,
    pub label: String,
    pub usage: ReportedUsage,
    pub report_count: usize,
    pub request_count: Option<String>,
    pub costs: Costs,
    pub avg_latency_ms: CostField,
    pub fallback_count: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucket {
    #[serde(flatten)]
    pub group: MetricGroup,
    pub start: i64,
    pub end: i64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDate {
    #[serde(flatten)]
    pub group: MetricGroup,
    pub date: String,
    pub provider: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlights {
    pub busiest_day: Option<String>,
    pub top_model: Option<String>,
    pub top_agent: Option<String>,
    pub active_days: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub provider: String,
    pub share: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diversity {
    pub score: Option<f64>,
    pub provider_count: usize,
    pub known_report_count: usize,
    pub total_report_count: usize,
    pub recent_score: Option<f64>,
    pub recent_start: i64,
    pub shares: Vec<Share>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCoverage {
    #[serde(flatten)]
    pub base: Coverage,
    pub provider_reports: usize,
    pub account_reports: usize,
    pub tier_reports: usize,
    pub complete_request_reports: usize,
    pub request_observation_count: usize,
    pub cost_provenance_reports: usize,
    pub archive_first_reported_at: Option<i64>,
    pub archive_last_reported_at: Option<i64>,
    pub inconsistent_request_reports: usize,
}
/// Full, internally consistent filtered dashboard response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub collection_enabled: bool,
    pub summary: MetricGroup,
    pub timeline: Vec<TimeBucket>,
    pub days: Vec<TimeBucket>,
    pub weekdays: Vec<MetricGroup>,
    pub providers: Vec<MetricGroup>,
    pub provider_by_date: Vec<ProviderDate>,
    pub agents: Vec<MetricGroup>,
    pub models: Vec<MetricGroup>,
    pub accounts: Vec<MetricGroup>,
    pub service_tiers: Vec<MetricGroup>,
    pub stop_reasons: Vec<MetricGroup>,
    pub available_agents: Vec<String>,
    pub highlights: Highlights,
    pub diversity: Diversity,
    pub coverage: AnalyticsCoverage,
}

#[derive(Default)]
struct Group {
    usage: UsageAccumulator,
    reports: HashSet<String>,
    requests: Option<u64>,
    requests_unknown: bool,
    costs: [Option<f64>; 3],
    cost_unknown: [bool; 3],
    latency_sum: u128,
    latency_count: usize,
    latency_unknown: bool,
    fallback: u64,
    fallback_unknown: bool,
    label: Option<String>,
}
impl Group {
    fn add(&mut self, id: &str, outcome: &EventOutcome, metadata: &analytics_store::Metadata) {
        self.usage.add(outcome);
        self.reports.insert(id.to_string());
        let t = &metadata.telemetry;
        match t.request_count {
            Some(n) => {
                self.requests = self.requests.unwrap_or(0).checked_add(n);
                if self.requests.is_none() {
                    self.requests_unknown = true;
                }
            }
            None => self.requests_unknown = true,
        }
        let index = match t.cost_source.as_deref() {
            Some("wire-reported") => 0,
            Some("manifest-estimated") => 1,
            _ => 2,
        };
        match outcome.cost {
            FieldValue::Known(cost) => {
                let sum = self.costs[index].unwrap_or(0.0) + cost;
                if sum.is_finite() {
                    self.costs[index] = Some(sum)
                } else {
                    self.cost_unknown[index] = true
                }
            }
            FieldValue::Unknown => self.cost_unknown[index] = true,
        }
        if !t.requests_complete {
            self.latency_unknown = true;
            self.fallback_unknown = true;
        }
        for r in &t.requests {
            if let Some(ms) = r.latency_ms {
                self.latency_sum += u128::from(ms);
                self.latency_count += 1;
            } else {
                self.latency_unknown = true;
            }
            if let Some(fallback) = r.fallback {
                self.fallback += u64::from(fallback);
            } else {
                self.fallback_unknown = true;
            }
        }
    }
    fn finish(self, key: String) -> MetricGroup {
        let field = |index| CostField {
            value: self.costs[index],
            incomplete: self.cost_unknown[index],
        };
        MetricGroup {
            label: self.label.unwrap_or_else(|| {
                if key == UNKNOWN {
                    "Not reported".into()
                } else {
                    key.clone()
                }
            }),
            key,
            usage: self.usage.finish(),
            report_count: self.reports.len(),
            request_count: (!self.requests_unknown)
                .then(|| self.requests.map(|n| n.to_string()))
                .flatten(),
            costs: Costs {
                wire_reported: field(0),
                manifest_estimated: field(1),
                unknown: field(2),
            },
            avg_latency_ms: CostField {
                value: (self.latency_count > 0)
                    .then(|| self.latency_sum as f64 / self.latency_count as f64),
                incomplete: self.latency_unknown,
            },
            fallback_count: (!self.fallback_unknown && !self.reports.is_empty())
                .then(|| self.fallback.to_string()),
        }
    }
}
fn dimension(value: Option<&str>) -> String {
    value
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(UNKNOWN)
        .to_string()
}
fn add(
    map: &mut BTreeMap<String, Group>,
    key: String,
    id: &str,
    outcome: &EventOutcome,
    meta: &analytics_store::Metadata,
) {
    map.entry(key).or_default().add(id, outcome, meta);
}
fn finish(map: BTreeMap<String, Group>) -> Vec<MetricGroup> {
    map.into_iter().map(|(key, g)| g.finish(key)).collect()
}
fn bucket(boundaries: &[i64], at: i64) -> usize {
    boundaries.partition_point(|b| *b <= at).saturating_sub(1)
}
fn score(counts: &BTreeMap<String, usize>) -> Option<f64> {
    let n: usize = counts.values().sum();
    if n == 0 {
        None
    } else if counts.len() == 1 {
        Some(0.0)
    } else {
        Some(
            (-100.0
                * counts
                    .values()
                    .map(|c| {
                        let p = *c as f64 / n as f64;
                        p * p.ln()
                    })
                    .sum::<f64>()
                / (counts.len() as f64).ln())
            .clamp(0.0, 100.0),
        )
    }
}

fn known_total_tokens(group: &MetricGroup) -> Option<u128> {
    (!group.usage.total_tokens.incomplete)
        .then(|| group.usage.total_tokens.value.as_deref()?.parse().ok())
        .flatten()
}

fn top_by_tokens(rows: &[MetricGroup]) -> Option<String> {
    rows.iter()
        .filter(|row| row.key != UNKNOWN)
        .filter_map(|row| Some((known_total_tokens(row)?, row)))
        .max_by_key(|(tokens, _)| *tokens)
        .map(|(_, row)| row.key.clone())
}

fn requests_consistent(outcome: &EventOutcome, meta: &analytics_store::Metadata) -> bool {
    let mut aggregate = UsageAccumulator::default();
    let mut turn = UsageAccumulator::default();
    turn.add(outcome);
    for request in &meta.telemetry.requests {
        aggregate.add(&EventOutcome::from_counts(&request.usage));
    }
    let (a, b) = (aggregate.finish(), turn.finish());
    for (a, b) in [
        (&a.input_tokens, &b.input_tokens),
        (&a.output_tokens, &b.output_tokens),
        (&a.total_tokens, &b.total_tokens),
        (&a.cache_read_tokens, &b.cache_read_tokens),
        (&a.cache_write_tokens, &b.cache_write_tokens),
    ] {
        if !a.incomplete
            && !b.incomplete
            && a.value.is_some()
            && b.value.is_some()
            && a.value != b.value
        {
            return false;
        }
    }
    if let (Some(a), Some(b)) = (a.estimated_cost_usd.value, b.estimated_cost_usd.value) {
        if (a - b).abs() > 1e-8 * a.abs().max(b.abs()).max(1.0) {
            return false;
        }
    }
    true
}

/// SQLite entry point. Backfills precede the single read transaction, so all
/// dashboard sections see exactly the same archive snapshot.
pub(super) fn query(
    conn: &Connection,
    identity: &str,
    relay: &str,
    request: &AnalyticsRequest,
) -> Result<Analytics, String> {
    let selected = request.validate()?;
    metric_store::backfill_agent_metric_index(conn, identity, relay)?;
    metric_store::repair_orphaned_metric_index_rows(conn, identity, relay)?;
    analytics_store::backfill(conn, identity, relay)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let start = request.bucket_boundaries[0];
    let end = request.bucket_boundaries[request.bucket_boundaries.len() - 1];
    let kinds = store::get_subscription_kinds(&tx, identity, relay, "owner_p", identity)?
        .unwrap_or_default();
    let enabled = serde_json::from_str::<Vec<u64>>(&kinds)
        .unwrap_or_default()
        .contains(&44200);
    let all_rows = metric_store::load_window_valid_rows(&tx, identity, relay, start, end, None)?;
    let available_agents = {
        let mut stmt=tx.prepare("SELECT DISTINCT agent_pubkey FROM agent_metric_index WHERE identity_pubkey=?1 AND relay_url=?2 ORDER BY agent_pubkey").map_err(|e|e.to_string())?;
        let values = stmt
            .query_map(params![identity, relay], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        values
    };
    let rows: Vec<_> = all_rows
        .into_iter()
        .filter(|r| {
            !request.select_none && (selected.is_empty() || selected.contains(&r.agent_pubkey))
        })
        .collect();
    let invalid = if request.select_none {
        0
    } else if selected.is_empty() {
        metric_store::count_invalid_rows_in_window(&tx, identity, relay, start, end, None)?
    } else {
        selected.iter().try_fold(0, |sum, pk| {
            metric_store::count_invalid_rows_in_window(&tx, identity, relay, start, end, Some(pk))
                .map(|n| sum + n)
        })?
    };
    let probes = metric_store::load_rows_at_exact_keys(
        &tx,
        identity,
        relay,
        &agent_usage::window_probe_keys(&rows),
    )?;
    let metadata = analytics_store::load(&tx, identity, relay, start, end)?;
    let mut result = compute(
        request,
        &rows,
        &probes,
        &metadata,
        invalid,
        enabled,
        available_agents,
    );
    if !request.select_none {
        let mut stmt=tx.prepare("SELECT agent_pubkey,MIN(reported_at),MAX(reported_at) FROM agent_metric_index WHERE identity_pubkey=?1 AND relay_url=?2 AND parse_status='valid' GROUP BY agent_pubkey").map_err(|e|e.to_string())?;
        let bounds = stmt
            .query_map(params![identity, relay], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for bound in bounds {
            let (pk, first, last) = bound.map_err(|e| e.to_string())?;
            if selected.is_empty() || selected.contains(&pk) {
                if let Some(first) = first {
                    result.coverage.archive_first_reported_at = Some(
                        result
                            .coverage
                            .archive_first_reported_at
                            .map_or(first, |v| v.min(first)),
                    );
                }
                if let Some(last) = last {
                    result.coverage.archive_last_reported_at = Some(
                        result
                            .coverage
                            .archive_last_reported_at
                            .map_or(last, |v| v.max(last)),
                    );
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

fn compute(
    request: &AnalyticsRequest,
    rows: &[metric_store::AgentMetricIndexRow],
    probes: &[metric_store::AgentMetricIndexRow],
    metadata: &HashMap<String, analytics_store::Metadata>,
    invalid: i64,
    enabled: bool,
    available_agents: Vec<String>,
) -> Analytics {
    let mut probe_map = HashMap::new();
    for row in probes {
        if let Some(key) = row.accounting_key() {
            probe_map.entry(key).or_insert_with(Vec::new).push(row);
        }
    }
    let mut summary = Group::default();
    let mut timeline: Vec<Group> = (0..request.bucket_boundaries.len() - 1)
        .map(|_| Group::default())
        .collect();
    let mut days: Vec<Group> = (0..request.day_labels.len())
        .map(|_| Group::default())
        .collect();
    let mut weekdays: Vec<Group> = (0..7).map(|_| Group::default()).collect();
    let mut stop_reasons = BTreeMap::new();
    let (mut providers, mut dates, mut agents, mut models, mut accounts, mut tiers) = (
        BTreeMap::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        BTreeMap::new(),
    );
    let mut coverage = AnalyticsCoverage {
        base: Coverage {
            first_archived_at: None,
            last_archived_at: None,
            first_reported_at: None,
            last_reported_at: None,
            report_count: rows.len() as i64,
            invalid_report_count: invalid,
            has_unknown_usage: invalid > 0,
        },
        provider_reports: 0,
        account_reports: 0,
        tier_reports: 0,
        complete_request_reports: 0,
        request_observation_count: 0,
        cost_provenance_reports: 0,
        archive_first_reported_at: None,
        archive_last_reported_at: None,
        inconsistent_request_reports: 0,
    };
    let mut provider_counts = BTreeMap::<String, usize>::new();
    let mut recent_counts = BTreeMap::new();
    let recent_start = request.day_boundaries[request.day_labels.len().saturating_sub(7)];
    for row in rows {
        let Some(at) = row.reported_at else { continue };
        let ti = bucket(&request.bucket_boundaries, at);
        let di = bucket(&request.day_boundaries, at);
        if ti >= timeline.len() || di >= days.len() {
            continue;
        }
        let default = analytics_store::Metadata::default();
        let meta = metadata.get(&row.id).unwrap_or(&default);
        let outcome = agent_usage::compute_event_outcome(row, &probe_map);
        summary.add(&row.id, &outcome, meta);
        add(
            &mut stop_reasons,
            dimension(meta.stop_reason.as_deref()),
            &row.id,
            &outcome,
            meta,
        );
        timeline[ti].add(&row.id, &outcome, meta);
        days[di].add(&row.id, &outcome, meta);
        if let Ok(date) = NaiveDate::parse_from_str(&request.day_labels[di], "%Y-%m-%d") {
            weekdays[date.weekday().num_days_from_monday() as usize].add(&row.id, &outcome, meta);
        }
        add(
            &mut agents,
            row.agent_pubkey.clone(),
            &row.id,
            &outcome,
            meta,
        );
        let a = &meta.telemetry.attribution;
        let consistent = requests_consistent(&outcome, meta);
        let complete = meta.telemetry.requests_complete && consistent;
        coverage.inconsistent_request_reports +=
            usize::from(meta.telemetry.requests_complete && !consistent);
        let has_requests = complete && !meta.telemetry.requests.is_empty();
        coverage.provider_reports += usize::from(
            a.provider.is_some()
                || (has_requests
                    && meta
                        .telemetry
                        .requests
                        .iter()
                        .all(|r| r.attribution.provider.is_some())),
        );
        coverage.account_reports += usize::from(
            a.account_id.is_some()
                || (has_requests
                    && meta
                        .telemetry
                        .requests
                        .iter()
                        .all(|r| r.attribution.account_id.is_some())),
        );
        coverage.tier_reports += usize::from(
            a.service_tier.is_some()
                || (has_requests
                    && meta
                        .telemetry
                        .requests
                        .iter()
                        .all(|r| r.attribution.service_tier.is_some())),
        );
        coverage.complete_request_reports += usize::from(complete);
        coverage.request_observation_count += meta.telemetry.requests.len();
        coverage.cost_provenance_reports += usize::from(matches!(
            meta.telemetry.cost_source.as_deref(),
            Some("wire-reported" | "manifest-estimated")
        ));
        // The turn remains the headline accounting unit. Complete requests may
        // partition dimensions; they are never added to the headline totals.
        let mut contribute =
            |outcome: &EventOutcome, meta: &analytics_store::Metadata, model: Option<&str>| {
                let a = &meta.telemetry.attribution;
                let provider = dimension(a.provider.as_deref());
                add(&mut providers, provider.clone(), &row.id, outcome, meta);
                add(
                    &mut dates,
                    format!("{}|{}", request.day_labels[di], provider),
                    &row.id,
                    outcome,
                    meta,
                );
                add(&mut models, dimension(model), &row.id, outcome, meta);
                let account = dimension(a.account_id.as_deref());
                add(&mut accounts, account.clone(), &row.id, outcome, meta);
                if let Some(label) = a.account_label.as_ref().filter(|_| {
                    a.account_id
                        .as_ref()
                        .is_some_and(|id| !id.trim().is_empty())
                }) {
                    if let Some(group) = accounts.get_mut(&account) {
                        group.label = Some(label.clone());
                    }
                }
                add(
                    &mut tiers,
                    dimension(a.service_tier.as_deref()),
                    &row.id,
                    outcome,
                    meta,
                );
            };
        if has_requests {
            for r in &meta.telemetry.requests {
                let rm = analytics_store::Metadata {
                    telemetry: buzz_core_pkg::agent_turn_metric::UsageTelemetry {
                        attribution: r.attribution.clone(),
                        cost_source: r.cost_source.clone(),
                        request_count: Some(1),
                        requests_complete: true,
                        requests: vec![r.clone()],
                    },
                    stop_reason: meta.stop_reason.clone(),
                    expected_requests: 1,
                };
                contribute(
                    &EventOutcome::from_counts(&r.usage),
                    &rm,
                    r.model.as_deref(),
                );
            }
        } else {
            contribute(&outcome, meta, row.model.as_deref());
        }
        // Diversity is weighted by the finest complete observation available:
        // each request when request coverage is complete, otherwise one turn.
        // Never collapse a 99:1 request split into a 50:50 set of providers.
        let observed_providers: Vec<&String> = if has_requests {
            meta.telemetry
                .requests
                .iter()
                .filter_map(|r| r.attribution.provider.as_ref())
                .collect()
        } else {
            a.provider.iter().collect()
        };
        for provider in observed_providers {
            *provider_counts.entry(provider.clone()).or_default() += 1;
            if at >= recent_start {
                *recent_counts.entry(provider.clone()).or_default() += 1;
            }
        }
        let c = &mut coverage.base;
        c.first_archived_at = Some(
            c.first_archived_at
                .map_or(row.archived_at, |v| v.min(row.archived_at)),
        );
        c.last_archived_at = Some(
            c.last_archived_at
                .map_or(row.archived_at, |v| v.max(row.archived_at)),
        );
        c.first_reported_at = Some(c.first_reported_at.map_or(at, |v| v.min(at)));
        c.last_reported_at = Some(c.last_reported_at.map_or(at, |v| v.max(at)));
    }
    let summary = summary.finish("all".into());
    coverage.base.has_unknown_usage |= summary.usage.input_tokens.incomplete
        || summary.usage.output_tokens.incomplete
        || summary.usage.total_tokens.incomplete
        || summary.usage.estimated_cost_usd.incomplete
        || summary.usage.cache_read_tokens.incomplete
        || summary.usage.cache_write_tokens.incomplete
        || summary.usage.fresh_input_tokens.incomplete
        || coverage.inconsistent_request_reports > 0;
    let timeline = timeline
        .into_iter()
        .enumerate()
        .map(|(i, g)| TimeBucket {
            group: g.finish(request.bucket_boundaries[i].to_string()),
            start: request.bucket_boundaries[i],
            end: request.bucket_boundaries[i + 1],
        })
        .collect();
    let days: Vec<_> = days
        .into_iter()
        .enumerate()
        .map(|(i, g)| TimeBucket {
            group: g.finish(request.day_labels[i].clone()),
            start: request.day_boundaries[i],
            end: request.day_boundaries[i + 1],
        })
        .collect();
    let weekdays = weekdays
        .into_iter()
        .enumerate()
        .map(|(i, g)| g.finish(WEEKDAY_LABELS[i].to_string()))
        .collect();
    let (providers, agents, models, accounts, service_tiers) = (
        finish(providers),
        finish(agents),
        finish(models),
        finish(accounts),
        finish(tiers),
    );
    let provider_by_date = dates
        .into_iter()
        .filter_map(|(key, g)| {
            let (date, provider) = key.split_once('|')?;
            Some(ProviderDate {
                date: date.into(),
                provider: provider.into(),
                group: g.finish(key.clone()),
            })
        })
        .collect();
    let highlights = Highlights {
        busiest_day: days
            .iter()
            .filter_map(|day| Some((known_total_tokens(&day.group)?, day)))
            .max_by_key(|(tokens, _)| *tokens)
            .map(|(_, day)| day.group.key.clone()),
        top_model: top_by_tokens(&models),
        top_agent: top_by_tokens(&agents),
        active_days: days.iter().filter(|d| d.group.report_count > 0).count(),
    };
    let known = provider_counts.values().sum::<usize>();
    let diversity = Diversity {
        score: score(&provider_counts),
        provider_count: provider_counts.len(),
        known_report_count: coverage.provider_reports,
        total_report_count: rows.len(),
        recent_score: score(&recent_counts),
        recent_start,
        shares: provider_counts
            .into_iter()
            .map(|(provider, n)| Share {
                provider,
                share: n as f64 / known as f64,
            })
            .collect(),
    };
    Analytics {
        collection_enabled: enabled,
        summary,
        timeline,
        days,
        weekdays,
        providers,
        provider_by_date,
        agents,
        models,
        accounts,
        service_tiers,
        stop_reasons: finish(stop_reasons),
        available_agents,
        highlights,
        diversity,
        coverage,
    }
}

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod tests;
