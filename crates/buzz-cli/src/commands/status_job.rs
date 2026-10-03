//! Independent background jobs, published under the caller's own key.

use buzz_core::kind::KIND_AGENT_TASK_STATUS;
use buzz_core::task_status::{
    parse_task_status, StatusNamespace, TaskState, TaskStatusHead, TURN_D_PREFIX,
};
use buzz_sdk::task_status::{build_task_job, job_d_tag, TaskJob};
use clap::{Args, Subcommand, ValueEnum};
use nostr::{Event, EventBuilder, PublicKey};
use uuid::Uuid;

use super::status::running_turn_id;
use crate::channel_ref::resolve_channel_uuid;
use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;

/// Commands for long background jobs. Beat at least once every five minutes.
#[derive(Subcommand)]
pub enum StatusJobCmd {
    /// Start a job; without --channel, requires exactly one fresh running turn
    Start {
        /// Channel UUID or visible name/#slug; otherwise auto-detect your turn
        #[arg(long)]
        channel: Option<String>,
        /// Job role (1..=32 lowercase letters, digits, underscores or hyphens)
        #[arg(long)]
        role: String,
        /// Model identifier, used for the Work rail engine label
        #[arg(long)]
        model: Option<String>,
        /// Readable title; whitespace collapsed and clipped to 120 characters
        #[arg(long)]
        title: Option<String>,
        /// Independent job id; generated when omitted
        #[arg(long)]
        job: Option<String>,
        /// Do not bind to the launching turn and its trigger
        #[arg(long)]
        no_bind: bool,
    },
    /// Refresh a job heartbeat; refuses after end; silent >5 min reads dropped
    Beat {
        /// Channel UUID or visible name/#slug
        #[arg(long)]
        channel: String,
        /// Job id returned by start
        #[arg(long)]
        job: String,
        /// Fallback/override fields; role and started required without a head
        #[command(flatten)]
        fields: JobFields,
    },
    /// Finish a job; repeating end is an idempotent no-op
    End {
        /// Channel UUID or visible name/#slug
        #[arg(long)]
        channel: String,
        /// Job id returned by start
        #[arg(long)]
        job: String,
        /// Terminal state
        #[arg(long)]
        state: JobEndState,
        /// Error reason; only allowed with --state error
        #[arg(long)]
        reason: Option<String>,
        /// Fallback/override fields; role and started required without a head
        #[command(flatten)]
        fields: JobFields,
    },
}

/// Fields which a beat or end can overlay on the current head.
#[derive(Args, Default)]
pub struct JobFields {
    /// Job role; required when no previous head exists
    #[arg(long)]
    pub role: Option<String>,
    /// Job start in unix seconds; required when no previous head exists
    #[arg(long)]
    pub started: Option<u64>,
    /// Model identifier
    #[arg(long)]
    pub model: Option<String>,
    /// Readable title, clipped to 120 characters
    #[arg(long)]
    pub title: Option<String>,
}

/// Terminal states accepted by `status job end`.
#[derive(Clone, Copy, ValueEnum)]
pub enum JobEndState {
    /// Normal completion.
    Done,
    /// Failure or timeout.
    Error,
    /// Cancellation.
    Cancelled,
}

impl JobEndState {
    fn task_state(self) -> TaskState {
        match self {
            Self::Done => TaskState::Done,
            Self::Error => TaskState::Error,
            Self::Cancelled => TaskState::Cancelled,
        }
    }
}

/// Normalize a title and clip by characters, reserving one for the ellipsis.
pub(crate) fn clip_title(title: &str) -> String {
    let normalized = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= 120 {
        return normalized;
    }
    let mut clipped = normalized.chars().take(119).collect::<String>();
    clipped.push('…');
    clipped
}

pub(crate) fn default_job_id(role: &str, started: u64) -> String {
    format!(
        "{role}-{started}-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    )
}

fn newest<'a>(events: impl Iterator<Item = &'a Event>) -> Option<&'a Event> {
    // NIP-01: newer timestamp, then LOWER event id on a tie.
    events.max_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| b.id.cmp(&a.id))
    })
}

/// Require one own fresh running turn, after resolving replacement heads.
pub(crate) fn auto_channel(heads: &[Event], me: &PublicKey, now: u64) -> Result<Uuid, CliError> {
    let mut channels = std::collections::HashMap::new();
    for event in heads.iter().filter(|e| &e.pubkey == me) {
        let Ok(head) = parse_task_status(event) else {
            continue;
        };
        if head.namespace != StatusNamespace::Turn {
            continue;
        }
        let previous: Option<&Event> = channels.get(&head.channel).copied();
        if newest(previous.into_iter().chain(std::iter::once(event))) == Some(event) {
            channels.insert(head.channel, event);
        }
    }
    let running: Vec<_> = channels
        .into_iter()
        .filter(|(_, event)| {
            event.created_at.as_secs() >= now.saturating_sub(180)
                && parse_task_status(event).is_ok_and(|head| head.state == Some(TaskState::Running))
        })
        .map(|(channel, _)| channel)
        .collect();
    if running.len() != 1 {
        return Err(CliError::Usage(format!(
            "pass --channel: found {} running turns",
            running.len()
        )));
    }
    Ok(running[0])
}

