//! Voice fast lane: the deterministic half.
//!
//! Spec: `~/.buzz/PLANS/VOICE_FAST_PATH_2026-10-07.md` (§3 architecture,
//! §3.4 double-reply rules R1-R8, §3.5 prompt, §3.6 what the agent sees).
//!
//! When the owner's `[voice]` kind:9 arrives and the per-agent `voiceFast`
//! switch is on, the intake loop CLAIMS it ([`claim`]) instead of queueing it
//! for the full agent session. The runner (`voice_fast_runner`) answers it
//! from a direct, small-prompt streaming model call and speaks the reply
//! through the existing `run_voice_stream` publisher. A request that needs
//! tools makes the model say a short acknowledgment and emit
//! `<<handoff: task>>` ([`HandoffScanner`] keeps the marker out of speech);
//! the runner then hands the SAME event to the agent through the normal
//! queue, and the agent's prompt carries a `[Voice Fast Context]` section
//! ([`CallLedger::render_context`]).
//!
//! Everything here is pure and clock-injected so the routing rules are
//! testable without a process, a relay or a model. Logs go on target
//! `buzz_acp::voice_fast` (survives `RUST_LOG=buzz_acp=info`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::voice_turn::{VoiceFastSettings, VOICE_TURN_MARKER};

/// Tracing target for every fast-lane log line.
pub const LOG_TARGET: &str = "buzz_acp::voice_fast";

/// Stream-id prefix for fast-lane replies (`vf-` + 12 hex of the trigger id).
/// The web latency recorder keys `path: "fast"` off this prefix.
pub const FAST_STREAM_PREFIX: &str = "vf-";

/// The handoff sentinel the fast model writes when it needs the full agent.
pub const HANDOFF_MARKER: &str = "<<handoff:";

/// Closes the handoff sentinel.
pub const HANDOFF_CLOSE: &str = ">>";

/// Opens the call-state note; an echo of it is dropped up to `]`.
pub const CALL_STATE_NOTE: &str = "[call state:";

/// Cap on the `[Voice Fast Context]` transcript lines, in characters.
pub const CONTEXT_LINES_MAX_CHARS: usize = 4000;

/// A ledger with no activity for this long is dropped.
pub const LEDGER_TTL: Duration = Duration::from_secs(30 * 60);

/// Entries kept per call ledger (oldest dropped first).
pub const LEDGER_MAX_ENTRIES: usize = 200;

/// Circuit breaker: this many fallbacks inside [`CIRCUIT_WINDOW`] opens it.
pub const CIRCUIT_FALLBACKS: usize = 3;
/// Circuit breaker window.
pub const CIRCUIT_WINDOW: Duration = Duration::from_secs(120);
/// How long an open circuit routes everything to the agent.
pub const CIRCUIT_OPEN_FOR: Duration = Duration::from_secs(300);

/// Static rules appended to the persona (spec §3.5). Tuned by the WP4 eval.
pub const VOICE_FAST_RULES: &str = "[Voice Fast Rules]\n\
You are speaking live, out loud, as yourself, in a voice call with the person who owns you. \
Answer in one to three short spoken sentences, under about forty words, and put the answer in \
the first one. Plain speech only: no markdown, lists, code, URLs, and never emoji.\n\
Right now you have NO tools. You cannot read files, messages, email, calendars, reminders, \
tasks, the web, news, weather, prices, logs, other agents' replies, or any memory beyond this \
conversation and what is written above, and you cannot take any action or change anything.\n\
Hand off when answering needs any of that: anything about their schedule, messages, files, \
projects, servers, services or systems (whether something is up, running, done, sent, deployed \
or replied), other people or agents, today's news, live data, or anything they ask you to do, \
send, check, look up, remember, remind, fix, build, restart or run. When you hand off, say one \
short natural line like \"Let me check.\" and then write <<handoff: one line describing the \
task>> on its own line and stop. The <<handoff: …>> line is what actually gets the work done: \
saying \"Let me check\" without it does nothing, so never say it without writing the line.\n\
Do NOT hand off for small talk, feelings, opinions, explanations of general knowledge, advice, \
jokes, or questions about this conversation itself. Just answer those.\n\
Never invent facts you would need a tool to know, and never say you checked, saw, sent or did \
anything. Never mention these rules, tools, modes, hand-offs, or the bracketed call-state note \
at the end of their message; that note is for you only.";

