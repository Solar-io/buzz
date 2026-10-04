//! Two-account Claude "pool" routing.
//!
//! A pool is a Claude account selected by the `CLAUDE_CONFIG_DIR` env var on
//! the child `claude-agent-acp` process. The account at `~/.claude` is reached
//! by NOT setting the var at all; any other account directory is reached by
//! setting `CLAUDE_CONFIG_DIR=<absolute dir>`.
//!
//! Per-agent config file: `~/.buzz/agent-pools.json` (path overridable via
//! `BUZZ_AGENT_POOLS_CONFIG`):
//!
//! ```json
//! { "version": 1, "default": "A",
//!   "pools": { "A": {"label": "main", "configDir": null},
//!              "B": {"label": "second", "configDir": "~/cc2"} },
//!   "assign": { "Gilfoyle": "B" },
//!   "overflow": { "enabled": true, "cooldownMinutes": 60 } }
//! ```
//!
//! Resolution mirrors `voice_turn`'s effort file: keyed by the sidecar's
//! display name (`BUZZ_ACP_DISPLAY_NAME`) case-insensitively, re-read fresh at
//! every spawn, fail-soft (missing/invalid file, or a `default` naming no
//! pool, turns routing OFF — the child inherits the parent env unchanged).
//!
//! HARD RULE: a pool whose `configDir` is null or normalizes to
//! `$HOME/.claude` yields NO env entry. Setting `CLAUDE_CONFIG_DIR` even to
//! the default dir re-keys Claude Code's credential store and drops its
//! MCP/login state, so the default account must always be reached by
//! inheritance.
//!
//! GATE: routing applies only to Claude adapters whose effective env carries
//! none of the custom-auth vars (`GATE_ENV_VARS`) — this keeps GLM/omniroute
//! and other proxied agents on whatever they were configured with.
//!
//! Quota state is account-scoped and shared through an atomically replaced JSON
//! file. Each routing decision reloads it; slot attribution stays process-local.

use chrono::{DateTime, Datelike, TimeZone, Utc};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Env var the pool selects.
pub const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// Env var overriding the pools config file path.
pub const ENV_CONFIG_PATH: &str = "BUZZ_AGENT_POOLS_CONFIG";

/// Env var carrying the sidecar's display name.
pub const ENV_AGENT_NAME: &str = "BUZZ_ACP_DISPLAY_NAME";

/// Default config location, relative to `$HOME`.
pub const DEFAULT_CONFIG_RELATIVE: &str = ".buzz/agent-pools.json";

/// Any of these present in the child's effective env means the agent is
/// already on custom auth / a proxy: routing is skipped.
pub const GATE_ENV_VARS: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolDef {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub config_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverflowConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_cooldown_minutes")]
    pub cooldown_minutes: u64,
}

fn default_cooldown_minutes() -> u64 {
    60
}

impl Default for OverflowConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cooldown_minutes: default_cooldown_minutes(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PoolsFile {
    #[serde(default)]
    pub version: Option<u64>,
    pub default: String,
    pub pools: HashMap<String, PoolDef>,
    #[serde(default)]
    pub assign: HashMap<String, String>,
    #[serde(default)]
    pub overflow: OverflowConfig,
}

impl PoolsFile {
    /// The pool id the file assigns to `display_name` (case-insensitive),
    /// falling back to `default` for unlisted names or unknown pool ids.
    /// `None` when `default` itself names no pool (routing off).
    pub fn assigned_pool(&self, display_name: &str) -> Option<String> {
        if !self.pools.contains_key(&self.default) {
            return None;
        }
        let wanted = display_name.trim();
        let assigned = self
            .assign
            .iter()
            .find(|(name, _)| name.trim().eq_ignore_ascii_case(wanted))
            .map(|(_, pool)| pool.clone())
            .filter(|pool| self.pools.contains_key(pool));
        Some(assigned.unwrap_or_else(|| self.default.clone()))
    }

    fn cooldown(&self) -> Duration {
        Duration::from_secs(self.overflow.cooldown_minutes.saturating_mul(60))
    }
}

/// Read and parse the pools file. Missing, unreadable, or invalid → `None`.
pub fn load(path: &Path) -> Option<PoolsFile> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<PoolsFile>(&text) {
        Ok(file) => Some(file),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "auth_pool: invalid pools file — routing off");
            None
        }
    }
}

/// Config path: `$BUZZ_AGENT_POOLS_CONFIG` if set/non-blank, else
/// `$HOME/.buzz/agent-pools.json`.
pub fn config_path(env_override: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = env_override.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let home = home.map(str::trim).filter(|h| !h.is_empty())?;
    Some(Path::new(home).join(DEFAULT_CONFIG_RELATIVE))
}

/// Expand a leading `~` and strip trailing slashes.
fn expand_dir(dir: &str, home: Option<&str>) -> Option<PathBuf> {
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    let expanded = if dir == "~" {
        PathBuf::from(home?)
    } else if let Some(rest) = dir.strip_prefix("~/") {
        Path::new(home?).join(rest)
    } else {
        PathBuf::from(dir)
    };
    // Normalize away `.` segments and trailing separators.
    let normalized: PathBuf = expanded
        .components()
        .filter(|c| !matches!(c, std::path::Component::CurDir))
        .collect();
    Some(normalized)
}

