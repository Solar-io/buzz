use super::{
    default_config_path, is_voice_turn_content, parse_agent_effort_file, resolve_effort_override,
    resolve_model_override, AgentEffortFile, EffortClass, EffortFileEntry, EffortOverride,
    TurnKnobs, VoiceTurnOverrides, VIDEO_TURN_MARKER, VOICE_TURN_MARKER, WILDCARD_KEY,
};

const PUBKEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn identity_knobs(raw: &str) -> TurnKnobs<'_> {
    TurnKnobs {
        agent_pubkey: Some(PUBKEY),
        agent_name: Some("eViE"),
        text_env: Some("default"),
        voice_env: Some("default"),
        model_env: Some("env-model"),
        file_content: Some(raw),
    }
}

#[test]
fn pubkey_entry_beats_name_entry() {
    let raw = format!(
        r#"{{"{PUBKEY}":{{"text":"high","voice":"low","voiceModel":"key-model"}},
        "Evie":{{"text":"medium","voice":"max","voiceModel":"name-model"}},
        "*":{{"text":"max","voice":"high","voiceModel":"wild-model"}}}}"#
    );
    let knobs = identity_knobs(&raw);
    let text = VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs);
    assert_eq!(text.text_effort.as_deref(), Some("high"));
    let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hello"), &knobs);
    assert_eq!(voice.effort.as_deref(), Some("low"));
    assert_eq!(voice.model.as_deref(), Some("key-model"));
}

#[test]
fn name_entry_still_applies_without_pubkey_entry() {
    let knobs = identity_knobs(
        r#"{"Evie":{"text":"medium","voice":"high","voiceModel":"name-model"},
        "*":{"text":"low","voice":"low","voiceModel":"wild-model"}}"#,
    );
    let text = VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs);
    assert_eq!(text.text_effort.as_deref(), Some("medium"));
    let voice = VoiceTurnOverrides::resolve_for_turn(Some("[video] hello"), &knobs);
    assert_eq!(voice.effort.as_deref(), Some("high"));
    assert_eq!(voice.model.as_deref(), Some("name-model"));
}

#[test]
fn renamed_agent_keeps_pubkey_entry() {
    let raw = format!(
        r#"{{"{PUBKEY}":{{"text":"high","voice":"low","voiceModel":"key-model"}},
        "Evie":{{"text":"medium","voiceModel":"old-name-model"}}}}"#
    );
    for name in [Some("Evie"), Some("New name"), None] {
        let knobs = TurnKnobs {
            agent_name: name,
            ..identity_knobs(&raw)
        };
        let text = VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs);
        assert_eq!(text.text_effort.as_deref(), Some("high"));
        let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hello"), &knobs);
        assert_eq!(voice.effort.as_deref(), Some("low"));
        assert_eq!(voice.model.as_deref(), Some("key-model"));
    }
}

#[test]
fn voice_model_from_file_beats_env() {
    let raw = format!(r#"{{"{PUBKEY}":{{"voiceModel":"  file-model  "}}}}"#);
    for content in ["[voice] hello", "[video] hello"] {
        let voice = VoiceTurnOverrides::resolve_for_turn(Some(content), &identity_knobs(&raw));
        assert_eq!(voice.model.as_deref(), Some("file-model"));
    }
}

#[test]
fn voice_model_unset_masks_env() {
    for value in ["unset", " UnSeT ", "", "   "] {
        let raw = format!(
            r#"{{"{PUBKEY}":{{"voiceModel":"{value}"}},
            "Evie":{{"voiceModel":"name-model"}},"*":{{"voiceModel":"wild-model"}}}}"#
        );
        let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &identity_knobs(&raw));
        assert_eq!(
            voice.model, None,
            "explicit {value:?} masks every lower tier"
        );
    }
}

#[test]
fn voice_model_ignored_on_unmarked_turn() {
    let raw = format!(r#"{{"{PUBKEY}":{{"voiceModel":"key-model"}}}}"#);
    // Pin the positive half too: an absent file-model mechanism must not
    // masquerade as a working marked/unmarked boundary.
    assert_eq!(
        VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &identity_knobs(&raw))
            .model
            .as_deref(),
        Some("key-model")
    );
    for content in [Some("typed"), Some("quotes [voice] hello"), None] {
        let text = VoiceTurnOverrides::resolve_for_turn(content, &identity_knobs(&raw));
        assert_eq!(text.model, None);
        assert_eq!(text.text_effort.as_deref(), Some("default"));
    }
}

