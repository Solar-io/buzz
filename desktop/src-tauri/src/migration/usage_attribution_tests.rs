//! Boot-seeding tests over a store shaped like the real one.
//!
//! The fixture mirrors the distribution actually on disk: many agents on one
//! custom harness, a handful on a builtin, one behind its own gateway, and
//! several with no recorded runtime at all. The last group is the proof case —
//! it must come out of seeding with no attribution whatsoever.

use super::*;

fn definition(slug: &str, runtime: Option<&str>, provider: Option<&str>, env: Value) -> Value {
    serde_json::json!({
        "pubkey": "",
        "slug": slug,
        "name": slug,
        "runtime": runtime,
        "provider": provider,
        "env_vars": env,
    })
}

fn instance(pubkey: &str, persona_id: Option<&str>, runtime: Option<&str>, provider: Option<&str>, env: Value) -> Value {
    serde_json::json!({
        "pubkey": pubkey,
        "name": pubkey,
        "persona_id": persona_id,
        "runtime": runtime,
        "provider": provider,
        "env_vars": env,
    })
}

fn attribution(record: &Value) -> Option<&serde_json::Map<String, Value>> {
    record.get("usage_attribution").and_then(Value::as_object)
}

fn account_id(record: &Value) -> Option<&str> {
    attribution(record)?.get("account_id")?.as_str()
}

#[test]
fn seeds_one_account_per_distinct_observed_configuration() {
    let mut records = vec![
        definition("glm-a", Some("claude-code-glm"), None, serde_json::json!({})),
        definition("glm-b", Some("claude-code-glm"), None, serde_json::json!({})),
        definition("cc", Some("claude"), None, serde_json::json!({})),
        definition(
            "aliyun",
            Some("claude-code-glm"),
            None,
            serde_json::json!({
                "OPENAI_COMPAT_BASE_URL":
                    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
            }),
        ),
        definition("builtin-fizz", None, None, serde_json::json!({})),
    ];
    assert_eq!(seed_records(&mut records), 4, "the runtime-less row is skipped");

    assert_eq!(account_id(&records[0]), Some("harness=claude-code-glm"));
    assert_eq!(
        account_id(&records[1]),
        account_id(&records[0]),
        "identical observed configuration is one account"
    );
    assert_eq!(
        account_id(&records[2]),
        Some("harness=claude;credential=claude-cli-login")
    );
    assert_eq!(
        account_id(&records[3]),
        Some("harness=claude-code-glm;gateway=token-plan.ap-southeast-1.maas.aliyuncs.com")
    );
    assert_eq!(
        records[4].get("usage_attribution"),
        None,
        "a record with nothing recorded gets no attribution key at all"
    );
    for record in &records[..4] {
        assert_eq!(
            attribution(record).and_then(|a| a.get("confirmed")),
            Some(&Value::Bool(false)),
            "every seeded row is unconfirmed"
        );
    }
}

/// A linked instance inherits its definition's gateway at spawn, so it must be
/// filed under the same account as that definition — not a second one.
#[test]
fn instances_inherit_the_definition_env_layer_when_grouping() {
    let mut records = vec![
        definition(
            "pilot",
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://pilot.example.net:6250/v1" }),
        ),
        instance(
            "a".repeat(64).as_str(),
            Some("pilot"),
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({}),
        ),
    ];
    assert_eq!(seed_records(&mut records), 2);
    assert_eq!(
        account_id(&records[1]),
        account_id(&records[0]),
        "an instance must not be split from the definition whose gateway it inherits"
    );
    assert_eq!(
        account_id(&records[0]),
        Some("harness=buzz-agent;provider=openai-compat;gateway=pilot.example.net:6250")
    );
}

/// An instance override beats the inherited layer, exactly as `merged_user_env`
/// would at spawn.
#[test]
fn an_instance_gateway_override_splits_it_from_its_definition() {
    let mut records = vec![
        definition(
            "pilot",
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://pilot.example.net:6250/v1" }),
        ),
        instance(
            "b".repeat(64).as_str(),
            Some("pilot"),
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://other.example.net/v1" }),
        ),
    ];
    assert_eq!(seed_records(&mut records), 2);
    assert_ne!(account_id(&records[1]), account_id(&records[0]));
    assert_eq!(
        account_id(&records[1]),
        Some("harness=buzz-agent;provider=openai-compat;gateway=other.example.net")
    );
}

