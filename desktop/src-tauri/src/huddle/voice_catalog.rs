//! Relay-backed community voice catalog (kind:30181).
//!
//! The catalog is a CACHE overlaid on the existing local voice registry,
//! exposed through one Tauri command ([`list_voice_catalog`]). The D5
//! fallback is structural: every failure path returns today's local-only
//! list — a query error keeps the previous cache untouched, an unparseable
//! row is dropped, and the picker never blocks on the network (the refresh
//! lands asynchronously and re-emits).
//!
//! Cache identity is the relay HTTP base URL: a community switch changes the
//! relay, the mismatch makes the stale rows inapplicable, and the merge falls
//! back to local-only until the new community's rows arrive. No
//! `resetCommunityState()` entry is needed — the state lives Rust-side behind
//! that key check, not in a React module singleton.
//!
//! Wire format: `docs/plans/2026-09-15-voice-repository-v1.md` §3, §6.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use buzz_core_pkg::kind::KIND_VOICE_CATALOG;

use crate::app_state::AppState;

use super::tts_settings::{POCKET_BACKEND_ID, VoiceProvenance, VoiceRegistryEntry, voice_registry};

/// How long a fetched catalog stays fresh. A stale cache is still served
/// (better than a flicker to local-only); only the refresh cadence depends
/// on this.
pub const VOICE_CATALOG_TTL: Duration = Duration::from_secs(5 * 60);

/// Availability string for catalog rows with no local copy. Already named as
/// a planned state in `VoiceRegistryEntry.availability`'s doc comment.
const VOICE_AVAILABILITY_DOWNLOADABLE: &str = "downloadable";

/// The JSON body of a kind:30181 voice-catalog event.
///
/// Mirrors the desktop's `VoiceRegistryEntry` shape field-for-field so the
/// reader maps rows almost directly. Optional fields default and skip when
/// absent, matching the `VoiceRegistryEntry`/`VoiceProvenance` convention.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogContent {
    /// Body version; readers refuse `version > 1` (registry-file precedent).
    pub version: u32,
    /// The stable voice key; MUST equal the event's `d` tag.
    pub key: String,
    /// Editable label (≤ 80 chars at publish).
    pub display_name: String,
    /// `"pocket"` in v1.
    pub backend: String,
    /// sha256 of the reference audio (64 lowercase hex). For imported rows
    /// this is the same hash the key is derived from.
    pub content_hash: String,
    /// True for stock presets (`pocket:<slug>`, asset-less).
    #[serde(default)]
    pub bundled: bool,
    /// Required attribution.
    pub license: String,
    /// Required attribution.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// `null` for bundled rows; `{sha256, size, mimeType}` otherwise. The
    /// sha256 is authoritative — the URL is derivable as
    /// `{relay-http-base}/media/{sha256}.wav`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<VoiceCatalogAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

/// Locator for an uploaded canonical WAV.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogAsset {
    /// sha256 of the uploaded canonical WAV; the locator is
    /// `{relay-http-base}/media/{sha256}.wav`.
    pub sha256: String,
    /// Blob size in bytes.
    pub size: u64,
    /// `audio/wav` in v1.
    pub mime_type: String,
}

/// One validated catalog row, reduced from an event.
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceCatalogRow {
    /// Author pubkey (hex) — coordinates never collide across authors, so
    /// this distinguishes two members' rows for the same key.
    pub author: String,
    /// Event `created_at` (unix seconds) — LWW within a coordinate.
    pub created_at: u64,
    pub content: VoiceCatalogContent,
}

/// Relay-fetched catalog rows plus the identity of the relay they came from.
#[derive(Default)]
pub struct VoiceCatalogCache {
    /// Relay HTTP base the rows were fetched from. A community switch changes
    /// the base, the mismatch drops the cache.
    pub relay_api_base: String,
    pub fetched_at: Option<Instant>,
    pub rows: Vec<VoiceCatalogRow>,
}

/// True when the cache is usable for `relay_api_base` right now: same relay
/// and fetched within the TTL.
pub fn cache_is_fresh(cache: &VoiceCatalogCache, relay_api_base: &str) -> bool {
    cache.relay_api_base == relay_api_base
        && cache
            .fetched_at
            .is_some_and(|fetched_at| fetched_at.elapsed() < VOICE_CATALOG_TTL)
}

