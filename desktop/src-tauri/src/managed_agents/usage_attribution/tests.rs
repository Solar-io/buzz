//! Seeding, validation and derived-env tests for owner-editable usage
//! attribution.
//!
//! The cases that matter most are the ones that must produce *nothing*: an
//! agent with no recorded configuration, and an env override that has to beat
//! the derived value. Both are asserted against concrete expected values rather
//! than against the constants that produce them.

use std::collections::BTreeMap;

use super::*;

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

// ── Seeding from observed configuration ──────────────────────────────────────

/// A custom `claude-*` harness has a recorded runtime profile id and nothing
/// else. It gets a grouping key from that id — and, critically, **no
/// provider**: concluding "zai" or "anthropic" from the profile name is the
/// name-shaped inference NIP-AM forbids.
#[test]
fn seeds_from_runtime_profile_without_claiming_a_provider() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    })
    .expect("a recorded runtime is observable configuration");
    assert_eq!(seeded.account_id.as_deref(), Some("harness=claude-code-glm"));
    assert_eq!(
        seeded.account_label.as_deref(),
        Some("Observed harness claude-code-glm")
    );
    assert_eq!(
        seeded.provider, None,
        "a harness profile id is not a provider claim"
    );
    assert!(!seeded.confirmed, "seeded rows are never confirmed");
}

/// The structured `provider` field is recorded configuration, so it is carried
/// verbatim — and the credential the readiness gate requires for it joins the
/// grouping key.
#[test]
fn seeds_structured_provider_and_its_credential_requirement() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("buzz-agent"),
        provider: Some("anthropic"),
        gateway_base_url: None,
    })
    .expect("runtime and provider are observable");
    assert_eq!(
        seeded.account_id.as_deref(),
        Some("harness=buzz-agent;provider=anthropic;credential=ANTHROPIC_API_KEY")
    );
    assert_eq!(seeded.provider.as_deref(), Some("anthropic"));
    assert_eq!(
        seeded.account_label.as_deref(),
        Some("Observed harness buzz-agent · provider anthropic"),
        "the credential requirement groups but is not display metadata"
    );
}

/// The `claude` builtin authenticates through its own CLI login store, so that
/// store is the credential requirement named in the key.
#[test]
fn seeds_cli_login_runtimes_against_their_own_credential_store() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude"),
        ..Default::default()
    })
    .expect("a recorded runtime is observable");
    assert_eq!(
        seeded.account_id.as_deref(),
        Some("harness=claude;credential=claude-cli-login")
    );
}

/// Two agents whose recorded configuration is identical share one account, and
/// an explicitly-configured gateway splits them apart. This is the whole point
/// of the grouping: 33 agents on one harness are one subscription, and the one
/// pointed at a different endpoint is not.
#[test]
fn identical_observed_configuration_groups_and_a_gateway_splits() {
    let plain = ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    };
    let also_plain = ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        provider: None,
        gateway_base_url: None,
    };
    let gatewayed = ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        provider: None,
        gateway_base_url: Some(
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        ),
    };
    let id = |observed| {
        seed_usage_attribution(observed)
            .and_then(|seeded| seeded.account_id)
            .expect("observable configuration seeds an account id")
    };
    assert_eq!(id(plain), id(also_plain));
    assert_ne!(id(plain), id(gatewayed));
    assert_eq!(
        id(gatewayed),
        "harness=claude-code-glm;gateway=token-plan.ap-southeast-1.maas.aliyuncs.com"
    );
}

/// The model identifier is never a seeding signal. Two agents on the same
/// harness running different models are the same subscription until the owner
/// says otherwise — and there is no input on [`ObservedAgentConfig`] that could
/// carry the model in, which is the structural half of this guarantee.
#[test]
fn model_is_not_a_seeding_signal() {
    // `opus` and `fable` agents differ only by model in the real store.
    let observed = ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    };
    let seeded = seed_usage_attribution(observed).expect("seeded");
    for model in ["opus", "fable", "opus[1m]"] {
        assert!(
            !seeded.account_id.as_deref().unwrap_or_default().contains(model),
            "the account id must not mention the model `{model}`"
        );
        assert!(
            !seeded
                .account_label
                .as_deref()
                .unwrap_or_default()
                .contains(model),
            "the label must not mention the model `{model}`"
        );
    }
}

