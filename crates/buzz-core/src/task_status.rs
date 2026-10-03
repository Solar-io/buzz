//! Agent task status — kind `30624`, the member-readable projection of an
//! agent's turn in a channel.
//!
//! Three `d` namespaces share the kind (phase-8 design D8.2):
//!
//! - `turn:<channel uuid>` — the lifecycle head, written only by the ACP
//!   harness (`running` → `done` | `error` | `cancelled`).
//! - `detail:<channel uuid>` — an optional title/progress head, written only by
//!   `buzz status set`, bound to a lifecycle head by its `turn` id.
//! - `job:<channel uuid>:<job id>` — an independent background job,
//!   written by `buzz status job start|beat|end`.
//!
//! This module is the single validator for the wire format; the relay, the SDK
//! builders and the CLI all call [`validate_task_status_event`] (or its
//! tag-level twin [`validate_task_status_parts`]). Every rejection's `Display`
//! starts with `task-status: `; the relay prefixes `invalid: `.

use nostr::Event;
use uuid::Uuid;

use crate::kind::{event_kind_u32, KIND_AGENT_TASK_STATUS};

/// `d` prefix of the lifecycle namespace.
pub const TURN_D_PREFIX: &str = "turn:";
/// `d` prefix of the detail namespace.
pub const DETAIL_D_PREFIX: &str = "detail:";
/// `d` prefix of the independent job namespace.
pub const JOB_D_PREFIX: &str = "job:";
/// Maximum job id length (ASCII).
pub const MAX_JOB_ID_LEN: usize = 64;
/// Maximum job role length (ASCII).
pub const MAX_ROLE_LEN: usize = 32;
/// Maximum model id length (ASCII).
pub const MAX_MODEL_LEN: usize = 64;
/// Maximum `turn` id length.
pub const MAX_TURN_ID_LEN: usize = 128;
/// Maximum `session` tag length.
pub const MAX_SESSION_LEN: usize = 32;
/// Maximum `reason` tag length.
pub const MAX_REASON_LEN: usize = 64;
/// Maximum `title` length, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// Maximum detail note (`content`) size, in bytes.
pub const MAX_NOTE_BYTES: usize = 2048;
/// Maximum progress total.
pub const MAX_PROGRESS_TOTAL: u32 = 100;

/// Lifecycle state of a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskState {
    /// The turn is in flight.
    Running,
    /// The turn ended normally.
    Done,
    /// The turn failed, timed out, or its harness died.
    Error,
    /// The turn was cancelled.
    Cancelled,
}

impl TaskState {
    /// Wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Running => "running",
            TaskState::Done => "done",
            TaskState::Error => "error",
            TaskState::Cancelled => "cancelled",
        }
    }

    /// Parse the wire spelling. Unknown values are `None` — never coerced.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "running" => Some(TaskState::Running),
            "done" => Some(TaskState::Done),
            "error" => Some(TaskState::Error),
            "cancelled" => Some(TaskState::Cancelled),
            _ => None,
        }
    }

    /// `true` for every state except `running`.
    pub fn is_terminal(self) -> bool {
        self != TaskState::Running
    }
}

/// Which `d` namespace a status event belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatusNamespace {
    /// `turn:<channel>` — lifecycle, harness-written.
    Turn,
    /// `detail:<channel>` — title/progress, CLI-written.
    Detail,
    /// `job:<channel>:<job id>` — independent background job, CLI-written.
    Job,
}

/// A validated, parsed kind-30624 head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStatusHead {
    /// Namespace of the `d` tag.
    pub namespace: StatusNamespace,
    /// Channel (`h`, equal to the channel part of `d`).
    pub channel: Uuid,
    /// Job id for job heads only.
    pub job_id: Option<String>,
    /// Job role for job heads only.
    pub role: Option<String>,
    /// Optional model id for job heads only.
    pub model: Option<String>,
    /// Turn id binding lifecycle and detail; launching turn for job heads.
    /// Empty when the job is unbound.
    pub turn_id: String,
    /// Lifecycle state (turn and job heads).
    pub state: Option<TaskState>,
    /// Turn or job start, unix seconds.
    pub started: Option<u64>,
    /// Turn or job end, unix seconds (terminal heads only).
    pub ended: Option<u64>,
    /// First triggering event id (turn and job heads).
    pub trigger: Option<String>,
    /// Harness pool slot (turn heads only).
    pub session: Option<String>,
    /// Error reason (turn or job heads with `state=error` only).
    pub reason: Option<String>,
    /// Human title (detail or job heads).
    pub title: Option<String>,
    /// `(done, total)` progress (detail heads only).
    pub progress: Option<(u32, u32)>,
    /// Free-form note (detail `content`).
    pub note: String,
}

