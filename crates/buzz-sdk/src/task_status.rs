//! Builders for kind-30624 agent task status heads.
//!
//! All builders assemble the tags, run them through the single wire validator
//! (`buzz_core::task_status`) and only then return an [`EventBuilder`] with the
//! caller's `created_at` pinned. A builder can therefore never emit an event
//! the relay would reject.

use buzz_core::kind::KIND_AGENT_TASK_STATUS;
use buzz_core::task_status::{
    validate_task_status_parts, TaskState, DETAIL_D_PREFIX, JOB_D_PREFIX, TURN_D_PREFIX,
};
use nostr::{EventBuilder, Kind, Tag, Timestamp};
use uuid::Uuid;

use crate::SdkError;

/// Inputs for a lifecycle (`turn:<channel>`) head.
#[derive(Debug, Clone)]
pub struct TaskLifecycle<'a> {
    /// Channel the turn runs in (`h`).
    pub channel: Uuid,
    /// Harness turn id.
    pub turn_id: &'a str,
    /// Lifecycle state.
    pub state: TaskState,
    /// Turn start, unix seconds.
    pub started: u64,
    /// Turn end, unix seconds. Required iff `state` is terminal.
    pub ended: Option<u64>,
    /// First triggering event id (64 lowercase hex).
    pub trigger: Option<&'a str>,
    /// Harness pool slot.
    pub session: Option<&'a str>,
    /// Error reason (only with `state == Error`).
    pub reason: Option<&'a str>,
    /// Event `created_at`, unix seconds.
    pub created_at: u64,
}

/// Inputs for a detail (`detail:<channel>`) head.
#[derive(Debug, Clone)]
pub struct TaskDetail<'a> {
    /// Channel of the running turn (`h`).
    pub channel: Uuid,
    /// Turn id copied from the current lifecycle head.
    pub turn_id: &'a str,
    /// Short human title.
    pub title: Option<&'a str>,
    /// `(done, total)` progress.
    pub progress: Option<(u32, u32)>,
    /// Optional note (event content).
    pub note: Option<&'a str>,
    /// Event `created_at`, unix seconds.
    pub created_at: u64,
}

fn tags_from(raw: &[Vec<String>]) -> Result<Vec<Tag>, SdkError> {
    raw.iter()
        .map(|t| {
            Tag::parse(t.iter().map(String::as_str))
                .map_err(|e| SdkError::InvalidTag(e.to_string()))
        })
        .collect()
}

/// Inputs for an independent background job (`job:<channel>:<job id>`) head.
#[derive(Debug, Clone)]
pub struct TaskJob<'a> {
    /// Channel the job runs in (`h`).
    pub channel: Uuid,
    /// Independent job id, 1..=64 ASCII characters.
    pub job_id: &'a str,
    /// Role, e.g. coder or tester.
    pub role: &'a str,
    /// Job lifecycle state.
    pub state: TaskState,
    /// Job start, unix seconds.
    pub started: u64,
    /// End time, required iff terminal.
    pub ended: Option<u64>,
    /// Optional model identifier.
    pub model: Option<&'a str>,
    /// Optional human title.
    pub title: Option<&'a str>,
    /// Optional launching turn id.
    pub turn_id: Option<&'a str>,
    /// Optional first trigger (64 lowercase hex).
    pub trigger: Option<&'a str>,
    /// Error reason, allowed only with state=error.
    pub reason: Option<&'a str>,
    /// Event timestamp; the running job's heartbeat.
    pub created_at: u64,
}

/// Addressable `d` tag for an independent job. The builder validates the id.
pub fn job_d_tag(channel: Uuid, job_id: &str) -> String {
    format!("{JOB_D_PREFIX}{channel}:{job_id}")
}