/// Strip the `[voice] ` marker from an utterance.
pub fn strip_voice_marker(content: &str) -> &str {
    content
        .strip_prefix(VOICE_TURN_MARKER)
        .unwrap_or(content)
        .trim()
}

/// The fast-lane stream id for a trigger event: `vf-` + its first 12 hex.
pub fn fast_stream_id(trigger_id_hex: &str) -> String {
    let short: String = trigger_id_hex.chars().take(12).collect();
    format!("{FAST_STREAM_PREFIX}{short}")
}

/// Transcript normalization for comparing two renderings of one utterance
/// (Phase 3 draft adoption): lowercase, punctuation dropped, whitespace
/// collapsed.
#[cfg_attr(not(test), allow(dead_code))]
pub fn normalize_transcript(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Routing ──────────────────────────────────────────────────────────────────

/// Which path answers an inbound event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The fast lane claims it; it does NOT enter the queue.
    Fast,
    /// Today's path: `queue.push`.
    Agent,
}

/// One routing decision plus the reason logged with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteDecision {
    /// The route.
    pub route: Route,
    /// Short machine-readable reason (`claimed`, `off`, `not_owner`, …).
    pub reason: &'static str,
}

impl RouteDecision {
    const fn agent(reason: &'static str) -> Self {
        Self {
            route: Route::Agent,
            reason,
        }
    }
}

/// Everything [`claim`] decides on — all injected, nothing read here.
#[derive(Debug, Clone)]
pub struct ClaimInput<'a> {
    /// Event kind.
    pub kind: u32,
    /// Event content.
    pub content: &'a str,
    /// Event author, lowercase hex.
    pub author_hex: &'a str,
    /// The agent's owner, lowercase hex, if resolved.
    pub owner_hex: Option<&'a str>,
    /// The fast-lane knobs, read for this event.
    pub settings: &'a VoiceFastSettings,
    /// Whether an API key resolved.
    pub has_api_key: bool,
    /// Whether the circuit breaker is open.
    pub circuit_open: bool,
}

/// True when the event is a candidate at all: a kind:9 `[voice] ` utterance.
/// Only candidates get a `route` log line.
pub fn is_candidate(kind: u32, content: &str) -> bool {
    kind == 9 && content.starts_with(VOICE_TURN_MARKER)
}

/// The single synchronous routing decision for one inbound event (R1).
///
/// `Fast` needs every condition of spec §3.3 step 2: the switch on, kind:9,
/// a `[voice] ` prefix, the OWNER as author, an endpoint and key, and a
/// closed circuit. Anything else is `Agent` — exactly today's path.
pub fn claim(input: &ClaimInput) -> RouteDecision {
    if !is_candidate(input.kind, input.content) {
        return RouteDecision::agent("not_voice");
    }
    if !input.settings.on {
        return RouteDecision::agent("off");
    }
    match input.owner_hex {
        Some(owner) if owner.eq_ignore_ascii_case(input.author_hex) => {}
        _ => return RouteDecision::agent("not_owner"),
    }
    if input.settings.base_url.is_none() || !input.has_api_key {
        return RouteDecision::agent("no_endpoint");
    }
    if input.circuit_open {
        return RouteDecision::agent("circuit_open");
    }
    RouteDecision {
        route: Route::Fast,
        reason: "claimed",
    }
}

/// Per-agent circuit breaker (spec §6): [`CIRCUIT_FALLBACKS`] fallbacks
/// inside [`CIRCUIT_WINDOW`] route everything to the agent for
/// [`CIRCUIT_OPEN_FOR`]; after that the next event tries the fast lane
/// again (half-open), and one more fallback re-opens it.
#[derive(Debug, Default)]
pub struct CircuitBreaker {
    fallbacks: VecDeque<Instant>,
    open_until: Option<Instant>,
    half_open: bool,
}

impl CircuitBreaker {
    /// Whether the circuit routes to the agent at `now`.
    pub fn is_open(&mut self, now: Instant) -> bool {
        match self.open_until {
            Some(until) if now < until => true,
            Some(_) => {
                self.open_until = None;
                self.half_open = true;
                false
            }
            None => false,
        }
    }