// ── The proof case: nothing observable means nothing at all ──────────────────

/// An agent with no recorded runtime, provider or gateway gets **no**
/// attribution. Not an empty string, not `unknown`, not a shared catch-all
/// bucket — absent.
#[test]
fn runtime_null_yields_absent_attribution_not_a_placeholder() {
    let seeded = seed_usage_attribution(ObservedAgentConfig::default());
    assert_eq!(
        seeded, None,
        "an agent with nothing recorded must not be given an identity"
    );
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("   "),
        provider: Some(""),
        gateway_base_url: Some("   "),
    });
    assert_eq!(
        seeded, None,
        "blank recorded values are not observed configuration"
    );
}

/// The absent case must survive the write path too: seeding an unattributed
/// agent leaves the field `None`, so the record serializes without the key and
/// the spawn exports no attribution variables.
#[test]
fn seeding_an_unobservable_agent_writes_nothing_and_exports_nothing() {
    let mut current: Option<UsageAttributionConfig> = None;
    assert!(!seed_absent_attribution(
        &mut current,
        ObservedAgentConfig::default()
    ));
    assert_eq!(current, None);
    assert!(current
        .as_ref()
        .map(UsageAttributionConfig::derived_env)
        .unwrap_or_default()
        .is_empty());
}

/// An unparseable or host-less gateway is not observed configuration. A typo
/// becomes "nothing observed", never a bogus account.
#[test]
fn unusable_gateway_urls_are_not_observed_configuration() {
    for value in [
        "not a url",
        "/relative/v1",
        "",
        "   ",
        "file:///etc/passwd",
        "http://",
    ] {
        assert_eq!(
            gateway_authority(value),
            None,
            "`{value}` must not yield a gateway authority"
        );
    }
    assert_eq!(
        seed_usage_attribution(ObservedAgentConfig {
            runtime_id: None,
            provider: None,
            gateway_base_url: Some("not a url"),
        }),
        None
    );
}

// ── Gateways never launder a credential into an identity ─────────────────────

/// A URL is a place credentials hide. Userinfo, path, query and fragment are
/// dropped; only host and port survive.
#[test]
fn gateway_authority_discards_userinfo_path_query_and_fragment() {
    assert_eq!(
        gateway_authority("https://sam:sk-live-supersecret@Gateway.Example.COM:8443/v1?k=tok#f")
            .as_deref(),
        Some("gateway.example.com:8443")
    );
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("buzz-agent"),
        provider: Some("openai-compat"),
        gateway_base_url: Some("https://sam:sk-live-supersecret@pilot.example.net:6250/v1"),
    })
    .expect("seeded");
    for field in [
        seeded.account_id.as_deref(),
        seeded.account_label.as_deref(),
        seeded.provider.as_deref(),
    ] {
        let field = field.unwrap_or_default();
        assert!(!field.contains("sk-live-supersecret"), "leaked token: {field}");
        assert!(!field.contains("sam"), "leaked userinfo: {field}");
        assert!(!field.contains("/v1"), "leaked path: {field}");
    }
    assert_eq!(
        seeded.account_id.as_deref(),
        Some("harness=buzz-agent;provider=openai-compat;gateway=pilot.example.net:6250")
    );
}

/// The default port is not invented back into the key, so `https://host` and
/// `https://host:443` are one account rather than two.
#[test]
fn gateway_authority_normalizes_the_default_port() {
    assert_eq!(
        gateway_authority("https://host.example.com"),
        gateway_authority("https://host.example.com:443")
    );
    assert_eq!(
        gateway_authority("https://host.example.com:6250").as_deref(),
        Some("host.example.com:6250")
    );
}

