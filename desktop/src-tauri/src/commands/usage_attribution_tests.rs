//! Grouping and owner-edit tests for the usage-attribution IPC surface.
//!
//! These exercise the two functions the commands delegate to
//! (`overview_from_records`, `confirm_account_in_records`) rather than
//! re-creating their logic, so a change to either is a change to what is
//! tested.

use std::collections::BTreeMap;

use super::*;
use crate::managed_agents::{
    usage_attribution::{seed_usage_attribution, ObservedAgentConfig},
    BackendKind, RespondTo,
};

fn record(name: &str, pubkey: &str, slug: Option<&str>, runtime: Option<&str>) -> ManagedAgentRecord {
    ManagedAgentRecord {
        pubkey: pubkey.to_string(),
        name: name.to_string(),
        persona_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: "ws://localhost:3000".to_string(),
        avatar_url: None,
        acp_command: "buzz-acp".to_string(),
        agent_command: "goose".to_string(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 300,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: BTreeMap::new(),
        start_on_app_launch: false,
        auto_restart_on_config_change: true,
        runtime_pid: None,
        backend: BackendKind::Local,
        backend_agent_id: None,
        provider_policy_pending: false,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: String::new(),
        updated_at: String::new(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: RespondTo::OwnerOnly,
        respond_to_allowlist: vec![],
        display_name: None,
        slug: slug.map(str::to_string),
        runtime: runtime.map(str::to_string),
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Vec::new(),
        definition_parallelism: None,
        relay_mesh: None,
        effort_level: None,
        usage_attribution: None,
    }
}

fn seeded(runtime: &str) -> Option<UsageAttributionConfig> {
    seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some(runtime),
        ..Default::default()
    })
}

#[test]
fn overview_groups_seeded_agents_and_separates_the_unattributed() {
    let mut glm_a = record("Acid Burn", "a".repeat(64).as_str(), None, Some("claude-code-glm"));
    glm_a.usage_attribution = seeded("claude-code-glm");
    let mut glm_b = record("Crash Override", "b".repeat(64).as_str(), None, Some("claude-code-glm"));
    glm_b.usage_attribution = seeded("claude-code-glm");
    let mut cc = record("Richard", "c".repeat(64).as_str(), None, Some("claude"));
    cc.usage_attribution = seeded("claude");
    // Nothing observable: no runtime at all.
    let fizz = record("Fizz", "", Some("builtin:fizz"), None);
    // The owner said: no subscription identity.
    let mut honey = record("Honey", "", Some("builtin:honey"), None);
    honey.usage_attribution = Some(
        crate::managed_agents::usage_attribution::apply_owner_attribution(None, None, None)
            .expect("clearing is allowed"),
    );

    let overview = overview_from_records(&[glm_a, glm_b, cc, fizz, honey]);
    assert_eq!(overview.accounts.len(), 2);
    let glm = overview
        .accounts
        .iter()
        .find(|account| account.account_id == "harness=claude-code-glm")
        .expect("the glm account exists");
    assert_eq!(glm.agents.len(), 2);
    assert!(
        !glm.confirmed,
        "a seeded account must render as provisional"
    );
    assert_eq!(
        glm.account_label.as_deref(),
        Some("Observed harness claude-code-glm")
    );
    assert_eq!(
        glm.provider, None,
        "a harness profile id is never published as a provider"
    );
    assert_eq!(
        overview.unattributed.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        vec!["Fizz"],
        "an agent with nothing observable is reported unattributed, not as an account"
    );
    assert_eq!(
        overview.declined.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        vec!["Honey"]
    );
    // A definition row reports its slug and no pubkey; an instance the reverse.
    assert_eq!(overview.unattributed[0].pubkey, None);
    assert_eq!(overview.unattributed[0].slug.as_deref(), Some("builtin:fizz"));
    assert_eq!(glm.agents[0].pubkey.as_deref(), Some("a".repeat(64).as_str()));
}

