//! Voice fast lane: the impure half — the per-turn runner.
//!
//! Spec: `~/.buzz/PLANS/VOICE_FAST_PATH_2026-10-07.md` §3.3 (data flow),
//! §3.4 (R1-R8), §6 (failure and fallback).
//!
//! [`VoiceFastRuntime::try_claim`] is called inline by the intake loop for
//! every event that passed the author gate and matched a rule. It makes the
//! ONE routing decision for the event ([`crate::voice_fast::claim`]), logs
//! it, and on `Fast` spawns [`VoiceFastRuntime::run_turn`] and returns `true`
//! — the caller then skips `queue.push` entirely.
//!
//! The runner never touches the queue itself. When the event must reach the
//! agent after all (handoff R3, fallback R4) it sends a
//! [`VoiceFastMsg::PushToAgent`] back to the main loop, at most once per
//! event (`CallLedger::mark_handed`), and the main loop pushes it exactly as
//! the intake would have.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::relay::RestClient;
use crate::voice_fast::{
    build_fast_request, claim, fast_stream_id, is_candidate, strip_voice_marker,
    usable_core_section, CircuitBreaker, ClaimInput, EntrySource, FastPromptParts, HandoffNote,
    HandoffScanner, Route, VoiceFastLedgers, LOG_TARGET,
};
use crate::voice_fast_client::{FastClientError, FastCompletionStream};
use crate::voice_stream::{
    run_voice_stream, SinkFuture, SpeechSink, SpeechTap, StreamReport, VoiceStreamParams,
};
use crate::voice_turn::{VoiceFastDigest, VoiceFastSettings};

/// How long first-sight bootstrap (history + core memory) may delay a turn.
pub const BOOTSTRAP_CAP: Duration = Duration::from_millis(300);

/// History messages fetched on first sight of a call channel.
pub const BOOTSTRAP_HISTORY_LIMIT: usize = 20;

/// Prompt tag for the synthetic idle-digest event.
pub const DIGEST_PROMPT_TAG: &str = "voice-fast-digest";

/// Body of the synthetic idle-digest event; the pool adds the
/// `[Voice Fast Context]` section from the ledger.
pub const DIGEST_PROMPT: &str = "[Voice Fast Digest]\n\
Your fast voice has been talking in this voice call as you (see [Voice Fast Context]). \
Nothing is waiting on you. Reply only to correct something you said, or to follow up on \
something you promised; otherwise end the turn without sending anything.";

/// Messages from the fast lane to the main loop.
#[derive(Debug)]
pub enum VoiceFastMsg {
    /// Push this event into the queue as the intake would have (R3/R4).
    PushToAgent {
        /// Call channel.
        channel_id: Uuid,
        /// The original trigger event.
        event: Event,
        /// The prompt tag the rule match produced.
        prompt_tag: String,
        /// `handoff` | `fallback` (for logs).
        reason: &'static str,
    },
    /// Push a synthetic, unpublished digest event (spec §3.6).
    Digest {
        /// Call channel.
        channel_id: Uuid,
        /// The synthetic event (signed by this agent, never published).
        event: Event,
    },
}

/// Where the per-event knobs come from (test seam).
pub type SettingsSource = Arc<dyn Fn() -> VoiceFastSettings + Send + Sync>;

/// Where the API key comes from.
#[derive(Clone)]
pub enum KeySource {
    /// Production: env > key registry (read per claim) > Infisical (once,
    /// in the background, cached).
    Resolve {
        /// `BUZZ_ACP_DISPLAY_NAME`.
        agent_name: Option<String>,
    },
    /// Tests: a fixed key (or none).
    #[cfg_attr(not(test), allow(dead_code))]
    Fixed(Option<String>),
}

#[derive(Debug, Default)]
enum InfisicalKey {
    #[default]
    Unresolved,
    Resolving,
    Resolved(Option<String>),
}

struct ActiveTurn {
    trigger_id: String,
    cancel: Option<oneshot::Sender<()>>,
    /// Resolves (sender dropped) once that turn has recorded its outcome in
    /// the ledger — a superseding turn waits on it briefly so its prompt
    /// sees the cut-off reply.
    settled: Option<oneshot::Receiver<()>>,
}