#[test]
fn pubkey_precedence_is_per_knob() {
    let raw = format!(
        r#"{{"{PUBKEY}":{{"text":"low"}},"Evie":{{"voice":"high"}},
        "*":{{"text":"max","voice":"low","voiceModel":"wild-model"}}}}"#
    );
    let knobs = identity_knobs(&raw);
    assert_eq!(
        VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs)
            .text_effort
            .as_deref(),
        Some("low")
    );
    let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &knobs);
    assert_eq!(voice.effort.as_deref(), Some("high"));
    assert_eq!(voice.model.as_deref(), Some("wild-model"));
    // With no model at any file tier the environment still applies.
    let raw = format!(r#"{{"{PUBKEY}":{{"text":"low"}},"Evie":{{"voice":"high"}}}}"#);
    assert_eq!(
        VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &identity_knobs(&raw))
            .model
            .as_deref(),
        Some("env-model")
    );
}

#[test]
fn pubkey_entry_requires_exact_lowercase_hex() {
    for key in [PUBKEY.to_ascii_uppercase(), "b".repeat(64)] {
        let raw = format!(
            r#"{{"{key}":{{"text":"high","voiceModel":"other-model"}},"Evie":{{"text":"low","voiceModel":"name-model"}}}}"#
        );
        let knobs = identity_knobs(&raw);
        assert_eq!(
            VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs)
                .text_effort
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &knobs)
                .model
                .as_deref(),
            Some("name-model")
        );
    }
}

#[test]
fn pubkey_unset_and_invalid_effort_mask_lower_tiers() {
    for value in ["unset", "", "banana", "null"] {
        let raw = format!(
            r#"{{"{PUBKEY}":{{"text":"{value}","voice":"{value}"}},"Evie":{{"text":"high","voice":"high"}}}}"#
        );
        let knobs = identity_knobs(&raw);
        assert_eq!(
            VoiceTurnOverrides::resolve_for_turn(Some("typed"), &knobs).text_effort,
            None
        );
        assert_eq!(
            VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &knobs).effort,
            None
        );
    }
}

#[test]
fn malformed_voice_model_masks_lower_tiers() {
    for value in ["null", "5", "true", "[]", "{}"] {
        let raw = format!(
            r#"{{"{PUBKEY}":{{"voiceModel":{value}}},"Evie":{{"voiceModel":"name-model"}}}}"#
        );
        let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &identity_knobs(&raw));
        assert_eq!(voice.model, None);
    }
}

#[test]
fn missing_or_broken_model_file_falls_back_to_env() {
    for raw in ["{}", "{bad", "[]", "5"] {
        let voice = VoiceTurnOverrides::resolve_for_turn(Some("[voice] hi"), &identity_knobs(raw));
        assert_eq!(voice.model.as_deref(), Some("env-model"));
    }
}

