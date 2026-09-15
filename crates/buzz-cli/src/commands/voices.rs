//! `buzz voices` — publish and query kind:30181 voice-catalog events.
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
}