/// Read one kind:30181 event into the content projection — the inbound
/// counterpart of the CLI publisher's body build.
///
/// Rejects (rather than repairs): future `version`, a `key` that does not
/// equal the event's `d` tag, and keys violating the §3.3 grammar. Rows
/// failing validation are dropped by [`rows_from_events`], never fatal.
pub fn catalog_content_from_event(event: &nostr::Event) -> Result<VoiceCatalogContent, String> {
    let content: VoiceCatalogContent = serde_json::from_str(event.content.as_ref())
        .map_err(|e| format!("failed to parse voice-catalog event content: {e}"))?;
    if content.version > 1 {
        return Err(format!(
            "voice-catalog content version {} is newer than this Buzz build supports",
            content.version
        ));
    }
    let d_tag = d_tag_of(event)
        .ok_or_else(|| "voice-catalog event must carry exactly one `d` tag".to_string())?;
    if content.key != d_tag {
        return Err(format!(
            "voice-catalog key {:?} does not match its `d` tag {:?}",
            content.key, d_tag
        ));
    }
    validate_voice_key(&content.key, &content.content_hash)?;
    Ok(content)
}

/// The voice-key grammar (§3.3): `pocket:<slug>` or
/// `pocket:imported:<64 lowercase hex>`, with the imported form required to
/// equal `pocket:imported:` + `content_hash` (the `valid_identity` rule).
fn validate_voice_key(key: &str, content_hash: &str) -> Result<(), String> {
    if let Some(hash) = key.strip_prefix("pocket:imported:") {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!(
                "imported voice key {key:?} is not pocket:imported:<64 lowercase hex>"
            ));
        }
        if hash != content_hash {
            return Err(format!(
                "imported voice key {key:?} must equal pocket:imported: + contentHash {:?}",
                content_hash
            ));
        }
        return Ok(());
    }
    if let Some(slug) = key.strip_prefix("pocket:") {
        if slug.is_empty()
            || slug
                .chars()
                .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'))
        {
            return Err(format!("bundled voice key {key:?} is not pocket:<slug>"));
        }
        return Ok(());
    }
    Err(format!(
        "voice key {key:?} must be pocket:<slug> or pocket:imported:<hash>"
    ))
}

fn d_tag_of(event: &nostr::Event) -> Option<&str> {
    let mut found: Option<Option<&str>> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(|name| name.as_str()) == Some("d") {
            if found.is_some() {
                return None; // ambiguous — the relay rejects this upstream anyway
            }
            found = Some(parts.get(1).map(|value| value.as_str()));
        }
    }
    // A valueless `["d"]` yields None here — treated as absent, matching how
    // the relay's NIP-33 addressing would see the empty coordinate.
    found.flatten()
}

/// Reduce raw query events into validated rows: one row per voice key, the
/// signer's own row preferred, otherwise last-write-wins by `created_at`.
/// Rows failing validation are dropped, not fatal.
pub fn rows_from_events(
    events: &[nostr::Event],
    own_pubkey_hex: Option<&str>,
) -> Vec<VoiceCatalogRow> {
    let mut by_key: Vec<VoiceCatalogRow> = Vec::new();
    for event in events {
        let Ok(content) = catalog_content_from_event(event) else {
            continue;
        };
        let row = VoiceCatalogRow {
            author: event.pubkey.to_hex(),
            created_at: event.created_at.as_secs(),
            content,
        };
        match by_key
            .iter_mut()
            .find(|existing| existing.content.key == row.content.key)
        {
            Some(existing) => {
                let own_row = own_pubkey_hex == Some(row.author.as_str());
                let own_existing = own_pubkey_hex == Some(existing.author.as_str());
                if (own_row && !own_existing)
                    || (own_row == own_existing && row.created_at >= existing.created_at)
                {
                    *existing = row;
                }
            }
            None => by_key.push(row),
        }
    }
    by_key.sort_by(|a, b| a.content.key.cmp(&b.content.key));
    by_key
}

