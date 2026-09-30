//! Huddle end → call transcript in the parent channel, through every path a
//! huddle can end by. Postgres-gated like the other DB-backed relay tests:
//!   `cargo test -p buzz-relay --lib transcript_tests -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use buzz_core::channel::{ChannelType, ChannelVisibility};
use buzz_core::kind::{BUZZ_SYSTEM_CALL_TRANSCRIPT, TAG_BUZZ_SYSTEM};
use buzz_core::tenant::TenantContext;
use buzz_core::StoredEvent;
use buzz_db::CreateCommunityWithOwnerResult;
use nostr::{EventBuilder, Kind, Tag, ToBech32};
use uuid::Uuid;

use crate::audio::grace::GraceArchiveOutcome;
use crate::audio::handler::archive_empty_huddle;
use crate::audio::transcript::{emit_call_transcript, emit_call_transcript_for_archived};
use crate::handlers::ingest::{ingest_event, HttpAuthMethod, IngestAuth, IngestError};
use crate::state::AppState;

/// Real-PG state mirroring `workflow_sink::integration_tests::test_state`.
async fn test_state() -> (Arc<AppState>, sqlx::PgPool) {
    let mut config = crate::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    let pool = sqlx::PgPool::connect_lazy(&config.database_url).expect("lazy pg pool");
    let db = buzz_db::Db::from_pool(pool.clone());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager"),
    );
    let audit = buzz_audit::AuditService::new(pool.clone());
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool.clone());
    let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
    let (state, _audit_shutdown) = AppState::new(
        config,
        db,
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        nostr::Keys::generate(),
        media_storage,
    );
    (Arc::new(state), pool)
}

struct Fixture {
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    tenant: TenantContext,
    parent: Uuid,
    huddle: Uuid,
    sam: nostr::Keys,
    agent: nostr::Keys,
}

/// Parent channel + ephemeral huddle channel created by Sam, linked the way
/// clients link them: a Sam-signed kind:48100 in the parent naming the huddle.
async fn fixture() -> Fixture {
    let (state, pool) = test_state().await;
    let sam = nostr::Keys::generate();
    let agent = nostr::Keys::generate();
    let host = format!("huddle-tx-{}.example", Uuid::new_v4().simple());
    let community = match state
        .db
        .create_community_with_owner(&host, &sam.public_key().to_hex())
        .await
        .expect("create community")
    {
        CreateCommunityWithOwnerResult::Created(rec) => rec.id,
        other => panic!("expected fresh community, got {other:?}"),
    };
    let parent = state
        .db
        .create_channel(
            community,
            "jared",
            ChannelType::Stream,
            ChannelVisibility::Open,
            None,
            &sam.public_key().to_bytes(),
            None,
        )
        .await
        .expect("parent channel")
        .id;
    let huddle = state
        .db
        .create_channel(
            community,
            "Jared Dunn call",
            ChannelType::Stream,
            ChannelVisibility::Private,
            None,
            &sam.public_key().to_bytes(),
            Some(3600),
        )
        .await
        .expect("ephemeral huddle channel")
        .id;
    // Sam has a profile name; the agent deliberately does not (npub fallback).
    let sam_bytes = sam.public_key().to_bytes().to_vec();
    state
        .db
        .ensure_user(community, &sam_bytes)
        .await
        .expect("user");
    state
        .db
        .update_user_profile(community, &sam_bytes, Some("Sam"), None, None, None)
        .await
        .expect("profile");
    let f = Fixture {
        state,
        pool,
        tenant: TenantContext::resolved(community, host),
        parent,
        huddle,
        sam,
        agent,
    };
    link_huddle(&f, &f.sam.clone()).await;
    f
}

/// Insert a kind:48100 "huddle started" in the parent linking the huddle,
/// signed by `signer` (only the huddle channel's creator counts).
async fn link_huddle(f: &Fixture, signer: &nostr::Keys) {
    let ev = EventBuilder::new(
        Kind::from(48100u16),
        serde_json::json!({ "ephemeral_channel_id": f.huddle.to_string() }).to_string(),
    )
    .tags([Tag::parse(["h", &f.parent.to_string()]).unwrap()])
    .sign_with_keys(signer)
    .unwrap();
    f.state
        .db
        .insert_event(f.tenant.community(), &ev, Some(f.parent))
        .await
        .expect("insert 48100 link");
}

async fn post(f: &Fixture, keys: &nostr::Keys, secs: u64, content: &str) {
    let ev = EventBuilder::new(Kind::from(9u16), content)
        .tags([Tag::parse(["h", &f.huddle.to_string()]).unwrap()])
        .custom_created_at(nostr::Timestamp::from_secs(secs))
        .sign_with_keys(keys)
        .unwrap();
    f.state
        .db
        .insert_event(f.tenant.community(), &ev, Some(f.huddle))
        .await
        .expect("insert huddle message");
}

async fn post_call(f: &Fixture) {
    let base = nostr::Timestamp::now().as_secs() - 60;
    post(f, &f.sam, base, "[voice] which drill should I buy?").await;
    post(f, &f.agent, base + 1, "The DeWalt 20V — best value.").await;
    post(f, &f.sam, base + 2, "[voice] thanks").await;
}

