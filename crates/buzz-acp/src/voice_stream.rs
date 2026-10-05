//! Streamed spoken replies for `[voice]` turns.
//!
//! Spec: `~/.buzz/PLANS/VOICE_STREAMED_REPLIES_2026-10-04.md` (§3.3 wire
//! format, §3.4 harness design, §3.6 behaviour matrix).
//!
//! On a `[voice]` turn with the `voiceStream` switch on, the agent answers in
//! plain assistant text instead of `buzz messages send`. The ACP client taps
//! `agent_message_chunk` updates (see `AcpClient::set_speech_tap`) and feeds
//! them here as [`SpeechTap`] messages. [`run_voice_stream`] cuts the text
//! into sentences as tokens arrive ([`SentenceSegmenter`]) and publishes each
//! as an ephemeral kind:24820 segment, so a voice client can start speaking
//! after the FIRST sentence instead of after the whole reply. When the turn
//! ends (the tap sender is dropped) it publishes a `done` segment and then
//! ONE ordinary kind:9 carrying the full text, tagged with the stream id —
//! the fallback every other client speaks exactly as today.
//!
//! Layout follows `voice_turn.rs`: the segmenter is pure and deterministic
//! (independent of how the text was chunked), and the impure half — signing,
//! pacing, publishing — sits behind the [`SpeechSink`] seam so tests run it
//! with an in-memory sink and a paused clock.
//!
//! Logs go on target `buzz_acp::voice_stream`: desktop-spawned harnesses run
//! `RUST_LOG=buzz_acp=info`, which filters out every target not prefixed
//! `buzz_acp`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tokio::sync::mpsc;
use uuid::Uuid;

/// Tracing target for every streamed-voice log line.
pub const LOG_TARGET: &str = "buzz_acp::voice_stream";

/// Later segments shorter than this (trimmed chars) carry forward into the
/// next one. Matches the web player's `BRIDGE_MIN_FRAGMENT_CHARS`.
pub const MIN_LATER_SEGMENT_CHARS: usize = 20;

/// A run longer than this without a sentence boundary is split at its last
/// space (or hard at this many chars when it has none).
pub const MAX_SEGMENT_CHARS: usize = 200;

/// Inserted into the canonical text at a tool-call boundary.
pub const TOOL_BOUNDARY_SEPARATOR: &str = "\n\n";

/// Minimum spacing between segment publishes after the first.
pub const MIN_PUBLISH_GAP: Duration = Duration::from_millis(250);

/// Hard cap on kind:24820 events per turn, the `done` segment included.
/// Past it, pending sentences coalesce into the `done` segment.
pub const MAX_EVENTS_PER_TURN: u32 = 40;

/// Backoff between attempts to post the final kind:9 (1 attempt + 3 retries).
pub const FINAL_RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

/// The tag name shared by segments and the final message.
pub const SPEECH_TAG: &str = "buzz-speech";

/// The kind:9 builder caps content at 64 KiB.
const FINAL_CONTENT_MAX_BYTES: usize = 64 * 1024;

/// One message from the ACP speech tap.
#[derive(Debug, Clone, PartialEq)]
pub enum SpeechTap {
    /// A streamed `agent_message_chunk` text delta.
    Text(String),
    /// A `tool_call` started: flush the partial sentence and separate.
    ToolBoundary {
        /// The update's `rawInput`, when it carried one.
        raw_input: Option<serde_json::Value>,
    },
    /// A `tool_call_update` carrying the tool's (now complete) `rawInput`.
    /// Streaming adapters emit the `tool_call` with an empty input and send
    /// the real one here, so the CLI-send duplicate guard needs both.
    ToolInput {
        /// The update's `rawInput`.
        raw_input: serde_json::Value,
    },
}

/// A sentence-sized slice of the reply's canonical text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// UTF-16 code-unit offset of `text` in the final text (what JS
    /// `String.slice` indexes by).
    pub offset: usize,
    /// The exact slice: segments tile the final text with no gaps.
    pub text: String,
}

/// UTF-16 length of `s` — the unit of every offset on the wire.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_terminal_punct(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…')
}

