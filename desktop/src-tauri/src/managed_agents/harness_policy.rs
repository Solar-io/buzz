//! Provider-neutral policy for the roles a harness may delegate.
//!
//! Buzz owns the desired policy.  Native harness adapters (Codex, Claude, and
//! sibling Claude profiles) consume the compiled overlay and are responsible
//! for checking their live capability catalog before writing native config.
//! Keeping the desired state here avoids making the desktop application a
//! second, silently-drifting implementation of either harness's config file.
//!
//! The important boundary is [`compile_native_overlay`]: it preserves the
//! exact model and effort requested by the operator.  It never substitutes a
//! nearby model or effort when a native adapter cannot support the request.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::storage::{atomic_write_json_restricted, managed_agents_base_dir};

/// Current on-disk policy schema.
pub const HARNESS_POLICY_SCHEMA_VERSION: u32 = 1;
/// Environment variable carrying the compiled, provider-neutral overlay.
pub const HARNESS_POLICY_JSON_ENV: &str = "BUZZ_HARNESS_POLICY_JSON";
/// Environment variable carrying the canonical policy hash.
pub const HARNESS_POLICY_HASH_ENV: &str = "BUZZ_HARNESS_POLICY_HASH";
/// Environment variable naming the runtime profile receiving the overlay.
pub const HARNESS_POLICY_PROFILE_ENV: &str = "BUZZ_HARNESS_POLICY_PROFILE";
const HARNESS_POLICY_FILE: &str = "harness-policy.json";

/// Roles the orchestration policy can route.
///
/// Keep QA variants explicit.  A QA/tester role is not interchangeable with a
/// generic worker because the native adapters use the role name when creating
/// receipts and enforcing completion gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessRole {
    Architect,
    Coder,
    Qa,
    Tester,
    BackendTester,
    UiTester,
    Verifier,
    Worker,
}

impl HarnessRole {
    /// Every role that can appear in a complete policy.
    pub const ALL: [Self; 8] = [
        Self::Architect,
        Self::Coder,
        Self::Qa,
        Self::Tester,
        Self::BackendTester,
        Self::UiTester,
        Self::Verifier,
        Self::Worker,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Architect => "architect",
            Self::Coder => "coder",
            Self::Qa => "qa",
            Self::Tester => "tester",
            Self::BackendTester => "backend_tester",
            Self::UiTester => "ui_tester",
            Self::Verifier => "verifier",
            Self::Worker => "worker",
        }
    }
}

/// Reasoning-effort values accepted by the native harness adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessEffort {
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl HarnessEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// Exact model and effort requested for one role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRoleRoute {
    /// The exact model identifier.  It is intentionally opaque to Buzz.
    pub model: String,
    pub effort: HarnessEffort,
}

/// Whether a task normally delegates proportionally, and the explicit-request
/// behavior required by the approved policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultDelegationMode {
    Proportional,
}

impl Default for DefaultDelegationMode {
    fn default() -> Self {
        Self::Proportional
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationPolicy {
    #[serde(default)]
    pub default_mode: DefaultDelegationMode,
    /// An explicit architect/dev-team request always requires the complete
    /// architect → coder → QA/tester → verifier pipeline.
    #[serde(default = "default_true")]
    pub explicit_request_requires_pipeline: bool,
}

impl Default for DelegationPolicy {
    fn default() -> Self {
        Self {
            default_mode: DefaultDelegationMode::Proportional,
            explicit_request_requires_pipeline: true,
        }
    }
}

/// Provider-neutral description of a native runtime profile.
///
/// The model/effort capability set does not live here.  It is supplied by the
/// runtime catalog at compile time, so this schema cannot become a rival
/// capability table.  These fields only identify the native adapter and its
/// config surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProfilePolicy {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Native writes are the default.  Claude profiles without native exact
    /// Sol support select `codex_role_runner` instead of substituting a
    /// different model.
    #[serde(default)]
    pub adapter: HarnessPolicyAdapter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_config_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_config_format: Option<String>,
}

impl Default for HarnessProfilePolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            adapter: HarnessPolicyAdapter::Native,
            native_config_path: None,
            native_config_format: None,
        }
    }
}

