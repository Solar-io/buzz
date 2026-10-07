//! Intake-level voice fast lane tests: the real `route_inbound_event` and
//! `handle_voice_fast_msg` against a real `EventQueue` (R1: one route per
//! event — a claimed event is never queued by the intake; a hand-back is
//! queued exactly once).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostr::{EventBuilder, Keys, Kind, Tag};

use super::*;
use crate::voice_fast_runner::{KeySource, VoiceFastDeps, VoiceFastRuntime};
use crate::voice_fast_testkit::{self as kit, Script};
use crate::voice_stream::{SinkFuture, SpeechSink};
use crate::voice_turn::VoiceFastSettings;

struct NullSink;
impl SpeechSink for NullSink {
    fn publish_segment(&self, _: nostr::Event) -> SinkFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn post_final(&self, _: nostr::Event) -> SinkFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}

fn test_ctx() -> Arc<PromptContext> {
    let agent_keys = Keys::generate();
    let dead_rest = || relay::RestClient {
        http: reqwest::Client::new(),
        base_url: "http://127.0.0.1:0".to_string(),
        keys: agent_keys.clone(),
        auth_tag_json: None,
    };
    Arc::new(PromptContext {
        mcp_servers: vec![],
        initial_message: None,
        idle_timeout: Duration::from_secs(60),
        background_idle_timeout: Duration::from_secs(60),
        max_turn_duration: Duration::from_secs(120),
        prompt_timezone: chrono_tz::UTC,
        turn_liveness_interval: Duration::ZERO,
        dedup_mode: DedupMode::Queue,
        system_prompt: None,
        session_title: None,
        team_instructions: None,
        shared_instructions: None,
        heartbeat_prompt: None,
        base_prompt: None,
        cwd: ".".to_string(),
        rest_client: dead_rest(),
        channel_info: pool::ChannelInfoResolver::new(HashMap::new(), dead_rest()),
        context_message_limit: 0,
        max_turns_per_session: 0,
        permission_mode: config::PermissionMode::Default,
        agent_keys,
        agent_owner_pubkey: None,
        memory_enabled: false,
        harness_name: "voice-fast-intake-test".to_string(),
        relay_url: "ws://127.0.0.1:3000".to_string(),
        pool_router: crate::auth_pool::PoolRouter::default(),
        task_status_sink: None,
        task_status_refresh: crate::task_status::STATUS_REFRESH,
        speech_sink: None,
        voice_stream_forced: None,
        voice_fast_ledgers: None,
        resume: Default::default(),
    })
}

struct Intake {
    pool: AgentPool,
    queue: EventQueue,
    ctx: Arc<PromptContext>,
    steer_tx: mpsc::UnboundedSender<SteerAckEvent>,
    last_activity: tokio::time::Instant,
    typing: HashMap<Uuid, ThreadTags>,
    owner_hex: String,
}

impl Intake {
    fn new(owner: &Keys) -> Self {
        let (steer_tx, _rx) = mpsc::unbounded_channel();
        Self {
            pool: AgentPool::from_slots(vec![]),
            queue: EventQueue::new(DedupMode::Queue),
            ctx: test_ctx(),
            steer_tx,
            last_activity: tokio::time::Instant::now(),
            typing: HashMap::new(),
            owner_hex: owner.public_key().to_hex(),
        }
    }

    fn accept_ctx(&mut self) -> AcceptCtx<'_> {
        AcceptCtx {
            pool: &mut self.pool,
            queue: &mut self.queue,
            ctx: &self.ctx,
            multiple_event_handling: MultipleEventHandling::Queue,
            owner: Some(self.owner_hex.as_str()),
            steer_ack_tx: &self.steer_tx,
            pubkey_hex: "agent",
            last_activity: &mut self.last_activity,
            typing_channels: &mut self.typing,
            // No pool: nothing dispatches, so queue state is observable.
            pool_ready: false,
        }
    }

    fn queued(&mut self) -> usize {
        let mut n = 0;
        while let Some(batch) = self.queue.flush_next() {
            n += batch.events.len();
            self.queue.mark_complete(batch.channel_id);
        }
        n
    }
}

