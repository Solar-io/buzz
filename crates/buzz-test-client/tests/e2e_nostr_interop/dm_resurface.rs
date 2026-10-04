//! NIP-DV resurface over real HTTP/WS ingest and live fan-out.
use super::*;

async fn hide(keys: &Keys, channel: &str) {
    post_signed_event(
        keys,
        41012,
        vec![
            Tag::parse(["h", channel]).unwrap(),
            Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()]).unwrap(),
        ],
    )
    .await;
}

async fn submit(keys: &Keys, event: &nostr::Event) {
    let response = reqwest::Client::new()
        .post(format!("{}/events", relay_http_url()))
        .header("X-Pubkey", keys.public_key().to_hex())
        .json(event)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(
        body["accepted"], true,
        "event must really be accepted: {body}"
    );
}

#[tokio::test]
#[ignore = "requires an isolated running relay"]
async fn test_nipdv_new_chat_resurfaces_live_and_preserves_sender_hide() {
    let a = Keys::generate();
    let b = Keys::generate();
    let channel = create_dm(&a, &b.public_key().to_hex()).await;
    let c = Keys::generate();
    let other = create_dm(&a, &c.public_key().to_hex()).await;
    hide(&a, &other).await;
    let mut viewer = BuzzTestClient::connect(&relay_url(), &a).await.unwrap();
    let mut sender = BuzzTestClient::connect(&relay_url(), &b).await.unwrap();
    for kind in [9, 40002] {
        hide(&a, &channel).await;
        hide(&b, &channel).await;
        let before = read_snapshot_event(&mut viewer, &a.public_key().to_hex())
            .await
            .unwrap();
        assert!(read_hidden_dms(&mut viewer, &a.public_key().to_hex())
            .await
            .contains(&channel));
        let sender_before = read_snapshot_event(&mut sender, &b.public_key().to_hex())
            .await
            .unwrap();
        let sid = sub_id("nipdv-resurface-live");
        viewer
            .subscribe(
                &sid,
                vec![Filter::new().kind(Kind::Custom(30622)).custom_tag(
                    SingleLetterTag::lowercase(Alphabet::P),
                    a.public_key().to_hex(),
                )],
            )
            .await
            .unwrap();
        let history = viewer
            .collect_until_eose(&sid, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        let message = EventBuilder::new(Kind::Custom(kind), "new chat restores the DM")
            .tags([Tag::parse(["h", &channel]).unwrap()])
            .sign_with_keys(&b)
            .unwrap();
        if kind == 9 {
            submit(&b, &message).await;
        } else {
            let result = sender.send_event(message).await.unwrap();
            assert!(
                result.accepted,
                "WebSocket message acceptance: {}",
                result.message
            );
        }
        let after = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let RelayMessage::Event {
                    subscription_id,
                    event,
                } = viewer.recv_event(Duration::from_secs(5)).await.unwrap()
                {
                    if subscription_id == sid && event.kind == Kind::Custom(30622) {
                        break *event;
                    }
                }
            }
        })
        .await
        .expect("resurface snapshot must arrive LIVE without another query");
        after.verify().unwrap();
        assert_eq!(after.pubkey, before.pubkey);
        assert!(after.created_at > before.created_at);
        assert!(!after.tags.iter().any(|t| t.as_slice() == ["h", &channel]));
        assert!(
            after.tags.iter().any(|t| t.as_slice() == ["h", &other]),
            "the live replacement preserves unrelated hidden DMs"
        );
        assert_eq!(
            read_snapshot_event(&mut sender, &b.public_key().to_hex())
                .await
                .unwrap()
                .id,
            sender_before.id
        );
        assert!(read_hidden_dms(&mut sender, &b.public_key().to_hex())
            .await
            .contains(&channel));
        viewer.close_subscription(&sid).await.unwrap();
    }
    viewer.disconnect().await.unwrap();
    sender.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated running relay"]
async fn test_nipdv_accepted_reaction_edit_and_delete_keep_dm_hidden() {
    let a = Keys::generate();
    let b = Keys::generate();
    let channel = create_dm(&a, &b.public_key().to_hex()).await;
    let target = send_rest_message(&b, &channel, "original message").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    hide(&a, &channel).await;
    let mut viewer = BuzzTestClient::connect(&relay_url(), &a).await.unwrap();
    let before = read_snapshot_event(&mut viewer, &a.public_key().to_hex())
        .await
        .unwrap();
    for (kind, content) in [(7, "+"), (40003, "edited text"), (9005, "")] {
        let operation = EventBuilder::new(Kind::Custom(kind), content)
            .tags([
                Tag::parse(["h", &channel]).unwrap(),
                Tag::parse(["e", &target]).unwrap(),
            ])
            .sign_with_keys(&b)
            .unwrap();
        submit(&b, &operation).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let after = read_snapshot_event(&mut viewer, &a.public_key().to_hex())
            .await
            .unwrap();
        assert_eq!(
            after.id, before.id,
            "accepted kind {kind} must not refresh visibility"
        );
        assert!(read_hidden_dms(&mut viewer, &a.public_key().to_hex())
            .await
            .contains(&channel));
    }
    viewer.disconnect().await.unwrap();
}
