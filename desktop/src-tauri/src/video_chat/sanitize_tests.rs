//! Unit tests for video-chat speech sanitization and SSE framing.

use super::sanitize::{chunk_for_speech, sanitize_for_speech};
use super::sse;

#[test]
fn strips_bold_and_italic_markers() {
    assert_eq!(
        sanitize_for_speech("**hello** *world* __again__"),
        "hello world again"
    );
}

#[test]
fn replaces_fenced_code_with_spoken_placeholder() {
    assert_eq!(
        sanitize_for_speech("before\n```ts\nconst x = 1;\n```\nafter"),
        "before\n (code omitted) \nafter"
    );
}

#[test]
fn unwraps_links_and_drops_the_url() {
    assert_eq!(
        sanitize_for_speech("see [the docs](https://example.com) now"),
        "see the docs now"
    );
}

#[test]
fn removes_heading_markers_and_bullets() {
    assert_eq!(
        sanitize_for_speech("## Title\n- one\n- two"),
        "Title\none\ntwo"
    );
}

#[test]
fn replaces_bare_urls_with_link() {
    assert_eq!(
        sanitize_for_speech("go to https://example.com/x today"),
        "go to (link) today"
    );
}

#[test]
fn collapses_repeated_whitespace() {
    assert_eq!(sanitize_for_speech("a   b\n\n\nc"), "a b\nc");
}

#[test]
fn chunks_respect_size_cap_and_join_back() {
    let chunks = chunk_for_speech("aaa bbb ccc ddd eee fff ggg", 11);
    for c in &chunks {
        assert!(c.len() <= 11, "chunk over cap: {c}");
    }
    assert_eq!(chunks.join(" "), "aaa bbb ccc ddd eee fff ggg");
}

#[test]
fn chunk_short_and_empty_inputs() {
    assert_eq!(chunk_for_speech("hi", 42), vec!["hi".to_string()]);
    assert!(chunk_for_speech("", 42).is_empty());
}

#[test]
fn sse_role_delta_parses_with_assistant_role() {
    let frame = sse::role_delta();
    assert!(frame.starts_with("data: "));
    let json: serde_json::Value =
        serde_json::from_str(frame.trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(json["choices"][0]["delta"]["role"], "assistant");
}

#[test]
fn sse_content_delta_carries_text() {
    let frame = sse::content_delta("hello there");
    let json: serde_json::Value =
        serde_json::from_str(frame.trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(json["choices"][0]["delta"]["content"], "hello there");
}

#[test]
fn sse_finish_delta_stops_and_marks_done() {
    let frame = sse::finish_delta();
    assert!(frame.contains("\"finish_reason\":\"stop\""));
    assert!(frame.trim_end().ends_with("data: [DONE]"));
}

#[test]
fn sse_keepalive_is_a_comment_frame() {
    assert_eq!(sse::keepalive(), ": keepalive\n\n");
}
