use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

const RELAY: &str = "https://relay.example";

fn sha(n: u64) -> String {
    format!("{n:064x}")
}

/// A recorded `send` call — what would have become a published event.
#[derive(Debug, Clone)]
struct Sent {
    channel: String,
    content: String,
    tag: Vec<String>,
    media_url: Option<String>,
    reply_to: Option<String>,
    mentions: Vec<String>,
}

#[derive(Default)]
struct FakeBackend {
    /// 1-based upload number that fails (None = never).
    fail_upload_at: Option<usize>,
    /// HEAD answers by URL; a URL absent from the map answers 404.
    heads: HashMap<String, MediaHead>,
    uploads: RefCell<Vec<PathBuf>>,
    head_calls: RefCell<usize>,
    resolve_calls: RefCell<usize>,
    sent: RefCell<Vec<Sent>>,
}

impl FakeBackend {
    fn sends(&self) -> usize {
        self.sent.borrow().len()
    }
    fn network_calls(&self) -> usize {
        self.uploads.borrow().len()
            + *self.head_calls.borrow()
            + *self.resolve_calls.borrow()
            + self.sends()
    }
}

impl StageBackend for FakeBackend {
    fn relay_url(&self) -> &str {
        RELAY
    }
    async fn resolve_channel(&self, channel: &str) -> Result<String, CliError> {
        *self.resolve_calls.borrow_mut() += 1;
        Ok(format!("uuid-{channel}"))
    }
    async fn upload(&self, path: &Path) -> Result<BlobDescriptor, CliError> {
        let n = {
            let mut uploads = self.uploads.borrow_mut();
            uploads.push(path.to_path_buf());
            uploads.len()
        };
        if self.fail_upload_at == Some(n) {
            return Err(CliError::Other(format!(
                "upload failed for {}",
                path.display()
            )));
        }
        Ok(BlobDescriptor {
            url: format!("{RELAY}/media/{}.png", sha(n as u64)),
            sha256: sha(n as u64),
            size: 10,
            mime_type: "image/png".into(),
            uploaded: 0,
            dim: Some("640x480".into()),
            blurhash: None,
            thumb: None,
            duration: None,
        })
    }
    async fn head_media(&self, url: &str) -> Result<Option<MediaHead>, CliError> {
        *self.head_calls.borrow_mut() += 1;
        Ok(self.heads.get(url).cloned())
    }
    async fn send(&self, p: SendMessageParams) -> Result<Value, CliError> {
        let stage = p
            .stage
            .expect("every stage send carries a stage attachment");
        let mut sent = self.sent.borrow_mut();
        sent.push(Sent {
            channel: p.channel_id,
            content: p.content,
            tag: stage.tag,
            media_url: stage.media.map(|m| m.url),
            reply_to: p.reply_to,
            mentions: p.mentions,
        });
        Ok(serde_json::json!({
            "event_id": sha(0xe000 + sent.len() as u64),
            "accepted": true,
            "message": "",
        }))
    }
}

fn deck_json(parts: &[(&str, &str, &str)]) -> String {
    let parts: Vec<Value> = parts
        .iter()
        .map(|(label, text, image)| {
            let mut v = serde_json::json!({ "image": image });
            if !label.is_empty() {
                v["label"] = Value::String(label.to_string());
            }
            if !text.is_empty() {
                v["text"] = Value::String(text.to_string());
            }
            v
        })
        .collect();
    serde_json::json!({ "title": "Kyoto", "parts": parts }).to_string()
}