/// The per-turn handles [`VoiceFastRuntime::try_claim`] creates
/// synchronously, so supersede order is intake order (R5).
pub struct TurnHandles {
    cancel: oneshot::Receiver<()>,
    settled: oneshot::Sender<()>,
    previous_settled: Option<oneshot::Receiver<()>>,
}

/// How long a superseding turn waits for the superseded one to record its
/// cut-off reply before building its prompt.
pub const SUPERSEDE_SETTLE_CAP: Duration = Duration::from_millis(150);

/// Everything the runtime needs; built once at harness startup.
pub struct VoiceFastDeps {
    /// Shared call ledgers (the pool reads them too).
    pub ledgers: Arc<VoiceFastLedgers>,
    /// Pooled HTTP client.
    pub http: reqwest::Client,
    /// Segment / final publisher.
    pub sink: Arc<dyn SpeechSink>,
    /// The agent's signing keys.
    pub keys: Keys,
    /// The agent's persona (`config.system_prompt`).
    pub persona: Option<String>,
    /// REST client for bootstrap and core memory (`None` skips both).
    pub rest: Option<RestClient>,
    /// The owner (core memory needs it).
    pub owner: Option<PublicKey>,
    /// Back-channel to the main loop.
    pub to_main: mpsc::UnboundedSender<VoiceFastMsg>,
    /// Per-event knobs.
    pub settings: SettingsSource,
    /// API key source.
    pub key: KeySource,
    /// Test seam: digest delay instead of `digest_idle_secs`.
    pub digest_delay_override: Option<Duration>,
}

/// The fast lane of one harness process.
pub struct VoiceFastRuntime {
    deps: VoiceFastDeps,
    circuit: Mutex<CircuitBreaker>,
    active: Mutex<HashMap<Uuid, ActiveTurn>>,
    infisical: Mutex<InfisicalKey>,
    warned_no_persona: std::sync::atomic::AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Wraps the real sink so the runner can atomically decide "nothing was
/// spoken yet — fall back" (R4): once [`GatedSink::close_if_unpublished`]
/// wins, no segment or final can go out through this stream.
struct GatedSink {
    inner: Arc<dyn SpeechSink>,
    state: Mutex<(u32, bool)>,
    stream_id: String,
    started: tokio::time::Instant,
}

impl GatedSink {
    fn close_if_unpublished(&self) -> bool {
        let mut s = lock(&self.state);
        if s.0 == 0 {
            s.1 = true;
            true
        } else {
            false
        }
    }

    fn published(&self) -> u32 {
        lock(&self.state).0
    }
}

impl SpeechSink for GatedSink {
    fn publish_segment(&self, event: Event) -> SinkFuture<'_> {
        let admitted = {
            let mut s = lock(&self.state);
            if s.1 {
                false
            } else {
                s.0 += 1;
                if s.0 == 1 {
                    tracing::info!(
                        target: LOG_TARGET,
                        stream_id = %self.stream_id,
                        ms = self.started.elapsed().as_millis() as u64,
                        "first_segment"
                    );
                }
                true
            }
        };
        if !admitted {
            return Box::pin(async { Err("fast stream closed".to_string()) });
        }
        self.inner.publish_segment(event)
    }

    fn post_final(&self, event: Event) -> SinkFuture<'_> {
        if lock(&self.state).1 {
            return Box::pin(async { Err("fast stream closed".to_string()) });
        }
        self.inner.post_final(event)
    }
}

/// How the model call ended.
enum DriveOutcome {
    /// The stream finished (or the handoff marker closed it).
    Completed { reasoning_chars: usize },
    /// Error or first-token timeout.
    Failed(String),
    /// A newer owner utterance in the channel took over (R5).
    Superseded,
}

impl VoiceFastRuntime {
    /// Build the runtime.
    pub fn new(deps: VoiceFastDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            circuit: Mutex::new(CircuitBreaker::default()),
            active: Mutex::new(HashMap::new()),
            infisical: Mutex::new(InfisicalKey::Unresolved),
            warned_no_persona: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// The shared ledgers.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn ledgers(&self) -> &Arc<VoiceFastLedgers> {
        &self.deps.ledgers
    }

