//! Cancellable grace period for the empty-room huddle auto-end (defect V1a).
//!
//! The relay used to archive a huddle the same millisecond its last audio
//! peer disconnected — a page reload drops the WebSocket and the reloading
//! peer rejoins moments later, into a huddle that no longer exists. Instead
//! of archiving immediately, the last-leaver path arms a grace timer:
//!
//! ```text
//! last peer leaves ──► grace armed (room stays resident + admissible)
//!     ├─ any peer (re)joins  ──► grace cancelled, huddle lives on
//!     └─ timer fires, room still empty ──► archive exactly as before
//! ```
//!
//! The timer is an ordinary tokio task (`sleep` racing a
//! [`CancellationToken`], the codebase's existing delayed-work idiom), and
//! every fire re-checks live state under the room's admission guard, so a
//! timer that outlives its room or races a rejoining peer can never archive
//! a huddle that is still in use.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::info;
use uuid::Uuid;

use buzz_core::CommunityId;

use crate::audio::room::AudioRoomManager;

/// How long an emptied huddle audio room waits for a rejoining peer before
/// the auto-end archive runs. Long enough to cover a page reload or a brief
/// network blip, short enough that a genuinely abandoned huddle ends promptly.
pub(crate) const EMPTY_ROOM_AUTO_END_GRACE: Duration = Duration::from_secs(30);

/// Outcome of the archive side of a grace fire.
///
/// `Ended` and `AlreadyEnded` both leave the huddle finished; the difference
/// is only who did the archiving (this fire, or another path such as an
/// explicit actor archive or the ephemeral-channel TTL reaper). `Failed`
/// means the DB rejected the archive — the huddle stays alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GraceArchiveOutcome {
    /// This fire archived the channel and emitted kind:48103.
    Ended,
    /// The channel was already archived by another path while the grace ran.
    AlreadyEnded,
    /// The archive failed; the room must be un-ended and stay alive.
    Failed,
}

