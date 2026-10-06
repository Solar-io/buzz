//! Resume journal: re-deliver a channel's turn when its session dies while
//! background work is still outstanding.
//!
//! Claude Code wakes itself when a background subagent or shell finishes —
//! but only while its ACP session is alive. A respawn (idle timeout, exit,
//! quota flip), a harness restart or an app restart kills the session and its
//! background children, and nothing woke the seat again. This journal records,
//! per channel, the request a turn was answering plus any background work that
//! turn (or an earlier one on the same session) left running. When the session
//! is lost, the channel gets ONE resume turn framed by
//! [`CancelReason::Resume`](crate::queue::CancelReason::Resume).
//!
//! Only channels with outstanding background work are ever resumed (Sam,
//! 2026-10-06): a background subagent holding the turn open, or a live AIR
//! async task (`async_task_spawned` without a terminal
//! `async_task_state_update`). An ordinary turn cut off mid-flight keeps
//! today's in-process requeue behaviour and is never written to disk.
//!
//! Same storage discipline as [`crate::auth_parking`]: one JSON file per agent,
//! atomic temp-file + rename writes, a corrupt or missing file is logged and
//! treated as empty. `BUZZ_ACP_RESUME=0` disables the feature entirely (no
//! file, no replay); `BUZZ_ACP_RESUME_FILE` overrides the path.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth_parking::SavedEvent;
use crate::pool::PromptOutcome;
use crate::queue::{BatchEvent, CancelReason, FlushBatch};

/// Entries whose last recorded activity is older than this are dropped
/// (equals the 12 h max turn duration).
pub(crate) const RESUME_TTL_SECS: u64 = 12 * 60 * 60;
/// At most this many resume turns per take (one startup, or one respawn).
pub(crate) const MAX_RESUMES_PER_TAKE: usize = 3;
/// An entry already resumed this many times is dropped instead: a resumed
/// turn that keeps killing the harness must not loop.
pub(crate) const MAX_RESUME_ATTEMPTS: u32 = 2;
/// Startup resume batches are spread over this window, keyed by the agent's
/// pubkey, so a fleet restart does not fire every resume at once.
pub(crate) const STARTUP_JITTER_SECS: u64 = 90;

/// Resolve the journal path from explicit values (pure, for tests).
///
/// `enabled` is the raw `BUZZ_ACP_RESUME` value: `0`/`false`/`off`/`no`
/// disable the feature. `file` is `BUZZ_ACP_RESUME_FILE`.
fn resolve_path(
    enabled: Option<&str>,
    file: Option<&str>,
    home: Option<&str>,
    pubkey: &str,
) -> Option<PathBuf> {
    if enabled.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    }) {
        return None;
    }
    file.filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.map(|home| {
                PathBuf::from(home)
                    .join(".buzz/WORKING_STATE/resume")
                    .join(format!("{pubkey}.json"))
            })
        })
}

/// Journal path for this agent, or `None` when `BUZZ_ACP_RESUME=0`.
pub(crate) fn path_for_agent(pubkey: &str) -> Option<PathBuf> {
    resolve_path(
        std::env::var("BUZZ_ACP_RESUME").ok().as_deref(),
        std::env::var("BUZZ_ACP_RESUME_FILE").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
        pubkey,
    )
}

/// Deterministic per-agent startup delay in `[0, STARTUP_JITTER_SECS)`.
pub(crate) fn startup_jitter(pubkey: &str) -> Duration {
    // FNV-1a: stable across builds and processes (std's hasher is seeded).
    let hash = pubkey.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    Duration::from_secs(hash % STARTUP_JITTER_SECS)
}

