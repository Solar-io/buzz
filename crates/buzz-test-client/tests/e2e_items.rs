//! End-to-end tests for items (kind 30623): ingest validation, channel-scoped
//! visibility, and the multi-writer fold.
//!
//! Requires a running relay; `#[ignore]`d like the other e2e suites.
//!
//! ```text
//! cargo test -p buzz-test-client --test e2e_items -- --ignored
//! ```

use std::time::Duration;

use buzz_core::item::fold_items;
use buzz_sdk::{build_item, new_item_id, ItemDraft};
use buzz_test_client::{BuzzTestClient, RelayMessage};
use nostr::{Alphabet, EventBuilder, EventId, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn sub_id(name: &str) -> String {
    format!("e2e-items-{name}-{}", Uuid::new_v4())
}

fn item_kind() -> Kind {
    Kind::Custom(30623)
}

/// Create a channel over WebSocket; `visibility` is `open` or `private`.
async fn create_channel(client: &mut BuzzTestClient, keys: &Keys, visibility: &str) -> Uuid {
    let channel = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["name", &format!("items-e2e-{channel}")]).unwrap(),
            Tag::parse(["channel_type", "stream"]).unwrap(),
            Tag::parse(["visibility", visibility]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();
    let ok = client.send_event(event).await.expect("create channel");
    assert!(ok.accepted, "channel creation failed: {}", ok.message);
    channel
}

async fn add_member(client: &mut BuzzTestClient, channel: Uuid, target: &Keys, signer: &Keys) {
    let event = EventBuilder::new(Kind::Custom(9000), "")
        .allow_self_tagging()
        .tags([
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["p", &target.public_key().to_hex()]).unwrap(),
        ])
        .sign_with_keys(signer)
        .unwrap();
    let ok = client.send_event(event).await.expect("put user");
    assert!(ok.accepted, "add member failed: {}", ok.message);
}

fn draft(reporter: &Keys, channel: Option<Uuid>, status: &str) -> ItemDraft {
    ItemDraft {
        d: new_item_id(),
        channel,
        item_type: "bug".into(),
        status: status.into(),
        title: "Composer drops the draft".into(),
        summary: Some("e2e".into()),
        body: String::new(),
        created: Timestamp::now().as_secs(),
        reporter: reporter.public_key().to_hex(),
        owner: None,
        source_event: None,
        project_coord: None,
        project_name: None,
    }
}

fn sign(draft: &ItemDraft, keys: &Keys, created_at: Timestamp) -> nostr::Event {
    build_item(draft, created_at)
        .expect("build item")
        .sign_with_keys(keys)
        .expect("sign item")
}

async fn query(client: &mut BuzzTestClient, name: &str, filter: Filter) -> Vec<nostr::Event> {
    let sid = sub_id(name);
    client
        .subscribe(&sid, vec![filter])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("EOSE");
    client.close_subscription(&sid).await.expect("close");
    events
}

fn by_d(d: &str) -> Filter {
    Filter::new()
        .kind(item_kind())
        .custom_tags(SingleLetterTag::lowercase(Alphabet::D), [d])
}

/// Drain live frames for `window`, returning any item events seen on `sid`.
async fn live_items(client: &mut BuzzTestClient, sid: &str, window: Duration) -> Vec<EventId> {
    let deadline = tokio::time::Instant::now() + window;
    let mut seen = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or(Duration::ZERO);
        if remaining.is_zero() {
            return seen;
        }
        match client.recv_event(remaining).await {
            Ok(RelayMessage::Event {
                subscription_id,
                event,
            }) if subscription_id == sid && event.kind == item_kind() => seen.push(event.id),
            Ok(_) => {}
            Err(_) => return seen,
        }
    }
}

#[tokio::test]
#[ignore]
async fn item_in_private_channel_hidden_from_non_member() {
    let url = relay_url();
    let a = Keys::generate();
    let b = Keys::generate();
    let mut ca = BuzzTestClient::connect(&url, &a).await.expect("connect A");
    let mut cb = BuzzTestClient::connect(&url, &b).await.expect("connect B");
    let channel = create_channel(&mut ca, &a, "private").await;

    // B subscribes to every item before A publishes, to observe live fan-out.
    let live_sid = sub_id("live");
    cb.subscribe(&live_sid, vec![Filter::new().kind(item_kind())])
        .await
        .expect("B live subscribe");
    cb.collect_until_eose(&live_sid, Duration::from_secs(5))
        .await
        .expect("B live EOSE");

    let d = draft(&a, Some(channel), "open");
    let ev = sign(&d, &a, Timestamp::now());
    let ok = ca.send_event(ev.clone()).await.expect("A publish");
    assert!(ok.accepted, "member item rejected: {}", ok.message);

    let leaked = live_items(&mut cb, &live_sid, Duration::from_secs(2)).await;
    assert!(
        !leaked.contains(&ev.id),
        "non-member received the private item via live fan-out"
    );

    // Positive control: the member reads it back, stored against the channel.
    let mine = query(&mut ca, "member", by_d(&d.d)).await;
    assert_eq!(mine.len(), 1, "member must see the item");

    let by_kind = query(&mut cb, "kind", Filter::new().kind(item_kind()).limit(1000)).await;
    assert!(
        !by_kind.iter().any(|e| e.id == ev.id),
        "non-member read the private item by kind"
    );
    let by_id = query(&mut cb, "ids", Filter::new().id(ev.id)).await;
    assert!(by_id.is_empty(), "non-member read the private item by id");
    let by_tag = query(&mut cb, "d", by_d(&d.d)).await;
    assert!(by_tag.is_empty(), "non-member read the private item by #d");

    ca.disconnect().await.expect("disconnect A");
    cb.disconnect().await.expect("disconnect B");
}

