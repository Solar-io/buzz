//! Isolated SQLx databases on the documented test Postgres, never the live stack.

use super::*;
use buzz_core::channel::{ChannelType, ChannelVisibility};
use buzz_core::kind::KIND_DM_VISIBILITY;
use buzz_core::StoredEvent;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

use crate::handlers::ingest::{ingest_event, HttpAuthMethod, IngestAuth};

struct Fixture {
    state: Arc<AppState>,
    tenant: TenantContext,
    a: Keys,
    b: Keys,
    dm: Uuid,
    pool: PgPool,
}

async fn fixture(pool: PgPool) -> Fixture {
    buzz_db::migration::run_migrations(&pool).await.unwrap();
    let mut config = crate::config::Config::from_env().unwrap();
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".into();
    let db = buzz_db::Db::from_pool(pool.clone());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .unwrap();
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .unwrap(),
    );
    let workflow = Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        Default::default(),
    ));
    let media = buzz_media::MediaStorage::new(&config.media).unwrap();
    let (state, _shutdown) = AppState::new(
        config.clone(),
        db,
        redis_pool,
        buzz_audit::AuditService::new(pool.clone()),
        pubsub,
        buzz_auth::AuthService::new(config.auth),
        buzz_search::SearchService::new(pool.clone()),
        workflow,
        Keys::generate(),
        media,
    );
    let state = Arc::new(state);
    let a = Keys::generate();
    let b = Keys::generate();
    let host = format!("dm-resurface-{}.example", Uuid::new_v4());
    let community = match state
        .db
        .create_community_with_owner(&host, &a.public_key().to_hex())
        .await
        .unwrap()
    {
        buzz_db::CreateCommunityWithOwnerResult::Created(record) => record.id,
        other => panic!("unexpected community result: {other:?}"),
    };
    let dm = state
        .db
        .open_dm(
            community,
            &[&b.public_key().to_bytes()],
            &a.public_key().to_bytes(),
        )
        .await
        .unwrap()
        .0
        .id;
    Fixture {
        state,
        tenant: TenantContext::resolved(community, host),
        a,
        b,
        dm,
        pool,
    }
}

fn event(keys: &Keys, channel: Uuid, kind: u16, content: &str, extra: Vec<Tag>) -> Event {
    EventBuilder::new(Kind::Custom(kind), content)
        .tags(
            [Tag::parse(["h", &channel.to_string()]).unwrap()]
                .into_iter()
                .chain(extra),
        )
        .sign_with_keys(keys)
        .unwrap()
}

fn auth(keys: &Keys) -> IngestAuth {
    IngestAuth::Http {
        pubkey: keys.public_key(),
        scopes: vec![buzz_auth::Scope::MessagesWrite],
        auth_method: HttpAuthMethod::Nip98,
    }
}

async fn snapshot(f: &Fixture, keys: &Keys) -> Option<StoredEvent> {
    f.state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_DM_VISIBILITY as i32]),
            pubkey: Some(f.state.relay_keypair.public_key().to_bytes().to_vec()),
            d_tag: Some(keys.public_key().to_hex()),
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(f.tenant.community())
        })
        .await
        .unwrap()
        .into_iter()
        .next()
}

async fn hide(f: &Fixture, keys: &Keys) -> Event {
    f.state
        .db
        .hide_dm(f.tenant.community(), f.dm, &keys.public_key().to_bytes())
        .await
        .unwrap();
    publish_dm_visibility_snapshot(&f.tenant, &f.state, &keys.public_key().to_bytes())
        .await
        .unwrap();
    snapshot(f, keys).await.unwrap().event
}

fn hidden_in(ev: &Event, channel: Uuid) -> bool {
    ev.tags
        .iter()
        .any(|tag| tag.as_slice() == ["h", &channel.to_string()])
}

