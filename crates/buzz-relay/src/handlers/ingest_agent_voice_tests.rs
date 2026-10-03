//! Selection and assignment envelope tests, including shared cloud voice-key vectors.

use super::tests::{make_dummy_event, make_event_with_tags};
use super::*;

// ─── agent-voice (30182) envelope + payload + scope tests ─────────────────

fn local_synth_content(uri: &str) -> String {
    serde_json::json!({
        "version": 1,
        "engine": "local-synth",
        "voiceURI": uri,
        "label": "Samantha",
    })
    .to_string()
}

fn pocket_content(key: &str) -> String {
    serde_json::json!({
        "version": 1,
        "engine": "pocket",
        "key": key,
        "label": "Azelma",
    })
    .to_string()
}

fn eleven_content(key: &str) -> String {
    serde_json::json!({
        "version": 1,
        "engine": "eleven",
        "key": key,
        "label": "Eleven voice",
    })
    .to_string()
}

fn chatterbox_content(key: &str) -> String {
    serde_json::json!({
        "version": 1,
        "engine": "chatterbox",
        "key": key,
        "label": "Evie",
    })
    .to_string()
}

/// AC-R1: the chatterbox engine accepts `chatterbox:<slug>` and rejects
/// uppercase, empty, overlong (49-char), and path-shaped slugs.
#[test]
fn agent_voice_chatterbox_key_grammar_matrix() {
    for good in [
        "chatterbox:evie",
        "chatterbox:a",
        "chatterbox:0x",
        "chatterbox:iris_2-b",
    ] {
        let ev = make_agent_voice_content(&chatterbox_content(good), KIND_AGENT_VOICE_D_TAG);
        assert!(
            validate_agent_voice_envelope(&ev).is_ok(),
            "`{good}` must be accepted"
        );
    }
    // A 48-char slug is the upper bound.
    let at_bound = format!("chatterbox:{}", "a".repeat(48));
    let ev = make_agent_voice_content(&chatterbox_content(&at_bound), KIND_AGENT_VOICE_D_TAG);
    assert!(validate_agent_voice_envelope(&ev).is_ok(), "48-char slug");

    let overlong = format!("chatterbox:{}", "a".repeat(49));
    for bad in [
        "chatterbox:Evie",
        "chatterbox:",
        overlong.as_str(),
        "chatterbox:a/b",
        "chatterbox:../x",
        "chatterbox:-lead",
        "chatterbox:_lead",
        "chatterbox:ev ie",
        "pocket:evie",
        "evie",
    ] {
        let ev = make_agent_voice_content(&chatterbox_content(bad), KIND_AGENT_VOICE_D_TAG);
        let err =
            validate_agent_voice_envelope(&ev).expect_err(&format!("`{bad}` must be rejected"));
        assert!(err.contains("Chatterbox voice key"), "`{bad}` got: {err}");
    }

    // Missing key.
    let no_key =
        serde_json::json!({"version": 1, "engine": "chatterbox", "label": "x"}).to_string();
    let ev = make_agent_voice_content(&no_key, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("requires a string `key`"), "got: {err}");
}

/// Backward compatibility: the pre-existing engines still validate
/// unchanged alongside the new arm.
#[test]
fn agent_voice_legacy_engines_still_accepted_with_chatterbox() {
    for content in [
        pocket_content("pocket:anna"),
        eleven_content("eleven:21m00Tcm4TlvDq8ikWAM"),
        local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
    ] {
        let ev = make_agent_voice_content(&content, KIND_AGENT_VOICE_D_TAG);
        assert!(validate_agent_voice_envelope(&ev).is_ok(), "{content}");
    }
}

// ─── agent-voice assignment (30183) envelope + scope tests ────────────────

const AGENT_HEX: &str = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";

fn make_assignment(content: &str, tags: &[&[&str]]) -> Event {
    make_event_with_tags(KIND_AGENT_VOICE_ASSIGNMENT, content, tags)
}