/// Closing quotes/brackets allowed between terminal punctuation and the
/// whitespace that confirms the boundary (`He said "no."  Then…`).
fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | ')' | ']' | '”' | '’' | '»')
}

/// Splits streamed text into speakable sentences.
///
/// Rules (spec §3.4.2):
/// - a boundary is terminal punctuation (`.!?…`, optionally followed by
///   closing quotes/brackets) followed by whitespace, or a newline;
/// - the FIRST segment goes out at its first boundary regardless of length —
///   this is the whole latency win;
/// - later segments must be at least [`MIN_LATER_SEGMENT_CHARS`] or they
///   carry forward to the next boundary;
/// - more than [`MAX_SEGMENT_CHARS`] without a boundary splits at the last
///   space;
/// - a tool boundary flushes the partial sentence and inserts
///   [`TOOL_BOUNDARY_SEPARATOR`].
///
/// The whitespace that follows a boundary leads the NEXT segment, leading
/// whitespace before the first text and trailing whitespace at a flush are
/// dropped, so the concatenation of every emitted segment is exactly
/// [`Self::text`]. Decisions depend only on the characters seen, never on
/// how they were chunked.
#[derive(Debug, Default)]
pub struct SentenceSegmenter {
    /// Text not yet emitted; the current segment starts at byte 0.
    buf: String,
    /// Byte index in `buf` of the next char to examine.
    scan: usize,
    /// The canonical text emitted so far (concatenation of segments).
    emitted: String,
    /// `utf16_len(emitted)`.
    emitted_utf16: usize,
    /// A tool boundary passed after emitted text: the separator goes in
    /// front of the next non-whitespace text.
    pending_separator: bool,
}

impl SentenceSegmenter {
    /// New, empty segmenter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a text delta; returns the segments it completed.
    pub fn push(&mut self, delta: &str) -> Vec<Segment> {
        for ch in delta.chars() {
            if self.buf.is_empty()
                && ch.is_whitespace()
                && (self.emitted.is_empty() || self.pending_separator)
            {
                continue;
            }
            if self.pending_separator {
                self.pending_separator = false;
                self.buf.push_str(TOOL_BOUNDARY_SEPARATOR);
            }
            self.buf.push(ch);
        }
        let mut out = Vec::new();
        self.scan_into(&mut out);
        out
    }

    /// A tool call started: flush the partial sentence (any length) and
    /// separate what follows with [`TOOL_BOUNDARY_SEPARATOR`].
    pub fn boundary(&mut self) -> Vec<Segment> {
        let mut out = Vec::new();
        self.flush_into(&mut out);
        if !self.emitted.is_empty() {
            self.pending_separator = true;
        }
        out
    }

    /// The turn ended: flush whatever remains.
    pub fn finish(&mut self) -> Vec<Segment> {
        let mut out = Vec::new();
        self.flush_into(&mut out);
        self.pending_separator = false;
        out
    }

    /// The canonical text emitted so far — after [`Self::finish`], the
    /// final reply text.
    pub fn text(&self) -> &str {
        &self.emitted
    }

    /// `utf16_len(self.text())`.
    pub fn text_utf16_len(&self) -> usize {
        self.emitted_utf16
    }

