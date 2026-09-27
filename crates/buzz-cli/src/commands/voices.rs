//! `buzz voices` — publish and query kind:30181 voice-catalog events, and
//! set/read agent voices: the agent's own kind:30182 selection (`select`) and
//! the owner-authored kind:30183 assignment (`assign`), read back by `get`.
//!
//! One event per voice, NIP-33 addressed by `(pubkey, kind, d = voice key)`.
//! `publish` canonicalizes the source audio through
//! [`buzz_voice::imported::PocketVoiceLibrary::import_path`] (the same
//! 32 kHz PCM16 mono canonicalizer the desktop uses) before uploading, so the
//! relay's structural voice-reference WAV validator always sees canonical
//! bytes. Bundled presets publish as asset-less rows from the shared
//! [`buzz_voice::bundled`] table. Design:
//! `docs/plans/2026-09-15-voice-repository-v1.md` §3, §8.

use crate::{client::normalize_write_response, error::CliError, BuzzClient};
use buzz_voice::bundled::{publishable_presets, EVE_VOICE_KEY};
use nostr::{EventBuilder, Tag};

/// Event kind for voice-catalog rows. Mirrors
/// `buzz_core::kind::KIND_VOICE_CATALOG`; hardcoded in the wire filters and
/// deletion coordinate rather than pulling in a `buzz-core` import per use.
const KIND_VOICE_CATALOG: u32 = 30181;

/// Agent's own voice selection. Mirrors `buzz_core::kind::KIND_AGENT_VOICE`.
const KIND_AGENT_VOICE: u32 = 30182;

/// Fixed `d` tag of a kind:30182 selection. Mirrors
/// `buzz_core::kind::KIND_AGENT_VOICE_D_TAG`.
const AGENT_VOICE_D_TAG: &str = "agent-voice";

/// Owner-authored agent voice assignment (`d` = agent pubkey hex). Mirrors
/// `buzz_core::kind::KIND_AGENT_VOICE_ASSIGNMENT`.
const KIND_AGENT_VOICE_ASSIGNMENT: u32 = 30183;

/// Kind-5 deletion request kind (NIP-09).
const KIND_DELETION: u32 = 5;

/// License every bundled preset is published under — the Kyutai/VCTK terms
/// the desktop already emits (`tts_settings.rs`).
const BUNDLED_LICENSE: &str = "CC-BY-4.0";

/// Maximum display-name length, matching the imported-voice label cap
/// (`crates/buzz-voice/src/imported.rs`, the `chars().take(80)` rule).
const DISPLAY_NAME_MAX: usize = 80;

/// Refuse to publish the one banned voice key.
///
/// `pocket:eve` is a stock preset every desktop bundles, but the
/// identity-test ban forbids catalog publication (and later pins) of that
/// exact key. Catalog publication is banned, not local use. This guard is the
/// single choke point both publish paths go through.
fn ensure_publishable_key(key: &str) -> Result<(), CliError> {
    if key == EVE_VOICE_KEY {
        return Err(CliError::Usage(
            "refusing to publish pocket:eve — that key is banned from the voice catalog \
             (identity-test ban); local use is unaffected"
                .into(),
        ));
    }
    Ok(())
}

