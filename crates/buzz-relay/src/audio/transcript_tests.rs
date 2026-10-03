//! Call lines flowing, live, from a voice call into its parent channel — and
//! the end-of-call flush that must not duplicate them, through every path a
//! huddle can end by. Postgres-gated like the other DB-backed relay tests:
//!   `cargo test -p buzz-relay --lib transcript_tests -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use buzz_core::channel::{ChannelType, ChannelVisibility, MemberRole};
use buzz_core::kind::{
    BUZZ_SYSTEM_CALL_LINE, BUZZ_SYSTEM_CALL_TRANSCRIPT, TAG_BUZZ_CALL_SOURCE, TAG_BUZZ_SYSTEM,
};
use buzz_core::tenant::TenantContext;
use buzz_core::StoredEvent;
use buzz_db::CreateCommunityWithOwnerResult;
use nostr::{EventBuilder, Kind, Tag};
use uuid::Uuid;

use crate::audio::grace::GraceArchiveOutcome;
use crate::audio::handler::archive_empty_huddle;
use crate::audio::transcript::{flush_call_lines, flush_call_lines_for_archived};
use crate::handlers::ingest::{ingest_event, HttpAuthMethod, IngestAuth, IngestError};
use crate::state::AppState;

/// Real-PG state mirroring `workflow_sink::integration_tests::test_state`.
async fn test_state() -> (Arc<AppState>, sqlx::PgPool) {
    let config = crate::config::Config::from_env().expect("default config loads");
    let pool = sqlx::PgPool::connect_lazy(&config.database_url).expect("lazy pg pool");
    test_state_with_pool(pool).await
}