pub(crate) struct JobSnapshot {
    head: TaskStatusHead,
    created_at: u64,
}

fn own_job(heads: &[Event], me: &PublicKey, channel: Uuid, job: &str) -> Option<JobSnapshot> {
    let event = newest(heads.iter().filter(|event| {
        &event.pubkey == me
            && parse_task_status(event).is_ok_and(|head| {
                head.namespace == StatusNamespace::Job
                    && head.channel == channel
                    && head.job_id.as_deref() == Some(job)
            })
    }))?;
    Some(JobSnapshot {
        head: parse_task_status(event).ok()?,
        created_at: event.created_at.as_secs(),
    })
}

pub(crate) struct JobDraft {
    role: String,
    started: u64,
    state: TaskState,
    ended: Option<u64>,
    model: Option<String>,
    title: Option<String>,
    turn: Option<String>,
    trigger: Option<String>,
    reason: Option<String>,
    created_at: u64,
}

impl JobDraft {
    fn build(&self, channel: Uuid, job: &str) -> Result<EventBuilder, CliError> {
        build_task_job(&TaskJob {
            channel,
            job_id: job,
            role: &self.role,
            state: self.state,
            started: self.started,
            ended: self.ended,
            model: self.model.as_deref(),
            title: self.title.as_deref(),
            turn_id: self.turn.as_deref(),
            trigger: self.trigger.as_deref(),
            reason: self.reason.as_deref(),
            created_at: self.created_at,
        })
        .map_err(|e| CliError::Usage(e.to_string()))
    }
}

/// Merge the complete head and flags; None means end was already recorded.
pub(crate) fn advance_job(
    previous: Option<&JobSnapshot>,
    fields: &JobFields,
    state: TaskState,
    reason: Option<&str>,
    now: u64,
) -> Result<Option<JobDraft>, CliError> {
    if previous.is_some_and(|p| p.head.state.is_some_and(TaskState::is_terminal)) {
        if state == TaskState::Running {
            return Err(CliError::Usage("job already ended".into()));
        }
        return Ok(None);
    }
    let head = previous.map(|p| &p.head);
    let role = fields
        .role
        .clone()
        .or_else(|| head.and_then(|h| h.role.clone()))
        .ok_or_else(|| CliError::Usage("no job head: pass --role and --started".into()))?;
    let started = fields
        .started
        .or_else(|| head.and_then(|h| h.started))
        .ok_or_else(|| CliError::Usage("no job head: pass --role and --started".into()))?;
    let created_at = now.max(previous.map_or(0, |p| p.created_at.saturating_add(1)));
    Ok(Some(JobDraft {
        role,
        started,
        state,
        created_at,
        ended: state.is_terminal().then_some(created_at.max(started)),
        model: fields
            .model
            .clone()
            .or_else(|| head.and_then(|h| h.model.clone())),
        title: fields
            .title
            .as_deref()
            .map(clip_title)
            .or_else(|| head.and_then(|h| h.title.clone())),
        turn: head.and_then(|h| (!h.turn_id.is_empty()).then(|| h.turn_id.clone())),
        trigger: head.and_then(|h| h.trigger.clone()),
        reason: reason.map(str::to_string),
    }))
}

fn unix_now() -> u64 {
    nostr::Timestamp::now().as_secs()
}

async fn query_heads(
    client: &BuzzClient,
    filter: serde_json::Value,
) -> Result<Vec<Event>, CliError> {
    let raw = client.query(&filter).await?;
    serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse status query: {e}")))
}

async fn publish(
    client: &BuzzClient,
    builder: EventBuilder,
    fields: serde_json::Value,
) -> Result<(), CliError> {
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    let mut out: serde_json::Value = serde_json::from_str(&normalize_write_response(&resp))
        .map_err(|e| CliError::Other(format!("failed to parse status write: {e}")))?;
    if let (Some(out), Some(fields)) = (out.as_object_mut(), fields.as_object()) {
        out.extend(fields.clone());
    }
    println!("{out}");
    Ok(())
}

