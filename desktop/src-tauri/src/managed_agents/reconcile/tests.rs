use super::*;
use crate::managed_agents::retention::{get_pending_sync, get_retained_event, mark_synced};
use std::collections::BTreeMap;
use tempfile::TempDir;

fn sample_record(pubkey: &str, name: &str) -> ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "{pubkey}",
            "name": "{name}",
            "relay_url": "wss://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": "You are a test agent.",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "last_started_at": null,
            "last_stopped_at": null,
            "last_exit_code": null,
            "last_error": null
        }}"#
    ))
    .unwrap()
}

fn write_store(dir: &TempDir, records: &[ManagedAgentRecord]) {
    std::fs::write(
        dir.path().join("managed-agents.json"),
        serde_json::to_vec_pretty(records).unwrap(),
    )
    .unwrap();
}

#[test]
fn missing_store_is_noop() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

#[test]
fn fresh_record_is_retained_pending() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &[sample_record("a".repeat(64).as_str(), "agent-one")]);

    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);

    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let pending = get_pending_sync(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, KIND_MANAGED_AGENT);
    assert_eq!(pending[0].d_tag, "a".repeat(64));
    // The retained content is the opt-IN projection — never secrets.
    assert!(!pending[0].raw_event.contains("nsec"));
}

#[test]
fn unchanged_record_does_not_churn_pending_sync() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &[sample_record("b".repeat(64).as_str(), "agent-two")]);

    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);

    // Simulate the flush loop confirming the publish.
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let row = get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &"b".repeat(64),
    )
    .unwrap()
    .unwrap();
    mark_synced(
        &conn,
        row.kind,
        &row.pubkey,
        &row.d_tag,
        row.created_at,
        &row.content,
    )
    .unwrap();
    drop(conn);

    // Second boot with identical disk state: no re-retain, no pending churn.
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    assert!(get_pending_sync(&conn).unwrap().is_empty());
}

#[test]
fn edited_record_is_republished() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let mut record = sample_record("c".repeat(64).as_str(), "agent-three");
    write_store(&dir, &[record.clone()]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);

    // Hand-edit a published field between launches.
    record.system_prompt = Some("You are an edited agent.".to_string());
    write_store(&dir, &[record]);

    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let row = get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &"c".repeat(64),
    )
    .unwrap()
    .unwrap();
    assert!(row.content.contains("edited agent"));
    assert!(row.pending_sync);
}

#[test]
fn excluded_field_edit_is_noop() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let mut record = sample_record("d".repeat(64).as_str(), "agent-four");
    write_store(&dir, &[record.clone()]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);

    // env_vars is excluded from the projection — editing it must not republish.
    record.env_vars = BTreeMap::from([("SOME_KEY".to_string(), "value".to_string())]);
    write_store(&dir, &[record]);

    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

#[test]
fn missing_record_is_never_tombstoned() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let one = sample_record("e".repeat(64).as_str(), "agent-five");
    let two = sample_record("f".repeat(64).as_str(), "agent-six");
    write_store(&dir, &[one.clone(), two]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 2);

    // A truncated store (one of two records) must leave the missing record's
    // retained row untouched — absence never tombstones.
    write_store(&dir, &[one]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);

    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let survivor = get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &"f".repeat(64),
    )
    .unwrap();
    assert!(survivor.is_some(), "missing record must stay retained");
}

#[test]
fn keyless_record_is_skipped() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &[sample_record("", "keyless-agent")]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

#[test]
fn malformed_store_errors_and_preserves_invalid_backup() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let store_path = dir.path().join("managed-agents.json");
    std::fs::write(&store_path, b"[{ this is not json").unwrap();

    let err = reconcile_agents_in_dir(dir.path(), &keys).unwrap_err();
    assert!(err.contains("failed to parse"), "unexpected error: {err}");

    let backup = dir.path().join("managed-agents.json.invalid");
    assert!(backup.exists(), "malformed store must be preserved");
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        b"[{ this is not json".to_vec()
    );
    // Original stays in place so the next boot fails loudly again.
    assert!(store_path.exists());
}

#[test]
fn monotonic_bump_supersedes_future_dated_head() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let mut record = sample_record("1".repeat(64).as_str(), "agent-seven");
    write_store(&dir, &[record.clone()]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);

    // Future-date the retained head (clock skew / interactive same-second bump).
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let owner = keys.public_key().to_hex();
    let head = get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, &"1".repeat(64))
        .unwrap()
        .unwrap();
    let future = RetainedEvent {
        created_at: head.created_at + 3600,
        ..head
    };
    crate::managed_agents::retention::retain_event(&conn, &future).unwrap();
    drop(conn);

    record.system_prompt = Some("New prompt after skew.".to_string());
    write_store(&dir, &[record]);

    // The changed body must land despite the future-dated head.
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, &"1".repeat(64))
        .unwrap()
        .unwrap();
    assert!(row.content.contains("New prompt after skew"));
}