/// Only the documented gateway keys are read out of the layered env, and a
/// credential key sitting next to them is never mistaken for one.
#[test]
fn gateway_lookup_reads_only_gateway_keys() {
    let map = env(&[
        ("OPENAI_COMPAT_API_KEY", "sk-live-should-never-be-read"),
        ("ANTHROPIC_API_KEY", "sk-ant-should-never-be-read"),
        ("OPENAI_COMPAT_BASE_URL", "https://pilot.example.net:6250/v1"),
    ]);
    assert_eq!(
        gateway_base_url_from_env(&map),
        Some("https://pilot.example.net:6250/v1")
    );
    let credentials_only = env(&[
        ("OPENAI_COMPAT_API_KEY", "sk-live-should-never-be-read"),
        ("DATABRICKS_TOKEN", "dapi-should-never-be-read"),
    ]);
    assert_eq!(gateway_base_url_from_env(&credentials_only), None);
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Oversized, control-character, NUL-bearing and reserved values are rejected
/// rather than trimmed, so the value the owner reviewed is the value published.
#[test]
fn validation_rejects_oversized_control_and_reserved_values() {
    let with_account = |account_id: &str| UsageAttributionConfig {
        account_id: Some(account_id.to_string()),
        confirmed: true,
        ..Default::default()
    };
    assert!(with_account("claude-max-cc1").validate().is_ok());
    // 129 bytes is one past the publisher's own cap.
    assert!(with_account(&"a".repeat(129)).validate().is_err());
    assert!(with_account(&"a".repeat(128)).validate().is_ok());
    assert!(with_account("line\nbreak").validate().is_err());
    assert!(with_account("nul\0byte").validate().is_err());
    assert!(with_account("tab\there").validate().is_err());
    assert!(with_account("__unknown__").validate().is_err());
    assert!(with_account("__UNKNOWN__").validate().is_err());
    assert!(with_account(" leading").validate().is_err());
    assert!(with_account("trailing ").validate().is_err());
    assert!(with_account("   ").validate().is_err());
    // A label and a provider are held to the same rules.
    assert!(UsageAttributionConfig {
        account_id: Some("cc1".into()),
        account_label: Some("bad\u{0}label".into()),
        confirmed: true,
        ..Default::default()
    }
    .validate()
    .is_err());
    assert!(UsageAttributionConfig {
        account_id: Some("cc1".into()),
        provider: Some("x".repeat(129)),
        confirmed: true,
        ..Default::default()
    }
    .validate()
    .is_err());
}

/// The same limits are enforced on the owner-edit path, so a malformed IPC
/// caller cannot write a record the publisher would silently drop.
#[test]
fn owner_edits_are_validated_and_marked_confirmed() {
    let applied = apply_owner_attribution(
        Some("  anthropic  ".into()),
        Some(" claude-max-cc1 ".into()),
        Some(" Claude Max CC1 ".into()),
    )
    .expect("trimmed owner input is accepted");
    assert_eq!(applied.provider.as_deref(), Some("anthropic"));
    assert_eq!(applied.account_id.as_deref(), Some("claude-max-cc1"));
    assert_eq!(applied.account_label.as_deref(), Some("Claude Max CC1"));
    assert!(applied.confirmed, "an owner edit is a confirmation");

    assert!(apply_owner_attribution(None, Some("a\nb".into()), None).is_err());
    assert!(apply_owner_attribution(None, Some("x".repeat(129)), None).is_err());
    assert!(apply_owner_attribution(None, Some("__unknown__".into()), None).is_err());
    // A label with no account to attach it to is not an identity.
    assert!(apply_owner_attribution(None, None, Some("Claude Max".into())).is_err());

    // Clearing every field is a real answer: "no subscription identity".
    let cleared = apply_owner_attribution(None, None, None).expect("clearing is allowed");
    assert!(cleared.is_empty());
    assert!(cleared.confirmed);
    assert!(cleared.derived_env().is_empty());
}

/// An account id long enough to exceed the publisher's cap collapses to a
/// digest — and two different over-long configurations stay different, which
/// plain truncation would not guarantee.
#[test]
fn over_long_account_ids_digest_instead_of_colliding() {
    let long = |suffix: &str| {
        seed_usage_attribution(ObservedAgentConfig {
            runtime_id: Some("buzz-agent"),
            provider: Some("openai-compat"),
            gateway_base_url: Some(&format!("https://{}{suffix}.example.com/v1", "n".repeat(120))),
        })
        .and_then(|seeded| seeded.account_id)
        .expect("seeded")
    };
    let first = long("-alpha");
    let second = long("-beta");
    assert!(first.len() <= 128, "digested id must fit the cap");
    assert!(first.starts_with("observed-"));
    assert_ne!(first, second, "digested ids must not collide");
    assert_eq!(first, long("-alpha"), "digested ids must be stable");
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("buzz-agent"),
        provider: Some("openai-compat"),
        gateway_base_url: Some(&format!("https://{}.example.com/v1", "n".repeat(120))),
    })
    .expect("seeded");
    assert!(seeded.validate().is_ok(), "a digested row stays publishable");
    assert!(seeded.account_label.as_deref().unwrap_or_default().len() <= 128);
}

