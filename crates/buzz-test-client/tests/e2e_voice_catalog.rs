//! End-to-end tests for kind:30181 voice-catalog events.
//!
//! Kind 30181 is the per-voice community catalog: parameterized-replaceable,
//! `d` tag = the voice key, community-global (`channel_id = NULL`, a stray
//! `h` tag cannot channel-scope it), any-member publish (`UsersWrite`), and
//! public-read by design (in no gated set). These tests assert that wire
//! behaviour plus the ingest envelope rules:
//! - Exactly one non-empty `d` tag, bounded at 96 characters — the imported
//!   key `pocket:imported:<64-hex>` is 80 chars, which the generic 64-char
//!   bound would reject.
//! - Removal is the generic kind:5 `a`-tag coordinate delete.
//!
//! # Running
//!
//! Start the relay, then run:
//!
//! ```text
//! RELAY_URL=ws://localhost:3000 cargo test --test e2e_voice_catalog -- --ignored
//! ```

use std::time::Duration;

use buzz_test_client::BuzzTestClient;
use nostr::{Alphabet, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};

const VOICE_CATALOG_KIND: u16 = 30181;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn sub_id(name: &str) -> String {
    format!("e2e-voice-catalog-{name}-{}", uuid::Uuid::new_v4())
}

fn azelma_content() -> String {
    serde_json::json!({
        "version": 1,
        "key": "pocket:azelma",
        "displayName": "Azelma",
        "backend": "pocket",
        "contentHash": "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",
        "bundled": true,
        "license": "CC-BY-4.0",
        "source": "VCTK p303_023_enhanced.wav",
    })
    .to_string()
}

fn imported_content(hash: &str) -> String {
    serde_json::json!({
        "version": 1,
        "key": format!("pocket:imported:{hash}"),
        "displayName": "Azelma studio take",
        "backend": "pocket",
        "contentHash": hash,
        "bundled": false,
        "license": "CC-BY-4.0",
        "source": "Sam's own recording",
        "asset": {
            "sha256": "9f2c07e5a8c14a0b9d3e6f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
            "size": 184354,
            "mimeType": "audio/wav",
        },
    })
    .to_string()
}

/// Build a kind:30181 event with an explicit `d` tag and `created_at` so
/// NIP-33 head ordering is deterministic.
fn voice_event(keys: &Keys, d_tag: &str, content: &str, created_at: u64) -> nostr::Event {
    EventBuilder::new(Kind::Custom(VOICE_CATALOG_KIND), content)
        .tag(Tag::parse(["d", d_tag]).unwrap())
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .unwrap()
}

/// Build a kind:5 deletion carrying exactly one `a`-tag coordinate.
fn voice_delete(keys: &Keys, author_hex: &str, d_tag: &str) -> nostr::Event {
    let coord = format!("{VOICE_CATALOG_KIND}:{author_hex}:{d_tag}");
    EventBuilder::new(Kind::Custom(5), "")
        .tag(Tag::parse(["a", coord.as_str()]).unwrap())
        .sign_with_keys(keys)
        .unwrap()
}

fn author_filter(author: &Keys) -> Filter {
    Filter::new()
        .kind(Kind::Custom(VOICE_CATALOG_KIND))
        .author(author.public_key())
}

fn coordinate_filter(author: &Keys, d_tag: &str) -> Filter {
    author_filter(author).custom_tags(SingleLetterTag::lowercase(Alphabet::D), [d_tag])
}

fn d_tag_of(event: &nostr::Event) -> Option<&str> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        if parts.first().map(|p| p.as_str()) != Some("d") {
            return None;
        }
        Some(parts.get(1)?.as_str())
    })
}

