use std::time::{Duration, Instant};

use super::*;
use crate::voice_turn::{resolve_voice_fast, VoiceFastDigest, VoiceFastKnobs, VoiceFastSettings};

const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const STRANGER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const AGENT_PK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn on_settings() -> VoiceFastSettings {
    VoiceFastSettings {
        on: true,
        base_url: Some("http://127.0.0.1:1".into()),
        ..VoiceFastSettings::default()
    }
}

fn input<'a>(settings: &'a VoiceFastSettings, content: &'a str, author: &'a str) -> ClaimInput<'a> {
    ClaimInput {
        kind: 9,
        content,
        author_hex: author,
        owner_hex: Some(OWNER),
        settings,
        has_api_key: true,
        circuit_open: false,
    }
}

// ── claim ────────────────────────────────────────────────────────────────────

#[test]
fn claim_owner_voice_with_everything_on_is_fast() {
    let s = on_settings();
    let d = claim(&input(&s, "[voice] what should I cook?", OWNER));
    assert_eq!(d.route, Route::Fast);
    assert_eq!(d.reason, "claimed");
}

#[test]
fn claim_non_owner_voice_routes_agent() {
    let s = on_settings();
    let d = claim(&input(&s, "[voice] hello", STRANGER));
    assert_eq!(d, RouteDecision::agent("not_owner"));
    let mut no_owner = input(&s, "[voice] hello", OWNER);
    no_owner.owner_hex = None;
    assert_eq!(claim(&no_owner).reason, "not_owner");
}

#[test]
fn claim_switch_off_routes_agent() {
    let s = VoiceFastSettings {
        on: false,
        ..on_settings()
    };
    assert_eq!(
        claim(&input(&s, "[voice] hello", OWNER)),
        RouteDecision::agent("off")
    );
}

#[test]
fn claim_only_kind9_voice_marker_is_a_candidate() {
    let s = on_settings();
    assert_eq!(claim(&input(&s, "hello", OWNER)).reason, "not_voice");
    assert_eq!(
        claim(&input(&s, "[video] hello", OWNER)).reason,
        "not_voice"
    );
    assert_eq!(
        claim(&input(&s, "say [voice] hi", OWNER)).reason,
        "not_voice"
    );
    let mut other_kind = input(&s, "[voice] hello", OWNER);
    other_kind.kind = 1;
    assert_eq!(claim(&other_kind).reason, "not_voice");
    assert!(is_candidate(9, "[voice] x"));
    assert!(!is_candidate(9, "[video] x"));
}

#[test]
fn claim_without_endpoint_or_key_routes_agent() {
    let no_url = VoiceFastSettings {
        base_url: None,
        ..on_settings()
    };
    assert_eq!(
        claim(&input(&no_url, "[voice] hi", OWNER)).reason,
        "no_endpoint"
    );
    let s = on_settings();
    let mut no_key = input(&s, "[voice] hi", OWNER);
    no_key.has_api_key = false;
    assert_eq!(claim(&no_key).reason, "no_endpoint");
}

#[test]
fn claim_open_circuit_routes_agent() {
    let s = on_settings();
    let mut open = input(&s, "[voice] hi", OWNER);
    open.circuit_open = true;
    assert_eq!(claim(&open), RouteDecision::agent("circuit_open"));
}

// ── circuit ──────────────────────────────────────────────────────────────────

#[test]
fn circuit_opens_on_third_fallback_inside_two_minutes() {
    let t0 = Instant::now();
    let mut c = CircuitBreaker::default();
    assert!(!c.record_fallback(t0));
    assert!(!c.record_fallback(t0 + Duration::from_secs(30)));
    assert!(!c.is_open(t0 + Duration::from_secs(31)));
    assert!(c.record_fallback(t0 + Duration::from_secs(60)));
    assert!(c.is_open(t0 + Duration::from_secs(61)));
    assert!(c.is_open(t0 + Duration::from_secs(60 + 299)));
    // Half-open after 5 minutes.
    assert!(!c.is_open(t0 + Duration::from_secs(60 + 301)));
    // One more fallback while half-open re-opens it at once.
    assert!(c.record_fallback(t0 + Duration::from_secs(400)));
    assert!(c.is_open(t0 + Duration::from_secs(401)));
}