/// Dispatch `buzz status job …`.
pub async fn dispatch(cmd: StatusJobCmd, client: &BuzzClient) -> Result<(), CliError> {
    let me = client.keys().public_key();
    match cmd {
        StatusJobCmd::Start {
            channel,
            role,
            model,
            title,
            job,
            no_bind,
        } => {
            let now = unix_now();
            let channel = if let Some(channel) = channel {
                resolve_channel_uuid(client, &channel).await?
            } else {
                let heads = query_heads(client, serde_json::json!({ "kinds": [KIND_AGENT_TASK_STATUS], "authors": [me.to_hex()], "since": now.saturating_sub(600), "limit": 200 })).await?;
                auto_channel(&heads, &me, now)?
            };
            let job = job.unwrap_or_else(|| default_job_id(&role, now));
            let mut draft = JobDraft {
                role,
                model,
                title: title.as_deref().map(clip_title),
                started: now,
                created_at: now,
                state: TaskState::Running,
                ended: None,
                turn: None,
                trigger: None,
                reason: None,
            };
            if !no_bind {
                let query = query_heads(client, serde_json::json!({ "kinds": [KIND_AGENT_TASK_STATUS], "authors": [me.to_hex()], "#d": [format!("{TURN_D_PREFIX}{channel}")] })).await;
                match query {
                    Ok(heads) => {
                        if let Ok(turn) = running_turn_id(&heads, &me, channel) {
                            let event = newest(heads.iter().filter(|e| {
                                e.pubkey == me
                                    && parse_task_status(e).is_ok_and(|h| {
                                        h.namespace == StatusNamespace::Turn
                                            && h.channel == channel
                                            && h.turn_id == turn
                                    })
                            }));
                            draft.trigger = event
                                .and_then(|e| parse_task_status(e).ok())
                                .and_then(|h| h.trigger);
                            draft.turn = Some(turn);
                        }
                    }
                    Err(error) => eprintln!("warning: job starts without turn binding: {error}"),
                }
            }
            publish(client, draft.build(channel, &job)?, serde_json::json!({ "job": job, "channel": channel, "started": now, "turn": draft.turn })).await
        }
        StatusJobCmd::Beat {
            channel,
            job,
            fields,
        } => update(client, &channel, &job, &fields, TaskState::Running, None).await,
        StatusJobCmd::End {
            channel,
            job,
            fields,
            state,
            reason,
        } => {
            update(
                client,
                &channel,
                &job,
                &fields,
                state.task_state(),
                reason.as_deref(),
            )
            .await
        }
    }
}