/// Run one empty-room auto-end grace to completion.
///
/// Arms nothing: the caller has already installed the cancellation token in
/// the manager via [`AudioRoomManager::start_empty_grace`] and spawned this
/// task with it. On fire, the task re-checks every piece of state it acts on,
/// in order:
///
/// 1. **Cancelled** — a peer rejoined inside the window; do nothing.
/// 2. **Entry consumed** — [`AudioRoomManager::take_empty_grace`] makes this
///    fire the single winner for the grace generation. A fire that lost (the
///    entry was already consumed by a rejoin's cancel, an earlier fire, or
///    another end path) is a no-op, which is what makes double-archive /
///    double-48103 impossible.
/// 3. **Room known** — a room the manager no longer knows about (failed-join
///    cleanup, restart race) is never archived.
/// 4. **Room still empty** — `mark_ended` atomically (under the admission
///    guard, the same lock `add_peer` uses) verifies emptiness and blocks new
///    admissions. A peer that snuck in during the fire race wins: the end
///    flag is rolled back and the huddle lives on.
///
/// Only then does the caller-supplied `archive` run — the exact archive
/// sequence the old same-millisecond auto-end performed. `on_ended` (the
/// owner-lease release) fires only after a successful archive, preserving the
/// old release semantics: a room that survives the fire keeps its lease.
pub(crate) async fn run_empty_room_grace<A, Fut, R>(
    manager: Arc<AudioRoomManager>,
    community_id: CommunityId,
    channel_id: Uuid,
    grace: Duration,
    token: CancellationToken,
    archive: A,
    on_ended: R,
) where
    A: FnOnce() -> Fut,
    Fut: Future<Output = GraceArchiveOutcome>,
    R: FnOnce(),
{
    tokio::select! {
        _ = token.cancelled() => {
            // A peer (re)joined inside the window; the admission path already
            // removed the manager entry. The huddle lives on.
            return;
        }
        _ = tokio::time::sleep(grace) => {}
    }

    // Single-winner guard: consuming the entry makes this the only fire for
    // this grace generation. Every other consumer of the room's end — a
    // rejoining peer's cancel, an earlier fire, another end path — removes
    // the entry first, and a fire without an entry is a no-op.
    if manager.take_empty_grace(community_id, channel_id).is_none() {
        return;
    }

    // Defensive re-check: never archive a room the manager no longer knows
    // about (a failed-join cleanup or a restart race removed it while the
    // timer was pending).
    let Some(room) = manager.get(community_id, channel_id) else {
        info!(
            channel_id = %channel_id,
            "auto-end grace fired but the room is gone — skipping archive"
        );
        return;
    };

    // Atomically (under the admission guard) verify the room is still empty
    // and block admissions for the duration of the archive. If a peer snuck
    // in first, they won: roll the end flag back so their eventual departure
    // can re-arm a fresh grace.
    if !room.mark_ended() {
        room.clear_ended();
        info!(
            channel_id = %channel_id,
            "auto-end grace fired but the room repopulated — keeping huddle alive"
        );
        return;
    }

    info!(
        channel_id = %channel_id,
        "auto-end grace fired — proceeding to archive"
    );
    match archive().await {
        GraceArchiveOutcome::Ended => on_ended(),
        GraceArchiveOutcome::AlreadyEnded => {}
        GraceArchiveOutcome::Failed => room.clear_ended(),
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// Short grace for tests that must observe a fire; long enough to still
    /// be cancellable from the test task between spawns.
    const TEST_GRACE: Duration = Duration::from_millis(50);
    /// Longer than any test grace — used to bound awaits.
    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    fn test_key() -> (CommunityId, Uuid) {
        (CommunityId::from_uuid(Uuid::new_v4()), Uuid::new_v4())
    }

    /// Counting fake for the archive side effect. Optionally performs the
    /// real room eviction so fire-path tests exercise the same manager state
    /// transitions production does.
    #[derive(Clone, Default)]
    struct ArchiveSpy {
        calls: Arc<AtomicUsize>,
    }

    impl ArchiveSpy {
        fn count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        /// Archive closure returning `outcome`, bumping the counter at fire
        /// time (i.e. only for fires that reach the archive). Non-failed
        /// outcomes evict the room like the production closure does.
        fn closure(
            &self,
            manager: &Arc<AudioRoomManager>,
            key: (CommunityId, Uuid),
            outcome: GraceArchiveOutcome,
        ) -> Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = GraceArchiveOutcome> + Send>> + Send>
        {
            let calls = Arc::clone(&self.calls);
            let manager = Arc::clone(manager);
            Box::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let manager = Arc::clone(&manager);
                Box::pin(async move {
                    if outcome != GraceArchiveOutcome::Failed {
                        manager.cleanup_if_empty(key.0, key.1);
                    }
                    outcome
                })
            })
        }
    }

    async fn run_to_completion(future: impl Future) {
        tokio::time::timeout(TEST_TIMEOUT, future)
            .await
            .expect("grace task must settle inside the test timeout");
    }

    /// The core fire: an empty room that nobody rejoins is archived exactly
    /// once, evicted from the manager, and the lease release fires.
    #[tokio::test]
    async fn grace_fires_and_archives_when_room_stays_empty() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        manager.get_or_create(key.0, key.1); // room exists and is empty

        let token = manager
            .start_empty_grace(key.0, key.1)
            .expect("first grace arms");
        let spy = ArchiveSpy::default();
        let released = Arc::new(AtomicUsize::new(0));
        let release_counter = Arc::clone(&released);

        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            move || {
                release_counter.fetch_add(1, Ordering::SeqCst);
            },
        ))
        .await;

        assert_eq!(spy.count(), 1, "exactly one archive must run");
        assert_eq!(
            released.load(Ordering::SeqCst),
            1,
            "lease release fires once"
        );
        assert!(
            manager.get(key.0, key.1).is_none(),
            "fired room must be evicted from the manager"
        );
        assert!(
            manager.take_empty_grace(key.0, key.1).is_none(),
            "fired grace must not leave its entry behind"
        );
    }

    /// Defect V1a's fix, pinned end-to-end at the mechanism level: the exact
    /// production sequence — last peer leaves (armed grace), the same peer
    /// reloads and rejoins, admission cancels the grace — must never archive.
    #[tokio::test]
    async fn peer_rejoin_inside_the_grace_window_cancels_the_auto_end() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        let room = manager.get_or_create(key.0, key.1);

        // Last peer leaves: the handler's auto-end precondition.
        let (peer_id, ..) = room.add_peer("reload-victim".into(), 1).expect("admit");
        let (_, ended) = room
            .remove_peer_and_check_ended(peer_id)
            .expect("peer existed");
        assert!(ended, "solo departure must arm the auto-end");

        // Handler arm sequence: room becomes admissible again, grace installed.
        room.clear_ended();
        let token = manager
            .start_empty_grace(key.0, key.1)
            .expect("grace arms after solo departure");

        let spy = ArchiveSpy::default();
        let runner = tokio::spawn(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            || {},
        ));

        // The reload: same peer rejoins inside the window, admission succeeds
        // into the SAME room generation, and the admission hook cancels.
        room.add_peer("reload-victim".into(), 1)
            .expect("rejoin must be admitted while the grace is pending");
        assert!(
            manager.cancel_empty_grace(key.0, key.1),
            "admission must find the pending grace to cancel"
        );

        run_to_completion(runner).await;

        assert_eq!(
            spy.count(),
            0,
            "a refilled room must never be archived — join inside the window cancels the grace"
        );
        let room = manager
            .get(key.0, key.1)
            .expect("cancelled grace keeps the room resident");
        assert_eq!(room.peers.len(), 1, "rejoined peer stays in the room");
    }

    /// Invariant: a timer firing after the room already ended by another path
    /// (entry consumed, room evicted — e.g. an explicit actor archive or the
    /// TTL reaper got there first) must be a silent no-op. No second archive,
    /// no second 48103, no lease release for an end this fire did not make.
    #[tokio::test]
    async fn grace_fire_after_the_room_already_ended_by_another_path_is_a_noop() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        manager.get_or_create(key.0, key.1);

        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");

        // Another path consumes the end while the timer is pending.
        assert!(manager.take_empty_grace(key.0, key.1).is_some());
        assert!(
            manager.cleanup_if_empty(key.0, key.1),
            "with the grace consumed, the empty room is evictable"
        );

        let spy = ArchiveSpy::default();
        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            || {},
        ))
        .await;

        assert_eq!(
            spy.count(),
            0,
            "a fire whose grace generation is already consumed must not archive again"
        );
    }

    /// Invariant: no double-archive / double-48103. Two fire paths racing one
    /// grace generation — the exact "timer double-fires" mutation — must
    /// produce exactly one archive and one lease release.
    #[tokio::test]
    async fn only_one_fire_wins_a_single_grace_generation() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        manager.get_or_create(key.0, key.1);

        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");

        let spy = ArchiveSpy::default();
        let released = Arc::new(AtomicUsize::new(0));
        let release_a = Arc::clone(&released);
        let release_b = Arc::clone(&released);
        let runner_a = tokio::spawn(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token.clone(),
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            move || {
                release_a.fetch_add(1, Ordering::SeqCst);
            },
        ));
        let runner_b = tokio::spawn(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            move || {
                release_b.fetch_add(1, Ordering::SeqCst);
            },
        ));

        run_to_completion(runner_a).await;
        run_to_completion(runner_b).await;

        assert_eq!(
            spy.count(),
            1,
            "exactly one fire may archive a single grace generation"
        );
        assert_eq!(
            released.load(Ordering::SeqCst),
            1,
            "the lease release belongs to the winning fire only"
        );
    }

    /// Shutdown/restart-race invariant: a pending timer must not archive a
    /// room that the manager no longer knows about. The fire re-checks room
    /// existence and stands down.
    #[tokio::test]
    async fn grace_fire_for_a_room_unknown_to_state_skips_the_archive() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        // Grace armed, but no room exists in the manager — the restart-race
        // shape (state lost the room while the timer was pending).
        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");

        let spy = ArchiveSpy::default();
        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            || {},
        ))
        .await;

        assert_eq!(
            spy.count(),
            0,
            "a room the state no longer knows about must never be archived by a stale timer"
        );
    }

    /// The old auto-end's rollback, preserved: a failed archive un-ends the
    /// room so it stays alive and admissible (matching the previous
    /// clear_ended-on-archive-error behavior).
    #[tokio::test]
    async fn failed_archive_rolls_back_the_end_flag_and_keeps_the_room() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        manager.get_or_create(key.0, key.1);

        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");
        let spy = ArchiveSpy::default();
        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Failed),
            || {},
        ))
        .await;

        assert_eq!(spy.count(), 1);
        let room = manager
            .get(key.0, key.1)
            .expect("failed archive keeps the room resident");
        room.add_peer("late-joiner".into(), 1)
            .expect("room must be admissible again after a failed archive");
    }

    /// A peer that snuck in during the fire race wins over the timer: the end
    /// flag is rolled back, nothing archives, and the room keeps admitting.
    #[tokio::test]
    async fn grace_fire_racing_a_sneaky_peer_keeps_the_room_alive() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        let room = manager.get_or_create(key.0, key.1);
        room.add_peer("sneaky".into(), 1).expect("admit");

        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");
        let spy = ArchiveSpy::default();
        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::Ended),
            || {},
        ))
        .await;

        assert_eq!(
            spy.count(),
            0,
            "a repopulated room must never be archived by the fire"
        );
        room.add_peer("after-fire".into(), 1)
            .expect("end flag must be rolled back so the room keeps admitting");
    }

    /// A fire that reaches the archive for a channel another path already
    /// archived (explicit archive, TTL reaper) must not archive twice — the
    /// closure skips and the room is still evicted.
    #[tokio::test]
    async fn fire_against_an_already_archived_channel_skips_the_second_end() {
        let manager = Arc::new(AudioRoomManager::new());
        let key = test_key();
        manager.get_or_create(key.0, key.1);

        let token = manager.start_empty_grace(key.0, key.1).expect("grace arms");
        let spy = ArchiveSpy::default();
        run_to_completion(crate::audio::grace::run_empty_room_grace(
            Arc::clone(&manager),
            key.0,
            key.1,
            TEST_GRACE,
            token,
            spy.closure(&manager, key, GraceArchiveOutcome::AlreadyEnded),
            || {
                panic!("lease release must not fire for an end another path made");
            },
        ))
        .await;

        assert_eq!(spy.count(), 1);
        assert!(
            manager.get(key.0, key.1).is_none(),
            "an already-archived huddle's empty room must still be evicted"
        );
    }
}
