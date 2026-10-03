//! `buzz status set` — optional title/progress for the caller's running turn.
//!
//! The ACP harness publishes the lifecycle head (`d = turn:<channel>`, kind
//! 30624) for every channel turn. This command only writes the separate
//! `detail:<channel>` head, stamped with the lifecycle head's `turn` id so
//! clients never show a title from a previous turn against a new one
//! (phase-8 D8.2/D8.3). Outside a running turn it refuses (exit 1).

use buzz_core::kind::KIND_AGENT_TASK_STATUS;
use buzz_core::task_status::{parse_task_status, StatusNamespace, TaskState, TURN_D_PREFIX};
use buzz_sdk::task_status::{build_task_detail, TaskDetail};
use nostr::{Event, PublicKey};
use uuid::Uuid;

use crate::channel_ref::resolve_channel_uuid;
use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::read_or_stdin;

/// Parse `--progress <done>/<total>`.
pub(crate) fn parse_progress(value: &str) -> Result<(u32, u32), CliError> {
    let usage = || CliError::Usage(format!("--progress must be <done>/<total>, got '{value}'"));
    let (done, total) = value.trim().split_once('/').ok_or_else(usage)?;
    let done: u32 = done.trim().parse().map_err(|_| usage())?;
    let total: u32 = total.trim().parse().map_err(|_| usage())?;
    Ok((done, total))
}

/// Pick the current turn id from `own_heads` (the query response for this
/// author's `turn:<channel>` head). Only a `running` head qualifies; anything
/// else — no head, a terminal head, a foreign author — is exit 1.
pub(crate) fn running_turn_id(
    own_heads: &[Event],
    me: &PublicKey,
    channel: Uuid,
) -> Result<String, CliError> {
    let head = own_heads
        .iter()
        .filter(|e| &e.pubkey == me)
        .filter_map(|e| parse_task_status(e).ok().map(|h| (e.created_at, h)))
        .filter(|(_, h)| h.namespace == StatusNamespace::Turn && h.channel == channel)
        .max_by_key(|(created_at, _)| *created_at)
        .map(|(_, h)| h);
    match head {
        Some(h) if h.state == Some(TaskState::Running) => Ok(h.turn_id),
        _ => Err(CliError::Usage(
            "no running turn in this channel — `buzz status set` only works inside a turn".into(),
        )),
    }
}

/// Everything `status set` publishes, minus signing.
pub(crate) struct DetailArgs<'a> {
    pub title: Option<&'a str>,
    pub progress: Option<(u32, u32)>,
    pub note: Option<&'a str>,
}