/// One piece of background work recorded for a channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BackgroundTask {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tool_call_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    channel_id: Uuid,
    /// The original signed events of the channel's latest dispatched batch.
    events: Vec<SavedEvent>,
    /// Live AIR async tasks (background shells, workflows) on the channel's
    /// session.
    #[serde(default)]
    tasks: Vec<BackgroundTask>,
    /// Background subagents the current turn launched. The adapter holds the
    /// prompt open while they run, so these clear when the turn ends.
    #[serde(default)]
    subagents: Vec<BackgroundTask>,
    /// Unix seconds of the latest recorded activity (TTL clock).
    recorded_at: u64,
    /// How many resume turns this entry has already been given.
    #[serde(default)]
    resumes: u32,
    /// A resume turn was handed out and has not completed yet. Keeps the
    /// entry durable through a crash during that turn (crash-loop guard).
    #[serde(default)]
    resume_pending: bool,
    /// The rendered "work that was stopped" section for the resume turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// A turn for this channel is running now. Memory only.
    #[serde(skip)]
    in_turn: bool,
}

impl Entry {
    fn new(channel_id: Uuid, now: u64) -> Self {
        Self {
            channel_id,
            events: Vec::new(),
            tasks: Vec::new(),
            subagents: Vec::new(),
            recorded_at: now,
            resumes: 0,
            resume_pending: false,
            note: None,
            in_turn: false,
        }
    }

    /// Whether this entry must survive a process death.
    fn durable(&self) -> bool {
        !self.tasks.is_empty() || !self.subagents.is_empty() || self.resume_pending
    }

    fn render_note(&self) -> Option<String> {
        let work: Vec<String> = self
            .subagents
            .iter()
            .map(|t| format!("- background subagent: {}", t.title))
            .chain(self.tasks.iter().map(|t| match &t.output_file {
                Some(path) => format!("- {} (output: {path})", t.title),
                None => format!("- {}", t.title),
            }))
            .collect();
        (!work.is_empty()).then(|| {
            format!(
                "[Background work stopped by the restart]\n{}",
                work.join("\n")
            )
        })
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    entries: Vec<Entry>,
}

struct JournalState {
    path: PathBuf,
    entries: HashMap<Uuid, Entry>,
    /// Channels whose session died in this process (slot respawn), awaiting
    /// [`ResumeJournal::take_lost`].
    lost: HashSet<Uuid>,
}

impl JournalState {
    fn persist(&self) {
        let mut entries: Vec<Entry> = self
            .entries
            .values()
            .filter(|e| e.durable())
            .cloned()
            .collect();
        entries.sort_by_key(|e| e.channel_id);
        if entries.is_empty() {
            // Nothing outstanding: leave no file behind (and create none).
            if let Err(error) = std::fs::remove_file(&self.path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(%error, path = %self.path.display(), "could not remove empty resume journal");
                }
            }
            return;
        }
        let path = &self.path;
        let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| -> anyhow::Result<()> {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)?;
            }
            let bytes = serde_json::to_vec(&Persisted { entries })?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temp, path)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temp);
            tracing::error!(%error, path = %path.display(), "could not persist resume journal");
        }
    }

    /// Turn candidate entries into resume batches, applying TTL, the
    /// crash-loop guard and the per-take cap. Persists once.
    fn take(&mut self, candidates: Vec<Uuid>, now: u64) -> Vec<FlushBatch> {
        let mut live: Vec<Uuid> = Vec::new();
        for ch in candidates {
            let Some(entry) = self.entries.get(&ch) else {
                continue;
            };
            if !entry.durable() {
                continue;
            }
            if now.saturating_sub(entry.recorded_at) >= RESUME_TTL_SECS {
                tracing::warn!(channel_id = %ch, recorded_at = entry.recorded_at, "resume: dropping expired entry");
                self.entries.remove(&ch);
            } else if entry.resumes >= MAX_RESUME_ATTEMPTS {
                tracing::warn!(channel_id = %ch, resumes = entry.resumes, "resume: dropping entry after repeated resumes (crash-loop guard)");
                self.entries.remove(&ch);
            } else if entry.events.is_empty() {
                tracing::warn!(channel_id = %ch, "resume: dropping entry with no request to resume");
                self.entries.remove(&ch);
            } else {
                live.push(ch);
            }
        }
        // Newest first; ties broken by channel id so the order is stable.
        live.sort_by_key(|ch| (std::cmp::Reverse(self.entries[ch].recorded_at), *ch));
        for ch in live.split_off(live.len().min(MAX_RESUMES_PER_TAKE)) {
            tracing::warn!(channel_id = %ch, cap = MAX_RESUMES_PER_TAKE, "resume: dropping entry over the per-restart cap");
            self.entries.remove(&ch);
        }
        let mut batches = Vec::with_capacity(live.len());
        for ch in live {
            let entry = self.entries.get_mut(&ch).expect("live entry");
            if let Some(note) = entry.render_note() {
                entry.note = Some(note);
            }
            // The work itself died with the session; the resume turn owns it.
            entry.tasks.clear();
            entry.subagents.clear();
            entry.resume_pending = true;
            entry.resumes += 1;
            entry.in_turn = false;
            tracing::info!(channel_id = %ch, resumes = entry.resumes, "resume: re-delivering turn whose session was lost");
            batches.push(FlushBatch {
                channel_id: ch,
                events: entry.events.iter().map(|e| e.restore(now)).collect(),
                cancelled_events: Vec::new(),
                cancel_reason: Some(CancelReason::Resume),
            });
        }
        self.persist();
        batches
    }
}