    fn api_key(self: &Arc<Self>) -> Option<String> {
        match &self.deps.key {
            KeySource::Fixed(key) => key.clone(),
            KeySource::Resolve { agent_name } => {
                if let Some(key) =
                    crate::voice_fast_client::resolve_api_key_sync(agent_name.as_deref())
                {
                    return Some(key);
                }
                let mut state = lock(&self.infisical);
                match &*state {
                    InfisicalKey::Resolved(key) => key.clone(),
                    InfisicalKey::Resolving => None,
                    InfisicalKey::Unresolved => {
                        let Some(name) = agent_name.clone() else {
                            *state = InfisicalKey::Resolved(None);
                            return None;
                        };
                        *state = InfisicalKey::Resolving;
                        let this = self.clone();
                        tokio::spawn(async move {
                            let key =
                                crate::voice_fast_client::resolve_api_key_infisical(&name).await;
                            if key.is_none() {
                                tracing::warn!(
                                    target: LOG_TARGET,
                                    "no fast-lane API key (env, key registry and Infisical all empty) — voice stays on the agent path"
                                );
                            }
                            *lock(&this.infisical) = InfisicalKey::Resolved(key);
                        });
                        None
                    }
                }
            }
        }
    }

    /// The single routing decision for one inbound event (R1). Returns
    /// `true` when the fast lane claimed it — the caller must then NOT push
    /// it to the queue. Non-candidates return `false` without a log line.
    pub fn try_claim(
        self: &Arc<Self>,
        channel_id: Uuid,
        event: &Event,
        owner_hex: Option<&str>,
        prompt_tag: &str,
    ) -> bool {
        let kind = u32::from(event.kind.as_u16());
        if !is_candidate(kind, &event.content) {
            return false;
        }
        let settings = (self.deps.settings)();
        let api_key = if settings.on { self.api_key() } else { None };
        let has_api_key = api_key.is_some();
        let circuit_open = lock(&self.circuit).is_open(std::time::Instant::now());
        let author_hex = event.pubkey.to_hex();
        let decision = claim(&ClaimInput {
            kind,
            content: &event.content,
            author_hex: &author_hex,
            owner_hex,
            settings: &settings,
            has_api_key,
            circuit_open,
        });
        let event_id = event.id.to_hex();
        let route = match decision.route {
            Route::Fast => "fast",
            Route::Agent => "agent",
        };
        tracing::info!(
            target: LOG_TARGET,
            event = %event_id,
            channel = %channel_id,
            route,
            reason = decision.reason,
            "route"
        );
        if decision.route != Route::Fast {
            return false;
        }
        let Some(api_key) = api_key else {
            return false;
        };
        // R5: the newest owner utterance supersedes a generating stream.
        // Decided here, synchronously, so it follows intake order.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (settled_tx, settled_rx) = oneshot::channel();
        let previous = lock(&self.active).insert(
            channel_id,
            ActiveTurn {
                trigger_id: event.id.to_hex(),
                cancel: Some(cancel_tx),
                settled: Some(settled_rx),
            },
        );
        let previous_settled = previous.and_then(|mut prev| {
            if let Some(tx) = prev.cancel.take() {
                let _ = tx.send(());
            }
            prev.settled.take()
        });
        let handles = TurnHandles {
            cancel: cancel_rx,
            settled: settled_tx,
            previous_settled,
        };
        let this = self.clone();
        let event = event.clone();
        let prompt_tag = prompt_tag.to_string();
        tokio::spawn(async move {
            this.run_turn(settings, api_key, channel_id, event, prompt_tag, handles)
                .await;
        });
        true
    }