/// Build a complete replacement job head, validated before return.
pub fn build_task_job(input: &TaskJob<'_>) -> Result<EventBuilder, SdkError> {
    let mut raw = vec![
        vec!["d".into(), job_d_tag(input.channel, input.job_id)],
        vec!["h".into(), input.channel.to_string()],
        vec!["role".into(), input.role.to_string()],
        vec!["state".into(), input.state.as_str().to_string()],
        vec!["started".into(), input.started.to_string()],
    ];
    if let Some(ended) = input.ended {
        raw.push(vec!["ended".into(), ended.to_string()]);
    }
    for (name, value) in [
        ("model", input.model),
        ("title", input.title),
        ("turn", input.turn_id),
    ] {
        if let Some(value) = value {
            raw.push(vec![name.into(), value.to_string()]);
        }
    }
    if let Some(trigger) = input.trigger {
        raw.push(vec![
            "e".into(),
            trigger.into(),
            String::new(),
            "trigger".into(),
        ]);
    }
    if let Some(reason) = input.reason {
        raw.push(vec!["reason".into(), reason.into()]);
    }
    validate_task_status_parts(&raw, "").map_err(|e| SdkError::InvalidInput(e.to_string()))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_TASK_STATUS as u16), "")
            .tags(tags_from(&raw)?)
            .custom_created_at(Timestamp::from(input.created_at)),
    )
}

/// Build a lifecycle head. Validated before return.
pub fn build_task_lifecycle(input: &TaskLifecycle<'_>) -> Result<EventBuilder, SdkError> {
    let ch = input.channel.to_string();
    let mut raw: Vec<Vec<String>> = vec![
        vec!["d".into(), format!("{TURN_D_PREFIX}{ch}")],
        vec!["h".into(), ch],
        vec!["turn".into(), input.turn_id.to_string()],
        vec!["state".into(), input.state.as_str().to_string()],
        vec!["started".into(), input.started.to_string()],
    ];
    if let Some(ended) = input.ended {
        raw.push(vec!["ended".into(), ended.to_string()]);
    }
    if let Some(trigger) = input.trigger {
        raw.push(vec![
            "e".into(),
            trigger.to_string(),
            String::new(),
            "trigger".into(),
        ]);
    }
    if let Some(session) = input.session {
        raw.push(vec!["session".into(), session.to_string()]);
    }
    if let Some(reason) = input.reason {
        raw.push(vec!["reason".into(), reason.to_string()]);
    }
    validate_task_status_parts(&raw, "").map_err(|e| SdkError::InvalidInput(e.to_string()))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_TASK_STATUS as u16), "")
            .tags(tags_from(&raw)?)
            .custom_created_at(Timestamp::from(input.created_at)),
    )
}

