//! Kind-30624 agent task status — the member-readable projection of a turn.
//!
//! The harness publishes a lifecycle head (`d = turn:<channel>`) for every
//! channel turn with no agent cooperation (phase-8 design D8.1–D8.9):
//!
//! - `running` when the turn starts, re-published every [`STATUS_REFRESH`]
//!   while it runs, so non-owner readers can tell a live turn from a dead
//!   harness (clients render a `running` head older than 180 s as stalled);
//! - exactly one terminal head (`done` / `error` / `cancelled`) from
//!   `TurnCompletionGuard::drop`, on every exit path;
//! - a startup sweep that marks a previous process's still-`running` heads as
//!   `error` with `reason=harness-restart`.
//!
//! Publishing is best-effort: a 3 s timeout, a WARN on failure, never a failed
//! turn. `created_at` is strictly monotonic per turn ([`StatusClock`]) so the
//! relay's addressable stale-write protection keeps the terminal head even if
//! spawned submits arrive out of order.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use buzz_core::task_status::{parse_task_status, StatusNamespace, TaskState};
use buzz_sdk::task_status::{build_task_lifecycle, TaskLifecycle};
use nostr::{Event, Keys};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::relay::RestClient;

/// Interval at which a running turn's lifecycle head is re-published.
pub const STATUS_REFRESH: Duration = Duration::from_secs(60);

/// Per-publish submit timeout (same posture as the 44200 turn metric).
const STATUS_SUBMIT_TIMEOUT: Duration = Duration::from_secs(3);

/// `reason` stamped by the startup sweep.
pub const HARNESS_RESTART_REASON: &str = "harness-restart";

/// Maximum heads the startup sweep reads.
const SWEEP_LIMIT: usize = 500;

/// Destination for signed status events. Production spawns a relay submit;
/// tests record.
pub trait TaskStatusSink: Send + Sync {
    /// Publish one signed kind-30624 event. Must not block and must not fail
    /// the caller.
    fn publish(&self, event: Event);
}

/// Production sink: spawns `POST /events` on the current tokio runtime.
pub struct RestTaskStatusSink {
    rest: RestClient,
}

impl RestTaskStatusSink {
    /// Sink submitting through the harness's REST client.
    pub fn new(rest: RestClient) -> Self {
        Self { rest }
    }
}

impl TaskStatusSink for RestTaskStatusSink {
    fn publish(&self, event: Event) {
        // Called from `Drop`, which may run outside a runtime during shutdown.
        // The startup sweep (D8.8) is the backstop for a lost terminal head.
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle,
            Err(_) => {
                tracing::warn!(
                    target: "pool::task_status",
                    event_id = %event.id,
                    "task status: no tokio runtime; status head dropped"
                );
                return;
            }
        };
        let rest = self.rest.clone();
        handle.spawn(async move {
            match tokio::time::timeout(STATUS_SUBMIT_TIMEOUT, rest.submit_event(&event)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => tracing::warn!(
                    target: "pool::task_status",
                    event_id = %event.id,
                    "task status: publish failed: {e}"
                ),
                Err(_) => tracing::warn!(
                    target: "pool::task_status",
                    event_id = %event.id,
                    "task status: publish timed out"
                ),
            }
        });
    }
}

/// Current unix time in seconds.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Strictly monotonic `created_at` source for one turn (D8.6):
/// `next = max(now, last + 1)`.
#[derive(Debug, Default)]
pub struct StatusClock(AtomicU64);

impl StatusClock {
    /// Next timestamp given the wall clock `now`.
    pub fn next_at(&self, now: u64) -> u64 {
        let mut last = self.0.load(Ordering::SeqCst);
        loop {
            let next = now.max(last.saturating_add(1));
            match self
                .0
                .compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return next,
                Err(actual) => last = actual,
            }
        }
    }

    /// Next timestamp from the system clock.
    pub fn next(&self) -> u64 {
        self.next_at(unix_now())
    }
}

/// Publishes one turn's lifecycle heads. Shared (`Arc`) between the refresh
/// task and `TurnCompletionGuard`.
pub struct TurnStatusPublisher {
    sink: Arc<dyn TaskStatusSink>,
    keys: Keys,
    channel: Uuid,
    turn_id: String,
    started: u64,
    trigger: Option<String>,
    session: Option<String>,
    clock: StatusClock,
    /// Set by [`TurnStatusPublisher::terminal`]. Held across the build+publish
    /// of every head so a refresh can never be *emitted* after the terminal
    /// head (arrival order is handled by the clock).
    closed: Mutex<bool>,
}