    /// R8: one of this agent's own kind:9 messages in a call channel with a
    /// ledger becomes an assistant line (deduped). Call BEFORE `ignore_self`.
    pub fn note_self_message(&self, channel_id: Uuid, event: &Event) {
        if event.kind.as_u16() != 9 {
            return;
        }
        let stream_id = event.tags.iter().find_map(|t| {
            let s = t.as_slice();
            (s.first().map(String::as_str) == Some(crate::voice_stream::SPEECH_TAG))
                .then(|| s.get(1).cloned())
                .flatten()
        });
        let event_id = event.id.to_hex();
        self.deps.ledgers.with_existing(channel_id, |l| {
            l.note_self_message(&event_id, stream_id.as_deref(), &event.content)
        });
    }

    /// Hand `event` to the agent through the main loop — at most once per
    /// event (R1). Returns whether it was sent.
    fn push_to_agent(
        &self,
        channel_id: Uuid,
        event: &Event,
        prompt_tag: &str,
        reason: &'static str,
    ) -> bool {
        let event_id = event.id.to_hex();
        let first = self
            .deps
            .ledgers
            .with(channel_id, std::time::Instant::now(), |l| {
                l.mark_handed(&event_id)
            });
        if !first {
            tracing::warn!(
                target: LOG_TARGET,
                event = %event_id,
                reason,
                "already handed to the agent — not pushing twice"
            );
            return false;
        }
        self.deps
            .to_main
            .send(VoiceFastMsg::PushToAgent {
                channel_id,
                event: event.clone(),
                prompt_tag: prompt_tag.to_string(),
                reason,
            })
            .is_ok()
    }