/// Merge catalog rows into the local registry. LOCAL AVAILABILITY WINS: a
/// row whose key matches a local bundled/imported entry is skipped, so a
/// forged `pocket:eve` row is inert (the bundled row shadows it) and a
/// locally installed clip is never downgraded to "downloadable". Unmatched
/// rows are appended as downloadable entries.
pub fn merge_catalog_rows(
    mut local: Vec<VoiceRegistryEntry>,
    rows: &[VoiceCatalogRow],
) -> Vec<VoiceRegistryEntry> {
    for row in rows {
        if local.iter().any(|entry| entry.key == row.content.key) {
            continue;
        }
        local.push(catalog_row_to_entry(row));
    }
    local
}

fn catalog_row_to_entry(row: &VoiceCatalogRow) -> VoiceRegistryEntry {
    VoiceRegistryEntry {
        key: row.content.key.clone(),
        display_name: row.content.display_name.clone(),
        backend: POCKET_BACKEND_ID.to_string(),
        backend_name: "Pocket TTS".to_string(),
        availability: VOICE_AVAILABILITY_DOWNLOADABLE.to_string(),
        fallback_key: Some(super::tts_voice_registry::MARY_VOICE_KEY.to_string()),
        reference_file: None,
        provenance: VoiceProvenance {
            source: row.content.source.clone(),
            content_hash: Some(row.content.content_hash.clone()),
            license: Some(row.content.license.clone()),
            source_url: row.content.source_url.clone(),
        },
    }
}

/// Apply a fetch result to the cache. A successful fetch WHOLESALE-REPLACES
/// the rows — a full-result fold means kind:5 deletions propagate on every
/// refresh; a union would resurrect deleted rows. A failed fetch leaves the
/// cache (fresh or stale) untouched.
pub fn apply_refresh(
    cache: &mut VoiceCatalogCache,
    relay_api_base: &str,
    result: Result<Vec<VoiceCatalogRow>, String>,
) {
    match result {
        Ok(rows) => {
            *cache = VoiceCatalogCache {
                relay_api_base: relay_api_base.to_string(),
                fetched_at: Some(Instant::now()),
                rows,
            };
        }
        Err(error) => {
            eprintln!(
                "buzz-desktop: voice catalog refresh failed: {error}; keeping the previous cache"
            );
        }
    }
}

/// Fetch the catalog for `relay_api_base` and apply it to the cache, then
/// re-emit so open surfaces re-list. Deliberately never surfaces an error:
/// the picker already returned local (or stale-cache) rows.
fn spawn_catalog_refresh(app: AppHandle, relay_api_base: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = match crate::relay::query_relay(
            &state,
            &[serde_json::json!({
                "kinds": [KIND_VOICE_CATALOG],
                "limit": 500,
            })],
        )
        .await
        {
            Ok(events) => {
                let own_pubkey = state
                    .keys
                    .lock()
                    .map(|keys| keys.public_key().to_hex())
                    .ok();
                Ok(rows_from_events(&events, own_pubkey.as_deref()))
            }
            Err(error) => Err(error),
        };
        apply_refresh(
            &mut state
                .huddle_audio
                .voice_catalog
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            &relay_api_base,
            result,
        );
        if let Err(error) = app.emit("voice-catalog-updated", ()) {
            eprintln!("buzz-desktop: voice catalog re-emit failed: {error}");
        }
    });
}