async fn update(
    client: &BuzzClient,
    channel: &str,
    job: &str,
    fields: &JobFields,
    state: TaskState,
    reason: Option<&str>,
) -> Result<(), CliError> {
    let channel = resolve_channel_uuid(client, channel).await?;
    let heads = query_heads(client, serde_json::json!({ "kinds": [KIND_AGENT_TASK_STATUS], "authors": [client.keys().public_key().to_hex()], "#d": [job_d_tag(channel, job)] })).await?;
    let previous = own_job(&heads, &client.keys().public_key(), channel, job);
    let Some(draft) = advance_job(previous.as_ref(), fields, state, reason, unix_now())? else {
        println!("{}", serde_json::json!({ "job": job, "unchanged": true }));
        return Ok(());
    };
    let output = if state == TaskState::Running {
        serde_json::json!({ "job": job, "created_at": draft.created_at })
    } else {
        serde_json::json!({ "job": job, "state": state.as_str() })
    };
    publish(client, draft.build(channel, job)?, output).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::exit_code;
    use buzz_sdk::task_status::{build_task_lifecycle, TaskLifecycle};
    use nostr::Keys;

    fn turn(keys: &Keys, ch: Uuid, at: u64) -> Event {
        build_task_lifecycle(&TaskLifecycle {
            channel: ch,
            turn_id: "launch-1",
            state: TaskState::Running,
            started: 1000,
            ended: None,
            trigger: None,
            session: None,
            reason: None,
            created_at: at,
        })
        .unwrap()
        .sign_with_keys(keys)
        .unwrap()
    }
    fn snapshot(state: TaskState) -> JobSnapshot {
        let event = build_task_job(&TaskJob {
            channel: Uuid::new_v4(),
            job_id: "j1",
            role: "coder",
            state,
            started: 900,
            ended: state.is_terminal().then_some(1000),
            model: Some("gpt-6.1-sol"),
            title: Some("Fix it"),
            turn_id: Some("launch-1"),
            trigger: Some("ab".repeat(32).leak()),
            reason: None,
            created_at: 1000,
        })
        .unwrap()
        .sign_with_keys(&Keys::generate())
        .unwrap();
        JobSnapshot {
            head: parse_task_status(&event).unwrap(),
            created_at: 1000,
        }
    }
    #[test]
    fn start_auto_channel_picks_single_running_turn() {
        let keys = Keys::generate();
        let me = keys.public_key();
        let ch = Uuid::new_v4();
        assert_eq!(
            auto_channel(&[turn(&keys, ch, 1000)], &me, 1000).unwrap(),
            ch
        );
        for heads in [
            vec![],
            vec![turn(&keys, ch, 1000), turn(&keys, Uuid::new_v4(), 1000)],
            vec![turn(&keys, ch, 819)],
            vec![turn(&Keys::generate(), ch, 1000)],
        ] {
            assert_eq!(exit_code(&auto_channel(&heads, &me, 1000).unwrap_err()), 1);
        }
        assert_eq!(
            auto_channel(&[turn(&keys, ch, 820)], &me, 1000).unwrap(),
            ch
        );
    }
    #[test]
    fn beat_refuses_after_end() {
        for state in [TaskState::Done, TaskState::Error, TaskState::Cancelled] {
            let error = advance_job(
                Some(&snapshot(state)),
                &JobFields::default(),
                TaskState::Running,
                None,
                1100,
            )
            .err()
            .unwrap();
            assert_eq!(exit_code(&error), 1);
            assert!(error.to_string().contains("job already ended"));
        }
    }
    #[test]
    fn beat_created_at_is_monotonic() {
        let head = snapshot(TaskState::Running);
        for (now, at) in [(1000, 1001), (1500, 1500)] {
            let draft = advance_job(
                Some(&head),
                &JobFields::default(),
                TaskState::Running,
                None,
                now,
            )
            .unwrap()
            .unwrap();
            assert_eq!(draft.created_at, at);
            assert_eq!(draft.turn.as_deref(), Some("launch-1"));
            assert_eq!(draft.trigger, head.head.trigger);
            assert_eq!(draft.model.as_deref(), Some("gpt-6.1-sol"));
        }
    }
    #[test]
    fn beat_recreates_from_flags_without_head() {
        let fields = JobFields {
            role: Some("coder".into()),
            started: Some(900),
            ..Default::default()
        };
        let draft = advance_job(None, &fields, TaskState::Running, None, 1000)
            .unwrap()
            .unwrap();
        let event = draft
            .build(Uuid::new_v4(), "j1")
            .unwrap()
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(
            parse_task_status(&event).unwrap().state,
            Some(TaskState::Running)
        );
        assert!(advance_job(None, &JobFields::default(), TaskState::Running, None, 1000).is_err());
        assert!(advance_job(
            None,
            &JobFields {
                role: Some("coder".into()),
                ..Default::default()
            },
            TaskState::Running,
            None,
            1000
        )
        .is_err());
    }
    #[test]
    fn end_is_idempotent() {
        assert!(advance_job(
            Some(&snapshot(TaskState::Done)),
            &JobFields::default(),
            TaskState::Done,
            None,
            1100
        )
        .unwrap()
        .is_none());
        let head = snapshot(TaskState::Running);
        let fields = JobFields {
            started: Some(2000),
            title: Some("New  title".into()),
            ..Default::default()
        };
        let end = advance_job(Some(&head), &fields, TaskState::Done, None, 1100)
            .unwrap()
            .unwrap();
        assert_eq!(end.ended, Some(2000));
        assert_eq!(end.title.as_deref(), Some("New title"));
        assert!(
            advance_job(Some(&head), &fields, TaskState::Done, Some("timeout"), 1100)
                .unwrap()
                .unwrap()
                .build(head.head.channel, "j1")
                .is_err()
        );
    }
    #[test]
    fn clip_title_is_char_safe() {
        let title = clip_title(&"é".repeat(200));
        assert_eq!(title.chars().count(), 120);
        assert!(title.ends_with('…'));
        assert_eq!(clip_title("  Fix\n   it\t now "), "Fix it now");
        let fields = JobFields {
            role: Some("coder".into()),
            started: Some(900),
            title: Some(title),
            ..Default::default()
        };
        assert!(advance_job(None, &fields, TaskState::Running, None, 1000)
            .unwrap()
            .unwrap()
            .build(Uuid::new_v4(), "j1")
            .is_ok());
    }
    #[test]
    fn job_id_default_matches_charset() {
        let fields = JobFields {
            role: Some("coder".into()),
            started: Some(900),
            ..Default::default()
        };
        let draft = advance_job(None, &fields, TaskState::Running, None, 1000)
            .unwrap()
            .unwrap();
        assert!(draft
            .build(Uuid::new_v4(), &default_job_id("coder", 1000))
            .is_ok());
        assert!(draft.build(Uuid::new_v4(), "bad:id").is_err());
    }
}