#[test]
fn pubkey_file_is_reread_without_restart() {
    // Exercise the impure seam in an isolated subprocess so these env knobs
    // cannot race other crate tests or touch the developer's real config.
    const CHILD: &str = "BUZZ_A1_FILE_RELOAD_TEST";
    if let Ok(path) = std::env::var(CHILD) {
        let first = VoiceTurnOverrides::from_env_for_turn(Some("[voice] hi"), Some(PUBKEY));
        assert_eq!(first.effort.as_deref(), Some("low"));
        assert_eq!(first.model.as_deref(), Some("first-model"));
        std::fs::write(
            &path,
            format!(
                r#"{{"{PUBKEY}":{{"text":"high","voice":"medium","voiceModel":"second-model"}}}}"#
            ),
        )
        .expect("edit fixture");
        let second = VoiceTurnOverrides::from_env_for_turn(Some("[video] hi"), Some(PUBKEY));
        assert_eq!(second.effort.as_deref(), Some("medium"));
        assert_eq!(second.model.as_deref(), Some("second-model"));
        let text = VoiceTurnOverrides::from_env_for_turn(Some("typed"), Some(PUBKEY));
        assert_eq!(text.text_effort.as_deref(), Some("high"));
        assert_eq!(text.model, None);
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("a1-reload-{}.json", std::process::id()));
    std::fs::create_dir_all(path.parent().expect("fixture parent")).expect("scratch dir");
    std::fs::write(&path, format!(r#"{{"{PUBKEY}":{{"voice":"low","voiceModel":"first-model"}},"Evie":{{"voice":"max"}}}}"#)).expect("fixture");
    let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "voice_turn::tests::pubkey_file_is_reread_without_restart",
            "--nocapture",
        ])
        .env(CHILD, &path)
        .env(super::ENV_CONFIG_PATH, &path)
        .env(super::ENV_AGENT_NAME, "Renamed agent")
        .env(super::ENV_EFFORT, "max")
        .env(super::ENV_MODEL, "env-model")
        .output()
        .expect("run fixture subprocess");
    std::fs::remove_file(path).expect("remove fixture");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn markers_are_pinned() {
    // The desktop bridge emits exactly this shape (mark_video_turn);
    // the web voice mode must emit the matching one.
    assert_eq!(VIDEO_TURN_MARKER, "[video] ");
    assert_eq!(VOICE_TURN_MARKER, "[voice] ");
}

#[test]
fn detects_both_markers() {
    assert!(is_voice_turn_content("[video] what's the weather"));
    assert!(is_voice_turn_content("[voice] what's the weather"));
}

#[test]
fn no_marker_for_plain_or_mid_text_mentions() {
    // The hard requirement: an ordinary turn is not voice-shaped, and a
    // marker that arrives mid-text does not mark the turn.
    assert!(!is_voice_turn_content("what's the weather"));
    assert!(!is_voice_turn_content("hey [voice] are you there"));
    assert!(!is_voice_turn_content("read me [video] the thing"));
}

#[test]
fn marker_without_trailing_space_is_not_a_marker() {
    assert!(!is_voice_turn_content("[video]news"));
    assert!(!is_voice_turn_content("[voice]news"));
    assert!(!is_voice_turn_content("[video]"));
}

#[test]
fn effort_unset_when_env_missing_blank_or_unset() {
    assert_eq!(resolve_effort_override(None), EffortOverride::Unset);
    assert_eq!(resolve_effort_override(Some("")), EffortOverride::Unset);
    assert_eq!(resolve_effort_override(Some("  ")), EffortOverride::Unset);
    assert_eq!(
        resolve_effort_override(Some("unset")),
        EffortOverride::Unset
    );
    assert_eq!(
        resolve_effort_override(Some("UNSET")),
        EffortOverride::Unset
    );
}

#[test]
fn effort_applies_recognized_values_normalized() {
    // The full adapter vocabulary (SDK supportedEffortLevels + default):
    // every level Sam can name must reach the wire normalized lowercase.
    assert_eq!(
        resolve_effort_override(Some("low")),
        EffortOverride::Apply("low".into())
    );
    assert_eq!(
        resolve_effort_override(Some("medium")),
        EffortOverride::Apply("medium".into())
    );
    assert_eq!(
        resolve_effort_override(Some("high")),
        EffortOverride::Apply("high".into())
    );
    assert_eq!(
        resolve_effort_override(Some("xhigh")),
        EffortOverride::Apply("xhigh".into())
    );
    assert_eq!(
        resolve_effort_override(Some("max")),
        EffortOverride::Apply("max".into())
    );
    assert_eq!(
        resolve_effort_override(Some("default")),
        EffortOverride::Apply("default".into())
    );
    assert_eq!(
        resolve_effort_override(Some(" LOW ")),
        EffortOverride::Apply("low".into())
    );
    assert_eq!(
        resolve_effort_override(Some("Max")),
        EffortOverride::Apply("max".into())
    );
}

#[test]
fn effort_rejects_unrecognized_values() {
    // Values the adapter cannot honor (the SDK catalog has no "off" or
    // "minimal" effort) must invalidate rather than silently no-op — a
    // knob that looks set but does nothing is worse than a loud warning.
    assert_eq!(
        resolve_effort_override(Some("off")),
        EffortOverride::Invalid("off".into())
    );
    assert_eq!(
        resolve_effort_override(Some("minimal")),
        EffortOverride::Invalid("minimal".into())
    );
    assert_eq!(
        resolve_effort_override(Some("loww")),
        EffortOverride::Invalid("loww".into())
    );
    assert_eq!(
        resolve_effort_override(Some("maximum")),
        EffortOverride::Invalid("maximum".into())
    );
}

#[test]
fn model_override_off_by_default_and_passthrough_when_set() {
    assert_eq!(resolve_model_override(None), None);
    assert_eq!(resolve_model_override(Some("")), None);
    assert_eq!(resolve_model_override(Some("unset")), None);
    assert_eq!(
        resolve_model_override(Some(" deepseek-v4-flash ")),
        Some("deepseek-v4-flash".to_string())
    );
}

// ---------------------------------------------------------------------
// Text-turn knob + layered config file
// ---------------------------------------------------------------------

/// Shorthand: resolve with only the text env knob set.
fn text_only(content: &str, text_env: Option<&str>) -> VoiceTurnOverrides {
    VoiceTurnOverrides::resolve_for_turn(
        Some(content),
        &TurnKnobs {
            text_env,
            ..TurnKnobs::default()
        },
    )
}

#[test]
fn text_knob_resolves_on_unmarked_turn() {
    let overrides = text_only("ordinary typed message", Some("max"));
    assert_eq!(overrides.text_effort.as_deref(), Some("max"));
    assert_eq!(overrides.effort, None, "the voice knob stays untouched");
    assert_eq!(overrides.model, None, "no text model knob exists");
    assert!(!overrides.is_noop());
}

#[test]
fn text_knob_unset_on_unmarked_turn_is_noop() {
    // THE byte-identical requirement for the default deployment: no
    // knobs, no file → the unmarked path resolves to the no-op default.
    let overrides = text_only("ordinary typed message", None);
    assert!(overrides.is_noop());
    assert_eq!(overrides, VoiceTurnOverrides::default());
}

#[test]
fn text_knob_invalid_value_is_noop_on_effort() {
    let overrides = text_only("ordinary typed message", Some("banana"));
    assert_eq!(overrides.text_effort, None, "Invalid → warn + proceed");
    assert!(overrides.is_noop());
}

#[test]
fn text_knob_on_marked_turn_is_ignored() {
    // Partition, env tier: a marked turn never consults the text knob.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("[voice] what's the weather"),
        &TurnKnobs {
            text_env: Some("max"),
            ..TurnKnobs::default()
        },
    );
    assert!(overrides.is_noop());
    assert_eq!(overrides.text_effort, None);
}

