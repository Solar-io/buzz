//! End-to-end tests for kind:30182 agent-voice selection events.
//!
//! Kind 30182 is an agent's own speaking-voice binding: parameterized-
//! replaceable at the FIXED `d` tag `agent-voice` (one row per author — the
//! author pubkey IS the agent identity), community-global (`channel_id =
//! NULL`, a stray `h` tag cannot channel-scope it), any-member publish
//! (`UsersWrite`), and public-read by design (in no gated set). These tests
//! assert that wire behaviour plus the ingest rules:
//! - Exactly one `d` tag, equal to `agent-voice`.
//! - Payload is an engine-tagged selection: `local-synth` requires a
//!   `voiceURI`; `pocket` requires a catalog-row key (`pocket:<slug>` or the
//!   full `pocket:imported:<64-hex>` form); `pocket:eve` is refused.
//! - NIP-33 replacement at the fixed coordinate, and removal via the generic
//!   kind:5 `a`-tag coordinate delete.
//!
//! # Running
//!
//! Start the relay, then run:
//!
//! ```text
//! RELAY_URL=ws://localhost:3000 cargo test --test e2e_agent_voice -- --ignored
//! ```

use std::time::Duration;

use buzz_test_client::BuzzTestClient;
use nostr::{Alphabet, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};

const AGENT_VOICE_KIND: u16 = 30182;
const D_TAG: &str = "agent-voice";

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn sub_id(name: &str) -> String {
    format!("e2e-agent-voice-{name}-{}", uuid::Uuid::new_v4())
}

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

/// Build a kind:30182 event with an explicit `created_at` so NIP-33 head
/// ordering is deterministic.
fn agent_voice_event(keys: &Keys, content: &str, created_at: u64) -> nostr::Event {
    EventBuilder::new(Kind::Custom(AGENT_VOICE_KIND), content)
        .tag(Tag::parse(["d", D_TAG]).unwrap())
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .unwrap()
}

/// Build a kind:5 deletion carrying exactly one `a`-tag coordinate.
fn agent_voice_delete(keys: &Keys, author_hex: &str) -> nostr::Event {
    let coord = format!("{AGENT_VOICE_KIND}:{author_hex}:{D_TAG}");
    EventBuilder::new(Kind::Custom(5), "")
        .tag(Tag::parse(["a", coord.as_str()]).unwrap())
        .sign_with_keys(keys)
        .unwrap()
}

fn author_filter(author: &Keys) -> Filter {
    Filter::new()
        .kind(Kind::Custom(AGENT_VOICE_KIND))
        .author(author.public_key())
}

fn coordinate_filter(author: &Keys) -> Filter {
    author_filter(author).custom_tags(SingleLetterTag::lowercase(Alphabet::D), [D_TAG])
}

/// The selection is a property of the agent, readable community-wide: a
/// foreign member REQs it by kinds+author with NO `#h` scope and receives it.
#[tokio::test]
#[ignore]
async fn test_agent_voice_public_read_by_foreign_member() {
    let url = relay_url();
    let author_keys = Keys::generate();
    let foreign_keys = Keys::generate();

    let mut author = BuzzTestClient::connect(&url, &author_keys)
        .await
        .expect("connect author");
    let event = agent_voice_event(
        &author_keys,
        &local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
        Timestamp::now().as_secs(),
    );
    let event_id = event.id;
    let ok = client_send(&mut author, event).await;
    assert!(
        ok.accepted,
        "relay rejected agent-voice selection: {}",
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
        events.iter().any(|e| e.id == event_id),
        "foreign member must read a public agent-voice selection, got {} event(s)",
        events.len()
    );

    foreign.disconnect().await.expect("disconnect foreign");
}

/// Replacing the selection at the fixed coordinate leaves exactly ONE head —
/// the whole point of the fixed `d` tag — and switching engines replaces just
/// as cleanly.
#[tokio::test]
#[ignore]
async fn test_agent_voice_replace_leaves_one_head() {
    let url = relay_url();
    let keys = Keys::generate();
    let now = Timestamp::now().as_secs();

    let mut client = BuzzTestClient::connect(&url, &keys).await.expect("connect");
    // Distinct created_at per publish — the replacement MUST be newer. At
    // equal created_at the relay's NIP-33 tie-break keeps the lower event ID
    // (replaceable.rs), so sharing a timestamp makes the asserted winner
    // depend on random signing keys — a coin flip, not a test.
    for (index, content) in [
        pocket_content("pocket:azelma"),
        local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
    ]
    .into_iter()
    .enumerate()
    {
        let created_at = now.saturating_sub(1) + index as u64;
        let ok = client_send(&mut client, agent_voice_event(&keys, &content, created_at)).await;
        assert!(ok.accepted, "publish rejected: {}", ok.message);
    }

    let sid = sub_id("replace");
    client
        .subscribe(&sid, vec![coordinate_filter(&keys)])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");
    assert_eq!(
        events.len(),
        1,
        "NIP-33 replacement at the fixed d tag must leave exactly one head, got {}",
        events.len()
    );
    assert!(
        events[0].content.contains("local-synth"),
        "the surviving head must be the newer selection"
    );

    client.disconnect().await.expect("disconnect");
}