/// How a channel turn ended, from the resume journal's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    /// The prompt returned normally: any held subagents are done.
    Natural,
    /// Explicit cancel or rotate: the batch was dropped by design.
    Dropped,
    /// Steer/interrupt: the batch was requeued in-process for a merged turn.
    Steered,
    /// The session or process died (timeout, exit, error); keep the entry.
    Lost,
}

impl TurnEnd {
    /// Classify a prompt outcome. `requeued` = the batch rides back to the
    /// queue. `None` = the turn never reached the agent (pool reroute).
    pub(crate) fn from_outcome(outcome: &PromptOutcome, requeued: bool) -> Option<Self> {
        Some(match outcome {
            PromptOutcome::Ok(_) => Self::Natural,
            PromptOutcome::Cancelled | PromptOutcome::CancelDrainTimeout(_) if requeued => {
                Self::Steered
            }
            PromptOutcome::Cancelled | PromptOutcome::CancelDrainTimeout(_) => Self::Dropped,
            PromptOutcome::PoolReroute => return None,
            PromptOutcome::AgentExited | PromptOutcome::Timeout(_) | PromptOutcome::Error(_) => {
                Self::Lost
            }
        })
    }
}

/// Shared handle to the per-agent resume journal. `Default` is disabled:
/// every operation is a no-op and nothing touches disk.
#[derive(Clone, Default)]
pub(crate) struct ResumeJournal(Option<Arc<Mutex<JournalState>>>);

