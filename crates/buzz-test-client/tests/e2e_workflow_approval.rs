//! End-to-end coverage for workflow approvals and execution events (WF-08).
//!
//! An approval is an authorization decision that crosses the wire in both
//! directions — the relay announces a pending one as kind:46010, and a client
//! answers with a signed kind:46030/46031. Everything below runs against a real
//! relay for that reason: the unit and DB tests can show a record is minted and
//! decided once, but only the live path shows that the announcement reaches a
//! subscriber, that a granted run actually continues, and that a denied one
//! actually stops.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3000 \
//!   cargo test -p buzz-test-client --test e2e_workflow_approval -- --ignored
//! ```

use std::time::Duration;

use buzz_test_client::BuzzTestClient;
use nostr::{Alphabet, Event, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag};
use serde_json::Value;
use uuid::Uuid;

const KIND_CHANNEL_CREATE: u16 = 9007;
const KIND_WORKFLOW_DEF: u16 = 30620;
const KIND_WORKFLOW_TRIGGER: u16 = 46020;
const KIND_APPROVAL_GRANT: u16 = 46030;
const KIND_APPROVAL_DENY: u16 = 46031;
const KIND_STEP_COMPLETED: u16 = 46003;
const KIND_RUN_COMPLETED: u16 = 46005;
const KIND_RUN_CANCELLED: u16 = 46007;
const KIND_APPROVAL_REQUESTED: u16 = 46010;
const KIND_APPROVAL_GRANTED: u16 = 46011;
const KIND_APPROVAL_DENIED: u16 = 46012;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

fn sub_id(name: &str) -> String {
    format!("e2e-wf08-{name}-{}", Uuid::new_v4())
}

/// Submit a signed event over the HTTP bridge and return the parsed response.
async fn submit(keys: &Keys, event: &Event) -> Value {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/events", relay_http_url()))
        .header("X-Pubkey", keys.public_key().to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(event).expect("serialize event"))
        .send()
        .await
        .expect("submit event");
    resp.json().await.expect("parse event response")
}

async fn submit_accepted(keys: &Keys, event: &Event, what: &str) -> Value {
    let body = submit(keys, event).await;
    assert!(
        body["accepted"].as_bool().unwrap_or(false),
        "{what} not accepted: {body}"
    );
    body
}