/// Desired-state policy persisted by Buzz.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPolicy {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub delegation: DelegationPolicy,
    /// Global role defaults.  Missing roles are rejected at validation time;
    /// this makes an accidental partial policy fail closed instead of
    /// inheriting a hidden process default.
    #[serde(default)]
    pub role_defaults: BTreeMap<HarnessRole, HarnessRoleRoute>,
    /// Native runtime profiles such as `codex`, `claude`, and `claude-glm`.
    #[serde(default)]
    pub profiles: BTreeMap<String, HarnessProfilePolicy>,
    /// Per-agent role overrides.  Absence means inherit the global role route.
    /// Values are exact routes and are never interpreted as model aliases.
    #[serde(default)]
    pub agent_overrides: BTreeMap<String, BTreeMap<HarnessRole, HarnessRoleRoute>>,
}

/// Native adapter input describing the live capabilities of one profile.
///
/// Adapters must construct this from their runtime catalog.  A route is
/// unsupported when the exact model or effort is absent; compilation never
/// chooses a substitute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRuntimeCapability {
    pub profile_id: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub supported_models: BTreeSet<String>,
    #[serde(default)]
    pub supported_efforts: BTreeSet<HarnessEffort>,
    #[serde(default)]
    pub supports_role_routing: bool,
    /// Whether the profile can force the model and effort for each native
    /// role.  This is distinct from whether the runtime can merely list
    /// models; the canary gate is about effective enforcement.
    #[serde(default)]
    pub supports_forced_model_and_effort: bool,
}

/// The complete runtime catalog supplied to the compiler by a native adapter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRuntimeCatalog {
    pub runtimes: BTreeMap<String, HarnessRuntimeCapability>,
    /// Whether the Codex role-runner adapter is installed and available to
    /// profiles that cannot natively enforce the requested exact route.
    #[serde(default)]
    pub codex_role_runner_available: bool,
}

/// Native adapter selected for one runtime profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessPolicyAdapter {
    Native,
    CodexRoleRunner,
}

impl Default for HarnessPolicyAdapter {
    fn default() -> Self {
        Self::Native
    }
}

/// Health of a compiled profile.  Desired state remains visible even when
/// this is not healthy; the adapter must never hide an unsupported route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessPolicyHealth {
    Healthy,
    Unsupported,
    Unavailable,
    /// The spawn overlay has not yet been checked by the native adapter's
    /// live catalog.
    Unknown,
}

/// A route which could not be compiled for an exact runtime capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedHarnessRoute {
    pub profile_id: String,
    pub role: HarnessRole,
    pub model: String,
    pub effort: HarnessEffort,
    pub reason: String,
}

/// Exact route after applying an agent override, suitable for a native adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledHarnessRoute {
    pub model: String,
    pub effort: HarnessEffort,
}

/// One profile's compiled view.  `unsupported` is deliberately returned to
/// the caller instead of silently dropping or changing a route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledHarnessProfile {
    pub profile_id: String,
    pub adapter: HarnessPolicyAdapter,
    /// Desired routes after per-agent overrides, before adapter execution.
    pub routes: BTreeMap<HarnessRole, CompiledHarnessRoute>,
    /// Effective routes the selected adapter will execute.  This is kept
    /// separate from `routes` so a UI can show desired/effective distinctly.
    pub effective_routes: BTreeMap<HarnessRole, CompiledHarnessRoute>,
    pub health: HarnessPolicyHealth,
    pub unsupported: Vec<UnsupportedHarnessRoute>,
}

/// Provider-neutral compiler result and the canonical policy hash used for
/// spawn receipts and drift checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledHarnessPolicy {
    pub policy_hash: String,
    pub schema_version: u32,
    pub delegation: DelegationPolicy,
    pub profiles: BTreeMap<String, CompiledHarnessProfile>,
}

/// State returned to the UI and to other IPC callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPolicyState {
    pub policy: HarnessPolicy,
    pub policy_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPolicySaveResult {
    pub state: HarnessPolicyState,
    pub previous_revision: u64,
}

fn default_true() -> bool {
    true
}

fn default_schema_version() -> u32 {
    HARNESS_POLICY_SCHEMA_VERSION
}

