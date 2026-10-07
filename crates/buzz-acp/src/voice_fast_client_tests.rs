use std::time::{Duration, Instant};

use super::*;
use crate::voice_fast_testkit::{self as kit, Script};

#[test]
fn sse_parser_reassembles_lines_split_across_chunks() {
    let mut p = SseParser::default();
    assert!(p.feed(b"data: {\"a\"").is_empty());
    assert_eq!(p.feed(b":1}\r\n\r\ndata: [DO"), vec!["{\"a\":1}".to_string()]);
    assert_eq!(p.feed(b"NE]\n: comment\nevent: x\n"), vec!["[DONE]".to_string()]);
}

#[test]
fn sse_parser_survives_utf8_split_inside_a_line() {
    let mut p = SseParser::default();
    let line = "data: café\n".as_bytes();
    let (a, b) = line.split_at(10); // inside the 2-byte é
    assert!(p.feed(a).is_empty());
    assert_eq!(p.feed(b), vec!["café".to_string()]);
}

#[test]
fn parse_counts_reasoning_and_yields_text() {
    assert_eq!(
        parse_sse_data(&kit::text_delta("Hi.")),
        vec![SseItem::Text("Hi.".into())]
    );
    assert_eq!(
        parse_sse_data(&kit::reasoning_delta("hmm")),
        vec![SseItem::Reasoning(3)]
    );
    assert_eq!(parse_sse_data("[DONE]"), vec![SseItem::Done]);
    assert_eq!(
        parse_sse_data(r#"{"choices":[{"delta":{"reasoning":"ab","content":"x"},"finish_reason":"stop"}]}"#),
        vec![SseItem::Reasoning(2), SseItem::Text("x".into()), SseItem::Finish]
    );
    assert!(matches!(
        parse_sse_data(r#"{"error":{"message":"bad"}}"#).first(),
        Some(SseItem::Error(_))
    ));
    assert!(parse_sse_data("not json").is_empty());
}

#[test]
fn completions_url_handles_v1_suffix() {
    assert_eq!(completions_url("https://h:6250"), "https://h:6250/v1/chat/completions");
    assert_eq!(completions_url("https://h:6250/v1/"), "https://h:6250/v1/chat/completions");
}

#[test]
fn key_registry_lookup() {
    let raw = r#"{"Kaiya":"k-1","Evie":"  ","other":7}"#;
    assert_eq!(key_from_registry(raw, "Kaiya").as_deref(), Some("k-1"));
    assert_eq!(key_from_registry(raw, "kaiya").as_deref(), Some("k-1"));
    assert_eq!(key_from_registry(raw, "Evie"), None);
    assert_eq!(key_from_registry(raw, "other"), None);
    assert_eq!(key_from_registry("nope", "Kaiya"), None);
}

#[tokio::test]
async fn stream_yields_text_counts_reasoning_and_sends_bearer_body() {
    let mut items = vec![
        (Duration::ZERO, kit::reasoning_delta("thinking")),
        (Duration::ZERO, kit::text_delta("Hello ")),
        (Duration::from_millis(5), kit::text_delta("there.")),
    ];
    items.extend(kit::finish());
    let server = kit::spawn(vec![Script::Stream(items)]).await;
    let client = build_http_client();
    let body = serde_json::json!({"model":"m","stream":true});
    let mut s = FastCompletionStream::open(&client, &server.base_url, "key", &body)
        .await
        .expect("open");
    let mut out = String::new();
    while let Some(t) = s.next_text().await.expect("next") {
        out.push_str(&t);
    }
    assert_eq!(out, "Hello there.");
    assert_eq!(s.reasoning_chars, 8);
    assert_eq!(server.request_count(), 1);
    assert_eq!(server.bodies(), vec![body]);
}

#[tokio::test]
async fn stream_http_error_is_reported() {
    let server = kit::spawn(vec![Script::Status(503)]).await;
    let err = FastCompletionStream::open(&build_http_client(), &server.base_url, "k", &serde_json::json!({}))
        .await
        .err()
        .expect("error");
    assert_eq!(err, FastClientError::Http { status: 503 });
    assert_eq!(err.reason(), "http_503");
}

#[tokio::test]
async fn stream_eof_without_done_is_an_error() {
    let server = kit::spawn(vec![Script::Stream(vec![(
        Duration::ZERO,
        kit::text_delta("Half a sen"),
    )])])
    .await;
    let mut s = FastCompletionStream::open(&build_http_client(), &server.base_url, "k", &serde_json::json!({}))
        .await
        .expect("open");
    assert_eq!(s.next_text().await, Ok(Some("Half a sen".to_string())));
    assert!(matches!(s.next_text().await, Err(FastClientError::Protocol(_))));
}

/// Live probe against the real OmniRoute endpoint (WP2). Ignored by default;
/// run with:
/// `cargo test -p buzz-acp voice_fast_live_probe -- --ignored --nocapture`.
/// Base URL from `BUZZ_VOICE_FAST_BASE_URL` (default pilot :6250), key from
/// `BUZZ_VOICE_FAST_API_KEY` or the per-agent registry entry named by
/// `BUZZ_VOICE_FAST_PROBE_AGENT` (default `Kaiya`). Asserts thinking is OFF.
#[tokio::test]
#[ignore = "live network call to OmniRoute"]
async fn voice_fast_live_probe() {
    let base = std::env::var("BUZZ_VOICE_FAST_BASE_URL")
        .unwrap_or_else(|_| "https://pilot.tailb3d4b8.ts.net:6250".to_string());
    let agent = std::env::var("BUZZ_VOICE_FAST_PROBE_AGENT").unwrap_or_else(|_| "Kaiya".into());
    let key = resolve_api_key_sync(Some(&agent)).expect("api key");
    let model = std::env::var("BUZZ_VOICE_FAST_MODEL")
        .unwrap_or_else(|_| crate::voice_turn::DEFAULT_VOICE_FAST_MODEL.to_string());
    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "reasoning_effort": "none",
        "max_tokens": 40,
        "messages": [
            {"role": "system", "content": "Answer in one short spoken sentence."},
            {"role": "user", "content": "Say hello and name one fruit."}
        ]
    });
    let client = build_http_client();
    let started = Instant::now();
    let mut s = FastCompletionStream::open(&client, &base, &key, &body)
        .await
        .expect("open");
    let mut first: Option<Duration> = None;
    let mut out = String::new();
    while let Some(t) = s.next_text().await.expect("stream") {
        first.get_or_insert_with(|| started.elapsed());
        out.push_str(&t);
    }
    println!(
        "probe model={model} first_text_ms={} total_ms={} reasoning_chars={} text={out:?}",
        first.map(|d| d.as_millis()).unwrap_or(0),
        started.elapsed().as_millis(),
        s.reasoning_chars
    );
    assert!(!out.trim().is_empty(), "no text came back");
    assert_eq!(s.reasoning_chars, 0, "provider ignored reasoning_effort=none");
}
