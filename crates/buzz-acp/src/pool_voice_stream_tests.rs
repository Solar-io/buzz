//! Pool wiring for streamed voice replies (spec §5 row 3): real
//! `run_prompt_task` turns against a fake ACP agent, with an in-memory
//! [`SpeechSink`] standing in for the relay.

use super::*;
use crate::acp::AcpClient;
use crate::voice_stream::{SinkFuture, SpeechSink};
use nostr::{Event, EventBuilder, Keys, Kind};
use std::sync::Mutex as StdMutex;
use tests::make_prompt_context_no_owner;

const SESSION: &str = "live-session";

/// Answers every `session/prompt` with two text chunks, then `end_turn`.
const ANSWER_SCRIPT: &str = r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__CAPTURE__'
  case "$line" in
    *'"session/prompt"'*)
      ID=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"live-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Sure. "}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"live-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"It is 72 degrees in Austin right now."}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done
"#;

/// Streams a partial answer, then waits for `session/cancel` and ends the
/// turn as cancelled.
const CANCEL_SCRIPT: &str = r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__CAPTURE__'
  case "$line" in
    *'"session/prompt"'*)
      ID=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"live-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Let me look that up for you. The forecast"}}}}'
      IFS= read -r cancel
      printf '%s\n' "$cancel" >> '__CAPTURE__'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"result\":{\"stopReason\":\"cancelled\"}}"
      ;;
  esac
done
"#;

#[derive(Default)]
struct CollectSink {
    events: StdMutex<Vec<Event>>,
}

impl CollectSink {
    fn of_kind(&self, kind: u16) -> Vec<Event> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.kind.as_u16() == kind)
            .cloned()
            .collect()
    }
    fn len(&self) -> usize {
        self.events.lock().unwrap().len()
    }
}

impl SpeechSink for CollectSink {
    fn publish_segment(&self, event: Event) -> SinkFuture<'_> {
        Box::pin(async move {
            self.events.lock().unwrap().push(event);
            Ok(())
        })
    }
    fn post_final(&self, event: Event) -> SinkFuture<'_> {
        self.publish_segment(event)
    }
}

struct Harness {
    agent: OwnedAgent,
    channel_id: Uuid,
    capture: std::path::PathBuf,
    sink: Arc<CollectSink>,
    ctx: Arc<PromptContext>,
}

async fn harness(script: &str, forced: Option<bool>, with_sink: bool) -> Harness {
    harness_in(script, forced, with_sink, Uuid::new_v4()).await
}

async fn harness_in(
    script: &str,
    forced: Option<bool>,
    with_sink: bool,
    channel_id: Uuid,
) -> Harness {
    let capture =
        std::env::temp_dir().join(format!("buzz-acp-voice-stream-{}.ndjson", Uuid::new_v4()));
    let quoted = capture.to_string_lossy().replace('\'', "'\\''");
    let script = script.replace("__CAPTURE__", &quoted);
    let acp = AcpClient::spawn("bash", &["-c".into(), script], &[], false)
        .await
        .expect("spawn fake ACP");
    let mut agent = OwnedAgent {
        index: 0,
        acp,
        state: SessionState::default(),
        model_capabilities: None,
        desired_model: None,
        model_overridden: false,
        desired_model_request_id: None,
        desired_model_pending_ack: false,
        startup_effort: None,
        agent_name: "voice-test-agent".into(),
        goose_system_prompt_supported: None,
        protocol_version: 2,
    };
    agent.state.sessions.insert(channel_id, SESSION.into());
    agent
        .state
        .deliveries
        .insert(channel_id, ChannelDeliveryState::default());
    let sink = Arc::new(CollectSink::default());
    let mut ctx = make_prompt_context_no_owner();
    ctx.voice_stream_forced = forced;
    if with_sink {
        ctx.speech_sink = Some(sink.clone() as Arc<dyn SpeechSink>);
    }
    Harness {
        agent,
        channel_id,
        capture,
        sink,
        ctx: Arc::new(ctx),
    }
}