    async fn bootstrap(self: &Arc<Self>, channel_id: Uuid, trigger_id: &str, memory: bool) {
        let first = self
            .deps
            .ledgers
            .with(channel_id, std::time::Instant::now(), |l| {
                let first = !l.bootstrapped;
                l.bootstrapped = true;
                first
            });
        if !first {
            return;
        }
        let Some(rest) = self.deps.rest.clone() else {
            return;
        };
        // Core memory: fetched in the background; if it misses the cap it
        // still lands in the ledger for the next turn.
        let memory_task = match (memory, self.deps.owner) {
            (true, Some(owner)) => {
                let ledgers = self.deps.ledgers.clone();
                let keys = self.deps.keys.clone();
                let rest = rest.clone();
                Some(tokio::spawn(async move {
                    if let Some(section) =
                        crate::engram_fetch::build_core_section(&rest, &keys, &owner).await
                    {
                        if usable_core_section(&section) {
                            ledgers.with_existing(channel_id, |l| l.core_memory = Some(section));
                        }
                    }
                }))
            }
            _ => None,
        };
        let history = async {
            use nostr::{Alphabet, SingleLetterTag};
            let filter = nostr::Filter::new()
                .kind(Kind::Custom(9))
                .custom_tags(
                    SingleLetterTag::lowercase(Alphabet::H),
                    [channel_id.to_string()],
                )
                .limit(BOOTSTRAP_HISTORY_LIMIT);
            rest.query(std::slice::from_ref(&filter)).await.ok()
        };
        let joined = tokio::time::timeout(BOOTSTRAP_CAP, async {
            let h = history.await;
            if let Some(task) = memory_task {
                let _ = task.await;
            }
            h
        })
        .await;
        let Ok(Some(json)) = joined else {
            tracing::debug!(target: LOG_TARGET, channel = %channel_id, "bootstrap missed its cap");
            return;
        };
        let mut events: Vec<Event> = json
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| serde_json::from_value::<Event>(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        events.sort_by_key(|e| e.created_at);
        let me = self.deps.keys.public_key();
        let owner = self.deps.owner;
        self.deps.ledgers.with_existing(channel_id, |l| {
            for e in &events {
                let id = e.id.to_hex();
                if id == trigger_id {
                    continue;
                }
                if Some(e.pubkey) == owner
                    && e.content.starts_with(crate::voice_turn::VOICE_TURN_MARKER)
                {
                    l.push_owner(
                        strip_voice_marker(&e.content),
                        Some(&id),
                        EntrySource::History,
                        true,
                    );
                } else if e.pubkey == me {
                    l.note_self_message(&id, None, &e.content);
                }
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive(
        &self,
        settings: &VoiceFastSettings,
        api_key: &str,
        body: &serde_json::Value,
        tap: &mpsc::UnboundedSender<SpeechTap>,
        scanner: &mut HandoffScanner,
        cancel: &mut oneshot::Receiver<()>,
        started: tokio::time::Instant,
        stream_id: &str,
    ) -> DriveOutcome {
        let deadline = started + Duration::from_millis(settings.first_token_ms);
        let base = settings.base_url.as_deref().unwrap_or_default();
        let open = FastCompletionStream::open(&self.deps.http, base, api_key, body);
        let mut stream = tokio::select! {
            r = open => match r {
                Ok(s) => s,
                Err(e) => return DriveOutcome::Failed(e.reason()),
            },
            _ = tokio::time::sleep_until(deadline) => {
                return DriveOutcome::Failed("first_token_timeout".into());
            }
            _ = &mut *cancel => return DriveOutcome::Superseded,
        };
        let mut got_text = false;
        loop {
            let next = tokio::select! {
                r = stream.next_text() => r,
                _ = tokio::time::sleep_until(deadline), if !got_text => {
                    return DriveOutcome::Failed("first_token_timeout".into());
                }
                _ = &mut *cancel => return DriveOutcome::Superseded,
            };
            match next {
                Ok(Some(text)) => {
                    if !got_text {
                        got_text = true;
                        tracing::info!(
                            target: LOG_TARGET,
                            stream_id,
                            ms = started.elapsed().as_millis() as u64,
                            "first_token"
                        );
                    }
                    let speak = scanner.push(&text);
                    if !speak.is_empty() {
                        let _ = tap.send(SpeechTap::Text(speak));
                    }
                    if scanner.is_closed() {
                        // Marker closed: nothing more will be spoken; drop
                        // the stream (aborts the request).
                        break;
                    }
                }
                Ok(None) => break,
                Err(FastClientError::Http { status }) => {
                    return DriveOutcome::Failed(format!("http_{status}"))
                }
                Err(e) => return DriveOutcome::Failed(e.reason()),
            }
        }
        DriveOutcome::Completed {
            reasoning_chars: stream.reasoning_chars,
        }
    }

    /// Answer one claimed utterance. Spawned by [`Self::try_claim`].
    pub async fn run_turn(
        self: Arc<Self>,
        settings: VoiceFastSettings,
        api_key: String,
        channel_id: Uuid,
        event: Event,
        prompt_tag: String,
        handles: TurnHandles,
    ) {
        let started = tokio::time::Instant::now();
        let trigger_id = event.id.to_hex();
        let stream_id = fast_stream_id(&trigger_id);
        let utterance = strip_voice_marker(&event.content).to_string();
        let TurnHandles {
            cancel: mut cancel_rx,
            settled: _settled,
            previous_settled,
        } = handles;
        self.deps.ledgers.sweep(std::time::Instant::now());

        self.bootstrap(channel_id, &trigger_id, settings.memory)
            .await;
        if let Some(prev) = previous_settled {
            let _ = tokio::time::timeout(SUPERSEDE_SETTLE_CAP, prev).await;
        }

        let (user_seq, history, call_state, core) =
            self.deps
                .ledgers
                .with(channel_id, std::time::Instant::now(), |l| {
                    l.expect_stream(&stream_id);
                    let seq = l.push_owner(&utterance, Some(&trigger_id), EntrySource::Fast, false);
                    let history =
                        l.history_messages(seq, settings.history_turns, settings.history_chars);
                    (
                        seq,
                        history,
                        l.call_state_line(),
                        if settings.memory {
                            l.core_memory.clone()
                        } else {
                            None
                        },
                    )
                });
        if self.deps.persona.is_none()
            && !self
                .warned_no_persona
                .swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            tracing::warn!(target: LOG_TARGET, "agent has no system prompt — fast lane runs on the rules only");
        }
        let body = build_fast_request(
            &settings,
            &FastPromptParts {
                persona: self.deps.persona.as_deref(),
                core_memory: core.as_deref(),
                history: &history,
                utterance: &utterance,
                call_state: &call_state,
            },
        );
        tracing::info!(
            target: LOG_TARGET,
            stream_id = %stream_id,
            model = %settings.model,
            history = history.len(),
            "request_start"
        );

        let gate = Arc::new(GatedSink {
            inner: self.deps.sink.clone(),
            state: Mutex::new((0, false)),
            stream_id: stream_id.clone(),
            started,
        });
        let (tap_tx, tap_rx) = mpsc::unbounded_channel();
        let stream_task = tokio::spawn(run_voice_stream(
            tap_rx,
            Some(gate.clone() as Arc<dyn SpeechSink>),
            VoiceStreamParams {
                channel_id,
                stream_id: stream_id.clone(),
                trigger_event_id: Some(trigger_id.clone()),
                trigger_created_at: Some(event.created_at.as_secs()),
                keys: self.deps.keys.clone(),
                started,
            },
        ));

        let mut scanner = HandoffScanner::new();
        let outcome = self
            .drive(
                &settings,
                &api_key,
                &body,
                &tap_tx,
                &mut scanner,
                &mut cancel_rx,
                started,
                &stream_id,
            )
            .await;
        let task = scanner.finish();

        match outcome {
            DriveOutcome::Superseded => {
                let _ = tap_tx.send(SpeechTap::Cut);
                drop(tap_tx);
                let report = stream_task.await.unwrap_or_default();
                self.deps
                    .ledgers
                    .with(channel_id, std::time::Instant::now(), |l| {
                        l.push_agent(&report.text, EntrySource::Fast, true, false);
                        l.last_reply_interrupted = true;
                    });
                tracing::info!(
                    target: LOG_TARGET,
                    stream_id = %stream_id,
                    segments = report.segments_published,
                    "superseded"
                );
                // The newer turn owns `active` now; do not clear it.
            }
            DriveOutcome::Failed(reason) => {
                if gate.close_if_unpublished() {
                    let _ = tap_tx.send(SpeechTap::Abort);
                    drop(tap_tx);
                    let _ = stream_task.await;
                    self.fall_back(channel_id, &event, &prompt_tag, user_seq, &reason);
                } else {
                    // Already speaking: finish what was generated, no
                    // fallback (it would be a second answer).
                    drop(tap_tx);
                    let report = stream_task.await.unwrap_or_default();
                    self.deps
                        .ledgers
                        .with(channel_id, std::time::Instant::now(), |l| {
                            l.push_agent(&report.text, EntrySource::Fast, true, false);
                            l.last_reply_interrupted = true;
                        });
                    tracing::warn!(
                        target: LOG_TARGET,
                        stream_id = %stream_id,
                        reason = %reason,
                        segments = report.segments_published,
                        "stream_died_after_speech — partial finalized, no fallback"
                    );
                }
                self.clear_active(channel_id, &trigger_id);
            }
            DriveOutcome::Completed { reasoning_chars } => {
                if reasoning_chars > 0 {
                    tracing::warn!(
                        target: LOG_TARGET,
                        stream_id = %stream_id,
                        chars = reasoning_chars,
                        "thinking_not_disabled"
                    );
                }
                drop(tap_tx);
                let report: StreamReport = stream_task.await.unwrap_or_default();
                self.finish_completed(
                    &settings,
                    channel_id,
                    &event,
                    &prompt_tag,
                    user_seq,
                    task,
                    report,
                    gate.published(),
                    started,
                    &stream_id,
                );
                self.clear_active(channel_id, &trigger_id);
            }
        }
    }

    fn clear_active(&self, channel_id: Uuid, trigger_id: &str) {
        let mut active = lock(&self.active);
        if active
            .get(&channel_id)
            .is_some_and(|a| a.trigger_id == trigger_id)
        {
            active.remove(&channel_id);
        }
    }

    fn fall_back(
        &self,
        channel_id: Uuid,
        event: &Event,
        prompt_tag: &str,
        user_seq: Option<u64>,
        reason: &str,
    ) {
        // The agent sees the event itself, so its line is digested.
        if let Some(seq) = user_seq {
            self.deps
                .ledgers
                .with_existing(channel_id, |l| l.mark_entry_digested(seq));
        }
        let opened = lock(&self.circuit).record_fallback(std::time::Instant::now());
        tracing::warn!(
            target: LOG_TARGET,
            event = %event.id.to_hex(),
            reason,
            "fallback"
        );
        if opened {
            tracing::warn!(target: LOG_TARGET, "circuit open — voice routes to the agent for 5 min");
        }
        self.push_to_agent(channel_id, event, prompt_tag, "fallback");
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_completed(
        self: &Arc<Self>,
        settings: &VoiceFastSettings,
        channel_id: Uuid,
        event: &Event,
        prompt_tag: &str,
        user_seq: Option<u64>,
        task: Option<String>,
        report: StreamReport,
        segments: u32,
        started: tokio::time::Instant,
        stream_id: &str,
    ) {
        let now = std::time::Instant::now();
        if let Some(task) = task {
            // R3: ack (already finalized as its own kind:9) + handoff.
            let trigger_id = event.id.to_hex();
            self.deps.ledgers.with(channel_id, now, |l| {
                if let Some(seq) = user_seq {
                    l.mark_entry_digested(seq);
                }
                // The note carries the ack; its line need not repeat.
                l.push_agent(&report.text, EntrySource::Fast, false, true);
                l.last_reply_interrupted = false;
                l.add_handoff(HandoffNote {
                    trigger_id,
                    ack: report.text.clone(),
                    task: task.clone(),
                });
            });
            lock(&self.circuit).record_success();
            tracing::info!(
                target: LOG_TARGET,
                stream_id,
                chars = report.text.chars().count(),
                task = %task,
                "handoff"
            );
            self.push_to_agent(channel_id, event, prompt_tag, "handoff");
            return;
        }
        if report.text.trim().is_empty() {
            // Nothing was spoken and nothing handed off: let the agent answer.
            self.fall_back(channel_id, event, prompt_tag, user_seq, "empty_reply");
            return;
        }
        let seq = self.deps.ledgers.with(channel_id, now, |l| {
            l.push_agent(&report.text, EntrySource::Fast, false, false);
            l.last_reply_interrupted = false;
            let seq = user_seq.unwrap_or(0);
            l.last_fast_turn_seq = seq;
            seq
        });
        lock(&self.circuit).record_success();
        tracing::info!(
            target: LOG_TARGET,
            stream_id,
            segments,
            chars = report.text.chars().count(),
            final_posted = report.final_posted,
            ms = started.elapsed().as_millis() as u64,
            "done"
        );
        if settings.digest == VoiceFastDigest::Idle {
            self.schedule_digest(channel_id, seq, settings.digest_idle_secs);
        }
    }

    fn schedule_digest(self: &Arc<Self>, channel_id: Uuid, seq: u64, idle_secs: u64) {
        let delay = self
            .deps
            .digest_delay_override
            .unwrap_or(Duration::from_secs(idle_secs));
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let due = this
                .deps
                .ledgers
                .with_existing(channel_id, |l| {
                    l.last_fast_turn_seq == seq
                        && l.has_undigested()
                        && l.agent_status == crate::voice_fast::AgentStatus::Idle
                })
                .unwrap_or(false);
            if !due || lock(&this.active).contains_key(&channel_id) {
                return;
            }
            let Ok(event) = build_digest_event(&this.deps.keys, channel_id) else {
                return;
            };
            tracing::info!(target: LOG_TARGET, channel = %channel_id, "digest");
            let _ = this
                .deps
                .to_main
                .send(VoiceFastMsg::Digest { channel_id, event });
        });
    }
}

/// The synthetic digest event: kind:9 in the call channel, signed by this
/// agent, NEVER published — it only rides the local queue so the pool gives
/// the agent one turn carrying `[Voice Fast Context]`.
pub fn build_digest_event(keys: &Keys, channel_id: Uuid) -> Result<Event, String> {
    let h = Tag::parse(["h", &channel_id.to_string()]).map_err(|e| e.to_string())?;
    EventBuilder::new(Kind::Custom(9), DIGEST_PROMPT)
        .tags([h])
        .sign_with_keys(keys)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "voice_fast_runner_tests.rs"]
mod tests;