/// Build the detail head for `turn_id`, validated by the shared core rules.
pub(crate) fn build_detail(
    channel: Uuid,
    turn_id: &str,
    args: &DetailArgs<'_>,
    created_at: u64,
) -> Result<nostr::EventBuilder, CliError> {
    if args.title.is_none() && args.progress.is_none() {
        return Err(CliError::Usage(
            "pass --title and/or --progress <done>/<total>".into(),
        ));
    }
    build_task_detail(&TaskDetail {
        channel,
        turn_id,
        title: args.title,
        progress: args.progress,
        note: args.note,
        created_at,
    })
    .map_err(|e| CliError::Usage(e.to_string()))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `buzz status set`.
pub async fn cmd_set(
    client: &BuzzClient,
    channel: &str,
    title: Option<&str>,
    progress: Option<&str>,
    note: Option<&str>,
) -> Result<(), CliError> {
    let progress = progress.map(parse_progress).transpose()?;
    let note = note.map(read_or_stdin).transpose()?;
    let title = title.map(str::trim);
    let args = DetailArgs {
        title,
        progress,
        note: note.as_deref(),
    };
    if args.title.is_none() && args.progress.is_none() {
        return Err(CliError::Usage(
            "pass --title and/or --progress <done>/<total>".into(),
        ));
    }
    let channel = resolve_channel_uuid(client, channel).await?;
    let me = client.keys().public_key();

    let filter = serde_json::json!({
        "kinds": [KIND_AGENT_TASK_STATUS],
        "authors": [me.to_hex()],
        "#d": [format!("{TURN_D_PREFIX}{channel}")],
    });
    let raw = client.query(&filter).await?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse status query: {e}")))?;
    let heads: Vec<Event> = values
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let turn_id = running_turn_id(&heads, &me, channel)?;

    let event = client.sign_event(build_detail(channel, &turn_id, &args, unix_now())?)?;
    let resp = client.submit_event(event).await?;
    let mut out: serde_json::Value = serde_json::from_str(&normalize_write_response(&resp))
        .unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = out.as_object_mut() {
        obj.insert("turn".into(), serde_json::Value::String(turn_id));
    }
    println!("{out}");
    Ok(())
}

/// Dispatch `buzz status …`.
pub async fn dispatch(cmd: crate::StatusCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        crate::StatusCmd::Job(cmd) => super::status_job::dispatch(cmd, client).await,
        crate::StatusCmd::Set {
            channel,
            title,
            progress,
            note,
        } => {
            cmd_set(
                client,
                &channel,
                title.as_deref(),
                progress.as_deref(),
                note.as_deref(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::exit_code;
    use buzz_sdk::task_status::{build_task_lifecycle, TaskLifecycle};
    use nostr::Keys;

    fn lifecycle(keys: &Keys, channel: Uuid, turn: &str, state: TaskState, at: u64) -> Event {
        build_task_lifecycle(&TaskLifecycle {
            channel,
            turn_id: turn,
            state,
            started: 1_000,
            ended: state.is_terminal().then_some(at),
            trigger: None,
            session: None,
            reason: None,
            created_at: at,
        })
        .unwrap()
        .sign_with_keys(keys)
        .unwrap()
    }

    #[test]
    fn set_refuses_without_running_turn() {
        let keys = Keys::generate();
        let ch = Uuid::new_v4();
        let me = keys.public_key();
        let none = running_turn_id(&[], &me, ch).unwrap_err();
        assert_eq!(exit_code(&none), 1);
        let done = lifecycle(&keys, ch, "t-old", TaskState::Done, 1_100);
        let err = running_turn_id(&[done], &me, ch).unwrap_err();
        assert_eq!(exit_code(&err), 1);
        assert!(err.to_string().contains("no running turn"), "{err}");
        // A running head written by someone else is not our turn.
        let foreign = lifecycle(&Keys::generate(), ch, "t-x", TaskState::Running, 1_100);
        assert_eq!(
            exit_code(&running_turn_id(&[foreign], &me, ch).unwrap_err()),
            1
        );
    }

    #[test]
    fn set_stamps_lifecycle_turn_id() {
        let keys = Keys::generate();
        let ch = Uuid::new_v4();
        let older = lifecycle(&keys, ch, "turn-old", TaskState::Done, 1_050);
        let running = lifecycle(&keys, ch, "turn-live-42", TaskState::Running, 1_100);
        let turn = running_turn_id(&[older, running], &keys.public_key(), ch).unwrap();
        assert_eq!(turn, "turn-live-42");
        let args = DetailArgs {
            title: Some("Fix composer draft loss"),
            progress: Some((2, 3)),
            note: None,
        };
        let detail = build_detail(ch, &turn, &args, 1_200)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        let head = parse_task_status(&detail).unwrap();
        assert_eq!(head.namespace, StatusNamespace::Detail);
        assert_eq!(head.turn_id, "turn-live-42");
        assert_eq!(head.progress, Some((2, 3)));
    }

    #[test]
    fn newest_lifecycle_head_wins() {
        let keys = Keys::generate();
        let ch = Uuid::new_v4();
        let running = lifecycle(&keys, ch, "t1", TaskState::Running, 1_100);
        let done = lifecycle(&keys, ch, "t1", TaskState::Done, 1_101);
        assert!(running_turn_id(&[running, done], &keys.public_key(), ch).is_err());
    }

    #[test]
    fn progress_parsing_and_bounds() {
        assert_eq!(parse_progress("2/5").unwrap(), (2, 5));
        assert_eq!(parse_progress(" 0 / 1 ").unwrap(), (0, 1));
        assert!(parse_progress("2").is_err());
        assert!(parse_progress("a/b").is_err());
        let ch = Uuid::new_v4();
        let bad = DetailArgs {
            title: None,
            progress: Some((4, 3)),
            note: None,
        };
        assert_eq!(exit_code(&build_detail(ch, "t", &bad, 1).unwrap_err()), 1);
        let empty = DetailArgs {
            title: None,
            progress: None,
            note: Some("n"),
        };
        assert_eq!(exit_code(&build_detail(ch, "t", &empty, 1).unwrap_err()), 1);
    }
}