    /// Record a fallback. Returns `true` when this one OPENED the circuit.
    pub fn record_fallback(&mut self, now: Instant) -> bool {
        if self.half_open {
            self.half_open = false;
            self.fallbacks.clear();
            self.open_until = Some(now + CIRCUIT_OPEN_FOR);
            return true;
        }
        self.fallbacks.push_back(now);
        while self
            .fallbacks
            .front()
            .is_some_and(|t| now.duration_since(*t) > CIRCUIT_WINDOW)
        {
            self.fallbacks.pop_front();
        }
        if self.fallbacks.len() >= CIRCUIT_FALLBACKS {
            self.fallbacks.clear();
            self.open_until = Some(now + CIRCUIT_OPEN_FOR);
            return true;
        }
        false
    }

    /// Record a successful fast turn: closes a half-open circuit.
    pub fn record_success(&mut self) {
        self.half_open = false;
        self.fallbacks.clear();
    }
}

// ── Handoff scanner ──────────────────────────────────────────────────────────

/// Streaming detector for `<<handoff: task>>`.
///
/// Text is released as soon as it cannot be the start of the marker. A run
/// that MIGHT be the marker (`<`, `<<`, `<<hand`, …) is held back until it
/// either completes the marker or diverges from it, so no chunking of the
/// stream can make a `<` or any marker text reach speech. Matching is
/// case-insensitive. Everything after the marker opens is the task, up to
/// `>>`; anything after that is dropped.
///
/// The same hold-back also drops an echoed `[call state: …]` note (the
/// dynamic tail of the user message, measured echoed back by the model in
/// the WP4 eval) so it is never spoken.
#[derive(Debug, Default)]
pub struct HandoffScanner {
    held: String,
    in_marker: bool,
    in_note: bool,
    closed: bool,
    task: String,
}

impl HandoffScanner {
    /// New scanner.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a delta; returns the text that is safe to speak now.
    pub fn push(&mut self, delta: &str) -> String {
        let mut out = String::new();
        let mut input: VecDeque<char> = delta.chars().collect();
        while let Some(ch) = input.pop_front() {
            if self.closed {
                continue;
            }
            if self.in_marker {
                self.task.push(ch);
                if self.task.ends_with(HANDOFF_CLOSE) {
                    let keep = self.task.len() - HANDOFF_CLOSE.len();
                    self.task.truncate(keep);
                    self.closed = true;
                }
                continue;
            }
            if self.in_note {
                if ch == ']' {
                    self.in_note = false;
                }
                continue;
            }
            if self.held.is_empty() && ch != '<' && ch != '[' {
                out.push(ch);
                continue;
            }
            self.held.push(ch);
            let lowered = self.held.to_lowercase();
            if HANDOFF_MARKER.starts_with(lowered.as_str()) {
                if lowered == HANDOFF_MARKER {
                    self.in_marker = true;
                    self.held.clear();
                }
                continue;
            }
            if CALL_STATE_NOTE.starts_with(lowered.as_str()) {
                if lowered == CALL_STATE_NOTE {
                    self.in_note = true;
                    self.held.clear();
                }
                continue;
            }
            // Diverged: the first held char is plain text; everything after
            // it is re-scanned (it may itself start a marker).
            let held = std::mem::take(&mut self.held);
            let mut chars = held.chars();
            if let Some(first) = chars.next() {
                out.push(first);
            }
            for (i, c) in chars.enumerate() {
                input.insert(i, c);
            }
        }
        out
    }

    /// Whether the marker has closed — nothing more will be spoken, so the
    /// caller may stop generation.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// End of stream. Returns the task when the reply handed off. A held
    /// partial marker (`<<hand` at EOF) is dropped, never spoken.
    pub fn finish(&mut self) -> Option<String> {
        self.held.clear();
        if !self.in_marker {
            return None;
        }
        let task = self.task.trim().to_string();
        Some(if task.is_empty() {
            "answer the caller's last request".to_string()
        } else {
            task
        })
    }
}

/// Phrases that make a short reply a bare "I'll go look" acknowledgment.
const ACK_PHRASES: &[&str] = &[
    "let me check",
    "let me look",
    "let me see",
    "let me find",
    "let me pull",
    "one sec",
    "one second",
    "hang on",
    "give me a sec",
    "checking now",
    "i'll check",
    "i'll look",
];

