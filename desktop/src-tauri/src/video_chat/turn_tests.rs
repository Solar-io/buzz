//! Marker shape for video-relayed turns. The marker is what the agent's
//! prompt keys on to answer in live-call mode — these tests pin it so a
//! refactor can't silently drop or mangle it (the failure would be Evie
//! answering video calls in long-form DM style again).

use super::turn::{mark_video_turn, VIDEO_TURN_MARKER};

#[test]
fn marker_prefixes_plain_turn() {
    assert_eq!(mark_video_turn("hey babe"), "[video] hey babe");
}

#[test]
fn marker_survives_whitespace_only_padding() {
    assert_eq!(mark_video_turn("  padded turn  "), "[video] padded turn");
}

#[test]
fn marker_constant_matches_helper_output() {
    // A prompt rule pasted into the agent ("lines starting with [video]")
    // must keep matching whatever the bridge emits.
    assert!(mark_video_turn("x").starts_with(VIDEO_TURN_MARKER));
    assert_eq!(VIDEO_TURN_MARKER, "[video]");
}
