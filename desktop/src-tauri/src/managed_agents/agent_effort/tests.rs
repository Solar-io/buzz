use super::*;

fn record(effort_level: Option<&str>, env: &[(&str, &str)]) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "a".repeat(64),
        "name": "agent",
        "persona_id": "evie",
        "relay_url": "wss://localhost:3000",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "last_started_at": null,
        "last_stopped_at": null,
        "last_exit_code": null,
        "last_error": null
    }))
    .unwrap();
    record.effort_level = effort_level.map(str::to_string);
    record.env_vars = env_map(env);
    record
}

fn env_map(env: &[(&str, &str)]) -> BTreeMap<String, String> {
    env.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn agent_env_overrides_definition_env() {
    let definition = env_map(&[("BUZZ_TEXT_TURN_EFFORT", "low")]);
    let agent = record(None, &[("BUZZ_TEXT_TURN_EFFORT", "high")]);
    let effort = resolve_agent_effort(&agent, &definition).unwrap();
    assert_eq!(effort.text_turn.as_deref(), Some("high"));
}

#[test]
fn effort_level_beats_env_acp() {
    let definition = env_map(&[("BUZZ_ACP_EFFORT_LEVEL", "low")]);
    let effort = resolve_agent_effort(&record(Some("max"), &[]), &definition).unwrap();
    assert_eq!(effort.acp.as_deref(), Some("max"));
    let effort = resolve_agent_effort(&record(None, &[]), &definition).unwrap();
    assert_eq!(effort.acp.as_deref(), Some("low"));
}

#[test]
fn invalid_values_are_not_published() {
    let seventeen = "x".repeat(17);
    let definition = env_map(&[
        ("BUZZ_TEXT_TURN_EFFORT", "High!"),
        ("BUZZ_VOICE_TURN_EFFORT", seventeen.as_str()),
        ("BUZZ_AGENT_THINKING_EFFORT", "sk-secret"),
        ("CLAUDE_CODE_EFFORT_LEVEL", "medium"),
    ]);
    let effort = resolve_agent_effort(&record(Some("rm -rf"), &[]), &definition).unwrap();
    assert_eq!(
        effort,
        AgentEffortConfig {
            claude_code: Some("medium".into()),
            ..Default::default()
        }
    );
}

#[test]
fn unset_and_blank_are_absent() {
    let definition = env_map(&[
        ("BUZZ_TEXT_TURN_EFFORT", "unset"),
        ("BUZZ_VOICE_TURN_EFFORT", "   "),
    ]);
    assert_eq!(resolve_agent_effort(&record(None, &[]), &definition), None);
}

#[test]
fn all_empty_resolves_none() {
    let definition = env_map(&[("OPENAI_API_KEY", "sk-secret")]);
    assert_eq!(resolve_agent_effort(&record(None, &[]), &definition), None);
}

#[test]
fn max_context_parses_positive_u64_only() {
    for (raw, expected) in [
        ("555000", Some(555_000)),
        (" 42 ", Some(42)),
        ("0", None),
        ("abc", None),
        ("+5", None),
        ("-5", None),
        ("9007199254740992", None),
        ("9007199254740991", Some(9_007_199_254_740_991)),
    ] {
        let agent = record(None, &[("BUZZ_AGENT_MAX_CONTEXT_TOKENS", raw)]);
        let got = resolve_agent_effort(&agent, &BTreeMap::new()).and_then(|e| e.max_context_tokens);
        assert_eq!(got, expected, "raw {raw:?}");
    }
}

#[test]
fn definition_env_for_finds_linked_definition_only() {
    let mut definition = record(None, &[("BUZZ_TEXT_TURN_EFFORT", "low")]);
    definition.pubkey = String::new();
    definition.slug = Some("evie".into());
    definition.persona_id = None;
    let instance = record(None, &[]);
    let store = vec![definition, instance.clone()];
    assert_eq!(
        definition_env_for(&instance, &store).get("BUZZ_TEXT_TURN_EFFORT"),
        Some(&"low".to_string())
    );
    let mut standalone = instance;
    standalone.persona_id = None;
    assert!(definition_env_for(&standalone, &store).is_empty());
}

fn fixture(name: &str) -> serde_json::Value {
    let path = format!(
        "{}/../../test-fixtures/agent-effort/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn str_env(value: &serde_json::Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect()
}

#[test]
fn fixture_corpus_matches() {
    let limits = fixture("limits.json");
    let cases = fixture("cases.json")["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len() as u64, limits["cases"].as_u64().unwrap());
    let mut ran = 0u64;
    for case in cases.iter().filter(|c| c.get("web_only").is_none()) {
        let name = case["name"].as_str().unwrap();
        let mut agent = record(case["record_effort_level"].as_str(), &[]);
        agent.env_vars = str_env(&case["agent_env"]);
        let resolved = resolve_agent_effort(&agent, &str_env(&case["definition_env"]));
        let wire = serde_json::to_value(&resolved).unwrap();
        assert_eq!(wire, case["wire"], "case {name}");
        ran += 1;
    }
    assert_eq!(ran, limits["rustCases"].as_u64().unwrap());
}