fn open_args(deck_raw: String) -> OpenArgs {
    OpenArgs {
        channel: "dm".into(),
        deck_raw,
        deck_dir: PathBuf::from("/decks"),
        voice: None,
        mentions: vec![],
    }
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn three_frame_deck() -> String {
    deck_json(&[
        ("gate", "Fushimi Inari at dawn.", "01.png"),
        ("temple", "Kiyomizu-dera.", "02.png"),
        ("", "", "03.png"),
    ])
}

fn tag_json(tag: &[String]) -> Value {
    assert_eq!(tag[0], "stage");
    serde_json::from_str(&tag[1]).unwrap()
}

// ---- deck validation ----

#[test]
fn deck_validation_rejects_bad_decks() {
    let dir = Path::new("/d");
    let ok = parse_deck(&three_frame_deck(), dir, RELAY, None).expect("valid deck");
    assert_eq!(ok.parts.len(), 3);
    assert!(ok.voice, "voice defaults on");
    assert_eq!(
        ok.parts[0].image,
        ImageSource::Local(PathBuf::from("/d/01.png"))
    );
    assert_eq!(ok.parts[2].text, None, "empty text = image-only frame");

    let cases: Vec<(String, &str)> = vec![
        (r#"{"title":"T","parts":[]}"#.into(), "needs 1-50 parts"),
        (
            serde_json::json!({"title":"T","parts": (0..51).map(|_| serde_json::json!({"image":"a.png"})).collect::<Vec<_>>()}).to_string(),
            "needs 1-50 parts",
        ),
        (r#"{"title":"  ","parts":[{"image":"a.png"}]}"#.into(), "title"),
        (format!(r#"{{"title":"{}","parts":[{{"image":"a.png"}}]}}"#, "t".repeat(121)), "title"),
        (r#"{"title":"T","parts":[{"image":""}]}"#.into(), "image is required"),
        (r#"{"title":"T","parts":[{"text":"x"}]}"#.into(), "invalid JSON"),
        (r#"{"title":"T","parts":[{"image":"a","label":"x"},{"image":"b","label":"x"}]}"#.into(), "duplicate label"),
        (r#"{"title":"T","parts":[{"image":"a","label":" "}]}"#.into(), "label"),
        (r#"{"title":"T","parts":[{"image":"a","caption":"x"}]}"#.into(), "unknown field"),
    ];
    assert_eq!(cases.len(), 9);
    for (raw, want) in &cases {
        let err = parse_deck(raw, dir, RELAY, None)
            .expect_err(raw)
            .to_string();
        assert!(err.contains(want), "{raw}: {err:?} lacks {want:?}");
    }
}

#[test]
fn voice_flag_overrides_deck() {
    let raw = r#"{"title":"T","voice":true,"parts":[{"image":"a.png"}]}"#;
    assert!(
        !parse_deck(raw, Path::new("."), RELAY, Some(false))
            .unwrap()
            .voice
    );
    let raw = r#"{"title":"T","voice":false,"parts":[{"image":"a.png"}]}"#;
    assert!(!parse_deck(raw, Path::new("."), RELAY, None).unwrap().voice);
}

#[test]
fn relay_image_urls_must_be_content_addressed_on_this_relay() {
    let good = format!("{RELAY}/media/{}.png", sha(7));
    assert_eq!(
        relay_image_source(RELAY, &good).unwrap(),
        ImageSource::Relay {
            url: good.clone(),
            sha256: sha(7),
            ext: "png".into()
        }
    );
    let bad = [
        format!("https://evil.example/media/{}.png", sha(7)),
        format!("http://relay.example/media/{}.png", sha(7)),
        format!("https://relay.example:8443/media/{}.png", sha(7)),
        format!("{RELAY}/media/{}", sha(7)),
        format!("{RELAY}/media/{}.PNG", sha(7)),
        format!("{RELAY}/files/{}.png", sha(7)),
        format!("{RELAY}/media/abc.png"),
        format!("{RELAY}/media/{}.png?x=1", sha(7)),
    ];
    assert_eq!(bad.len(), 8);
    for url in &bad {
        let err = relay_image_source(RELAY, url).expect_err(url);
        assert_eq!(crate::error::exit_code(&err), 1, "{url}");
    }
}

// ---- open: upload-all-before-publish ----

#[test]
fn open_upload_failure_publishes_nothing() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend {
        fail_upload_at: Some(3),
        ..Default::default()
    };
    let deck = deck_json(&[
        ("", "a", "1.png"),
        ("", "b", "2.png"),
        ("", "c", "3.png"),
        ("", "d", "4.png"),
    ]);
    let err =
        run(open_session(&backend, base.path(), open_args(deck))).expect_err("upload #3 fails");
    assert!(err.to_string().contains("upload failed"), "{err}");
    assert_eq!(
        backend.uploads.borrow().len(),
        3,
        "stopped at the failing upload"
    );
    assert_eq!(backend.sends(), 0, "zero events published");
    assert_eq!(
        std::fs::read_dir(base.path()).unwrap().count(),
        0,
        "no state file"
    );
}

#[test]
fn open_url_image_off_relay_exits_1_with_zero_calls() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let deck = deck_json(&[
        ("", "a", "1.png"),
        (
            "",
            "b",
            &format!("https://cdn.example/media/{}.png", sha(9)),
        ),
    ]);
    let err = run(open_session(&backend, base.path(), open_args(deck))).expect_err("off-relay URL");
    assert_eq!(crate::error::exit_code(&err), 1);
    assert_eq!(backend.network_calls(), 0, "refused before any network I/O");
}

#[test]
fn open_missing_relay_blob_exits_1_with_zero_events() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default(); // every HEAD answers 404
    let url = format!("{RELAY}/media/{}.jpg", sha(9));
    let deck = deck_json(&[("", "a", "1.png"), ("", "b", &url)]);
    let err = run(open_session(&backend, base.path(), open_args(deck))).expect_err("missing blob");
    assert_eq!(crate::error::exit_code(&err), 1);
    assert!(err.to_string().contains("not found on the relay"), "{err}");
    assert_eq!(*backend.head_calls.borrow(), 1);
    assert_eq!(backend.sends(), 0, "zero events published");
}

#[test]
fn open_publishes_one_manifest_and_keeps_labels_local() {
    let base = tempfile::tempdir().unwrap();
    let url = format!("{RELAY}/media/{}.jpg", sha(9));
    let mut backend = FakeBackend::default();
    backend.heads.insert(
        url.clone(),
        MediaHead {
            mime: Some("image/jpeg".into()),
            size: Some(42),
        },
    );
    let deck = deck_json(&[("gate", "a", "1.png"), ("secret-label", "b", &url)]);
    let state = run(open_session(&backend, base.path(), open_args(deck))).expect("opens");

    assert_eq!(backend.sends(), 1, "open posts no parts");
    let sent = backend.sent.borrow()[0].clone();
    assert_eq!(sent.channel, "uuid-dm");
    assert_eq!(sent.reply_to, None);
    assert!(
        sent.content.contains("Stage: Kyoto") && sent.content.contains("2 frames"),
        "{}",
        sent.content
    );
    let tag = tag_json(&sent.tag);
    assert_eq!(tag["op"], "open");
    assert_eq!(tag["voice"], true);
    let parts = tag["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0]["x"], sha(1));
    assert_eq!(parts[1]["x"], sha(9));
    assert_eq!(parts[1]["m"], "image/jpeg");
    assert!(
        !sent.tag[1].contains("secret-label"),
        "labels never go on the wire"
    );

    assert_eq!(state.session, sha(0xe001));
    assert_eq!(state.palette[1].label.as_deref(), Some("secret-label"));
    let loaded = load_state(base.path(), &state.session).unwrap();
    assert_eq!(loaded, state);
}

// ---- show / next / close ----

fn opened(backend: &FakeBackend, base: &Path) -> String {
    run(open_session(backend, base, open_args(three_frame_deck())))
        .unwrap()
        .session
}

#[test]
fn show_by_label_posts_a_held_off_showing_with_its_image() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let session = opened(&backend, base.path());
    let out = run(show_frame(
        &backend,
        base.path(),
        &session,
        FrameSelector::Label("temple".into()),
        None,
        false,
    ))
    .unwrap();
    assert_eq!(out["shown"], 1);
    assert_eq!(backend.sends(), 2);
    let sent = backend.sent.borrow()[1].clone();
    assert_eq!(sent.content, "Kiyomizu-dera.");
    assert_eq!(
        sent.media_url.as_deref(),
        Some(format!("{RELAY}/media/{}.png", sha(2)).as_str())
    );
    assert_eq!(sent.reply_to, None, "no e tag on showings");
    assert!(sent.mentions.is_empty());
    assert_eq!(
        tag_json(&sent.tag),
        serde_json::json!({"v":1,"op":"part","s":session,"i":1,"hold":false})
    );

    // The same frame again, held, with new words: a second showing.
    run(show_frame(
        &backend,
        base.path(),
        &session,
        FrameSelector::Index(1),
        Some("Again.".into()),
        true,
    ))
    .unwrap();
    let sent = backend.sent.borrow()[2].clone();
    assert_eq!(sent.content, "Again.");
    assert_eq!(
        tag_json(&sent.tag),
        serde_json::json!({"v":1,"op":"part","s":session,"i":1})
    );
    let state = load_state(base.path(), &session).unwrap();
    assert_eq!(state.showings.len(), 2);
    assert_eq!(status_json(&state)["palette"][1]["shown_count"], 2);
}

#[test]
fn show_unknown_label_or_index_exits_1_and_publishes_nothing() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let session = opened(&backend, base.path());
    let before = backend.network_calls();
    for selector in [
        FrameSelector::Label("nope".into()),
        FrameSelector::Label("Gate".into()),
        FrameSelector::Index(3),
    ] {
        let err = run(show_frame(
            &backend,
            base.path(),
            &session,
            selector.clone(),
            None,
            false,
        ))
        .expect_err("unknown frame");
        assert_eq!(crate::error::exit_code(&err), 1, "{selector:?}");
    }
    assert_eq!(backend.network_calls(), before, "zero network calls");
    assert!(load_state(base.path(), &session)
        .unwrap()
        .showings
        .is_empty());
}

#[test]
fn image_only_frame_sends_empty_text() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let session = opened(&backend, base.path());
    run(show_frame(
        &backend,
        base.path(),
        &session,
        FrameSelector::Index(2),
        None,
        false,
    ))
    .unwrap();
    let sent = backend.sent.borrow()[1].clone();
    assert_eq!(sent.content, "");
    assert!(sent.media_url.is_some());
}

#[test]
fn next_walks_unshown_frames_held_then_exhausts() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let session = opened(&backend, base.path());
    run(show_frame(
        &backend,
        base.path(),
        &session,
        FrameSelector::Index(0),
        None,
        false,
    ))
    .unwrap();
    let out = run(next_frames(&backend, base.path(), &session, 1)).unwrap();
    assert_eq!(out, serde_json::json!({"posted":[1],"remaining":1}));
    assert!(
        tag_json(&backend.sent.borrow()[2].tag)
            .get("hold")
            .is_none(),
        "next = hold on"
    );
    let out = run(next_frames(&backend, base.path(), &session, 5)).unwrap();
    assert_eq!(out, serde_json::json!({"posted":[2],"remaining":0}));
    let sends = backend.sends();
    let err = run(next_frames(&backend, base.path(), &session, 1)).expect_err("exhausted");
    assert_eq!(crate::error::exit_code(&err), 7);
    assert_eq!(backend.sends(), sends);
}

#[test]
fn close_publishes_once_and_blocks_further_showings() {
    let base = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let session = opened(&backend, base.path());
    run(close_session(&backend, base.path(), &session)).unwrap();
    let sent = backend.sent.borrow()[1].clone();
    assert_eq!(
        tag_json(&sent.tag),
        serde_json::json!({"v":1,"op":"close","s":session})
    );
    assert!(sent.media_url.is_none());
    let err = run(show_frame(
        &backend,
        base.path(),
        &session,
        FrameSelector::Index(0),
        None,
        false,
    ))
    .expect_err("closed");
    assert!(err.to_string().contains("closed"));
    assert!(run(close_session(&backend, base.path(), &session)).is_err());
    assert_eq!(backend.sends(), 2);
}

// ---- state file ----

#[test]
fn state_round_trips_atomically_and_rejects_bad_ids() {
    let base = tempfile::tempdir().unwrap();
    let dir = base.path().join("nested").join("stage");
    let state = StageState {
        version: STATE_VERSION,
        session: sha(0xabc),
        channel: "c".into(),
        title: "T".into(),
        voice: false,
        palette: vec![FrameState {
            i: 0,
            label: Some("l".into()),
            text: None,
            media: BlobDescriptor {
                url: "u".into(),
                sha256: sha(1),
                size: 1,
                mime_type: "image/png".into(),
                uploaded: 0,
                dim: None,
                blurhash: None,
                thumb: None,
                duration: None,
            },
        }],
        showings: vec![ShowingState {
            event_id: sha(2),
            i: 0,
            hold: false,
            at: 5,
        }],
        closed: false,
    };
    save_state(&dir, &state).unwrap();
    assert_eq!(load_state(&dir, &state.session).unwrap(), state);
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        vec![format!("{}.json", state.session)],
        "no temp file left behind"
    );
    for bad in ["../etc/passwd", "ABC", ""] {
        assert!(load_state(&dir, bad).is_err(), "{bad}");
    }
    assert!(load_state(&dir, &sha(0xdef)).is_err(), "missing session");
}

// ---- dwell ----

#[test]
fn dwell_auto_math() {
    assert_eq!(dwell_for(Dwell::Auto, ""), Duration::from_millis(4000));
    assert_eq!(
        dwell_for(Dwell::Auto, &"x".repeat(38)),
        Duration::from_millis(4000)
    );
    // 39 × 65 + 1500 = 4035 — the first length past the floor.
    assert_eq!(
        dwell_for(Dwell::Auto, &"x".repeat(39)),
        Duration::from_millis(4035)
    );
    assert_eq!(
        dwell_for(Dwell::Auto, &"x".repeat(100)),
        Duration::from_millis(8000)
    );
    // Characters, not bytes: 100 × "é" is 200 bytes.
    assert_eq!(
        dwell_for(Dwell::Auto, &"é".repeat(100)),
        Duration::from_millis(8000)
    );
    assert_eq!(parse_dwell("auto").unwrap(), Dwell::Auto);
    assert_eq!(
        parse_dwell("2.5").unwrap(),
        Dwell::Fixed(Duration::from_millis(2500))
    );
    assert_eq!(
        dwell_for(Dwell::Fixed(Duration::from_secs(1)), &"x".repeat(500)),
        Duration::from_secs(1)
    );
    for bad in ["-1", "fast", "NaN", "4000"] {
        assert!(parse_dwell(bad).is_err(), "{bad}");
    }
}
