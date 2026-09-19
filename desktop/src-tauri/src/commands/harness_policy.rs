//! IPC surface for the provider-neutral harness role policy.

use tauri::AppHandle;

use crate::managed_agents::harness_policy::{
    compile_native_overlay, load_harness_policy, policy_hash, save_harness_policy,
    CompiledHarnessPolicy, HarnessPolicy, HarnessPolicySaveResult, HarnessPolicyState,
    HarnessRuntimeCatalog,
};

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
    let previous = load_harness_policy(&app)?;
    policy.revision = previous.revision.saturating_add(1);
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
}