/// Build the approved default matrix.
pub fn default_harness_policy() -> HarnessPolicy {
    let mut role_defaults = BTreeMap::new();
    for role in HarnessRole::ALL {
        role_defaults.insert(
            role,
            HarnessRoleRoute {
                model: "gpt-5.6-sol".to_string(),
                effort: if role == HarnessRole::Architect {
                    HarnessEffort::High
                } else {
                    HarnessEffort::Low
                },
            },
        );
    }

    let mut profiles = BTreeMap::new();
    // These are runtime profile identifiers, not capability claims.  Native
    // adapters still have to prove the exact route against their live catalog.
    for profile in ["codex", "goose", "buzz-agent"] {
        profiles.insert(profile.to_string(), HarnessProfilePolicy::default());
    }
    profiles.insert("claude-codex".to_string(), HarnessProfilePolicy::default());
    for profile in ["claude", "claude-glm"] {
        profiles.insert(
            profile.to_string(),
            HarnessProfilePolicy {
                adapter: HarnessPolicyAdapter::CodexRoleRunner,
                ..HarnessProfilePolicy::default()
            },
        );
    }

    HarnessPolicy {
        schema_version: HARNESS_POLICY_SCHEMA_VERSION,
        revision: 0,
        delegation: DelegationPolicy::default(),
        role_defaults,
        profiles,
        agent_overrides: BTreeMap::new(),
    }
}

impl Default for HarnessPolicy {
    fn default() -> Self {
        default_harness_policy()
    }
}

