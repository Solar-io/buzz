//! Tests for `voice_stream` (spec §5 rows 1 and 3).
//!
//! Expected strings are hardcoded, never derived from the module's constants.

use super::*;
use std::sync::Mutex;

// ── segmenter ──────────────────────────────────────────────────────────────

/// Feed `text` one char at a time; return every segment in order.
fn feed_chars(seg: &mut SentenceSegmenter, text: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        out.extend(seg.push(ch.encode_utf8(&mut buf)));
    }
    out
}

fn texts(segments: &[Segment]) -> Vec<String> {
    segments.iter().map(|s| s.text.clone()).collect()
}

fn trimmed(segments: &[Segment]) -> Vec<String> {
    segments.iter().map(|s| s.text.trim().to_string()).collect()
}

fn concat(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect()
}

#[test]
fn first_segment_is_emitted_at_its_first_boundary_regardless_of_length() {
    let mut seg = SentenceSegmenter::new();
    assert!(seg.push("Sure").is_empty());
    // The period alone cannot decide ("3.5"); the following space does.
    assert!(seg.push(".").is_empty());
    let first = seg.push(" ");
    assert_eq!(texts(&first), vec!["Sure.".to_string()]);
    assert_eq!(first[0].offset, 0);
}

#[test]
fn token_by_token_feed_yields_sure_then_the_answer() {
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, "Sure. It's 72 degrees in Austin right now.");
    all.extend(seg.finish());
    assert_eq!(
        trimmed(&all),
        vec![
            "Sure.".to_string(),
            "It's 72 degrees in Austin right now.".to_string()
        ]
    );
    assert_eq!(
        texts(&all),
        vec![
            "Sure.".to_string(),
            " It's 72 degrees in Austin right now.".to_string()
        ]
    );
    assert_eq!(seg.text(), "Sure. It's 72 degrees in Austin right now.");
    assert_eq!(concat(&all), seg.text());
}

#[test]
fn decimal_point_is_not_a_boundary() {
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, "It is 3.5 degrees warmer than yesterday");
    assert!(all.is_empty(), "no boundary yet: {all:?}");
    all.extend(seg.finish());
    assert_eq!(
        texts(&all),
        vec!["It is 3.5 degrees warmer than yesterday".to_string()]
    );
}

#[test]
fn later_short_sentences_carry_forward_to_twenty_chars() {
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, "Sure. Yes. It is raining in Austin. Ok. Bye.");
    all.extend(seg.finish());
    assert_eq!(
        texts(&all),
        vec![
            "Sure.".to_string(),
            " Yes. It is raining in Austin.".to_string(),
            " Ok. Bye.".to_string(),
        ]
    );
}

#[test]
fn newline_is_a_boundary() {
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(
        &mut seg,
        "Here you go\nthe forecast says rain all afternoon",
    );
    all.extend(seg.finish());
    assert_eq!(
        texts(&all),
        vec![
            "Here you go".to_string(),
            "\nthe forecast says rain all afternoon".to_string()
        ]
    );
}

#[test]
fn closing_quote_after_punctuation_still_splits() {
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, "She said \"no.\" Then she left the room quietly.");
    all.extend(seg.finish());
    assert_eq!(
        texts(&all),
        vec![
            "She said \"no.\"".to_string(),
            " Then she left the room quietly.".to_string()
        ]
    );
}

#[test]
fn tool_boundary_flushes_unpunctuated_partial_and_separates() {
    let mut seg = SentenceSegmenter::new();
    assert!(seg.push("Let me check").is_empty());
    let flushed = seg.boundary();
    assert_eq!(texts(&flushed), vec!["Let me check".to_string()]);
    let mut after = seg.push("  It's 72 degrees in Austin right now.");
    after.extend(seg.finish());
    assert_eq!(
        texts(&after),
        vec!["\n\nIt's 72 degrees in Austin right now.".to_string()]
    );
    assert_eq!(
        seg.text(),
        "Let me check\n\nIt's 72 degrees in Austin right now."
    );
    assert_eq!(after[0].offset, 12);
}