/// Confirming an account rewrites every agent filed under it in one edit —
/// the reason this is an account-level command and not a per-agent one.
#[test]
fn confirming_an_account_rewrites_every_member() {
    let mut records: Vec<ManagedAgentRecord> = (0..3)
        .map(|i| {
            let mut r = record(
                &format!("glm-{i}"),
                &format!("{i}").repeat(64),
                None,
                Some("claude-code-glm"),
            );
            r.usage_attribution = seeded("claude-code-glm");
            r
        })
        .collect();
    let mut other = record("cc", "f".repeat(64).as_str(), None, Some("claude"));
    other.usage_attribution = seeded("claude");
    records.push(other);

    let applied = crate::managed_agents::usage_attribution::apply_owner_attribution(
        Some("zai".into()),
        Some("zai-coding-plan".into()),
        Some("Z.ai Coding Plan".into()),
    )
    .expect("valid owner edit");
    let matched = confirm_account_in_records(
        &mut records,
        "harness=claude-code-glm",
        &applied,
        "2026-09-19T00:00:00Z",
    );
    assert_eq!(matched, 3);

    let overview = overview_from_records(&records);
    let zai = overview
        .accounts
        .iter()
        .find(|account| account.account_id == "zai-coding-plan")
        .expect("the renamed account exists");
    assert_eq!(zai.agents.len(), 3);
    assert!(zai.confirmed, "an owner edit confirms the account");
    assert_eq!(zai.account_label.as_deref(), Some("Z.ai Coding Plan"));
    assert_eq!(zai.provider.as_deref(), Some("zai"));
    // The untouched account is still exactly as seeded.
    let cc = overview
        .accounts
        .iter()
        .find(|account| account.account_id == "harness=claude;credential=claude-cli-login")
        .expect("the other account is untouched");
    assert!(!cc.confirmed);
    assert_eq!(
        records[3].updated_at,
        "",
        "a record outside the group must not be restamped"
    );
    assert_eq!(records[0].updated_at, "2026-09-19T00:00:00Z");
}

/// An account with one still-seeded member stays provisional. The whole point
/// of the marker is that the dashboard is adding these agents' usage together.
#[test]
fn a_partially_confirmed_account_stays_provisional() {
    let mut confirmed_member = record("a", "a".repeat(64).as_str(), None, Some("claude"));
    confirmed_member.usage_attribution = Some(
        crate::managed_agents::usage_attribution::apply_owner_attribution(
            Some("anthropic".into()),
            Some("claude-max-cc1".into()),
            Some("Claude Max CC1".into()),
        )
        .expect("valid"),
    );
    let mut seeded_member = record("b", "b".repeat(64).as_str(), None, Some("claude"));
    seeded_member.usage_attribution = Some(UsageAttributionConfig {
        account_id: Some("claude-max-cc1".into()),
        account_label: Some("Observed harness claude".into()),
        confirmed: false,
        provider: None,
    });

    // Order must not matter: the confirmed member's labels win either way, and
    // the account is provisional either way.
    for records in [
        vec![confirmed_member.clone(), seeded_member.clone()],
        vec![seeded_member, confirmed_member],
    ] {
        let overview = overview_from_records(&records);
        let account = &overview.accounts[0];
        assert_eq!(account.agents.len(), 2);
        assert!(
            !account.confirmed,
            "one seeded member keeps the whole account provisional"
        );
        assert_eq!(
            account.account_label.as_deref(),
            Some("Claude Max CC1"),
            "a seeded label must never overwrite the owner's"
        );
        assert_eq!(account.provider.as_deref(), Some("anthropic"));
    }
}

/// An account that exists nowhere in the store is a caller error, not a silent
/// no-op that leaves the UI claiming an edit landed.
#[test]
fn confirming_an_unknown_account_matches_nothing() {
    let mut records = vec![record("a", "a".repeat(64).as_str(), None, Some("claude"))];
    records[0].usage_attribution = seeded("claude");
    let applied = crate::managed_agents::usage_attribution::apply_owner_attribution(
        None,
        Some("does-not-exist".into()),
        None,
    )
    .expect("valid");
    assert_eq!(
        confirm_account_in_records(&mut records, "harness=nope", &applied, "now"),
        0
    );
    assert_eq!(
        records[0].usage_attribution.as_ref().and_then(|a| a.account_id.as_deref()),
        Some("harness=claude;credential=claude-cli-login"),
        "a non-matching record must be left alone"
    );
}

/// The overview serializes camelCase, which is what the frontend reads.
#[test]
fn overview_serializes_camel_case() {
    let mut records = vec![record("a", "a".repeat(64).as_str(), None, Some("claude"))];
    records[0].usage_attribution = seeded("claude");
    let json = serde_json::to_value(overview_from_records(&records)).expect("serializes");
    let account = &json["accounts"][0];
    assert!(account["accountId"].is_string());
    assert!(account["accountLabel"].is_string());
    assert_eq!(account["confirmed"], serde_json::Value::Bool(false));
    assert!(json["unattributed"].is_array());
    assert!(json["declined"].is_array());
}