impl TurnStatusPublisher {
    /// A publisher for one channel turn.
    pub fn new(
        sink: Arc<dyn TaskStatusSink>,
        keys: Keys,
        channel: Uuid,
        turn_id: String,
        started: u64,
        trigger: Option<String>,
        session: Option<String>,
    ) -> Self {
        Self {
            sink,
            keys,
            channel,
            turn_id,
            started,
            trigger,
            session,
            clock: StatusClock::default(),
            closed: Mutex::new(false),
        }
    }

    fn lock_closed(&self) -> std::sync::MutexGuard<'_, bool> {
        match self.closed.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn emit(&self, state: TaskState, reason: Option<&str>) {
        let created_at = self.clock.next();
        let ended = state.is_terminal().then(|| created_at.max(self.started));
        let input = TaskLifecycle {
            channel: self.channel,
            turn_id: &self.turn_id,
            state,
            started: self.started,
            ended,
            trigger: self.trigger.as_deref(),
            session: self.session.as_deref(),
            reason,
            created_at,
        };
        let event = build_task_lifecycle(&input)
            .map_err(|e| e.to_string())
            .and_then(|b| b.sign_with_keys(&self.keys).map_err(|e| e.to_string()));
        match event {
            Ok(event) => self.sink.publish(event),
            Err(e) => tracing::warn!(
                target: "pool::task_status",
                turn_id = %self.turn_id,
                "task status: could not build {} head: {e}",
                state.as_str()
            ),
        }
    }

    /// Publish the initial `running` head.
    pub fn running(&self) {
        let closed = self.lock_closed();
        if !*closed {
            self.emit(TaskState::Running, None);
        }
    }

    /// Re-publish `running`. Returns `false` (and publishes nothing) once the
    /// terminal head has been published.
    pub fn refresh(&self) -> bool {
        let closed = self.lock_closed();
        if *closed {
            return false;
        }
        self.emit(TaskState::Running, None);
        true
    }

    /// Publish the terminal head. Idempotent: only the first call publishes.
    pub fn terminal(&self, state: TaskState, reason: Option<&str>) {
        let mut closed = self.lock_closed();
        if *closed {
            return;
        }
        *closed = true;
        let state = if state.is_terminal() {
            state
        } else {
            TaskState::Error
        };
        self.emit(state, reason);
    }
}

/// Re-publishes `running` every `interval` until the publisher closes.
///
/// Independent of the observer liveness ticker, so it still runs when
/// `BUZZ_ACP_TURN_LIVENESS_SECS=0`. A zero interval disables refresh.
pub async fn run_status_refresh(publisher: Arc<TurnStatusPublisher>, interval: Duration) {
    if interval.is_zero() {
        return;
    }
    let mut ticker = tokio::time::interval(interval);
    // First tick is immediate; `running()` already covered t=0.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if !publisher.refresh() {
            return;
        }
    }
}

/// Aborts the refresh task when the turn ends (any exit path).
pub struct StatusRefreshGuard(JoinHandle<()>);

impl StatusRefreshGuard {
    /// Spawn the refresh loop for `publisher`.
    pub fn spawn(publisher: Arc<TurnStatusPublisher>, interval: Duration) -> Self {
        Self(tokio::spawn(run_status_refresh(publisher, interval)))
    }
}

impl Drop for StatusRefreshGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Terminal slot a turn's result path fills; read by `TurnCompletionGuard`.
/// Unset at drop (panic, unhandled path) means `error` (D8.7).
#[derive(Clone, Default)]
pub struct TaskOutcomeSlot(Arc<Mutex<Option<TaskState>>>);

impl TaskOutcomeSlot {
    /// Record the turn's terminal state.
    pub fn set(&self, state: TaskState) {
        let mut slot = match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *slot = Some(state);
    }

    /// Recorded state, or `error` when nothing was recorded.
    pub fn resolve(&self) -> TaskState {
        let slot = match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        slot.unwrap_or(TaskState::Error)
    }
}