#[test]
fn boundary_with_no_text_yet_adds_nothing() {
    let mut seg = SentenceSegmenter::new();
    assert!(seg.boundary().is_empty());
    let mut all = seg.push("Done now.");
    all.extend(seg.finish());
    assert_eq!(seg.text(), "Done now.");
    assert_eq!(texts(&all), vec!["Done now.".to_string()]);
}

#[test]
fn trailing_boundary_leaves_no_dangling_separator() {
    let mut seg = SentenceSegmenter::new();
    seg.push("Let me check that.");
    seg.boundary();
    seg.finish();
    assert_eq!(seg.text(), "Let me check that.");
}

#[test]
fn long_run_without_boundary_splits_at_a_space_within_200_chars() {
    // 50 × "word " = 250 chars, no punctuation.
    let run = "word ".repeat(50);
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, &run);
    assert!(!all.is_empty(), "a 250-char run must split before finish");
    let first = &all[0];
    assert!(
        first.text.chars().count() <= 200,
        "first segment {} chars",
        first.text.chars().count()
    );
    assert_eq!(first.text.chars().count(), 199);
    assert!(first.text.ends_with("word"));
    all.extend(seg.finish());
    assert_eq!(concat(&all), run.trim_end());
}

#[test]
fn long_run_with_no_space_hard_splits_at_200() {
    let run = "x".repeat(250);
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, &run);
    all.extend(seg.finish());
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].text.chars().count(), 200);
    assert_eq!(all[1].text.chars().count(), 50);
    assert_eq!(all[1].offset, 200);
}

#[test]
fn offsets_are_utf16_with_astral_emoji_and_accents() {
    let text = "Hi 🎉 there. Café au lait is ready for you now.";
    let mut seg = SentenceSegmenter::new();
    let mut all = feed_chars(&mut seg, text);
    all.extend(seg.finish());
    assert_eq!(
        texts(&all),
        vec![
            "Hi 🎉 there.".to_string(),
            " Café au lait is ready for you now.".to_string()
        ]
    );
    // "Hi 🎉 there." is 11 chars but 12 UTF-16 units (🎉 is a surrogate pair).
    assert_eq!(all[1].offset, 12);
    let units: Vec<u16> = seg.text().encode_utf16().collect();
    assert_eq!(
        String::from_utf16(&units[all[1].offset..]).unwrap(),
        " Café au lait is ready for you now."
    );
    assert_eq!(seg.text_utf16_len(), 47);
}

/// A script of streamed ops: text deltas and tool boundaries.
#[derive(Clone)]
enum Op {
    Text(&'static str),
    Boundary,
}

fn corpus() -> Vec<Vec<Op>> {
    vec![
        vec![Op::Text("Sure. It's 72 degrees in Austin right now.")],
        vec![
            Op::Text("Let me check"),
            Op::Boundary,
            Op::Text("Okay, the build passed. All 42 tests are green, and 3.5 seconds faster!"),
        ],
        vec![
            Op::Text("Hi 🎉 there. Café au lait is ready… Want some? “Yes,” she said.\nNext line here is long enough."),
            Op::Boundary,
            Op::Boundary,
            Op::Text("   "),
            Op::Text("Done. ok."),
        ],
        vec![Op::Text(
            "A very long sentence without any punctuation that keeps going and going well past the two hundred character limit so that the segmenter must cut it at a space somewhere sensible before the end of the run and then keep going again",
        )],
    ]
}

/// Deterministic xorshift so the re-chunkings are reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn run_ops(ops: &[Op], chunker: &mut dyn FnMut(&str) -> Vec<String>) -> (Vec<Segment>, String) {
    let mut seg = SentenceSegmenter::new();
    let mut out = Vec::new();
    for op in ops {
        match op {
            Op::Text(t) => {
                for piece in chunker(t) {
                    out.extend(seg.push(&piece));
                }
            }
            Op::Boundary => out.extend(seg.boundary()),
        }
    }
    out.extend(seg.finish());
    (out, seg.text().to_string())
}