#[test]
fn voice_knob_on_unmarked_turn_is_ignored() {
    // Partition, the other half: an unmarked turn never consults the
    // voice knob (this is the env-only shape `for_turn` pins too).
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("ordinary typed message"),
        &TurnKnobs {
            voice_env: Some("low"),
            ..TurnKnobs::default()
        },
    );
    assert!(overrides.is_noop());
    assert_eq!(overrides.effort, None);
}

#[test]
fn unmarked_turn_resolves_to_noop_even_with_env_set() {
    // THE original requirement, env-only shape: no marker → no voice
    // override, whatever the voice knobs say.
    let overrides = VoiceTurnOverrides::for_turn(
        Some("ordinary typed message"),
        Some("low"),
        Some("deepseek-v4-flash"),
    );
    assert!(overrides.is_noop());
    assert_eq!(overrides, VoiceTurnOverrides::default());
}

#[test]
fn missing_content_is_never_a_voice_turn() {
    let overrides = VoiceTurnOverrides::for_turn(None, Some("low"), None);
    assert!(overrides.is_noop());
}

#[test]
fn marked_turn_resolves_env_knobs() {
    let overrides = VoiceTurnOverrides::for_turn(
        Some("[voice] what's the weather"),
        Some("low"),
        Some("deepseek-v4-flash"),
    );
    assert_eq!(overrides.effort.as_deref(), Some("low"));
    assert_eq!(overrides.text_effort, None);
    assert_eq!(overrides.model.as_deref(), Some("deepseek-v4-flash"));
}

#[test]
fn marked_turn_with_no_env_stays_noop() {
    // Marked but both knobs unset (the DEFAULT deployment): the turn
    // runs at normal config, identically to today.
    let overrides = VoiceTurnOverrides::for_turn(Some("[video] hello"), None, None);
    assert!(overrides.is_noop());
}

#[test]
fn marked_turn_with_invalid_effort_is_noop_on_effort() {
    let overrides = VoiceTurnOverrides::for_turn(Some("[voice] hi"), Some("loww"), None);
    assert_eq!(overrides.effort, None);
}

// ----- config file parsing -----

