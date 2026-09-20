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
    assert_eq!(data.accounts[0].group.key, UNKNOWN);
    assert!(
        !data.accounts[0].confirmed,
        "the unknown-account bucket is never a confirmed subscription identity"
    );
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

#[test]
fn unknown_token_fields_are_not_coerced_to_zero() {
    let c = db();
    insert(&c, "one", &"a".repeat(64), None, Value::Null);
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.summary.usage.input_tokens.value, None);
    assert!(data.summary.usage.input_tokens.incomplete);
    assert_eq!(data.summary.usage.total_tokens.value, None);
}

#[test]
fn wire_and_manifest_costs_keep_distinct_provenance() {
    let c = db();
    let a = "a".repeat(64);
    insert(
        &c,
        "wire",
        &a,
        Some(1),
        json!({"costSource":"wire-reported"}),
    );
    insert(
        &c,
        "manifest",
        &a,
        Some(1),
        json!({"costSource":"manifest-estimated"}),
    );
    insert(&c, "old", &a, Some(1), Value::Null);
    let data = query(&c, "owner", "relay", &request()).unwrap();
    assert_eq!(data.summary.costs.wire_reported.value, Some(0.5));
    assert_eq!(data.summary.costs.manifest_estimated.value, Some(0.5));
    assert_eq!(data.summary.costs.unknown.value, Some(0.5));
    assert_eq!(data.coverage.cost_provenance_reports, 2);
}

#[test]
fn dst_short_day_assigns_next_midnight_to_next_day() {
    let c = db();
    insert(&c, "one", &"a".repeat(64), Some(1), Value::Null);
    let at = START + 23 * 3600 + 1;
    c.execute(
        "UPDATE archived_events SET raw_json=json_set(raw_json,'$.timestamp',?1)",
        params![chrono::DateTime::from_timestamp(at, 0)
            .unwrap()
            .to_rfc3339()],
    )
    .unwrap();
    let mut req = request();
    req.day_boundaries = vec![START, START + 23 * 3600, START + 47 * 3600];
    req.bucket_boundaries = req.day_boundaries.clone();
    req.day_labels = vec!["2026-03-08".into(), "2026-03-09".into()];
    let data = query(&c, "owner", "relay", &req).unwrap();
    assert_eq!(data.days[0].group.report_count, 0);
    assert_eq!(data.days[1].group.report_count, 1);
    assert_eq!(data.weekdays[0].report_count, 1);
}

// ── Seeded vs owner-confirmed account identity ───────────────────────────────

/// A seeded account and a confirmed account must be distinguishable in the
/// query output, not just in the store that wrote them. The expected values
/// DIFFER between the two accounts so the assertions discriminate.
#[test]
fn seeded_and_confirmed_accounts_are_reported_apart() {
    let c = db();
    let a = "a".repeat(64);
    insert(
        &c,
        "seeded",
        &a,
        Some(10),
        json!({"attribution":{"accountId":"harness=claude-code-glm",
               "accountLabel":"Observed harness claude-code-glm",
               "accountConfirmed":false}}),
    );
    insert(
        &c,
        "confirmed",
        &a,
        Some(20),
        json!({"attribution":{"accountId":"zai-coding-plan",
               "accountLabel":"Z.ai Coding Plan","accountConfirmed":true,
               "provider":"zai"}}),
    );
    let data = query(&c, "owner", "relay", &request()).unwrap();

    let seeded = data
        .accounts
        .iter()
        .find(|account| account.group.key == "harness=claude-code-glm")
        .expect("the seeded account is reported");
    assert!(
        !seeded.confirmed,
        "a seeded account must read as provisional"
    );
    assert_eq!(seeded.unconfirmed_reports, 1);
    assert_eq!(seeded.confirmed_reports, 0);
    assert_eq!(seeded.group.label, "Observed harness claude-code-glm");

    let confirmed = data
        .accounts
        .iter()
        .find(|account| account.group.key == "zai-coding-plan")
        .expect("the confirmed account is reported");
    assert!(
        confirmed.confirmed,
        "an owner-confirmed account reads as established"
    );
    assert_eq!(confirmed.confirmed_reports, 1);
    assert_eq!(confirmed.unconfirmed_reports, 0);

    assert_eq!(data.coverage.account_reports, 2);
    assert_eq!(
        data.coverage.confirmed_account_reports, 1,
        "coverage must report confirmed identities separately from all identities"
    );
}

/// An absent `accountConfirmed` is unconfirmed, and it must not be readable as
/// a confirmation. Historical events carry no flag at all, so this is the shape
/// every pre-existing archived report has.
#[test]
fn an_account_without_a_confirmation_flag_is_provisional() {
    let c = db();
    insert(
        &c,
        "historical",
        &"a".repeat(64),
        Some(5),
        json!({"attribution":{"accountId":"acct","accountLabel":"Acct"}}),
    );
    let data = query(&c, "owner", "relay", &request()).unwrap();
    let account = data
        .accounts
        .iter()
        .find(|account| account.group.key == "acct")
        .expect("the account is reported");
    assert!(!account.confirmed);
    assert_eq!(account.unconfirmed_reports, 1);
    assert_eq!(data.coverage.account_reports, 1);
    assert_eq!(data.coverage.confirmed_account_reports, 0);
}

/// One still-seeded report keeps the whole account provisional, because the
/// account's totals are the sum of every report in it.
#[test]
fn one_seeded_report_keeps_a_mostly_confirmed_account_provisional() {
    let c = db();
    let a = "a".repeat(64);
    for (id, confirmed) in [("c1", true), ("c2", true), ("s1", false)] {
        insert(
            &c,
            id,
            &a,
            Some(1),
            json!({"attribution":{"accountId":"shared","accountConfirmed":confirmed}}),
        );
    }
    let data = query(&c, "owner", "relay", &request()).unwrap();
    let account = data
        .accounts
        .iter()
        .find(|account| account.group.key == "shared")
        .expect("the account is reported");
    assert_eq!(account.group.report_count, 3);
    assert_eq!(account.confirmed_reports, 2);
    assert_eq!(account.unconfirmed_reports, 1);
    assert!(
        !account.confirmed,
        "two confirmed reports do not launder the third"
    );
}

/// Confirmation counts are per turn, not per request observation: a complete
/// request breakdown must not multiply them.
#[test]
fn request_breakdowns_do_not_multiply_confirmation_counts() {
    let c = db();
    let attribution = json!({"accountId":"acct","accountConfirmed":true});
    insert(
        &c,
        "one",
        &"a".repeat(64),
        Some(4),
        json!({
            "attribution": attribution,
            "requestCount": 2,
            "requestsComplete": true,
            "requests": [
                {"id":"0","model":"m","attribution":attribution,
                 "usage":{"inputTokens":2,"outputTokens":1,"totalTokens":null,"costUsd":null}},
                {"id":"1","model":"m","attribution":attribution,
                 "usage":{"inputTokens":2,"outputTokens":1,"totalTokens":null,"costUsd":null}}
            ]
        }),
    );
    let data = query(&c, "owner", "relay", &request()).unwrap();
    let account = data
        .accounts
        .iter()
        .find(|account| account.group.key == "acct")
        .expect("the account is reported");
    assert_eq!(account.group.report_count, 1, "one turn, not two requests");
    assert_eq!(
        account.confirmed_reports, 1,
        "two request observations of one turn count once"
    );
    assert!(account.confirmed);
    assert_eq!(data.coverage.confirmed_account_reports, 1);
}