#[test]
fn segments_are_invariant_under_random_rechunking_and_tile_the_text() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for ops in corpus() {
        let (reference, reference_text) = run_ops(&ops, &mut |t: &str| {
            t.chars().map(|c| c.to_string()).collect()
        });
        assert!(!reference.is_empty());
        assert_eq!(concat(&reference), reference_text);
        // Offsets are contiguous in UTF-16 units.
        let mut expected_offset = 0;
        for s in &reference {
            assert_eq!(s.offset, expected_offset);
            expected_offset += s.text.encode_utf16().count();
        }
        assert_eq!(expected_offset, reference_text.encode_utf16().count());

        for _ in 0..200 {
            let (segments, text) = run_ops(&ops, &mut |t: &str| {
                let chars: Vec<char> = t.chars().collect();
                let mut pieces = Vec::new();
                let mut i = 0;
                while i < chars.len() {
                    let n = 1 + (rng.next() % 12) as usize;
                    let end = (i + n).min(chars.len());
                    pieces.push(chars[i..end].iter().collect());
                    i = end;
                }
                pieces
            });
            assert_eq!(segments, reference);
            assert_eq!(text, reference_text);
        }
        // Whole-text, single-chunk feed too.
        let (whole, _) = run_ops(&ops, &mut |t: &str| vec![t.to_string()]);
        assert_eq!(whole, reference);
    }
}

// ── CLI-send duplicate guard ───────────────────────────────────────────────

const CH: &str = "6b0a7a8e-4f39-4d5c-9b1e-2a7f0c3d9e11";
const OTHER: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";

#[test]
fn cli_send_into_this_channel_is_detected() {
    let ch = Uuid::parse_str(CH).unwrap();
    let raw = serde_json::json!({
        "command": format!("buzz messages send --channel {CH} --content \"It's 72.\"")
    });
    assert!(is_cli_send_to_channel(&raw, ch));
    // No channel UUID at all: assumed to be this one.
    let raw = serde_json::json!({"command": "buzz messages send --channel '#call' --content hi"});
    assert!(is_cli_send_to_channel(&raw, ch));
}

#[test]
fn cli_send_elsewhere_or_other_commands_are_not_duplicates() {
    let ch = Uuid::parse_str(CH).unwrap();
    let raw = serde_json::json!({
        "command": format!("buzz messages send --channel {OTHER} --content hi")
    });
    assert!(!is_cli_send_to_channel(&raw, ch));
    let raw = serde_json::json!({"command": format!("buzz messages list --channel {CH}")});
    assert!(!is_cli_send_to_channel(&raw, ch));
    assert!(!is_cli_send_to_channel(&serde_json::json!({}), ch));
}

// ── streamer ───────────────────────────────────────────────────────────────

#[derive(Default)]
struct RecordingSink {
    /// (kind, event, paused-clock instant of the publish)
    events: Mutex<Vec<(u16, Event, tokio::time::Instant)>>,
    final_attempts: Mutex<u32>,
    /// Fail this many final posts before succeeding.
    fail_finals: u32,
}

impl RecordingSink {
    fn segments(&self) -> Vec<Event> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| *k == 24820)
            .map(|(_, e, _)| e.clone())
            .collect()
    }
    fn finals(&self) -> Vec<Event> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| *k == 9)
            .map(|(_, e, _)| e.clone())
            .collect()
    }
    fn times(&self) -> Vec<tokio::time::Instant> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| *k == 24820)
            .map(|(_, _, t)| *t)
            .collect()
    }
}

impl SpeechSink for RecordingSink {
    fn publish_segment(&self, event: Event) -> SinkFuture<'_> {
        Box::pin(async move {
            let kind = event.kind.as_u16();
            self.events
                .lock()
                .unwrap()
                .push((kind, event, tokio::time::Instant::now()));
            Ok(())
        })
    }
    fn post_final(&self, event: Event) -> SinkFuture<'_> {
        Box::pin(async move {
            let attempt = {
                let mut a = self.final_attempts.lock().unwrap();
                *a += 1;
                *a
            };
            if attempt <= self.fail_finals {
                return Err(format!("simulated failure {attempt}"));
            }
            let kind = event.kind.as_u16();
            self.events
                .lock()
                .unwrap()
                .push((kind, event, tokio::time::Instant::now()));
            Ok(())
        })
    }
}