/// Build the `error` heads that close `own_heads` still left `running` by a
/// previous harness process (D8.8). Pure: the caller publishes.
pub fn stale_running_sweep_events(own_heads: &[Event], keys: &Keys, now: u64) -> Vec<Event> {
    let me = keys.public_key();
    let mut out = Vec::new();
    for ev in own_heads {
        if ev.pubkey != me {
            continue;
        }
        let Ok(head) = parse_task_status(ev) else {
            continue;
        };
        if head.namespace != StatusNamespace::Turn || head.state != Some(TaskState::Running) {
            continue;
        }
        let created_at = now.max(ev.created_at.as_secs().saturating_add(1));
        let started = head.started.unwrap_or(created_at);
        let input = TaskLifecycle {
            channel: head.channel,
            turn_id: &head.turn_id,
            state: TaskState::Error,
            started,
            ended: Some(created_at.max(started)),
            trigger: head.trigger.as_deref(),
            session: head.session.as_deref(),
            reason: Some(HARNESS_RESTART_REASON),
            created_at,
        };
        match build_task_lifecycle(&input)
            .map_err(|e| e.to_string())
            .and_then(|b| b.sign_with_keys(keys).map_err(|e| e.to_string()))
        {
            Ok(event) => out.push(event),
            Err(e) => tracing::warn!(
                target: "pool::task_status",
                turn_id = %head.turn_id,
                "task status sweep: could not build error head: {e}"
            ),
        }
    }
    out
}

/// Startup sweep: read this agent's own kind-30624 heads and close every
/// `running` lifecycle head a previous process left behind. Best-effort.
pub async fn sweep_stale_running(rest: &RestClient, keys: &Keys, sink: &dyn TaskStatusSink) {
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(
            buzz_core::kind::KIND_AGENT_TASK_STATUS as u16,
        ))
        .author(keys.public_key())
        .limit(SWEEP_LIMIT);
    let value = match tokio::time::timeout(Duration::from_secs(10), rest.query(&[filter])).await {
        Ok(Ok(value)) => value,
        Ok(Err(e)) => {
            tracing::warn!(target: "pool::task_status", "task status sweep: query failed: {e}");
            return;
        }
        Err(_) => {
            tracing::warn!(target: "pool::task_status", "task status sweep: query timed out");
            return;
        }
    };
    let heads: Vec<Event> = value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| serde_json::from_value::<Event>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let closing = stale_running_sweep_events(&heads, keys, unix_now());
    if !closing.is_empty() {
        tracing::info!(
            target: "pool::task_status",
            count = closing.len(),
            "task status sweep: closing stale running heads"
        );
    }
    for event in closing {
        sink.publish(event);
    }
}

/// Test sink that records every published event.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink(pub Mutex<Vec<Event>>);

#[cfg(test)]
impl RecordingSink {
    /// Parsed `(state, turn_id, created_at)` of every recorded lifecycle head.
    pub fn states(&self) -> Vec<(TaskState, String, u64)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|e| {
                let head = parse_task_status(e).expect("recorded head is valid");
                (
                    head.state.expect("lifecycle head"),
                    head.turn_id,
                    e.created_at.as_secs(),
                )
            })
            .collect()
    }
}