impl ResumeJournal {
    /// Load the journal at `path`; `None` (feature disabled) yields a no-op.
    pub(crate) fn load(path: Option<PathBuf>) -> Self {
        let Some(path) = path else {
            tracing::info!("resume journal disabled (BUZZ_ACP_RESUME=0)");
            return Self(None);
        };
        let persisted = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Persisted>(&bytes).unwrap_or_else(|error| {
                tracing::warn!(%error, path = %path.display(), "invalid resume journal; continuing");
                Persisted::default()
            }),
            Err(error) => {
                tracing::debug!(%error, path = %path.display(), "resume journal unavailable; continuing");
                Persisted::default()
            }
        };
        let entries = persisted
            .entries
            .into_iter()
            .map(|e| (e.channel_id, e))
            .collect();
        Self(Some(Arc::new(Mutex::new(JournalState {
            path,
            entries,
            lost: HashSet::new(),
        }))))
    }

    fn with<R>(&self, f: impl FnOnce(&mut JournalState) -> R) -> Option<R> {
        self.0.as_ref().map(|state| {
            let mut guard = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            f(&mut guard)
        })
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.0.is_some()
    }

    /// Every entry loaded from disk belongs to a dead process: take them all.
    pub(crate) fn take_startup(&self, now: u64) -> Vec<FlushBatch> {
        self.with(|s| {
            let candidates = s.entries.keys().copied().collect();
            s.take(candidates, now)
        })
        .unwrap_or_default()
    }

    /// Take channels whose session died in this process. `skip(channel,
    /// event_ids)` = the batch is already queued or in flight again (the
    /// in-process requeue owns it); its dead work is cleared, not resumed.
    pub(crate) fn take_lost(
        &self,
        now: u64,
        skip: impl Fn(Uuid, &[nostr::EventId]) -> bool,
    ) -> Vec<FlushBatch> {
        self.with(|s| {
            if s.lost.is_empty() {
                return Vec::new();
            }
            let mut candidates = Vec::new();
            let mut changed = false;
            for ch in std::mem::take(&mut s.lost) {
                let Some(entry) = s.entries.get_mut(&ch) else {
                    continue;
                };
                let ids: Vec<nostr::EventId> = entry.events.iter().map(|e| e.event.id).collect();
                if skip(ch, &ids) {
                    tracing::info!(channel_id = %ch, "resume: lost session's request is already requeued; not resuming");
                    entry.tasks.clear();
                    entry.subagents.clear();
                    changed = true;
                } else {
                    candidates.push(ch);
                }
            }
            if changed && candidates.is_empty() {
                s.persist();
            }
            s.take(candidates, now)
        })
        .unwrap_or_default()
    }

    /// A batch was dispatched for `channel`: remember its request.
    pub(crate) fn begin_turn(&self, batch: &FlushBatch, now: u64) {
        self.with(|s| {
            let entry = s
                .entries
                .entry(batch.channel_id)
                .or_insert_with(|| Entry::new(batch.channel_id, now));
            // The merged request: carried-over events first, then new ones.
            entry.events = batch
                .cancelled_events
                .iter()
                .chain(&batch.events)
                .map(|e: &BatchEvent| SavedEvent::save(e, now))
                .collect();
            entry.recorded_at = now;
            entry.in_turn = true;
            if entry.durable() {
                s.persist();
            }
        });
    }

    fn add_work(&self, channel: Uuid, task: BackgroundTask, subagent: bool, now: u64) {
        self.with(|s| {
            let entry = s
                .entries
                .entry(channel)
                .or_insert_with(|| Entry::new(channel, now));
            let list = if subagent {
                &mut entry.subagents
            } else {
                &mut entry.tasks
            };
            match list.iter_mut().find(|t| t.id == task.id) {
                Some(existing) => {
                    if *existing == task {
                        return;
                    }
                    *existing = task;
                }
                None => list.push(task),
            }
            entry.recorded_at = now;
            s.persist();
        });
    }

    pub(crate) fn subagent_started(&self, channel: Uuid, task: BackgroundTask, now: u64) {
        self.add_work(channel, task, true, now);
    }

    pub(crate) fn task_started(&self, channel: Uuid, task: BackgroundTask, now: u64) {
        self.add_work(channel, task, false, now);
    }

    pub(crate) fn task_output(&self, channel: Uuid, id: &str, output_file: &str) {
        self.with(|s| {
            let Some(task) = s
                .entries
                .get_mut(&channel)
                .and_then(|e| e.tasks.iter_mut().find(|t| t.id == id))
            else {
                return;
            };
            if task.output_file.as_deref() != Some(output_file) {
                task.output_file = Some(output_file.to_string());
                s.persist();
            }
        });
    }

    pub(crate) fn task_ended(&self, channel: Uuid, id: &str) {
        self.with(|s| {
            let Some(entry) = s.entries.get_mut(&channel) else {
                return;
            };
            let before = entry.tasks.len();
            entry.tasks.retain(|t| t.id != id);
            if entry.tasks.len() == before {
                return;
            }
            if !entry.in_turn && !entry.durable() {
                s.entries.remove(&channel);
            }
            s.persist();
        });
    }

    pub(crate) fn turn_ended(&self, channel: Uuid, end: TurnEnd) {
        self.with(|s| {
            let Some(entry) = s.entries.get_mut(&channel) else {
                return;
            };
            let was_durable = entry.durable();
            entry.in_turn = false;
            match end {
                TurnEnd::Natural => {
                    entry.subagents.clear();
                    entry.resume_pending = false;
                    entry.note = None;
                }
                TurnEnd::Dropped => {
                    s.entries.remove(&channel);
                    if was_durable {
                        s.persist();
                    }
                    return;
                }
                TurnEnd::Steered | TurnEnd::Lost => {}
            }
            if !entry.durable() {
                s.entries.remove(&channel);
            }
            if was_durable {
                s.persist();
            }
        });
    }

    /// The agent process hosting these channels' sessions is gone.
    pub(crate) fn sessions_lost<'a>(&self, channels: impl IntoIterator<Item = &'a Uuid>) {
        self.with(|s| {
            for ch in channels {
                if s.entries.get(ch).is_some_and(Entry::durable) {
                    s.lost.insert(*ch);
                }
            }
        });
    }

    /// The "work that was stopped" section for a resume batch, if any.
    pub(crate) fn resume_note(&self, batch: &FlushBatch) -> Option<String> {
        if batch.cancel_reason != Some(CancelReason::Resume) {
            return None;
        }
        self.with(|s| {
            s.entries
                .get(&batch.channel_id)
                .and_then(|e| e.note.clone())
        })
        .flatten()
    }

    #[cfg(test)]
    pub(crate) fn snapshot(
        &self,
        channel: Uuid,
    ) -> Option<(Vec<BackgroundTask>, Vec<BackgroundTask>, bool)> {
        self.with(|s| {
            s.entries
                .get(&channel)
                .map(|e| (e.tasks.clone(), e.subagents.clone(), e.durable()))
        })
        .flatten()
    }
}