async fn create_channel(keys: &Keys) -> String {
    let channel_uuid = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(KIND_CHANNEL_CREATE), "")
        .tags(vec![
            Tag::parse(["h", &channel_uuid.to_string()]).unwrap(),
            Tag::parse(["name", &format!("wf08-{channel_uuid}")]).unwrap(),
            Tag::parse(["channel_type", "stream"]).unwrap(),
            Tag::parse(["visibility", "open"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .expect("sign channel create");
    submit_accepted(keys, &event, "channel create").await;
    channel_uuid.to_string()
}

/// A workflow with one approval gate followed by a message step, so "did the
/// run continue?" is answerable by looking for the step *after* the gate rather
/// than by trusting a status field.
async fn create_gated_workflow(keys: &Keys, channel: &str, approver_spec: &str) -> String {
    let workflow_id = Uuid::new_v4().to_string();
    let yaml = format!(
        "name: gate-e2e\n\
         trigger:\n\
         \x20 on: webhook\n\
         steps:\n\
         \x20 - id: gate\n\
         \x20   action: request_approval\n\
         \x20   from: \"{approver_spec}\"\n\
         \x20   message: \"Approve the deploy?\"\n\
         \x20   timeout: 1h\n\
         \x20 - id: after_gate\n\
         \x20   action: send_message\n\
         \x20   text: \"deploy started\"\n"
    );
    let event = EventBuilder::new(Kind::Custom(KIND_WORKFLOW_DEF), yaml)
        .tags(vec![
            Tag::parse(["d", &workflow_id]).unwrap(),
            Tag::parse(["h", channel]).unwrap(),
            Tag::parse(["name", "gate-e2e"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .expect("sign workflow def");
    submit_accepted(keys, &event, "workflow definition").await;
    workflow_id
}

async fn trigger(keys: &Keys, workflow_id: &str) -> Value {
    let event = EventBuilder::new(Kind::Custom(KIND_WORKFLOW_TRIGGER), "{}")
        .tags(vec![Tag::parse(["d", workflow_id]).unwrap()])
        .sign_with_keys(keys)
        .expect("sign trigger");
    submit_accepted(keys, &event, "workflow trigger").await
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        (tag.kind().to_string() == name).then(|| tag.content().map(str::to_string))?
    })
}

/// Poll the relay for events of `kind` scoped to `channel`, until `predicate`
/// matches one or the deadline passes.
///
/// Polls a fresh REQ each time rather than holding one live subscription: the
/// events under test are published from a spawned task after the trigger's HTTP
/// response has already returned, so the interesting one can land before a
/// subscription opened afterwards would see it.
async fn await_event<F>(
    keys: &Keys,
    channel: &str,
    kind: u16,
    timeout: Duration,
    predicate: F,
) -> Option<Event>
where
    F: Fn(&Event) -> bool,
{
    let deadline = std::time::Instant::now() + timeout;
    loop {
        for event in query(keys, channel, kind).await {
            if predicate(&event) {
                return Some(event);
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn query(keys: &Keys, channel: &str, kind: u16) -> Vec<Event> {
    let mut ws = BuzzTestClient::connect(&relay_url(), keys)
        .await
        .expect("connect");
    let sid = sub_id("query");
    let filter = Filter::new()
        .kind(Kind::Custom(kind))
        .custom_tags(SingleLetterTag::lowercase(Alphabet::H), [channel])
        .limit(50);
    ws.subscribe(&sid, vec![filter]).await.expect("subscribe");
    let events = ws
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("collect until EOSE");
    let _ = ws.close_subscription(&sid).await;
    let _ = ws.disconnect().await;
    events
}

fn decision_event(kind: u16, approval_ref: &str, note: &str, keys: &Keys) -> Event {
    EventBuilder::new(Kind::Custom(kind), note)
        .tags(vec![Tag::parse(["d", approval_ref]).unwrap()])
        .sign_with_keys(keys)
        .expect("sign decision")
}

/// Drive a gated workflow to its suspended state and return
/// `(channel, workflow_id, run_id, approval_ref, the 46010 event)`.
async fn suspend_at_gate(
    keys: &Keys,
    approver_spec: &str,
) -> (String, String, String, String, Event) {
    let channel = create_channel(keys).await;
    let workflow_id = create_gated_workflow(keys, &channel, approver_spec).await;
    let response = trigger(keys, &workflow_id).await;
    let run_id = response["message"]
        .as_str()
        .and_then(|message| message.strip_prefix("response:"))
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| value["run_id"].as_str().map(str::to_string))
        .expect("trigger response carries a run id");

    let request = await_event(
        keys,
        &channel,
        KIND_APPROVAL_REQUESTED,
        Duration::from_secs(15),
        |event| tag_value(event, "run").as_deref() == Some(run_id.as_str()),
    )
    .await
    .expect("the gate must announce a kind:46010 for this run");

    let approval_ref = tag_value(&request, "approval").expect("46010 carries an approval tag");
    (channel, workflow_id, run_id, approval_ref, request)
}

/// The gate announces itself over the wire, carrying everything a client needs
/// to answer: the reference, the step, the run, and a human-readable message.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn approval_request_reaches_subscribers() {
    let keys = Keys::generate();
    let (_, workflow_id, run_id, approval_ref, request) = suspend_at_gate(&keys, "any").await;

    assert_eq!(request.kind, Kind::Custom(KIND_APPROVAL_REQUESTED));
    assert_eq!(
        tag_value(&request, "d").as_deref(),
        Some(workflow_id.as_str())
    );
    assert_eq!(tag_value(&request, "run").as_deref(), Some(run_id.as_str()));
    assert_eq!(tag_value(&request, "step").as_deref(), Some("gate"));
    assert_eq!(
        request.content, "Approve the deploy?",
        "clients render a 46010's content directly"
    );
    assert_eq!(
        approval_ref.len(),
        64,
        "the approval reference is a SHA-256 hex digest, not a token"
    );
    assert!(approval_ref.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        tag_value(&request, "p").as_deref(),
        Some(keys.public_key().to_hex().as_str()),
        "an `any` approval is addressed to the workflow owner"
    );
    assert_ne!(
        request.pubkey.to_hex(),
        keys.public_key().to_hex(),
        "the announcement is relay-signed, not signed by the workflow owner"
    );
}

/// The whole point: a granted approval resumes the run, and the step *after*
/// the gate actually executes.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_granted_approval_resumes_the_run() {
    let keys = Keys::generate();
    let (channel, _, run_id, approval_ref, _) = suspend_at_gate(&keys, "any").await;

    let grant = decision_event(KIND_APPROVAL_GRANT, &approval_ref, "ship it", &keys);
    let body = submit_accepted(&keys, &grant, "approval grant").await;
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("granted"),
        "grant response: {body}"
    );

    let after_gate = await_event(
        &keys,
        &channel,
        KIND_STEP_COMPLETED,
        Duration::from_secs(15),
        |event| {
            tag_value(event, "run").as_deref() == Some(run_id.as_str())
                && tag_value(event, "step").as_deref() == Some("after_gate")
        },
    )
    .await;
    assert!(
        after_gate.is_some(),
        "the step after the gate must run once the approval is granted"
    );

    let completed = await_event(
        &keys,
        &channel,
        KIND_RUN_COMPLETED,
        Duration::from_secs(15),
        |event| tag_value(event, "run").as_deref() == Some(run_id.as_str()),
    )
    .await;
    assert!(
        completed.is_some(),
        "the resumed run must report completion"
    );

    let granted = await_event(
        &keys,
        &channel,
        KIND_APPROVAL_GRANTED,
        Duration::from_secs(10),
        |event| tag_value(event, "approval").as_deref() == Some(approval_ref.as_str()),
    )
    .await
    .expect("the grant must be announced as kind:46011");
    assert_eq!(granted.content, "ship it", "the approver's note is carried");
}

/// A denied approval stops the run, and the step after the gate never runs.
/// Asserting the cancellation alone would not catch a resume that also happened.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_denied_approval_stops_the_run() {
    let keys = Keys::generate();
    let (channel, _, run_id, approval_ref, _) = suspend_at_gate(&keys, "any").await;

    let deny = decision_event(KIND_APPROVAL_DENY, &approval_ref, "not yet", &keys);
    let body = submit_accepted(&keys, &deny, "approval deny").await;
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("denied"),
        "deny response: {body}"
    );

    let cancelled = await_event(
        &keys,
        &channel,
        KIND_RUN_CANCELLED,
        Duration::from_secs(15),
        |event| tag_value(event, "run").as_deref() == Some(run_id.as_str()),
    )
    .await;
    assert!(cancelled.is_some(), "a denied run must be cancelled");

    let denied = await_event(
        &keys,
        &channel,
        KIND_APPROVAL_DENIED,
        Duration::from_secs(10),
        |event| tag_value(event, "approval").as_deref() == Some(approval_ref.as_str()),
    )
    .await
    .expect("the denial must be announced as kind:46012");
    assert_eq!(denied.content, "not yet");

    // The decisive assertion: nothing after the gate ran. The cancellation
    // event above would still be published if the run had *also* resumed.
    let leaked = await_event(
        &keys,
        &channel,
        KIND_STEP_COMPLETED,
        Duration::from_secs(3),
        |event| {
            tag_value(event, "run").as_deref() == Some(run_id.as_str())
                && tag_value(event, "step").as_deref() == Some("after_gate")
        },
    )
    .await;
    assert!(
        leaked.is_none(),
        "a denied run must not execute the step after the gate"
    );
}

/// Replay: re-submitting a decision that already landed is rejected, and does
/// not start a second resume of the same run.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_replayed_grant_is_rejected() {
    let keys = Keys::generate();
    let (channel, _, run_id, approval_ref, _) = suspend_at_gate(&keys, "any").await;

    let grant = decision_event(KIND_APPROVAL_GRANT, &approval_ref, "first", &keys);
    submit_accepted(&keys, &grant, "first grant").await;
    await_event(
        &keys,
        &channel,
        KIND_RUN_COMPLETED,
        Duration::from_secs(15),
        |event| tag_value(event, "run").as_deref() == Some(run_id.as_str()),
    )
    .await
    .expect("first grant completes the run");

    // A distinct second grant — a different note, so it is a new event id and
    // cannot be absorbed by plain event-level deduplication. It must still be
    // refused, because the approval it names is no longer pending.
    let replay = decision_event(KIND_APPROVAL_GRANT, &approval_ref, "second", &keys);
    let body = submit(&keys, &replay).await;
    assert!(
        !body["accepted"].as_bool().unwrap_or(false),
        "a second grant for a decided approval must be rejected: {body}"
    );

    let granted = query(&keys, &channel, KIND_APPROVAL_GRANTED).await;
    let for_this_approval = granted
        .iter()
        .filter(|event| tag_value(event, "approval").as_deref() == Some(approval_ref.as_str()))
        .count();
    assert_eq!(
        for_this_approval, 1,
        "exactly one kind:46011 may exist for one approval"
    );
}

/// A denial is final: a later grant cannot talk the run back into resuming.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_denied_approval_cannot_be_granted_afterwards() {
    let keys = Keys::generate();
    let (channel, _, run_id, approval_ref, _) = suspend_at_gate(&keys, "any").await;

    submit_accepted(
        &keys,
        &decision_event(KIND_APPROVAL_DENY, &approval_ref, "no", &keys),
        "deny",
    )
    .await;
    await_event(
        &keys,
        &channel,
        KIND_RUN_CANCELLED,
        Duration::from_secs(15),
        |event| tag_value(event, "run").as_deref() == Some(run_id.as_str()),
    )
    .await
    .expect("denied run is cancelled");

    let body = submit(
        &keys,
        &decision_event(KIND_APPROVAL_GRANT, &approval_ref, "actually yes", &keys),
    )
    .await;
    assert!(
        !body["accepted"].as_bool().unwrap_or(false),
        "a denied approval must not accept a later grant: {body}"
    );

    let leaked = await_event(
        &keys,
        &channel,
        KIND_STEP_COMPLETED,
        Duration::from_secs(3),
        |event| {
            tag_value(event, "run").as_deref() == Some(run_id.as_str())
                && tag_value(event, "step").as_deref() == Some("after_gate")
        },
    )
    .await;
    assert!(
        leaked.is_none(),
        "the rejected grant must not have resumed the cancelled run"
    );
}

/// Only the designated approver may decide when the gate names one.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_bystander_cannot_grant_someone_elses_approval() {
    let owner = Keys::generate();
    let approver_hex = owner.public_key().to_hex();
    let (channel, _, run_id, approval_ref, request) = suspend_at_gate(&owner, &approver_hex).await;
    assert_eq!(
        tag_value(&request, "p").as_deref(),
        Some(approver_hex.as_str()),
        "the designated approver is p-tagged so their client can surface it"
    );

    let bystander = Keys::generate();
    let body = submit(
        &bystander,
        &decision_event(KIND_APPROVAL_GRANT, &approval_ref, "me too", &bystander),
    )
    .await;
    assert!(
        !body["accepted"].as_bool().unwrap_or(false),
        "a non-approver must not be able to grant: {body}"
    );

    let leaked = await_event(
        &owner,
        &channel,
        KIND_STEP_COMPLETED,
        Duration::from_secs(3),
        |event| {
            tag_value(event, "run").as_deref() == Some(run_id.as_str())
                && tag_value(event, "step").as_deref() == Some("after_gate")
        },
    )
    .await;
    assert!(
        leaked.is_none(),
        "the rejected grant must not resume the run"
    );
}

/// Execution events are the relay's own record. A client that signs one itself
/// must be refused, or anyone could inject an "approval required" entry into
/// another member's needs-action feed and push stream.
#[tokio::test]
#[ignore = "requires a running relay"]
async fn a_client_cannot_forge_an_execution_event() {
    let keys = Keys::generate();
    let channel = create_channel(&keys).await;
    let victim = Keys::generate();

    for kind in [
        KIND_APPROVAL_REQUESTED,
        KIND_APPROVAL_GRANTED,
        KIND_APPROVAL_DENIED,
        KIND_RUN_COMPLETED,
    ] {
        let forged = EventBuilder::new(Kind::Custom(kind), "you have work to do")
            .tags(vec![
                Tag::parse(["h", channel.as_str()]).unwrap(),
                Tag::parse(["d", &Uuid::new_v4().to_string()]).unwrap(),
                Tag::parse(["p", &victim.public_key().to_hex()]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("sign forged event");
        let body = submit(&keys, &forged).await;
        assert!(
            !body["accepted"].as_bool().unwrap_or(false),
            "kind {kind} is relay-authored and must be refused from a client: {body}"
        );
    }
}
