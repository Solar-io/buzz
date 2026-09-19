//! IPC surface for the provider-neutral harness role policy.

use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::managed_agents::harness_policy::{
    compile_native_overlay, load_harness_policy, policy_hash, save_harness_policy,
    CompiledHarnessPolicy, HarnessPolicy, HarnessPolicySaveResult, HarnessPolicyState,
    HarnessRuntimeCatalog,
};

fn policy_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn next_policy_revision(previous: u64, submitted: u64) -> Result<u64, String> {
    if submitted != previous {
        return Err(format!(
            "harness policy changed concurrently (expected revision {previous}, received {submitted}); reload before saving"
        ));
    }
    previous
        .checked_add(1)
        .ok_or_else(|| "harness policy revision overflow".to_string())
}

/// Read the desired harness policy and its canonical hash.
#[tauri::command]
pub fn get_harness_policy(app: AppHandle) -> Result<HarnessPolicyState, String> {
    let policy = load_harness_policy(&app)?;
    let hash = policy_hash(&policy)?;
    Ok(HarnessPolicyState {
        policy,
        policy_hash: hash,
    })
}

/// Validate and save desired policy state.
///
/// The revision is assigned by the desktop write boundary.  A caller cannot
/// claim a newer revision by sending an arbitrary value, and a failed
/// validation never touches the previous file.
#[tauri::command]
pub fn set_harness_policy(
    mut policy: HarnessPolicy,
    app: AppHandle,
) -> Result<HarnessPolicySaveResult, String> {
    let _guard = policy_write_lock()
        .lock()
        .map_err(|_| "harness policy write lock is poisoned".to_string())?;
    let previous = load_harness_policy(&app)?;
    policy.revision = next_policy_revision(previous.revision, policy.revision)?;
    policy.validate()?;
    save_harness_policy(&app, &policy)?;
    let state = HarnessPolicyState {
        policy: policy.clone(),
        policy_hash: policy_hash(&policy)?,
    };
    Ok(HarnessPolicySaveResult {
        state,
        previous_revision: previous.revision,
    })
}

/// Compile desired policy against the live runtime capability catalog supplied
/// by a native adapter or an acceptance probe.  Unsupported exact routes are
/// returned in the compiled profile and are never substituted.
#[tauri::command]
pub fn compile_harness_policy(
    policy: HarnessPolicy,
    catalog: HarnessRuntimeCatalog,
    agent_pubkey: Option<String>,
) -> Result<CompiledHarnessPolicy, String> {
    policy.compile(&catalog, agent_pubkey.as_deref())
}

/// Compile one exact profile overlay for a spawn adapter.
#[tauri::command]
pub fn compile_harness_profile_overlay(
    policy: HarnessPolicy,
    catalog: HarnessRuntimeCatalog,
    profile_id: String,
    agent_pubkey: Option<String>,
) -> Result<crate::managed_agents::harness_policy::CompiledHarnessProfile, String> {
    compile_native_overlay(&policy, &catalog, &profile_id, agent_pubkey.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_module_uses_versioned_policy_types() {
        let policy = HarnessPolicy::default();
        assert_eq!(policy.schema_version, 1);
        assert!(!policy_hash(&policy).unwrap().is_empty());
    }

    #[test]
    fn stale_policy_revision_is_rejected_instead_of_overwriting_newer_state() {
        let error = next_policy_revision(4, 3).unwrap_err();
        assert!(error.contains("changed concurrently"));
    }

    #[test]
    fn policy_revision_advances_exactly_once() {
        assert_eq!(next_policy_revision(4, 4).unwrap(), 5);
    }
}