    fn accepts(&self, candidate: &str) -> bool {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return false;
        }
        self.emitted.is_empty() || trimmed.chars().count() >= MIN_LATER_SEGMENT_CHARS
    }

    fn emit(&mut self, text: String, out: &mut Vec<Segment>) {
        let offset = self.emitted_utf16;
        self.emitted_utf16 += utf16_len(&text);
        self.emitted.push_str(&text);
        out.push(Segment { offset, text });
    }

    fn split_at(&mut self, at: usize, out: &mut Vec<Segment>) {
        let rest = self.buf.split_off(at);
        let seg = std::mem::replace(&mut self.buf, rest);
        self.scan = 0;
        self.emit(seg, out);
    }

    fn flush_into(&mut self, out: &mut Vec<Segment>) {
        let text = self.buf.trim_end().to_string();
        self.buf.clear();
        self.scan = 0;
        if !text.trim().is_empty() {
            self.emit(text, out);
        }
    }

    /// Walk `buf` from `scan`, splitting at every accepted boundary. Stops
    /// (leaving `scan` on the char) when a boundary decision needs a char
    /// that has not arrived yet.
    fn scan_into(&mut self, out: &mut Vec<Segment>) {
        'restart: loop {
            let mut i = self.scan;
            while i < self.buf.len() {
                let ch = self.buf[i..].chars().next().expect("char at index");
                // Cap: the segment already holds MAX chars and this char
                // would exceed it.
                if self.buf[..i].chars().count() >= MAX_SEGMENT_CHARS {
                    let window = &self.buf[..i + ch.len_utf8()];
                    let split = window
                        .char_indices()
                        .rev()
                        .find(|(pos, c)| {
                            *pos > 0 && c.is_whitespace() && !window[..*pos].trim().is_empty()
                        })
                        .map(|(pos, _)| pos)
                        .unwrap_or(i);
                    self.split_at(split, out);
                    continue 'restart;
                }
                if ch == '\n' {
                    if self.accepts(&self.buf[..i]) {
                        self.split_at(i, out);
                        continue 'restart;
                    }
                } else if is_terminal_punct(ch) {
                    let mut j = i + ch.len_utf8();
                    loop {
                        match self.buf[j..].chars().next() {
                            None => {
                                // Need the next char to decide.
                                self.scan = i;
                                return;
                            }
                            Some(c) if is_closer(c) => j += c.len_utf8(),
                            Some(c) if c.is_whitespace() => {
                                if self.accepts(&self.buf[..j]) {
                                    self.split_at(j, out);
                                    continue 'restart;
                                }
                                break;
                            }
                            Some(_) => break,
                        }
                    }
                }
                i += ch.len_utf8();
            }
            self.scan = self.buf.len();
            return;
        }
    }
}

/// True when a tool's raw input is a `buzz messages send` into THIS channel
/// (or into an unnamed one — a send that names no channel UUID at all is
/// assumed to be this one, the conservative reading for the duplicate
/// guard). A send that names only other channel UUIDs is not a duplicate.
pub fn is_cli_send_to_channel(raw_input: &serde_json::Value, channel_id: Uuid) -> bool {
    let text = match raw_input.get("command").and_then(|c| c.as_str()) {
        Some(command) => command.to_string(),
        None => raw_input.to_string(),
    };
    let is_send = text.contains("buzz messages send") || text.contains("buzz-cli messages send");
    if !is_send {
        return false;
    }
    let uuids = uuids_in(&text);
    uuids.is_empty() || uuids.contains(&channel_id)
}

/// Every hyphenated UUID appearing in `text`.
fn uuids_in(text: &str) -> Vec<Uuid> {
    const LEN: usize = 36;
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i + LEN <= bytes.len() {
        if text.is_char_boundary(i) && text.is_char_boundary(i + LEN) {
            if let Ok(id) = Uuid::try_parse(&text[i..i + LEN]) {
                if text.as_bytes()[i + 8] == b'-' {
                    found.push(id);
                    i += LEN;
                    continue;
                }
            }
        }
        i += 1;
    }
    found
}

/// Boxed future returned by [`SpeechSink`] methods.
pub type SinkFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Where a streamed reply goes. Production: segments over the relay
/// WebSocket (HTTP `POST /events` rejects ephemeral kinds), the final over
/// HTTP `POST /events` — the same acknowledged path the CLI's send uses, so
/// a failure is visible and retryable.
pub trait SpeechSink: Send + Sync {
    /// Publish one signed kind:24820 segment.
    fn publish_segment(&self, event: Event) -> SinkFuture<'_>;
    /// Post the signed final kind:9.
    fn post_final(&self, event: Event) -> SinkFuture<'_>;
}

/// The production [`SpeechSink`].
pub struct RelaySpeechSink {
    ws: crate::relay::RelayEventPublisher,
    rest: crate::relay::RestClient,
}

impl RelaySpeechSink {
    /// Segments over `ws`, the final over `rest`.
    pub fn new(ws: crate::relay::RelayEventPublisher, rest: crate::relay::RestClient) -> Self {
        Self { ws, rest }
    }
}

