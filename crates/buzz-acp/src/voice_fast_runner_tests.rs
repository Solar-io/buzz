//! Runner integration tests: fake SSE server + recording sink + a real
//! `EventQueue` fed by the runner's hand-backs (spec §9 AC2, tests 1-8).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::*;
use crate::queue::{EventQueue, QueuedEvent};
use crate::voice_fast_testkit::{self as kit, Script};
use crate::voice_stream::{SinkFuture, SpeechSink};
use crate::voice_turn::VoiceFastSettings;

#[derive(Default)]
struct RecSink {
    events: Mutex<Vec<Event>>,
}

impl RecSink {
    fn all(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }
    fn segments_for(&self, stream: &str) -> Vec<Event> {
        self.all()
            .into_iter()
            .filter(|e| e.kind.as_u16() == 24820 && speech(e).is_some_and(|s| s[1] == stream))
            .collect()
    }
    fn finals(&self) -> Vec<Event> {
        self.all()
            .into_iter()
            .filter(|e| e.kind.as_u16() == 9)
            .collect()
    }
    fn segment_count(&self) -> usize {
        self.all()
            .iter()
            .filter(|e| e.kind.as_u16() == 24820)
            .count()
    }
}

impl SpeechSink for RecSink {
    fn publish_segment(&self, event: Event) -> SinkFuture<'_> {
        self.events.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
    fn post_final(&self, event: Event) -> SinkFuture<'_> {
        self.events.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
}

fn tag(e: &Event, name: &str) -> Option<Vec<String>> {
    e.tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .find(|t| t.first().map(String::as_str) == Some(name))
}

fn speech(e: &Event) -> Option<Vec<String>> {
    tag(e, "buzz-speech")
}

struct Rig {
    rt: Arc<VoiceFastRuntime>,
    rx: mpsc::UnboundedReceiver<VoiceFastMsg>,
    sink: Arc<RecSink>,
    server: kit::FakeSse,
    owner: Keys,
    channel: Uuid,
    settings: Arc<Mutex<VoiceFastSettings>>,
}

impl Rig {
    async fn new(scripts: Vec<Script>) -> Self {
        Self::with(scripts, |_| {}).await
    }

    async fn with(scripts: Vec<Script>, tweak: impl FnOnce(&mut VoiceFastSettings)) -> Self {
        let server = kit::spawn(scripts).await;
        let mut s = VoiceFastSettings {
            on: true,
            base_url: Some(server.base_url.clone()),
            first_token_ms: 400,
            ..VoiceFastSettings::default()
        };
        tweak(&mut s);
        let settings = Arc::new(Mutex::new(s));
        let source = settings.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let sink = Arc::new(RecSink::default());
        let owner = Keys::generate();
        let rt = VoiceFastRuntime::new(VoiceFastDeps {
            ledgers: Arc::new(VoiceFastLedgers::new()),
            http: crate::voice_fast_client::build_http_client(),
            sink: sink.clone(),
            keys: Keys::generate(),
            persona: Some("You are Kaiya.".into()),
            rest: None,
            owner: Some(owner.public_key()),
            to_main: tx,
            settings: Arc::new(move || source.lock().unwrap().clone()),
            key: KeySource::Fixed(Some("test-key".into())),
            digest_delay_override: Some(Duration::from_secs(3600)),
        });
        Self {
            rt,
            rx,
            sink,
            server,
            owner,
            channel: Uuid::new_v4(),
            settings,
        }
    }

    fn voice_from(&self, keys: &Keys, text: &str) -> Event {
        EventBuilder::new(Kind::Custom(9), format!("[voice] {text}"))
            .tags([Tag::parse(["h", &self.channel.to_string()]).unwrap()])
            .sign_with_keys(keys)
            .unwrap()
    }

    fn voice(&self, text: &str) -> Event {
        self.voice_from(&self.owner.clone(), text)
    }

    fn claim(&self, event: &Event) -> bool {
        let owner = self.owner.public_key().to_hex();
        self.rt
            .try_claim(self.channel, event, Some(&owner), "voice-rule")
    }

    /// Wait until no fast turn is active in the channel (or time out).
    async fn settle(&self) {
        for _ in 0..300 {
            if !lock(&self.rt.active).contains_key(&self.channel) {
                tokio::time::sleep(Duration::from_millis(30)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fast turn never finished");
    }

    /// Drain hand-backs into a real queue, as the main loop does.
    fn drain_into(&mut self, queue: &mut EventQueue) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                VoiceFastMsg::PushToAgent {
                    channel_id,
                    event,
                    prompt_tag,
                    reason,
                } => {
                    reasons.push(reason);
                    queue.push(QueuedEvent {
                        channel_id,
                        event,
                        received_at: std::time::Instant::now(),
                        prompt_tag,
                    });
                }
                VoiceFastMsg::Digest { .. } => reasons.push("digest"),
            }
        }
        reasons
    }
}