const FILE_BOTH: &str = r#"{
    "*":    { "text": "max", "voice": "low" },
    "Evie": { "text": "medium" }
}"#;

fn knobs_with_file<'a>(
    file: &'a str,
    agent: Option<&'a str>,
    text_env: Option<&'a str>,
    voice_env: Option<&'a str>,
) -> TurnKnobs<'a> {
    TurnKnobs {
        voice_env,
        text_env,
        agent_name: agent,
        file_content: Some(file),
        ..TurnKnobs::default()
    }
}

#[test]
fn parse_narrows_to_agent_and_wildcard() {
    let file = parse_agent_effort_file(FILE_BOTH, Some("Evie"), None).expect("parses");
    assert_eq!(
        file.agent,
        EffortFileEntry {
            text: Some("medium".into()),
            voice: None,
            ..EffortFileEntry::default()
        }
    );
    assert_eq!(
        file.wildcard,
        EffortFileEntry {
            text: Some("max".into()),
            voice: Some("low".into()),
            ..EffortFileEntry::default()
        }
    );
}

#[test]
fn parse_agent_key_is_case_insensitive() {
    let file = parse_agent_effort_file(FILE_BOTH, Some("eViE"), None).expect("parses");
    assert_eq!(
        file.agent.text.as_deref(),
        Some("medium"),
        "the per-agent entry must match regardless of case"
    );
}

#[test]
fn parse_without_agent_name_reads_wildcard_only() {
    // A sidecar with no display name in its env gets exactly the
    // wildcard tiers, never someone else's entry.
    let file = parse_agent_effort_file(FILE_BOTH, None, None).expect("parses");
    assert_eq!(file.agent, EffortFileEntry::default());
    assert_eq!(file.wildcard.voice.as_deref(), Some("low"));
}

#[test]
fn parse_ignores_other_agents_entries() {
    let file = parse_agent_effort_file(FILE_BOTH, Some("Duncan"), None).expect("parses");
    assert_eq!(file.agent, EffortFileEntry::default());
    assert_eq!(file.class_value(EffortClass::Text), Some("max"));
}

#[test]
fn parse_rejects_invalid_json_and_non_object_root() {
    assert!(parse_agent_effort_file("not json {", Some("Evie"), None).is_err());
    assert!(parse_agent_effort_file("[]", Some("Evie"), None).is_err());
    assert!(parse_agent_effort_file("\"a string\"", Some("Evie"), None).is_err());
    assert!(parse_agent_effort_file("5", Some("Evie"), None).is_err());
}

#[test]
fn parse_skips_non_object_entries() {
    // Per-entry fail-soft: a malformed entry is ignored with a warn, the
    // rest of the file still applies.
    let raw = r#"{ "Evie": "medium", "*": { "voice": "low" } }"#;
    let file = parse_agent_effort_file(raw, Some("Evie"), None).expect("parses");
    assert_eq!(file.agent, EffortFileEntry::default());
    assert_eq!(file.wildcard.voice.as_deref(), Some("low"));
}

#[test]
fn parse_serializes_non_string_class_values_for_loud_failure() {
    // A non-string class value is PRESENT, so it must fail the
    // vocabulary check (Invalid) rather than fall through to env.
    let raw = r#"{ "*": { "text": 5 } }"#;
    let file = parse_agent_effort_file(raw, Some("Evie"), None).expect("parses");
    assert_eq!(file.wildcard.text.as_deref(), Some("5"));
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("plain text"),
        &TurnKnobs {
            text_env: Some("low"),
            agent_name: Some("Evie"),
            file_content: Some(raw),
            ..TurnKnobs::default()
        },
    );
    assert_eq!(
        overrides.text_effort, None,
        "invalid file value poisons its tier — no fallthrough to env"
    );
}

#[test]
fn parse_ignores_unknown_keys_inside_entries() {
    let raw = r#"{ "*": { "text": "max", "model": "m-9", "bogus": true } }"#;
    let file = parse_agent_effort_file(raw, None, None).expect("parses");
    assert_eq!(file.wildcard.text.as_deref(), Some("max"));
    assert_eq!(file.wildcard.voice, None);
}

#[test]
fn wildcard_key_is_pinned() {
    assert_eq!(WILDCARD_KEY, "*");
}

// ----- full precedence matrix -----