/// True for a short reply that only promises to go look ("Let me check.").
/// Measured in the WP4 eval: the model sometimes says the ack and stops
/// without the marker; on its own that is a promise nothing will keep.
pub fn is_bare_ack(text: &str) -> bool {
    let lowered = text.trim().to_lowercase().replace('’', "'");
    !lowered.is_empty()
        && lowered.split_whitespace().count() <= 8
        && ACK_PHRASES.iter().any(|p| lowered.contains(p))
}

/// The handoff task for a finished reply: the marker's task, or — when the
/// reply is only a bare acknowledgment — the utterance itself, so the
/// promise reaches the agent. A wrong guess costs one agent turn; a missed
/// one leaves the caller waiting on nothing.
pub fn resolve_handoff(spoken: &str, task: Option<String>, utterance: &str) -> Option<String> {
    if task.is_some() {
        return task;
    }
    is_bare_ack(spoken).then(|| format!("answer the caller's request: \"{}\"", utterance.trim()))
}

// ── Call ledger ──────────────────────────────────────────────────────────────

/// Who said a transcript line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    /// The owner (the caller).
    Owner,
    /// This agent — either voice.
    Agent,
}

/// Which path produced a transcript line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntrySource {
    /// Handled by the fast lane.
    Fast,
    /// Seen by (or said by) the full agent.
    Agent,
    /// Bootstrapped from channel history.
    History,
}

/// One line of the call transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptEntry {
    /// Monotonic per-ledger sequence.
    pub seq: u64,
    /// Who said it.
    pub speaker: Speaker,
    /// What was said (`[voice] ` stripped).
    pub text: String,
    /// Which path produced it.
    pub source: EntrySource,
    /// A reply that was cut off (superseded or the stream died).
    pub interrupted: bool,
    /// Whether the full agent has seen it.
    pub digested: bool,
}

/// What the full agent is doing in this call (R7).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum AgentStatus {
    /// Nothing handed off is running.
    #[default]
    Idle,
    /// A handed-off task is running.
    Working(String),
}

/// A handoff awaiting delivery in the agent's prompt (R3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffNote {
    /// The trigger event handed to the agent.
    pub trigger_id: String,
    /// What the fast voice already said.
    pub ack: String,
    /// The task line from the marker.
    pub task: String,
}

/// A rendered `[Voice Fast Context]` plus what to commit once delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedContext {
    /// The section text.
    pub text: String,
    /// Highest entry seq included; commit marks `<=` this digested.
    pub watermark: u64,
    /// Handoff notes included; commit removes them.
    pub handoff_ids: Vec<String>,
}

/// Per call channel state (spec §3.2).
#[derive(Debug)]
pub struct CallLedger {
    entries: VecDeque<TranscriptEntry>,
    next_seq: u64,
    /// Cached `[Agent Memory — core]` section (fetched once per ledger).
    pub core_memory: Option<String>,
    /// Whether channel history has been loaded.
    pub bootstrapped: bool,
    /// What the full agent is doing.
    pub agent_status: AgentStatus,
    /// Whether the last fast reply was cut off.
    pub last_reply_interrupted: bool,
    /// Last activity (TTL).
    pub last_activity: Instant,
    /// When the last fast turn ended — the digest timer's key.
    pub last_fast_turn_seq: u64,
    handoffs: Vec<HandoffNote>,
    handed: HashSet<String>,
    seen_event_ids: HashSet<String>,
    seen_stream_ids: HashSet<String>,
}

impl CallLedger {
    /// Empty ledger.
    pub fn new(now: Instant) -> Self {
        Self {
            entries: VecDeque::new(),
            next_seq: 1,
            core_memory: None,
            bootstrapped: false,
            agent_status: AgentStatus::Idle,
            last_reply_interrupted: false,
            last_activity: now,
            last_fast_turn_seq: 0,
            handoffs: Vec::new(),
            handed: HashSet::new(),
            seen_event_ids: HashSet::new(),
            seen_stream_ids: HashSet::new(),
        }
    }