/// A kind-30624 rejection. `Display` is `task-status: <rule>`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("task-status: {0}")]
pub struct TaskStatusError(pub String);

fn err<T>(msg: impl Into<String>) -> Result<T, TaskStatusError> {
    Err(TaskStatusError(msg.into()))
}

fn is_turn_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TURN_ID_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_unix_secs(name: &str, value: &str) -> Result<u64, TaskStatusError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return err(format!("`{name}` must be unix seconds"));
    }
    value
        .parse::<u64>()
        .map_err(|_| TaskStatusError(format!("`{name}` must be unix seconds")))
}

fn parse_count(value: &str) -> Result<u32, TaskStatusError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return err("`progress` values must be non-negative integers");
    }
    value
        .parse::<u32>()
        .map_err(|_| TaskStatusError("`progress` values must be non-negative integers".into()))
}

/// Collects every value slice of tags named `name`.
fn tags_named<'a>(tags: &'a [Vec<String>], name: &str) -> Vec<&'a [String]> {
    tags.iter()
        .filter(|t| t.first().map(String::as_str) == Some(name))
        .map(|t| &t[1..])
        .collect()
}

/// Exactly one tag named `name` with a non-empty first value.
fn exactly_one<'a>(tags: &'a [Vec<String>], name: &str) -> Result<&'a str, TaskStatusError> {
    let found = tags_named(tags, name);
    match found.as_slice() {
        [values] => match values.first() {
            Some(v) => Ok(v.as_str()),
            None => err(format!("`{name}` tag has no value")),
        },
        _ => err(format!(
            "exactly one `{name}` tag is required (got {})",
            found.len()
        )),
    }
}

/// At most one tag named `name`.
fn at_most_one<'a>(
    tags: &'a [Vec<String>],
    name: &str,
) -> Result<Option<&'a [String]>, TaskStatusError> {
    let found = tags_named(tags, name);
    match found.as_slice() {
        [] => Ok(None),
        [values] => Ok(Some(values)),
        _ => err(format!("at most one `{name}` tag is allowed")),
    }
}

fn first_value<'a>(values: &'a [String], name: &str) -> Result<&'a str, TaskStatusError> {
    values
        .first()
        .map(String::as_str)
        .ok_or_else(|| TaskStatusError(format!("`{name}` tag has no value")))
}

struct LifecycleFields {
    state: TaskState,
    started: u64,
    ended: Option<u64>,
    trigger: Option<String>,
    reason: Option<String>,
}

fn parse_lifecycle_fields(tags: &[Vec<String>]) -> Result<LifecycleFields, TaskStatusError> {
    let state = TaskState::parse(exactly_one(tags, "state")?).ok_or_else(|| {
        TaskStatusError("`state` must be running, done, error or cancelled".into())
    })?;
    let started = parse_unix_secs("started", exactly_one(tags, "started")?)?;
    let ended = match (state, at_most_one(tags, "ended")?) {
        (TaskState::Running, Some(_)) => return err("`ended` must be absent while running"),
        (TaskState::Running, None) => None,
        (_, None) => return err("`ended` is required when the state is terminal"),
        (_, Some(values)) => {
            let ended = parse_unix_secs("ended", first_value(values, "ended")?)?;
            if ended < started {
                return err("`ended` must not precede `started`");
            }
            Some(ended)
        }
    };
    let trigger = match at_most_one(tags, "e")? {
        None => None,
        Some(values) => {
            let id = first_value(values, "e")?;
            if !is_lower_hex_64(id) {
                return err("`e` trigger must be 64 lowercase hex chars");
            }
            Some(id.to_string())
        }
    };
    let reason = match at_most_one(tags, "reason")? {
        None => None,
        Some(values) => {
            if state != TaskState::Error {
                return err("`reason` is only allowed with state=error");
            }
            let r = first_value(values, "reason")?;
            if r.is_empty() || r.len() > MAX_REASON_LEN {
                return err(format!("`reason` must be 1..={MAX_REASON_LEN} chars"));
            }
            Some(r.to_string())
        }
    };
    Ok(LifecycleFields {
        state,
        started,
        ended,
        trigger,
        reason,
    })
}

