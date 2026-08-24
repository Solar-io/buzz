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

/// Stale-turn guard: a follow-up turn sent inside the skew window must NOT
/// re-match the exact reply the avatar just spoke. This pins the 2026-08-24
/// fix for "reply in 14ms, identical chars" — the avatar re-speaking its own
/// last line while the user was still talking.
mod stale_reply_guard {
    use crate::video_chat::turn::is_fresh_reply;

    const SENT_AT: i64 = 1000;

    fn id(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn rejects_the_already_spoken_event_in_the_skew_window() {
        // Reply A returned at t=999; turn B sent at t=1000 (within the 2s
        // skew grace). Candidate A must be excluded, not re-spoken.
        let last = (999, id(1));
        assert!(!is_fresh_reply(999, &id(1), SENT_AT, &last));
    }

    #[test]
    fn accepts_a_new_event_in_the_same_second() {
        // Two replies inside one second: the unspoken one is still fresh.
        let last = (999, id(1));
        assert!(is_fresh_reply(999, &id(2), SENT_AT, &last));
    }

    #[test]
    fn accepts_the_new_reply_after_the_last_spoken_one() {
        let last = (999, id(1));
        assert!(is_fresh_reply(1004, &id(2), SENT_AT, &last));
    }

    #[test]
    fn rejects_events_older_than_the_send_window() {
        let last = (0, [0u8; 32]);
        assert!(!is_fresh_reply(SENT_AT - 3, &id(9), SENT_AT, &last));
    }

    #[test]
    fn rejects_events_older_than_the_last_spoken_reply() {
        // An unspoken event from before the last returned reply must not be
        // dug up by a later turn's skew window.
        let last = (1005, id(1));
        assert!(!is_fresh_reply(1000, &id(2), 1006, &last));
    }
}