#[cfg(test)]
impl TaskStatusSink for RecordingSink {
    fn publish(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publisher(sink: Arc<RecordingSink>) -> Arc<TurnStatusPublisher> {
        Arc::new(TurnStatusPublisher::new(
            sink,
            Keys::generate(),
            Uuid::new_v4(),
            Uuid::new_v4().to_string(),
            unix_now(),
            None,
            Some("0".into()),
        ))
    }

    #[test]
    fn status_clock_is_strictly_monotonic() {
        let clock = StatusClock::default();
        assert_eq!(clock.next_at(1000), 1000);
        assert_eq!(clock.next_at(1000), 1001);
        assert_eq!(clock.next_at(1000), 1002);
        // Wall clock jumping ahead wins; going backwards never does.
        assert_eq!(clock.next_at(2000), 2000);
        assert_eq!(clock.next_at(1500), 2001);
    }

    #[test]
    fn terminal_is_published_once_and_closes_refresh() {
        let sink = Arc::new(RecordingSink::default());
        let p = publisher(Arc::clone(&sink));
        p.running();
        p.terminal(TaskState::Done, None);
        p.terminal(TaskState::Error, None);
        assert!(!p.refresh(), "refresh after terminal must report closed");
        let states: Vec<TaskState> = sink.states().into_iter().map(|s| s.0).collect();
        assert_eq!(states, vec![TaskState::Running, TaskState::Done]);
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_runs_with_liveness_disabled() {
        // The refresh loop has its own ticker: nothing here configures (or
        // needs) observer liveness.
        let sink = Arc::new(RecordingSink::default());
        let p = publisher(Arc::clone(&sink));
        p.running();
        let guard = StatusRefreshGuard::spawn(Arc::clone(&p), STATUS_REFRESH);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert_eq!(sink.states().len(), 1, "no refresh before 60 s");
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let states = sink.states();
        assert_eq!(states.len(), 2, "one refresh at 60 s");
        assert_eq!(states[1].0, TaskState::Running);
        drop(guard);
    }

    #[tokio::test(start_paused = true)]
    async fn no_refresh_after_guard_drop() {
        let sink = Arc::new(RecordingSink::default());
        let p = publisher(Arc::clone(&sink));
        p.running();
        // Keep the refresh task alive (no guard drop) so only the close flag
        // can stop it from emitting after the terminal head.
        let handle = tokio::spawn(run_status_refresh(Arc::clone(&p), STATUS_REFRESH));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        p.terminal(TaskState::Done, None);
        for _ in 0..3 {
            tokio::time::advance(Duration::from_secs(60)).await;
            tokio::task::yield_now().await;
        }
        let states = sink.states();
        assert_eq!(
            states.last().map(|s| s.0),
            Some(TaskState::Done),
            "the last published head must be terminal: {states:?}"
        );
        assert_eq!(states.len(), 3, "running, one refresh, done: {states:?}");
        let times: Vec<u64> = states.iter().map(|s| s.2).collect();
        assert!(times.windows(2).all(|w| w[0] < w[1]), "{times:?}");
        assert!(handle.is_finished(), "refresh loop exits once closed");
    }

    #[test]
    fn outcome_slot_defaults_to_error() {
        let slot = TaskOutcomeSlot::default();
        assert_eq!(slot.resolve(), TaskState::Error);
        slot.set(TaskState::Cancelled);
        assert_eq!(slot.resolve(), TaskState::Cancelled);
    }

    #[test]
    fn startup_sweep_marks_stale_running_as_error() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let sign = |state: TaskState, ended: Option<u64>, turn: &str, created: u64, k: &Keys| {
            build_task_lifecycle(&TaskLifecycle {
                channel,
                turn_id: turn,
                state,
                started: 1_000,
                ended,
                trigger: None,
                session: Some("2"),
                reason: None,
                created_at: created,
            })
            .unwrap()
            .sign_with_keys(k)
            .unwrap()
        };
        let stale = sign(TaskState::Running, None, "t-stale", 1_050, &keys);
        let finished = sign(TaskState::Done, Some(1_100), "t-done", 1_100, &keys);
        let foreign = sign(
            TaskState::Running,
            None,
            "t-other",
            1_050,
            &Keys::generate(),
        );
        let out = stale_running_sweep_events(&[stale, finished, foreign], &keys, 2_000);
        assert_eq!(out.len(), 1, "only our own running head is closed");
        let head = parse_task_status(&out[0]).unwrap();
        assert_eq!(head.state, Some(TaskState::Error));
        assert_eq!(head.reason.as_deref(), Some(HARNESS_RESTART_REASON));
        assert_eq!(head.turn_id, "t-stale");
        assert_eq!(head.channel, channel);
        assert_eq!(head.session.as_deref(), Some("2"));
        assert_eq!(out[0].created_at.as_secs(), 2_000);
        assert_eq!(out[0].pubkey, keys.public_key());
    }

    #[test]
    fn startup_sweep_supersedes_future_dated_head() {
        let keys = Keys::generate();
        let stale = build_task_lifecycle(&TaskLifecycle {
            channel: Uuid::new_v4(),
            turn_id: "t",
            state: TaskState::Running,
            started: 1_000,
            ended: None,
            trigger: None,
            session: None,
            reason: None,
            created_at: 5_000,
        })
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
        let out = stale_running_sweep_events(&[stale], &keys, 2_000);
        assert_eq!(out[0].created_at.as_secs(), 5_001);
    }
    #[test]
    fn sweep_ignores_job_heads() {
        use buzz_sdk::task_status::{build_task_job, TaskJob};
        let keys = Keys::generate();
        // Bind a turn so dropping the namespace guard really builds an error event.
        let event = build_task_job(&TaskJob {
            channel: Uuid::new_v4(),
            job_id: "j1",
            role: "coder",
            state: TaskState::Running,
            started: 1000,
            ended: None,
            model: None,
            title: None,
            turn_id: Some("launch-1"),
            trigger: None,
            reason: None,
            created_at: 1000,
        })
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
        assert!(stale_running_sweep_events(&[event], &keys, 2000).is_empty());
    }
}