/// Append the resume note to a formatted prompt (no-op for other batches).
pub(crate) fn with_resume_note(
    mut sections: Vec<String>,
    batch: Option<&FlushBatch>,
    journal: &ResumeJournal,
) -> Vec<String> {
    if let Some(note) = batch.and_then(|b| journal.resume_note(b)) {
        sections.push(note);
    }
    sections
}

/// Per-agent-process view: which ACP session belongs to which channel, so
/// `session/update`s (read during any later prompt on the same process) land
/// on the right channel's entry. Dropping it — the process is gone — marks
/// every channel it hosted as lost.
#[derive(Default)]
pub(crate) struct ResumeTracker {
    journal: ResumeJournal,
    sessions: HashMap<String, Uuid>,
}

impl ResumeTracker {
    pub(crate) fn begin_turn(
        &mut self,
        journal: &ResumeJournal,
        session_id: &str,
        batch: &FlushBatch,
    ) {
        if !journal.is_enabled() {
            return;
        }
        self.journal = journal.clone();
        self.sessions
            .insert(session_id.to_string(), batch.channel_id);
        journal.begin_turn(batch, crate::auth_parking::now_secs());
    }

    pub(crate) fn turn_ended(&self, channel: Uuid, end: Option<TurnEnd>) {
        if let Some(end) = end {
            self.journal.turn_ended(channel, end);
        }
    }

    /// Record background-work lifecycle from one `session/update`.
    pub(crate) fn observe(&self, msg: &serde_json::Value) {
        if !self.journal.is_enabled() {
            return;
        }
        let Some(&channel) = msg["params"]["sessionId"]
            .as_str()
            .and_then(|s| self.sessions.get(s))
        else {
            return;
        };
        let update = &msg["params"]["update"];
        let now = crate::auth_parking::now_secs();
        let str_field = |key: &str| {
            update
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        };
        match update["sessionUpdate"].as_str() {
            Some("tool_call" | "tool_call_update") => {
                if let Some(task) = background_subagent(update) {
                    self.journal.subagent_started(channel, task, now);
                }
            }
            Some("async_task_spawned") => {
                let Some(id) = str_field("asyncTaskId") else {
                    return;
                };
                let title = str_field("name")
                    .or_else(|| str_field("description"))
                    .unwrap_or_else(|| "Background task".to_string());
                self.journal.task_started(
                    channel,
                    BackgroundTask {
                        id,
                        title,
                        output_file: str_field("outputFilePath"),
                        tool_call_id: str_field("toolCallId"),
                    },
                    now,
                );
            }
            Some("async_task_progress") => {
                if let (Some(id), Some(path)) =
                    (str_field("asyncTaskId"), str_field("outputFilePath"))
                {
                    self.journal.task_output(channel, &id, &path);
                }
            }
            Some("async_task_state_update") => {
                let Some(id) = str_field("asyncTaskId") else {
                    return;
                };
                if str_field("state").as_deref().is_some_and(is_terminal_state) {
                    self.journal.task_ended(channel, &id);
                } else if let Some(path) = str_field("outputFilePath") {
                    self.journal.task_output(channel, &id, &path);
                }
            }
            _ => {}
        }
    }
}