fn runtime(
    base_url: &str,
    on: Arc<Mutex<bool>>,
) -> (Arc<VoiceFastRuntime>, mpsc::UnboundedReceiver<VoiceFastMsg>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let base = base_url.to_string();
    let rt = VoiceFastRuntime::new(VoiceFastDeps {
        ledgers: Arc::new(voice_fast::VoiceFastLedgers::new()),
        http: voice_fast_client::build_http_client(),
        sink: Arc::new(NullSink),
        keys: Keys::generate(),
        persona: None,
        rest: None,
        owner: None,
        to_main: tx,
        settings: Arc::new(move || VoiceFastSettings {
            on: *on.lock().unwrap(),
            base_url: Some(base.clone()),
            first_token_ms: 400,
            ..VoiceFastSettings::default()
        }),
        key: KeySource::Fixed(Some("k".into())),
        digest_delay_override: Some(Duration::from_secs(3600)),
    });
    (rt, rx)
}

fn voice(owner: &Keys, channel: Uuid, text: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(9), format!("[voice] {text}"))
        .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
        .sign_with_keys(owner)
        .unwrap()
}

#[tokio::test]
async fn claimed_voice_event_is_never_queued_by_intake() {
    let server = kit::spawn(vec![kit::reply(&["Hi there."], Duration::ZERO)]).await;
    let owner = Keys::generate();
    let (rt, mut rx) = runtime(&server.base_url, Arc::new(Mutex::new(true)));
    let mut intake = Intake::new(&owner);
    let channel = Uuid::new_v4();
    let queued = route_inbound_event(
        &rt,
        intake.accept_ctx(),
        channel,
        voice(&owner, channel, "hello"),
        "t".into(),
    );
    assert!(!queued, "the fast lane owns a claimed event");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(intake.queued(), 0);
    assert!(
        rx.try_recv().is_err(),
        "a normal fast turn hands nothing back"
    );
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn unclaimed_events_are_queued_exactly_as_before() {
    let server = kit::spawn(vec![kit::reply(&["x."], Duration::ZERO)]).await;
    let owner = Keys::generate();
    let on = Arc::new(Mutex::new(false));
    let (rt, _rx) = runtime(&server.base_url, on);
    let mut intake = Intake::new(&owner);
    let channel = Uuid::new_v4();
    assert!(route_inbound_event(
        &rt,
        intake.accept_ctx(),
        channel,
        voice(&owner, channel, "switch is off"),
        "t".into(),
    ));
    let typed = EventBuilder::new(Kind::Custom(9), "typed message")
        .sign_with_keys(&owner)
        .unwrap();
    assert!(route_inbound_event(
        &rt,
        intake.accept_ctx(),
        channel,
        typed,
        "t".into(),
    ));
    assert_eq!(intake.queued(), 2);
    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn fallback_hand_back_is_queued_once() {
    let server = kit::spawn(vec![Script::Status(500)]).await;
    let owner = Keys::generate();
    let (rt, mut rx) = runtime(&server.base_url, Arc::new(Mutex::new(true)));
    let mut intake = Intake::new(&owner);
    let channel = Uuid::new_v4();
    let ev = voice(&owner, channel, "hello?");
    assert!(!route_inbound_event(
        &rt,
        intake.accept_ctx(),
        channel,
        ev.clone(),
        "t".into()
    ));
    let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("hand-back in time")
        .expect("msg");
    handle_voice_fast_msg(intake.accept_ctx(), msg);
    let batch = intake.queue.flush_next().expect("queued");
    assert_eq!(batch.events.len(), 1);
    assert_eq!(batch.events[0].event.id, ev.id);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err(), "handed back exactly once");
}

#[tokio::test]
async fn digest_is_skipped_while_the_channel_is_in_flight() {
    let owner = Keys::generate();
    let mut intake = Intake::new(&owner);
    let channel = Uuid::new_v4();
    let agent = Keys::generate();
    let digest = voice_fast_runner::build_digest_event(&agent, channel).unwrap();
    // Occupy the channel.
    intake.queue.push(QueuedEvent {
        channel_id: channel,
        event: voice(&owner, channel, "busy"),
        received_at: std::time::Instant::now(),
        prompt_tag: "t".into(),
    });
    let _in_flight = intake.queue.flush_next().expect("batch");
    handle_voice_fast_msg(
        intake.accept_ctx(),
        VoiceFastMsg::Digest {
            channel_id: channel,
            event: digest.clone(),
        },
    );
    assert!(intake.queue.flush_next().is_none());
    intake.queue.mark_complete(channel);
    handle_voice_fast_msg(
        intake.accept_ctx(),
        VoiceFastMsg::Digest {
            channel_id: channel,
            event: digest,
        },
    );
    let batch = intake.queue.flush_next().expect("digest queued");
    assert_eq!(
        batch.events[0].prompt_tag,
        voice_fast_runner::DIGEST_PROMPT_TAG
    );
}