/// A member's row is public-read and community-global: a foreign member REQs
/// it by kinds+author with NO `#h` scope and receives it.
#[tokio::test]
#[ignore]
async fn test_voice_catalog_public_read_by_foreign_member() {
    let url = relay_url();
    let author_keys = Keys::generate();
    let foreign_keys = Keys::generate();
    let d_tag = "pocket:azelma";

    let mut author = BuzzTestClient::connect(&url, &author_keys)
        .await
        .expect("connect author");
    let event = voice_event(
        &author_keys,
        d_tag,
        &azelma_content(),
        Timestamp::now().as_secs(),
    );
    let event_id = event.id;
    let ok = client_send(&mut author, event).await;
    assert!(
        ok.accepted,
        "relay rejected voice-catalog row: {}",
        ok.message
    );
    author.disconnect().await.expect("disconnect author");

    let mut foreign = BuzzTestClient::connect(&url, &foreign_keys)
        .await
        .expect("connect foreign");
    let sid = sub_id("foreign-read");
    foreign
        .subscribe(&sid, vec![author_filter(&author_keys)])
        .await
        .expect("subscribe");
    let events = foreign
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");

    assert!(
        events
            .iter()
            .any(|e| e.id == event_id && d_tag_of(e) == Some(d_tag)),
        "foreign member must read a public voice-catalog row, got {:?}",
        events.iter().map(|e| d_tag_of(e)).collect::<Vec<_>>()
    );

    foreign.disconnect().await.expect("disconnect foreign");
}

/// A stray `h` tag must not channel-scope a global-only kind: the event is
/// still accepted and still readable community-wide.
#[tokio::test]
#[ignore]
async fn test_voice_catalog_stray_h_tag_does_not_channel_scope() {
    let url = relay_url();
    let author_keys = Keys::generate();
    let foreign_keys = Keys::generate();
    let d_tag = "pocket:anna";

    let event = EventBuilder::new(Kind::Custom(VOICE_CATALOG_KIND), azelma_content())
        .tag(Tag::parse(["d", d_tag]).unwrap())
        .tag(Tag::parse(["h", &uuid::Uuid::new_v4().to_string()]).unwrap())
        .custom_created_at(Timestamp::now())
        .sign_with_keys(&author_keys)
        .unwrap();
    let event_id = event.id;

    let mut author = BuzzTestClient::connect(&url, &author_keys)
        .await
        .expect("connect author");
    let ok = client_send(&mut author, event).await;
    assert!(
        ok.accepted,
        "a stray h tag must not reject a global-only row: {}",
        ok.message
    );
    author.disconnect().await.expect("disconnect author");

    let mut foreign = BuzzTestClient::connect(&url, &foreign_keys)
        .await
        .expect("connect foreign");
    let sid = sub_id("stray-h");
    foreign
        .subscribe(&sid, vec![author_filter(&author_keys)])
        .await
        .expect("subscribe");
    let events = foreign
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");
    assert!(
        events.iter().any(|e| e.id == event_id),
        "a stray h tag must not hide the row from a community-wide reader"
    );

    foreign.disconnect().await.expect("disconnect foreign");
}

/// The full imported key — `pocket:imported:` + 64 hex, 80 chars — is a legal
/// `d` tag. This is the widened-bound contract: the generic 64-char rule
/// would make every imported row unpublishable.
#[tokio::test]
#[ignore]
async fn test_voice_catalog_accepts_full_imported_key_d_tag() {
    let url = relay_url();
    let keys = Keys::generate();
    let hash = "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026";
    let d_tag = format!("pocket:imported:{hash}");

    let mut client = BuzzTestClient::connect(&url, &keys).await.expect("connect");
    let event = voice_event(
        &keys,
        &d_tag,
        &imported_content(hash),
        Timestamp::now().as_secs(),
    );
    let ok = client_send(&mut client, event).await;
    assert!(
        ok.accepted,
        "the 80-char imported key must be accepted: {}",
        ok.message
    );

    // Roundtrip at the coordinate.
    let sid = sub_id("imported-key");
    client
        .subscribe(&sid, vec![coordinate_filter(&keys, &d_tag)])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");
    assert_eq!(
        events
            .iter()
            .filter(|e| d_tag_of(e) == Some(d_tag.as_str()))
            .count(),
        1,
        "the imported row must roundtrip at its NIP-33 coordinate"
    );

    client.disconnect().await.expect("disconnect");
}