// ── Derived env ──────────────────────────────────────────────────────────────

/// Absent fields export nothing, so "not reported" never arrives as a blank
/// string that the dashboard would have to distinguish from zero.
#[test]
fn derived_env_omits_absent_fields_entirely() {
    let only_provider = UsageAttributionConfig {
        provider: Some("anthropic".into()),
        ..Default::default()
    };
    let derived = only_provider.derived_env();
    assert_eq!(
        derived.get("BUZZ_USAGE_PROVIDER").map(String::as_str),
        Some("anthropic")
    );
    assert_eq!(derived.get("BUZZ_USAGE_ACCOUNT_ID"), None);
    assert_eq!(derived.get("BUZZ_USAGE_ACCOUNT_LABEL"), None);
    assert_eq!(
        derived.get("BUZZ_USAGE_ACCOUNT_CONFIRMED"),
        None,
        "a confirmation flag with no account is invalid per NIP-AM"
    );
}

/// Seeded and confirmed rows differ on the wire, not merely in the store.
#[test]
fn derived_env_publishes_the_confirmation_state() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude"),
        ..Default::default()
    })
    .expect("seeded");
    assert_eq!(
        seeded
            .derived_env()
            .get("BUZZ_USAGE_ACCOUNT_CONFIRMED")
            .map(String::as_str),
        Some("false")
    );
    let confirmed = apply_owner_attribution(
        None,
        Some("claude-max-cc1".into()),
        Some("Claude Max CC1".into()),
    )
    .expect("confirmed");
    let derived = confirmed.derived_env();
    assert_eq!(
        derived
            .get("BUZZ_USAGE_ACCOUNT_CONFIRMED")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        derived.get("BUZZ_USAGE_ACCOUNT_LABEL").map(String::as_str),
        Some("Claude Max CC1")
    );
}

/// A record hand-edited past the validator must not poison the spawn env.
#[test]
fn derived_env_is_empty_for_an_invalid_persisted_row() {
    let corrupt = UsageAttributionConfig {
        account_id: Some("bad\nid".into()),
        account_label: Some("fine".into()),
        confirmed: true,
        ..Default::default()
    };
    assert!(corrupt.validate().is_err());
    assert!(
        corrupt.derived_env().is_empty(),
        "an invalid row publishes nothing at all"
    );
}

// ── Spawn precedence, at the real `Command` boundary ────────────────────────

/// Read the env a command would hand its child, by actually spawning
/// `/usr/bin/env`. This exercises `apply_user_and_attribution_env` — the
/// function `spawn_agent_child` calls — rather than a re-creation of its two
/// loops, so the precedence under test is the shipped precedence.
#[cfg(unix)]
fn spawned_env(
    attribution: Option<&UsageAttributionConfig>,
    descriptor_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut command = std::process::Command::new("/usr/bin/env");
    command.env_clear();
    // An ambient value the desktop itself was launched with. It must not
    // survive into the child unless something actually resolved it.
    command.env("BUZZ_USAGE_ACCOUNT_ID", "ambient-leak-should-be-cleared");
    apply_user_and_attribution_env(&mut command, attribution, descriptor_env);
    let output = command.output().expect("spawn env canary");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("env output is utf-8")
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The derived variables reach the child, and the ambient value the desktop
/// was launched with does not.
#[cfg(unix)]
#[test]
fn spawn_exports_the_derived_attribution_and_clears_ambient_values() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    })
    .expect("seeded");
    let env = spawned_env(Some(&seeded), &BTreeMap::new());
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_ID").map(String::as_str),
        Some("harness=claude-code-glm")
    );
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_LABEL").map(String::as_str),
        Some("Observed harness claude-code-glm")
    );
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_CONFIRMED").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        env.get("BUZZ_USAGE_PROVIDER"),
        None,
        "a seeded harness profile asserts no provider"
    );
}