/// The slimming transition: a definition-linked record whose retained row
/// holds the legacy fat projection republishes ONCE (the slimmed shape), and
/// the second boot is a true no-op — the republish wave is one-time.
#[test]
fn slimming_republish_wave_is_one_time() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let mut record = sample_record("e".repeat(64).as_str(), "agent-five");
    record.persona_id = Some("persona-1".to_string());
    record.persona_source_version = Some("abc123".to_string());
    write_store(&dir, &[record]);

    // Seed a SYNCED legacy-fat retained row — the pre-upgrade state — so the
    // first-boot republish below is distinctly the fat→slim content change,
    // not the ordinary fresh-record retain.
    let fat_content = serde_json::json!({
        "name": "agent-five",
        "persona_id": "persona-1",
        "system_prompt": "You are a test agent.",
        "persona_source_version": "abc123",
        "parallelism": 1,
        "respond_to": "owner-only"
    })
    .to_string();
    {
        let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_MANAGED_AGENT,
                pubkey: keys.public_key().to_hex(),
                d_tag: "e".repeat(64),
                content: fat_content,
                created_at: 1,
                raw_event: String::new(),
                pending_sync: false,
            },
        )
        .unwrap();
    }

    // First boot after upgrade: projection content changed (fat -> slim) so
    // the agent republishes.
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let row = get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &"e".repeat(64),
    )
    .unwrap()
    .unwrap();
    assert!(
        !row.content.contains("system_prompt"),
        "definition-linked retained content must be the slimmed shape"
    );
    assert!(!row.content.contains("\"model\""), "model must be slimmed");
    assert!(
        !row.content.contains("\"provider\""),
        "provider must be slimmed"
    );
    assert!(
        !row.content.contains("persona_source_version"),
        "persona_source_version must be slimmed"
    );
    assert!(
        !row.content.contains("abc123"),
        "source version value must be absent"
    );
    assert!(row.pending_sync, "slimmed rewrite must queue for publish");
    drop(conn);

    // Second boot: identical projection — a true no-op, no republish loop.
    assert_eq!(
        reconcile_agents_in_dir(dir.path(), &keys).unwrap(),
        0,
        "second boot must be a no-op (idempotence)"
    );
}

// ── retain_agent_record (interactive-edit engine) ────────────────────────────
//
// #2423: renaming an agent must re-retain its kind:30177 identity record
// IMMEDIATELY, not at the next boot-time reconcile. These tests pin the shared
// engine both the boot reconcile and the interactive edit paths
// (`retain_managed_agent_pending`, persona-rename propagation) run on.

/// A rename re-retains the identity record under the SAME coordinate (the
/// agent pubkey) with the new name, queued for publish, with a created_at
/// strictly past the retained head so the relay's replaceable-event rule
/// accepts it. Without this, the relay keeps the old name→pubkey binding
/// until the next restart — the identity desync in #2423.
#[test]
fn rename_re_retains_identity_record_with_new_name() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let owner = keys.public_key().to_hex();
    let pubkey = "9".repeat(64);
    let mut record = sample_record(&pubkey, "Fizz");

    assert!(retain_agent_record(&conn, &keys, &record, &BTreeMap::new()).unwrap());
    let first = get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, &pubkey)
        .unwrap()
        .unwrap();
    // Simulate the flush loop confirming the initial publish.
    mark_synced(
        &conn,
        first.kind,
        &first.pubkey,
        &first.d_tag,
        first.created_at,
        &first.content,
    )
    .unwrap();

    record.name = "Spark".to_string();
    assert!(
        retain_agent_record(&conn, &keys, &record, &BTreeMap::new()).unwrap(),
        "a renamed record must re-retain its identity record"
    );

    let row = get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, &pubkey)
        .unwrap()
        .unwrap();
    assert_eq!(row.d_tag, pubkey, "coordinate stays keyed by agent pubkey");
    assert!(
        row.content.contains("Spark"),
        "retained identity record must carry the new name"
    );
    assert!(
        !row.content.contains("Fizz"),
        "the stale name must not survive the rename"
    );
    assert!(row.pending_sync, "a rename must queue a republish");
    assert!(
        row.created_at > first.created_at,
        "created_at must bump past the retained head (replaceable-event rule)"
    );
}

/// An unchanged record is a true no-op: no rewrite, no `pending_sync` churn.
/// This is what lets every edit path call the engine unconditionally.
#[test]
fn retain_agent_record_is_noop_when_unchanged() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    let pubkey = "8".repeat(64);
    let record = sample_record(&pubkey, "steady-agent");

    assert!(retain_agent_record(&conn, &keys, &record, &BTreeMap::new()).unwrap());
    let row = get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &pubkey,
    )
    .unwrap()
    .unwrap();
    mark_synced(
        &conn,
        row.kind,
        &row.pubkey,
        &row.d_tag,
        row.created_at,
        &row.content,
    )
    .unwrap();

    assert!(
        !retain_agent_record(&conn, &keys, &record, &BTreeMap::new()).unwrap(),
        "an unchanged projection must not re-retain"
    );
    assert!(
        get_pending_sync(&conn).unwrap().is_empty(),
        "no pending_sync churn for an unchanged record"
    );
}

