use super::*;
use serde_json::{json, Value};

const START: i64 = 1_789_776_000;
fn request() -> AnalyticsRequest {
    AnalyticsRequest {
        bucket_boundaries: vec![START, START + 86400],
        day_boundaries: vec![START, START + 86400],
        day_labels: vec!["2026-09-19".into()],
        agent_pubkeys: vec![],
        select_none: false,
    }
}
fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(store::SCHEMA).unwrap();
    super::super::store_migrations::apply_schema_migrations(&c).unwrap();
    c
}
fn insert(c: &Connection, id: &str, agent: &str, input: Option<u64>, telemetry: Value) {
    let raw = json!({"harness":"test","model":"same-model","timestamp":chrono::DateTime::from_timestamp(START+1,0).unwrap().to_rfc3339(),"turn":{"inputTokens":input,"outputTokens":7,"totalTokens":null,"costUsd":0.5},"deltaReliable":true,"telemetry":telemetry});
    c.execute(
        "INSERT INTO archived_events VALUES ('owner','relay',?1,44200,?2,?3,?4,?3)",
        params![id, agent, START + 1, raw.to_string()],
    )
    .unwrap();
}

#[test]
fn filters_every_section_and_preserves_unknown_fields() {
    let c = db();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    insert(
        &c,
        "one",
        &a,
        Some(u64::MAX),
        json!({"attribution":{"provider":"p1","accountId":"acct"},"costSource":"wire-reported"}),
    );
    insert(&c, "two", &b, None, Value::Null);
    let mut req = request();
    req.agent_pubkeys = vec![a.to_uppercase()];
    let single = query(&c, "owner", "relay", &req).unwrap();
    assert_eq!(
        single.summary.usage.input_tokens.value,
        Some(u64::MAX.to_string())
    );
    assert!(!single.summary.usage.input_tokens.incomplete);
    assert_eq!(single.summary.report_count, 1);
    assert_eq!(single.agents[0].key, a);
    assert_eq!(single.providers[0].key, "p1");
    assert_eq!(single.days[0].group.report_count, 1);
    assert_eq!(single.timeline[0].group.report_count, 1);
    assert_eq!(
        single
            .weekdays
            .iter()
            .map(|r| r.report_count)
            .sum::<usize>(),
        1
    );
    assert_eq!(single.provider_by_date.len(), 1);
    assert_eq!(single.coverage.base.report_count, 1);
    assert_eq!(single.highlights.active_days, 1);
    assert_eq!(single.available_agents.len(), 2);
    assert_eq!(single.summary.costs.wire_reported.value, Some(0.5));
    assert_eq!(single.summary.costs.unknown.value, None);
    req.agent_pubkeys = vec![a, b];
    let both = query(&c, "owner", "relay", &req).unwrap();
    assert_eq!(both.summary.report_count, 2);
    assert!(both.summary.usage.input_tokens.incomplete);
    assert_eq!(
        both.summary.usage.input_tokens.value,
        Some(u64::MAX.to_string())
    );
    assert_eq!(both.summary.request_count, None);
    assert_eq!(both.summary.avg_latency_ms.value, None);
    assert_eq!(both.summary.fallback_count, None);
    assert_eq!(both.summary.costs.unknown.value, Some(0.5));
    assert_eq!(both.providers.len(), 2);
}

#[test]
fn complete_requests_partition_dimensions_without_double_counting() {
    let c = db();
    let a = "a".repeat(64);
    let observation = |id: &str, provider: &str, input: u64| json!({"id":id,"model":"m","attribution":{"provider":provider},"usage":{"inputTokens":input,"outputTokens":null,"totalTokens":null,"costUsd":null},"latencyMs":100,"fallback":false});
    insert(
        &c,
        "one",
        &a,
        Some(30),
        json!({"requestCount":2,"requestsComplete":true,"requests":[observation("1","p1",10),observation("2","p2",20)]}),
    );
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.summary.usage.input_tokens.value.as_deref(), Some("30"));
    assert_eq!(data.summary.request_count.as_deref(), Some("2"));
    assert_eq!(data.providers.len(), 2);
    assert_eq!(
        data.providers[0].usage.input_tokens.value.as_deref(),
        Some("10")
    );
    assert_eq!(
        data.providers[1].usage.input_tokens.value.as_deref(),
        Some("20")
    );
    assert_eq!(data.summary.avg_latency_ms.value, Some(100.0));
    assert_eq!(data.coverage.request_observation_count, 2);
}

#[test]
fn migration_backfill_restart_and_orphan_repair_are_idempotent() {
    let c = db();
    insert(&c, "one", &"a".repeat(64), Some(1), Value::Null);
    analytics_store::migrate(&c).unwrap();
    analytics_store::migrate(&c).unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_usage_metadata", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute("DELETE FROM agent_usage_metadata", []).unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_usage_metadata", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute("DELETE FROM archived_events", []).unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_usage_metadata", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn boundaries_accept_dst_and_adaptive_months_reject_invalid_input() {
    let mut req = request();
    req.day_boundaries = vec![START, START + 23 * 3600, START + 48 * 3600];
    req.bucket_boundaries = vec![START, START + 48 * 3600];
    req.day_labels = vec!["2026-03-08".into(), "2026-03-09".into()];
    assert!(req.validate().is_ok());
    req.day_labels[1] = "2026-03-08".into();
    assert!(req.validate().is_err());
    req = request();
    req.agent_pubkeys = vec!["not-a-key".into()];
    assert!(req.validate().is_err());
    req = request();
    req.bucket_boundaries = vec![i64::MIN, i64::MAX];
    assert!(req.validate().is_err());
}