impl HarnessPolicy {
    /// Validate user-authored desired state before it is persisted or applied.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != HARNESS_POLICY_SCHEMA_VERSION {
            return Err(format!(
                "unsupported harness policy schema version {} (expected {})",
                self.schema_version, HARNESS_POLICY_SCHEMA_VERSION
            ));
        }
        for role in HarnessRole::ALL {
            let route = self.role_defaults.get(&role).ok_or_else(|| {
                format!(
                    "harness policy is missing the required {} role default",
                    role.as_str()
                )
            })?;
            validate_route(route, &format!("role default {}", role.as_str()))?;
        }
        if self.profiles.is_empty() {
            return Err("harness policy must name at least one runtime profile".to_string());
        }
        for profile in self.profiles.keys() {
            validate_id(profile, "runtime profile")?;
        }
        for (pubkey, overrides) in &self.agent_overrides {
            validate_pubkey(pubkey)?;
            for (role, route) in overrides {
                validate_route(route, &format!("override {pubkey} {}", role.as_str()))?;
            }
        }
        Ok(())
    }

    /// Resolve one exact role route using a per-agent override when present.
    pub fn route_for(&self, pubkey: Option<&str>, role: HarnessRole) -> Option<&HarnessRoleRoute> {
        pubkey
            .and_then(|key| self.agent_overrides.get(key))
            .and_then(|overrides| overrides.get(&role))
            .or_else(|| self.role_defaults.get(&role))
    }

    /// Compile the policy against an adapter-supplied live runtime catalog.
    ///
    /// `Ok` does not mean every route is supported: unsupported exact routes
    /// are represented in each profile's `unsupported` list so the UI can show
    /// the reason.  Call [`CompiledHarnessPolicy::require_supported`] before
    /// spawning when the selected profile must be usable now.
    pub fn compile(
        &self,
        catalog: &HarnessRuntimeCatalog,
        pubkey: Option<&str>,
    ) -> Result<CompiledHarnessPolicy, String> {
        self.validate()?;
        let mut profiles = BTreeMap::new();
        for profile_id in self.profiles.keys() {
            let profile_policy = &self.profiles[profile_id];
            let mut routes = BTreeMap::new();
            let mut effective_routes = BTreeMap::new();
            let mut unsupported = Vec::new();
            let capability = catalog.runtimes.get(profile_id);
            let runner_capability = catalog.runtimes.get("codex");
            for role in HarnessRole::ALL {
                let route = self
                    .route_for(pubkey, role)
                    .ok_or_else(|| format!("harness policy has no route for {}", role.as_str()))?;
                routes.insert(
                    role,
                    CompiledHarnessRoute {
                        model: route.model.clone(),
                        effort: route.effort,
                    },
                );
                let mut reason = None;
                match profile_policy.adapter {
                    HarnessPolicyAdapter::Native => {
                        let Some(capability) = capability else {
                            reason =
                                Some("runtime profile is absent from the live capability catalog");
                            if profile_id == "claude" || profile_id == "claude-glm" {
                                // Keep the diagnostic explicit: a Claude
                                // profile without a native exact route must
                                // choose the Codex role-runner adapter.
                                reason = Some(
                                    "native exact route is unsupported; select the Codex role-runner adapter",
                                );
                            }
                            if reason.is_some() {
                                // The profile may still be represented in the
                                // response so the UI can show desired state.
                            }
                            // Continue through the common unsupported path.
                            if let Some(reason) = reason {
                                unsupported.push(UnsupportedHarnessRoute {
                                    profile_id: profile_id.clone(),
                                    role,
                                    model: route.model.clone(),
                                    effort: route.effort,
                                    reason: reason.to_string(),
                                });
                            }
                            continue;
                        };
                        if !capability.available {
                            reason = Some("runtime profile is unavailable");
                        } else if !capability.supports_role_routing {
                            reason = Some("runtime does not report role-routing support");
                        } else if !capability.supports_forced_model_and_effort {
                            reason = Some(
                                "runtime cannot force an exact model and effort for native roles",
                            );
                        } else if !capability.supported_models.contains(&route.model) {
                            reason = Some("exact model is absent from the live capability catalog");
                        } else if !capability.supported_efforts.contains(&route.effort) {
                            reason =
                                Some("exact effort is absent from the live capability catalog");
                        }
                    }
                    HarnessPolicyAdapter::CodexRoleRunner => {
                        if !catalog.codex_role_runner_available {
                            reason = Some(
                                "Codex role-runner adapter is unavailable; install or enable it",
                            );
                        } else if runner_capability.map_or(true, |runner| {
                            !runner.available
                                || !runner.supports_role_routing
                                || !runner.supports_forced_model_and_effort
                                || !runner.supported_models.contains(&route.model)
                                || !runner.supported_efforts.contains(&route.effort)
                        }) {
                            reason = Some(
                                "the Codex role-runner catalog does not support this exact route",
                            );
                        }
                    }
                }
                if let Some(reason) = reason {
                    unsupported.push(UnsupportedHarnessRoute {
                        profile_id: profile_id.clone(),
                        role,
                        model: route.model.clone(),
                        effort: route.effort,
                        reason: reason.to_string(),
                    });
                } else {
                    effective_routes.insert(
                        role,
                        CompiledHarnessRoute {
                            model: route.model.clone(),
                            effort: route.effort,
                        },
                    );
                }
            }
            let health = if !profile_policy.enabled {
                HarnessPolicyHealth::Unavailable
            } else if unsupported.is_empty() {
                HarnessPolicyHealth::Healthy
            } else if profile_policy.adapter == HarnessPolicyAdapter::CodexRoleRunner
                && !catalog.codex_role_runner_available
            {
                HarnessPolicyHealth::Unavailable
            } else {
                HarnessPolicyHealth::Unsupported
            };
            profiles.insert(
                profile_id.clone(),
                CompiledHarnessProfile {
                    profile_id: profile_id.clone(),
                    adapter: profile_policy.adapter,
                    routes,
                    effective_routes,
                    health,
                    unsupported,
                },
            );
        }

        Ok(CompiledHarnessPolicy {
            policy_hash: policy_hash(self)?,
            schema_version: self.schema_version,
            delegation: self.delegation.clone(),
            profiles,
        })
    }

    /// Compile the exact overlay used by a Buzz-managed spawn.  Native
    /// adapters perform their own catalog check after reading this JSON.
    pub fn spawn_overlay(
        &self,
        profile_id: &str,
        pubkey: Option<&str>,
    ) -> Result<CompiledHarnessProfile, String> {
        self.validate()?;
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or_else(|| format!("unsupported harness profile '{profile_id}'"))?;
        if !profile.enabled {
            return Err(format!(
                "harness profile '{profile_id}' is disabled by policy"
            ));
        }
        let mut routes = BTreeMap::new();
        for role in HarnessRole::ALL {
            let route = self
                .route_for(pubkey, role)
                .ok_or_else(|| format!("harness policy has no route for {}", role.as_str()))?;
            routes.insert(
                role,
                CompiledHarnessRoute {
                    model: route.model.clone(),
                    effort: route.effort,
                },
            );
        }
        Ok(CompiledHarnessProfile {
            profile_id: profile_id.to_string(),
            adapter: profile.adapter,
            routes: routes.clone(),
            effective_routes: routes,
            health: HarnessPolicyHealth::Healthy,
            // The spawn overlay is provider-neutral.  The native adapter must
            // fill this from its current runtime catalog before applying it.
            unsupported: Vec::new(),
        })
    }
}

/// Compile one exact profile overlay against the runtime catalog.  This named
/// seam is used by IPC and spawn adapters so neither path can accidentally
/// invent a second resolution algorithm.
pub fn compile_native_overlay(
    policy: &HarnessPolicy,
    catalog: &HarnessRuntimeCatalog,
    profile_id: &str,
    pubkey: Option<&str>,
) -> Result<CompiledHarnessProfile, String> {
    let compiled = policy.compile(catalog, pubkey)?;
    compiled
        .profiles
        .get(profile_id)
        .cloned()
        .ok_or_else(|| format!("unsupported harness profile '{profile_id}'"))
}

