//! Tauri commands for the two-account Claude pool routing file
//! (`~/.buzz/agent-pools.json`).
//!
//! The file is read by `buzz-acp` (`crates/buzz-acp/src/auth_pool.rs`) at each
//! agent spawn, which sets `CLAUDE_CONFIG_DIR` on the child env for the
//! agent's assigned pool. These commands are the desktop's (and, through the
//! owner admin channel, the web's) editor for that file:
//!
//! - `get_agent_pools` — read + hash (the hash is the `baseHash` a writer must
//!   echo back so two editors never silently overwrite each other).
//! - `set_agent_pools` — validate, compare `baseHash`, write atomically
//!   (temp file + rename in the same directory).
//! - `probe_agent_pool` — `claude auth status --json` under a pool's config
//!   dir, for the "test login" button and the both-accounts usage view.
//!
//! This module NEVER reads or writes `managed-agents.json`: assignments are
//! keyed by agent display name inside the pools file itself. Changes apply on
//! each agent's next spawn (wake/restart); nothing is restarted here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Path of the pools file relative to `$HOME` (mirror of
/// `auth_pool::DEFAULT_CONFIG_RELATIVE`).
const POOLS_RELATIVE: &str = ".buzz/agent-pools.json";
const MAX_POOLS: usize = 8;
const MAX_POOL_ID_LEN: usize = 32;
const MAX_LABEL_LEN: usize = 80;
const MAX_ASSIGNMENTS: usize = 1000;
const MAX_AGENT_NAME_LEN: usize = 200;
const MAX_COOLDOWN_MINUTES: u64 = 7 * 24 * 60;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoolDef {
    #[serde(default)]
    pub label: Option<String>,
    /// `null` = inherit (do not set `CLAUDE_CONFIG_DIR`; the `~/.claude`
    /// account). Otherwise an absolute or `~`-relative existing directory.
    #[serde(default)]
    pub config_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoolsOverflow {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_cooldown_minutes")]
    pub cooldown_minutes: u64,
}

fn default_cooldown_minutes() -> u64 {
    60
}

impl Default for AgentPoolsOverflow {
    fn default() -> Self {
        Self {
            enabled: false,
            cooldown_minutes: default_cooldown_minutes(),
        }
    }
}

/// On-disk schema — the same document `buzz-acp` deserializes. BTreeMaps keep
/// the written file (and therefore its hash) deterministic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentPoolsConfig {
    #[serde(default)]
    pub version: Option<u64>,
    pub default: String,
    pub pools: BTreeMap<String, AgentPoolDef>,
    #[serde(default)]
    pub assign: BTreeMap<String, String>,
    #[serde(default)]
    pub overflow: AgentPoolsOverflow,
}

/// `get_agent_pools` result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoolsSnapshot {
    /// `None` when the file does not exist yet (routing is off).
    pub config: Option<AgentPoolsConfig>,
    /// sha256 hex of the file bytes; `""` when the file does not exist.
    pub hash: String,
    /// Set when the file exists but does not parse — the UI shows it instead
    /// of pretending routing is configured.
    pub parse_error: Option<String>,
}

/// `probe_agent_pool` result — the identity fields of
/// `claude auth status --json`. No token or credential ever leaves the CLI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoolProbe {
    pub logged_in: bool,
    pub email: Option<String>,
    pub org_name: Option<String>,
    pub subscription_type: Option<String>,
    pub auth_method: Option<String>,
    /// The config directory the CLI reported using (proves isolation).
    pub config_directory: Option<String>,
    pub error: Option<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())
}

fn pools_path(home: &Path) -> PathBuf {
    home.join(POOLS_RELATIVE)
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Expand `~` / `~/x` against `home`. Anything else is returned verbatim.
fn expand_tilde(dir: &str, home: &Path) -> PathBuf {
    if dir == "~" {
        home.to_path_buf()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(dir)
    }
}

/// Validate a pool config dir. `None` (inherit) is always valid; otherwise
/// the value must be absolute or `~`-relative AND name an existing directory.
pub(crate) fn validate_config_dir(dir: Option<&str>, home: &Path) -> Result<(), String> {
    let Some(raw) = dir else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("configDir must be null or a non-empty path".into());
    }
    if trimmed.contains('\0') {
        return Err("configDir contains a NUL byte".into());
    }
    if !(trimmed == "~" || trimmed.starts_with("~/") || Path::new(trimmed).is_absolute()) {
        return Err(format!(
            "configDir \"{trimmed}\" must be absolute or start with ~/"
        ));
    }
    let expanded = expand_tilde(trimmed, home);
    if !expanded.is_dir() {
        return Err(format!(
            "configDir \"{trimmed}\" does not exist or is not a directory"
        ));
    }
    Ok(())
}