#[tokio::test]
#[ignore]
async fn global_item_visible_to_community_member() {
    let url = relay_url();
    let a = Keys::generate();
    let b = Keys::generate();
    let mut ca = BuzzTestClient::connect(&url, &a).await.expect("connect A");
    let mut cb = BuzzTestClient::connect(&url, &b).await.expect("connect B");

    let d = draft(&a, None, "open");
    let ev = sign(&d, &a, Timestamp::now());
    let ok = ca.send_event(ev.clone()).await.expect("A publish");
    assert!(ok.accepted, "global item rejected: {}", ok.message);

    let seen = query(&mut cb, "global", by_d(&d.d)).await;
    assert_eq!(seen.len(), 1, "community member must see a global item");
    assert_eq!(seen[0].id, ev.id);

    ca.disconnect().await.expect("disconnect A");
    cb.disconnect().await.expect("disconnect B");
}

#[tokio::test]
#[ignore]
async fn non_member_cannot_write_item_into_private_channel() {
    let url = relay_url();
    let a = Keys::generate();
    let b = Keys::generate();
    let mut ca = BuzzTestClient::connect(&url, &a).await.expect("connect A");
    let mut cb = BuzzTestClient::connect(&url, &b).await.expect("connect B");
    let channel = create_channel(&mut ca, &a, "private").await;

    let ev = sign(&draft(&b, Some(channel), "open"), &b, Timestamp::now());
    let ok = cb.send_event(ev).await.expect("B publish");
    assert!(!ok.accepted, "non-member write must be refused");
    assert!(
        ok.message.contains("not a channel member"),
        "unexpected rejection: {}",
        ok.message
    );

    ca.disconnect().await.expect("disconnect A");
    cb.disconnect().await.expect("disconnect B");
}

#[tokio::test]
#[ignore]
async fn second_author_head_coexists_and_folds() {
    let url = relay_url();
    let a = Keys::generate();
    let b = Keys::generate();
    let mut ca = BuzzTestClient::connect(&url, &a).await.expect("connect A");
    let mut cb = BuzzTestClient::connect(&url, &b).await.expect("connect B");
    let channel = create_channel(&mut ca, &a, "private").await;
    add_member(&mut ca, channel, &b, &a).await;

    let first = draft(&a, Some(channel), "open");
    let t0 = Timestamp::now();
    let ev_a = sign(&first, &a, t0);
    let ok = ca.send_event(ev_a.clone()).await.expect("A publish");
    assert!(ok.accepted, "A head rejected: {}", ok.message);

    // B marks it done: same identity (d, h, created, reporter), newer head.
    let mut done = first.clone();
    done.status = "done".into();
    let ev_b = sign(&done, &b, Timestamp::from(t0.as_secs() + 1));
    let ok = cb.send_event(ev_b.clone()).await.expect("B publish");
    assert!(ok.accepted, "B head rejected: {}", ok.message);

    let heads = query(&mut ca, "fold", by_d(&first.d)).await;
    assert_eq!(heads.len(), 2, "both authors' heads must be stored");
    let folded = fold_items(&heads);
    assert_eq!(folded.len(), 1);
    assert_eq!(folded[0].status, "done");
    assert_eq!(folded[0].updated_by, b.public_key().to_hex());
    assert_eq!(folded[0].reporter, a.public_key().to_hex());

    ca.disconnect().await.expect("disconnect A");
    cb.disconnect().await.expect("disconnect B");
}

#[tokio::test]
#[ignore]
async fn malformed_item_rejected_with_prefix() {
    let url = relay_url();
    let a = Keys::generate();
    let mut ca = BuzzTestClient::connect(&url, &a).await.expect("connect A");

    // A non-UUID h would otherwise store the item as community-global.
    let tags = vec![
        Tag::parse(["d", &new_item_id()]).unwrap(),
        Tag::parse(["h", "general"]).unwrap(),
        Tag::parse(["type", "bug"]).unwrap(),
        Tag::parse(["status", "open"]).unwrap(),
        Tag::parse(["title", "bad h"]).unwrap(),
        Tag::parse(["created", &Timestamp::now().as_secs().to_string()]).unwrap(),
        Tag::parse(["p", &a.public_key().to_hex(), "", "reporter"]).unwrap(),
    ];
    let ev = EventBuilder::new(item_kind(), "")
        .tags(tags)
        .allow_self_tagging()
        .sign_with_keys(&a)
        .unwrap();
    let ok = ca.send_event(ev).await.expect("publish");
    assert!(!ok.accepted, "malformed item must be refused");
    assert!(
        ok.message.starts_with("invalid: item:"),
        "unexpected rejection: {}",
        ok.message
    );

    ca.disconnect().await.expect("disconnect A");
}