fn queue() -> EventQueue {
    EventQueue::new(crate::config::DedupMode::Queue)
}

// 1. normal → segments + one final, nothing queued.
#[tokio::test]
async fn normal_fast_turn_speaks_and_queues_nothing() {
    let mut rig = Rig::new(vec![kit::reply(
        &["Pasta ", "would be easy tonight. ", "Want a recipe?"],
        Duration::from_millis(5),
    )])
    .await;
    let ev = rig.voice("what should I cook tonight?");
    assert!(rig.claim(&ev));
    rig.settle().await;
    let stream = fast_stream_id(&ev.id.to_hex());
    let segments = rig.sink.segments_for(&stream);
    assert!(!segments.is_empty());
    assert_eq!(segments[0].content, "Pasta would be easy tonight.");
    assert_eq!(tag(&segments[0], "e").unwrap()[1], ev.id.to_hex());
    let finals = rig.sink.finals();
    assert_eq!(finals.len(), 1);
    assert_eq!(
        finals[0].content,
        "Pasta would be easy tonight. Want a recipe?"
    );
    assert_eq!(speech(&finals[0]).unwrap()[1], stream);
    let mut q = queue();
    assert!(rig.drain_into(&mut q).is_empty());
    assert_eq!(q.pending_channels(), 0);
    assert_eq!(rig.server.request_count(), 1);
    let body = &rig.server.bodies()[0];
    assert_eq!(body["reasoning_effort"], "none");
    assert!(body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .starts_with("You are Kaiya."));
    assert_eq!(
        body["messages"].as_array().unwrap().last().unwrap()["content"],
        "what should I cook tonight?\n\n[call state: agent idle]"
    );
}

// 2. handoff → ack final without the marker, trigger queued, context rendered.
#[tokio::test]
async fn handoff_speaks_ack_then_queues_trigger_with_context() {
    let mut rig = Rig::new(vec![kit::reply(
        &[
            "Let me check.",
            "\n<<hand",
            "off: check the calendar for tomorrow>>",
        ],
        Duration::from_millis(5),
    )])
    .await;
    let ev = rig.voice("what's on my calendar tomorrow?");
    assert!(rig.claim(&ev));
    rig.settle().await;
    let finals = rig.sink.finals();
    assert_eq!(finals.len(), 1);
    assert_eq!(finals[0].content, "Let me check.");
    assert!(rig
        .sink
        .all()
        .iter()
        .all(|e| !e.content.contains('<') && !e.content.contains("handoff")));
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q), vec!["handoff"]);
    let batch = q.flush_next().expect("trigger queued");
    assert_eq!(batch.events.len(), 1);
    assert_eq!(batch.events[0].event.id, ev.id);
    assert_eq!(batch.events[0].prompt_tag, "voice-rule");

    let ids = vec![ev.id.to_hex()];
    let rendered = rig
        .rt
        .ledgers()
        .render_context(rig.channel, &ids)
        .expect("context");
    assert!(rendered.text.contains(
        "it already said: \"Let me check.\" and handed you: check the calendar for tomorrow."
    ));
    let sections = crate::queue::format_prompt(
        &batch,
        &crate::queue::FormatPromptArgs {
            voice_fast_context: Some(&rendered.text),
            ..Default::default()
        },
    );
    let joined = sections.join("\n\n");
    let event_at = joined
        .find("what's on my calendar tomorrow?")
        .expect("event");
    let ctx_at = joined
        .find("[Voice Fast Context]")
        .expect("context section");
    assert!(ctx_at > event_at, "context renders after the event section");
    // Exactly once: the same event can never be handed twice.
    assert!(!rig
        .rt
        .push_to_agent(rig.channel, &ev, "voice-rule", "handoff"));
    assert!(rig.drain_into(&mut q).is_empty());
}

// A bare "Let me check." with no marker still reaches the agent.
#[tokio::test]
async fn bare_ack_without_marker_hands_off() {
    let mut rig = Rig::new(vec![kit::reply(&["Let me check."], Duration::ZERO)]).await;
    let ev = rig.voice("find that article I sent you");
    assert!(rig.claim(&ev));
    rig.settle().await;
    assert_eq!(rig.sink.finals().len(), 1);
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q), vec!["handoff"]);
    let ctx = rig
        .rt
        .ledgers()
        .render_context(rig.channel, &[ev.id.to_hex()])
        .expect("ctx");
    assert!(ctx
        .text
        .contains("handed you: answer the caller's request: \"find that article I sent you\""));
}