#[test]
fn circuit_ignores_fallbacks_spread_past_the_window() {
    let t0 = Instant::now();
    let mut c = CircuitBreaker::default();
    assert!(!c.record_fallback(t0));
    assert!(!c.record_fallback(t0 + Duration::from_secs(100)));
    assert!(!c.record_fallback(t0 + Duration::from_secs(230)));
    assert!(!c.is_open(t0 + Duration::from_secs(231)));
}

#[test]
fn circuit_success_closes_half_open() {
    let t0 = Instant::now();
    let mut c = CircuitBreaker::default();
    for i in 0..3 {
        c.record_fallback(t0 + Duration::from_secs(i));
    }
    assert!(!c.is_open(t0 + Duration::from_secs(400)));
    c.record_success();
    assert!(!c.record_fallback(t0 + Duration::from_secs(401)));
    assert!(!c.is_open(t0 + Duration::from_secs(402)));
}

// ── handoff scanner ──────────────────────────────────────────────────────────

fn scan(chunks: &[&str]) -> (String, Option<String>) {
    let mut s = HandoffScanner::new();
    let mut out = String::new();
    for c in chunks {
        out.push_str(&s.push(c));
    }
    let task = s.finish();
    (out, task)
}

#[test]
fn scanner_passes_plain_text() {
    let (out, task) = scan(&["Pasta ", "sounds great. ", "Want a recipe?"]);
    assert_eq!(out, "Pasta sounds great. Want a recipe?");
    assert_eq!(task, None);
}

#[test]
fn scanner_strips_marker_and_captures_task() {
    let (out, task) = scan(&["Let me check.\n<<handoff: check Sam's calendar for tomorrow>>"]);
    assert_eq!(out, "Let me check.\n");
    assert_eq!(task.as_deref(), Some("check Sam's calendar for tomorrow"));
}

#[test]
fn scanner_marker_split_at_every_boundary_never_leaks() {
    let full = "Let me check.\n<<handoff: look up the weather>>";
    let chars: Vec<char> = full.chars().collect();
    let mut cases = 0;
    for i in 0..=chars.len() {
        for j in i..=chars.len() {
            let a: String = chars[..i].iter().collect();
            let b: String = chars[i..j].iter().collect();
            let c: String = chars[j..].iter().collect();
            let (out, task) = scan(&[&a, &b, &c]);
            assert_eq!(out, "Let me check.\n", "split at {i},{j}");
            assert!(!out.contains('<'), "split at {i},{j}");
            assert_eq!(
                task.as_deref(),
                Some("look up the weather"),
                "split {i},{j}"
            );
            cases += 1;
        }
    }
    assert_eq!(cases, (chars.len() + 1) * (chars.len() + 2) / 2);
}

#[test]
fn scanner_char_by_char_never_emits_a_lt() {
    let mut s = HandoffScanner::new();
    let mut out = String::new();
    for ch in "Sure.<<HandOff: send the doc>> trailing junk".chars() {
        out.push_str(&s.push(&ch.to_string()));
    }
    assert_eq!(out, "Sure.");
    assert!(s.is_closed());
    assert_eq!(s.finish().as_deref(), Some("send the doc"));
}

#[test]
fn scanner_releases_lt_that_is_not_a_marker() {
    let (out, task) = scan(&["3 <", " 4 and a <<b", "ig deal"]);
    assert_eq!(out, "3 < 4 and a <<big deal");
    assert_eq!(task, None);
}

#[test]
fn scanner_drops_partial_marker_at_eof() {
    let (out, task) = scan(&["Okay. <<hand"]);
    assert_eq!(out, "Okay. ");
    assert_eq!(task, None);
}

#[test]
fn scanner_unclosed_marker_still_hands_off() {
    let (out, task) = scan(&["One sec. <<handoff: deploy the web build"]);
    assert_eq!(out, "One sec. ");
    assert_eq!(task.as_deref(), Some("deploy the web build"));
}

#[test]
fn scanner_drops_echoed_call_state_note_at_any_split() {
    let full = "Any time. [call state: agent idle] Bye.";
    let chars: Vec<char> = full.chars().collect();
    for i in 0..=chars.len() {
        let a: String = chars[..i].iter().collect();
        let b: String = chars[i..].iter().collect();
        let (out, task) = scan(&[&a, &b]);
        assert_eq!(out, "Any time.  Bye.", "split at {i}");
        assert_eq!(task, None);
    }
}

