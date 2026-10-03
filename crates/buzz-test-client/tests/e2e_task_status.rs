//! End-to-end tests for kind:30624 agent task status (phase 8).
//!
//! Verifies that the status head is `h`-scoped through the existing channel
//! gating (a member of a private channel reads it; a non-member gets it from
//! neither a kind query, an `ids` query, nor live fan-out), that the relay's
//! addressable stale-write protection keeps a terminal head against an older
//! `running` write (the D8.6 positive control), and that malformed heads are
//! refused with the kind-specific prefix.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3000 cargo test -p buzz-test-client --test e2e_task_status -- --ignored
//! ```

use std::time::Duration;

use buzz_core::task_status::{parse_task_status, TaskState};
use buzz_sdk::task_status::{build_task_job, build_task_lifecycle, TaskJob, TaskLifecycle};
use buzz_test_client::{BuzzTestClient, RelayMessage};
use nostr::{Alphabet, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};
use uuid::Uuid;

const KIND_TASK_STATUS: u16 = 30624;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn sub_id(name: &str) -> String {
    format!("e2e-task-status-{name}-{}", Uuid::new_v4())
}

async fn create_private_channel(client: &mut BuzzTestClient, keys: &Keys) -> Uuid {
    let channel = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["name", &format!("task-status-e2e-{channel}")]).unwrap(),
            Tag::parse(["channel_type", "stream"]).unwrap(),
            Tag::parse(["visibility", "private"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();
    let ok = client.send_event(event).await.expect("create channel");
    assert!(
        ok.accepted,
        "private channel creation failed: {}",
        ok.message
    );
    channel
}

async fn add_member(client: &mut BuzzTestClient, channel: Uuid, member: &Keys, signer: &Keys) {
    let event = EventBuilder::new(Kind::Custom(9000), "")
        .allow_self_tagging()
        .tags([
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["p", &member.public_key().to_hex()]).unwrap(),
        ])
        .sign_with_keys(signer)
        .unwrap();
    let ok = client.send_event(event).await.expect("add member");
    assert!(ok.accepted, "add member failed: {}", ok.message);
}

fn lifecycle(
    keys: &Keys,
    channel: Uuid,
    turn: &str,
    state: TaskState,
    created_at: u64,
) -> nostr::Event {
    build_task_lifecycle(&TaskLifecycle {
        channel,
        turn_id: turn,
        state,
        started: created_at.saturating_sub(10),
        ended: state.is_terminal().then_some(created_at),
        trigger: None,
        session: Some("0"),
        reason: None,
        created_at,
    })
    .unwrap()
    .sign_with_keys(keys)
    .unwrap()
}

fn now() -> u64 {
    Timestamp::now().as_secs()
}

async fn query(client: &mut BuzzTestClient, name: &str, filter: Filter) -> Vec<nostr::Event> {
    let sid = sub_id(name);
    client.subscribe(&sid, vec![filter]).await.expect("REQ");
    let events = client
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("EOSE");
    client.close_subscription(&sid).await.ok();
    events
}

/// A private-channel REQ may be denied with CLOSED rather than empty EOSE.
/// Timeouts and unrelated failures are not proof of read isolation.
async fn query_or_denied(client: &mut BuzzTestClient, filter: Filter) -> Vec<nostr::Event> {
    let sid = sub_id("jobs-outsider");
    client.subscribe(&sid, vec![filter]).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut events = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match client
            .recv_event(remaining)
            .await
            .expect("EOSE or explicit channel denial")
        {
            RelayMessage::Event {
                subscription_id,
                event,
            } if subscription_id == sid => events.push(*event),
            RelayMessage::Eose { subscription_id } if subscription_id == sid => break,
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == sid => {
                assert_eq!(message, "restricted: not a channel member");
                assert!(
                    events.is_empty(),
                    "a denied reader must receive no job heads"
                );
                break;
            }
            _ => {}
        }
    }
    client.close_subscription(&sid).await.unwrap();
    events
}