#[test]
fn precedence_matrix_voice_per_agent_beats_wildcard_beats_env_beats_unset() {
    let marked = Some("[voice] hello");

    // per-agent > wildcard
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        marked,
        &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
    );
    assert_eq!(
        overrides.effort.as_deref(),
        Some("low"),
        "Evie has no voice key → wildcard voice wins"
    );

    let file_agent_voice = r#"{
        "*":    { "voice": "low" },
        "Evie": { "voice": "high" }
    }"#;
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        marked,
        &knobs_with_file(file_agent_voice, Some("Evie"), None, None),
    );
    assert_eq!(
        overrides.effort.as_deref(),
        Some("high"),
        "per-agent entry must beat the wildcard"
    );

    // wildcard > env
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        marked,
        &knobs_with_file(FILE_BOTH, Some("Evie"), None, Some("xhigh")),
    );
    assert_eq!(
        overrides.effort.as_deref(),
        Some("low"),
        "wildcard file entry must beat the env knob"
    );

    // env > unset
    let overrides = VoiceTurnOverrides::for_turn(marked, Some("xhigh"), None);
    assert_eq!(overrides.effort.as_deref(), Some("xhigh"));

    // unset → no override
    let overrides = VoiceTurnOverrides::for_turn(marked, None, None);
    assert_eq!(overrides.effort, None);
}

#[test]
fn precedence_matrix_text_per_agent_beats_wildcard_beats_env_beats_unset() {
    let plain = "ordinary typed message";

    // per-agent > wildcard
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some(plain),
        &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
    );
    assert_eq!(
        overrides.text_effort.as_deref(),
        Some("medium"),
        "per-agent text entry must beat the wildcard"
    );

    // wildcard > env
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some(plain),
        &knobs_with_file(FILE_BOTH, Some("Duncan"), Some("low"), None),
    );
    assert_eq!(
        overrides.text_effort.as_deref(),
        Some("max"),
        "wildcard text entry must beat the env knob"
    );

    // env > unset
    let overrides = text_only(plain, Some("low"));
    assert_eq!(overrides.text_effort.as_deref(), Some("low"));

    // unset → no override (byte-identical default)
    let overrides = text_only(plain, None);
    assert_eq!(overrides.text_effort, None);
}

#[test]
fn missing_class_key_falls_through_tier_by_tier() {
    // Evie's entry has only `text`; her VOICE tier falls per-agent →
    // wildcard, while her TEXT tier stops at per-agent.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("[voice] hello"),
        &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
    );
    assert_eq!(
        overrides.effort.as_deref(),
        Some("low"),
        "missing per-agent voice key → wildcard voice stands"
    );
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
    );
    assert_eq!(
        overrides.text_effort.as_deref(),
        Some("medium"),
        "present per-agent text key stops the fall-through"
    );

    // When NEITHER file tier carries the class, the env knob stands:
    // this file has no wildcard voice and Evie has no voice key.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("[voice] hello"),
        &knobs_with_file(
            r#"{ "Evie": { "text": "medium" } }"#,
            Some("Evie"),
            None,
            Some("high"),
        ),
    );
    assert_eq!(
        overrides.effort.as_deref(),
        Some("high"),
        "class key missing at both file tiers → env knob stands"
    );

    // Duncan has no entry at all: his TEXT tier falls wildcard (absent)
    // → env.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file(
            r#"{ "Evie": { "text": "medium" } }"#,
            Some("Duncan"),
            Some("low"),
            None,
        ),
    );
    assert_eq!(
        overrides.text_effort.as_deref(),
        Some("low"),
        "no matching file entry → env knob stands"
    );
}

#[test]
fn file_explicit_unset_masks_env() {
    // `unset` is part of the vocabulary: an explicit file "unset" is a
    // deliberate no-override for that class and masks the env knob.
    let raw = r#"{ "*": { "text": "unset", "voice": "" } }"#;
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file(raw, None, Some("low"), None),
    );
    assert_eq!(overrides.text_effort, None);
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("[voice] hello"),
        &knobs_with_file(raw, None, None, Some("low")),
    );
    assert_eq!(overrides.effort, None);
}

#[test]
fn invalid_file_value_does_not_fall_through_to_env() {
    // A present-but-invalid file value warns and proceeds at normal
    // config (same posture as an invalid env value) — it must not
    // silently degrade into the env tier, which would apply a DIFFERENT
    // config than the operator wrote.
    let raw = r#"{ "*": { "voice": "banana" } }"#;
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("[voice] hello"),
        &knobs_with_file(raw, None, None, Some("low")),
    );
    assert_eq!(overrides.effort, None);
}