#[test]
fn scanner_releases_other_brackets() {
    let (out, _) = scan(&["[laughs] okay, [c", "all me] later"]);
    assert_eq!(out, "[laughs] okay, [call me] later");
}

#[test]
fn scanner_handles_extra_lt_before_marker() {
    let (out, task) = scan(&["x <<<handoff: t>>"]);
    assert_eq!(out, "x <");
    assert_eq!(task.as_deref(), Some("t"));
}

#[test]
fn bare_ack_without_marker_becomes_a_handoff() {
    assert!(is_bare_ack("Let me check."));
    assert!(is_bare_ack("  One sec, I’ll look. "));
    assert!(!is_bare_ack(""));
    assert!(!is_bare_ack("Pasta would be easy tonight."));
    assert!(!is_bare_ack(
        "Let me check my notes on that, though honestly I think it was probably fine either way."
    ));
    assert_eq!(
        resolve_handoff("Let me check.", None, " find the article "),
        Some("answer the caller's request: \"find the article\"".to_string())
    );
    assert_eq!(
        resolve_handoff("Let me check.", Some("t".into()), "x"),
        Some("t".to_string())
    );
    assert_eq!(resolve_handoff("Sure, pasta.", None, "x"), None);
}

// ── ledger ───────────────────────────────────────────────────────────────────

#[test]
fn mark_handed_is_exactly_once_per_event() {
    let mut l = CallLedger::new(Instant::now());
    assert!(l.mark_handed("ev1"));
    assert!(!l.mark_handed("ev1"));
    assert!(!l.mark_handed("ev1"));
    assert!(l.mark_handed("ev2"));
}

#[test]
fn self_messages_dedupe_by_stream_and_event_id() {
    let mut l = CallLedger::new(Instant::now());
    l.expect_stream("vf-abc");
    assert!(!l.note_self_message("e1", Some("vf-abc"), "fast final"));
    assert!(l.note_self_message("e2", Some("turn-1"), "agent streamed answer"));
    assert!(!l.note_self_message("e2b", Some("turn-1"), "same stream again"));
    assert!(l.note_self_message("e3", None, "cli send"));
    assert!(!l.note_self_message("e3", None, "cli send replay"));
    let texts: Vec<&str> = l.entries().map(|e| e.text.as_str()).collect();
    assert_eq!(texts, vec!["agent streamed answer", "cli send"]);
    assert!(l
        .entries()
        .all(|e| e.digested && e.speaker == Speaker::Agent));
}

#[test]
fn render_context_carries_lines_ack_and_task_then_commits() {
    let mut l = CallLedger::new(Instant::now());
    l.push_owner("what should I cook", Some("u1"), EntrySource::Fast, false);
    let seq = l
        .push_agent("Pasta would be easy.", EntrySource::Fast, false, false)
        .expect("seq");
    l.push_agent("And then", EntrySource::Fast, true, false);
    let handoff_user = l
        .push_owner("check my calendar", Some("u2"), EntrySource::Fast, false)
        .expect("seq");
    l.mark_entry_digested(handoff_user);
    l.add_handoff(HandoffNote {
        trigger_id: "u2".into(),
        ack: "Let me check.".into(),
        task: "check the calendar for tomorrow".into(),
    });
    assert_eq!(
        l.agent_status,
        AgentStatus::Working("check the calendar for tomorrow".into())
    );

    let r = l.render_context(&["u2".to_string()]).expect("context");
    assert_eq!(
        r.text,
        "[Voice Fast Context]\n\
         Your fast voice has been talking with the caller in this call as you; these lines were spoken in your voice:\n  \
         Caller: what should I cook\n  \
         You: Pasta would be easy.\n  \
         You: And then (cut off)\n\
         For the newest message it already said: \"Let me check.\" and handed you: check the calendar for tomorrow.\n\
         Do that now. Your reply is spoken right after the acknowledgment, so don't repeat it."
    );
    assert!(r.watermark > seq);
    assert_eq!(r.handoff_ids, vec!["u2".to_string()]);
    // A batch that does not carry the trigger gets the lines but no note.
    let other = l.render_context(&["zzz".to_string()]).expect("lines");
    assert!(!other.text.contains("handed you"));

    l.commit_context(r.watermark, &r.handoff_ids);
    assert!(!l.has_undigested());
    assert_eq!(l.render_context(&["u2".to_string()]), None);
}