/// Ingest refuses duplicate `d` tags and `d` tags beyond the widened
/// 96-character bound.
#[tokio::test]
#[ignore]
async fn test_voice_catalog_rejects_duplicate_and_overlong_d_tags() {
    let url = relay_url();
    let keys = Keys::generate();

    let mut client = BuzzTestClient::connect(&url, &keys).await.expect("connect");

    let duplicate = EventBuilder::new(Kind::Custom(VOICE_CATALOG_KIND), azelma_content())
        .tags(vec![
            Tag::parse(["d", "pocket:azelma"]).unwrap(),
            Tag::parse(["d", "pocket:eve"]).unwrap(),
        ])
        .sign_with_keys(&keys)
        .unwrap();
    let ok = client_send(&mut client, duplicate).await;
    assert!(!ok.accepted, "duplicate d tags must be rejected");
    assert!(
        ok.message.contains("invalid:"),
        "expected an `invalid:` refusal, got: {}",
        ok.message
    );

    let overlong = "a".repeat(97);
    let ok = client_send(
        &mut client,
        voice_event(
            &keys,
            &overlong,
            &azelma_content(),
            Timestamp::now().as_secs(),
        ),
    )
    .await;
    assert!(!ok.accepted, "a 97-char d tag must be rejected");
    assert!(
        ok.message.contains("invalid:"),
        "expected an `invalid:` refusal, got: {}",
        ok.message
    );

    client.disconnect().await.expect("disconnect");
}

/// NIP-33 replacement: republishing at the same coordinate leaves exactly one
/// head, and a kind:5 `a`-tag coordinate delete removes the row for a foreign
/// reader on the next fold.
#[tokio::test]
#[ignore]
async fn test_voice_catalog_replace_then_kind5_delete_removes_row() {
    let url = relay_url();
    let author_keys = Keys::generate();
    let foreign_keys = Keys::generate();
    let d_tag = "pocket:azelma";
    let now = Timestamp::now().as_secs();

    let mut author = BuzzTestClient::connect(&url, &author_keys)
        .await
        .expect("connect author");
    let ok = client_send(
        &mut author,
        voice_event(
            &author_keys,
            d_tag,
            &azelma_content(),
            now.saturating_sub(1),
        ),
    )
    .await;
    assert!(ok.accepted, "initial publish rejected: {}", ok.message);
    let ok = client_send(
        &mut author,
        voice_event(&author_keys, d_tag, &azelma_content(), now),
    )
    .await;
    assert!(ok.accepted, "replacement rejected: {}", ok.message);

    let ok = client_send(
        &mut author,
        voice_delete(&author_keys, &author_keys.public_key().to_hex(), d_tag),
    )
    .await;
    assert!(ok.accepted, "kind:5 deletion rejected: {}", ok.message);
    author.disconnect().await.expect("disconnect author");

    let mut foreign = BuzzTestClient::connect(&url, &foreign_keys)
        .await
        .expect("connect foreign");
    let sid = sub_id("post-delete");
    foreign
        .subscribe(&sid, vec![coordinate_filter(&author_keys, d_tag)])
        .await
        .expect("subscribe");
    let events = foreign
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");
    assert!(
        events.is_empty(),
        "a kind:5 coordinate delete must remove the row, got {} event(s)",
        events.len()
    );

    foreign.disconnect().await.expect("disconnect foreign");
}

async fn client_send(
    client: &mut BuzzTestClient,
    event: nostr::Event,
) -> buzz_test_client::OkResponse {
    client.send_event(event).await.expect("send event")
}