/// Build a detail head. Validated before return.
pub fn build_task_detail(input: &TaskDetail<'_>) -> Result<EventBuilder, SdkError> {
    let ch = input.channel.to_string();
    let mut raw: Vec<Vec<String>> = vec![
        vec!["d".into(), format!("{DETAIL_D_PREFIX}{ch}")],
        vec!["h".into(), ch],
        vec!["turn".into(), input.turn_id.to_string()],
    ];
    if let Some(title) = input.title {
        raw.push(vec!["title".into(), title.to_string()]);
    }
    if let Some((done, total)) = input.progress {
        raw.push(vec!["progress".into(), done.to_string(), total.to_string()]);
    }
    let note = input.note.unwrap_or("");
    validate_task_status_parts(&raw, note).map_err(|e| SdkError::InvalidInput(e.to_string()))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_TASK_STATUS as u16), note)
            .tags(tags_from(&raw)?)
            .custom_created_at(Timestamp::from(input.created_at)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::task_status::{parse_task_status, StatusNamespace};
    use nostr::Keys;

    fn lifecycle(state: TaskState, ended: Option<u64>) -> TaskLifecycle<'static> {
        TaskLifecycle {
            channel: Uuid::parse_str("0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6").unwrap(),
            turn_id: "turn-7",
            state,
            started: 1_759_190_400,
            ended,
            trigger: Some("ab".repeat(32).leak()),
            session: Some("3"),
            reason: None,
            created_at: 1_759_190_401,
        }
    }

    #[test]
    fn build_lifecycle_roundtrips_through_core_validator() {
        let event = build_task_lifecycle(&lifecycle(TaskState::Done, Some(1_759_190_500)))
            .unwrap()
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(event.kind, Kind::Custom(30624));
        assert_eq!(event.created_at.as_secs(), 1_759_190_401);
        let head = parse_task_status(&event).unwrap();
        assert_eq!(head.namespace, StatusNamespace::Turn);
        assert_eq!(head.state, Some(TaskState::Done));
        assert_eq!(head.turn_id, "turn-7");
        assert_eq!(head.ended, Some(1_759_190_500));
        assert_eq!(head.session.as_deref(), Some("3"));
        assert_eq!(head.trigger.as_deref(), Some("ab".repeat(32).as_str()));
    }

    #[test]
    fn build_lifecycle_refuses_invalid_input() {
        assert!(build_task_lifecycle(&lifecycle(TaskState::Done, None)).is_err());
        assert!(build_task_lifecycle(&lifecycle(TaskState::Running, Some(1_759_190_500))).is_err());
    }

    #[test]
    fn build_detail_roundtrips_through_core_validator() {
        let input = TaskDetail {
            channel: Uuid::parse_str("0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6").unwrap(),
            turn_id: "turn-7",
            title: Some("Fix composer draft loss"),
            progress: Some((2, 3)),
            note: Some("halfway"),
            created_at: 1_759_190_402,
        };
        let event = build_task_detail(&input)
            .unwrap()
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let head = parse_task_status(&event).unwrap();
        assert_eq!(head.namespace, StatusNamespace::Detail);
        assert_eq!(head.title.as_deref(), Some("Fix composer draft loss"));
        assert_eq!(head.progress, Some((2, 3)));
        assert_eq!(head.note, "halfway");
        let empty = TaskDetail {
            title: None,
            progress: None,
            ..input
        };
        assert!(build_task_detail(&empty).is_err());
    }
    fn job() -> TaskJob<'static> {
        TaskJob {
            channel: Uuid::parse_str("0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6").unwrap(),
            job_id: "coder-1",
            role: "coder",
            state: TaskState::Running,
            started: 1000,
            ended: None,
            model: Some("gpt-6.1-sol"),
            title: Some("Fix it"),
            turn_id: Some("turn-1"),
            trigger: Some("ab".repeat(32).leak()),
            reason: None,
            created_at: 1001,
        }
    }

    #[test]
    fn build_job_roundtrips_through_core_validator() {
        let input = job();
        let event = build_task_job(&input)
            .unwrap()
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let head = parse_task_status(&event).unwrap();
        assert_eq!(head.namespace, StatusNamespace::Job);
        assert_eq!(head.channel, input.channel);
        assert_eq!(head.job_id.as_deref(), Some("coder-1"));
        assert_eq!(head.role.as_deref(), Some("coder"));
        assert_eq!(head.model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(head.title.as_deref(), Some("Fix it"));
        assert_eq!(head.turn_id, "turn-1");
        assert_eq!(head.trigger, input.trigger.map(str::to_string));
        assert_eq!(event.created_at.as_secs(), 1001);
        let tags: Vec<_> = event
            .tags
            .iter()
            .map(|t| t.as_slice()[0].as_str())
            .collect();
        assert_eq!(
            tags,
            ["d", "h", "role", "state", "started", "model", "title", "turn", "e"]
        );
    }

    #[test]
    fn build_job_refuses_invalid_input() {
        assert!(build_task_job(&TaskJob {
            job_id: "bad id",
            ..job()
        })
        .is_err());
        assert!(build_task_job(&TaskJob {
            ended: Some(1002),
            ..job()
        })
        .is_err());
    }
}