#[test]
fn missing_or_broken_file_falls_back_to_env() {
    // File absent: env knobs stand alone.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &TurnKnobs {
            text_env: Some("low"),
            file_content: None,
            ..TurnKnobs::default()
        },
    );
    assert_eq!(overrides.text_effort.as_deref(), Some("low"));

    // Invalid JSON: warn + behave as absent.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file("{not json", None, Some("low"), None),
    );
    assert_eq!(overrides.text_effort.as_deref(), Some("low"));

    // Non-object root: same.
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file("[1,2,3]", None, Some("low"), None),
    );
    assert_eq!(overrides.text_effort.as_deref(), Some("low"));
}

#[test]
fn file_value_normalizes_like_env() {
    // Same resolver, same normalization: case and whitespace do not
    // reach the wire.
    let raw = r#"{ "*": { "text": "  MAX " } }"#;
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file(raw, None, None, None),
    );
    assert_eq!(overrides.text_effort.as_deref(), Some("max"));
}

#[test]
fn file_default_value_passes_through() {
    let raw = r#"{ "*": { "text": "default" } }"#;
    let overrides = VoiceTurnOverrides::resolve_for_turn(
        Some("typed message"),
        &knobs_with_file(raw, None, None, None),
    );
    assert_eq!(overrides.text_effort.as_deref(), Some("default"));
}

#[test]
fn partition_holds_across_both_tiers() {
    // The full stack, both classes at once: the marked turn resolves
    // ONLY voice tiers, the unmarked turn ONLY text tiers — neither can
    // see the other's sources.
    let knobs = knobs_with_file(FILE_BOTH, Some("Evie"), Some("high"), Some("high"));
    let marked = VoiceTurnOverrides::resolve_for_turn(Some("[video] hi"), &knobs);
    assert_eq!(
        marked.effort.as_deref(),
        Some("low"),
        "marked: Evie has no voice key → wildcard voice"
    );
    assert_eq!(marked.text_effort, None, "marked turn ignores text tiers");
    assert_eq!(marked.effective_effort(), Some("low"));

    let unmarked = VoiceTurnOverrides::resolve_for_turn(Some("typed message"), &knobs);
    assert_eq!(
        unmarked.text_effort.as_deref(),
        Some("medium"),
        "unmarked: per-agent text entry"
    );
    assert_eq!(unmarked.effort, None, "unmarked turn ignores voice tiers");
    assert_eq!(unmarked.effective_effort(), Some("medium"));
}

#[test]
fn effective_effort_merges_the_partition() {
    let mut overrides = VoiceTurnOverrides::default();
    assert_eq!(overrides.effective_effort(), None);
    overrides.effort = Some("low".into());
    assert_eq!(overrides.effective_effort(), Some("low"));
    overrides.effort = None;
    overrides.text_effort = Some("max".into());
    assert_eq!(overrides.effective_effort(), Some("max"));
}

#[test]
fn default_config_path_joins_home_and_is_none_without_home() {
    assert_eq!(
        default_config_path(Some("/Users/sam")).as_deref(),
        Some(std::path::Path::new("/Users/sam/.buzz/agent-effort.json"))
    );
    assert_eq!(default_config_path(None), None);
    assert_eq!(default_config_path(Some("   ")), None);
}

#[test]
fn agent_effort_file_default_is_empty() {
    // A default (absent-file) resolution must equal the no-file one.
    let file = AgentEffortFile::default();
    assert_eq!(file.class_value(EffortClass::Text), None);
    assert_eq!(file.class_value(EffortClass::Voice), None);
}

// ── voiceStream switch ─────────────────────────────────────────────────────

fn stream_knobs<'a>(raw: Option<&'a str>, env: Option<&'a str>) -> super::VoiceStreamKnobs<'a> {
    super::VoiceStreamKnobs {
        env,
        agent_name: Some("Kaiya"),
        agent_pubkey: Some(PUBKEY),
        file_content: raw,
    }
}