    /// All entries, oldest first.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn entries(&self) -> impl Iterator<Item = &TranscriptEntry> {
        self.entries.iter()
    }

    fn push(&mut self, speaker: Speaker, text: &str, source: EntrySource, digested: bool) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries.push_back(TranscriptEntry {
            seq,
            speaker,
            text: text.trim().to_string(),
            source,
            interrupted: false,
            digested,
        });
        while self.entries.len() > LEDGER_MAX_ENTRIES {
            self.entries.pop_front();
        }
        seq
    }

    /// Record an owner utterance. `event_id` dedupes against bootstrap.
    pub fn push_owner(
        &mut self,
        text: &str,
        event_id: Option<&str>,
        source: EntrySource,
        digested: bool,
    ) -> Option<u64> {
        if let Some(id) = event_id {
            if !self.seen_event_ids.insert(id.to_string()) {
                return None;
            }
        }
        Some(self.push(Speaker::Owner, text, source, digested))
    }

    /// Record an agent line (fast reply, or the agent's own message).
    pub fn push_agent(
        &mut self,
        text: &str,
        source: EntrySource,
        interrupted: bool,
        digested: bool,
    ) -> Option<u64> {
        if text.trim().is_empty() {
            return None;
        }
        let seq = self.push(Speaker::Agent, text, source, digested);
        if let Some(entry) = self.entries.back_mut() {
            entry.interrupted = interrupted;
        }
        Some(seq)
    }

    /// Register a stream id this process publishes, so its final kind:9
    /// coming back through the relay is not recorded twice (R8).
    pub fn expect_stream(&mut self, stream_id: &str) {
        self.seen_stream_ids.insert(stream_id.to_string());
    }

    /// Mark an entry digested (the agent will see the event itself).
    pub fn mark_entry_digested(&mut self, seq: u64) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.seq == seq) {
            entry.digested = true;
        }
    }

    /// R8: one of this agent's own kind:9 messages in the call channel.
    /// Deduped by `buzz-speech` stream id and event id. Returns whether it
    /// was recorded.
    pub fn note_self_message(
        &mut self,
        event_id: &str,
        stream_id: Option<&str>,
        text: &str,
    ) -> bool {
        if let Some(stream) = stream_id {
            if !self.seen_stream_ids.insert(stream.to_string()) {
                return false;
            }
        }
        if !self.seen_event_ids.insert(event_id.to_string()) {
            return false;
        }
        self.push_agent(text, EntrySource::Agent, false, true)
            .is_some()
    }

    /// R1 exactly-once: `true` the FIRST time `event_id` is handed to the
    /// agent, `false` ever after.
    pub fn mark_handed(&mut self, event_id: &str) -> bool {
        self.handed.insert(event_id.to_string())
    }

    /// Store a handoff note for the agent's prompt and mark the agent busy.
    pub fn add_handoff(&mut self, note: HandoffNote) {
        self.agent_status = AgentStatus::Working(note.task.clone());
        self.handoffs.retain(|n| n.trigger_id != note.trigger_id);
        self.handoffs.push(note);
    }

    /// Whether any fast-only line is still unknown to the agent.
    pub fn has_undigested(&self) -> bool {
        self.entries.iter().any(|e| !e.digested)
    }

    /// The transcript for the model: the newest entries (excluding seq
    /// `exclude`), capped at `turns` pairs and `max_chars` characters,
    /// oldest first, consecutive same-speaker lines merged.
    pub fn history_messages(
        &self,
        exclude: Option<u64>,
        turns: usize,
        max_chars: usize,
    ) -> Vec<(Speaker, String)> {
        let mut picked: Vec<&TranscriptEntry> = self
            .entries
            .iter()
            .rev()
            .filter(|e| Some(e.seq) != exclude && !e.text.is_empty())
            .take(turns.saturating_mul(2))
            .collect();
        let mut total = 0usize;
        let mut keep = 0usize;
        for entry in &picked {
            let len = entry.text.chars().count();
            if total + len > max_chars {
                break;
            }
            total += len;
            keep += 1;
        }
        picked.truncate(keep);
        picked.reverse();
        let mut out: Vec<(Speaker, String)> = Vec::new();
        for entry in picked {
            let mut text = entry.text.clone();
            if entry.interrupted {
                text.push_str(" (cut off)");
            }
            match out.last_mut() {
                Some((speaker, prev)) if *speaker == entry.speaker => {
                    prev.push('\n');
                    prev.push_str(&text);
                }
                _ => out.push((entry.speaker, text)),
            }
        }
        // The chat API wants a user turn first.
        while out.first().is_some_and(|(s, _)| *s == Speaker::Agent) {
            out.remove(0);
        }
        out
    }

    /// The trailing call-state line for the newest user message (R7).
    pub fn call_state_line(&self) -> String {
        let mut parts = Vec::new();
        match &self.agent_status {
            AgentStatus::Idle => parts.push("agent idle".to_string()),
            AgentStatus::Working(task) => parts.push(format!("agent working on: {task}")),
        }
        if self.last_reply_interrupted {
            parts.push("last reply interrupted".to_string());
        }
        format!("[call state: {}]", parts.join("; "))
    }

    /// Render `[Voice Fast Context]` for an agent turn whose batch carries
    /// `trigger_ids` (spec §3.6). `None` when there is nothing to say.
    /// Rendering does NOT consume: call [`Self::commit_context`] once the
    /// turn that carried it succeeded.
    pub fn render_context(&self, trigger_ids: &[String]) -> Option<RenderedContext> {
        let undigested: Vec<&TranscriptEntry> =
            self.entries.iter().filter(|e| !e.digested).collect();
        let notes: Vec<&HandoffNote> = self
            .handoffs
            .iter()
            .filter(|n| trigger_ids.contains(&n.trigger_id))
            .collect();
        if undigested.is_empty() && notes.is_empty() {
            return None;
        }
        let watermark = undigested.iter().map(|e| e.seq).max().unwrap_or(0);
        let mut lines: Vec<String> = undigested
            .iter()
            .map(|e| {
                let who = match e.speaker {
                    Speaker::Owner => "Caller",
                    Speaker::Agent => "You",
                };
                let cut = if e.interrupted { " (cut off)" } else { "" };
                format!("  {who}: {}{cut}", e.text)
            })
            .collect();
        let mut omitted = false;
        while lines.iter().map(|l| l.chars().count() + 1).sum::<usize>() > CONTEXT_LINES_MAX_CHARS
            && !lines.is_empty()
        {
            lines.remove(0);
            omitted = true;
        }
        let mut text = String::from("[Voice Fast Context]\n");
        if lines.is_empty() && !omitted {
            text.push_str("Your fast voice is answering the caller in this call as you.\n");
        } else {
            text.push_str(
                "Your fast voice has been talking with the caller in this call as you; \
                 these lines were spoken in your voice:\n",
            );
            if omitted {
                text.push_str("  (earlier lines omitted)\n");
            }
            for line in &lines {
                text.push_str(line);
                text.push('\n');
            }
        }
        for note in &notes {
            if note.ack.trim().is_empty() {
                text.push_str(&format!(
                    "For the newest message it said nothing and handed you: {}.\nDo that now.\n",
                    note.task
                ));
            } else {
                text.push_str(&format!(
                    "For the newest message it already said: \"{}\" and handed you: {}.\n\
                     Do that now. Your reply is spoken right after the acknowledgment, so don't repeat it.\n",
                    note.ack.trim(),
                    note.task
                ));
            }
        }
        Some(RenderedContext {
            text: text.trim_end().to_string(),
            watermark,
            handoff_ids: notes.iter().map(|n| n.trigger_id.clone()).collect(),
        })
    }

    /// Commit a delivered context: lines `<= watermark` become digested
    /// and the delivered handoff notes are dropped.
    pub fn commit_context(&mut self, watermark: u64, handoff_ids: &[String]) {
        for entry in self.entries.iter_mut().filter(|e| e.seq <= watermark) {
            entry.digested = true;
        }
        self.handoffs
            .retain(|n| !handoff_ids.contains(&n.trigger_id));
    }
}