fn params() -> VoiceStreamParams {
    VoiceStreamParams {
        channel_id: Uuid::parse_str(CH).unwrap(),
        stream_id: "turn-42".into(),
        trigger_event_id: Some("ab".repeat(32)),
        trigger_created_at: Some(1_790_000_000),
        keys: Keys::generate(),
        started: tokio::time::Instant::now(),
    }
}

fn tag_values(event: &Event, name: &str) -> Option<Vec<String>> {
    event
        .tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .find(|t| t.first().map(String::as_str) == Some(name))
}

#[tokio::test(start_paused = true)]
async fn streamed_turn_publishes_segments_then_one_tagged_final() {
    let sink = Arc::new(RecordingSink::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let p = params();
    let author = p.keys.public_key();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), p));
    for token in [
        "Sure",
        ".",
        " It's",
        " 72 degrees",
        " in Austin right",
        " now.",
    ] {
        tx.send(SpeechTap::Text(token.into())).unwrap();
    }
    drop(tx);
    let report = handle.await.unwrap();

    let segments = sink.segments();
    assert_eq!(segments.len(), 2, "segment 0 + done");
    for (i, ev) in segments.iter().enumerate() {
        assert_eq!(ev.pubkey, author);
        assert_eq!(tag_values(ev, "h").unwrap(), vec!["h", CH]);
        let speech = tag_values(ev, "buzz-speech").unwrap();
        assert_eq!(speech[1], "turn-42");
        assert_eq!(speech[2], i.to_string());
        assert_eq!(tag_values(ev, "e").unwrap()[3], "reply");
    }
    assert_eq!(segments[0].content, "Sure.");
    assert_eq!(tag_values(&segments[0], "buzz-speech").unwrap()[3], "0");
    assert!(tag_values(&segments[0], "done").is_none());
    assert_eq!(segments[1].content, " It's 72 degrees in Austin right now.");
    assert_eq!(tag_values(&segments[1], "buzz-speech").unwrap()[3], "5");
    assert_eq!(
        tag_values(&segments[1], "done").unwrap(),
        vec!["done", "42"]
    );

    let finals = sink.finals();
    assert_eq!(finals.len(), 1);
    assert_eq!(
        finals[0].content,
        "Sure. It's 72 degrees in Austin right now."
    );
    assert_eq!(tag_values(&finals[0], "h").unwrap(), vec!["h", CH]);
    assert_eq!(
        tag_values(&finals[0], "buzz-speech").unwrap(),
        vec!["buzz-speech", "turn-42", "2", "42"]
    );
    assert!(report.final_posted);
    assert_eq!(report.segments_published, 2);
}