/// The env entry a pool's `configDir` produces. `None` (inherit) for null,
/// blank, relative, or anything normalizing to `$HOME/.claude`.
pub fn pool_env(def: &PoolDef, home: Option<&str>) -> Option<(String, String)> {
    let dir = expand_dir(def.config_dir.as_deref()?, home)?;
    if !dir.is_absolute() {
        return None;
    }
    if let Some(home) = home.map(str::trim).filter(|h| !h.is_empty()) {
        let default_dir: PathBuf = Path::new(home)
            .join(".claude")
            .components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect();
        if dir == default_dir {
            return None;
        }
    }
    Some((
        CLAUDE_CONFIG_DIR.to_string(),
        dir.to_string_lossy().into_owned(),
    ))
}

/// Outcome of resolving a pool for one spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolDecision {
    /// Effective pool, `None` when routing is off/skipped.
    pub pool_id: Option<String>,
    /// The pool the agent is assigned to before any overflow redirect
    /// (`None` when routing is off).
    pub assigned: Option<String>,
    /// The env entry to inject, `None` = inherit.
    pub env: Option<(String, String)>,
    pub reason: &'static str,
}

impl PoolDecision {
    fn off(reason: &'static str) -> Self {
        Self {
            pool_id: None,
            assigned: None,
            env: None,
            reason,
        }
    }
}

/// True when any gate var is present (non-empty) in `env`.
fn has_custom_auth(env: &[(String, String)]) -> bool {
    env.iter()
        .any(|(k, v)| GATE_ENV_VARS.contains(&k.as_str()) && !v.trim().is_empty())
}

/// Resolve a spawn against freshly read shared status; time and home are explicit.
pub fn resolve(
    file: Option<&PoolsFile>,
    display_name: &str,
    parent_env: &[(String, String)],
    adapter_is_claude: bool,
    overflow: &OverflowState,
    home: Option<&str>,
    now: DateTime<Utc>,
) -> PoolDecision {
    if !adapter_is_claude {
        return PoolDecision::off("skipped_non_claude_adapter");
    }
    if has_custom_auth(parent_env) {
        return PoolDecision::off("skipped:custom-auth");
    }
    let Some(file) = file else {
        return PoolDecision::off("off_no_config");
    };
    let Some(assigned) = file.assigned_pool(display_name) else {
        return PoolDecision::off("off_unknown_default");
    };
    let assigned_id = assigned.clone();
    let (effective, reason) = overflow.route(file, &assigned, now);
    let env = file
        .pools
        .get(&effective)
        .and_then(|def| pool_env(def, home));
    PoolDecision {
        pool_id: Some(effective),
        assigned: Some(assigned_id),
        env,
        reason,
    }
}

/// What a quota error should do to this slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverflowAction {
    /// Respawn on the selected account, without recording a crash.
    FlipTo(String),
    /// The current pool is already the earliest available reset.
    Stay,
    /// Routing or overflow disabled.
    Disabled,
}

/// Shared account availability, serialized with an explicit UTC reset time.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PoolStatus {
    out_until_rfc3339: DateTime<Utc>,
    reason: String,
}

#[derive(Debug, Default)]
struct OverflowInner {
    statuses: HashMap<String, PoolStatus>,
    slot_pool: HashMap<usize, String>,
}

/// Shared account status file override.
pub const ENV_STATUS_PATH: &str = "BUZZ_POOL_STATUS_PATH";

/// Resolve the shared account status path.
pub fn status_path(env_override: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = env_override.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(path));
    }
    Some(
        Path::new(home.map(str::trim).filter(|s| !s.is_empty())?)
            .join(".buzz/state/pool-status.json"),
    )
}

/// Account availability plus process-local slot attribution.
#[derive(Debug, Clone, Default)]
pub struct OverflowState {
    inner: Arc<Mutex<OverflowInner>>,
    path: Option<PathBuf>,
}

/// Parse Claude's reset message in its stated IANA timezone, or use cooldown.
pub fn quota_reset(message: &str, now: DateTime<Utc>, cooldown: Duration) -> DateTime<Utc> {
    let parsed = (|| {
        let reset = message.split_once("resets ")?.1;
        let (date_time, zone) = reset.split_once('(')?;
        let tz: chrono_tz::Tz = zone.split_once(')')?.0.trim().parse().ok()?;
        let text = date_time.trim();
        let local_now = now.with_timezone(&tz);
        let (date, time, dated) = if let Some((date, time)) = text.split_once(" at ") {
            let date = chrono::NaiveDate::parse_from_str(
                &format!("{} {}", local_now.year(), date.trim()),
                "%Y %b %e",
            )
            .ok()?;
            (date, time.trim(), true)
        } else {
            (local_now.date_naive(), text, false)
        };
        let time = time.to_ascii_lowercase().replace(' ', "");
        let (clock, pm) = if let Some(clock) = time.strip_suffix("am") {
            (clock, false)
        } else {
            (time.strip_suffix("pm")?, true)
        };
        let (hour, minute) = clock.split_once(':').unwrap_or((clock, "0"));
        let hour: u32 = hour.parse().ok()?;
        if !(1..=12).contains(&hour) {
            return None;
        }
        let time = chrono::NaiveTime::from_hms_opt(
            hour % 12 + if pm { 12 } else { 0 },
            minute.parse().ok()?,
            0,
        )?;
        let mut date = date;
        for _ in 0..3 {
            // On an ambiguous DST boundary choose the later occurrence. A
            // nonexistent local time has no reliable reset: use the fallback.
            let candidate = tz
                .from_local_datetime(&date.and_time(time))
                .latest()?
                .with_timezone(&Utc);
            if candidate > now {
                return Some(candidate);
            }
            date = if dated {
                date.with_year(date.year() + 1)?
            } else {
                date.succ_opt()?
            };
        }
        None
    })();
    parsed.unwrap_or_else(|| now + chrono::Duration::from_std(cooldown).unwrap_or_default())
}

