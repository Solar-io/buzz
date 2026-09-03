use super::*;

fn provider_record(deployed: bool) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "agent", "name": "Agent", "relay_url": "", "acp_command": "",
        "agent_command": "", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .unwrap();
    record.backend = crate::managed_agents::BackendKind::Provider {
        id: "provider".into(),
        config: serde_json::json!({}),
    };
    record.backend_agent_id = deployed.then(|| "deployment".to_string());
    record
}

#[test]
fn deployed_provider_rejects_access_edits_that_cannot_be_revoked() {
    let error = ensure_access_policy_change_supported(&provider_record(true), true)
        .expect_err("deployed provider access edit must fail closed");
    assert!(error.contains("no explicit stop or revocation acknowledgement"));
}

#[test]
fn undeployed_provider_accepts_access_edits() {
    ensure_access_policy_change_supported(&provider_record(false), true)
        .expect("no running provider deployment can retain stale access");
}

// ── Phase-2 env patch semantics (web admin commands, plan §3) ───────────────

use std::collections::BTreeMap;

fn env_record(pairs: &[(&str, &str)]) -> ManagedAgentRecord {
    let mut record = provider_record(false);
    record.backend = crate::managed_agents::BackendKind::Local;
    record.env_vars = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    record
}

fn patch(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.map(|s| s.to_string())))
        .collect()
}

fn replace(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn env_of(record: &ManagedAgentRecord) -> Vec<(String, String)> {
    record
        .env_vars
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

#[test]
fn env_vars_patch_merges_sets_and_deletes() {
    let mut record = env_record(&[("A", "0"), ("B", "2"), ("C", "3")]);
    apply_env_vars_update(&mut record, None, Some(patch(&[("A", Some("1")), ("B", None)])))
        .expect("a well-formed patch applies");
    // A overwritten, B deleted, C untouched, missing-key delete is a no-op.
    assert_eq!(
        record.env_vars,
        BTreeMap::from([
            ("A".to_string(), "1".to_string()),
            ("C".to_string(), "3".to_string()),
        ])
    );
    // Deleting a key that is not present succeeds as a no-op.
    apply_env_vars_update(&mut record, None, Some(patch(&[("GONE", None)])))
        .expect("deleting a missing key is a no-op success");
    assert_eq!(env_of(&record).len(), 2);
}

#[test]
fn env_vars_patch_rejects_reserved_key_and_leaves_record_untouched() {
    let mut record = env_record(&[("A", "0"), ("B", "2"), ("C", "3")]);
    let error = apply_env_vars_update(
        &mut record,
        None,
        Some(patch(&[("BUZZ_PRIVATE_KEY", Some("x"))])),
    )
    .expect_err("a reserved key in the patch must reject the whole update");
    assert!(error.contains("BUZZ_PRIVATE_KEY"), "{error}");
    assert_eq!(
        record.env_vars,
        BTreeMap::from([
            ("A".to_string(), "0".to_string()),
            ("B".to_string(), "2".to_string()),
            ("C".to_string(), "3".to_string()),
        ]),
        "a rejected patch must not mutate the record"
    );
}

#[test]
fn env_vars_patch_applies_after_replace() {
    let mut record = env_record(&[("A", "0")]);
    apply_env_vars_update(
        &mut record,
        Some(replace(&[("X", "1")])),
        Some(patch(&[("X", Some("2")), ("Y", None)])),
    )
    .expect("a legal replace+patch pair applies");
    // Literal code order is the precedence: patch lands on top of replace,
    // and the patch's delete of a replace-introduced key removes it.
    assert_eq!(
        record.env_vars,
        BTreeMap::from([("X".to_string(), "2".to_string())])
    );
}

#[test]
fn patch_total_size_cap_rejects_atomically() {
    let mut record = env_record(&[]);
    // Nine sub-per-value-cap entries whose SUM crosses MAX_ENV_TOTAL_BYTES —
    // this pins the total-cap branch specifically, not the per-value one.
    let mut big = BTreeMap::new();
    for i in 0..9 {
        big.insert(format!("K{i}"), Some("v".repeat(30_000)));
    }
    let error = apply_env_vars_update(&mut record, None, Some(big))
        .expect_err("a patch past the total cap must reject the whole update");
    assert!(error.contains("total env var payload"), "{error}");
    assert!(
        record.env_vars.is_empty(),
        "a rejected patch must not mutate the record"
    );
}

#[test]
fn update_applies_avatar_timeouts_start_on_launch() {
    // Set + clear sentinels.
    let mut record = env_record(&[]);
    record.avatar_url = Some("old".to_string());
    record.max_turn_duration_seconds = Some(1800);
    record.start_on_app_launch = true;
    let changed = apply_agent_scalar_updates(
        &mut record,
        Some(" u ".to_string()),
        Some(600),
        Some(0),
        Some(false),
    );
    assert!(changed, "an avatar change must signal a republish");
    assert_eq!(record.avatar_url.as_deref(), Some("u"));
    assert_eq!(record.idle_timeout_seconds, Some(600));
    assert_eq!(record.max_turn_duration_seconds, None, "0 clears");
    assert_eq!(record.start_on_app_launch, false);

    // Absent fields leave the record's values untouched.
    let mut record = env_record(&[]);
    record.avatar_url = Some("keep".to_string());
    record.idle_timeout_seconds = Some(120);
    record.max_turn_duration_seconds = Some(240);
    record.start_on_app_launch = true;
    let changed = apply_agent_scalar_updates(&mut record, None, None, None, None);
    assert!(!changed);
    assert_eq!(record.avatar_url.as_deref(), Some("keep"));
    assert_eq!(record.idle_timeout_seconds, Some(120));
    assert_eq!(record.max_turn_duration_seconds, Some(240));
    assert_eq!(record.start_on_app_launch, true);

    // "" and whitespace clear the avatar; clearing an already-clear avatar
    // is not a change.
    let mut record = env_record(&[]);
    record.avatar_url = Some("old".to_string());
    assert!(apply_agent_scalar_updates(
        &mut record,
        Some("".to_string()),
        None,
        None,
        None
    ));
    assert_eq!(record.avatar_url, None);
    let mut record = env_record(&[]);
    record.avatar_url = None;
    assert!(!apply_agent_scalar_updates(
        &mut record,
        Some("   ".to_string()),
        None,
        None,
        None
    ));
    assert_eq!(record.avatar_url, None);

    // Idle 0 clears too (same convention as max turn duration).
    let mut record = env_record(&[]);
    record.idle_timeout_seconds = Some(90);
    apply_agent_scalar_updates(&mut record, None, Some(0), None, None);
    assert_eq!(record.idle_timeout_seconds, None);

    // Non-local backends never persist a launch flag (mirrors create).
    let mut record = env_record(&[]);
    record.start_on_app_launch = false;
    record.backend = crate::managed_agents::BackendKind::Provider {
        id: "provider".into(),
        config: serde_json::json!({}),
    };
    apply_agent_scalar_updates(&mut record, None, None, None, Some(true));
    assert_eq!(record.start_on_app_launch, false);
}

#[test]
fn profile_changed_triggers_on_avatar_only_edit() {
    assert!(profile_republish_needed(false, true), "avatar-only edit");
    assert!(profile_republish_needed(true, false), "rename-only edit");
    assert!(profile_republish_needed(true, true));
    assert!(!profile_republish_needed(false, false));
}