#[test]
fn render_context_none_when_nothing_undigested() {
    let mut l = CallLedger::new(Instant::now());
    l.push_owner("hi", Some("u1"), EntrySource::Agent, true);
    assert_eq!(l.render_context(&[]), None);
}

#[test]
fn render_context_caps_lines() {
    let mut l = CallLedger::new(Instant::now());
    for i in 0..40 {
        l.push_owner(
            &format!("{i:03} {}", "x".repeat(200)),
            None,
            EntrySource::Fast,
            false,
        );
    }
    let r = l.render_context(&[]).expect("ctx");
    assert!(r.text.contains("(earlier lines omitted)"));
    assert!(r.text.contains("039 "));
    assert!(!r.text.contains("000 "));
    assert!(r.text.chars().count() < CONTEXT_LINES_MAX_CHARS + 300);
}

#[test]
fn history_caps_turns_and_chars_and_merges_speakers() {
    let mut l = CallLedger::new(Instant::now());
    l.push_agent("leading agent line", EntrySource::History, false, true);
    l.push_owner("a", None, EntrySource::Fast, false);
    l.push_owner("b", None, EntrySource::Fast, false);
    l.push_agent("reply", EntrySource::Fast, true, false);
    let current = l.push_owner("now", None, EntrySource::Fast, false);
    let h = l.history_messages(current, 12, 6000);
    assert_eq!(
        h,
        vec![
            (Speaker::Owner, "a\nb".to_string()),
            (Speaker::Agent, "reply (cut off)".to_string()),
        ]
    );
    // One pair = the newest two entries before the current one.
    let h1 = l.history_messages(current, 1, 6000);
    assert_eq!(
        h1,
        vec![
            (Speaker::Owner, "b".to_string()),
            (Speaker::Agent, "reply (cut off)".to_string())
        ]
    );
    // Char cap keeps only what fits, newest first.
    let h2 = l.history_messages(current, 12, 6);
    assert_eq!(
        h2,
        vec![
            (Speaker::Owner, "b".to_string()),
            (Speaker::Agent, "reply (cut off)".to_string())
        ]
    );
    let h3 = l.history_messages(current, 12, 5);
    assert_eq!(
        h3,
        Vec::<(Speaker, String)>::new(),
        "agent-first is trimmed"
    );
    let h4 = l.history_messages(current, 12, 4);
    assert_eq!(h4, Vec::<(Speaker, String)>::new());
}

#[test]
fn call_state_line_reflects_status() {
    let mut l = CallLedger::new(Instant::now());
    assert_eq!(l.call_state_line(), "[call state: agent idle]");
    l.agent_status = AgentStatus::Working("deploy".into());
    l.last_reply_interrupted = true;
    assert_eq!(
        l.call_state_line(),
        "[call state: agent working on: deploy; last reply interrupted]"
    );
}

#[test]
fn ledgers_sweep_drops_idle_calls() {
    let ledgers = VoiceFastLedgers::new();
    let t0 = Instant::now();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    ledgers.with(a, t0, |_| ());
    ledgers.with(b, t0 + Duration::from_secs(20 * 60), |_| ());
    ledgers.sweep(t0 + Duration::from_secs(31 * 60));
    assert!(!ledgers.contains(a));
    assert!(ledgers.contains(b));
}

// ── request ──────────────────────────────────────────────────────────────────

#[test]
fn request_has_stable_prefix_history_and_call_state() {
    let s = on_settings();
    let history = vec![
        (Speaker::Owner, "hi".to_string()),
        (Speaker::Agent, "hey".to_string()),
    ];
    let body = build_fast_request(
        &s,
        &FastPromptParts {
            persona: Some("I am Kaiya."),
            core_memory: Some("[Agent Memory — core]\nlikes tea"),
            history: &history,
            utterance: "what now",
            call_state: "[call state: agent idle]",
        },
    );
    assert_eq!(body["model"], "ollama-cloud/deepseek-v4.1-flash");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 220);
    assert_eq!(body["reasoning_effort"], "none");
    let msgs = body["messages"].as_array().expect("messages");
    assert_eq!(msgs.len(), 4);
    let system = msgs[0]["content"].as_str().expect("system");
    assert!(
        system.starts_with("I am Kaiya.\n\n[Agent Memory — core]\nlikes tea\n\n[Voice Fast Rules]")
    );
    assert_eq!(msgs[1]["role"], "user");
    assert_eq!(msgs[2]["role"], "assistant");
    assert_eq!(msgs[3]["content"], "what now\n\n[call state: agent idle]");
}