#[tokio::test(start_paused = true)]
async fn empty_reply_publishes_nothing() {
    let sink = Arc::new(RecordingSink::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    tx.send(SpeechTap::ToolBoundary { raw_input: None })
        .unwrap();
    tx.send(SpeechTap::Text("   ".into())).unwrap();
    drop(tx);
    let report = handle.await.unwrap();
    assert!(sink.events.lock().unwrap().is_empty());
    assert_eq!(report, StreamReport::default());
}

#[tokio::test(start_paused = true)]
async fn cli_send_skips_the_final_but_still_sends_done() {
    let sink = Arc::new(RecordingSink::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    tx.send(SpeechTap::Text("Let me check.".into())).unwrap();
    tx.send(SpeechTap::ToolBoundary {
        raw_input: Some(serde_json::json!({})),
    })
    .unwrap();
    tx.send(SpeechTap::ToolInput {
        raw_input: serde_json::json!({
            "command": format!("buzz messages send --channel {CH} --content \"It's 72.\"")
        }),
    })
    .unwrap();
    drop(tx);
    let report = handle.await.unwrap();
    assert!(report.cli_send_detected);
    assert!(!report.final_posted);
    assert!(sink.finals().is_empty(), "final must be skipped");
    let segments = sink.segments();
    assert!(tag_values(segments.last().unwrap(), "done").is_some());
}

#[tokio::test(start_paused = true)]
async fn pacer_keeps_first_segment_immediate_and_caps_a_burst() {
    let sink = Arc::new(RecordingSink::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let start = tokio::time::Instant::now();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    // 30 sentences over 1 s.
    for i in 0..30 {
        tx.send(SpeechTap::Text(format!("This is sentence number {i:02}. ")))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    drop(tx);
    handle.await.unwrap();
    let times = sink.times();
    assert!(times.len() <= 40, "{} events", times.len());
    // 1 s at ≥250 ms spacing: seq 0 + at most 4 paced + done.
    assert!(times.len() <= 6, "{} events", times.len());
    assert_eq!(times[0], start, "seq 0 must not be delayed");
    for pair in times[..times.len() - 1].windows(2) {
        assert!(pair[1] - pair[0] >= Duration::from_millis(250));
    }
    // Nothing lost: the segments still tile the final text.
    let joined: String = sink.segments().iter().map(|e| e.content.clone()).collect();
    assert_eq!(joined, sink.finals()[0].content);
}

#[tokio::test(start_paused = true)]
async fn hard_cap_is_forty_events_per_turn() {
    let sink = Arc::new(RecordingSink::default());
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    // 100 sentences, one every 600 ms: unpaced, this would be 100 events.
    for i in 0..100 {
        tx.send(SpeechTap::Text(format!("This is sentence number {i:03}. ")))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    drop(tx);
    handle.await.unwrap();
    let segments = sink.segments();
    assert_eq!(segments.len(), 40);
    // Wire contract with the web tracker: seq is strictly contiguous from 0
    // (it orders by seq), and offsets index the final text exactly.
    let final_units: Vec<u16> = sink.finals()[0].content.encode_utf16().collect();
    for (i, ev) in segments.iter().enumerate() {
        let speech = tag_values(ev, "buzz-speech").unwrap();
        assert_eq!(speech[2], i.to_string(), "seq must be contiguous");
        let offset: usize = speech[3].parse().unwrap();
        let units: Vec<u16> = ev.content.encode_utf16().collect();
        assert_eq!(&final_units[offset..offset + units.len()], &units[..]);
    }
    assert!(tag_values(&segments[39], "done").is_some());
    let joined: String = segments.iter().map(|e| e.content.clone()).collect();
    assert_eq!(joined, sink.finals()[0].content);
}

#[tokio::test(start_paused = true)]
async fn final_post_retries_three_times_then_gives_up() {
    let sink = Arc::new(RecordingSink {
        fail_finals: 2,
        ..RecordingSink::default()
    });
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    tx.send(SpeechTap::Text("Sure thing, here it is.".into()))
        .unwrap();
    drop(tx);
    let report = handle.await.unwrap();
    assert!(report.final_posted);
    assert_eq!(*sink.final_attempts.lock().unwrap(), 3);
    assert_eq!(sink.finals().len(), 1);

    let sink = Arc::new(RecordingSink {
        fail_finals: 99,
        ..RecordingSink::default()
    });
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, Some(sink.clone()), params()));
    tx.send(SpeechTap::Text("Sure thing, here it is.".into()))
        .unwrap();
    drop(tx);
    let report = handle.await.unwrap();
    assert!(!report.final_posted);
    assert_eq!(
        *sink.final_attempts.lock().unwrap(),
        4,
        "1 attempt + 3 retries"
    );
}

#[tokio::test(start_paused = true)]
async fn measure_only_stream_publishes_nothing() {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run_voice_stream(rx, None, params()));
    tx.send(SpeechTap::Text("Sure. It's 72 degrees.".into()))
        .unwrap();
    drop(tx);
    let report = handle.await.unwrap();
    assert_eq!(report.segments_published, 0);
    assert!(!report.final_posted);
}
