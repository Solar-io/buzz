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
//! Overflow: on a quota/rate-limit error from a slot running on the assigned
//! pool, the process redirects to the sibling pool for `cooldownMinutes`. If a
//! slot already running on the sibling ALSO quota-errors while the redirect is
//! active, both pools are marked exhausted and flipping stops until the
//! cooldown lapses (no ping-pong).
//!
//! Everything here except [`PoolRouter::decide_for_slot`]'s log line is
//! side-effect-free so it can be unit-tested without a process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

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

    /// The overflow sibling of `pool`: the lexically-first other pool id.
    pub fn sibling(&self, pool: &str) -> Option<String> {
        let mut others: Vec<&String> = self.pools.keys().filter(|k| k.as_str() != pool).collect();
        others.sort();
        others.first().map(|s| (*s).clone())
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
    /// The env entry to inject, `None` = inherit.
    pub env: Option<(String, String)>,
    pub reason: &'static str,
}

impl PoolDecision {
    fn off(reason: &'static str) -> Self {
        Self {
            pool_id: None,
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

/// Resolve the pool for a spawn. Pure: `now` and `home` are inputs.
pub fn resolve(
    file: Option<&PoolsFile>,
    display_name: &str,
    parent_env: &[(String, String)],
    adapter_is_claude: bool,
    overflow: &OverflowState,
    home: Option<&str>,
    now: Instant,
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
    let (effective, reason) = match overflow.redirect_for(&assigned, now) {
        Some(sibling) if file.overflow.enabled && file.pools.contains_key(&sibling) => {
            (sibling, "overflow")
        }
        _ => (assigned, "assigned"),
    };
    let env = file
        .pools
        .get(&effective)
        .and_then(|def| pool_env(def, home));
    PoolDecision {
        pool_id: Some(effective),
        env,
        reason,
    }
}

/// What a quota error should do to this slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverflowAction {
    /// Respawn the slot on this pool (no crash recorded).
    FlipTo(String),
    /// Both pools quota-errored inside the cooldown: stop flipping.
    Exhausted,
    /// Routing or overflow off, or no sibling: behave as before.
    Disabled,
}

#[derive(Debug, Default)]
struct OverflowInner {
    /// assigned pool → (active sibling, until).
    redirect: HashMap<String, (String, Instant)>,
    /// assigned pool → exhausted until.
    exhausted: HashMap<String, Instant>,
    /// slot index → pool id the slot was last spawned on.
    slot_pool: HashMap<usize, String>,
}

/// Process-lived overflow state (one harness process = one agent).
#[derive(Debug, Clone, Default)]
pub struct OverflowState(Arc<Mutex<OverflowInner>>);

impl OverflowState {
    fn lock(&self) -> std::sync::MutexGuard<'_, OverflowInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Active, unexpired, non-exhausted redirect for `assigned`.
    pub fn redirect_for(&self, assigned: &str, now: Instant) -> Option<String> {
        let inner = self.lock();
        if inner
            .exhausted
            .get(assigned)
            .is_some_and(|until| now < *until)
        {
            return None;
        }
        inner
            .redirect
            .get(assigned)
            .filter(|(_, until)| now < *until)
            .map(|(pool, _)| pool.clone())
    }

    #[cfg(test)]
    pub fn is_exhausted(&self, assigned: &str, now: Instant) -> bool {
        self.lock()
            .exhausted
            .get(assigned)
            .is_some_and(|until| now < *until)
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

    /// Register a quota error from `slot` and decide what to do.
    pub fn on_quota_error(
        &self,
        file: &PoolsFile,
        assigned: &str,
        slot: usize,
        now: Instant,
    ) -> OverflowAction {
        if !file.overflow.enabled {
            return OverflowAction::Disabled;
        }
        let Some(sibling) = file.sibling(assigned) else {
            return OverflowAction::Disabled;
        };
        let cooldown = file.cooldown();
        let mut inner = self.lock();
        if inner
            .exhausted
            .get(assigned)
            .is_some_and(|until| now < *until)
        {
            return OverflowAction::Exhausted;
        }
        let slot_on = inner
            .slot_pool
            .get(&slot)
            .cloned()
            .unwrap_or_else(|| assigned.to_string());
        let redirect_active = inner
            .redirect
            .get(assigned)
            .is_some_and(|(_, until)| now < *until);
        if slot_on != assigned && redirect_active {
            // The sibling itself is out too — stop flipping.
            inner.exhausted.insert(assigned.to_string(), now + cooldown);
            inner.redirect.remove(assigned);
            return OverflowAction::Exhausted;
        }
        if !redirect_active {
            inner
                .redirect
                .insert(assigned.to_string(), (sibling.clone(), now + cooldown));
        }
        OverflowAction::FlipTo(sibling)
    }
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
        Self {
            enabled_for_claude: adapter_is_claude,
            display_name: std::env::var(ENV_AGENT_NAME).unwrap_or_default(),
            config_path: path,
            home,
            parent_gate_env,
            overflow: OverflowState::default(),
        }
    }

    fn load_file(&self) -> Option<PoolsFile> {
        self.config_path.as_deref().and_then(load)
    }

    /// Resolve against the effective child env (parent gate vars + the
    /// persona env about to be injected).
    pub fn decide(&self, persona_env: &[(String, String)], now: Instant) -> PoolDecision {
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
        let decision = self.decide(persona_env, Instant::now());
        self.overflow
            .record_slot_pool(slot, decision.pool_id.as_deref());
        tracing::info!(
            "auth_pool agent={:?} slot={} pool={} reason={}",
            self.display_name,
            slot,
            decision.pool_id.as_deref().unwrap_or("-"),
            decision.reason
        );
        decision
    }

    /// Handle a quota error from `slot`. `Disabled` when routing is not
    /// active for this agent.
    pub fn on_quota_error(&self, persona_env: &[(String, String)], slot: usize) -> OverflowAction {
        let now = Instant::now();
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
        self.overflow.on_quota_error(&file, &assigned, slot, now)
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
            Instant::now(),
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
        let now = Instant::now();
        st.record_slot_pool(0, Some("A"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now),
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
        let now = Instant::now();
        st.on_quota_error(&f, "A", 0, now);
        let later = now + Duration::from_secs(61 * 60);
        let d = resolve(Some(&f), "Nikon", &[], true, &st, Some(HOME), later);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
        assert_eq!(d.env, None);
        assert_eq!(d.reason, "assigned");
    }

    #[test]
    fn sibling_also_failing_marks_exhausted_and_stops_flipping() {
        let f = standard();
        let st = OverflowState::default();
        let now = Instant::now();
        st.record_slot_pool(0, Some("A"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now),
            OverflowAction::FlipTo("B".into())
        );
        st.record_slot_pool(0, Some("B"));
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now),
            OverflowAction::Exhausted
        );
        assert!(st.is_exhausted("A", now));
        // No further flips while exhausted, and spawns resolve to assigned.
        assert_eq!(
            st.on_quota_error(&f, "A", 0, now),
            OverflowAction::Exhausted
        );
        let d = resolve(Some(&f), "Nikon", &[], true, &st, Some(HOME), now);
        assert_eq!(d.pool_id.as_deref(), Some("A"));
    }

    #[test]
    fn overflow_disabled_in_file_does_nothing() {
        let f = file(
            r#"{"default":"A","pools":{"A":{"configDir":null},"B":{"configDir":"~/cc2"}},
                "overflow":{"enabled":false}}"#,
        );
        let st = OverflowState::default();
        assert_eq!(
            st.on_quota_error(&f, "A", 0, Instant::now()),
            OverflowAction::Disabled
        );
    }

    #[test]
    fn router_is_disabled_without_claude_or_file() {
        let r = PoolRouter::disabled();
        assert_eq!(r.on_quota_error(&[], 0), OverflowAction::Disabled);
        assert_eq!(r.decide(&[], Instant::now()).env, None);
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
        assert_eq!(r.decide(&[], Instant::now()).env, cc2());
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
        };
        assert_eq!(r.decide_for_slot(&[], 0).env, cc2());
        let glm = vec![(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://omniroute".to_string(),
        )];
        assert_eq!(r.decide(&glm, Instant::now()).env, None);
        assert_eq!(r.on_quota_error(&glm, 0), OverflowAction::Disabled);
        // Gilfoyle is assigned B; quota on B flips to A (inherit).
        assert_eq!(r.on_quota_error(&[], 0), OverflowAction::FlipTo("A".into()));
        assert_eq!(r.decide(&[], Instant::now()).env, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