/// Query the catalog: every member's voice rows, or one author's.
async fn cmd_list(client: &BuzzClient, author: Option<&str>) -> Result<(), CliError> {
    let mut filter = serde_json::json!({ "kinds": [KIND_VOICE_CATALOG] });
    if let Some(author) = author {
        crate::validate::validate_hex64(author)?;
        filter["authors"] = serde_json::json!([author]);
    }
    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

/// Canonicalize a source WAV through the shared voice library and upload the
/// canonical bytes, returning `(imported voice, blob descriptor)`.
///
/// The scratch library directory lives for the duration of the upload and is
/// removed afterwards; the descriptor's `sha256`/`size`/`mime_type` are what
/// the catalog row records.
async fn canonicalize_and_upload(
    client: &BuzzClient,
    file: &str,
) -> Result<
    (
        buzz_voice::imported::ImportedVoice,
        crate::client::BlobDescriptor,
    ),
    CliError,
> {
    let scratch = std::env::temp_dir().join(format!("buzz-voices-{}", uuid::Uuid::new_v4()));
    let uploaded = async {
        let library = buzz_voice::imported::PocketVoiceLibrary::new(&scratch);
        let imported = library
            .import_path(std::path::Path::new(file))
            .map_err(|e| CliError::Usage(format!("voice canonicalization failed: {e}")))?;
        let stored = library
            .resolve_file(&imported)
            .map_err(|e| CliError::Other(format!("canonical voice is unavailable: {e}")))?;
        let descriptor = client
            .upload_file(stored.to_string_lossy().as_ref())
            .await?;
        Ok((imported, descriptor))
    }
    .await;
    let _ = std::fs::remove_dir_all(&scratch);
    uploaded
}

/// Duration of a canonical voice WAV (32 kHz, PCM16, mono, 44-byte header) in
/// seconds, derived from its byte length.
fn canonical_duration_seconds(total_bytes: u64) -> f64 {
    let data_bytes = total_bytes.saturating_sub(44);
    data_bytes as f64 / (2.0 * f64::from(buzz_voice::imported::CANONICAL_SAMPLE_RATE))
}

/// Publish one imported voice: canonicalize → upload → kind:30181 row.
async fn cmd_publish(
    client: &BuzzClient,
    file: &str,
    name: &str,
    license: &str,
    source: &str,
    source_url: Option<&str>,
) -> Result<(), CliError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::Usage("voice --name must not be blank".into()));
    }
    if name.chars().count() > DISPLAY_NAME_MAX {
        return Err(CliError::Usage(format!(
            "voice --name is too long ({} chars, max {DISPLAY_NAME_MAX})",
            name.chars().count()
        )));
    }
    let (imported, descriptor) = canonicalize_and_upload(client, file).await?;

    // The imported key is `pocket:imported:<content-hash>` by construction;
    // verify rather than trust, and apply the eve ban to the derived key.
    let expected_key = format!("pocket:imported:{}", imported.content_hash);
    if imported.key != expected_key {
        return Err(CliError::Other(format!(
            "canonicalizer produced key {} but its content hash is {} — refusing to publish",
            imported.key, imported.content_hash
        )));
    }
    ensure_publishable_key(&imported.key)?;

    let body = serde_json::json!({
        "version": 1,
        "key": imported.key,
        "displayName": name,
        "backend": "pocket",
        "contentHash": imported.content_hash,
        "bundled": false,
        "license": license,
        "source": source,
        "sourceUrl": source_url,
        "asset": {
            "sha256": descriptor.sha256,
            "size": descriptor.size,
            "mimeType": descriptor.mime_type,
        },
        "sampleRate": buzz_voice::imported::CANONICAL_SAMPLE_RATE,
        "durationSeconds": canonical_duration_seconds(descriptor.size),
    });
    let d_tag = Tag::parse(["d", imported.key.as_str()])
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
    let builder = EventBuilder::new(
        nostr::Kind::Custom(KIND_VOICE_CATALOG as u16),
        body.to_string(),
    )
    .tag(d_tag);
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Publish every bundled preset as an asset-less catalog row.
///
/// Rows are `bundled: true`, license CC-BY-4.0, and carry the pinned VCTK
/// attribution URL. `pocket:eve` is excluded from the shared publishable set;
/// the skip is announced so a quiet absence is never read as a bug.
async fn cmd_publish_bundled(client: &BuzzClient) -> Result<(), CliError> {
    for preset in publishable_presets() {
        let body = serde_json::json!({
            "version": 1,
            "key": preset.key,
            "displayName": preset.display_name,
            "backend": "pocket",
            "contentHash": preset.sha256,
            "bundled": true,
            "license": BUNDLED_LICENSE,
            "source": format!("VCTK {}", preset.upstream_vctk_file),
            "sourceUrl": buzz_voice::bundled::source_url(preset),
            "asset": serde_json::Value::Null,
            "sampleRate": serde_json::Value::Null,
            "durationSeconds": serde_json::Value::Null,
        });
        let d_tag = Tag::parse(["d", preset.key])
            .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
        let builder = EventBuilder::new(
            nostr::Kind::Custom(KIND_VOICE_CATALOG as u16),
            body.to_string(),
        )
        .tag(d_tag);
        let event = client.sign_event(builder)?;
        let resp = client.submit_event(event).await?;
        println!("{preset_key}: {resp}", preset_key = preset.key);
    }
    println!("skipped pocket:eve: banned from catalog publication (identity-test ban)");
    Ok(())
}