impl SpeechSink for RelaySpeechSink {
    fn publish_segment(&self, event: Event) -> SinkFuture<'_> {
        Box::pin(async move {
            self.ws
                .publish_event(event)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn post_final(&self, event: Event) -> SinkFuture<'_> {
        Box::pin(async move {
            let response = self
                .rest
                .submit_event(&event)
                .await
                .map_err(|e| e.to_string())?;
            if response.get("accepted").and_then(|v| v.as_bool()) == Some(false) {
                return Err(format!("relay did not accept the final: {response}"));
            }
            Ok(())
        })
    }
}

/// Per-turn identity of a stream.
#[derive(Debug, Clone)]
pub struct VoiceStreamParams {
    /// The call channel.
    pub channel_id: Uuid,
    /// The pool's `turn_id`.
    pub stream_id: String,
    /// The `[voice]` event this turn answers (for the `e` tag and logs).
    pub trigger_event_id: Option<String>,
    /// Its `created_at` (unix seconds), for latency logs.
    pub trigger_created_at: Option<u64>,
    /// The agent's signing keys.
    pub keys: Keys,
    /// Turn start — the zero for every `+ms` in the logs.
    pub started: tokio::time::Instant,
}

/// What a finished stream did (returned for tests and logs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamReport {
    /// kind:24820 events handed to the sink (done segment included).
    pub segments_published: u32,
    /// Whether the final kind:9 was posted successfully.
    pub final_posted: bool,
    /// Whether a `buzz messages send` into this channel was seen.
    pub cli_send_detected: bool,
    /// The canonical reply text.
    pub text: String,
}

fn ms_since(started: tokio::time::Instant) -> u128 {
    started.elapsed().as_millis()
}

fn tag(parts: &[&str]) -> Result<Tag, String> {
    Tag::parse(parts.iter().copied()).map_err(|e| e.to_string())
}

/// Build and sign one kind:24820 segment.
pub fn build_segment_event(
    params: &VoiceStreamParams,
    seq: u32,
    offset: usize,
    text: &str,
    done_total: Option<usize>,
) -> Result<Event, String> {
    let mut tags = vec![
        tag(&["h", &params.channel_id.to_string()])?,
        tag(&[
            SPEECH_TAG,
            &params.stream_id,
            &seq.to_string(),
            &offset.to_string(),
        ])?,
    ];
    if let Some(trigger) = params.trigger_event_id.as_deref() {
        tags.push(tag(&["e", trigger, "", "reply"])?);
    }
    if let Some(total) = done_total {
        tags.push(tag(&["done", &total.to_string()])?);
    }
    EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_AGENT_SPEECH_SEGMENT as u16),
        text,
    )
    .tags(tags)
    .sign_with_keys(&params.keys)
    .map_err(|e| e.to_string())
}

/// Build and sign the final kind:9 (same builder the CLI uses), tagged
/// `["buzz-speech", <stream_id>, <segments>, <total_chars>]`.
pub fn build_final_event(
    params: &VoiceStreamParams,
    text: &str,
    segments: u32,
) -> Result<Event, String> {
    let content = truncate_to_bytes(text, FINAL_CONTENT_MAX_BYTES);
    let total = utf16_len(content);
    buzz_sdk::build_message(params.channel_id, content, None, &[], false, &[])
        .map_err(|e| e.to_string())?
        .tags([tag(&[
            SPEECH_TAG,
            &params.stream_id,
            &segments.to_string(),
            &total.to_string(),
        ])?])
        .sign_with_keys(&params.keys)
        .map_err(|e| e.to_string())
}

fn truncate_to_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Paces and publishes one stream's segments.
struct Publisher<'a> {
    sink: &'a dyn SpeechSink,
    params: &'a VoiceStreamParams,
    /// Segments cut but not yet published (coalesced on publish).
    pending: Vec<Segment>,
    /// Events handed to the sink so far (= next seq).
    published: u32,
    /// Earliest instant the next non-first segment may go out.
    next_allowed: tokio::time::Instant,
}