fn valid_pool_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_POOL_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Full-document validation. Rejects anything `buzz-acp` would route wrongly
/// or fail-soft on, so a saved file is always an effective one.
pub(crate) fn validate_agent_pools(config: &AgentPoolsConfig, home: &Path) -> Result<(), String> {
    if config.pools.is_empty() {
        return Err("at least one pool is required".into());
    }
    if config.pools.len() > MAX_POOLS {
        return Err(format!("at most {MAX_POOLS} pools are allowed"));
    }
    for (id, def) in &config.pools {
        if !valid_pool_id(id) {
            return Err(format!(
                "pool id \"{id}\" must be 1-{MAX_POOL_ID_LEN} chars of [A-Za-z0-9_-]"
            ));
        }
        if def
            .label
            .as_deref()
            .is_some_and(|l| l.len() > MAX_LABEL_LEN || l.contains('\0'))
        {
            return Err(format!("pool {id}: label is too long or contains NUL"));
        }
        validate_config_dir(def.config_dir.as_deref(), home)
            .map_err(|e| format!("pool {id}: {e}"))?;
    }
    if !config.pools.contains_key(&config.default) {
        return Err(format!(
            "default pool \"{}\" is not one of the defined pools",
            config.default
        ));
    }
    if config.assign.len() > MAX_ASSIGNMENTS {
        return Err(format!("at most {MAX_ASSIGNMENTS} assignments are allowed"));
    }
    for (name, pool) in &config.assign {
        let trimmed = name.trim();
        if trimmed.is_empty() || name.len() > MAX_AGENT_NAME_LEN || name.contains('\0') {
            return Err(format!("invalid agent name in assign: \"{name}\""));
        }
        if !config.pools.contains_key(pool) {
            return Err(format!(
                "agent \"{trimmed}\" is assigned to unknown pool \"{pool}\""
            ));
        }
    }
    if config.overflow.cooldown_minutes == 0
        || config.overflow.cooldown_minutes > MAX_COOLDOWN_MINUTES
    {
        return Err(format!(
            "overflow.cooldownMinutes must be 1-{MAX_COOLDOWN_MINUTES}"
        ));
    }
    Ok(())
}

pub(crate) fn read_agent_pools(home: &Path) -> Result<AgentPoolsSnapshot, String> {
    let path = pools_path(home);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentPoolsSnapshot {
                config: None,
                hash: String::new(),
                parse_error: None,
            })
        }
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let hash = hash_bytes(&bytes);
    match serde_json::from_slice::<AgentPoolsConfig>(&bytes) {
        Ok(config) => Ok(AgentPoolsSnapshot {
            config: Some(config),
            hash,
            parse_error: None,
        }),
        Err(e) => Ok(AgentPoolsSnapshot {
            config: None,
            hash,
            parse_error: Some(e.to_string()),
        }),
    }
}

/// Validate, check `base_hash` against the current file, then write via a
/// same-directory temp file + rename (atomic on POSIX). `base_hash = None`
/// skips the lost-update check (desktop-local editor that just read it).
pub(crate) fn write_agent_pools(
    home: &Path,
    config: &AgentPoolsConfig,
    base_hash: Option<&str>,
) -> Result<AgentPoolsSnapshot, String> {
    validate_agent_pools(config, home)?;
    let path = pools_path(home);
    if let Some(expected) = base_hash {
        let current = read_agent_pools(home)?.hash;
        if current != expected {
            return Err(
                "agent-pools.json changed since it was loaded — reload and re-apply your edit"
                    .into(),
            );
        }
    }
    let mut normalized = config.clone();
    normalized.version = Some(normalized.version.unwrap_or(1));
    let mut body = serde_json::to_vec_pretty(&normalized).map_err(|e| format!("serialize: {e}"))?;
    body.push(b'\n');
    let dir = path
        .parent()
        .ok_or_else(|| "pools path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".agent-pools.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename into {}: {e}", path.display()));
    }
    Ok(AgentPoolsSnapshot {
        config: Some(normalized),
        hash: hash_bytes(&body),
        parse_error: None,
    })
}