/// Retain a published (synced) kind:5 tombstone for an agent coordinate.
fn retain_synced_tombstone(dir: &TempDir, keys: &nostr::Keys, agent: &str, created_at: i64) {
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_DELETE,
            pubkey: keys.public_key().to_hex(),
            d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent),
            content: String::new(),
            created_at,
            raw_event: "{}".to_string(),
            pending_sync: false,
        },
    )
    .unwrap();
}

fn head(dir: &TempDir, keys: &nostr::Keys, agent: &str) -> Option<RetainedEvent> {
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        agent,
    )
    .unwrap()
}

fn confirm_publish(dir: &TempDir, keys: &nostr::Keys, agent: &str) {
    let row = head(dir, keys, agent).unwrap();
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    mark_synced(
        &conn,
        row.kind,
        &row.pubkey,
        &row.d_tag,
        row.created_at,
        &row.content,
    )
    .unwrap();
}

/// Live state 2026-09-26 (Evie 1fa92489…, Jared 72665f7c…): deleted (synced
/// tombstone, head row purged), then the same key restored into
/// managed-agents.json. Boot must re-publish a head NEWER than the tombstone
/// (the relay only soft-deletes versions at or before it), exactly once.
#[test]
fn restored_after_delete_republishes_newer_than_tombstone_once() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let agent = "e".repeat(64);
    // Future-dated tombstone proves the floor, not wall-clock luck.
    let tombstone_at = nostr::Timestamp::now().as_secs() as i64 + 10_000;
    retain_synced_tombstone(&dir, &keys, &agent, tombstone_at);
    write_store(&dir, &[sample_record(&agent, "Evie")]);

    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let row = head(&dir, &keys, &agent).unwrap();
    assert!(row.pending_sync);
    assert!(
        row.created_at > tombstone_at,
        "{} <= {tombstone_at}",
        row.created_at
    );

    confirm_publish(&dir, &keys, &agent);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

/// A synced head with unchanged content is normally a no-op — but not when a
/// tombstone at/after it says the relay copy is gone.
#[test]
fn synced_head_older_than_tombstone_is_republished() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    let agent = "f".repeat(64);
    write_store(&dir, &[sample_record(&agent, "Jared Dunn")]);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    confirm_publish(&dir, &keys, &agent);
    let first = head(&dir, &keys, &agent).unwrap().created_at;

    retain_synced_tombstone(&dir, &keys, &agent, first + 5);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let row = head(&dir, &keys, &agent).unwrap();
    assert!(row.pending_sync);
    assert!(row.created_at > first + 5);

    confirm_publish(&dir, &keys, &agent);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

// ── effort (definition env → linked instance's kind:30177) ───────────────────

/// A definition row (key-less, `slug` = persona id) carrying effort env and a
/// linked instance with none of its own.
fn store_with_effort_definition(text_effort: &str) -> Vec<ManagedAgentRecord> {
    let mut definition = sample_record("", "Evie");
    definition.slug = Some("evie".to_string());
    definition.env_vars = BTreeMap::from([
        ("BUZZ_TEXT_TURN_EFFORT".to_string(), text_effort.to_string()),
        ("OPENAI_API_KEY".to_string(), "sk-secret".to_string()),
    ]);
    let mut instance = sample_record(&"e".repeat(64), "Evie");
    instance.persona_id = Some("evie".to_string());
    vec![definition, instance]
}

fn retained_content(dir: &TempDir, keys: &nostr::Keys) -> String {
    let conn = open_retention_db(&dir.path().join("retention.db")).unwrap();
    get_retained_event(
        &conn,
        KIND_MANAGED_AGENT,
        &keys.public_key().to_hex(),
        &"e".repeat(64),
    )
    .unwrap()
    .unwrap()
    .content
}

#[test]
fn reconcile_linked_instance_publishes_definition_effort() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &store_with_effort_definition("low"));
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    let content = retained_content(&dir, &keys);
    assert!(
        content.contains(r#""effort":{"text_turn":"low"}"#),
        "{content}"
    );
    assert!(!content.contains("sk-secret"));
}

#[test]
fn reconcile_second_run_is_noop() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &store_with_effort_definition("low"));
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 0);
}

#[test]
fn definition_env_edit_rereconciles_instance() {
    let dir = TempDir::new().unwrap();
    let keys = nostr::Keys::generate();
    write_store(&dir, &store_with_effort_definition("low"));
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    write_store(&dir, &store_with_effort_definition("high"));
    assert_eq!(reconcile_agents_in_dir(dir.path(), &keys).unwrap(), 1);
    assert!(retained_content(&dir, &keys).contains(r#""text_turn":"high""#));
}