// 3. HTTP 500 → no 24820 at all, trigger queued (fallback).
#[tokio::test]
async fn http_error_falls_back_before_speaking() {
    let mut rig = Rig::new(vec![Script::Status(500)]).await;
    let ev = rig.voice("hello?");
    assert!(rig.claim(&ev));
    rig.settle().await;
    assert_eq!(rig.sink.segment_count(), 0);
    assert!(rig.sink.finals().is_empty());
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q), vec!["fallback"]);
    assert_eq!(q.flush_next().expect("queued").events[0].event.id, ev.id);
}

// 4. stall past the first-token timeout → same as 3.
#[tokio::test]
async fn first_token_timeout_falls_back() {
    let mut rig = Rig::new(vec![Script::Stall]).await;
    let ev = rig.voice("are you there?");
    let t0 = std::time::Instant::now();
    assert!(rig.claim(&ev));
    rig.settle().await;
    assert!(t0.elapsed() >= Duration::from_millis(400));
    assert_eq!(rig.sink.segment_count(), 0);
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q), vec!["fallback"]);
}

// 5. EOF after the first segment → done + partial final, NO fallback.
#[tokio::test]
async fn stream_death_after_first_segment_finalizes_partial_without_fallback() {
    let mut rig = Rig::new(vec![Script::Stream(vec![
        (Duration::ZERO, kit::text_delta("First sentence. And then")),
        // Ignored payload, so the EOF lands well after segment 0 went out.
        (Duration::from_millis(150), ":".to_string()),
    ])])
    .await;
    let ev = rig.voice("tell me a story");
    assert!(rig.claim(&ev));
    rig.settle().await;
    let stream = fast_stream_id(&ev.id.to_hex());
    let segments = rig.sink.segments_for(&stream);
    assert_eq!(segments[0].content, "First sentence.");
    let done = segments.last().unwrap();
    assert_eq!(tag(done, "done").unwrap().len(), 2, "plain done, not cut");
    let finals = rig.sink.finals();
    assert_eq!(finals.len(), 1);
    assert_eq!(finals[0].content, "First sentence. And then");
    let mut q = queue();
    assert!(rig.drain_into(&mut q).is_empty());
    assert_eq!(q.pending_channels(), 0);
    let interrupted = rig
        .rt
        .ledgers()
        .with_existing(rig.channel, |l| l.last_reply_interrupted)
        .unwrap();
    assert!(interrupted);
}

// 6. non-owner `[voice]` → agent route, no request.
#[tokio::test]
async fn non_owner_voice_is_not_claimed_and_makes_no_request() {
    let rig = Rig::new(vec![kit::reply(&["x."], Duration::ZERO)]).await;
    let stranger = Keys::generate();
    let ev = rig.voice_from(&stranger, "hi Kaiya");
    assert!(!rig.claim(&ev));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(rig.server.request_count(), 0);
    assert!(!rig.rt.ledgers().contains(rig.channel));
}

// 7. switch off → agent route, no request, no ledger (prompt unchanged).
#[tokio::test]
async fn switch_off_is_not_claimed_and_makes_no_request() {
    let rig = Rig::with(vec![kit::reply(&["x."], Duration::ZERO)], |s| s.on = false).await;
    let ev = rig.voice("hi");
    assert!(!rig.claim(&ev));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(rig.server.request_count(), 0);
    assert_eq!(rig.rt.ledgers().render_context(rig.channel, &[]), None);
    // Flipping it on takes effect on the next event, no restart.
    rig.settings.lock().unwrap().on = true;
    assert!(rig.claim(&rig.voice("now?")));
}

// 8. two owner events 200 ms apart → first cut (no final), second answers.
#[tokio::test]
async fn newer_utterance_supersedes_with_cut_and_no_final() {
    let mut rig = Rig::new(vec![
        Script::Stream(vec![
            (Duration::ZERO, kit::text_delta("Okay so. ")),
            (
                Duration::from_millis(1500),
                kit::text_delta("more that never plays."),
            ),
        ]),
        kit::reply(&["Dinner then. ", "Sounds good."], Duration::from_millis(5)),
    ])
    .await;
    let first = rig.voice("I was thinking");
    assert!(rig.claim(&first));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let second = rig.voice("about dinner");
    assert!(rig.claim(&second));
    rig.settle().await;
    let s1 = fast_stream_id(&first.id.to_hex());
    let s2 = fast_stream_id(&second.id.to_hex());
    let first_segments = rig.sink.segments_for(&s1);
    assert_eq!(first_segments[0].content, "Okay so.");
    assert_eq!(
        tag(first_segments.last().unwrap(), "done").unwrap(),
        vec!["done", "8", "cut"]
    );
    let finals = rig.sink.finals();
    assert_eq!(finals.len(), 1, "only the second stream gets a final");
    assert_eq!(speech(&finals[0]).unwrap()[1], s2);
    assert_eq!(finals[0].content, "Dinner then. Sounds good.");
    // The second request saw both utterances.
    let body = &rig.server.bodies()[1];
    let msgs = body["messages"].as_array().unwrap();
    let all: String = msgs
        .iter()
        .map(|m| m["content"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(all.contains("I was thinking"));
    assert!(all.contains("Okay so. (cut off)"));
    let mut q = queue();
    assert!(rig.drain_into(&mut q).is_empty());
}

// Empty reply with no handoff: nothing spoken, the agent answers.
#[tokio::test]
async fn empty_reply_falls_back() {
    let mut rig = Rig::new(vec![kit::reply(&["   "], Duration::ZERO)]).await;
    let ev = rig.voice("hmm");
    assert!(rig.claim(&ev));
    rig.settle().await;
    assert_eq!(rig.sink.segment_count(), 0);
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q), vec!["fallback"]);
}