/// All call ledgers of one agent, shared between the intake loop, the fast
/// runner and the pool. A plain mutex: every critical section is short and
/// never awaits.
#[derive(Debug, Default)]
pub struct VoiceFastLedgers {
    inner: Mutex<HashMap<Uuid, CallLedger>>,
}

impl VoiceFastLedgers {
    /// Empty set.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, CallLedger>> {
        // A poisoned lock only means another thread panicked mid-update; the
        // data is still a valid map, so keep going rather than wedge voice.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Run `f` on the channel's ledger, creating it if needed.
    pub fn with<R>(&self, cid: Uuid, now: Instant, f: impl FnOnce(&mut CallLedger) -> R) -> R {
        let mut map = self.lock();
        let ledger = map.entry(cid).or_insert_with(|| CallLedger::new(now));
        ledger.last_activity = now;
        f(ledger)
    }

    /// Run `f` on the channel's ledger only if one exists.
    pub fn with_existing<R>(&self, cid: Uuid, f: impl FnOnce(&mut CallLedger) -> R) -> Option<R> {
        self.lock().get_mut(&cid).map(f)
    }

    /// Whether the channel has a ledger.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn contains(&self, cid: Uuid) -> bool {
        self.lock().contains_key(&cid)
    }

    /// Drop ledgers idle longer than [`LEDGER_TTL`].
    pub fn sweep(&self, now: Instant) {
        self.lock()
            .retain(|_, l| now.duration_since(l.last_activity) < LEDGER_TTL);
    }

    /// [`CallLedger::render_context`] for a channel, if it has a ledger.
    pub fn render_context(&self, cid: Uuid, trigger_ids: &[String]) -> Option<RenderedContext> {
        self.lock()
            .get(&cid)
            .and_then(|l| l.render_context(trigger_ids))
    }

    /// [`CallLedger::commit_context`] for a channel.
    pub fn commit_context(&self, cid: Uuid, rendered: &RenderedContext) {
        if let Some(l) = self.lock().get_mut(&cid) {
            l.commit_context(rendered.watermark, &rendered.handoff_ids);
        }
    }

    /// An agent turn in `cid` ended: the handed-off task is no longer
    /// running.
    pub fn note_agent_turn_end(&self, cid: Uuid) {
        if let Some(l) = self.lock().get_mut(&cid) {
            l.agent_status = AgentStatus::Idle;
        }
    }
}