#[test]
fn request_omits_reasoning_when_configured() {
    let s = VoiceFastSettings {
        reasoning: None,
        ..on_settings()
    };
    let body = build_fast_request(
        &s,
        &FastPromptParts {
            persona: None,
            core_memory: None,
            history: &[],
            utterance: "x",
            call_state: "",
        },
    );
    assert!(body.get("reasoning_effort").is_none());
    assert!(body["messages"][0]["content"]
        .as_str()
        .expect("s")
        .starts_with("[Voice Fast Rules]"));
}

#[test]
fn helpers_strip_marker_and_derive_stream_id() {
    assert_eq!(strip_voice_marker("[voice] hello there "), "hello there");
    assert_eq!(fast_stream_id("0123456789abcdef0123"), "vf-0123456789ab");
    assert_eq!(
        normalize_transcript("Hey, want to  do it?"),
        "hey want to do it"
    );
    assert!(!usable_core_section(&format!(
        "[Agent Memory — core]\n{}",
        crate::engram_fetch::ONBOARDING_NUDGE
    )));
    assert!(usable_core_section("[Agent Memory — core]\nlikes tea"));
}

// ── config ───────────────────────────────────────────────────────────────────

fn knobs(file: Option<&str>) -> VoiceFastKnobs<'_> {
    VoiceFastKnobs {
        agent_name: Some("Kaiya"),
        agent_pubkey: Some(AGENT_PK),
        file_content: file,
        ..VoiceFastKnobs::default()
    }
}

#[test]
fn config_defaults_are_off() {
    let s = resolve_voice_fast(&knobs(None));
    assert_eq!(s, VoiceFastSettings::default());
    assert!(!s.on);
    assert_eq!(s.base_url, None);
    assert_eq!(s.first_token_ms, 2500);
    assert_eq!(s.max_tokens, 220);
    assert_eq!((s.history_turns, s.history_chars), (12, 6000));
    assert_eq!(s.digest, VoiceFastDigest::Idle);
    assert_eq!(s.digest_idle_secs, 180);
}

#[test]
fn config_layers_pubkey_name_wildcard() {
    let raw = format!(
        r#"{{"*":{{"voiceFastBaseUrl":"https://pilot:6250/","voiceFastModel":"wild"}},
        "kaiya":{{"voiceFast":"on","voiceFastModel":"named","voiceFastFirstTokenMs":1800}},
        "{AGENT_PK}":{{"voiceFastMaxTokens":"300","voiceFastReasoning":"omit","voiceFastDigest":"handoff"}},
        "Other":{{"voiceFast":"off"}}}}"#
    );
    let s = resolve_voice_fast(&knobs(Some(&raw)));
    assert!(s.on);
    assert_eq!(s.model, "named");
    assert_eq!(s.base_url.as_deref(), Some("https://pilot:6250"));
    assert_eq!(s.first_token_ms, 1800);
    assert_eq!(s.max_tokens, 300);
    assert_eq!(s.reasoning, None);
    assert_eq!(s.digest, VoiceFastDigest::Handoff);
}

#[test]
fn config_invalid_switch_stays_off_and_masks_env() {
    let mut k = knobs(Some(r#"{"Kaiya":{"voiceFast":"yes"}}"#));
    k.env_on = Some("on");
    assert!(!resolve_voice_fast(&k).on);
    let mut env_only = knobs(None);
    env_only.env_on = Some("on");
    env_only.env_base_url = Some("http://x:1");
    env_only.env_model = Some("m");
    let s = resolve_voice_fast(&env_only);
    assert!(s.on);
    assert_eq!(s.base_url.as_deref(), Some("http://x:1"));
    assert_eq!(s.model, "m");
}

#[test]
fn config_invalid_numbers_fall_back_to_defaults() {
    let s = resolve_voice_fast(&knobs(Some(
        r#"{"*":{"voiceFastFirstTokenMs":"soon","voiceFastMaxTokens":0,"voiceFastMemory":"off"}}"#,
    )));
    assert_eq!(s.first_token_ms, 2500);
    assert_eq!(s.max_tokens, 220);
    assert!(!s.memory);
}