#[test]
fn agent_voice_assignment_requires_users_write_and_is_global_only() {
    let dummy = make_dummy_event();
    assert_eq!(
        required_scope_for_kind(KIND_AGENT_VOICE_ASSIGNMENT, &dummy).unwrap(),
        Scope::UsersWrite
    );
    assert!(is_global_only_kind(KIND_AGENT_VOICE_ASSIGNMENT));
    assert!(!requires_h_channel_scope(KIND_AGENT_VOICE_ASSIGNMENT));
}

#[test]
fn agent_voice_assignment_accepts_agent_hex_d_and_returns_agent_bytes() {
    let ev = make_assignment(&chatterbox_content("chatterbox:evie"), &[&["d", AGENT_HEX]]);
    let bytes = validate_agent_voice_assignment_envelope(&ev).expect("valid");
    assert_eq!(hex::encode(bytes), AGENT_HEX);
    // Every engine the selection grammar accepts works here too.
    let ev = make_assignment(&pocket_content("pocket:anna"), &[&["d", AGENT_HEX]]);
    assert!(validate_agent_voice_assignment_envelope(&ev).is_ok());
}

/// AC-R3: `d` must be exactly 64 lowercase hex, exactly once.
#[test]
fn agent_voice_assignment_rejects_bad_d() {
    let content = chatterbox_content("chatterbox:evie");
    let upper = AGENT_HEX.to_uppercase();
    let short = &AGENT_HEX[..63];
    let long = format!("{AGENT_HEX}0");
    let nonhex = format!("{}g", &AGENT_HEX[..63]);
    for bad in [
        upper.as_str(),
        short,
        long.as_str(),
        nonhex.as_str(),
        "",
        KIND_AGENT_VOICE_D_TAG,
    ] {
        let ev = make_assignment(&content, &[&["d", bad]]);
        let err = validate_agent_voice_assignment_envelope(&ev)
            .expect_err(&format!("d=`{bad}` must be rejected"));
        assert!(err.contains("64 lowercase hex"), "d=`{bad}` got: {err}");
    }
    let ev = make_assignment(&content, &[]);
    let err = validate_agent_voice_assignment_envelope(&ev).unwrap_err();
    assert!(err.contains("exactly one `d` tag"), "got: {err}");
    let ev = make_assignment(&content, &[&["d", AGENT_HEX], &["d", AGENT_HEX]]);
    let err = validate_agent_voice_assignment_envelope(&ev).unwrap_err();
    assert!(err.contains("exactly one `d` tag"), "got: {err}");
}

/// AC-R3: the payload uses the 30182 grammar.
#[test]
fn agent_voice_assignment_rejects_invalid_payload() {
    for bad in [
        chatterbox_content("chatterbox:Evie"),
        pocket_content("pocket:eve"),
        "not json".to_string(),
        serde_json::json!({
            "version": 2,
            "engine": "chatterbox",
            "key": "chatterbox:evie",
            "label": "x",
        })
        .to_string(),
    ] {
        let ev = make_assignment(&bad, &[&["d", AGENT_HEX]]);
        assert!(
            validate_agent_voice_assignment_envelope(&ev).is_err(),
            "payload must be rejected: {bad}"
        );
    }
}

fn make_agent_voice_content(content: &str, d_tag: &str) -> Event {
    make_event_with_tags(KIND_AGENT_VOICE, content, &[&["d", d_tag]])
}

fn make_agent_voice(tags: &[&[&str]]) -> Event {
    make_event_with_tags(
        KIND_AGENT_VOICE,
        &local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
        tags,
    )
}

#[test]
fn agent_voice_requires_users_write_and_is_global_only() {
    let dummy = make_dummy_event();
    assert_eq!(
        required_scope_for_kind(KIND_AGENT_VOICE, &dummy).unwrap(),
        Scope::UsersWrite,
        "agent-voice rows are any-member writes (UsersWrite), not admin"
    );
    assert!(
        is_global_only_kind(KIND_AGENT_VOICE),
        "agent-voice rows must be community-global — a stray `h` tag must not channel-scope them"
    );
    assert!(
        !requires_h_channel_scope(KIND_AGENT_VOICE),
        "agent-voice rows must not require an h-tag channel scope"
    );
}

