//! Durable auth-outage work. Only auth failures enter this journal; normal retry
//! accounting stays in the queue. Wall-clock expiry survives process restarts.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::queue::{BatchEvent, CancelReason, FlushBatch};

pub(crate) const AUTH_PROBE_DELAY: Duration = Duration::from_secs(60);
pub(crate) const AUTH_PARK_CAP_SECS: u64 = 6 * 60 * 60;

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn path_for_agent(pubkey: &str) -> Option<PathBuf> {
    std::env::var("BUZZ_ACP_AUTH_PARKED_FILE")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME").ok().map(|home| {
                PathBuf::from(home)
                    .join(".buzz/WORKING_STATE/auth-parked")
                    .join(format!("{pubkey}.json"))
            })
        })
}

#[derive(Serialize, Deserialize)]
struct SavedEvent {
    event: nostr::Event,
    prompt_tag: String,
    received_at_ms: u64,
}

impl SavedEvent {
    fn save(event: &BatchEvent, now: u64) -> Self {
        Self {
            event: event.event.clone(),
            prompt_tag: event.prompt_tag.clone(),
            received_at_ms: now.saturating_mul(1000).saturating_sub(
                event
                    .received_at
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            ),
        }
    }
    fn restore(&self, now: u64) -> BatchEvent {
        BatchEvent {
            event: self.event.clone(),
            prompt_tag: self.prompt_tag.clone(),
            received_at: Instant::now()
                .checked_sub(Duration::from_millis(
                    now.saturating_mul(1000).saturating_sub(self.received_at_ms),
                ))
                .unwrap_or_else(Instant::now),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SavedBatch {
    channel_id: Uuid,
    first_failure: u64,
    events: Vec<SavedEvent>,
    cancelled_events: Vec<SavedEvent>,
    cancel_reason: Option<CancelReason>,
}

#[derive(Default, Serialize, Deserialize)]
struct ParkingState {
    batches: Vec<SavedBatch>,
    noticed_channels: HashSet<Uuid>,
    #[serde(skip)]
    path: Option<PathBuf>,
    #[serde(skip)]
    pending_notices: HashMap<Uuid, Uuid>,
}

impl ParkingState {
    pub(crate) fn load(path: PathBuf, now: u64) -> Self {
        let mut state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Self>(&bytes).unwrap_or_else(|error| {
                tracing::warn!(%error, path = %path.display(), "invalid auth parking journal; continuing");
                Self::default()
            }),
            Err(error) => {
                tracing::debug!(%error, path = %path.display(), "auth parking journal unavailable; continuing");
                Self::default()
            }
        };
        state.path = Some(path);
        let previous_count = state.batches.len();
        state.batches.retain(|batch| {
            let keep = now.saturating_sub(batch.first_failure) < AUTH_PARK_CAP_SECS;
            if !keep { tracing::warn!(channel_id = %batch.channel_id, "dropping expired parked auth batch on startup"); }
            keep
        });
        state
            .noticed_channels
            .retain(|ch| state.batches.iter().any(|b| b.channel_id == *ch));
        if state.batches.len() != previous_count {
            state.persist();
        }
        state
    }

    pub(crate) fn restored_batches(&self, now: u64) -> Vec<FlushBatch> {
        let mut batches: Vec<_> = self.batches.iter().collect();
        // A repeated probe updates its journal entry after newer batches. That
        // write order must never become delivery order on restart.
        batches.sort_by_key(|batch| {
            batch
                .events
                .iter()
                .chain(&batch.cancelled_events)
                .map(|e| e.received_at_ms)
                .min()
                .unwrap_or(u64::MAX)
        });
        batches
            .into_iter()
            .map(|batch| FlushBatch {
                channel_id: batch.channel_id,
                events: batch.events.iter().map(|e| e.restore(now)).collect(),
                cancelled_events: batch
                    .cancelled_events
                    .iter()
                    .map(|e| e.restore(now))
                    .collect(),
                cancel_reason: batch.cancel_reason,
            })
            .collect()
    }

    // Return (expired, should_notice). Updating the journal happens before the
    // caller releases the in-flight channel, including during a probe turn.
    pub(crate) fn park(&mut self, batch: &FlushBatch, now: u64) -> (bool, bool) {
        let ids: HashSet<_> = batch
            .events
            .iter()
            .chain(&batch.cancelled_events)
            .map(|e| e.event.id)
            .collect();
        let first = self
            .batches
            .iter()
            .filter(|b| {
                b.events
                    .iter()
                    .chain(&b.cancelled_events)
                    .any(|e| ids.contains(&e.event.id))
            })
            .map(|b| b.first_failure)
            .min()
            .unwrap_or(now);
        if now.saturating_sub(first) >= AUTH_PARK_CAP_SECS {
            self.finish(batch);
            return (true, false);
        }
        self.remove_events(&ids);
        self.batches.push(SavedBatch {
            channel_id: batch.channel_id,
            first_failure: first,
            events: batch
                .events
                .iter()
                .map(|e| SavedEvent::save(e, now))
                .collect(),
            cancelled_events: batch
                .cancelled_events
                .iter()
                .map(|e| SavedEvent::save(e, now))
                .collect(),
            cancel_reason: batch.cancel_reason,
        });
        let notice = !self.noticed_channels.contains(&batch.channel_id)
            && !self.pending_notices.contains_key(&batch.channel_id);
        if notice {
            self.pending_notices
                .insert(batch.channel_id, Uuid::new_v4());
        }
        self.persist();
        (false, notice)
    }

    pub(crate) fn contains(&self, id: nostr::EventId) -> bool {
        self.batches.iter().any(|b| {
            b.events
                .iter()
                .chain(&b.cancelled_events)
                .any(|e| e.event.id == id)
        })
    }

    fn remove_events(&mut self, ids: &HashSet<nostr::EventId>) {
        for batch in &mut self.batches {
            batch.events.retain(|e| !ids.contains(&e.event.id));
            batch
                .cancelled_events
                .retain(|e| !ids.contains(&e.event.id));
        }
        self.batches
            .retain(|b| !b.events.is_empty() || !b.cancelled_events.is_empty());
    }

    pub(crate) fn finish(&mut self, batch: &FlushBatch) {
        let before = self
            .batches
            .iter()
            .map(|b| b.events.len() + b.cancelled_events.len())
            .sum::<usize>();
        self.remove_events(
            &batch
                .events
                .iter()
                .chain(&batch.cancelled_events)
                .map(|e| e.event.id)
                .collect(),
        );
        self.pending_notices.remove(&batch.channel_id);
        let reset_notice = self.noticed_channels.remove(&batch.channel_id);
        let after = self
            .batches
            .iter()
            .map(|b| b.events.len() + b.cancelled_events.len())
            .sum::<usize>();
        if before != after || reset_notice {
            self.persist();
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| -> anyhow::Result<()> {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)?;
            }
            let bytes = serde_json::to_vec(self)?;
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
            tracing::error!(%error, path = %path.display(), "could not persist auth parking journal");
        }
    }
}

// The publication task and event loop share the same journal lock. An accepted
// notice is persisted immediately, without waiting for another prompt/probe.
#[derive(Default, Clone)]
pub(crate) struct AuthParking(Arc<Mutex<ParkingState>>);

impl AuthParking {
    fn state(&self) -> std::sync::MutexGuard<'_, ParkingState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub(crate) fn load(path: PathBuf, now: u64) -> Self {
        Self(Arc::new(Mutex::new(ParkingState::load(path, now))))
    }
    pub(crate) fn restored_batches(&self, now: u64) -> Vec<FlushBatch> {
        self.state().restored_batches(now)
    }
    pub(crate) fn park(&mut self, batch: &FlushBatch, now: u64) -> (bool, bool) {
        self.state().park(batch, now)
    }
    pub(crate) fn contains(&self, id: nostr::EventId) -> bool {
        self.state().contains(id)
    }
    pub(crate) fn finish(&mut self, batch: &FlushBatch) {
        self.state().finish(batch);
    }
    #[cfg(test)]
    pub(crate) fn notice_pending(&self, channel: Uuid) -> bool {
        self.state().pending_notices.contains_key(&channel)
    }
    pub(crate) fn notice_completion(&self, channel: Uuid) -> impl FnOnce(bool) + Send + 'static {
        let token = self.state().pending_notices.get(&channel).copied();
        let parking = self.clone();
        move |accepted| {
            let mut state = parking.state();
            // A late delivery must not suppress a new outage after completion.
            if token.is_some() && state.pending_notices.get(&channel).copied() == token {
                state.pending_notices.remove(&channel);
                if accepted {
                    state.noticed_channels.insert(channel);
                    state.persist();
                }
            }
        }
    }
}
