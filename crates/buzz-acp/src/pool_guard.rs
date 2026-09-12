//! One-pool-per-identity enforcement.
//!
//! Two pools for the same agent identity on one machine race on every
//! mention: both hold relay subscriptions under the same key and both answer,
//! which is the "two of me" duet observed 2026-09-10 (a Saturday launch
//! survivor outliving the fleet that replaced it). The desktop's instance
//! sweeps key on env markers and exe paths, so a survivor whose receipt is
//! gone or whose exe path drifted (dev-tree launches, manual `just staging`
//! runs) slips past them.
//!
//! This guard closes the class at the only point every shape shares: the
//! process itself, keyed by the identity it is about to serve. Before the
//! pool starts, buzz-acp takes an exclusive `flock` on
//! `~/.buzz/WORKING_STATE/pool-locks/<agent-pubkey>.lock`:
//!
//! - **Free lock** — take it, stamp `{pid, started_at, display}`, proceed.
//!   A crashed holder releases automatically (kernel-owned), so a stale file
//!   with a dead pid costs nothing.
//! - **Held by a young process** (started within [`REFUSE_WINDOW_SECS`]) —
//!   refuse: exit non-zero so the launcher surfaces the duplicate instead of
//!   racing two same-age pools against each other.
//! - **Held by an old process** — kill-adopt: SIGTERM, wait out the lock,
//!   SIGKILL if needed, then take over. This is the fleet-restart semantic:
//!   the new launch supersedes the survivor.
//!
//! Everything here fails OPEN on infrastructure problems: an uncreatable
//! lock directory, an unkillable holder, or an unreadable stamp must never
//! wedge the agent fleet — the guard logs loudly and proceeds without the
//! lock. Refusal is reserved for the one case it is safe to be strict: a
//! live, young, verifiable holder of the same identity.

// The crate denies unsafe_code; this module's whole job is two syscalls
// (flock, kill) that std does not expose.
#![allow(unsafe_code)]

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nostr::Keys;

/// A holder younger than this is assumed to be a legitimate same-era launch
/// (double spawn, racing starts): refusing keeps exactly one of them alive.
/// An older holder is a survivor from a superseded launch and is adopted.
pub(crate) const REFUSE_WINDOW_SECS: i64 = 60;

/// How long to wait after SIGTERM before escalating to SIGKILL.
pub(crate) const TERM_GRACE_SECS: u64 = 10;

/// How long to keep polling for the lock after SIGKILL before giving up
/// (and failing open rather than wedging startup).
pub(crate) const KILL_GRACE_SECS: u64 = 5;

/// Poll cadence while waiting out a dying holder.
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// `BUZZ_ACP_POOL_LOCK=off` disables the guard entirely (escape hatch for
/// tests and exotic topologies that genuinely run co-equal pools).
const LOCK_DISABLE_ENV: &str = "BUZZ_ACP_POOL_LOCK";

/// Override for the lock directory, bypassing the derived path. Used by
/// tests; a missing directory is created.
const LOCK_DIR_ENV: &str = "BUZZ_ACP_POOL_LOCK_DIR";