#[test]
fn agent_voice_envelope_accepts_both_engines() {
    let local = make_agent_voice_content(
        &local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
        KIND_AGENT_VOICE_D_TAG,
    );
    assert!(validate_agent_voice_envelope(&local).is_ok());

    let pocket = make_agent_voice_content(&pocket_content("pocket:azelma"), KIND_AGENT_VOICE_D_TAG);
    assert!(validate_agent_voice_envelope(&pocket).is_ok());

    let imported = make_agent_voice_content(
        &pocket_content(&format!("pocket:imported:{}", "a".repeat(64))),
        KIND_AGENT_VOICE_D_TAG,
    );
    assert!(validate_agent_voice_envelope(&imported).is_ok());
}

#[test]
fn agent_voice_envelope_rejects_wrong_d_tag() {
    // One row per author means the coordinate is FIXED — anything else
    // would fork the author's selection into a second, unread slot.
    let ev = make_agent_voice(&[&["d", "pocket:azelma"]]);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("exactly `agent-voice`"), "got: {err}");

    let ev = make_agent_voice(&[&["d", ""]]);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("must not be empty"), "got: {err}");

    let ev = make_agent_voice(&[
        &["d", KIND_AGENT_VOICE_D_TAG],
        &["d", KIND_AGENT_VOICE_D_TAG],
    ]);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("exactly one `d` tag"), "got: {err}");

    let ev = make_agent_voice(&[]);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("exactly one `d` tag"), "got: {err}");
}