// ── Request ──────────────────────────────────────────────────────────────────

/// The pieces of one fast-lane prompt.
#[derive(Debug, Clone)]
pub struct FastPromptParts<'a> {
    /// The agent's persona (`config.system_prompt`), verbatim.
    pub persona: Option<&'a str>,
    /// The cached `[Agent Memory — core]` section.
    pub core_memory: Option<&'a str>,
    /// Transcript, oldest first, excluding the current utterance.
    pub history: &'a [(Speaker, String)],
    /// The current utterance, marker stripped.
    pub utterance: &'a str,
    /// The `[call state: …]` line.
    pub call_state: &'a str,
}

/// The system message: persona, core memory, rules — stable prefix first so
/// the provider's prefix cache holds across turns (spec §3.5).
pub fn fast_system_prompt(persona: Option<&str>, core_memory: Option<&str>) -> String {
    [persona, core_memory, Some(VOICE_FAST_RULES)]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Build the OpenAI-compatible `/v1/chat/completions` body.
pub fn build_fast_request(
    settings: &VoiceFastSettings,
    parts: &FastPromptParts,
) -> serde_json::Value {
    let mut messages = vec![serde_json::json!({
        "role": "system",
        "content": fast_system_prompt(parts.persona, parts.core_memory),
    })];
    for (speaker, text) in parts.history {
        let role = match speaker {
            Speaker::Owner => "user",
            Speaker::Agent => "assistant",
        };
        messages.push(serde_json::json!({ "role": role, "content": text }));
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": format!("{}\n\n{}", parts.utterance, parts.call_state),
    }));
    let mut body = serde_json::json!({
        "model": settings.model,
        "stream": true,
        "max_tokens": settings.max_tokens,
        "messages": messages,
    });
    if let Some(reasoning) = settings.reasoning.as_deref() {
        body["reasoning_effort"] = serde_json::Value::String(reasoning.to_string());
    }
    body
}

/// Whether a `[Agent Memory — core]` section is worth sending to the fast
/// model: the onboarding nudge (no core yet) is not.
pub fn usable_core_section(section: &str) -> bool {
    !section.contains(crate::engram_fetch::ONBOARDING_NUDGE)
}

#[cfg(test)]
#[path = "voice_fast_tests.rs"]
mod tests;