fn batch(channel_id: Uuid, content: &str) -> (FlushBatch, String) {
    let event = EventBuilder::new(Kind::Custom(9), content)
        .sign_with_keys(&Keys::generate())
        .unwrap();
    batch_of(channel_id, event)
}

fn batch_of(channel_id: Uuid, event: Event) -> (FlushBatch, String) {
    let id = event.id.to_hex();
    (
        FlushBatch {
            channel_id,
            events: vec![crate::queue::BatchEvent {
                event,
                prompt_tag: "test".into(),
                received_at: std::time::Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        },
        id,
    )
}

impl Harness {
    /// Run one uncontrolled channel turn; return the agent's outcome.
    async fn turn(&mut self, content: &str, turn_id: &str) -> PromptOutcome {
        let (b, _) = batch(self.channel_id, content);
        self.turn_batch(b, turn_id).await
    }

    async fn turn_batch(&mut self, b: FlushBatch, turn_id: &str) -> PromptOutcome {
        let (result_tx, mut result_rx) = mpsc::unbounded_channel();
        let agent = std::mem::replace(&mut self.agent, placeholder_agent().await);
        run_prompt_task(
            agent,
            Some(b),
            None,
            Arc::clone(&self.ctx),
            result_tx,
            None,
            turn_id.into(),
        )
        .await;
        let result = result_rx.recv().await.expect("prompt result");
        let _ = std::mem::replace(&mut self.agent, result.agent)
            .acp
            .shutdown()
            .await;
        result.outcome
    }

    /// The prompt blocks of every `session/prompt` the agent received.
    fn prompts(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(&self.capture)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v["method"] == "session/prompt")
            .map(|v| {
                v["params"]["prompt"]
                    .as_array()
                    .expect("blocks")
                    .iter()
                    .filter_map(|b| b["text"].as_str().map(str::to_string))
                    .collect()
            })
            .collect()
    }

    async fn finish(mut self) {
        self.agent.acp.shutdown().await;
        let _ = std::fs::remove_file(&self.capture);
    }
}

async fn placeholder_agent() -> OwnedAgent {
    OwnedAgent {
        index: 0,
        acp: AcpClient::spawn("bash", &["-c".into(), "sleep 30".into()], &[], false)
            .await
            .expect("spawn placeholder"),
        state: SessionState::default(),
        model_capabilities: None,
        desired_model: None,
        model_overridden: false,
        desired_model_request_id: None,
        desired_model_pending_ack: false,
        startup_effort: None,
        agent_name: "placeholder".into(),
        goose_system_prompt_supported: None,
        protocol_version: 2,
    }
}

/// Wait (bounded) for the detached streamer to hand `n` events to the sink.
async fn wait_for_events(sink: &CollectSink, n: usize) {
    // Generous: the turn's REST context fetches retry against a dead port.
    for _ in 0..3000 {
        if sink.len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("expected {n} events, got {}", sink.len());
}

fn tag(event: &Event, name: &str) -> Option<Vec<String>> {
    event
        .tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .find(|t| t.first().map(String::as_str) == Some(name))
}

const VOICE_REPLY_HEAD: &str = "[Voice Reply]\nThis turn is a live voice call.";
const REPLY_MODE_HEAD: &str = "[Reply Mode]\nThis turn is not a streamed voice reply";

#[tokio::test]
async fn switch_on_voice_turn_streams_segments_then_one_tagged_final() {
    let mut h = harness(ANSWER_SCRIPT, Some(true), true).await;
    let (b, trigger_id) = batch(h.channel_id, "[voice] what's the weather");
    let (result_tx, mut result_rx) = mpsc::unbounded_channel();
    let agent = std::mem::replace(&mut h.agent, placeholder_agent().await);
    run_prompt_task(
        agent,
        Some(b),
        None,
        Arc::clone(&h.ctx),
        result_tx,
        None,
        "voice-turn-1".into(),
    )
    .await;
    let result = result_rx.recv().await.expect("result");
    assert!(matches!(
        result.outcome,
        PromptOutcome::Ok(StopReason::EndTurn)
    ));
    let _ = std::mem::replace(&mut h.agent, result.agent)
        .acp
        .shutdown()
        .await;

    // segment 0 + done + final.
    wait_for_events(&h.sink, 3).await;
    let segments = h.sink.of_kind(24820);
    assert_eq!(segments.len(), 2, "{segments:?}");
    let channel = h.channel_id.to_string();
    let mut next_offset = 0usize;
    for (seq, ev) in segments.iter().enumerate() {
        assert_eq!(
            tag(ev, "h").unwrap(),
            vec!["h".to_string(), channel.clone()]
        );
        let speech = tag(ev, "buzz-speech").unwrap();
        assert_eq!(speech[1], "voice-turn-1");
        assert_eq!(speech[2], seq.to_string());
        assert_eq!(speech[3], next_offset.to_string(), "offsets are contiguous");
        next_offset += ev.content.encode_utf16().count();
        assert_eq!(tag(ev, "e").unwrap()[1], trigger_id);
        assert_eq!(ev.pubkey, h.ctx.agent_keys.public_key());
    }
    assert_eq!(segments[0].content, "Sure.");
    assert!(tag(&segments[0], "done").is_none());
    assert_eq!(tag(&segments[1], "done").unwrap(), vec!["done", "43"]);

    let finals = h.sink.of_kind(9);
    assert_eq!(finals.len(), 1);
    assert_eq!(
        finals[0].content,
        "Sure. It is 72 degrees in Austin right now."
    );
    assert_eq!(
        tag(&finals[0], "buzz-speech").unwrap(),
        vec!["buzz-speech", "voice-turn-1", "2", "43"]
    );

    // The prompt told the agent to answer in plain text — as the LAST block.
    let prompts = h.prompts();
    assert_eq!(prompts.len(), 1);
    assert!(
        prompts[0].last().unwrap().starts_with(VOICE_REPLY_HEAD),
        "{:?}",
        prompts[0].last()
    );

    // Text-turn guard: a typed turn in the same session is reminded to use
    // the CLI, and streams nothing.
    let before = h.sink.len();
    let outcome = h.turn("typed follow-up", "text-turn-2").await;
    assert!(matches!(outcome, PromptOutcome::Ok(StopReason::EndTurn)));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.sink.len(), before, "typed turn must publish nothing");
    let prompts = h.prompts();
    assert_eq!(prompts.len(), 2);
    assert!(prompts[1].last().unwrap().starts_with(REPLY_MODE_HEAD));
    assert!(!prompts[1].iter().any(|b| b.contains("[Voice Reply]")));
    h.finish().await;
}

#[tokio::test]
async fn switch_off_voice_turn_publishes_nothing_and_prompt_is_unchanged() {
    // One event and channel for both runs, so the prompts can be compared
    // byte for byte.
    let channel_id = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(9), "[voice] what's the weather")
        .sign_with_keys(&Keys::generate())
        .unwrap();

    // Switch off, sink present.
    let mut off = harness_in(ANSWER_SCRIPT, Some(false), true, channel_id).await;
    let outcome = off
        .turn_batch(batch_of(channel_id, event.clone()).0, "same-turn")
        .await;
    assert!(matches!(outcome, PromptOutcome::Ok(StopReason::EndTurn)));
    // Give a (wrongly) spawned streamer every chance to publish.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        off.sink.len(),
        0,
        "switch off must publish zero 24820/9 events"
    );
    let off_prompts = off.prompts();

    // The pre-feature configuration: no sink at all, so streaming is
    // impossible whatever the switch says.
    let mut baseline = harness_in(ANSWER_SCRIPT, None, false, channel_id).await;
    baseline
        .turn_batch(batch_of(channel_id, event).0, "same-turn")
        .await;
    let base_prompts = baseline.prompts();

    assert_eq!(off_prompts.len(), 1);
    assert_eq!(base_prompts.len(), 1);
    for block in &off_prompts[0] {
        assert!(!block.contains("[Voice Reply]"), "{block}");
        assert!(!block.contains("[Reply Mode]"), "{block}");
    }
    // Byte-identical to the configuration that cannot stream at all.
    assert_eq!(off_prompts[0], base_prompts[0]);
    assert!(off_prompts[0]
        .last()
        .unwrap()
        .contains("[voice] what's the weather"));
    off.finish().await;
    baseline.finish().await;
}