/// Parse `claude auth status --json` stdout into the identity subset.
pub(crate) fn parse_auth_status(stdout: &[u8]) -> AgentPoolProbe {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return AgentPoolProbe {
            error: Some("claude auth status did not return JSON".into()),
            ..AgentPoolProbe::default()
        };
    };
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
    AgentPoolProbe {
        logged_in: value
            .get("loggedIn")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        email: text("email"),
        org_name: text("orgName"),
        subscription_type: text("subscriptionType"),
        auth_method: text("authMethod"),
        config_directory: text("configDirectory"),
        error: None,
    }
}

fn run_probe(config_dir: Option<&str>, home: &Path) -> AgentPoolProbe {
    let failed = |msg: String| AgentPoolProbe {
        error: Some(msg),
        ..AgentPoolProbe::default()
    };
    if let Err(e) = validate_config_dir(config_dir, home) {
        return failed(e);
    }
    let Some(binary) = crate::managed_agents::resolve_command("claude") else {
        return failed("claude CLI not found on PATH".into());
    };
    let mut command = std::process::Command::new(binary);
    command.args(["auth", "status", "--json"]);
    // Pool A semantics: null ⇒ UNSET, never an explicit ~/.claude (that
    // re-keys the credential store — see auth_pool.rs).
    command.env_remove("CLAUDE_CONFIG_DIR");
    if let Some(dir) = config_dir {
        command.env("CLAUDE_CONFIG_DIR", expand_tilde(dir.trim(), home));
    }
    if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
        command.env("PATH", path);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::util::configure_no_window(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return failed(format!("spawn claude: {e}")),
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return failed("claude auth status timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return failed(format!("wait claude: {e}")),
        }
    }
    match child.wait_with_output() {
        // `auth status` exits non-zero when logged out but still prints JSON.
        Ok(output) => parse_auth_status(&output.stdout),
        Err(e) => failed(format!("read claude output: {e}")),
    }
}

/// Read `~/.buzz/agent-pools.json` (+ its hash for `set_agent_pools`).
#[tauri::command]
pub fn get_agent_pools() -> Result<AgentPoolsSnapshot, String> {
    read_agent_pools(&home_dir()?)
}