/// Build the exact, redaction-free environment overlay handed to a managed
/// harness.  It contains desired and provisional effective routes; the native
/// adapter must update health after checking its runtime catalog.
pub fn spawn_overlay_env(
    policy: &HarnessPolicy,
    profile_id: &str,
    pubkey: Option<&str>,
) -> Result<BTreeMap<String, String>, String> {
    let mut overlay = policy.spawn_overlay(profile_id, pubkey)?;
    overlay.health = HarnessPolicyHealth::Unknown;
    let hash = policy_hash(policy)?;
    let payload = serde_json::to_string(&overlay)
        .map_err(|error| format!("failed to serialize harness spawn overlay: {error}"))?;
    let mut env = BTreeMap::new();
    env.insert(HARNESS_POLICY_JSON_ENV.to_string(), payload);
    env.insert(HARNESS_POLICY_HASH_ENV.to_string(), hash);
    env.insert(
        HARNESS_POLICY_PROFILE_ENV.to_string(),
        profile_id.to_string(),
    );
    Ok(env)
}

impl CompiledHarnessPolicy {
    /// Refuse to continue when the live catalog rejected any exact route.
    pub fn require_supported(&self, profile_id: &str) -> Result<(), String> {
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or_else(|| format!("unsupported harness profile '{profile_id}'"))?;
        if profile.unsupported.is_empty() {
            return Ok(());
        }
        let details = profile
            .unsupported
            .iter()
            .map(|route| {
                format!(
                    "{}={}@{} ({})",
                    route.role.as_str(),
                    route.model,
                    route.effort.as_str(),
                    route.reason
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "harness policy contains unsupported exact routes for '{profile_id}': {details}"
        ))
    }
}

/// Return a deterministic SHA-256 over the validated desired state.
pub fn policy_hash(policy: &HarnessPolicy) -> Result<String, String> {
    policy.validate()?;
    let canonical = serde_json::to_vec(policy)
        .map_err(|error| format!("failed to serialize harness policy for hashing: {error}"))?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

/// Load the desired policy.  Missing state means the approved default; a
/// malformed existing file is an error and is never silently replaced.
pub fn load_harness_policy(app: &AppHandle) -> Result<HarnessPolicy, String> {
    let path = harness_policy_path(app)?;
    if !path.exists() {
        return Ok(default_harness_policy());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read harness policy: {error}"))?;
    let policy: HarnessPolicy = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse harness policy: {error}"))?;
    policy.validate()?;
    Ok(policy)
}

/// Persist desired policy atomically with restricted permissions.
pub fn save_harness_policy(app: &AppHandle, policy: &HarnessPolicy) -> Result<(), String> {
    policy.validate()?;
    let path = harness_policy_path(app)?;
    let payload = serde_json::to_vec_pretty(policy)
        .map_err(|error| format!("failed to serialize harness policy: {error}"))?;
    atomic_write_json_restricted(&path, &payload)
}

fn harness_policy_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join(HARNESS_POLICY_FILE))
}

fn validate_route(route: &HarnessRoleRoute, context: &str) -> Result<(), String> {
    if route.model.trim().is_empty() {
        return Err(format!("{context} must name an exact model"));
    }
    if route.model.len() > 256 {
        return Err(format!("{context} model is too long"));
    }
    if route.model.contains('\0') || route.model.chars().any(char::is_control) {
        return Err(format!("{context} model contains control characters"));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {label} id '{value}'"));
    }
    Ok(())
}

fn validate_pubkey(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "invalid agent pubkey '{value}'; expected 64 hexadecimal characters"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_for(profiles: &[&str]) -> HarnessRuntimeCatalog {
        let mut catalog = HarnessRuntimeCatalog {
            codex_role_runner_available: true,
            ..HarnessRuntimeCatalog::default()
        };
        for profile in profiles {
            catalog.runtimes.insert(
                (*profile).to_string(),
                HarnessRuntimeCapability {
                    profile_id: (*profile).to_string(),
                    available: true,
                    supported_models: ["gpt-5.6-sol".to_string()].into_iter().collect(),
                    supported_efforts: [HarnessEffort::Low, HarnessEffort::High]
                        .into_iter()
                        .collect(),
                    supports_role_routing: true,
                    supports_forced_model_and_effort: true,
                },
            );
        }
        catalog
    }

    #[test]
    fn approved_default_matrix_is_sol_with_architect_high_and_workers_low() {
        let policy = default_harness_policy();
        assert_eq!(policy.role_defaults.len(), HarnessRole::ALL.len());
        assert_eq!(
            policy.role_defaults[&HarnessRole::Architect],
            HarnessRoleRoute {
                model: "gpt-5.6-sol".to_string(),
                effort: HarnessEffort::High,
            }
        );
        for role in HarnessRole::ALL {
            if role != HarnessRole::Architect {
                assert_eq!(policy.role_defaults[&role].effort, HarnessEffort::Low);
            }
        }
        assert!(policy.delegation.explicit_request_requires_pipeline);
        assert_eq!(
            policy.delegation.default_mode,
            DefaultDelegationMode::Proportional
        );
    }

    #[test]
    fn per_agent_route_wins_without_mutating_global_default() {
        let mut policy = default_harness_policy();
        let pubkey = "a".repeat(64);
        policy.agent_overrides.insert(
            pubkey.clone(),
            [(
                HarnessRole::Coder,
                HarnessRoleRoute {
                    model: "gpt-5.6-sol".to_string(),
                    effort: HarnessEffort::High,
                },
            )]
            .into_iter()
            .collect(),
        );
        policy.validate().unwrap();
        assert_eq!(
            policy
                .route_for(Some(&pubkey), HarnessRole::Coder)
                .unwrap()
                .effort,
            HarnessEffort::High
        );
        assert_eq!(
            policy.route_for(None, HarnessRole::Coder).unwrap().effort,
            HarnessEffort::Low
        );
    }

    #[test]
    fn missing_capability_is_reported_without_substitution() {
        let policy = default_harness_policy();
        let compiled = policy
            .compile(&HarnessRuntimeCatalog::default(), None)
            .unwrap();
        let codex = &compiled.profiles["codex"];
        assert_eq!(codex.routes[&HarnessRole::Architect].model, "gpt-5.6-sol");
        assert!(codex
            .unsupported
            .iter()
            .any(|route| route.role == HarnessRole::Architect));
        let error = compiled.require_supported("codex").unwrap_err();
        assert!(error.contains("unsupported exact routes"));
        assert!(error.contains("gpt-5.6-sol"));
    }

    #[test]
    fn exact_catalog_route_compiles_cleanly() {
        let policy = default_harness_policy();
        let compiled = policy
            .compile(
                &catalog_for(&["codex", "claude-codex", "claude", "claude-glm"]),
                None,
            )
            .unwrap();
        for profile in ["codex", "claude-codex", "claude", "claude-glm"] {
            assert!(compiled.profiles[profile].unsupported.is_empty());
            compiled.require_supported(profile).unwrap();
        }
    }

    #[test]
    fn unsupported_model_is_not_replaced_with_catalog_model() {
        let mut policy = default_harness_policy();
        policy
            .role_defaults
            .get_mut(&HarnessRole::Coder)
            .unwrap()
            .model = "model-that-is-not-installed".to_string();
        let compiled = policy
            .compile(
                &catalog_for(&["codex", "claude-codex", "claude", "claude-glm"]),
                None,
            )
            .unwrap();
        let route = &compiled.profiles["codex"].routes[&HarnessRole::Coder];
        assert_eq!(route.model, "model-that-is-not-installed");
        assert!(compiled.profiles["codex"]
            .unsupported
            .iter()
            .any(|entry| entry.role == HarnessRole::Coder));
    }

    #[test]
    fn hash_is_stable_and_changes_for_route_edits() {
        let mut policy = default_harness_policy();
        let first = policy_hash(&policy).unwrap();
        let second = policy_hash(&policy).unwrap();
        assert_eq!(first, second);
        policy
            .role_defaults
            .get_mut(&HarnessRole::Worker)
            .unwrap()
            .effort = HarnessEffort::Medium;
        assert_ne!(first, policy_hash(&policy).unwrap());
    }

    #[test]
    fn malformed_policy_is_rejected() {
        let mut policy = default_harness_policy();
        policy.role_defaults.remove(&HarnessRole::Verifier);
        assert!(policy.validate().unwrap_err().contains("verifier"));
        let mut policy = default_harness_policy();
        policy
            .agent_overrides
            .insert("not-a-pubkey".to_string(), BTreeMap::new());
        assert!(policy.validate().unwrap_err().contains("pubkey"));
    }
}