#[derive(Debug)]
pub(crate) enum GuardOutcome {
    /// The lock is held for the process lifetime. Dropping the guard closes
    /// the fd and releases the kernel lock. The payload is never read —
    /// possession IS the lock: keeping the guard alive is the mechanism.
    Held(#[allow(dead_code)] PoolLockGuard),
    /// The guard could not run (disabled, no home, unwritable dir) and the
    /// pool proceeds unprotected. Never an error by itself. The reason is
    /// for the caller's log.
    Bypassed(&'static str),
}

#[derive(Debug)]
pub(crate) struct PoolLockGuard {
    /// Held open for the guard's lifetime: dropping it releases the kernel
    /// lock. Read access is deliberately not exposed — possession IS the
    /// lock.
    _file: File,
}

#[derive(Debug)]
enum Stamp {
    Live { pid: u32, age_secs: i64 },
    Unreadable,
}

/// Take the per-identity pool lock for `keys`, or refuse.
pub(crate) fn acquire_pool_lock(keys: &Keys, display_name: &str) -> Result<GuardOutcome, String> {
    if std::env::var(LOCK_DISABLE_ENV)
        .map(|v| v.eq_ignore_ascii_case("off") || v == "0")
        .unwrap_or(false)
    {
        return Ok(GuardOutcome::Bypassed("BUZZ_ACP_POOL_LOCK=off"));
    }

    let Some(dir) = lock_dir() else {
        return Ok(GuardOutcome::Bypassed("no lock directory available"));
    };
    if std::fs::create_dir_all(&dir).is_err() {
        tracing::warn!(
            lock_dir = %dir.display(),
            "pool-guard: cannot create lock directory — proceeding WITHOUT one-pool enforcement"
        );
        return Ok(GuardOutcome::Bypassed("lock directory uncreatable"));
    }
    let path = dir.join(format!("{}.lock", keys.public_key().to_hex()));

    // Fast path: a dead holder (or a first launch) releases at the kernel.
    if let Ok(guard) = try_lock(&path, display_name) {
        return Ok(GuardOutcome::Held(guard));
    }

    // Someone holds it. Decide refuse vs adopt from the stamp's age.
    match read_stamp(&path) {
        Stamp::Live { pid, age_secs } => {
            if age_secs < REFUSE_WINDOW_SECS {
                return Err(format!(
                    "another pool for this agent identity started {age_secs}s ago \
                     (pid {pid}, lock {}); refusing to run a duplicate pool",
                    path.display()
                ));
            }
            tracing::warn!(
                pid,
                age_secs,
                lock = %path.display(),
                "pool-guard: adopting the identity from a superseded pool"
            );
            adopt(&path, pid, display_name)
        }
        Stamp::Unreadable => {
            // Busy but unreadable: give a dying writer a moment, then fail
            // open rather than refuse on evidence we cannot read.
            std::thread::sleep(POLL_INTERVAL);
            match try_lock(&path, display_name) {
                Ok(guard) => Ok(GuardOutcome::Held(guard)),
                Err(()) => {
                    tracing::warn!(
                        lock = %path.display(),
                        "pool-guard: lock busy and stamp unreadable — proceeding WITHOUT lock"
                    );
                    Ok(GuardOutcome::Bypassed("lock stamp unreadable"))
                }
            }
        }
    }
}

/// SIGTERM → wait out the grace → SIGKILL → wait out the kill grace → take
/// the lock. Fails open (never blocks startup) if the holder never dies.
fn adopt(path: &Path, pid: u32, display_name: &str) -> Result<GuardOutcome, String> {
    if pid == std::process::id() || pid == 0 {
        // A stamp naming OUR pid while we do not hold the lock is corruption
        // (or pid reuse): signalling it would be killing ourselves. Wait out
        // the grace instead — if the flock frees, take it; if not, fail open.
        tracing::error!(
            pid,
            lock = %path.display(),
            "pool-guard: stamp names this process but the lock is foreign — not signalling"
        );
    } else {
        send_signal(pid, Signal::Term);
    }
    if !wait_for_lock(path, TERM_GRACE_SECS) {
        tracing::warn!(pid, "pool-guard: holder survived SIGTERM — SIGKILL");
        send_signal(pid, Signal::Kill);
        if !wait_for_lock(path, KILL_GRACE_SECS) {
            tracing::error!(
                pid,
                lock = %path.display(),
                "pool-guard: holder will not die — proceeding WITHOUT lock"
            );
            return Ok(GuardOutcome::Bypassed("holder survived SIGKILL"));
        }
    }
    match try_lock(path, display_name) {
        Ok(guard) => Ok(GuardOutcome::Held(guard)),
        // The lock freed but someone else raced us onto it: that winner is a
        // same-machine pool for this identity, which is the invariant —
        // re-read and recurse rather than proceed duplicate.
        Err(()) => acquire_by_recheck(path, display_name),
    }
}

fn acquire_by_recheck(path: &Path, display_name: &str) -> Result<GuardOutcome, String> {
    match read_stamp(path) {
        Stamp::Live { pid, age_secs } => {
            if age_secs < REFUSE_WINDOW_SECS {
                Err(format!(
                    "another pool for this agent identity started {age_secs}s ago \
                     (pid {pid}, lock {}); refusing to run a duplicate pool",
                    path.display()
                ))
            } else {
                adopt(path, pid, display_name)
            }
        }
        Stamp::Unreadable => Ok(GuardOutcome::Bypassed("raced lock stamp unreadable")),
    }
}

/// Non-blocking exclusive flock; on success truncate + stamp our pid.
fn try_lock(path: &std::path::Path, display_name: &str) -> Result<PoolLockGuard, ()> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| ())?;
    if flock_nonblocking(&file).is_err() {
        return Err(());
    }
    let stamp = serde_json::json!({
        "pid": std::process::id(),
        "started_at": chrono::Utc::now().to_rfc3339(),
        "display": display_name,
    });
    let mut file = file;
    file.set_len(0).map_err(|_| ())?;
    file.write_all(stamp.to_string().as_bytes())
        .map_err(|_| ())?;
    Ok(PoolLockGuard { _file: file })
}