/// Validate and atomically write `~/.buzz/agent-pools.json`. Full-document
/// replace; `base_hash` (from `get_agent_pools`) guards against lost updates.
/// Takes effect on each agent's next spawn — no restarts here.
#[tauri::command]
pub async fn set_agent_pools(
    config: AgentPoolsConfig,
    base_hash: Option<String>,
) -> Result<AgentPoolsSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        write_agent_pools(&home_dir()?, &config, base_hash.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// `claude auth status --json` under a pool's config dir (`null` = the
/// default ~/.claude account). Returns identity only — never credentials.
#[tauri::command]
pub async fn probe_agent_pool(config_dir: Option<String>) -> Result<AgentPoolProbe, String> {
    tokio::task::spawn_blocking(move || {
        let home = home_dir()?;
        Ok(run_probe(config_dir.as_deref(), &home))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir_b: Option<&str>) -> AgentPoolsConfig {
        let mut pools = BTreeMap::new();
        pools.insert(
            "A".to_string(),
            AgentPoolDef {
                label: Some("Account A".into()),
                config_dir: None,
            },
        );
        pools.insert(
            "B".to_string(),
            AgentPoolDef {
                label: Some("Account B".into()),
                config_dir: dir_b.map(str::to_string),
            },
        );
        let mut assign = BTreeMap::new();
        assign.insert("Gilfoyle".to_string(), "B".to_string());
        AgentPoolsConfig {
            version: Some(1),
            default: "A".into(),
            pools,
            assign,
            overflow: AgentPoolsOverflow::default(),
        }
    }

    #[test]
    fn accepts_null_config_dir() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(validate_config_dir(None, home.path()), Ok(()));
    }

    #[test]
    fn accepts_tilde_dir_that_exists_under_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("cc2")).unwrap();
        assert_eq!(validate_config_dir(Some("~/cc2"), home.path()), Ok(()));
        assert!(validate_agent_pools(&config(Some("~/cc2")), home.path()).is_ok());
    }

    #[test]
    fn accepts_absolute_existing_dir() {
        let home = tempfile::tempdir().unwrap();
        let abs = home.path().join("abs");
        std::fs::create_dir(&abs).unwrap();
        assert!(validate_config_dir(Some(abs.to_str().unwrap()), home.path()).is_ok());
    }

    #[test]
    fn rejects_nonexistent_dir() {
        let home = tempfile::tempdir().unwrap();
        let err = validate_config_dir(Some("~/does-not-exist"), home.path()).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        let err = validate_agent_pools(&config(Some("~/does-not-exist")), home.path()).unwrap_err();
        assert!(err.starts_with("pool B:"), "{err}");
    }

    #[test]
    fn rejects_relative_path_even_if_it_exists() {
        let home = tempfile::tempdir().unwrap();
        // "." exists relative to cwd, but relative paths are never accepted.
        let err = validate_config_dir(Some("."), home.path()).unwrap_err();
        assert!(err.contains("must be absolute"), "{err}");
        let err = validate_config_dir(Some("cc2"), home.path()).unwrap_err();
        assert!(err.contains("must be absolute"), "{err}");
    }

    #[test]
    fn rejects_file_instead_of_dir_and_empty() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("f"), "x").unwrap();
        assert!(validate_config_dir(Some("~/f"), home.path()).is_err());
        assert!(validate_config_dir(Some("  "), home.path()).is_err());
    }

    #[test]
    fn rejects_unknown_default_and_unknown_assignment() {
        let home = tempfile::tempdir().unwrap();
        let mut c = config(None);
        c.default = "Z".into();
        assert!(validate_agent_pools(&c, home.path()).is_err());
        let mut c = config(None);
        c.assign.insert("Opus 1".into(), "Q".into());
        assert!(validate_agent_pools(&c, home.path()).is_err());
        let mut c = config(None);
        c.pools.clear();
        assert!(validate_agent_pools(&c, home.path()).is_err());
    }

    #[test]
    fn write_is_atomic_roundtrip_and_guards_base_hash() {
        let home = tempfile::tempdir().unwrap();
        let first = write_agent_pools(home.path(), &config(None), Some("")).unwrap();
        let read = read_agent_pools(home.path()).unwrap();
        assert_eq!(read.hash, first.hash);
        assert_eq!(read.config, first.config);
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(home.path().join(".buzz"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        // Stale baseHash is refused and the file is untouched.
        let mut next = config(None);
        next.default = "B".into();
        let err = write_agent_pools(home.path(), &next, Some("stale")).unwrap_err();
        assert!(err.contains("changed since"), "{err}");
        assert_eq!(read_agent_pools(home.path()).unwrap().hash, first.hash);
        // Correct baseHash succeeds.
        write_agent_pools(home.path(), &next, Some(&first.hash)).unwrap();
        assert_eq!(
            read_agent_pools(home.path())
                .unwrap()
                .config
                .unwrap()
                .default,
            "B"
        );
    }

    #[test]
    fn invalid_config_is_never_written() {
        let home = tempfile::tempdir().unwrap();
        assert!(write_agent_pools(home.path(), &config(Some("~/nope")), None).is_err());
        assert!(!home.path().join(POOLS_RELATIVE).exists());
    }

    #[test]
    fn parses_auth_status_identity() {
        let probe = parse_auth_status(
            br#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"Org","subscriptionType":"max","configDirectory":"/h/cc2"}"#,
        );
        assert!(probe.logged_in);
        assert_eq!(probe.email.as_deref(), Some("a@b.c"));
        assert_eq!(probe.subscription_type.as_deref(), Some("max"));
        assert!(parse_auth_status(b"nope").error.is_some());
    }
}