#[test]
fn agent_voice_payload_rejects_unknown_engine() {
    let content = serde_json::json!({
        "version": 1,
        "engine": "siri",
        "label": "x",
    })
    .to_string();
    let ev = make_agent_voice_content(&content, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(
        err.contains("`local-synth`, `pocket`, `eleven`, `chatterbox`, or `fish`"),
        "got: {err}"
    );
}

#[test]
fn agent_voice_payload_eleven_requires_voice_id_key() {
    // The real shape: `eleven:<20-char alphanumeric voice id>`.
    let ok = make_agent_voice_content(
        &eleven_content("eleven:T720RsqorTx4ZZWohrNN"),
        KIND_AGENT_VOICE_D_TAG,
    );
    assert!(validate_agent_voice_envelope(&ok).is_ok());

    for bad in [
        // Not prefixed with the engine name.
        "T720RsqorTx4ZZWohrNN",
        // Empty / too-short / too-long ids.
        "eleven:",
        "eleven:short",
        &format!("eleven:{}", "a".repeat(37)),
        // Prose is not a voice id.
        "eleven:my favorite voice",
    ] {
        let ev = make_agent_voice_content(&eleven_content(bad), KIND_AGENT_VOICE_D_TAG);
        let err =
            validate_agent_voice_envelope(&ev).expect_err(&format!("`{bad}` must be refused"));
        assert!(
            err.contains("ElevenLabs voice key"),
            "key `{bad}`: got: {err}"
        );
    }
}

#[test]
fn agent_voice_payload_local_synth_requires_voice_uri() {
    let content = serde_json::json!({
        "version": 1,
        "engine": "local-synth",
        "label": "Samantha",
    })
    .to_string();
    let ev = make_agent_voice_content(&content, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("requires a string `voiceURI`"), "got: {err}");

    let empty = make_agent_voice_content(&local_synth_content(""), KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&empty).unwrap_err();
    assert!(err.contains("`voiceURI` must not be empty"), "got: {err}");
}

#[test]
fn agent_voice_payload_pocket_requires_catalog_key_shape() {
    for bad in [
        "siri:aaron",
        "pocket:",
        "pocket:Imported",
        "pocket:azelma extra",
        "pocket:imported:",
        // 63 hex — one short of the imported form.
        "pocket:imported:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        // Uppercase hex is not the catalog's key grammar.
        "pocket:imported:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let ev = make_agent_voice_content(&pocket_content(bad), KIND_AGENT_VOICE_D_TAG);
        let err =
            validate_agent_voice_envelope(&ev).expect_err(&format!("`{bad}` must be refused"));
        assert!(
            err.contains("must match a voice-catalog key"),
            "key `{bad}`: got: {err}"
        );
    }
}

#[test]
fn agent_voice_payload_refuses_eve_key() {
    let ev = make_agent_voice_content(&pocket_content("pocket:eve"), KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("pocket:eve"), "got: {err}");
}

#[test]
fn agent_voice_payload_requires_version_and_label() {
    let no_version = serde_json::json!({
        "engine": "local-synth",
        "voiceURI": "v",
        "label": "x",
    })
    .to_string();
    let ev = make_agent_voice_content(&no_version, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("numeric `version`"), "got: {err}");

    let future = serde_json::json!({
        "version": 2,
        "engine": "local-synth",
        "voiceURI": "v",
        "label": "x",
    })
    .to_string();
    let ev = make_agent_voice_content(&future, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("`version` must be 1"), "got: {err}");

    let no_label = serde_json::json!({
        "version": 1,
        "engine": "local-synth",
        "voiceURI": "v",
    })
    .to_string();
    let ev = make_agent_voice_content(&no_label, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("string `label`"), "got: {err}");

    let ev = make_agent_voice_content("not json", KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("JSON object"), "got: {err}");
}

#[test]
fn agent_voice_payload_bounds_uri_and_label() {
    // 256 chars is the voiceURI ceiling; 257 is refused. Char-counted,
    // not byte-counted, matching the d-tag rule.
    let at_bound = "v".repeat(256);
    let ev = make_agent_voice_content(&local_synth_content(&at_bound), KIND_AGENT_VOICE_D_TAG);
    assert!(validate_agent_voice_envelope(&ev).is_ok());

    let over = "v".repeat(257);
    let ev = make_agent_voice_content(&local_synth_content(&over), KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("`voiceURI` too long"), "got: {err}");

    let label_over = "l".repeat(129);
    let content = serde_json::json!({
        "version": 1,
        "engine": "local-synth",
        "voiceURI": "v",
        "label": label_over,
    })
    .to_string();
    let ev = make_agent_voice_content(&content, KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(err.contains("`label` too long"), "got: {err}");

    let control = "tab\turi";
    let ev = make_agent_voice_content(&local_synth_content(control), KIND_AGENT_VOICE_D_TAG);
    let err = validate_agent_voice_envelope(&ev).unwrap_err();
    assert!(
        err.contains("`voiceURI` must not contain control"),
        "got: {err}"
    );
}

#[derive(serde::Deserialize)]
struct VoiceKeyVectors {
    fish: EngineKeyVectors,
    eleven: EngineKeyVectors,
}

#[derive(serde::Deserialize)]
struct EngineKeyVectors {
    accept: Vec<String>,
    reject: Vec<String>,
}

fn voice_key_vectors() -> VoiceKeyVectors {
    let vectors: VoiceKeyVectors = serde_json::from_str(include_str!(
        "../../../../test-fixtures/voice/voice-key-grammar.json"
    ))
    .expect("shared voice-key grammar vectors");
    // Fixed counts guard against an empty or truncated corpus. These bounds
    // are independent of the production grammar constants.
    assert_eq!(vectors.fish.accept.len(), 4);
    assert_eq!(vectors.fish.reject.len(), 19);
    assert_eq!(vectors.eleven.accept.len(), 4);
    assert_eq!(vectors.eleven.reject.len(), 18);
    vectors
}

fn fish_content(key: &str) -> String {
    serde_json::json!({
        "version": 1,
        "engine": "fish",
        "key": key,
        "label": "Fish voice",
    })
    .to_string()
}

#[test]
fn agent_voice_fish_vectors_accept() {
    for key in voice_key_vectors().fish.accept {
        let event = make_agent_voice_content(&fish_content(&key), KIND_AGENT_VOICE_D_TAG);
        assert!(
            validate_agent_voice_envelope(&event).is_ok(),
            "key: {key:?}"
        );
    }
}

#[test]
fn agent_voice_fish_vectors_reject() {
    for key in voice_key_vectors().fish.reject {
        let event = make_agent_voice_content(&fish_content(&key), KIND_AGENT_VOICE_D_TAG);
        let error = validate_agent_voice_envelope(&event).expect_err(&format!("key: {key:?}"));
        assert!(
            error.contains("Fish Audio voice key") || error.contains("too long"),
            "{error}"
        );
    }
}

#[test]
fn agent_voice_assignment_fish_uses_30182_grammar() {
    let vectors = voice_key_vectors().fish;
    for key in vectors.accept {
        let event = make_assignment(&fish_content(&key), &[&["d", AGENT_HEX]]);
        assert_eq!(
            hex::encode(validate_agent_voice_assignment_envelope(&event).expect(&key)),
            AGENT_HEX
        );
    }
    for key in vectors.reject {
        let event = make_assignment(&fish_content(&key), &[&["d", AGENT_HEX]]);
        assert!(
            validate_agent_voice_assignment_envelope(&event).is_err(),
            "key: {key:?}"
        );
    }
}

#[test]
fn agent_voice_eleven_vectors_preserve_existing_grammar() {
    let vectors = voice_key_vectors().eleven;
    for key in vectors.accept {
        let event = make_agent_voice_content(&eleven_content(&key), KIND_AGENT_VOICE_D_TAG);
        assert!(
            validate_agent_voice_envelope(&event).is_ok(),
            "key: {key:?}"
        );
    }
    for key in vectors.reject {
        let event = make_agent_voice_content(&eleven_content(&key), KIND_AGENT_VOICE_D_TAG);
        assert!(
            validate_agent_voice_envelope(&event).is_err(),
            "key: {key:?}"
        );
    }
}

#[test]
fn agent_voice_fish_payload_requires_key_version_and_label() {
    let valid: serde_json::Value =
        serde_json::from_str(&fish_content("fish:0123456789abcdef0123456789abcdef"))
            .expect("valid Fish body");
    for (field, bad_value, expected_error) in [
        ("key", None, "requires a string `key`"),
        (
            "key",
            Some(serde_json::json!(42)),
            "requires a string `key`",
        ),
        ("version", Some(serde_json::json!(2)), "`version` must be 1"),
        ("label", None, "requires a string `label`"),
        (
            "label",
            Some(serde_json::json!("")),
            "`label` must not be empty",
        ),
    ] {
        let mut body = valid.clone();
        let object = body.as_object_mut().expect("object");
        if let Some(value) = bad_value {
            object.insert(field.to_string(), value);
        } else {
            object.remove(field);
        }
        let event = make_agent_voice_content(&body.to_string(), KIND_AGENT_VOICE_D_TAG);
        let error = validate_agent_voice_envelope(&event).expect_err(field);
        assert!(error.contains(expected_error), "{field}: {error}");
        let event = make_assignment(&body.to_string(), &[&["d", AGENT_HEX]]);
        assert!(
            validate_agent_voice_assignment_envelope(&event).is_err(),
            "{field}"
        );
    }
}

#[test]
fn agent_voice_fish_reports_key_length_limit() {
    let key = format!("fish:{}", "a".repeat(68));
    let event = make_agent_voice_content(&fish_content(&key), KIND_AGENT_VOICE_D_TAG);
    let error = validate_agent_voice_envelope(&event).expect_err("73-character key");
    assert_eq!(error, "agent-voice selection `key` too long (max 72 chars)");
}