/// Poll `try_lock` without stamping mismatches — used while a dying holder
/// releases. Returns true if the lock became available (caller re-runs the
/// full stamping path).
fn wait_for_lock(path: &std::path::Path, grace_secs: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(grace_secs);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
        let file = match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        if flock_nonblocking(&file).is_ok() {
            // Release immediately: the caller re-acquires with a stamp.
            drop(file);
            return true;
        }
    }
    false
}

fn read_stamp(path: &std::path::Path) -> Stamp {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Stamp::Unreadable,
    };
    let doc: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(doc) => doc,
        Err(_) => return Stamp::Unreadable,
    };
    let Some(pid) = doc.get("pid").and_then(|v| v.as_u64()) else {
        return Stamp::Unreadable;
    };
    let Some(at) = doc.get("started_at").and_then(|v| v.as_str()) else {
        return Stamp::Unreadable;
    };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(at) else {
        return Stamp::Unreadable;
    };
    let age_secs = (chrono::Utc::now() - at.with_timezone(&chrono::Utc)).num_seconds();
    Stamp::Live {
        pid: u32::try_from(pid).unwrap_or(0),
        age_secs,
    }
}

fn lock_dir() -> Option<PathBuf> {
    if let Ok(overridden) = std::env::var(LOCK_DIR_ENV) {
        let overridden = overridden.trim().to_string();
        if !overridden.is_empty() {
            return Some(PathBuf::from(overridden));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(
        PathBuf::from(home)
            .join(".buzz")
            .join("WORKING_STATE")
            .join("pool-locks"),
    )
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

fn send_signal(pid: u32, signal: Signal) {
    #[cfg(unix)]
    {
        let signo = match signal {
            Signal::Term => 15,
            Signal::Kill => 9,
        };
        // kill(2) via libc FFI — declared here rather than taking a libc
        // dependency for two syscalls, mirroring the desktop sweep's extern
        // declarations.
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let rc = unsafe { kill(pid as i32, signo) };
        if rc != 0 {
            tracing::debug!(pid, signo, "pool-guard: kill syscall returned nonzero");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
    }
}

fn flock_nonblocking(file: &File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd as _;
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if rc == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // Windows has no flock; the guard fails open off-Unix.
        let _ = file;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "flock unavailable",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test here mutates the process-global `LOCK_DIR_ENV`; the
    /// harness runs tests on parallel threads. Hold this mutex for the whole
    /// body or the tests race each other's lock directory.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("buzz-pool-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp lock dir");
        // Route the guard at it via the env override.
        std::env::set_var(LOCK_DIR_ENV, &dir);
        dir
    }

    fn keys() -> Keys {
        Keys::generate()
    }

    /// The primary contract: a second acquire of the same identity REFUSES
    /// while the first holder is young. This is the test that fails if the
    /// refuse window or the stamp age math breaks.
    #[test]
    fn young_holder_refuses_duplicate() {
        let _env = env_guard();
        let _dir = temp_dir();
        let keys = keys();
        let first = acquire_pool_lock(&keys, "Evie").expect("first acquire");
        assert!(
            matches!(first, GuardOutcome::Held(_)),
            "first acquire must hold"
        );
        let second = acquire_pool_lock(&keys, "Evie");
        assert!(
            second.is_err(),
            "a young live holder must refuse a duplicate pool, got {second:?}"
        );
    }

    /// A lock file whose holder is long gone (flock released by the kernel)
    /// is adoptable without error: the fast path just takes it.
    #[test]
    fn dead_holder_is_adopted_freely() {
        let _env = env_guard();
        let dir = temp_dir();
        let keys = keys();
        let path = dir.join(format!("{}.lock", keys.public_key().to_hex()));
        // A stamp from an hour ago whose process no longer exists. flock on
        // this file is free, so the guard never even reads the stamp.
        std::fs::write(
            &path,
            serde_json::json!({
                "pid": 999999,
                "started_at": (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
                "display": "ghost"
            })
            .to_string(),
        )
        .expect("write ghost stamp");
        let outcome = acquire_pool_lock(&keys, "Evie").expect("ghost holder must not error");
        assert!(
            matches!(outcome, GuardOutcome::Held(_)),
            "ghost holder must be adopted, got {outcome:?}"
        );
        // Adoption re-stamped the lock file with OUR pid — prove the guard
        // holds THIS file and took ownership of it.
        let stamp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read restamped lock"))
                .expect("lock file must still parse as a stamp");
        assert_eq!(
            stamp.get("pid").and_then(|v| v.as_u64()),
            Some(u64::from(std::process::id())),
            "adopted lock must be restamped with the adopting pid"
        );
    }

    /// A STAMPED old holder whose flock is still held (simulated by holding
    /// the file locked here) routes to the adopt path; since the pid is our
    /// own test process, adopt would be killing ourselves — instead this test
    /// pins the decision boundary through read_stamp + the age check that
    /// selects refuse vs adopt.
    #[test]
    fn stamp_age_selects_refuse_vs_adopt() {
        let _env = env_guard();
        let dir = temp_dir();
        let path = dir.join("decision.lock");

        let young = serde_json::json!({
            "pid": 4242,
            "started_at": (chrono::Utc::now() - chrono::Duration::seconds(59)).to_rfc3339(),
        })
        .to_string();
        std::fs::write(&path, &young).unwrap();
        match read_stamp(&path) {
            Stamp::Live { age_secs, .. } => assert!(
                age_secs < REFUSE_WINDOW_SECS,
                "59s-old holder must classify as young (refuse)"
            ),
            other => panic!("young stamp must parse, got {other:?}"),
        }

        let old = serde_json::json!({
            "pid": 4242,
            "started_at": (chrono::Utc::now() - chrono::Duration::seconds(61)).to_rfc3339(),
        })
        .to_string();
        std::fs::write(&path, &old).unwrap();
        match read_stamp(&path) {
            Stamp::Live { age_secs, .. } => assert!(
                age_secs >= REFUSE_WINDOW_SECS,
                "61s-old holder must classify as old (adopt)"
            ),
            other => panic!("old stamp must parse, got {other:?}"),
        }
    }

    /// Garbage stamps read as Unreadable — never as a refuse-worthy claim.
    #[test]
    fn garbage_stamp_is_unreadable() {
        let _env = env_guard();
        let dir = temp_dir();
        let path = dir.join("garbage.lock");
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(read_stamp(&path), Stamp::Unreadable));
        let missing = dir.join("missing.lock");
        assert!(matches!(read_stamp(&missing), Stamp::Unreadable));
    }

    /// Distinct identities never contend: different pubkeys, different files.
    #[test]
    fn distinct_identities_do_not_contend() {
        let _env = env_guard();
        let _dir = temp_dir();
        let first = acquire_pool_lock(&keys(), "Evie").expect("evie acquires");
        let second = acquire_pool_lock(&keys(), "Crash Override").expect("crash acquires");
        assert!(matches!(first, GuardOutcome::Held(_)));
        assert!(matches!(second, GuardOutcome::Held(_)));
    }

    /// Real exclusion: flock is per open-file-description, so a second
    /// `try_lock` on the same path from THIS process fails while the first
    /// guard holds it — proving the FFI call, flags, and fd are right — and
    /// succeeds after the first guard drops.
    #[test]
    fn second_lock_on_held_file_fails_until_released() {
        let _env = env_guard();
        let dir = temp_dir();
        let keys = keys();
        let path = dir.join(format!("{}.lock", keys.public_key().to_hex()));

        let first = try_lock(&path, "Evie").expect("first try_lock holds");
        assert!(
            try_lock(&path, "Evie").is_err(),
            "second flock on a held file must fail"
        );
        drop(first);
        let second = try_lock(&path, "Evie").expect("try_lock after release succeeds");
        // The stamp was rewritten, not appended.
        let raw = std::fs::read_to_string(&path).expect("stamp readable");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw).unwrap()["pid"],
            serde_json::json!(std::process::id())
        );
        drop(second);
    }
}