// Circuit: three fallbacks in a row → the fourth event routes to the agent.
#[tokio::test]
async fn three_fallbacks_open_the_circuit() {
    let mut rig = Rig::new(vec![Script::Status(502)]).await;
    for i in 0..3 {
        let ev = rig.voice(&format!("try {i}"));
        assert!(rig.claim(&ev));
        rig.settle().await;
    }
    assert!(!rig.claim(&rig.voice("fourth")));
    assert_eq!(rig.server.request_count(), 3);
    let mut q = queue();
    assert_eq!(rig.drain_into(&mut q).len(), 3);
}

// Digest: an idle call with fast-only turns produces one digest event.
#[tokio::test]
async fn idle_digest_fires_after_fast_only_turns() {
    let server = kit::spawn(vec![kit::reply(&["Sure thing."], Duration::ZERO)]).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let owner = Keys::generate();
    let agent = Keys::generate();
    let base = server.base_url.clone();
    let rt = VoiceFastRuntime::new(VoiceFastDeps {
        ledgers: Arc::new(VoiceFastLedgers::new()),
        http: crate::voice_fast_client::build_http_client(),
        sink: Arc::new(RecSink::default()),
        keys: agent.clone(),
        persona: None,
        rest: None,
        owner: Some(owner.public_key()),
        to_main: tx,
        settings: Arc::new(move || VoiceFastSettings {
            on: true,
            base_url: Some(base.clone()),
            ..VoiceFastSettings::default()
        }),
        key: KeySource::Fixed(Some("k".into())),
        digest_delay_override: Some(Duration::from_millis(150)),
    });
    let channel = Uuid::new_v4();
    let ev = EventBuilder::new(Kind::Custom(9), "[voice] thanks")
        .sign_with_keys(&owner)
        .unwrap();
    assert!(rt.try_claim(channel, &ev, Some(&owner.public_key().to_hex()), "t"));
    let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("digest in time")
        .expect("msg");
    match msg {
        VoiceFastMsg::Digest { channel_id, event } => {
            assert_eq!(channel_id, channel);
            assert_eq!(event.pubkey, agent.public_key());
            assert_eq!(event.content, DIGEST_PROMPT);
            assert_eq!(tag(&event, "h").unwrap()[1], channel.to_string());
        }
        other => panic!("expected digest, got {other:?}"),
    }
    let ctx = rt
        .ledgers()
        .render_context(channel, &[])
        .expect("undigested");
    assert!(ctx.text.contains("Caller: thanks"));
    assert!(ctx.text.contains("You: Sure thing."));
}

// R8: the agent's own call reply feeds the next fast prompt.
#[tokio::test]
async fn agent_reply_in_call_feeds_fast_history() {
    let rig = Rig::new(vec![
        kit::reply(
            &["Let me check.\n<<handoff: read the doc>>"],
            Duration::ZERO,
        ),
        kit::reply(&["Glad it helps."], Duration::ZERO),
    ])
    .await;
    let ev = rig.voice("what does the doc say?");
    assert!(rig.claim(&ev));
    rig.settle().await;
    let agent_keys = Keys::generate();
    let reply = EventBuilder::new(Kind::Custom(9), "The doc says ship Friday.")
        .tags([Tag::parse(["buzz-speech", "turn-7", "1", "25"]).unwrap()])
        .sign_with_keys(&agent_keys)
        .unwrap();
    rig.rt.note_self_message(rig.channel, &reply);
    rig.rt.note_self_message(rig.channel, &reply);
    rig.rt.ledgers().note_agent_turn_end(rig.channel);
    let next = rig.voice("great, thanks");
    assert!(rig.claim(&next));
    rig.settle().await;
    let body = &rig.server.bodies()[1];
    let text = body["messages"].to_string();
    assert_eq!(text.matches("The doc says ship Friday.").count(), 1);
    assert!(text.contains("[call state: agent idle]"));
}