/// Wait for a live event on `sid` matching `id`, up to `wait`.
async fn saw_live(
    client: &mut BuzzTestClient,
    sid: &str,
    id: &nostr::EventId,
    wait: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match client.recv_event(remaining).await {
            Ok(RelayMessage::Event {
                subscription_id,
                event,
            }) if subscription_id == sid && &event.id == id => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

#[tokio::test]
#[ignore]
async fn member_reads_agent_status_non_member_cannot() {
    let url = relay_url();
    let agent = Keys::generate();
    let member = Keys::generate();
    let outsider = Keys::generate();
    let mut agent_ws = BuzzTestClient::connect(&url, &agent).await.expect("agent");
    let mut member_ws = BuzzTestClient::connect(&url, &member)
        .await
        .expect("member");
    let mut outsider_ws = BuzzTestClient::connect(&url, &outsider)
        .await
        .expect("outsider");

    let channel = create_private_channel(&mut agent_ws, &agent).await;
    add_member(&mut agent_ws, channel, &member, &agent).await;

    let t = now();
    let running = lifecycle(&agent, channel, "turn-e2e-1", TaskState::Running, t);
    let ok = agent_ws.send_event(running.clone()).await.expect("send");
    assert!(ok.accepted, "running head rejected: {}", ok.message);

    let by_author = || {
        Filter::new()
            .kind(Kind::Custom(KIND_TASK_STATUS))
            .author(agent.public_key())
    };

    // Kind query.
    let seen = query(&mut member_ws, "member-kind", by_author()).await;
    assert!(
        seen.iter().any(|e| e.id == running.id),
        "member must read the head via a kind query"
    );
    let seen = query(&mut outsider_ws, "outsider-kind", by_author()).await;
    assert!(
        seen.iter().all(|e| e.id != running.id),
        "non-member must not read the head via a kind query"
    );
    // Channel-scoped query.
    let by_h = Filter::new()
        .kind(Kind::Custom(KIND_TASK_STATUS))
        .custom_tag(SingleLetterTag::lowercase(Alphabet::H), channel.to_string());
    let seen = query(&mut member_ws, "member-h", by_h.clone()).await;
    assert!(seen.iter().any(|e| e.id == running.id));
    // `ids` query.
    let seen = query(
        &mut outsider_ws,
        "outsider-ids",
        Filter::new().id(running.id),
    )
    .await;
    assert!(seen.is_empty(), "non-member must not read the head by id");
    let seen = query(&mut member_ws, "member-ids", Filter::new().id(running.id)).await;
    assert_eq!(seen.len(), 1, "member reads the head by id");

    // Live fan-out. Channel-scoped events only fan out to `#h`-scoped
    // subscriptions (global subscriptions never receive them), so a live
    // Work-tab view subscribes per channel. The outsider's `#h` REQ into a
    // private channel may be CLOSED outright; either way it must see nothing.
    let member_sid = sub_id("member-live");
    let outsider_sid = sub_id("outsider-live");
    let live = || {
        Filter::new()
            .kind(Kind::Custom(KIND_TASK_STATUS))
            .custom_tag(SingleLetterTag::lowercase(Alphabet::H), channel.to_string())
            .since(Timestamp::from(t))
    };
    member_ws
        .subscribe(&member_sid, vec![live()])
        .await
        .unwrap();
    member_ws
        .collect_until_eose(&member_sid, Duration::from_secs(5))
        .await
        .unwrap();
    outsider_ws
        .subscribe(&outsider_sid, vec![live()])
        .await
        .unwrap();
    let _ = outsider_ws
        .collect_until_eose(&outsider_sid, Duration::from_secs(2))
        .await;

    let done = lifecycle(&agent, channel, "turn-e2e-1", TaskState::Done, t + 1);
    let ok = agent_ws.send_event(done.clone()).await.expect("send done");
    assert!(ok.accepted, "done head rejected: {}", ok.message);
    assert!(
        saw_live(
            &mut member_ws,
            &member_sid,
            &done.id,
            Duration::from_secs(3)
        )
        .await,
        "member receives the terminal head live"
    );
    assert!(
        !saw_live(
            &mut outsider_ws,
            &outsider_sid,
            &done.id,
            Duration::from_secs(2)
        )
        .await,
        "non-member must not receive the head live"
    );

    let heads = query(&mut member_ws, "member-final", by_h).await;
    let head = heads
        .iter()
        .find(|e| e.pubkey == agent.public_key())
        .map(|e| parse_task_status(e).unwrap())
        .expect("head present");
    assert_eq!(
        head.state,
        Some(TaskState::Done),
        "addressable head was replaced"
    );
}

#[tokio::test]
#[ignore]
async fn older_created_at_does_not_replace_terminal() {
    let url = relay_url();
    let agent = Keys::generate();
    let mut ws = BuzzTestClient::connect(&url, &agent).await.expect("agent");
    let channel = create_private_channel(&mut ws, &agent).await;

    let t = now();
    let done = lifecycle(&agent, channel, "turn-order", TaskState::Done, t + 2);
    let ok = ws.send_event(done.clone()).await.expect("send done");
    assert!(ok.accepted, "done rejected: {}", ok.message);
    // A late-arriving refresh stamped earlier than the terminal head.
    let late = lifecycle(&agent, channel, "turn-order", TaskState::Running, t + 1);
    let _ = ws.send_event(late).await.expect("send late running");

    let heads = query(
        &mut ws,
        "order",
        Filter::new()
            .kind(Kind::Custom(KIND_TASK_STATUS))
            .author(agent.public_key())
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::D),
                format!("turn:{channel}"),
            ),
    )
    .await;
    assert_eq!(heads.len(), 1, "one addressable head: {heads:?}");
    assert_eq!(heads[0].id, done.id, "the terminal head survives");
}