fn expected_call_body(f: &Fixture) -> String {
    let npub = f.agent.public_key().to_bech32().unwrap();
    let agent_label = format!("{}…", &npub[..12]);
    format!(
        "📞 Call transcript — Jared Dunn call\n\n\
         Sam: which drill should I buy?\n\n\
         {agent_label}: The DeWalt 20V — best value.\n\n\
         Sam: thanks"
    )
}

async fn parent_events(f: &Fixture, kind: i32) -> Vec<StoredEvent> {
    f.state
        .db
        .query_events(&buzz_db::EventQuery {
            channel_id: Some(f.parent),
            kinds: Some(vec![kind]),
            limit: Some(50),
            ..buzz_db::EventQuery::for_community(f.tenant.community())
        })
        .await
        .expect("query parent")
}

/// Exactly one kind:9 in the parent, and it is the relay-signed, tagged call
/// transcript with the expected body.
async fn assert_one_transcript(f: &Fixture) {
    let transcripts = parent_events(f, 9).await;
    assert_eq!(transcripts.len(), 1, "exactly one transcript in the parent");
    let t = &transcripts[0].event;
    assert_eq!(t.pubkey, f.state.relay_keypair.public_key(), "relay-signed");
    t.verify().expect("valid signature");
    assert_eq!(t.content, expected_call_body(f));
    let has = |name: &str, value: &str| {
        t.tags.iter().any(|tag| {
            let s = tag.as_slice();
            s.first().map(String::as_str) == Some(name)
                && s.get(1).map(String::as_str) == Some(value)
        })
    };
    assert!(
        has(TAG_BUZZ_SYSTEM, BUZZ_SYSTEM_CALL_TRANSCRIPT),
        "no-trigger tag"
    );
    assert!(has("h", &f.parent.to_string()), "h tag = parent");
}

// ── Path 1: the relay's empty-room grace timer ───────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn grace_timer_end_posts_transcript_once() {
    let f = fixture().await;
    post_call(&f).await;

    let sam_hex = f.sam.public_key().to_hex();
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::Ended);
    assert_one_transcript(&f).await;
    assert_eq!(
        parent_events(&f, 48103).await.len(),
        1,
        "48103 still emitted"
    );

    // A second end attempt (racing fire / explicit archive) is a no-op.
    let again = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(again, GraceArchiveOutcome::AlreadyEnded);
    assert_eq!(parent_events(&f, 48103).await.len(), 1);

    // Replaying either emitter (belt-and-braces) dedupes on the event id.
    assert_eq!(
        emit_call_transcript(&f.state, &f.tenant, f.huddle, f.parent).await,
        None
    );
    assert_eq!(
        emit_call_transcript_for_archived(&f.state, &f.tenant, f.huddle).await,
        None
    );
    assert_one_transcript(&f).await;
}

// ── Path 2: a client ends the huddle (48103 + kind:9002 archived=true) ──────