/// A kind:5 `a`-tag coordinate delete removes the selection for a foreign
/// reader on the next fold.
#[tokio::test]
#[ignore]
async fn test_agent_voice_kind5_delete_removes_selection() {
    let url = relay_url();
    let author_keys = Keys::generate();
    let foreign_keys = Keys::generate();

    let mut author = BuzzTestClient::connect(&url, &author_keys)
        .await
        .expect("connect author");
    let ok = client_send(
        &mut author,
        agent_voice_event(
            &author_keys,
            &local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
            Timestamp::now().as_secs(),
        ),
    )
    .await;
    assert!(ok.accepted, "initial publish rejected: {}", ok.message);
    let ok = client_send(
        &mut author,
        agent_voice_delete(&author_keys, &author_keys.public_key().to_hex()),
    )
    .await;
    assert!(ok.accepted, "kind:5 deletion rejected: {}", ok.message);
    author.disconnect().await.expect("disconnect author");

    let mut foreign = BuzzTestClient::connect(&url, &foreign_keys)
        .await
        .expect("connect foreign");
    let sid = sub_id("post-delete");
    foreign
        .subscribe(&sid, vec![coordinate_filter(&author_keys)])
        .await
        .expect("subscribe");
    let events = foreign
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect");
    assert!(
        events.is_empty(),
        "a kind:5 coordinate delete must remove the selection, got {} event(s)",
        events.len()
    );

    foreign.disconnect().await.expect("disconnect foreign");
}

/// Ingest refuses: a `d` tag that is not the fixed constant, and malformed
/// payloads — unknown engine, missing `voiceURI`, non-catalog pocket key,
/// and the identity-test-banned `pocket:eve`.
#[tokio::test]
#[ignore]
async fn test_agent_voice_rejects_bad_envelope_and_payloads() {
    let url = relay_url();
    let keys = Keys::generate();

    let mut client = BuzzTestClient::connect(&url, &keys).await.expect("connect");

    // Wrong d tag — 30181-style key addressing must not fork a second slot.
    let wrong_d = EventBuilder::new(
        Kind::Custom(AGENT_VOICE_KIND),
        local_synth_content("com.apple.speech.synthesis.voice.Samantha"),
    )
    .tag(Tag::parse(["d", "pocket:azelma"]).unwrap())
    .sign_with_keys(&keys)
    .unwrap();
    let ok = client_send(&mut client, wrong_d).await;
    assert!(!ok.accepted, "a non-fixed d tag must be rejected");
    assert!(
        ok.message.contains("invalid:"),
        "expected an `invalid:` refusal, got: {}",
        ok.message
    );

    let refuses = |message: &str| {
        assert!(
            message.contains("invalid:"),
            "expected an `invalid:` refusal, got: {message}"
        );
    };

    // Unknown engine.
    let bad_engine = serde_json::json!({
        "version": 1,
        "engine": "siri",
        "label": "x",
    })
    .to_string();
    let ok = client_send(
        &mut client,
        agent_voice_event(&keys, &bad_engine, Timestamp::now().as_secs()),
    )
    .await;
    assert!(!ok.accepted, "an unknown engine must be rejected");
    refuses(&ok.message);

    // local-synth without a voiceURI.
    let no_uri = serde_json::json!({
        "version": 1,
        "engine": "local-synth",
        "label": "x",
    })
    .to_string();
    let ok = client_send(
        &mut client,
        agent_voice_event(&keys, &no_uri, Timestamp::now().as_secs()),
    )
    .await;
    assert!(
        !ok.accepted,
        "local-synth without voiceURI must be rejected"
    );
    refuses(&ok.message);

    // pocket with a key outside the catalog grammar.
    let ok = client_send(
        &mut client,
        agent_voice_event(
            &keys,
            &pocket_content("siri:aaron"),
            Timestamp::now().as_secs(),
        ),
    )
    .await;
    assert!(!ok.accepted, "a non-catalog pocket key must be rejected");
    refuses(&ok.message);

    // The identity-test-banned voice must not be selectable.
    let ok = client_send(
        &mut client,
        agent_voice_event(
            &keys,
            &pocket_content("pocket:eve"),
            Timestamp::now().as_secs(),
        ),
    )
    .await;
    assert!(!ok.accepted, "pocket:eve must be refused");
    refuses(&ok.message);

    client.disconnect().await.expect("disconnect");
}

async fn client_send(
    client: &mut BuzzTestClient,
    event: nostr::Event,
) -> buzz_test_client::OkResponse {
    client.send_event(event).await.expect("send event")
}