#[tokio::test]
#[ignore]
async fn malformed_task_status_rejected_with_prefix() {
    let url = relay_url();
    let agent = Keys::generate();
    let mut ws = BuzzTestClient::connect(&url, &agent).await.expect("agent");
    let channel = create_private_channel(&mut ws, &agent).await;
    let other = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(KIND_TASK_STATUS), "")
        .tags([
            Tag::parse(["d", &format!("turn:{other}")]).unwrap(),
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["turn", "t"]).unwrap(),
            Tag::parse(["state", "running"]).unwrap(),
            Tag::parse(["started", "1"]).unwrap(),
        ])
        .sign_with_keys(&agent)
        .unwrap();
    let ok = ws.send_event(event).await.expect("send");
    assert!(!ok.accepted);
    assert!(
        ok.message.starts_with("invalid: task-status: "),
        "unexpected message: {}",
        ok.message
    );
}

fn job(
    keys: &Keys,
    channel: Uuid,
    job_id: &str,
    state: TaskState,
    at: u64,
    started: u64,
) -> nostr::Event {
    build_task_job(&TaskJob {
        channel,
        job_id,
        role: "coder",
        state,
        started,
        ended: state.is_terminal().then_some(at),
        model: Some("gpt-6.1-sol"),
        title: Some("Probe"),
        turn_id: None,
        trigger: None,
        reason: None,
        created_at: at,
    })
    .unwrap()
    .sign_with_keys(keys)
    .unwrap()
}

#[tokio::test]
#[ignore]
async fn concurrent_jobs_coexist_and_are_member_scoped() {
    let url = relay_url();
    let agent = Keys::generate();
    let member = Keys::generate();
    let outsider = Keys::generate();
    let mut agent_ws = BuzzTestClient::connect(&url, &agent).await.unwrap();
    let mut member_ws = BuzzTestClient::connect(&url, &member).await.unwrap();
    let mut outsider_ws = BuzzTestClient::connect(&url, &outsider).await.unwrap();
    let channel = create_private_channel(&mut agent_ws, &agent).await;
    add_member(&mut agent_ws, channel, &member, &agent).await;
    let t = now();
    for job_id in ["j1", "j2", "j3"] {
        let ok = agent_ws
            .send_event(job(&agent, channel, job_id, TaskState::Running, t, t))
            .await
            .unwrap();
        assert!(ok.accepted, "{}", ok.message);
    }
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_TASK_STATUS))
        .custom_tag(SingleLetterTag::lowercase(Alphabet::H), channel.to_string());
    let seen = query(&mut member_ws, "jobs-member", filter.clone()).await;
    assert_eq!(seen.len(), 3);
    let ids: std::collections::HashSet<_> = seen
        .iter()
        .map(|e| parse_task_status(e).unwrap().job_id.unwrap())
        .collect();
    assert_eq!(
        ids,
        ["j1", "j2", "j3"].map(str::to_string).into_iter().collect()
    );
    let seen = query_or_denied(&mut outsider_ws, filter.clone()).await;
    assert!(seen.is_empty());
    let sid = sub_id("jobs-live");
    member_ws.subscribe(&sid, vec![filter]).await.unwrap();
    let history = member_ws
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(history.len(), 3);
    let fourth = job(&agent, channel, "j4", TaskState::Running, t + 1, t);
    assert!(agent_ws.send_event(fourth.clone()).await.unwrap().accepted);
    assert!(saw_live(&mut member_ws, &sid, &fourth.id, Duration::from_secs(3)).await);
    member_ws.close_subscription(&sid).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn job_end_replaces_running_and_stale_beat_cannot_revert() {
    let agent = Keys::generate();
    let mut ws = BuzzTestClient::connect(&relay_url(), &agent).await.unwrap();
    let channel = create_private_channel(&mut ws, &agent).await;
    let t = now();
    assert!(
        ws.send_event(job(&agent, channel, "j1", TaskState::Running, t, t))
            .await
            .unwrap()
            .accepted
    );
    let done = job(&agent, channel, "j1", TaskState::Done, t + 2, t);
    assert!(ws.send_event(done.clone()).await.unwrap().accepted);
    ws.send_event(job(&agent, channel, "j1", TaskState::Running, t + 1, t))
        .await
        .unwrap();
    let seen = query(
        &mut ws,
        "job-order",
        Filter::new()
            .kind(Kind::Custom(KIND_TASK_STATUS))
            .author(agent.public_key())
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::D),
                format!("job:{channel}:j1"),
            ),
    )
    .await;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].id, done.id);
    assert_eq!(
        parse_task_status(&seen[0]).unwrap().state,
        Some(TaskState::Done)
    );
}