/// Remove one of the caller's own catalog rows via the generic kind:5
/// `a`-tag coordinate delete (`30181:<self>:<key>`) — the same shape as the
/// desktop's `build_agent_delete`.
async fn cmd_remove(client: &BuzzClient, key: &str) -> Result<(), CliError> {
    if key.is_empty() || key.chars().any(char::is_control) || key.chars().any(char::is_whitespace) {
        return Err(CliError::Usage("voice --key must be a single token".into()));
    }
    let self_hex = client.keys().public_key().to_hex();
    let coord = format!("{KIND_VOICE_CATALOG}:{self_hex}:{key}");
    let a_tag = Tag::parse(["a", coord.as_str()])
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
    let builder = EventBuilder::new(nostr::Kind::Custom(KIND_DELETION as u16), "").tag(a_tag);
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Build the engine-tagged v1 selection body for a voice key.
///
/// The engine is read off the key prefix; the relay enforces the full grammar
/// (slug shape, `pocket:eve` ban, eleven id shape), so this only refuses keys
/// no engine could own. The label defaults to the part after the prefix.
fn selection_body(key: &str, label: Option<&str>) -> Result<serde_json::Value, CliError> {
    let (engine, slug) = ["chatterbox", "pocket", "eleven"]
        .iter()
        .find_map(|engine| {
            key.strip_prefix(engine)
                .and_then(|rest| rest.strip_prefix(':'))
                .map(|slug| (*engine, slug))
        })
        .ok_or_else(|| {
            CliError::Usage(format!(
                "voice key must start with `chatterbox:`, `pocket:`, or `eleven:` (got `{key}`)"
            ))
        })?;
    if slug.is_empty() {
        return Err(CliError::Usage(format!(
            "voice key `{key}` has an empty id"
        )));
    }
    let label = label.unwrap_or(slug);
    Ok(serde_json::json!({
        "version": 1,
        "engine": engine,
        "key": key,
        "label": label,
    }))
}

/// Publish the caller's own kind:30182 selection at the fixed `d` tag.
async fn cmd_select(client: &BuzzClient, key: &str, label: Option<&str>) -> Result<(), CliError> {
    let body = selection_body(key, label)?;
    let d_tag = Tag::parse(["d", AGENT_VOICE_D_TAG])
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
    let builder = EventBuilder::new(
        nostr::Kind::Custom(KIND_AGENT_VOICE as u16),
        body.to_string(),
    )
    .tag(d_tag);
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Publish (or clear) the caller's kind:30183 assignment for `agent`.
///
/// The relay accepts it only when the caller is the agent's registered owner.
async fn cmd_assign(
    client: &BuzzClient,
    agent: &str,
    key: Option<&str>,
    label: Option<&str>,
    clear: bool,
) -> Result<(), CliError> {
    crate::validate::validate_hex64(agent)?;
    let agent = agent.to_ascii_lowercase();
    let builder = if clear {
        let self_hex = client.keys().public_key().to_hex();
        let coord = format!("{KIND_AGENT_VOICE_ASSIGNMENT}:{self_hex}:{agent}");
        let a_tag = Tag::parse(["a", coord.as_str()])
            .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
        EventBuilder::new(nostr::Kind::Custom(KIND_DELETION as u16), "").tag(a_tag)
    } else {
        let key =
            key.ok_or_else(|| CliError::Usage("a voice key or --clear is required".into()))?;
        let body = selection_body(key, label)?;
        let d_tag = Tag::parse(["d", agent.as_str()])
            .map_err(|e| CliError::Other(format!("tag error: {e}")))?;
        EventBuilder::new(
            nostr::Kind::Custom(KIND_AGENT_VOICE_ASSIGNMENT as u16),
            body.to_string(),
        )
        .tag(d_tag)
    };
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Newest event by `created_at` (ties: lower id wins, the NIP-01 replaceable rule).
fn newest(events: Vec<serde_json::Value>) -> Option<serde_json::Value> {
    events.into_iter().max_by(|a, b| {
        let ts = |e: &serde_json::Value| e["created_at"].as_u64().unwrap_or(0);
        let id = |e: &serde_json::Value| e["id"].as_str().unwrap_or("").to_string();
        ts(a).cmp(&ts(b)).then_with(|| id(b).cmp(&id(a)))
    })
}

/// Parse an event's JSON content into a selection object, if it is one.
fn content_json(event: &serde_json::Value) -> Option<serde_json::Value> {
    serde_json::from_str(event["content"].as_str()?).ok()
}

/// Resolve the relay-level precedence: owner assignment > own selection.
///
/// (Clients additionally place a listener-local channel override above, and
/// fall back to the pubkey-derived default below; neither is relay state.)
fn effective_voice(
    assignment: Option<&serde_json::Value>,
    selection: Option<&serde_json::Value>,
) -> serde_json::Value {
    if let Some(voice) = assignment.and_then(content_json) {
        return serde_json::json!({ "source": "owner-assignment", "voice": voice });
    }
    if let Some(voice) = selection.and_then(content_json) {
        return serde_json::json!({ "source": "agent-selection", "voice": voice });
    }
    serde_json::json!({ "source": "derived", "voice": serde_json::Value::Null })
}

/// Read an agent's kind:30183 assignment and kind:30182 selection.
async fn cmd_get(client: &BuzzClient, agent: &str) -> Result<(), CliError> {
    crate::validate::validate_hex64(agent)?;
    let agent = agent.to_ascii_lowercase();
    let assignment = newest(
        client
            .query_all(serde_json::json!({
                "kinds": [KIND_AGENT_VOICE_ASSIGNMENT],
                "#d": [agent],
            }))
            .await?,
    );
    let selection = newest(
        client
            .query_all(serde_json::json!({
                "kinds": [KIND_AGENT_VOICE],
                "authors": [agent],
                "#d": [AGENT_VOICE_D_TAG],
            }))
            .await?,
    );
    let out = serde_json::json!({
        "agent": agent,
        "effective": effective_voice(assignment.as_ref(), selection.as_ref()),
        "assignment": assignment,
        "selection": selection,
    });
    println!("{out}");
    Ok(())
}

pub async fn dispatch(cmd: crate::VoicesCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::VoicesCmd;
    match cmd {
        VoicesCmd::List { author } => cmd_list(client, author.as_deref()).await,
        VoicesCmd::Publish {
            file,
            name,
            license,
            source,
            source_url,
        } => {
            cmd_publish(
                client,
                &file,
                &name,
                &license,
                &source,
                source_url.as_deref(),
            )
            .await
        }
        VoicesCmd::PublishBundled => cmd_publish_bundled(client).await,
        VoicesCmd::Remove { key } => cmd_remove(client, &key).await,
        VoicesCmd::Select { key, label } => cmd_select(client, &key, label.as_deref()).await,
        VoicesCmd::Assign {
            agent,
            key,
            label,
            clear,
        } => cmd_assign(client, &agent, key.as_deref(), label.as_deref(), clear).await,
        VoicesCmd::Get { agent } => cmd_get(client, &agent).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voices_publish_refuses_eve_key() {
        let error = ensure_publishable_key("pocket:eve").expect_err("eve must be refused");
        assert!(
            error.to_string().contains("pocket:eve"),
            "refusal must name the banned key, got: {error}"
        );
        // Every other key shape passes, including imported keys.
        assert!(ensure_publishable_key("pocket:anna").is_ok());
        assert!(ensure_publishable_key(&format!("pocket:imported:{}", "a".repeat(64))).is_ok());
        // Near-misses are not the banned key.
        assert!(ensure_publishable_key("pocket:eve2").is_ok());
        assert!(ensure_publishable_key("Pocket:eve").is_ok());
    }

    #[test]
    fn canonical_duration_derives_from_canonical_byte_length() {
        // 44-byte header + 2 bytes per sample at 32 kHz.
        assert_eq!(canonical_duration_seconds(44), 0.0);
        assert_eq!(canonical_duration_seconds(44 + 64_000), 1.0);
        assert_eq!(canonical_duration_seconds(44 + 160_000), 2.5);
    }

    #[test]
    fn selection_body_reads_engine_from_key_prefix() {
        let body = selection_body("chatterbox:evie", None).expect("chatterbox");
        assert_eq!(body["engine"], "chatterbox");
        assert_eq!(body["key"], "chatterbox:evie");
        assert_eq!(body["label"], "evie");
        assert_eq!(body["version"], 1);
        let body = selection_body("pocket:anna", Some("Anna")).expect("pocket");
        assert_eq!(body["engine"], "pocket");
        assert_eq!(body["label"], "Anna");
        let body = selection_body("eleven:21m00Tcm4TlvDq8ikWAM", None).expect("eleven");
        assert_eq!(body["engine"], "eleven");
    }

    #[test]
    fn selection_body_refuses_unknown_or_empty_keys() {
        for bad in ["evie", "siri:aaron", "chatterbox:", "chatterboxevie", ""] {
            assert!(
                selection_body(bad, None).is_err(),
                "`{bad}` must be refused"
            );
        }
    }

    fn event(created_at: u64, id: &str, content: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "created_at": created_at, "id": id, "content": content.to_string() })
    }

    #[test]
    fn effective_voice_owner_assignment_beats_agent_selection() {
        let assign = event(1, "a", serde_json::json!({"key": "chatterbox:evie"}));
        let select = event(2, "b", serde_json::json!({"key": "pocket:anna"}));
        let eff = effective_voice(Some(&assign), Some(&select));
        assert_eq!(eff["source"], "owner-assignment");
        assert_eq!(eff["voice"]["key"], "chatterbox:evie");
        let eff = effective_voice(None, Some(&select));
        assert_eq!(eff["source"], "agent-selection");
        assert_eq!(eff["voice"]["key"], "pocket:anna");
        let eff = effective_voice(None, None);
        assert_eq!(eff["source"], "derived");
    }

    #[test]
    fn newest_picks_latest_created_at() {
        let old = event(10, "ff", serde_json::json!({"key": "chatterbox:old"}));
        let new = event(20, "00", serde_json::json!({"key": "chatterbox:new"}));
        let picked = newest(vec![old, new]).expect("some");
        assert_eq!(picked["created_at"], 20);
        assert!(newest(Vec::new()).is_none());
    }
}