/// The local registry overlaid with the community voice catalog.
///
/// Returns immediately: local entries plus whatever cached rows are
/// applicable to the current relay (any age). When the cache is missing,
/// mismatched, or stale, a background refresh is spawned and
/// `voice-catalog-updated` is emitted when it lands so open surfaces can
/// re-invoke.
#[tauri::command]
pub async fn list_voice_catalog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<VoiceRegistryEntry>, String> {
    let relay_api_base = crate::relay::relay_api_base_url_with_override(&state);
    let (applicable_rows, needs_refresh) = {
        let cache = state
            .huddle_audio
            .voice_catalog
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let matches_relay = cache.relay_api_base == relay_api_base;
        (
            matches_relay.then(|| cache.rows.clone()),
            !cache_is_fresh(&cache, &relay_api_base),
        )
    };
    if needs_refresh {
        spawn_catalog_refresh(app.clone(), relay_api_base);
    }
    Ok(merge_catalog_rows(
        voice_registry(&app),
        applicable_rows.as_deref().unwrap_or(&[]),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::huddle::tts_settings::bundled_voice_registry;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn azelma_hash() -> String {
        buzz_voice_pkg::bundled::POCKET_PRESETS
            .iter()
            .find(|preset| preset.key == "pocket:azelma")
            .expect("azelma preset")
            .sha256
            .to_string()
    }

    fn bundled_content(key: &str) -> VoiceCatalogContent {
        VoiceCatalogContent {
            version: 1,
            key: key.to_string(),
            display_name: "Azelma".to_string(),
            backend: "pocket".to_string(),
            content_hash: azelma_hash(),
            bundled: true,
            license: "CC-BY-4.0".to_string(),
            source: "VCTK p303_023_enhanced.wav".to_string(),
            source_url: None,
            asset: None,
            sample_rate: None,
            duration_seconds: None,
        }
    }

    fn voice_event(
        keys: &Keys,
        d_tag: &str,
        content: &VoiceCatalogContent,
        created_at: u64,
    ) -> nostr::Event {
        EventBuilder::new(Kind::Custom(KIND_VOICE_CATALOG as u16), {
            serde_json::to_string(content).expect("serialize content")
        })
        .tag(Tag::parse(["d", d_tag]).expect("d tag"))
        .custom_created_at(nostr::Timestamp::from(created_at))
        .sign_with_keys(keys)
        .expect("sign event")
    }

    #[test]
    fn catalog_content_round_trips_through_serde() {
        let content = bundled_content("pocket:azelma");
        let json = serde_json::to_string(&content).expect("serialize");
        let parsed: VoiceCatalogContent = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed, content);
        // camelCase wire shape, matching the design's §3.2 example.
        let value: serde_json::Value = serde_json::from_str(&json).expect("value");
        assert_eq!(value["displayName"], "Azelma");
        assert_eq!(value["contentHash"], azelma_hash());
        assert_eq!(value["bundled"], true);
    }

    #[test]
    fn parse_rejects_version_mismatch_key_d_mismatch_and_bad_grammar() {
        let keys = Keys::generate();
        let mut content = bundled_content("pocket:azelma");
        content.version = 2;
        let event = voice_event(&keys, "pocket:azelma", &content, 100);
        assert!(
            catalog_content_from_event(&event)
                .expect_err("future version")
                .contains("newer than this Buzz build supports")
        );

        let content = bundled_content("pocket:azelma");
        let event = voice_event(&keys, "pocket:eponine", &content, 100);
        assert!(
            catalog_content_from_event(&event)
                .expect_err("key/d mismatch")
                .contains("does not match its `d` tag")
        );

        // An imported key whose hash does not match contentHash is invalid.
        let mut imported = bundled_content(&format!("pocket:imported:{}", "a".repeat(64)));
        imported.bundled = false;
        imported.content_hash = azelma_hash();
        let event = voice_event(&keys, imported.key.as_str(), &imported, 100);
        assert!(
            catalog_content_from_event(&event)
                .expect_err("hash mismatch")
                .contains("pocket:imported: + contentHash")
        );

        // Uppercase hash, and a non-pocket backend prefix, are bad grammar.
        for key in [
            format!("pocket:imported:{}", "A".repeat(64)),
            "siri:aaron".to_string(),
        ] {
            let mut bad = bundled_content(&key);
            bad.bundled = false;
            let event = voice_event(&keys, &key, &bad, 100);
            assert!(catalog_content_from_event(&event).is_err(), "key {key}");
        }
    }

    #[test]
    fn rows_from_events_folds_by_key_own_author_wins_lww_otherwise() {
        let own_keys = Keys::generate();
        let foreign_keys = Keys::generate();
        let mut own_content = bundled_content("pocket:azelma");
        own_content.display_name = "Mine".to_string();
        let mut older_foreign = bundled_content("pocket:azelma");
        older_foreign.display_name = "Foreign older".to_string();
        let mut newer_foreign = bundled_content("pocket:azelma");
        newer_foreign.display_name = "Foreign newer".to_string();
        let foreign_other = bundled_content("pocket:eponine");

        let own = voice_event(&own_keys, "pocket:azelma", &own_content, 300);
        let f_old = voice_event(&foreign_keys, "pocket:azelma", &older_foreign, 100);
        let f_old2 = f_old.clone();
        let f_new = voice_event(&foreign_keys, "pocket:azelma", &newer_foreign, 200);
        let f_other = voice_event(&foreign_keys, "pocket:eponine", &foreign_other, 50);

        let own_hex = own_keys.public_key().to_hex();
        let rows = rows_from_events(
            &[f_new.clone(), f_old, own.clone(), f_other],
            Some(&own_hex),
        );
        // Two keys: azelma resolves to OUR row despite being newest-foreign;
        // eponine resolves to the foreign row.
        assert_eq!(rows.len(), 2, "one row per key, got {rows:?}");
        assert_eq!(rows[0].content.key, "pocket:azelma");
        assert_eq!(rows[0].content.display_name, "Mine");
        assert_eq!(rows[1].content.key, "pocket:eponine");

        // Without an own-author preference, last write wins by created_at.
        let rows = rows_from_events(&[f_new, f_old2], None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content.display_name, "Foreign newer");
        assert_eq!(rows[0].created_at, 200);
    }

    #[test]
    fn rows_from_events_drops_invalid_rows_without_failing() {
        let keys = Keys::generate();
        let good = voice_event(
            &keys,
            "pocket:azelma",
            &bundled_content("pocket:azelma"),
            100,
        );
        let mut bad = bundled_content("pocket:azelma");
        bad.key = "not-a-voice-key".to_string();
        let bad = voice_event(&keys, "pocket:azelma", &bad, 101);
        let rows = rows_from_events(&[bad, good], None);
        assert_eq!(
            rows.len(),
            1,
            "the invalid row is dropped, the good one kept"
        );
    }

    #[test]
    fn catalog_rows_merge_without_shadowing_local_availability() {
        // A foreign row re-publishing a bundled key must NOT downgrade the
        // local bundled entry — this is also what makes a forged pocket:eve
        // row inert on desktop.
        let mut foreign = bundled_content("pocket:eve");
        foreign.display_name = "Fake Eve".to_string();
        foreign.content_hash = "0".repeat(64);
        let forged = VoiceCatalogRow {
            author: OTHER.to_string(),
            created_at: 100,
            content: foreign,
        };
        // A genuinely new key appends as downloadable.
        let mut imported = bundled_content(&format!("pocket:imported:{}", azelma_hash()));
        imported.bundled = false;
        imported.key = format!("pocket:imported:{}", "9".repeat(64));
        imported.content_hash = "9".repeat(64);
        imported.asset = Some(VoiceCatalogAsset {
            sha256: "9".repeat(64),
            size: 184_354,
            mime_type: "audio/wav".to_string(),
        });
        let fresh = VoiceCatalogRow {
            author: OTHER.to_string(),
            created_at: 101,
            content: imported,
        };

        let merged = merge_catalog_rows(bundled_voice_registry(), &[forged, fresh]);
        // Local bundled rows keep their availability.
        let eve = merged
            .iter()
            .find(|entry| entry.key == "pocket:eve")
            .expect("local eve entry survives");
        assert_eq!(
            eve.display_name, "Eve",
            "the forged row must not shadow the local one"
        );
        assert_eq!(eve.availability, "bundled");
        let azelma = merged
            .iter()
            .find(|entry| entry.key == "pocket:azelma")
            .expect("local azelma entry survives");
        assert_eq!(azelma.availability, "bundled");
        // The fresh key appends as downloadable with provenance carried over.
        let appended = merged
            .iter()
            .find(|entry| entry.key == format!("pocket:imported:{}", "9".repeat(64)))
            .expect("unmatched row appends");
        assert_eq!(appended.availability, "downloadable");
        assert_eq!(appended.provenance.license.as_deref(), Some("CC-BY-4.0"));
        assert_eq!(appended.fallback_key.as_deref(), Some("pocket:mary"));
        assert_eq!(merged.len(), bundled_voice_registry().len() + 1);
    }

    #[test]
    fn relay_error_returns_local_registry_unchanged() {
        let mut cache = VoiceCatalogCache::default();
        cache.relay_api_base = "https://relay.example".to_string();
        cache.fetched_at = Some(Instant::now());
        cache.rows = vec![VoiceCatalogRow {
            author: OTHER.to_string(),
            created_at: 100,
            content: bundled_content("pocket:azelma"),
        }];
        let rows_before = cache.rows.clone();

        // The query failed — the cache (and therefore the next merge) keeps
        // the previous rows instead of collapsing to empty.
        apply_refresh(
            &mut cache,
            "https://relay.example",
            Err("relay unreachable".to_string()),
        );
        assert_eq!(cache.rows, rows_before);

        // And the merge output is unchanged local ⊕ previous cache.
        let merged = merge_catalog_rows(bundled_voice_registry(), &cache.rows);
        assert_eq!(merged.len(), bundled_voice_registry().len());
    }

    #[test]
    fn deleted_rows_drop_on_full_refresh() {
        let mut cache = VoiceCatalogCache::default();
        cache.relay_api_base = "https://relay.example".to_string();
        cache.rows = vec![
            VoiceCatalogRow {
                author: OTHER.to_string(),
                created_at: 100,
                content: bundled_content("pocket:azelma"),
            },
            VoiceCatalogRow {
                author: OTHER.to_string(),
                created_at: 101,
                content: bundled_content("pocket:eponine"),
            },
        ];

        // eponine's row was kind:5-deleted on the relay — the next successful
        // fetch simply no longer contains it. The cache REPLACES wholesale.
        apply_refresh(
            &mut cache,
            "https://relay.example",
            Ok(vec![VoiceCatalogRow {
                author: OTHER.to_string(),
                created_at: 102,
                content: bundled_content("pocket:azelma"),
            }]),
        );
        assert_eq!(
            cache.rows.len(),
            1,
            "deleted rows must drop, not union back"
        );
        assert_eq!(cache.rows[0].content.key, "pocket:azelma");
        assert!(cache_is_fresh(&cache, "https://relay.example"));
    }

    #[test]
    fn cache_does_not_apply_across_relay_bases() {
        let mut cache = VoiceCatalogCache::default();
        cache.relay_api_base = "https://old-relay.example".to_string();
        cache.fetched_at = Some(Instant::now());
        cache.rows = vec![VoiceCatalogRow {
            author: OTHER.to_string(),
            created_at: 100,
            content: bundled_content("pocket:azelma"),
        }];
        // A community switch changed the relay: not fresh for the new base.
        assert!(!cache_is_fresh(&cache, "https://new-relay.example"));
        assert!(cache_is_fresh(&cache, "https://old-relay.example"));
        // Past the TTL: stale even for the same base.
        cache.fetched_at = Some(Instant::now() - VOICE_CATALOG_TTL - Duration::from_secs(1));
        assert!(!cache_is_fresh(&cache, "https://old-relay.example"));
    }

    /// Desktop ↔ buzz-voice drift guard: the bundled preset table transcribed
    /// into buzz-voice must agree with the desktop's own registry on keys and
    /// hashes (and on the VCTK revision both build attribution URLs from).
    /// Editing EITHER table fails this test.
    #[test]
    fn bundled_presets_match_shared_table() {
        assert_eq!(
            crate::huddle::tts_voice_registry::VCTK_REVISION,
            buzz_voice_pkg::bundled::VCTK_REVISION,
            "the VCTK revisions must agree or the two source-url builders diverge"
        );
        let desktop: Vec<(&str, &str)> = crate::huddle::tts_voice_registry::POCKET_VOICES
            .iter()
            .map(|voice| (voice.key, voice.sha256))
            .collect();
        let shared: Vec<(&str, &str)> = buzz_voice_pkg::bundled::POCKET_PRESETS
            .iter()
            .map(|preset| (preset.key, preset.sha256))
            .collect();
        assert_eq!(
            desktop, shared,
            "desktop POCKET_VOICES and shared POCKET_PRESETS have drifted"
        );
    }
}
