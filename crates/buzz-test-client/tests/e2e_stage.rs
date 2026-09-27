//! E2E: `buzz stage open` + 3× `buzz stage next` against a live relay.
//!
//! `#[ignore]` — needs a running relay, a built `buzz` binary, and a key that
//! may post in a channel:
//!
//! ```text
//! cargo build -p buzz-cli
//! RELAY_URL=wss://<relay> \
//! BUZZ_BIN=target/debug/buzz \
//! STAGE_E2E_NSEC=nsec1… STAGE_E2E_CHANNEL=<channel uuid> \
//! [BUZZ_AUTH_TAG='["auth",…]'] \
//! cargo test -p buzz-test-client --test e2e_stage -- --ignored
//! ```
//!
//! Asserts: exactly 4 stage kind-9 events (1 open + 3 parts), tag shapes, each
//! part's `imeta` sha256 == the manifest's `x` for its index, parts carry no
//! `e` tag, and the open event id is the session id.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use buzz_test_client::BuzzTestClient;
use nostr::{Alphabet, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};
use serde_json::Value;

/// A valid 1×1 PNG.
const PNG_1X1: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for this e2e test"))
}

fn buzz(args: &[&str], stage_dir: &Path) -> Value {
    let relay = env("RELAY_URL");
    let out = Command::new(env("BUZZ_BIN"))
        .args(args)
        .env("BUZZ_RELAY_URL", &relay)
        .env("BUZZ_PRIVATE_KEY", env("STAGE_E2E_NSEC"))
        .env("BUZZ_STAGE_DIR", stage_dir)
        // Not a managed session: no hold gate, no session stamp.
        .env_remove("BUZZ_ACP_SESSION_ID")
        .output()
        .expect("buzz binary runs");
    assert!(
        out.status.success(),
        "buzz {args:?} failed: {}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().last().expect("buzz printed JSON");
    serde_json::from_str(last).expect("stdout is JSON")
}

fn stage_json(event: &nostr::Event) -> Option<Value> {
    event.tags.iter().find_map(|t| {
        let s = t.as_slice();
        (s.first().map(String::as_str) == Some("stage"))
            .then(|| serde_json::from_str(&s[1]).expect("stage tag is JSON"))
    })
}

fn imeta_x(event: &nostr::Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter(|t| t.as_slice().first().map(String::as_str) == Some("imeta"))
        .flat_map(|t| t.as_slice()[1..].to_vec())
        .filter_map(|f| f.strip_prefix("x ").map(str::to_string))
        .collect()
}

#[tokio::test]
#[ignore]
async fn stage_open_then_three_nexts_publishes_four_tagged_events() {
    let work = std::env::temp_dir().join(format!("buzz-stage-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG_1X1)
        .unwrap();
    for n in 0..3 {
        std::fs::write(work.join(format!("{n}.png")), &png).unwrap();
    }
    let deck = serde_json::json!({
        "title": "e2e stage",
        "voice": false,
        "parts": (0..3).map(|n| serde_json::json!({
            "label": format!("frame-{n}"),
            "text": format!("Paragraph {n}."),
            "image": format!("{n}.png"),
        })).collect::<Vec<_>>(),
    });
    let deck_path = work.join("deck.json");
    std::fs::write(&deck_path, deck.to_string()).unwrap();
    let stage_dir = work.join("state");
    let channel = env("STAGE_E2E_CHANNEL");
    let since = Timestamp::now() - 5;

    let opened = buzz(
        &[
            "stage",
            "open",
            "--channel",
            &channel,
            "--deck",
            deck_path.to_str().unwrap(),
        ],
        &stage_dir,
    );
    let session = opened["session"].as_str().unwrap().to_string();
    assert_eq!(opened["total"], 3);
    for _ in 0..3 {
        buzz(&["stage", "next", "--session", &session], &stage_dir);
    }

    let keys = Keys::parse(&env("STAGE_E2E_NSEC")).unwrap();
    let mut client = BuzzTestClient::connect_unauthenticated(&env("RELAY_URL"))
        .await
        .unwrap();
    match std::env::var("BUZZ_AUTH_TAG") {
        Ok(raw) => {
            let parts: Vec<String> = serde_json::from_str(&raw).unwrap();
            let tag = Tag::parse(parts).unwrap();
            client.authenticate_with_nip_oa(&keys, &tag).await.unwrap();
        }
        Err(_) => client.authenticate(&keys).await.unwrap(),
    }
    let filter = Filter::new()
        .kind(Kind::Custom(9))
        .author(keys.public_key())
        .custom_tag(SingleLetterTag::lowercase(Alphabet::H), channel.clone())
        .since(since)
        .limit(200);
    client.subscribe("stage-e2e", vec![filter]).await.unwrap();
    let events = client
        .collect_until_eose("stage-e2e", Duration::from_secs(10))
        .await
        .unwrap();

    let mut ours: Vec<(nostr::Event, Value)> = events
        .into_iter()
        .filter_map(|e| stage_json(&e).map(|t| (e, t)))
        .filter(|(e, t)| e.id.to_hex() == session || t["s"] == session)
        .collect();
    ours.sort_by_key(|(e, _)| (e.created_at, e.id));
    assert_eq!(ours.len(), 4, "1 open + 3 parts");

    let (open, open_tag) = &ours[0];
    assert_eq!(open.id.to_hex(), session, "session id = open event id");
    assert_eq!(open_tag["op"], "open");
    let manifest = open_tag["parts"].as_array().unwrap();
    assert_eq!(manifest.len(), 3);

    let mut seen = Vec::new();
    for (event, tag) in &ours[1..] {
        assert_eq!(tag["op"], "part");
        assert!(tag.get("hold").is_none(), "next posts held showings");
        let i = tag["i"].as_u64().unwrap() as usize;
        seen.push(i);
        assert_eq!(
            imeta_x(event),
            vec![manifest[i]["x"].as_str().unwrap().to_string()]
        );
        assert!(
            !event
                .tags
                .iter()
                .any(|t| t.as_slice().first().map(String::as_str) == Some("e")),
            "parts carry no e tag"
        );
        assert!(event
            .content
            .starts_with(&format!("Paragraph {i}.\n![image](")));
    }
    seen.sort();
    assert_eq!(seen, vec![0, 1, 2]);
    let _ = std::fs::remove_dir_all(&work);
}