fn parse_title(tags: &[Vec<String>]) -> Result<Option<String>, TaskStatusError> {
    match at_most_one(tags, "title")? {
        None => Ok(None),
        Some(values) => {
            let t = first_value(values, "title")?;
            if t.is_empty() || t.chars().count() > MAX_TITLE_CHARS {
                return err(format!("`title` must be 1..={MAX_TITLE_CHARS} chars"));
            }
            Ok(Some(t.to_string()))
        }
    }
}

/// Validate and parse kind-30624 tags and content.
///
/// Tag-level twin of [`parse_task_status`], used by builders that validate
/// before signing. Unknown tags are ignored for forward compatibility.
pub fn parse_task_status_parts(
    tags: &[Vec<String>],
    content: &str,
) -> Result<TaskStatusHead, TaskStatusError> {
    let d = exactly_one(tags, "d")?;
    let (namespace, d_channel, job_id) = if let Some(rest) = d.strip_prefix(TURN_D_PREFIX) {
        (StatusNamespace::Turn, rest, None)
    } else if let Some(rest) = d.strip_prefix(DETAIL_D_PREFIX) {
        (StatusNamespace::Detail, rest, None)
    } else if let Some(rest) = d.strip_prefix(JOB_D_PREFIX) {
        let (channel, job_id) = rest.split_once(':').ok_or_else(|| {
            TaskStatusError(
                "`d` must be `turn:<uuid>`, `detail:<uuid>` or `job:<uuid>:<job id>`".into(),
            )
        })?;
        if job_id.is_empty()
            || job_id.len() > MAX_JOB_ID_LEN
            || !job_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return err(format!(
                "job id must be 1..={MAX_JOB_ID_LEN} chars of [A-Za-z0-9._-]"
            ));
        }
        (StatusNamespace::Job, channel, Some(job_id.to_string()))
    } else {
        return err("`d` must be `turn:<uuid>`, `detail:<uuid>` or `job:<uuid>:<job id>`");
    };

    let h = exactly_one(tags, "h")?;
    let channel =
        Uuid::parse_str(h).map_err(|_| TaskStatusError("`h` must be a channel UUID".into()))?;
    if d_channel != h {
        return err("`d` channel must equal `h`");
    }

    let turn_id = if namespace == StatusNamespace::Job {
        at_most_one(tags, "turn")?
            .map(|v| first_value(v, "turn"))
            .transpose()?
    } else {
        Some(exactly_one(tags, "turn")?)
    };
    if turn_id.is_some_and(|id| !is_turn_id(id)) {
        return err(format!(
            "`turn` must be 1..={MAX_TURN_ID_LEN} chars of [A-Za-z0-9._:-]"
        ));
    }

    let mut head = TaskStatusHead {
        namespace,
        channel,
        turn_id: turn_id.unwrap_or("").to_string(),
        job_id,
        role: None,
        model: None,
        state: None,
        started: None,
        ended: None,
        trigger: None,
        session: None,
        reason: None,
        title: None,
        progress: None,
        note: String::new(),
    };

    match namespace {
        StatusNamespace::Turn => {
            if !tags_named(tags, "title").is_empty() || !tags_named(tags, "progress").is_empty() {
                return err("lifecycle heads must not carry `title` or `progress`");
            }
            if !content.is_empty() {
                return err("lifecycle heads must have empty content");
            }
            let session = match at_most_one(tags, "session")? {
                None => None,
                Some(values) => {
                    let s = first_value(values, "session")?;
                    if s.is_empty() || s.len() > MAX_SESSION_LEN {
                        return err(format!("`session` must be 1..={MAX_SESSION_LEN} chars"));
                    }
                    Some(s.to_string())
                }
            };
            let fields = parse_lifecycle_fields(tags)?;
            head.state = Some(fields.state);
            head.started = Some(fields.started);
            head.ended = fields.ended;
            head.trigger = fields.trigger;
            head.session = session;
            head.reason = fields.reason;
        }
        StatusNamespace::Job => {
            if !content.is_empty() {
                return err("job heads must have empty content");
            }
            for forbidden in ["progress", "session"] {
                if !tags_named(tags, forbidden).is_empty() {
                    return err(format!("job heads must not carry `{forbidden}`"));
                }
            }
            let role = exactly_one(tags, "role")?;
            if role.is_empty()
                || role.len() > MAX_ROLE_LEN
                || !role.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                })
            {
                return err(format!(
                    "`role` must be 1..={MAX_ROLE_LEN} chars of [a-z0-9_-]"
                ));
            }
            let model = at_most_one(tags, "model")?
                .map(|v| first_value(v, "model"))
                .transpose()?;
            if model.is_some_and(|m| {
                m.is_empty()
                    || m.len() > MAX_MODEL_LEN
                    || !m.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-')
                    })
            }) {
                return err(format!(
                    "`model` must be 1..={MAX_MODEL_LEN} chars of [A-Za-z0-9._:/-]"
                ));
            }
            let fields = parse_lifecycle_fields(tags)?;
            head.state = Some(fields.state);
            head.started = Some(fields.started);
            head.ended = fields.ended;
            head.trigger = fields.trigger;
            head.reason = fields.reason;
            head.role = Some(role.to_string());
            head.model = model.map(str::to_string);
            head.title = parse_title(tags)?;
        }
        StatusNamespace::Detail => {
            for lifecycle_only in ["state", "started", "ended", "reason"] {
                if !tags_named(tags, lifecycle_only).is_empty() {
                    return err(format!(
                        "detail heads must not carry `{lifecycle_only}` (lifecycle belongs to turn:)"
                    ));
                }
            }
            if content.len() > MAX_NOTE_BYTES {
                return err(format!("note exceeds {MAX_NOTE_BYTES} bytes"));
            }
            let title = parse_title(tags)?;
            let progress = match at_most_one(tags, "progress")? {
                None => None,
                Some(values) => {
                    if values.len() != 2 {
                        return err("`progress` must be [\"progress\", <done>, <total>]");
                    }
                    let done = parse_count(&values[0])?;
                    let total = parse_count(&values[1])?;
                    if total == 0 || total > MAX_PROGRESS_TOTAL {
                        return err(format!("`progress` total must be 1..={MAX_PROGRESS_TOTAL}"));
                    }
                    if done > total {
                        return err("`progress` done must not exceed total");
                    }
                    Some((done, total))
                }
            };
            if title.is_none() && progress.is_none() {
                return err("detail heads require `title` or `progress`");
            }
            head.title = title;
            head.progress = progress;
            head.note = content.to_string();
        }
    }
    Ok(head)
}