impl Drop for ResumeTracker {
    fn drop(&mut self) {
        self.journal.sessions_lost(self.sessions.values());
    }
}

fn is_terminal_state(state: &str) -> bool {
    matches!(
        state,
        "completed" | "failed" | "stopped" | "cancelled" | "killed"
    )
}

/// A background subagent launch: claude-agent-acp tags subagent tool calls
/// with `_meta.claudeCode.subagent` (tool `Agent`/`Task`) and passes the
/// model's input as `rawInput`, which carries `run_in_background: true`.
/// The flag can first appear on a refining `tool_call_update`.
fn background_subagent(update: &serde_json::Value) -> Option<BackgroundTask> {
    let raw = update.get("rawInput")?;
    if raw.get("run_in_background").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let meta = &update["_meta"]["claudeCode"];
    let is_subagent = meta["subagent"].as_bool() == Some(true)
        || matches!(meta["toolName"].as_str(), Some("Agent" | "Task"))
        || matches!(update["name"].as_str(), Some("Agent" | "Task"));
    if !is_subagent {
        return None;
    }
    let id = update["toolCallId"].as_str()?.to_string();
    let title = raw["description"]
        .as_str()
        .or_else(|| update["title"].as_str())
        .unwrap_or("background subagent")
        .to_string();
    Some(BackgroundTask {
        tool_call_id: Some(id.clone()),
        id,
        title,
        output_file: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("buzz-resume-{}.json", Uuid::new_v4()))
    }

    fn batch(channel: Uuid, text: &str) -> FlushBatch {
        FlushBatch {
            channel_id: channel,
            events: vec![BatchEvent {
                event: nostr::EventBuilder::new(nostr::Kind::Custom(9), text)
                    .sign_with_keys(&nostr::Keys::generate())
                    .unwrap(),
                prompt_tag: "test".into(),
                received_at: Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    fn task(id: &str) -> BackgroundTask {
        BackgroundTask {
            id: id.into(),
            title: format!("task {id}"),
            output_file: Some(format!("/tmp/{id}.out")),
            tool_call_id: None,
        }
    }

    /// Seed one channel with outstanding background work recorded at `at`.
    fn seed(journal: &ResumeJournal, channel: Uuid, at: u64) {
        journal.begin_turn(&batch(channel, "request"), at);
        journal.task_started(channel, task(&channel.to_string()), at);
        journal.turn_ended(channel, TurnEnd::Natural);
    }

    // T6: TTL, per-take cap (newest first) and the crash-loop guard.
    #[test]
    fn take_applies_ttl_cap_newest_first_and_crash_loop_guard() {
        let path = temp_path();
        let now = 100_000;
        let journal = ResumeJournal::load(Some(path.clone()));
        let channels: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
        // channels[0] is past the TTL; 1..5 are live, newest = channels[4].
        seed(&journal, channels[0], now - RESUME_TTL_SECS - 1);
        for (i, ch) in channels.iter().enumerate().skip(1) {
            seed(&journal, *ch, now - 1000 + i as u64);
        }
        let restarted = ResumeJournal::load(Some(path.clone()));
        let taken: Vec<Uuid> = restarted
            .take_startup(now)
            .into_iter()
            .map(|b| b.channel_id)
            .collect();
        assert_eq!(taken, vec![channels[4], channels[3], channels[2]]);
        assert!(
            restarted.snapshot(channels[0]).is_none(),
            "expired entry dropped"
        );
        assert!(
            restarted.snapshot(channels[1]).is_none(),
            "over-cap entry dropped"
        );

        // Crash-loop guard: an entry resumed twice already is dropped.
        let looping = Uuid::new_v4();
        let journal = ResumeJournal::load(Some(path.clone()));
        seed(&journal, looping, now);
        for attempt in 1..=MAX_RESUME_ATTEMPTS {
            let batches = ResumeJournal::load(Some(path.clone())).take_startup(now);
            assert!(
                batches.iter().any(|b| b.channel_id == looping),
                "attempt {attempt} must still resume"
            );
        }
        let batches = ResumeJournal::load(Some(path.clone())).take_startup(now);
        assert!(
            !batches.iter().any(|b| b.channel_id == looping),
            "an entry with resumes = {MAX_RESUME_ATTEMPTS} must be dropped"
        );
        let _ = std::fs::remove_file(path);
    }

    // T7 (regression guard — passes on unfixed code by construction): the
    // kill switch yields no path, so no file and no replay.
    #[test]
    fn kill_switch_disables_journal() {
        for off in ["0", "false", "OFF", "no"] {
            assert_eq!(
                resolve_path(Some(off), Some("/tmp/x.json"), Some("/home/u"), "pk"),
                None
            );
        }
        assert_eq!(
            resolve_path(Some("1"), None, Some("/home/u"), "pk"),
            Some(PathBuf::from("/home/u/.buzz/WORKING_STATE/resume/pk.json"))
        );
        assert_eq!(
            resolve_path(None, Some("/tmp/x.json"), Some("/home/u"), "pk"),
            Some(PathBuf::from("/tmp/x.json"))
        );
        let disabled = ResumeJournal::load(None);
        let ch = Uuid::new_v4();
        seed(&disabled, ch, 1000);
        disabled.sessions_lost([&ch]);
        assert!(disabled.take_startup(1000).is_empty());
        assert!(disabled.take_lost(1000, |_, _| false).is_empty());
    }

    #[test]
    fn ordinary_turn_is_never_written_and_finished_work_deletes_entry() {
        let path = temp_path();
        let journal = ResumeJournal::load(Some(path.clone()));
        let ch = Uuid::new_v4();
        journal.begin_turn(&batch(ch, "plain"), 1000);
        assert!(
            !path.exists(),
            "a turn without background work is memory-only"
        );
        journal.task_started(ch, task("t1"), 1000);
        assert!(path.exists(), "background work is durable at once");
        journal.turn_ended(ch, TurnEnd::Natural);
        journal.task_ended(ch, "t1");
        assert!(!path.exists(), "no outstanding work leaves no file");
        assert!(journal.snapshot(ch).is_none());
    }

    #[test]
    fn subagent_hold_clears_on_natural_end_but_survives_loss() {
        let path = temp_path();
        let journal = ResumeJournal::load(Some(path.clone()));
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for ch in [a, b] {
            journal.begin_turn(&batch(ch, "spawn a helper"), 1000);
            journal.subagent_started(ch, task("agent"), 1000);
        }
        journal.turn_ended(a, TurnEnd::Natural);
        journal.turn_ended(b, TurnEnd::Lost);
        assert!(journal.snapshot(a).is_none());
        let taken = ResumeJournal::load(Some(path.clone())).take_startup(1001);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].channel_id, b);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn lost_sessions_resume_unless_already_requeued() {
        let journal = ResumeJournal::load(Some(temp_path()));
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        seed(&journal, a, 1000);
        seed(&journal, b, 1000);
        journal.sessions_lost([&a, &b]);
        let taken = journal.take_lost(1001, |ch, _| ch == b);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].channel_id, a);
        assert_eq!(taken[0].cancel_reason, Some(CancelReason::Resume));
        assert!(
            journal.resume_note(&taken[0]).unwrap().contains("/tmp/"),
            "note names the stopped task's output"
        );
        assert!(
            journal.take_lost(1002, |_, _| false).is_empty(),
            "taken once"
        );
        assert!(journal
            .snapshot(b)
            .is_some_and(|(t, s, _)| t.is_empty() && s.is_empty()));
    }

    #[test]
    fn observe_tracks_subagents_and_async_tasks_by_session() {
        let path = temp_path();
        let journal = ResumeJournal::load(Some(path.clone()));
        let ch = Uuid::new_v4();
        let mut tracker = ResumeTracker::default();
        tracker.begin_turn(&journal, "s1", &batch(ch, "go"));
        let update = |u: serde_json::Value| {
            serde_json::json!({"jsonrpc":"2.0","method":"session/update",
                "params":{"sessionId":"s1","update":u}})
        };
        // Shapes as emitted by claude-agent-acp 0.79.0.
        tracker.observe(&update(serde_json::json!({
            "sessionUpdate":"tool_call","toolCallId":"tu1","name":"Agent","status":"pending",
            "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}},
            "rawInput":{"subagent_type":"designer","description":"icon concepts",
                        "run_in_background":true,"prompt":"…"}})));
        // A background Bash is NOT a held subagent (it is an async task).
        tracker.observe(&update(serde_json::json!({
            "sessionUpdate":"tool_call","toolCallId":"tu2","name":"Bash",
            "_meta":{"claudeCode":{"toolName":"Bash"}},
            "rawInput":{"command":"sleep 300","run_in_background":true}})));
        tracker.observe(&update(serde_json::json!({
            "sessionUpdate":"async_task_spawned","asyncTaskId":"b1","name":"sleep 300",
            "taskType":"Shell","description":"sleep 300","showInTranscript":true,
            "canStop":true,"toolCallId":"tu2"})));
        tracker.observe(&update(serde_json::json!({
            "sessionUpdate":"async_task_progress","asyncTaskId":"b1",
            "outputFilePath":"/tmp/b1.output"})));
        // Updates for an unknown session are ignored.
        tracker.observe(&serde_json::json!({"params":{"sessionId":"other","update":{
            "sessionUpdate":"async_task_spawned","asyncTaskId":"x"}}}));
        let (tasks, subagents, durable) = journal.snapshot(ch).unwrap();
        assert!(durable);
        assert_eq!(subagents.len(), 1);
        assert_eq!(subagents[0].title, "icon concepts");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].output_file.as_deref(), Some("/tmp/b1.output"));
        tracker.turn_ended(ch, Some(TurnEnd::Natural));
        tracker.observe(&update(serde_json::json!({
            "sessionUpdate":"async_task_state_update","asyncTaskId":"b1","state":"completed"})));
        assert!(journal.snapshot(ch).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn dropping_tracker_marks_its_channels_lost() {
        let journal = ResumeJournal::load(Some(temp_path()));
        let ch = Uuid::new_v4();
        {
            let mut tracker = ResumeTracker::default();
            tracker.begin_turn(&journal, "s1", &batch(ch, "go"));
            journal.task_started(ch, task("t"), auth_now());
        }
        assert_eq!(journal.take_lost(auth_now(), |_, _| false).len(), 1);
    }

    fn auth_now() -> u64 {
        crate::auth_parking::now_secs()
    }

    #[test]
    fn corrupt_journal_is_treated_as_empty() {
        let path = temp_path();
        std::fs::write(&path, b"{not json").unwrap();
        assert!(ResumeJournal::load(Some(path.clone()))
            .take_startup(1)
            .is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn startup_jitter_is_stable_and_bounded() {
        let a = startup_jitter("abc");
        assert_eq!(a, startup_jitter("abc"));
        assert!(a < Duration::from_secs(STARTUP_JITTER_SECS));
        let distinct: HashSet<_> = (0..50).map(|i| startup_jitter(&format!("pk{i}"))).collect();
        assert!(distinct.len() > 10, "jitter spreads agents");
    }
}