#[tokio::test]
async fn switch_on_unmarked_turn_publishes_nothing() {
    let mut h = harness(ANSWER_SCRIPT, Some(true), true).await;
    let outcome = h.turn("what's the weather", "typed-turn").await;
    assert!(matches!(outcome, PromptOutcome::Ok(StopReason::EndTurn)));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.sink.len(), 0);
    let prompts = h.prompts();
    assert!(!prompts[0].iter().any(|b| b.contains("[Voice Reply]")));
    assert!(!prompts[0].iter().any(|b| b.contains("[Reply Mode]")));
    h.finish().await;
}

#[tokio::test]
async fn video_marked_turn_is_out_of_scope_for_v1() {
    let mut h = harness(ANSWER_SCRIPT, Some(true), true).await;
    h.turn("[video] what's the weather", "video-turn").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.sink.len(), 0);
    assert!(!h.prompts()[0].iter().any(|b| b.contains("[Voice Reply]")));
    h.finish().await;
}

#[tokio::test]
async fn cancelled_voice_turn_still_sends_done_and_partial_final() {
    let mut h = harness(CANCEL_SCRIPT, Some(true), true).await;
    let (b, _) = batch(h.channel_id, "[voice] what's the forecast");
    let (result_tx, mut result_rx) = mpsc::unbounded_channel();
    let (control_tx, control_rx) = tokio::sync::oneshot::channel();
    let agent = std::mem::replace(&mut h.agent, placeholder_agent().await);
    let task = tokio::spawn(run_prompt_task(
        agent,
        Some(b),
        None,
        Arc::clone(&h.ctx),
        result_tx,
        Some(control_rx),
        "cancel-turn".into(),
    ));
    // Segment 0 is out before the cancel lands.
    wait_for_events(&h.sink, 1).await;
    control_tx.send(ControlSignal::Cancel).expect("send cancel");
    let result = result_rx.recv().await.expect("result");
    task.await.unwrap();
    assert!(matches!(result.outcome, PromptOutcome::Cancelled));
    let _ = std::mem::replace(&mut h.agent, result.agent)
        .acp
        .shutdown()
        .await;

    wait_for_events(&h.sink, 3).await;
    let segments = h.sink.of_kind(24820);
    assert_eq!(segments[0].content, "Let me look that up for you.");
    let done = segments.last().unwrap();
    assert_eq!(done.content, " The forecast");
    assert_eq!(tag(done, "done").unwrap(), vec!["done", "41"]);
    let finals = h.sink.of_kind(9);
    assert_eq!(finals.len(), 1);
    assert_eq!(
        finals[0].content,
        "Let me look that up for you. The forecast"
    );
    h.finish().await;
}

#[test]
fn plan_reads_marker_from_last_event_and_requires_a_sink() {
    let mut ctx = make_prompt_context_no_owner();
    ctx.voice_stream_forced = Some(true);
    let channel_id = Uuid::new_v4();
    let source = PromptSource::Channel(channel_id);
    let state = SessionState::default();
    let (marked, _) = batch(channel_id, "[voice] hi");
    // No sink → never streams, even with the switch on.
    let plan = plan_voice_stream(&ctx, &source, Some(&marked), &state);
    assert!(!plan.stream_on);
    assert!(plan.trigger.is_some(), "measure-only tap still applies");
    assert_eq!(plan.reply_mode, crate::queue::ReplyMode::Default);

    ctx.speech_sink = Some(Arc::new(CollectSink::default()));
    let plan = plan_voice_stream(&ctx, &source, Some(&marked), &state);
    assert!(plan.stream_on);
    assert_eq!(plan.reply_mode, crate::queue::ReplyMode::VoiceStream);

    let plan = plan_voice_stream(&ctx, &PromptSource::Heartbeat, None, &state);
    assert!(!plan.stream_on);
    assert!(plan.trigger.is_none());
}