async fn wait_resurfaced(f: &Fixture, keys: &Keys) -> Event {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(snapshot) = snapshot(f, keys).await {
                if !hidden_in(&snapshot.event, f.dm) {
                    return snapshot.event;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("new message must publish a snapshot without this DM")
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn accepted_chat_resurfaces_recipient_and_preserves_sender(pool: PgPool) {
    let f = fixture(pool).await;
    // A second hidden DM must remain in the complete snapshot.
    let c = Keys::generate();
    let other = f
        .state
        .db
        .open_dm(
            f.tenant.community(),
            &[&c.public_key().to_bytes()],
            &f.a.public_key().to_bytes(),
        )
        .await
        .unwrap()
        .0
        .id;
    f.state
        .db
        .hide_dm(f.tenant.community(), other, &f.a.public_key().to_bytes())
        .await
        .unwrap();
    for kind in [9, 40002] {
        let before_a = hide(&f, &f.a).await;
        let before_b = hide(&f, &f.b).await;
        assert!(hidden_in(&before_a, f.dm));
        let msg = event(&f.b, f.dm, kind, &format!("new chat {kind}"), vec![]);
        let result = ingest_event(&f.state, &f.tenant, msg, auth(&f.b))
            .await
            .unwrap();
        assert!(result.accepted);
        let after = wait_resurfaced(&f, &f.a).await;
        after.verify().unwrap();
        assert_eq!(after.pubkey, f.state.relay_keypair.public_key());
        assert!(after.created_at > before_a.created_at);
        assert!(
            hidden_in(&after, other),
            "full hidden set preserves other DMs"
        );
        assert_eq!(snapshot(&f, &f.b).await.unwrap().event.id, before_b.id);
        assert_eq!(
            f.state
                .db
                .list_hidden_dms(f.tenant.community(), &f.b.public_key().to_bytes())
                .await
                .unwrap(),
            vec![f.dm]
        );
    }
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn duplicate_chat_and_no_hidden_recipients_do_not_publish(pool: PgPool) {
    let f = fixture(pool).await;
    let msg = event(&f.b, f.dm, 9, "unique", vec![]);
    ingest_event(&f.state, &f.tenant, msg.clone(), auth(&f.b))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        snapshot(&f, &f.a).await.is_none(),
        "no changed viewers, no snapshot"
    );
    let before = hide(&f, &f.a).await;
    let result = ingest_event(&f.state, &f.tenant, msg, auth(&f.b))
        .await
        .unwrap();
    assert!(result.accepted && result.message.starts_with("duplicate:"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, before.id);
    assert!(f
        .state
        .db
        .list_hidden_dms(f.tenant.community(), &f.a.public_key().to_bytes())
        .await
        .unwrap()
        .contains(&f.dm));
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn non_message_kinds_do_not_resurface(pool: PgPool) {
    let f = fixture(pool).await;
    let before = hide(&f, &f.a).await;
    let channel = f
        .state
        .db
        .get_channel(f.tenant.community(), f.dm)
        .await
        .unwrap();
    // Exercise the production gating helper for every excluded event family.
    for kind in [
        7, 5, 9005, 40003, 40004, 40005, 40006, 40007, 40008, 40099, 20001, 44100, 39002, 48100,
    ] {
        spawn_dm_resurface(
            &f.state,
            &f.tenant,
            Some(&channel),
            &event(&f.b, f.dm, kind, "not a chat", vec![]),
        );
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, before.id);
    assert!(f
        .state
        .db
        .list_hidden_dms(f.tenant.community(), &f.a.public_key().to_bytes())
        .await
        .unwrap()
        .contains(&f.dm));
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn stream_chat_does_not_resurface_or_publish(pool: PgPool) {
    let f = fixture(pool).await;
    let stream = f
        .state
        .db
        .create_channel(
            f.tenant.community(),
            "stream",
            ChannelType::Stream,
            ChannelVisibility::Open,
            None,
            &f.b.public_key().to_bytes(),
            None,
        )
        .await
        .unwrap();
    f.state
        .db
        .add_member(
            f.tenant.community(),
            stream.id,
            &f.a.public_key().to_bytes(),
            buzz_core::channel::MemberRole::Member,
            Some(&f.b.public_key().to_bytes()),
        )
        .await
        .unwrap();
    f.state
        .db
        .hide_dm(
            f.tenant.community(),
            stream.id,
            &f.a.public_key().to_bytes(),
        )
        .await
        .unwrap();
    let msg = event(&f.b, stream.id, 9, "stream chat", vec![]);
    ingest_event(&f.state, &f.tenant, msg, auth(&f.b))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let hidden: bool = sqlx::query_scalar("SELECT hidden_at IS NOT NULL FROM channel_members WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
        .bind(f.tenant.community().as_uuid()).bind(stream.id).bind(f.a.public_key().to_bytes().as_slice()).fetch_one(&f.pool).await.unwrap();
    assert!(hidden);
    assert!(snapshot(&f, &f.a).await.is_none());
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn blocked_resurface_does_not_delay_message_acceptance(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    hide(&f, &f.a).await;
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE channel_members IN SHARE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let msg = event(&f.b, f.dm, 9, "accept while update is blocked", vec![]);
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        ingest_event(&f.state, &f.tenant, msg.clone(), auth(&f.b)),
    )
    .await
    .expect("resurface must not delay acceptance")
    .unwrap();
    assert!(result.accepted);
    assert!(f
        .state
        .db
        .get_event_by_id(f.tenant.community(), msg.id.as_bytes())
        .await
        .unwrap()
        .is_some());
    lock.rollback().await.unwrap();
    wait_resurfaced(&f, &f.a).await;
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn resurface_update_failure_does_not_reject_message(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let before = hide(&f, &f.a).await;
    sqlx::raw_sql("CREATE FUNCTION fail_unhide() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected resurface failure'; END $$; CREATE TRIGGER fail_unhide BEFORE UPDATE ON channel_members FOR EACH ROW WHEN (NEW.hidden_at IS NULL AND OLD.hidden_at IS NOT NULL) EXECUTE FUNCTION fail_unhide();")
        .execute(&pool).await.unwrap();
    let msg = event(&f.b, f.dm, 9, "accepted despite failed unhide", vec![]);
    let result = ingest_event(&f.state, &f.tenant, msg.clone(), auth(&f.b))
        .await
        .unwrap();
    assert!(result.accepted);
    assert!(f
        .state
        .db
        .get_event_by_id(f.tenant.community(), msg.id.as_bytes())
        .await
        .unwrap()
        .is_some());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, before.id);
    assert!(f
        .state
        .db
        .list_hidden_dms(f.tenant.community(), &f.a.public_key().to_bytes())
        .await
        .unwrap()
        .contains(&f.dm));
}

async fn missed_message(f: &Fixture, channel: Uuid, sender: &Keys, kind: u16) {
    let msg = EventBuilder::new(Kind::Custom(kind), "missed while old relay was running")
        .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
        .custom_created_at(Timestamp::from(Timestamp::now().as_secs() - 60))
        .sign_with_keys(sender)
        .unwrap();
    f.state
        .db
        .insert_event(f.tenant.community(), &msg, Some(channel))
        .await
        .unwrap();
}

async fn old_hide(f: &Fixture, viewer: &Keys, channel: Uuid) {
    sqlx::query("UPDATE channel_members SET hidden_at = NOW() - INTERVAL '2 minutes' WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
        .bind(f.tenant.community().as_uuid()).bind(channel).bind(viewer.public_key().to_bytes().as_slice()).execute(&f.pool).await.unwrap();
    publish_dm_visibility_snapshot(&f.tenant, &f.state, &viewer.public_key().to_bytes())
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn backfill_resurfaces_and_is_idempotent(pool: PgPool) {
    let f = fixture(pool).await;
    old_hide(&f, &f.a, f.dm).await;
    missed_message(&f, f.dm, &f.b, 9).await;
    let before = snapshot(&f, &f.a).await.unwrap().event;
    reconcile_dm_visibility(&f.state).await;
    let after = snapshot(&f, &f.a).await.unwrap().event;
    assert!(!hidden_in(&after, f.dm));
    assert!(after.created_at > before.created_at);
    assert!(f
        .state
        .db
        .list_hidden_dms(f.tenant.community(), &f.a.public_key().to_bytes())
        .await
        .unwrap()
        .is_empty());
    reconcile_dm_visibility(&f.state).await;
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, after.id);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn backfill_retries_failed_snapshot_publication(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    old_hide(&f, &f.a, f.dm).await;
    missed_message(&f, f.dm, &f.b, 9).await;
    let before = snapshot(&f, &f.a).await.unwrap().event.id;
    sqlx::raw_sql("CREATE FUNCTION fail_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected snapshot failure'; END $$; CREATE TRIGGER fail_snapshot BEFORE INSERT ON events FOR EACH ROW WHEN (NEW.kind = 30622) EXECUTE FUNCTION fail_snapshot();").execute(&pool).await.unwrap();
    reconcile_dm_visibility(&f.state).await;
    assert!(f
        .state
        .db
        .list_hidden_dms(f.tenant.community(), &f.a.public_key().to_bytes())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, before);
    assert_eq!(
        f.state
            .db
            .dm_visibility_repair_candidates(
                &f.state.relay_keypair.public_key().to_bytes(),
                None,
                100
            )
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::raw_sql("DROP TRIGGER fail_snapshot ON events; DROP FUNCTION fail_snapshot();")
        .execute(&pool)
        .await
        .unwrap();
    reconcile_dm_visibility(&f.state).await;
    let after = snapshot(&f, &f.a).await.unwrap().event;
    assert!(!hidden_in(&after, f.dm));
    reconcile_dm_visibility(&f.state).await;
    assert_eq!(snapshot(&f, &f.a).await.unwrap().event.id, after.id);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires Postgres"]
async fn backfill_pages_across_tenants_and_tolerates_query_failure(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let host = format!("dm-neighbor-{}.example", Uuid::new_v4());
    let other = match f
        .state
        .db
        .create_community_with_owner(&host, &f.a.public_key().to_hex())
        .await
        .unwrap()
    {
        buzz_db::CreateCommunityWithOwnerResult::Created(record) => record.id,
        other => panic!("unexpected result: {other:?}"),
    };
    let mut expected = Vec::new();
    for i in 0..101 {
        let viewer = Keys::generate();
        let community = if i % 2 == 0 {
            f.tenant.community()
        } else {
            other
        };
        let tenant = TenantContext::resolved(
            community,
            if i % 2 == 0 {
                f.tenant.host().to_string()
            } else {
                host.clone()
            },
        );
        let dm = f
            .state
            .db
            .open_dm(
                community,
                &[&f.b.public_key().to_bytes()],
                &viewer.public_key().to_bytes(),
            )
            .await
            .unwrap()
            .0
            .id;
        sqlx::query("UPDATE channel_members SET hidden_at = NOW() - INTERVAL '2 minutes' WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
            .bind(community.as_uuid()).bind(dm).bind(viewer.public_key().to_bytes().as_slice()).execute(&pool).await.unwrap();
        let msg = EventBuilder::new(Kind::Custom(40002), "newer than hide")
            .tags([Tag::parse(["h", &dm.to_string()]).unwrap()])
            .sign_with_keys(&f.b)
            .unwrap();
        f.state
            .db
            .insert_event(community, &msg, Some(dm))
            .await
            .unwrap();
        expected.push((tenant, viewer, dm));
    }
    let relay = f.state.relay_keypair.public_key().to_bytes();
    assert_eq!(
        f.state
            .db
            .dm_visibility_repair_candidates(&relay, None, 1000)
            .await
            .unwrap()
            .len(),
        100
    );
    reconcile_dm_visibility(&f.state).await;
    assert!(f
        .state
        .db
        .dm_visibility_repair_candidates(&relay, None, 100)
        .await
        .unwrap()
        .is_empty());
    for (tenant, viewer, dm) in expected {
        assert!(f
            .state
            .db
            .list_hidden_dms(tenant.community(), &viewer.public_key().to_bytes())
            .await
            .unwrap()
            .is_empty());
        let events = f
            .state
            .db
            .query_events(&buzz_db::EventQuery {
                kinds: Some(vec![30622]),
                d_tag: Some(viewer.public_key().to_hex()),
                ..buzz_db::EventQuery::for_community(tenant.community())
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        events[0].event.verify().unwrap();
        assert!(!hidden_in(&events[0].event, dm));
    }
    pool.close().await;
    tokio::time::timeout(Duration::from_secs(1), reconcile_dm_visibility(&f.state))
        .await
        .expect("query errors are fail-open");
}