impl OverflowState {
    /// Use a shared file; `None` provides isolated in-memory state for fixtures.
    pub fn with_path(path: Option<PathBuf>) -> Self {
        Self {
            path,
            ..Self::default()
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OverflowInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn statuses(&self) -> HashMap<String, PoolStatus> {
        match &self.path {
            Some(path) => std::fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default(),
            None => self.lock().statuses.clone(),
        }
    }

    fn mark_out(&self, pool: &str, status: PoolStatus, now: DateTime<Utc>) {
        let Some(path) = &self.path else {
            let mut inner = self.lock();
            let entry = inner
                .statuses
                .entry(pool.to_string())
                .or_insert_with(|| status.clone());
            if entry.out_until_rfc3339 <= now || status.out_until_rfc3339 < entry.out_until_rfc3339
            {
                *entry = status;
            }
            return;
        };
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)?;
            }
            // Reuse the fleet claims-file lock protocol: lock a stable sidecar,
            // reload under lock, then replace atomically. Concurrent accounts
            // cannot overwrite each other's updates.
            crate::claims_writer::with_claims_lock(path, |raw| {
                let mut statuses: HashMap<String, PoolStatus> = raw
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or_default();
                let entry = statuses
                    .entry(pool.to_string())
                    .or_insert_with(|| status.clone());
                if entry.out_until_rfc3339 <= now
                    || status.out_until_rfc3339 < entry.out_until_rfc3339
                {
                    *entry = status;
                }
                let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                let result = (|| {
                    std::fs::write(&tmp, serde_json::to_vec(&statuses)?)?;
                    std::fs::rename(&tmp, path)
                })();
                if result.is_err() {
                    let _ = std::fs::remove_file(tmp);
                }
                result
            })
        };
        if let Err(error) = write() {
            tracing::warn!(%error, path = %path.display(), "auth_pool status write failed");
        }
    }

    /// Choose assigned, an available sibling, or the earliest reset.
    pub fn route(
        &self,
        file: &PoolsFile,
        assigned: &str,
        now: DateTime<Utc>,
    ) -> (String, &'static str) {
        if !file.overflow.enabled {
            return (assigned.to_string(), "assigned");
        }
        let statuses = self.statuses();
        let until = |id: &str| {
            statuses
                .get(id)
                .map(|s| s.out_until_rfc3339)
                .filter(|t| *t > now)
        };
        if until(assigned).is_none() {
            return (assigned.to_string(), "assigned");
        }
        let mut ids: Vec<_> = file.pools.keys().collect();
        ids.sort();
        if let Some(id) = ids.iter().find(|id| until(id).is_none()) {
            return ((*id).clone(), "overflow");
        }
        let earliest = ids.into_iter().min_by_key(|id| (until(id), *id));
        (
            earliest.cloned().unwrap_or_else(|| assigned.to_string()),
            "all_out",
        )
    }

    /// Pool this slot actually runs on.
    pub fn slot_pool(&self, slot: usize) -> Option<String> {
        self.lock().slot_pool.get(&slot).cloned()
    }

    fn out_until(&self, pool: &str) -> Option<DateTime<Utc>> {
        Some(self.statuses().get(pool)?.out_until_rfc3339)
    }

    pub fn record_slot_pool(&self, slot: usize, pool: Option<&str>) {
        let mut inner = self.lock();
        match pool {
            Some(p) => {
                inner.slot_pool.insert(slot, p.to_string());
            }
            None => {
                inner.slot_pool.remove(&slot);
            }
        }
    }

    /// Mark the actual account out, then select a route using shared status.
    pub fn on_quota_error(
        &self,
        file: &PoolsFile,
        assigned: &str,
        slot: usize,
        now: DateTime<Utc>,
        message: &str,
    ) -> OverflowAction {
        if !file.overflow.enabled {
            return OverflowAction::Disabled;
        }
        let running = self.slot_pool(slot).unwrap_or_else(|| assigned.to_string());
        self.mark_out(
            &running,
            PoolStatus {
                out_until_rfc3339: quota_reset(message, now, file.cooldown()),
                reason: "quota_error".into(),
            },
            now,
        );
        let (target, _) = self.route(file, assigned, now);
        if target != running {
            OverflowAction::FlipTo(target)
        } else {
            OverflowAction::Stay
        }
    }
}

/// Env var overriding the pool-event ledger path.
pub const ENV_EVENTS_PATH: &str = "BUZZ_POOL_EVENTS_PATH";

/// Default ledger path, relative to `$HOME`.
pub const DEFAULT_EVENTS_RELATIVE: &str = ".buzz/state/pool-events.jsonl";