async fn test_state_with_pool(pool: sqlx::PgPool) -> (Arc<AppState>, sqlx::PgPool) {
    let mut config = crate::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
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
/// Sam and the agent are members of both.
async fn fixture() -> Fixture {
    let (state, pool) = test_state().await;
    fixture_with_state(state, pool).await
}

async fn fixture_with_state(state: Arc<AppState>, pool: sqlx::PgPool) -> Fixture {
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
    for who in [&sam, &agent] {
        state
            .db
            .ensure_user(community, &who.public_key().to_bytes())
            .await
            .expect("user");
    }
    for ch in [parent, huddle] {
        for who in [&sam, &agent] {
            // Sam (the creator) bootstraps himself, then invites the agent.
            let role = if who.public_key() == sam.public_key() {
                MemberRole::Owner
            } else {
                MemberRole::Member
            };
            state
                .db
                .add_member(
                    community,
                    ch,
                    &who.public_key().to_bytes(),
                    role,
                    Some(&sam.public_key().to_bytes()),
                )
                .await
                .expect("add member");
        }
    }
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

async fn isolated_fixture(pool: sqlx::PgPool) -> Fixture {
    buzz_db::migration::run_migrations(&pool)
        .await
        .expect("migrate isolated test database");
    let (state, pool) = test_state_with_pool(pool).await;
    fixture_with_state(state, pool).await
}

async fn discovery(f: &Fixture) -> Vec<StoredEvent> {
    f.state
        .db
        .query_events(&buzz_db::EventQuery {
            channel_id: Some(f.huddle),
            kinds: Some(vec![39000]),
            authors: Some(vec![f.state.relay_keypair.public_key().to_bytes().to_vec()]),
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(f.tenant.community())
        })
        .await
        .expect("query relay metadata")
}

async fn refresh_discovery(f: &Fixture) {
    crate::handlers::side_effects::emit_group_discovery_events(&f.tenant, &f.state, f.huddle)
        .await
        .expect("emit discovery");
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn grace_fire_archive_refreshes_archived_metadata_and_evicts_subscriptions(
    pool: sqlx::PgPool,
) {
    let f = isolated_fixture(pool).await;
    refresh_discovery(&f).await;
    let before = discovery(&f).await;
    assert_eq!(before.len(), 1);
    assert_eq!(tag(&before[0].event, "archived"), None);
    let conn = Uuid::new_v4();
    f.state.sub_registry.register_scoped(
        f.tenant.community(),
        conn,
        "call".into(),
        vec![],
        Some(f.huddle),
    );
    f.state
        .audio_rooms
        .get_or_create(f.tenant.community(), f.huddle);
    let token = f
        .state
        .audio_rooms
        .start_empty_grace(f.tenant.community(), f.huddle)
        .expect("arm grace");
    let sam_hex = hex(&f.sam);
    crate::audio::grace::run_empty_room_grace(
        Arc::clone(&f.state.audio_rooms),
        f.tenant.community(),
        f.huddle,
        Duration::ZERO,
        token,
        || archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex),
        || {},
    )
    .await;
    let after = discovery(&f).await;
    assert_eq!(after.len(), 1);
    assert_eq!(
        tag(&after[0].event, "archived"),
        Some("true"),
        "grace fire must refresh archived metadata"
    );
    assert!(after[0].event.created_at > before[0].event.created_at);
    after[0].event.verify().expect("valid relay signature");
    assert!(f
        .state
        .sub_registry
        .channel_subscriber_conns_scoped(f.tenant.community(), f.huddle)
        .is_empty());
    assert!(
        parent_events(&f, 9).await.is_empty(),
        "normal call end is silent"
    );
    assert_eq!(parent_events(&f, 48103).await.len(), 1);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn archived_discovery_selector_uses_latest_metadata_and_excludes_live_deleted_and_repaired_channels(
    pool: sqlx::PgPool,
) {
    let stale = isolated_fixture(pool).await;
    let repaired = fixture_with_state(Arc::clone(&stale.state), stale.pool.clone()).await;
    let active = fixture_with_state(Arc::clone(&stale.state), stale.pool.clone()).await;
    let deleted = fixture_with_state(Arc::clone(&stale.state), stale.pool.clone()).await;
    let missing = fixture_with_state(Arc::clone(&stale.state), stale.pool.clone()).await;
    refresh_discovery(&stale).await;
    refresh_discovery(&repaired).await;
    // Keep an older archived snapshot live to prove selection uses the
    // newest snapshot, rather than any archived tag in channel history.
    let old = EventBuilder::new(Kind::Custom(39000), "")
        .tags([
            Tag::parse(["d", &stale.huddle.to_string()]).unwrap(),
            Tag::parse(["archived", "true"]).unwrap(),
        ])
        .custom_created_at(nostr::Timestamp::from_secs(
            nostr::Timestamp::now().as_secs() - 60,
        ))
        .sign_with_keys(&stale.state.relay_keypair)
        .unwrap();
    stale
        .state
        .db
        .insert_event(stale.tenant.community(), &old, Some(stale.huddle))
        .await
        .expect("retain older archived snapshot");
    for f in [&stale, &repaired, &deleted, &missing] {
        f.state
            .db
            .archive_channel(f.tenant.community(), f.huddle)
            .await
            .expect("archive fixture");
    }
    refresh_discovery(&repaired).await;
    sqlx::query("UPDATE channels SET deleted_at = NOW() WHERE community_id = $1 AND id = $2")
        .bind(deleted.tenant.community().as_uuid())
        .bind(deleted.huddle)
        .execute(&stale.pool)
        .await
        .expect("delete fixture");
    // A newer actor-signed event and a neighbor community's event with the
    // same d-tag must not hide stale relay metadata in the target community.
    for (tenant, signer) in [
        (&stale.tenant, &stale.sam),
        (&active.tenant, &stale.state.relay_keypair),
    ] {
        let event = EventBuilder::new(Kind::Custom(39000), "")
            .tags([
                Tag::parse(["d", &stale.huddle.to_string()]).unwrap(),
                Tag::parse(["archived", "true"]).unwrap(),
            ])
            .custom_created_at(nostr::Timestamp::from_secs(
                nostr::Timestamp::now().as_secs() + 10,
            ))
            .sign_with_keys(signer)
            .unwrap();
        stale
            .state
            .db
            .insert_event(tenant.community(), &event, None)
            .await
            .expect("insert misleading metadata");
    }
    let relay = stale.state.relay_keypair.public_key().to_bytes();
    let rows = stale
        .state
        .db
        .archived_channels_missing_discovery(&relay, None, 100)
        .await
        .expect("selector");
    let mut ids: Vec<_> = rows.iter().map(|row| row.channel_id).collect();
    ids.sort();
    let mut expected = vec![stale.huddle, missing.huddle];
    expected.sort();
    assert_eq!(
        ids, expected,
        "only stale or missing archived metadata qualifies"
    );
    for row in &rows {
        let f = if row.channel_id == stale.huddle {
            &stale
        } else {
            &missing
        };
        assert_eq!(row.community_id, f.tenant.community());
        assert_eq!(row.host, f.tenant.host());
    }
    let first = stale
        .state
        .db
        .archived_channels_missing_discovery(&relay, None, 1)
        .await
        .expect("first page");
    assert_eq!(first.len(), 1);
    let next = stale
        .state
        .db
        .archived_channels_missing_discovery(
            &relay,
            Some((*first[0].community_id.as_uuid(), first[0].channel_id)),
            1,
        )
        .await
        .expect("second page");
    assert_eq!(next.len(), 1);
    assert_ne!(first[0].channel_id, next[0].channel_id);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn archived_discovery_reconciliation_repairs_multiple_batches_and_is_idempotent(
    pool: sqlx::PgPool,
) {
    let first = isolated_fixture(pool).await;
    let second = fixture_with_state(Arc::clone(&first.state), first.pool.clone()).await;
    let mut channels = Vec::new();
    for n in 0..101 {
        let f = if n % 2 == 0 { &first } else { &second };
        let ch = f
            .state
            .db
            .create_channel(
                f.tenant.community(),
                "ended call",
                ChannelType::Stream,
                ChannelVisibility::Private,
                None,
                &f.sam.public_key().to_bytes(),
                Some(3600),
            )
            .await
            .expect("call channel");
        f.state
            .db
            .archive_channel(f.tenant.community(), ch.id)
            .await
            .expect("archive call");
        channels.push((f.tenant.community(), ch.id));
    }
    let relay = first.state.relay_keypair.public_key().to_bytes();
    assert_eq!(
        first
            .state
            .db
            .archived_channels_missing_discovery(&relay, None, 1000)
            .await
            .expect("bounded page")
            .len(),
        100
    );
    crate::handlers::archived_discovery::reconcile_archived_channel_discovery(&first.state).await;
    assert!(first
        .state
        .db
        .archived_channels_missing_discovery(&relay, None, 100)
        .await
        .expect("repaired selector")
        .is_empty());
    let mut event_ids = Vec::new();
    for (community, channel) in &channels {
        let events = first
            .state
            .db
            .query_events(&buzz_db::EventQuery {
                channel_id: Some(*channel),
                kinds: Some(vec![39000]),
                limit: Some(1),
                ..buzz_db::EventQuery::for_community(*community)
            })
            .await
            .expect("repaired metadata");
        assert_eq!(events.len(), 1);
        assert_eq!(tag(&events[0].event, "archived"), Some("true"));
        event_ids.push(events[0].event.id);
    }
    crate::handlers::archived_discovery::reconcile_archived_channel_discovery(&first.state).await;
    for ((community, channel), id) in channels.iter().zip(event_ids) {
        let events = first
            .state
            .db
            .query_events(&buzz_db::EventQuery {
                channel_id: Some(*channel),
                kinds: Some(vec![39000]),
                limit: Some(1),
                ..buzz_db::EventQuery::for_community(*community)
            })
            .await
            .expect("unchanged metadata");
        assert_eq!(events[0].event.id, id, "second run emits nothing");
    }
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn archived_discovery_reconciliation_database_error_is_fail_open(pool: sqlx::PgPool) {
    let f = isolated_fixture(pool).await;
    f.pool.close().await;
    crate::handlers::archived_discovery::reconcile_archived_channel_discovery(&f.state).await;
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

fn call_event(f: &Fixture, keys: &nostr::Keys, secs: u64, content: &str) -> nostr::Event {
    EventBuilder::new(Kind::from(9u16), content)
        .tags([Tag::parse(["h", &f.huddle.to_string()]).unwrap()])
        .custom_created_at(nostr::Timestamp::from_secs(secs))
        .sign_with_keys(keys)
        .unwrap()
}

fn auth_for(keys: &nostr::Keys) -> IngestAuth {
    IngestAuth::Http {
        pubkey: keys.public_key(),
        scopes: vec![buzz_auth::Scope::MessagesWrite],
        auth_method: HttpAuthMethod::Nip98,
    }
}

/// Send a call message the way a client does — through ingest, which is
/// where the live mirror hooks in.
async fn say(f: &Fixture, keys: &nostr::Keys, secs: u64, content: &str) {
    let ev = call_event(f, keys, secs, content);
    let r = ingest_event(&f.state, &f.tenant, ev, auth_for(keys))
        .await
        .expect("call message accepted");
    assert!(r.accepted, "call message accepted: {}", r.message);
}

/// Store a call message WITHOUT going through ingest — the live mirror never
/// sees it, standing in for a line the live path missed (relay restart).
async fn post_missed(f: &Fixture, keys: &nostr::Keys, secs: u64, content: &str) {
    let ev = call_event(f, keys, secs, content);
    f.state
        .db
        .insert_event(f.tenant.community(), &ev, Some(f.huddle))
        .await
        .expect("insert huddle message");
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

/// Poll until the parent holds `n` kind:9 (the live mirror is spawned).
async fn wait_for_lines(f: &Fixture, n: usize) -> Vec<StoredEvent> {
    let mut got = Vec::new();
    for _ in 0..100 {
        got = parent_events(f, 9).await;
        if got.len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    got
}

fn tag<'a>(ev: &'a nostr::Event, name: &str) -> Option<&'a str> {
    ev.tags.iter().find_map(|t| {
        let s = t.as_slice();
        (s.first().map(String::as_str) == Some(name)).then(|| s.get(1).map(String::as_str))?
    })
}

/// The parent's kind:9s, oldest first, as `(actor hex, content)` — after
/// checking each is a relay-signed, valid, no-trigger call line.
fn lines(f: &Fixture, events: &[StoredEvent]) -> Vec<(String, String)> {
    let mut evs: Vec<&nostr::Event> = events.iter().map(|s| &s.event).collect();
    evs.sort_by_key(|e| e.created_at);
    evs.into_iter()
        .map(|e| {
            assert_eq!(e.pubkey, f.state.relay_keypair.public_key(), "relay-signed");
            e.verify().expect("valid signature");
            assert_eq!(tag(e, TAG_BUZZ_SYSTEM), Some(BUZZ_SYSTEM_CALL_LINE));
            assert_eq!(tag(e, "h"), Some(f.parent.to_string().as_str()));
            assert!(tag(e, TAG_BUZZ_CALL_SOURCE).is_some());
            assert!(tag(e, "p").is_none(), "no mention copied");
            (
                tag(e, "actor").expect("actor").to_string(),
                e.content.clone(),
            )
        })
        .collect()
}

fn hex(k: &nostr::Keys) -> String {
    k.public_key().to_hex()
}

fn call_lines(f: &Fixture) -> Vec<(String, String)> {
    vec![
        (hex(&f.sam), "which drill should I buy?".into()),
        (hex(&f.agent), "The DeWalt 20V — best value.".into()),
        (hex(&f.sam), "thanks".into()),
    ]
}

/// The call as clients send it: every line through ingest (live path).
async fn live_call(f: &Fixture) {
    let base = nostr::Timestamp::now().as_secs() - 60;
    say(f, &f.sam, base, "[voice] which drill should I buy?").await;
    say(f, &f.agent, base + 1, "The DeWalt 20V — best value.").await;
    say(f, &f.sam, base + 2, "[voice] thanks").await;
}

/// The same call, none of it seen by the live path.
async fn missed_call(f: &Fixture) {
    let base = nostr::Timestamp::now().as_secs() - 60;
    post_missed(f, &f.sam, base, "[voice] which drill should I buy?").await;
    post_missed(f, &f.agent, base + 1, "The DeWalt 20V — best value.").await;
    post_missed(f, &f.sam, base + 2, "[voice] thanks").await;
}

// ── Live flow ────────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn each_call_line_flows_into_the_parent_live_attributed_to_its_speaker() {
    let f = fixture().await;
    let base = nostr::Timestamp::now().as_secs() - 60;

    say(&f, &f.sam, base, "[voice] which drill should I buy?").await;
    // Live: the first line is in the parent before the call goes on.
    let first = wait_for_lines(&f, 1).await;
    assert_eq!(
        lines(&f, &first),
        vec![(hex(&f.sam), "which drill should I buy?".to_string())]
    );
    assert_eq!(
        first[0].event.created_at.as_secs(),
        base,
        "line keeps the time it was spoken"
    );

    say(&f, &f.agent, base + 1, "The DeWalt 20V — best value.").await;
    say(&f, &f.sam, base + 2, "[voice] thanks").await;
    assert_eq!(lines(&f, &wait_for_lines(&f, 3).await), call_lines(&f));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn messages_in_an_ordinary_channel_are_not_mirrored() {
    let f = fixture().await;
    let ev = EventBuilder::new(Kind::from(9u16), "plain")
        .tags([Tag::parse(["h", &f.parent.to_string()]).unwrap()])
        .sign_with_keys(&f.sam)
        .unwrap();
    ingest_event(&f.state, &f.tenant, ev, auth_for(&f.sam))
        .await
        .expect("accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let evs = parent_events(&f, 9).await;
    assert_eq!(evs.len(), 1, "only the message itself");
    assert_eq!(evs[0].event.pubkey, f.sam.public_key());
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn no_lines_flow_into_an_unverified_parent() {
    // The only 48100 naming the huddle is signed by someone who is NOT the
    // huddle channel's creator — an unverified parent.
    let f = fixture().await;
    sqlx::query("DELETE FROM events WHERE community_id = $1 AND kind = 48100")
        .bind(f.tenant.community().as_uuid())
        .execute(&f.pool)
        .await
        .expect("drop creator link");
    link_huddle(&f, &f.agent.clone()).await;
    live_call(&f).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(parent_events(&f, 9).await.is_empty(), "nothing live");

    assert_eq!(
        flush_call_lines_for_archived(&f.state, &f.tenant, f.huddle).await,
        0
    );
    assert!(parent_events(&f, 9).await.is_empty(), "nothing at the end");
}

// ── Authorship cannot be forged ──────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_agent_cannot_get_a_line_attributed_to_sam() {
    let f = fixture().await;
    // The agent dresses its call message up as Sam's: an `actor` tag naming
    // Sam and a p-tag. The mirrored line is attributed to the SIGNER.
    let forged = EventBuilder::new(Kind::from(9u16), "[voice] buy the expensive one")
        .tags([
            Tag::parse(["h", &f.huddle.to_string()]).unwrap(),
            Tag::parse(["actor", &hex(&f.sam)]).unwrap(),
            Tag::parse(["p", &hex(&f.sam)]).unwrap(),
        ])
        .sign_with_keys(&f.agent)
        .unwrap();
    ingest_event(&f.state, &f.tenant, forged, auth_for(&f.agent))
        .await
        .expect("accepted in the call room");
    assert_eq!(
        lines(&f, &wait_for_lines(&f, 1).await),
        vec![(hex(&f.agent), "buy the expensive one".to_string())]
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ingest_rejects_client_events_carrying_buzz_system_tag() {
    let f = fixture().await;
    for value in [BUZZ_SYSTEM_CALL_LINE, BUZZ_SYSTEM_CALL_TRANSCRIPT] {
        let forged = EventBuilder::new(Kind::from(9u16), "I never said this")
            .tags([
                Tag::parse(["h", &f.parent.to_string()]).unwrap(),
                Tag::parse(["actor", &hex(&f.sam)]).unwrap(),
                Tag::parse([TAG_BUZZ_SYSTEM, value]).unwrap(),
            ])
            .sign_with_keys(&f.agent)
            .unwrap();
        match ingest_event(&f.state, &f.tenant, forged, auth_for(&f.agent)).await {
            Err(IngestError::Rejected(msg)) => {
                assert_eq!(msg, "restricted: buzz-system tag is relay-only");
            }
            Err(other) => panic!("forged buzz-system event: wrong error {other:?}"),
            Ok(r) => panic!(
                "forged buzz-system event must be rejected, accepted={} msg={}",
                r.accepted, r.message
            ),
        }
    }

    // Control: the same message without the tag is accepted, so the rejection
    // above is the tag and not a harness that rejects everything.
    let plain = EventBuilder::new(Kind::from(9u16), "I never said this")
        .tags([Tag::parse(["h", &f.parent.to_string()]).unwrap()])
        .sign_with_keys(&f.agent)
        .unwrap();
    let ok = ingest_event(&f.state, &f.tenant, plain, auth_for(&f.agent))
        .await
        .expect("plain message accepted");
    assert!(ok.accepted);
}

// ── Huddle end: no duplicate of what flowed live ─────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn grace_timer_end_after_a_live_call_adds_nothing() {
    let f = fixture().await;
    live_call(&f).await;
    assert_eq!(lines(&f, &wait_for_lines(&f, 3).await), call_lines(&f));

    let sam_hex = hex(&f.sam);
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::Ended);
    assert_eq!(
        parent_events(&f, 48103).await.len(),
        1,
        "48103 still emitted"
    );
    assert_eq!(
        lines(&f, &parent_events(&f, 9).await),
        call_lines(&f),
        "no end-of-call transcript, no duplicate line"
    );
    // Re-flushing either way is a no-op.
    assert_eq!(
        flush_call_lines(&f.state, &f.tenant, f.huddle, f.parent).await,
        0
    );
    assert_eq!(
        flush_call_lines_for_archived(&f.state, &f.tenant, f.huddle).await,
        0
    );
    assert_eq!(parent_events(&f, 9).await.len(), 3);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn grace_timer_end_flushes_lines_the_live_path_missed() {
    let f = fixture().await;
    missed_call(&f).await;
    assert!(parent_events(&f, 9).await.is_empty());

    let sam_hex = hex(&f.sam);
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::Ended);
    assert_eq!(lines(&f, &parent_events(&f, 9).await), call_lines(&f));

    // A second end attempt (racing fire / explicit archive) is a no-op.
    let again = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(again, GraceArchiveOutcome::AlreadyEnded);
    assert_eq!(parent_events(&f, 9).await.len(), 3);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn partly_missed_call_flushes_only_the_missing_line() {
    let f = fixture().await;
    let base = nostr::Timestamp::now().as_secs() - 60;
    say(&f, &f.sam, base, "[voice] which drill should I buy?").await;
    post_missed(&f, &f.agent, base + 1, "The DeWalt 20V — best value.").await;
    say(&f, &f.sam, base + 2, "[voice] thanks").await;
    assert_eq!(wait_for_lines(&f, 2).await.len(), 2);

    assert_eq!(
        flush_call_lines(&f.state, &f.tenant, f.huddle, f.parent).await,
        1
    );
    assert_eq!(lines(&f, &parent_events(&f, 9).await), call_lines(&f));
}

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
async fn client_9002_archive_flushes_missed_lines_and_grace_then_adds_nothing() {
    let f = fixture().await;
    missed_call(&f).await;

    client_archive(&f).await;
    assert_eq!(lines(&f, &parent_events(&f, 9).await), call_lines(&f));

    let sam_hex = hex(&f.sam);
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::AlreadyEnded);
    assert_eq!(parent_events(&f, 9).await.len(), 3);
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

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ttl_reaper_end_flushes_missed_lines() {
    let f = fixture().await;
    missed_call(&f).await;
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
    assert_eq!(lines(&f, &parent_events(&f, 9).await), call_lines(&f));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn silent_call_posts_nothing() {
    let f = fixture().await;
    let sam_hex = hex(&f.sam);
    let outcome = archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(outcome, GraceArchiveOutcome::Ended);
    assert_eq!(
        parent_events(&f, 48103).await.len(),
        1,
        "the end itself happened"
    );
    assert!(parent_events(&f, 9).await.is_empty());
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn flush_skipped_when_parent_is_the_channel() {
    let f = fixture().await;
    post_missed(&f, &f.sam, nostr::Timestamp::now().as_secs(), "[voice] hi").await;
    assert_eq!(
        flush_call_lines(&f.state, &f.tenant, f.parent, f.parent).await,
        0
    );
    assert!(parent_events(&f, 9).await.is_empty());
}

// ── Mirrored lines never fire workflows ──────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn call_lines_do_not_trigger_message_posted_workflows() {
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

    // Live lines AND an end-of-call flush of a missed line.
    live_call(&f).await;
    post_missed(
        &f,
        &f.agent,
        nostr::Timestamp::now().as_secs() - 10,
        "one more",
    )
    .await;
    wait_for_lines(&f, 3).await;
    let sam_hex = hex(&f.sam);
    archive_empty_huddle(&f.state, &f.tenant, f.huddle, f.parent, &sam_hex).await;
    assert_eq!(parent_events(&f, 9).await.len(), 4);
    // Workflow triggers are spawned; give any call-line run time to land.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(runs().await, 0, "no call line fired a workflow run");

    // Control: an ordinary message through the same dispatch DOES fire the
    // workflow, so zero call-line runs is the exclusion, not a dead workflow.
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
}