async fn client_archive(f: &Fixture) {
    let ev = EventBuilder::new(Kind::from(9002u16), "")
        .tags([
            Tag::parse(["h", &f.huddle.to_string()]).unwrap(),
            Tag::parse(["archived", "true"]).unwrap(),
        ])
        .sign_with_keys(&f.sam)
        .unwrap();
    crate::handlers::side_effects::handle_side_effects(&f.tenant, 9002, &ev, &f.state)
        .await
        .expect("9002 archive side effect");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn client_9002_archive_posts_transcript_and_grace_then_adds_nothing() {
    let f = fixture().await;
    post_call(&f).await;

    client_archive(&f).await;
    assert_one_transcript(&f).await;

    // The relay's own grace timer fires afterwards: AlreadyEnded, no second
    // transcript (and no relay 48103 — the client sent its own).
    let sam_hex = f.sam.public_key().to_hex();
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::AlreadyEnded);
    assert_one_transcript(&f).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn client_9002_archive_without_creator_signed_link_posts_nothing() {
    // Same call, but the only 48100 naming the huddle is signed by someone who
    // is NOT the huddle channel's creator — an unverified parent.
    let f = fixture().await;
    sqlx::query("DELETE FROM events WHERE community_id = $1 AND kind = 48100")
        .bind(f.tenant.community().as_uuid())
        .execute(&f.pool)
        .await
        .expect("drop creator link");
    link_huddle(&f, &f.agent.clone()).await;
    post_call(&f).await;

    client_archive(&f).await;
    assert!(
        parent_events(&f, 9).await.is_empty(),
        "no transcript into an unverified parent"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn archiving_an_ordinary_channel_posts_nothing() {
    let f = fixture().await;
    let ev = EventBuilder::new(Kind::from(9002u16), "")
        .tags([
            Tag::parse(["h", &f.parent.to_string()]).unwrap(),
            Tag::parse(["archived", "true"]).unwrap(),
        ])
        .sign_with_keys(&f.sam)
        .unwrap();
    crate::handlers::side_effects::handle_side_effects(&f.tenant, 9002, &ev, &f.state)
        .await
        .expect("archive parent");
    assert!(parent_events(&f, 9).await.is_empty());
}

// ── Path 3: the TTL reaper ───────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ttl_reaper_end_posts_transcript() {
    let f = fixture().await;
    post_call(&f).await;
    sqlx::query(
        "UPDATE channels SET ttl_deadline = NOW() - interval '1 second' \
         WHERE community_id = $1 AND id = $2",
    )
    .bind(f.tenant.community().as_uuid())
    .bind(f.huddle)
    .execute(&f.pool)
    .await
    .expect("expire huddle channel");

    let reaped = crate::handlers::side_effects::run_ephemeral_reaper_tick(&f.state)
        .await
        .expect("reaper tick");
    assert!(reaped >= 1, "the expired huddle was reaped");
    assert_one_transcript(&f).await;
}

// ── Silent calls / non-ephemeral ─────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn silent_call_posts_no_transcript() {
    let f = fixture().await;
    let sam_hex = f.sam.public_key().to_hex();
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::Ended);
    assert_eq!(
        parent_events(&f, 48103).await.len(),
        1,
        "the end itself happened"
    );
    assert!(
        parent_events(&f, 9).await.is_empty(),
        "no transcript for a silent call"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn transcript_skipped_when_parent_is_the_channel() {
    let f = fixture().await;
    post(&f, &f.sam, nostr::Timestamp::now().as_secs(), "[voice] hi").await;
    assert_eq!(
        emit_call_transcript(&f.state, &f.tenant, f.parent, f.parent).await,
        None
    );
    assert!(parent_events(&f, 9).await.is_empty());
}

// ── Workflows never fire on the transcript ───────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn transcript_does_not_trigger_message_posted_workflows() {
    let f = fixture().await;
    let def_json = serde_json::json!({
        "name": "on-message",
        "trigger": {"on": "message_posted"},
        "steps": [{"id": "s1", "action": "send_message", "text": "seen"}],
        "enabled": true,
    })
    .to_string();
    let workflow_id = f
        .state
        .db
        .create_workflow(
            f.tenant.community(),
            Some(f.parent),
            &f.sam.public_key().to_bytes(),
            "on-message",
            &def_json,
            &[0u8; 32],
        )
        .await
        .expect("create workflow");
    let runs = || async {
        f.state
            .db
            .list_workflow_runs(f.tenant.community(), workflow_id, 10)
            .await
            .expect("list runs")
            .len()
    };

    post_call(&f).await;
    let sam_hex = f.sam.public_key().to_hex();
    archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_one_transcript(&f).await;

    // Control: an ordinary message through the same dispatch DOES fire the
    // workflow, so zero transcript runs is the exclusion, not a dead workflow.
    let human = EventBuilder::new(Kind::from(9u16), "hello")
        .tags([Tag::parse(["h", &f.parent.to_string()]).unwrap()])
        .sign_with_keys(&f.sam)
        .unwrap();
    let (stored, _) = f
        .state
        .db
        .insert_event(f.tenant.community(), &human, Some(f.parent))
        .await
        .expect("insert human message");
    crate::handlers::event::dispatch_persistent_event(
        &f.tenant, &f.state, &stored, 9, &sam_hex, None,
    )
    .await;
    let mut n = 0;
    for _ in 0..50 {
        n = runs().await;
        if n >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(n, 1, "the control message fires the workflow");
    // Give any straggling transcript-triggered run time to land.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(runs().await, 1, "the transcript fired no workflow run");
}

// ── Clients cannot submit a buzz-system tag ──────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ingest_rejects_client_events_carrying_buzz_system_tag() {
    let f = fixture().await;
    let auth = || IngestAuth::Http {
        pubkey: f.sam.public_key(),
        scopes: vec![buzz_auth::Scope::MessagesWrite],
        auth_method: HttpAuthMethod::Nip98,
    };
    let forged = EventBuilder::new(Kind::from(9u16), "📞 Call transcript — fake")
        .tags([
            Tag::parse(["h", &f.parent.to_string()]).unwrap(),
            Tag::parse([TAG_BUZZ_SYSTEM, BUZZ_SYSTEM_CALL_TRANSCRIPT]).unwrap(),
        ])
        .sign_with_keys(&f.sam)
        .unwrap();
    match ingest_event(&f.state, &f.tenant, forged, auth()).await {
        Err(IngestError::Rejected(msg)) => {
            assert_eq!(msg, "restricted: buzz-system tag is relay-only");
        }
        Err(other) => panic!("forged buzz-system event: wrong error {other:?}"),
        Ok(r) => panic!(
            "forged buzz-system event must be rejected, accepted={} msg={}",
            r.accepted, r.message
        ),
    }

    // Control: the same message without the tag is accepted, so the rejection
    // above is the tag and not a harness that rejects everything.
    let plain = EventBuilder::new(Kind::from(9u16), "📞 Call transcript — fake")
        .tags([Tag::parse(["h", &f.parent.to_string()]).unwrap()])
        .sign_with_keys(&f.sam)
        .unwrap();
    let ok = ingest_event(&f.state, &f.tenant, plain, auth())
        .await
        .expect("plain message accepted");
    assert!(ok.accepted);
}