#[test]
fn provider_diversity_is_normalized_shannon_and_does_not_infer_model() {
    assert_eq!(score(&BTreeMap::new()), None);
    assert_eq!(score(&BTreeMap::from([("p".into(), 5)])), Some(0.0));
    assert_eq!(
        score(&BTreeMap::from([("p".into(), 5), ("q".into(), 5)])),
        Some(100.0)
    );
    let c = db();
    insert(&c, "one", &"a".repeat(64), Some(1), Value::Null);
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.diversity.score, None);
    assert_eq!(data.providers[0].key, UNKNOWN);
    assert_eq!(data.accounts[0].key, UNKNOWN);
}

#[test]
fn hundred_thousand_rows_keep_exact_totals_with_bounded_query_time() {
    let c = db();
    let tx = c.unchecked_transaction().unwrap();
    for n in 0..100_000 {
        insert(&tx, &n.to_string(), &"a".repeat(64), Some(1), Value::Null);
    }
    tx.commit().unwrap();
    let before = std::time::Instant::now();
    let data = query(&c, "owner", "relay", &request()).unwrap();
    eprintln!("100000-row cold analytics: {:?}", before.elapsed());
    assert_eq!(data.summary.report_count, 100_000);
    assert_eq!(
        data.summary.usage.input_tokens.value.as_deref(),
        Some("100000")
    );
    let warm = std::time::Instant::now();
    let data = query(&c, "owner", "relay", &request()).unwrap();
    eprintln!("100000-row warm analytics: {:?}", warm.elapsed());
    assert_eq!(data.summary.report_count, 100_000);
    assert!(warm.elapsed() < std::time::Duration::from_secs(30));
}

#[test]
fn cleared_selection_has_no_metrics_but_keeps_available_agents() {
    let c = db();
    insert(&c, "one", &"a".repeat(64), Some(1), Value::Null);
    let mut req = request();
    req.select_none = true;
    let data = query(&c, "owner", "relay", &req).unwrap();
    assert_eq!(data.summary.report_count, 0);
    assert!(data.agents.is_empty());
    assert!(data.providers.is_empty());
    assert_eq!(data.available_agents.len(), 1);
    assert_eq!(data.coverage.archive_first_reported_at, None);
    req.select_none = false;
    req.bucket_boundaries.iter_mut().for_each(|b| *b += 86400);
    req.day_boundaries = req.bucket_boundaries.clone();
    req.day_labels = vec!["2026-09-20".into()];
    let data = query(&c, "owner", "relay", &req).unwrap();
    assert_eq!(data.summary.report_count, 0);
    assert_eq!(data.coverage.archive_first_reported_at, Some(START + 1));
}

#[test]
fn inconsistent_requests_remain_subordinate_and_are_flagged() {
    let c = db();
    insert(
        &c,
        "one",
        &"a".repeat(64),
        Some(10),
        json!({"requestCount":1,"requestsComplete":true,"requests":[{"id":"r","attribution":{"provider":"p"},"usage":{"inputTokens":99}}]}),
    );
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.summary.usage.input_tokens.value.as_deref(), Some("10"));
    assert_eq!(data.coverage.inconsistent_request_reports, 1);
    assert_eq!(data.coverage.complete_request_reports, 0);
    assert_eq!(data.providers[0].key, UNKNOWN);
}

#[test]
fn missing_request_projection_is_rebuilt_from_canonical_archive() {
    let c = db();
    insert(
        &c,
        "one",
        &"a".repeat(64),
        Some(10),
        json!({"requests":[{"id":"r","usage":{"inputTokens":10}}]}),
    );
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    c.execute("DELETE FROM agent_request_index", []).unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_request_index", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute("DELETE FROM archived_events", []).unwrap();
    analytics_store::backfill(&c, "owner", "relay").unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_request_index", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn analytics_cumulative_accounting_uses_predecessor_outside_window() {
    let c = db();
    let agent = "a".repeat(64);
    for (id, seq, at, total) in [("before", 1, START - 1, 90), ("inside", 2, START + 1, 110)] {
        let raw = json!({"harness":"test","timestamp":chrono::DateTime::from_timestamp(at,0).unwrap().to_rfc3339(),"sessionId":"s","turnSeq":seq,"cumulative":{"inputTokens":total},"turn":{"inputTokens":999},"deltaReliable":true});
        c.execute(
            "INSERT INTO archived_events VALUES ('owner','relay',?1,44200,?2,?3,?4,?3)",
            params![id, agent, at, raw.to_string()],
        )
        .unwrap();
    }
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.summary.usage.input_tokens.value.as_deref(), Some("20"));
    assert_eq!(data.summary.report_count, 1);
}