impl Publisher<'_> {
    /// Whether a content segment may be published at `now`. The last slot
    /// under the cap is reserved for the `done` segment.
    fn may_publish(&self, now: tokio::time::Instant) -> bool {
        !self.pending.is_empty()
            && self.published + 1 < MAX_EVENTS_PER_TURN
            && (self.published == 0 || now >= self.next_allowed)
    }

    fn take_pending(&mut self, fallback_offset: usize) -> (usize, String) {
        let offset = self
            .pending
            .first()
            .map(|s| s.offset)
            .unwrap_or(fallback_offset);
        let text: String = self.pending.drain(..).map(|s| s.text).collect();
        (offset, text)
    }

    async fn publish(&mut self, offset: usize, text: &str, done_total: Option<usize>) {
        let seq = self.published;
        self.published += 1;
        self.next_allowed = tokio::time::Instant::now() + MIN_PUBLISH_GAP;
        let chars = text.chars().count();
        let result = match build_segment_event(self.params, seq, offset, text, done_total) {
            Ok(event) => self.sink.publish_segment(event).await,
            Err(e) => Err(format!("build: {e}")),
        };
        match result {
            Ok(()) if seq == 0 => tracing::info!(
                target: LOG_TARGET,
                stream_id = %self.params.stream_id,
                seq,
                chars,
                done = done_total.is_some(),
                ms = ms_since(self.params.started) as u64,
                "segment_published"
            ),
            Ok(()) => tracing::debug!(
                target: LOG_TARGET,
                stream_id = %self.params.stream_id,
                seq,
                chars,
                done = done_total.is_some(),
                ms = ms_since(self.params.started) as u64,
                "segment_published"
            ),
            Err(error) => tracing::warn!(
                target: LOG_TARGET,
                stream_id = %self.params.stream_id,
                seq,
                error = %error,
                "publish_failed"
            ),
        }
    }

    async fn publish_pending(&mut self, fallback_offset: usize) {
        let (offset, text) = self.take_pending(fallback_offset);
        self.publish(offset, &text, None).await;
    }
}