/// Resolve the pool-event ledger path (env override, else `$HOME` default).
pub fn events_path(env_override: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = env_override.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let home = home.map(str::trim).filter(|h| !h.is_empty())?;
    Some(Path::new(home).join(DEFAULT_EVENTS_RELATIVE))
}

struct PoolEvent<'a> {
    slot: usize,
    action: &'static str,
    assigned: Option<&'a str>,
    effective: Option<&'a str>,
    reason: &'static str,
    cooldown: Option<DateTime<Utc>>,
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    // One write per line keeps concurrent appenders from interleaving.
    f.write_all(format!("{line}\n").as_bytes())
}

/// Router held on `Config`: everything needed to decide a spawn's pool.
#[derive(Debug, Clone, Default)]
pub struct PoolRouter {
    pub enabled_for_claude: bool,
    pub display_name: String,
    pub config_path: Option<PathBuf>,
    pub home: Option<String>,
    /// Gate vars captured from the harness parent env at startup.
    pub parent_gate_env: Vec<(String, String)>,
    pub overflow: OverflowState,
    /// Append-only pool-event ledger (`None` = don't record).
    pub events_path: Option<PathBuf>,
}

impl PoolRouter {
    /// Disabled router (test fixtures, non-Claude adapters).
    #[cfg(test)]
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Build from the process environment.
    pub fn from_env(adapter_is_claude: bool) -> Self {
        let home = std::env::var("HOME").ok();
        let path = config_path(
            std::env::var(ENV_CONFIG_PATH).ok().as_deref(),
            home.as_deref(),
        );
        let parent_gate_env = GATE_ENV_VARS
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
            .collect();
        let ledger_path = events_path(
            std::env::var(ENV_EVENTS_PATH).ok().as_deref(),
            home.as_deref(),
        );
        Self {
            enabled_for_claude: adapter_is_claude,
            display_name: std::env::var(ENV_AGENT_NAME).unwrap_or_default(),
            config_path: path,
            home: home.clone(),
            parent_gate_env,
            overflow: OverflowState::with_path(status_path(
                std::env::var(ENV_STATUS_PATH).ok().as_deref(),
                home.as_deref(),
            )),
            events_path: ledger_path,
        }
    }

    fn load_file(&self) -> Option<PoolsFile> {
        self.config_path.as_deref().and_then(load)
    }

    /// Resolve against the effective child env (parent gate vars + the
    /// persona env about to be injected).
    pub fn decide(&self, persona_env: &[(String, String)], now: DateTime<Utc>) -> PoolDecision {
        let mut env = self.parent_gate_env.clone();
        env.extend(persona_env.iter().cloned());
        resolve(
            self.load_file().as_ref(),
            &self.display_name,
            &env,
            self.enabled_for_claude,
            &self.overflow,
            self.home.as_deref(),
            now,
        )
    }

    /// Decide for `slot`, remember the slot's pool, log once.
    pub fn decide_for_slot(&self, persona_env: &[(String, String)], slot: usize) -> PoolDecision {
        let previous = self.overflow.slot_pool(slot);
        let decision = self.decide(persona_env, Utc::now());
        self.overflow
            .record_slot_pool(slot, decision.pool_id.as_deref());
        if let Some(effective) = decision.pool_id.as_deref() {
            let cooldown = if decision.reason == "overflow" || decision.reason == "all_out" {
                decision
                    .assigned
                    .as_deref()
                    .and_then(|a| self.overflow.out_until(a))
            } else {
                None
            };
            self.append_event(PoolEvent {
                slot,
                action: if decision.reason == "all_out" {
                    "all_out"
                } else if previous.is_some()
                    && previous != decision.pool_id
                    && decision.pool_id == decision.assigned
                {
                    "return_assigned"
                } else {
                    "spawn"
                },
                assigned: decision.assigned.as_deref(),
                effective: Some(effective),
                reason: decision.reason,
                cooldown,
            });
        }
        tracing::info!(
            "auth_pool agent={:?} slot={} pool={} reason={}",
            self.display_name,
            slot,
            decision.pool_id.as_deref().unwrap_or("-"),
            decision.reason
        );
        decision
    }