#[test]
fn voice_stream_defaults_off() {
    use super::{resolve_voice_stream, VoiceStreamSwitch};
    assert_eq!(
        resolve_voice_stream(&stream_knobs(None, None)),
        VoiceStreamSwitch::Off
    );
    assert_eq!(
        resolve_voice_stream(&stream_knobs(Some("{}"), None)),
        VoiceStreamSwitch::Off
    );
    // A file entry without the key leaves the default alone.
    assert_eq!(
        resolve_voice_stream(&stream_knobs(Some(r#"{"Kaiya":{"voice":"low"}}"#), None)),
        VoiceStreamSwitch::Off
    );
}

#[test]
fn voice_stream_precedence_is_pubkey_name_wildcard_env() {
    use super::{resolve_voice_stream, VoiceStreamSwitch};
    let on = VoiceStreamSwitch::On;
    let off = VoiceStreamSwitch::Off;
    assert_eq!(resolve_voice_stream(&stream_knobs(None, Some("on"))), on);
    assert_eq!(
        resolve_voice_stream(&stream_knobs(Some(r#"{"*":{"voiceStream":"on"}}"#), None)),
        on
    );
    assert_eq!(
        resolve_voice_stream(&stream_knobs(
            Some(r#"{"kaiya":{"voiceStream":"ON"}}"#),
            None
        )),
        on,
        "name match is case-insensitive"
    );
    let raw = format!(
        r#"{{"*":{{"voiceStream":"on"}},"Kaiya":{{"voiceStream":"on"}},"{PUBKEY}":{{"voiceStream":"off"}}}}"#
    );
    assert_eq!(
        resolve_voice_stream(&stream_knobs(Some(&raw), Some("on"))),
        off
    );
    let raw = r#"{"*":{"voiceStream":"off"},"Kaiya":{"voiceStream":"on"}}"#;
    assert_eq!(resolve_voice_stream(&stream_knobs(Some(raw), None)), on);
    // A file value masks the env, including an explicit off.
    let raw = r#"{"*":{"voiceStream":"off"}}"#;
    assert_eq!(
        resolve_voice_stream(&stream_knobs(Some(raw), Some("on"))),
        off
    );
    // Another agent's entry is not ours.
    let raw = r#"{"Evie":{"voiceStream":"on"}}"#;
    assert_eq!(resolve_voice_stream(&stream_knobs(Some(raw), None)), off);
}

#[test]
fn voice_stream_typos_never_turn_streaming_on() {
    use super::{resolve_voice_stream, VoiceStreamSwitch};
    for value in [r#""yes""#, r#""true""#, "true", "1", r#"{"a":1}"#] {
        let raw = format!(r#"{{"Kaiya":{{"voiceStream":{value}}}}}"#);
        let resolved = resolve_voice_stream(&stream_knobs(Some(&raw), Some("on")));
        assert!(
            matches!(resolved, VoiceStreamSwitch::Invalid(_)),
            "{value}: {resolved:?}"
        );
        assert!(!resolved.is_on());
    }
    assert!(!resolve_voice_stream(&stream_knobs(None, Some("enabled"))).is_on());
}

#[test]
fn voice_stream_file_is_reread_without_restart() {
    // Impure seam in an isolated subprocess, like the effort reload test.
    const CHILD: &str = "BUZZ_VOICE_STREAM_RELOAD_TEST";
    if let Ok(path) = std::env::var(CHILD) {
        assert!(super::voice_stream_from_env(Some(PUBKEY)).is_on());
        std::fs::write(&path, r#"{"Kaiya":{"voiceStream":"off"}}"#).expect("edit fixture");
        assert!(!super::voice_stream_from_env(Some(PUBKEY)).is_on());
        std::fs::write(&path, "{}").expect("edit fixture");
        // File silent → env decides.
        assert!(super::voice_stream_from_env(Some(PUBKEY)).is_on());
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("voice-stream-reload-{}.json", std::process::id()));
    std::fs::create_dir_all(path.parent().expect("fixture parent")).expect("scratch dir");
    std::fs::write(&path, r#"{"kaiya":{"voiceStream":"on"}}"#).expect("fixture");
    let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "voice_turn::tests::voice_stream_file_is_reread_without_restart",
            "--nocapture",
        ])
        .env(CHILD, &path)
        .env(super::ENV_CONFIG_PATH, &path)
        .env(super::ENV_AGENT_NAME, "Kaiya")
        .env(super::ENV_VOICE_STREAM, "on")
        .output()
        .expect("run fixture subprocess");
    std::fs::remove_file(path).expect("remove fixture");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "child must actually run the test"
    );
}