/// Validate kind-30624 tags and content without parsing into a head.
pub fn validate_task_status_parts(
    tags: &[Vec<String>],
    content: &str,
) -> Result<(), TaskStatusError> {
    parse_task_status_parts(tags, content).map(|_| ())
}

fn event_tags(event: &Event) -> Vec<Vec<String>> {
    event.tags.iter().map(|t| t.as_slice().to_vec()).collect()
}

/// Parse a signed kind-30624 event into its head.
pub fn parse_task_status(event: &Event) -> Result<TaskStatusHead, TaskStatusError> {
    if event_kind_u32(event) != KIND_AGENT_TASK_STATUS {
        return err(format!("expected kind {KIND_AGENT_TASK_STATUS}"));
    }
    parse_task_status_parts(&event_tags(event), &event.content)
}

/// Validate a signed kind-30624 event. The relay's ingest gate.
pub fn validate_task_status_event(event: &Event) -> Result<(), TaskStatusError> {
    parse_task_status(event).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::is_parameterized_replaceable;

    const CH_A: &str = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
    const CH_B: &str = "1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d";

    fn tag(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn lifecycle(state: &str, ended: Option<&str>) -> Vec<Vec<String>> {
        let mut tags = vec![
            tag(&["d", &format!("turn:{CH_A}")]),
            tag(&["h", CH_A]),
            tag(&["turn", "turn-1"]),
            tag(&["state", state]),
            tag(&["started", "1759190400"]),
        ];
        if let Some(e) = ended {
            tags.push(tag(&["ended", e]));
        }
        tags
    }

    fn detail(extra: &[Vec<String>]) -> Vec<Vec<String>> {
        let mut tags = vec![
            tag(&["d", &format!("detail:{CH_A}")]),
            tag(&["h", CH_A]),
            tag(&["turn", "turn-1"]),
        ];
        tags.extend_from_slice(extra);
        tags
    }

    #[test]
    fn kind_is_addressable_30624() {
        assert_eq!(KIND_AGENT_TASK_STATUS, 30624);
        assert!(is_parameterized_replaceable(KIND_AGENT_TASK_STATUS));
    }

    #[test]
    fn accepts_running_and_terminal_lifecycle() {
        let head = parse_task_status_parts(&lifecycle("running", None), "").unwrap();
        assert_eq!(head.namespace, StatusNamespace::Turn);
        assert_eq!(head.state, Some(TaskState::Running));
        assert_eq!(head.started, Some(1_759_190_400));
        assert_eq!(head.ended, None);
        let head = parse_task_status_parts(&lifecycle("done", Some("1759190500")), "").unwrap();
        assert_eq!(head.state, Some(TaskState::Done));
        assert_eq!(head.ended, Some(1_759_190_500));
    }

    #[test]
    fn rejects_d_channel_mismatch() {
        let mut tags = lifecycle("running", None);
        tags[1] = tag(&["h", CH_B]);
        let e = parse_task_status_parts(&tags, "").unwrap_err();
        assert_eq!(e.to_string(), "task-status: `d` channel must equal `h`");
    }

    #[test]
    fn requires_h_tag() {
        // An h-less head would be stored channel-less, i.e. readable by
        // anyone. Both namespaces must refuse it.
        let mut tags = lifecycle("running", None);
        tags.retain(|t| t[0] != "h");
        let e = parse_task_status_parts(&tags, "").unwrap_err();
        assert_eq!(
            e.to_string(),
            "task-status: exactly one `h` tag is required (got 0)"
        );
        let mut tags = detail(&[tag(&["title", "t"])]);
        tags.retain(|t| t[0] != "h");
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn rejects_non_uuid_h() {
        let mut tags = lifecycle("running", None);
        tags[0] = tag(&["d", "turn:general"]);
        tags[1] = tag(&["h", "general"]);
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn rejects_ended_while_running() {
        let e = parse_task_status_parts(&lifecycle("running", Some("1759190500")), "").unwrap_err();
        assert!(e.to_string().contains("absent while running"), "{e}");
    }

    #[test]
    fn requires_ended_when_terminal() {
        for state in ["done", "error", "cancelled"] {
            let e = parse_task_status_parts(&lifecycle(state, None), "").unwrap_err();
            assert!(
                e.to_string()
                    .contains("required when the state is terminal"),
                "{e}"
            );
        }
    }

    #[test]
    fn rejects_unknown_state_and_bad_turn_id() {
        assert!(parse_task_status_parts(&lifecycle("paused", None), "").is_err());
        let mut tags = lifecycle("running", None);
        tags[2] = tag(&["turn", "has space"]);
        assert!(parse_task_status_parts(&tags, "").is_err());
        tags[2] = tag(&["turn", &"x".repeat(129)]);
        assert!(parse_task_status_parts(&tags, "").is_err());
        tags[2] = tag(&["turn", &"x".repeat(128)]);
        assert!(parse_task_status_parts(&tags, "").is_ok());
    }

    #[test]
    fn reason_only_with_error() {
        let mut tags = lifecycle("done", Some("1759190500"));
        tags.push(tag(&["reason", "harness-restart"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = lifecycle("error", Some("1759190500"));
        tags.push(tag(&["reason", "harness-restart"]));
        let head = parse_task_status_parts(&tags, "").unwrap();
        assert_eq!(head.reason.as_deref(), Some("harness-restart"));
    }

    #[test]
    fn rejects_duplicate_h_and_bad_trigger() {
        let mut tags = lifecycle("running", None);
        tags.push(tag(&["h", CH_A]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = lifecycle("running", None);
        tags.push(tag(&["e", "ABCDEF"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn rejects_progress_done_gt_total() {
        let e = parse_task_status_parts(&detail(&[tag(&["progress", "4", "3"])]), "").unwrap_err();
        assert!(e.to_string().contains("done must not exceed total"), "{e}");
        assert!(parse_task_status_parts(&detail(&[tag(&["progress", "3", "3"])]), "").is_ok());
    }

    #[test]
    fn rejects_total_zero() {
        assert!(parse_task_status_parts(&detail(&[tag(&["progress", "0", "0"])]), "").is_err());
        assert!(parse_task_status_parts(&detail(&[tag(&["progress", "0", "101"])]), "").is_err());
        assert!(parse_task_status_parts(&detail(&[tag(&["progress", "0", "100"])]), "").is_ok());
        assert!(parse_task_status_parts(&detail(&[tag(&["progress", "0", "1"])]), "").is_ok());
    }

    #[test]
    fn detail_requires_title_or_progress() {
        let e = parse_task_status_parts(&detail(&[]), "just a note").unwrap_err();
        assert_eq!(
            e.to_string(),
            "task-status: detail heads require `title` or `progress`"
        );
        let head = parse_task_status_parts(&detail(&[tag(&["title", "Fix it"])]), "note").unwrap();
        assert_eq!(head.title.as_deref(), Some("Fix it"));
        assert_eq!(head.note, "note");
    }

    #[test]
    fn title_and_note_bounds() {
        let t120 = "é".repeat(120);
        assert!(parse_task_status_parts(&detail(&[tag(&["title", &t120])]), "").is_ok());
        let t121 = "é".repeat(121);
        assert!(parse_task_status_parts(&detail(&[tag(&["title", &t121])]), "").is_err());
        let ok = detail(&[tag(&["title", "t"])]);
        assert!(parse_task_status_parts(&ok, &"n".repeat(2048)).is_ok());
        assert!(parse_task_status_parts(&ok, &"n".repeat(2049)).is_err());
    }

    #[test]
    fn namespaces_do_not_cross() {
        let mut tags = detail(&[tag(&["title", "t"])]);
        tags.push(tag(&["state", "running"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = lifecycle("running", None);
        tags.push(tag(&["title", "t"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        assert!(parse_task_status_parts(&lifecycle("running", None), "content").is_err());
    }
    fn job(state: &str, ended: Option<&str>) -> Vec<Vec<String>> {
        let mut tags = lifecycle(state, ended);
        tags[0] = tag(&["d", &format!("job:{CH_A}:j1")]);
        tags.retain(|t| t[0] != "turn");
        tags.push(tag(&["role", "coder"]));
        tags
    }

    #[test]
    fn accepts_job_running_and_terminal() {
        let mut tags = job("running", None);
        tags.push(tag(&["model", "gpt-6.1-sol"]));
        tags.push(tag(&["title", "Fix stash restore"]));
        let head = parse_task_status_parts(&tags, "").unwrap();
        assert_eq!(head.namespace, StatusNamespace::Job);
        assert_eq!(head.job_id.as_deref(), Some("j1"));
        assert_eq!(head.role.as_deref(), Some("coder"));
        assert_eq!(head.model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(head.title.as_deref(), Some("Fix stash restore"));
        assert_eq!(head.turn_id, "");
        assert_eq!(head.state, Some(TaskState::Running));
        for state in ["done", "error", "cancelled"] {
            let head = parse_task_status_parts(&job(state, Some("1759190500")), "").unwrap();
            assert_eq!(head.state, TaskState::parse(state));
            assert_eq!(head.ended, Some(1_759_190_500));
        }
    }

    #[test]
    fn job_d_channel_must_equal_h() {
        let mut tags = job("running", None);
        tags[1] = tag(&["h", CH_B]);
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn job_id_bounds_and_charset() {
        for id in [
            "".to_string(),
            "a:b".into(),
            "has space".into(),
            "x".repeat(65),
            "a\n".into(),
        ] {
            let mut tags = job("running", None);
            tags[0] = tag(&["d", &format!("job:{CH_A}:{id}")]);
            assert!(parse_task_status_parts(&tags, "").is_err(), "{id:?}");
        }
        let mut tags = job("running", None);
        tags[0] = tag(&["d", &format!("job:{CH_A}:{}", "x".repeat(64))]);
        assert!(parse_task_status_parts(&tags, "").is_ok());
    }

    #[test]
    fn job_requires_role() {
        let mut tags = job("running", None);
        tags.retain(|t| t[0] != "role");
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn job_role_charset() {
        for role in [
            "".to_string(),
            "Coder!".into(),
            "x".repeat(33),
            "coder\n".into(),
        ] {
            let mut tags = job("running", None);
            tags.retain(|t| t[0] != "role");
            tags.push(tag(&["role", &role]));
            assert!(parse_task_status_parts(&tags, "").is_err(), "{role:?}");
        }
        let mut tags = job("running", None);
        tags.push(tag(&["role", "tester"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn job_lifecycle_rules_match_turn() {
        for tags in [
            job("running", Some("1759190500")),
            job("done", None),
            job("done", Some("1")),
            job("paused", None),
        ] {
            assert!(parse_task_status_parts(&tags, "").is_err());
        }
        let mut tags = job("done", Some("1759190500"));
        tags.push(tag(&["reason", "timeout"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = job("error", Some("1759190500"));
        tags.push(tag(&["reason", "timeout"]));
        assert_eq!(
            parse_task_status_parts(&tags, "")
                .unwrap()
                .reason
                .as_deref(),
            Some("timeout")
        );
    }

    #[test]
    fn job_rejects_progress_session_content() {
        for extra in [tag(&["progress", "1", "3"]), tag(&["session", "0"])] {
            let mut tags = job("running", None);
            tags.push(extra);
            assert!(parse_task_status_parts(&tags, "").is_err());
        }
        assert!(parse_task_status_parts(&job("running", None), "note").is_err());
    }

    #[test]
    fn job_turn_optional_but_valid() {
        assert!(parse_task_status_parts(&job("running", None), "").is_ok());
        let mut tags = job("running", None);
        tags.push(tag(&["turn", "launch:1"]));
        tags.push(tag(&["e", &"ab".repeat(32), "", "trigger"]));
        let head = parse_task_status_parts(&tags, "").unwrap();
        assert_eq!(head.turn_id, "launch:1");
        assert_eq!(head.trigger.as_deref(), Some("ab".repeat(32).as_str()));
        tags.push(tag(&["turn", "launch:2"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = job("running", None);
        tags.push(tag(&["turn", "bad id"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn job_model_and_title_bounds() {
        for model in [
            "".to_string(),
            "bad id".into(),
            "x".repeat(65),
            "gpt\n".into(),
        ] {
            let mut tags = job("running", None);
            tags.push(tag(&["model", &model]));
            assert!(parse_task_status_parts(&tags, "").is_err());
        }
        let mut tags = job("running", None);
        tags.push(tag(&["model", &"x".repeat(64)]));
        tags.push(tag(&["title", &"é".repeat(120)]));
        assert!(parse_task_status_parts(&tags, "").is_ok());
        tags.push(tag(&["model", "gpt"]));
        assert!(parse_task_status_parts(&tags, "").is_err());
        let mut tags = job("running", None);
        tags.push(tag(&["title", &"é".repeat(121)]));
        assert!(parse_task_status_parts(&tags, "").is_err());
    }

    #[test]
    fn turn_and_detail_unchanged() {
        let mut tags = lifecycle("running", None);
        tags.push(tag(&["session", "3"]));
        let turn = parse_task_status_parts(&tags, "").unwrap();
        assert_eq!(turn.namespace, StatusNamespace::Turn);
        assert_eq!(turn.turn_id, "turn-1");
        assert_eq!(turn.state, Some(TaskState::Running));
        assert_eq!(turn.session.as_deref(), Some("3"));
        assert_eq!(turn.job_id, None);
        let detail = parse_task_status_parts(
            &detail(&[tag(&["title", "Fix it"]), tag(&["progress", "2", "3"])]),
            "note",
        )
        .unwrap();
        assert_eq!(detail.namespace, StatusNamespace::Detail);
        assert_eq!(detail.turn_id, "turn-1");
        assert_eq!(detail.title.as_deref(), Some("Fix it"));
        assert_eq!(detail.progress, Some((2, 3)));
        assert_eq!(detail.note, "note");
        assert_eq!(detail.state, None);
    }
}