    /// Effective pool (after overflow) the slot is running on, with its
    /// label (falls back to the id). `None` when routing is not active for
    /// this slot — the caller then keeps its static attribution.
    pub fn pool_for_slot(&self, slot: usize) -> Option<(String, String)> {
        if !self.enabled_for_claude {
            return None;
        }
        let id = self.overflow.slot_pool(slot)?;
        let label = self
            .load_file()
            .and_then(|f| f.pools.get(&id).and_then(|d| d.label.clone()))
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| id.clone());
        Some((id, label))
    }

    /// Record the outcome of a quota error on `slot` in the pool-event
    /// ledger. `Disabled` records nothing (routing was not in play).
    pub fn record_quota_event(&self, slot: usize, action: &OverflowAction) {
        if *action == OverflowAction::Disabled {
            return;
        }
        let assigned = self
            .load_file()
            .and_then(|f| f.assigned_pool(&self.display_name));
        let running = self.overflow.slot_pool(slot).or_else(|| assigned.clone());
        let cooldown = running.as_deref().and_then(|p| self.overflow.out_until(p));
        self.append_event(PoolEvent {
            slot,
            action: "mark_out",
            assigned: assigned.as_deref(),
            effective: running.as_deref(),
            reason: "quota_error",
            cooldown,
        });
        let all_out = self
            .load_file()
            .zip(assigned.as_deref())
            .is_some_and(|(f, a)| self.overflow.route(&f, a, Utc::now()).1 == "all_out");
        let (kind, effective) = match action {
            OverflowAction::FlipTo(p) => (
                if all_out {
                    "all_out"
                } else if Some(p) == assigned.as_ref() {
                    "return_assigned"
                } else {
                    "flip"
                },
                Some(p.as_str()),
            ),
            _ => ("all_out", running.as_deref()),
        };
        let cooldown = effective
            .and_then(|p| self.overflow.out_until(p))
            .or(cooldown);
        self.append_event(PoolEvent {
            slot,
            action: kind,
            assigned: assigned.as_deref(),
            effective,
            reason: "quota_error",
            cooldown,
        });
    }

    /// Whether a turn must respawn before sending to its current account.
    pub fn needs_reroute(&self, persona_env: &[(String, String)], slot: usize) -> bool {
        let decision = self.decide(persona_env, Utc::now());
        decision.pool_id.is_some()
            && self.overflow.slot_pool(slot).is_some()
            && decision.pool_id != self.overflow.slot_pool(slot)
    }

    /// Best-effort JSONL append. Never fails or panics the caller.
    fn append_event(&self, ev: PoolEvent<'_>) {
        let Some(path) = self.events_path.as_deref() else {
            return;
        };
        let now = chrono::Utc::now();
        let cooldown_until = ev
            .cooldown
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let line = serde_json::json!({
            "ts": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "agent": self.display_name,
            "slot": ev.slot,
            "action": ev.action,
            "assigned": ev.assigned,
            "effective": ev.effective,
            "reason": ev.reason,
            "cooldownUntil": cooldown_until,
            "out_until": cooldown_until,
        });
        if let Err(e) = append_line(path, &line.to_string()) {
            tracing::debug!(path = %path.display(), error = %e, "auth_pool: pool-event append failed (ignored)");
        }
    }

    /// Handle a quota error from `slot`. `Disabled` when routing is not
    /// active for this agent.
    pub fn on_quota_error(
        &self,
        persona_env: &[(String, String)],
        slot: usize,
        message: &str,
    ) -> OverflowAction {
        let now = Utc::now();
        let Some(file) = self.load_file() else {
            return OverflowAction::Disabled;
        };
        let mut env = self.parent_gate_env.clone();
        env.extend(persona_env.iter().cloned());
        if !self.enabled_for_claude || has_custom_auth(&env) {
            return OverflowAction::Disabled;
        }
        let Some(assigned) = file.assigned_pool(&self.display_name) else {
            return OverflowAction::Disabled;
        };
        self.overflow
            .on_quota_error(&file, &assigned, slot, now, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/tester";

    fn file(json: &str) -> PoolsFile {
        serde_json::from_str(json).expect("valid test json")
    }

    fn standard() -> PoolsFile {
        file(
            r#"{ "version":1, "default":"A",
                 "pools": { "A": {"label":"main","configDir":null},
                            "B": {"label":"second","configDir":"~/cc2"} },
                 "assign": { "Gilfoyle": "B", "Ghost": "Z" },
                 "overflow": { "enabled": true, "cooldownMinutes": 60 } }"#,
        )
    }

    fn res(
        f: Option<&PoolsFile>,
        name: &str,
        env: &[(String, String)],
        claude: bool,
    ) -> PoolDecision {
        resolve(
            f,
            name,
            env,
            claude,
            &OverflowState::default(),
            Some(HOME),
            Utc::now(),
        )
    }

    fn cc2() -> Option<(String, String)> {
        Some((CLAUDE_CONFIG_DIR.into(), format!("{HOME}/cc2")))
    }

    #[test]
    fn assigned_agent_gets_pool_b_env() {
        let d = res(Some(&standard()), "Gilfoyle", &[], true);
        assert_eq!(d.pool_id.as_deref(), Some("B"));
        assert_eq!(d.env, cc2());
        assert_eq!(d.reason, "assigned");
    }

    #[test]
    fn unlisted_agent_gets_default_and_inherits() {
        let d = res(Some(&standard()), "Lord Nikon", &[], true);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
        assert_eq!(d.env, None);
    }

    #[test]
    fn assignment_is_case_insensitive() {
        let d = res(Some(&standard()), "  gILFOYLE ", &[], true);
        assert_eq!(d.pool_id.as_deref(), Some("B"));
        assert_eq!(d.env, cc2());
    }

    #[test]
    fn unknown_pool_falls_back_to_default() {
        let d = res(Some(&standard()), "Ghost", &[], true);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
        assert_eq!(d.env, None);
    }

    #[test]
    fn null_config_dir_never_sets_env() {
        let def = PoolDef {
            label: None,
            config_dir: None,
        };
        assert_eq!(pool_env(&def, Some(HOME)), None);
    }

    #[test]
    fn default_claude_dir_never_sets_env() {
        for dir in [
            "~/.claude",
            "~/.claude/",
            "/Users/tester/.claude",
            "/Users/tester/./.claude",
        ] {
            let def = PoolDef {
                label: None,
                config_dir: Some(dir.into()),
            };
            assert_eq!(pool_env(&def, Some(HOME)), None, "dir {dir}");
        }
        // Default pool configured as ~/.claude explicitly still inherits.
        let f = file(
            r#"{"default":"A","pools":{"A":{"configDir":"~/.claude"},"B":{"configDir":"/x/cc2"}}}"#,
        );
        assert_eq!(res(Some(&f), "anyone", &[], true).env, None);
    }

    #[test]
    fn absolute_custom_dir_sets_env() {
        let def = PoolDef {
            label: None,
            config_dir: Some("/opt/cc3/".into()),
        };
        assert_eq!(
            pool_env(&def, Some(HOME)),
            Some((CLAUDE_CONFIG_DIR.into(), "/opt/cc3".into()))
        );
    }

    #[test]
    fn each_custom_auth_var_skips_routing() {
        for var in GATE_ENV_VARS {
            let env = vec![(var.to_string(), "x".to_string())];
            let d = res(Some(&standard()), "Gilfoyle", &env, true);
            assert_eq!(d.env, None, "{var}");
            assert_eq!(d.pool_id, None, "{var}");
            assert_eq!(d.reason, "skipped:custom-auth", "{var}");
        }
    }

    #[test]
    fn non_claude_adapter_skips_routing() {
        let d = res(Some(&standard()), "Gilfoyle", &[], false);
        assert_eq!(d, PoolDecision::off("skipped_non_claude_adapter"));
    }

    #[test]
    fn missing_file_turns_routing_off() {
        assert_eq!(load(Path::new("/nonexistent/agent-pools.json")), None);
        let d = res(None, "Gilfoyle", &[], true);
        assert_eq!(d, PoolDecision::off("off_no_config"));
    }

    #[test]
    fn invalid_file_turns_routing_off() {
        let dir = std::env::temp_dir().join(format!("auth-pool-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("bad.json");
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(load(&p), None);
        std::fs::write(&p, r#"{"default":"A","pools":{"A":{"configDir":null}}}"#).unwrap();
        assert!(load(&p).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_default_turns_routing_off() {
        let f = file(
            r#"{"default":"Q","pools":{"B":{"configDir":"~/cc2"}},"assign":{"Gilfoyle":"B"}}"#,
        );
        let d = res(Some(&f), "Gilfoyle", &[], true);
        assert_eq!(d, PoolDecision::off("off_unknown_default"));
    }

    #[test]
    fn config_path_prefers_override() {
        assert_eq!(
            config_path(Some("/tmp/x.json"), Some(HOME)),
            Some(PathBuf::from("/tmp/x.json"))
        );
        assert_eq!(
            config_path(Some("  "), Some(HOME)),
            Some(PathBuf::from("/Users/tester/.buzz/agent-pools.json"))
        );
        assert_eq!(config_path(None, None), None);
    }

    // ---- overflow ----

    #[test]
    fn quota_error_flips_a_to_b() {
        let f = standard();
        let st = OverflowState::default();
        let now = Utc::now();
        st.record_slot_pool(0, Some("A"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now, "garbage"),
            OverflowAction::FlipTo("B".into())
        );
        let d = resolve(Some(&f), "Nikon", &[], true, &st, Some(HOME), now);
        assert_eq!(d.pool_id.as_deref(), Some("B"));
        assert_eq!(d.env, cc2());
        assert_eq!(d.reason, "overflow");
    }

    #[test]
    fn overflow_returns_to_assigned_after_cooldown() {
        let f = standard();
        let st = OverflowState::default();
        let now = Utc::now();
        st.on_quota_error(&f, "A", 0, now, "garbage");
        let later = now + chrono::Duration::minutes(61);
        let d = resolve(Some(&f), "Nikon", &[], true, &st, Some(HOME), later);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
        assert_eq!(d.env, None);
        assert_eq!(d.reason, "assigned");
    }

    #[test]
    fn both_out_routes_earliest_then_returns_assigned() {
        let f = standard();
        let st = OverflowState::default();
        let now = DateTime::parse_from_rfc3339("2026-10-04T04:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        st.record_slot_pool(0, Some("A"));
        st.on_quota_error(&f, "A", 0, now, "resets 3pm (America/Chicago)");
        st.record_slot_pool(0, Some("B"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now, "resets 8am (America/Chicago)"),
            OverflowAction::Stay
        );
        assert_eq!(st.route(&f, "A", now), ("B".into(), "all_out"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now + chrono::Duration::hours(8), "garbage"),
            OverflowAction::Stay
        );
        assert_eq!(
            st.route(&f, "A", now + chrono::Duration::hours(8)),
            ("B".into(), "all_out")
        );
        assert_eq!(
            st.route(&f, "A", now + chrono::Duration::hours(17)),
            ("A".into(), "assigned")
        );
        let st = OverflowState::default();
        st.record_slot_pool(0, Some("A"));
        st.on_quota_error(&f, "A", 0, now, "resets 8am (America/Chicago)");
        st.record_slot_pool(0, Some("B"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now, "resets 3pm (America/Chicago)"),
            OverflowAction::FlipTo("A".into())
        );
        assert_eq!(st.route(&f, "A", now), ("A".into(), "all_out"));
    }

    #[test]
    fn incident_quota_on_a_returns_to_available_b() {
        let f = standard();
        let st = OverflowState::default();
        st.record_slot_pool(0, Some("A"));
        assert_eq!(
            st.on_quota_error(&f, "B", 0, Utc::now(), "garbage"),
            OverflowAction::FlipTo("B".into())
        );
        assert!(st.statuses().contains_key("A"));
        assert!(!st.statuses().contains_key("B"));
    }

    #[test]
    fn quota_on_b_marks_b_and_routes_a() {
        let f = standard();
        let st = OverflowState::default();
        st.record_slot_pool(0, Some("B"));
        assert_eq!(
            st.on_quota_error(&f, "B", 0, Utc::now(), "garbage"),
            OverflowAction::FlipTo("A".into())
        );
        assert!(st.statuses().contains_key("B"));
    }

    #[test]
    fn parses_reset_and_fallback() {
        let now = DateTime::parse_from_rfc3339("2026-10-04T04:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        for (text, expected) in [
            (
                "weekly limit resets Oct 6 at 8am (America/Chicago)",
                "2026-10-06T13:00:00+00:00",
            ),
            ("resets 3pm (America/Chicago)", "2026-10-04T20:00:00+00:00"),
            ("resets 8pm (America/Chicago)", "2026-10-05T01:00:00+00:00"),
            ("garbage", "2026-10-04T05:00:00+00:00"),
        ] {
            assert_eq!(
                quota_reset(text, now, Duration::from_secs(3600)).to_rfc3339(),
                expected
            );
        }
    }

    #[test]
    fn shared_file_is_reloaded_and_corruption_fails_open() {
        let dir = std::env::temp_dir().join(format!("pool-shared-{}", uuid::Uuid::new_v4()));
        let path = dir.join("status.json");
        let first = OverflowState::with_path(Some(path.clone()));
        let second = OverflowState::with_path(Some(path.clone()));
        let f = standard();
        assert_eq!(second.route(&f, "A", Utc::now()).0, "A");
        first.on_quota_error(&f, "A", 0, Utc::now(), "garbage");
        assert_eq!(second.route(&f, "A", Utc::now()).0, "B");
        second.record_slot_pool(0, Some("B"));
        second.on_quota_error(&f, "A", 0, Utc::now(), "garbage");
        assert_eq!(first.statuses().len(), 2);
        std::fs::write(path, "corrupt").unwrap();
        assert_eq!(second.route(&f, "A", Utc::now()).0, "A");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_shared_writers_preserve_both_accounts() {
        let dir = std::env::temp_dir().join(format!("pool-concurrent-{}", uuid::Uuid::new_v4()));
        let path = dir.join("status.json");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writers: Vec<_> = ["A", "B"]
            .into_iter()
            .map(|pool| {
                let state = OverflowState::with_path(Some(path.clone()));
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    state.record_slot_pool(0, Some(pool));
                    state.on_quota_error(&standard(), "A", 0, Utc::now(), "garbage");
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let state = OverflowState::with_path(Some(path));
        assert_eq!(state.statuses().len(), 2);
        assert!(state.statuses().contains_key("A"));
        assert!(state.statuses().contains_key("B"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_path_default_and_override() {
        assert_eq!(
            status_path(None, Some("/Users/x")),
            Some(PathBuf::from("/Users/x/.buzz/state/pool-status.json"))
        );
        assert_eq!(
            status_path(Some(" /tmp/status.json "), None),
            Some(PathBuf::from("/tmp/status.json"))
        );
        assert_eq!(
            status_path(Some(" "), Some("/Users/x")),
            Some(PathBuf::from("/Users/x/.buzz/state/pool-status.json"))
        );
        assert_eq!(status_path(None, None), None);
    }

    #[test]
    fn overflow_disabled_in_file_does_nothing() {
        let f = file(
            r#"{"default":"A","pools":{"A":{"configDir":null},"B":{"configDir":"~/cc2"}},
                "overflow":{"enabled":false}}"#,
        );
        let st = OverflowState::default();
        assert_eq!(
            st.on_quota_error(&f, "A", 0, Utc::now(), "garbage"),
            OverflowAction::Disabled
        );
    }

    #[test]
    fn router_is_disabled_without_claude_or_file() {
        let r = PoolRouter::disabled();
        assert_eq!(
            r.on_quota_error(&[], 0, "garbage"),
            OverflowAction::Disabled
        );
        assert_eq!(r.decide(&[], Utc::now()).env, None);
    }

    #[test]
    fn custom_auth_only_in_persona_env_skips_routing() {
        let dir = std::env::temp_dir().join(format!("auth-pool-persona-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pools.json");
        std::fs::write(
            &p,
            r#"{"default":"B","pools":{"A":{"configDir":null},"B":{"configDir":"~/cc2"}}}"#,
        )
        .unwrap();
        let r = PoolRouter {
            enabled_for_claude: true,
            display_name: "Evie".into(),
            config_path: Some(p),
            home: Some(HOME.into()),
            parent_gate_env: vec![], // parent env is clean
            overflow: OverflowState::default(),
            events_path: None,
        };
        let persona = vec![(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://omniroute".to_string(),
        )];
        let d = r.decide_for_slot(&persona, 0);
        assert_eq!(d.env, None);
        assert_eq!(d.pool_id, None);
        assert_eq!(d.reason, "skipped:custom-auth");
        // Same agent without the persona var WOULD be routed to B.
        assert_eq!(r.decide(&[], Utc::now()).env, cc2());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn router_reads_file_and_gates_on_persona_env() {
        let dir = std::env::temp_dir().join(format!("auth-pool-router-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pools.json");
        std::fs::write(
            &p,
            r#"{"default":"A","pools":{"A":{"configDir":null},"B":{"configDir":"~/cc2"}},
                "assign":{"Gilfoyle":"B"},"overflow":{"enabled":true,"cooldownMinutes":5}}"#,
        )
        .unwrap();
        let r = PoolRouter {
            enabled_for_claude: true,
            display_name: "Gilfoyle".into(),
            config_path: Some(p),
            home: Some(HOME.into()),
            parent_gate_env: vec![],
            overflow: OverflowState::default(),
            events_path: None,
        };
        assert_eq!(r.decide_for_slot(&[], 0).env, cc2());
        let glm = vec![(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://omniroute".to_string(),
        )];
        assert_eq!(r.decide(&glm, Utc::now()).env, None);
        assert_eq!(
            r.on_quota_error(&glm, 0, "garbage"),
            OverflowAction::Disabled
        );
        // Gilfoyle is assigned B; quota on B flips to A (inherit).
        assert_eq!(
            r.on_quota_error(&[], 0, "garbage"),
            OverflowAction::FlipTo("A".into())
        );
        assert_eq!(r.decide(&[], Utc::now()).env, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn events_router(tag: &str) -> (PoolRouter, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("auth-pool-events-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("agent-pools.json");
        std::fs::write(
            &p,
            r#"{"default":"A","pools":{"A":{"label":"main"},"B":{"label":"second","configDir":"~/cc2"}},
                "overflow":{"enabled":true,"cooldownMinutes":60}}"#,
        )
        .unwrap();
        let r = PoolRouter {
            enabled_for_claude: true,
            display_name: "Nikon".into(),
            config_path: Some(p),
            home: Some(HOME.into()),
            parent_gate_env: vec![],
            overflow: OverflowState::default(),
            // Parent dir does not exist yet: the writer must create it.
            events_path: Some(dir.join("state").join("pool-events.jsonl")),
        };
        (r, dir)
    }

    fn read_events(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).expect("valid json line"))
            .collect()
    }

    #[test]
    fn decide_for_slot_appends_spawn_event() {
        let (r, dir) = events_router("spawn");
        let path = r.events_path.clone().unwrap();
        r.decide_for_slot(&[], 2);
        let ev = read_events(&path);
        assert_eq!(ev.len(), 1, "one spawn line: {ev:?}");
        assert_eq!(ev[0]["action"], "spawn");
        assert_eq!(ev[0]["agent"], "Nikon");
        assert_eq!(ev[0]["slot"], 2);
        assert_eq!(ev[0]["assigned"], "A");
        assert_eq!(ev[0]["effective"], "A");
        assert_eq!(ev[0]["reason"], "assigned");
        assert!(ev[0]["cooldownUntil"].is_null());
        assert!(ev[0]["ts"].as_str().is_some_and(|t| t.ends_with('Z')));

        // After a flip the next spawn is on B, with the redirect's expiry.
        assert_eq!(
            r.on_quota_error(&[], 2, "garbage"),
            OverflowAction::FlipTo("B".into())
        );
        r.decide_for_slot(&[], 2);
        let ev = read_events(&path);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[1]["effective"], "B");
        assert_eq!(ev[1]["assigned"], "A");
        assert_eq!(ev[1]["reason"], "overflow");
        assert!(ev[1]["cooldownUntil"].is_string());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spawn_event_not_written_when_routing_off() {
        let (mut r, dir) = events_router("off");
        r.enabled_for_claude = false;
        let path = r.events_path.clone().unwrap();
        r.decide_for_slot(&[], 0);
        assert!(read_events(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unwritable_events_path_never_fails_the_spawn() {
        let (mut r, dir) = events_router("unwritable");
        // Parent is a regular file, so create_dir_all fails; must be swallowed.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        r.events_path = Some(blocker.join("pool-events.jsonl"));
        let d = r.decide_for_slot(&[], 0);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pool_for_slot_is_effective_pool_with_label() {
        let (r, dir) = events_router("forslot");
        assert_eq!(r.pool_for_slot(0), None, "never spawned: no stamp");
        r.decide_for_slot(&[], 0);
        assert_eq!(r.pool_for_slot(0), Some(("A".into(), "main".into())));
        r.on_quota_error(&[], 0, "garbage");
        r.decide_for_slot(&[], 0);
        assert_eq!(r.pool_for_slot(0), Some(("B".into(), "second".into())));
        let mut off = r.clone();
        off.enabled_for_claude = false;
        assert_eq!(off.pool_for_slot(0), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn events_path_default_and_override() {
        assert_eq!(
            events_path(None, Some("/Users/x")),
            Some(PathBuf::from("/Users/x/.buzz/state/pool-events.jsonl"))
        );
        assert_eq!(
            events_path(Some(" /tmp/e.jsonl "), Some("/Users/x")),
            Some(PathBuf::from("/tmp/e.jsonl"))
        );
        assert_eq!(events_path(None, None), None);
    }
}