/// An explicit per-agent `env_vars` entry beats the derived mapping. The
/// expected value is hardcoded and differs from the derived one, so the
/// assertion cannot pass by both sides agreeing.
#[cfg(unix)]
#[test]
fn spawn_lets_an_explicit_env_var_override_the_derived_mapping() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    })
    .expect("seeded");
    assert_eq!(
        seeded.account_id.as_deref(),
        Some("harness=claude-code-glm"),
        "guard: the derived value must differ from the override below"
    );
    let descriptor_env: BTreeMap<String, String> = [
        ("BUZZ_USAGE_ACCOUNT_ID", "zai-coding-plan"),
        ("BUZZ_USAGE_ACCOUNT_LABEL", "Z.ai Coding Plan"),
        ("BUZZ_USAGE_PROVIDER", "zai"),
        ("BUZZ_USAGE_ACCOUNT_CONFIRMED", "true"),
        ("GOOSE_TEMPERATURE", "0.2"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
    .collect();

    let env = spawned_env(Some(&seeded), &descriptor_env);
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_ID").map(String::as_str),
        Some("zai-coding-plan"),
        "an explicit per-agent entry must beat the derived mapping"
    );
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_LABEL").map(String::as_str),
        Some("Z.ai Coding Plan")
    );
    assert_eq!(
        env.get("BUZZ_USAGE_PROVIDER").map(String::as_str),
        Some("zai")
    );
    assert_eq!(
        env.get("BUZZ_USAGE_ACCOUNT_CONFIRMED").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        env.get("GOOSE_TEMPERATURE").map(String::as_str),
        Some("0.2"),
        "unrelated user env must still be applied"
    );
}

/// No mapping and no env entry exports nothing at all — not an empty string,
/// and not the desktop's own ambient value.
#[cfg(unix)]
#[test]
fn spawn_exports_nothing_for_an_unattributed_agent() {
    let env = spawned_env(None, &BTreeMap::new());
    for key in USAGE_ATTRIBUTION_ENV_KEYS {
        assert_eq!(
            env.get(*key),
            None,
            "{key} must be absent, not blank, for an unattributed agent"
        );
    }
}

/// A partial override resolves per key: the owner's account id wins while the
/// derived label still applies.
#[test]
fn effective_attribution_resolves_per_key() {
    let seeded = seed_usage_attribution(ObservedAgentConfig {
        runtime_id: Some("claude"),
        ..Default::default()
    })
    .expect("seeded");
    let resolved = effective_usage_attribution(
        Some(&seeded),
        &env(&[("BUZZ_USAGE_ACCOUNT_ID", "claude-max-cc1")]),
    );
    assert_eq!(
        resolved.get("BUZZ_USAGE_ACCOUNT_ID").map(String::as_str),
        Some("claude-max-cc1")
    );
    assert_eq!(
        resolved.get("BUZZ_USAGE_ACCOUNT_LABEL").map(String::as_str),
        Some("Observed harness claude"),
        "keys the owner did not override keep the derived value"
    );
    assert!(effective_usage_attribution(None, &BTreeMap::new()).is_empty());
}

// ── Seeding is non-destructive ───────────────────────────────────────────────

/// Seeding never overwrites an existing row — confirmed or not. This is what
/// makes it safe to run on every boot, and it is why a confirmation survives
/// restart.
#[test]
fn seeding_never_overwrites_an_existing_row() {
    let observed = ObservedAgentConfig {
        runtime_id: Some("claude-code-glm"),
        ..Default::default()
    };
    let mut confirmed = Some(
        apply_owner_attribution(
            Some("zai".into()),
            Some("zai-coding-plan".into()),
            Some("Z.ai Coding Plan".into()),
        )
        .expect("confirmed"),
    );
    assert!(!seed_absent_attribution(&mut confirmed, observed));
    let row = confirmed.expect("still present");
    assert_eq!(row.account_id.as_deref(), Some("zai-coding-plan"));
    assert!(row.confirmed);

    // An owner who cleared the row does not get it resurrected.
    let mut cleared = Some(apply_owner_attribution(None, None, None).expect("cleared"));
    assert!(!seed_absent_attribution(&mut cleared, observed));
    assert!(cleared.expect("still present").is_empty());

    // An absent row is seeded, once.
    let mut absent: Option<UsageAttributionConfig> = None;
    assert!(seed_absent_attribution(&mut absent, observed));
    assert!(!seed_absent_attribution(&mut absent, observed));
    assert_eq!(
        absent.and_then(|row| row.account_id).as_deref(),
        Some("harness=claude-code-glm")
    );
}