/// Run one turn's stream until the tap sender is dropped.
///
/// `sink = None` is measure-only: a `[voice]` turn with streaming OFF still
/// logs `turn_start`/`first_chunk` (the baseline for the latency gain) and
/// publishes nothing.
///
/// With a sink: segment 0 goes out the moment it is cut; later segments are
/// spaced at least [`MIN_PUBLISH_GAP`] apart, coalescing whatever piled up,
/// and capped at [`MAX_EVENTS_PER_TURN`]. At turn end it publishes the `done`
/// segment (carrying any unpublished tail) and then the final kind:9 —
/// unless the agent sent its reply through the CLI into this channel, in
/// which case the final is skipped so history does not hold it twice. An
/// empty reply (the agent used only the CLI, or said nothing) publishes
/// nothing at all: the turn behaves exactly as it does today.
pub async fn run_voice_stream(
    mut rx: mpsc::UnboundedReceiver<SpeechTap>,
    sink: Option<Arc<dyn SpeechSink>>,
    params: VoiceStreamParams,
) -> StreamReport {
    tracing::info!(
        target: LOG_TARGET,
        stream_id = %params.stream_id,
        channel = %params.channel_id,
        trigger_event_id = params.trigger_event_id.as_deref().unwrap_or(""),
        trigger_created_at = params.trigger_created_at.unwrap_or(0),
        mode = if sink.is_some() { "stream" } else { "measure" },
        "turn_start"
    );
    let mut first_chunk_logged = false;
    let mut log_first_chunk = |text: &str| {
        if !first_chunk_logged && !text.trim().is_empty() {
            first_chunk_logged = true;
            tracing::info!(
                target: LOG_TARGET,
                stream_id = %params.stream_id,
                ms = ms_since(params.started) as u64,
                "first_chunk"
            );
        }
    };

    let Some(sink) = sink else {
        // Measure-only: drain until the turn ends.
        let mut report = StreamReport::default();
        while let Some(msg) = rx.recv().await {
            match msg {
                SpeechTap::Text(text) => log_first_chunk(&text),
                SpeechTap::ToolBoundary {
                    raw_input: Some(raw),
                }
                | SpeechTap::ToolInput { raw_input: raw } => {
                    if is_cli_send_to_channel(&raw, params.channel_id) {
                        report.cli_send_detected = true;
                    }
                }
                SpeechTap::ToolBoundary { raw_input: None } => {}
            }
        }
        return report;
    };

    let mut segmenter = SentenceSegmenter::new();
    let mut cli_send_detected = false;
    let mut publisher = Publisher {
        sink: sink.as_ref(),
        params: &params,
        pending: Vec::new(),
        published: 0,
        // Only segment 0 may beat the first gap — via the explicit
        // `published == 0` exemption in `may_publish`, the single rule that
        // keeps the first sentence immediate.
        next_allowed: tokio::time::Instant::now() + MIN_PUBLISH_GAP,
    };

    let note_cli_send = |raw: &serde_json::Value, detected: &mut bool| {
        if !*detected && is_cli_send_to_channel(raw, params.channel_id) {
            *detected = true;
            tracing::info!(
                target: LOG_TARGET,
                stream_id = %params.stream_id,
                "cli_send_detected"
            );
        }
    };

    loop {
        let wait_until = publisher.next_allowed;
        let pacer_armed = !publisher.pending.is_empty()
            && publisher.published > 0
            && publisher.published + 1 < MAX_EVENTS_PER_TURN;
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(SpeechTap::Text(text)) => {
                    log_first_chunk(&text);
                    publisher.pending.extend(segmenter.push(&text));
                }
                Some(SpeechTap::ToolBoundary { raw_input }) => {
                    if let Some(raw) = raw_input.as_ref() {
                        note_cli_send(raw, &mut cli_send_detected);
                    }
                    publisher.pending.extend(segmenter.boundary());
                }
                Some(SpeechTap::ToolInput { raw_input }) => {
                    note_cli_send(&raw_input, &mut cli_send_detected);
                }
                None => break,
            },
            _ = tokio::time::sleep_until(wait_until), if pacer_armed => {}
        }
        if publisher.may_publish(tokio::time::Instant::now()) {
            publisher.publish_pending(segmenter.text_utf16_len()).await;
        }
    }

    publisher.pending.extend(segmenter.finish());
    let text = segmenter.text().to_string();
    let mut report = StreamReport {
        cli_send_detected,
        text: text.clone(),
        ..StreamReport::default()
    };
    if text.is_empty() {
        tracing::info!(
            target: LOG_TARGET,
            stream_id = %params.stream_id,
            cli_send_detected,
            "no_text — nothing streamed, turn behaves as today"
        );
        return report;
    }

    let total = segmenter.text_utf16_len();
    let (offset, tail) = publisher.take_pending(total);
    publisher.publish(offset, &tail, Some(total)).await;
    report.segments_published = publisher.published;

    if cli_send_detected {
        tracing::info!(
            target: LOG_TARGET,
            stream_id = %params.stream_id,
            "final_skipped — the agent sent its reply through the CLI"
        );
        return report;
    }

    let final_event = match build_final_event(&params, &text, publisher.published) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(
                target: LOG_TARGET,
                stream_id = %params.stream_id,
                error = %error,
                "publish_failed — could not build the final message"
            );
            return report;
        }
    };
    let mut attempt = 0usize;
    loop {
        match sink.post_final(final_event.clone()).await {
            Ok(()) => {
                report.final_posted = true;
                tracing::info!(
                    target: LOG_TARGET,
                    stream_id = %params.stream_id,
                    segments = publisher.published,
                    chars = text.chars().count(),
                    ms = ms_since(params.started) as u64,
                    "final_posted"
                );
                break;
            }
            Err(error) => {
                tracing::warn!(
                    target: LOG_TARGET,
                    stream_id = %params.stream_id,
                    attempt = attempt + 1,
                    error = %error,
                    "publish_failed — final message"
                );
                let Some(delay) = FINAL_RETRY_BACKOFF.get(attempt) else {
                    break;
                };
                attempt += 1;
                tokio::time::sleep(*delay).await;
            }
        }
    }
    report
}

#[cfg(test)]
#[path = "voice_stream_tests.rs"]
mod tests;