/// The model is never consulted, so two agents that differ only by model stay
/// in one account. (This is the 21 `opus` + 12 `fable` case.)
#[test]
fn agents_differing_only_by_model_share_one_account() {
    let with_model = |slug: &str, model: &str| {
        let mut record = definition(slug, Some("claude-code-glm"), None, serde_json::json!({}));
        record.as_object_mut().unwrap().insert(
            "model".to_string(),
            Value::String(model.to_string()),
        );
        record
    };
    let mut records = vec![with_model("a", "opus"), with_model("b", "fable")];
    assert_eq!(seed_records(&mut records), 2);
    assert_eq!(account_id(&records[0]), account_id(&records[1]));
}

/// Running twice writes nothing the second time, and never disturbs a row an
/// owner has confirmed or deliberately cleared.
#[test]
fn seeding_is_idempotent_and_preserves_owner_decisions() {
    let mut records = vec![
        definition("glm", Some("claude-code-glm"), None, serde_json::json!({})),
        serde_json::json!({
            "pubkey": "",
            "slug": "confirmed",
            "runtime": "claude-code-glm",
            "usage_attribution": {
                "provider": "zai",
                "account_id": "zai-coding-plan",
                "account_label": "Z.ai Coding Plan",
                "confirmed": true
            }
        }),
        serde_json::json!({
            "pubkey": "",
            "slug": "cleared",
            "runtime": "claude",
            "usage_attribution": { "confirmed": true }
        }),
    ];
    assert_eq!(seed_records(&mut records), 1);
    let first_pass = records.clone();
    assert_eq!(
        seed_records(&mut records),
        0,
        "a second boot must write nothing"
    );
    assert_eq!(records, first_pass);
    assert_eq!(account_id(&records[1]), Some("zai-coding-plan"));
    assert_eq!(
        attribution(&records[1]).and_then(|a| a.get("confirmed")),
        Some(&Value::Bool(true)),
        "a confirmation must survive a re-seed"
    );
    assert_eq!(
        account_id(&records[2]),
        None,
        "an owner-cleared row must not be resurrected"
    );
    assert_eq!(
        attribution(&records[2]).and_then(|a| a.get("confirmed")),
        Some(&Value::Bool(true))
    );
}

/// A store whose values are the wrong JSON type must not panic or invent an
/// identity out of them.
#[test]
fn malformed_records_are_skipped_rather_than_guessed_at() {
    let mut records = vec![
        serde_json::json!({ "pubkey": "", "slug": "x", "runtime": 7, "env_vars": "nope" }),
        serde_json::json!("not an object"),
        serde_json::json!({ "pubkey": "", "slug": "y", "runtime": "   " }),
        serde_json::json!({
            "pubkey": "",
            "slug": "z",
            "runtime": "buzz-agent",
            "env_vars": { "OPENAI_COMPAT_BASE_URL": 42 }
        }),
    ];
    assert_eq!(seed_records(&mut records), 1);
    assert_eq!(records[0].get("usage_attribution"), None);
    assert_eq!(records[2].get("usage_attribution"), None);
    assert_eq!(
        account_id(&records[3]),
        Some("harness=buzz-agent"),
        "a non-string gateway is not observed configuration"
    );
}

/// A credential sitting in `env_vars` is never read — not as a gateway, not as
/// an identity, and not into the label.
#[test]
fn credentials_in_env_vars_never_reach_the_seeded_row() {
    let mut records = vec![definition(
        "creds",
        Some("buzz-agent"),
        Some("anthropic"),
        serde_json::json!({
            "ANTHROPIC_API_KEY": "sk-ant-should-never-appear",
            "OPENAI_COMPAT_API_KEY": "sk-live-should-never-appear",
            "DATABRICKS_TOKEN": "dapi-should-never-appear"
        }),
    )];
    assert_eq!(seed_records(&mut records), 1);
    let serialized = serde_json::to_string(&records[0].get("usage_attribution")).unwrap();
    for secret in [
        "sk-ant-should-never-appear",
        "sk-live-should-never-appear",
        "dapi-should-never-appear",
    ] {
        assert!(
            !serialized.contains(secret),
            "seeded row leaked `{secret}`: {serialized}"
        );
    }
    assert_eq!(
        account_id(&records[0]),
        Some("harness=buzz-agent;provider=anthropic;credential=ANTHROPIC_API_KEY"),
        "only the credential's NAME is a grouping signal"
    );
}
