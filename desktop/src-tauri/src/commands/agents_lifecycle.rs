//! Destructive managed-agent lifecycle verbs — `delete_managed_agent`,
//! `unregister_managed_agent` — and their guards. Split from `agents.rs`
//! along the incident seam: these are the only paths that can stop a live
//! seat or wipe an agent key, so they get their own file with the 9/2 rekey
//! post-mortem's invariants attached. Mounted as `mod lifecycle` inside
//! `commands::agents`.

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        current_instance_id, load_managed_agents, save_managed_agents,
        stop_managed_agent_process, sync_managed_agent_processes,
        try_regenerate_nest, BackendKind, ManagedAgentRuntimeKey,
    },
};

use super::{archive_managed_agent_pending, tombstone_managed_agent_pending};

/// True when the agent pubkey holds a live local runtime entry. Callers that
/// need accuracy over staleness run `sync_managed_agent_processes` first so
/// dead entries are already reaped. Takes only the keys — the runtime values
/// are irrelevant to liveness and this keeps the decision unit-testable.
pub(super) fn agent_is_running<'a, I>(pubkey: &str, runtime_keys: I) -> bool
where
    I: IntoIterator<Item = &'a ManagedAgentRuntimeKey>,
{
    runtime_keys.into_iter().any(|key| key.pubkey == pubkey)
}

/// Pure core of the running-agent delete guard, so the refusal is unit-testable
/// without an AppHandle. Mirrors the remote-backend guard contract: a UI
/// convention ("confirm first") made into a backend invariant.
pub(super) fn running_delete_guard(
    pubkey: &str,
    is_running: bool,
    force_running_delete: bool,
) -> Result<(), String> {
    if is_running && !force_running_delete {
        return Err(format!(
            "agent {pubkey} is running — stop it first, or pass force_running_delete: true"
        ));
    }
    Ok(())
}

// Async so the blocking body (disk reads/writes, process termination, keyring
// delete, nest regeneration) runs off the main UI thread via spawn_blocking.
#[tauri::command]
pub async fn delete_managed_agent(
    pubkey: String,
    force_remote_delete: Option<bool>,
    force_running_delete: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let mut records = load_managed_agents(&app)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;

            let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                &mut records,
                &mut runtimes,
                &current_instance_id(&app),
            );
            if sync_changed {
                save_managed_agents(&app, &records)?;
            }
            for pubkey in &exited_pubkeys {
                state.clear_agent_session_caches(pubkey);
            }

            // Guard: reject deletion of deployed remote agents unless explicitly forced.
            // This turns "don't orphan remote infra" from a UI convention into a backend
            // invariant — a buggy or compromised IPC caller cannot silently orphan a live
            // remote deployment. The frontend sends force_remote_delete: true only after
            // the user confirms the orphan warning.
            if let Some(record) = records.iter().find(|r| r.pubkey == pubkey) {
                if record.backend != BackendKind::Local
                    && record.backend_agent_id.is_some()
                    && !force_remote_delete.unwrap_or(false)
                {
                    return Err(
                        "cannot delete a deployed remote agent without force_remote_delete: true"
                            .to_string(),
                    );
                }
            }

            // Guard: reject deletion of an agent with a live local runtime
            // unless explicitly forced. Same backend-invariant contract as the
            // remote guard above — the 9/2 rekey incident killed five live
            // seats through exactly this path (a web cleanup batch deleted
            // running agents with only force_remote_delete set), and "stop
            // first" is the owner-legible recovery.
            running_delete_guard(
                &pubkey,
                agent_is_running(&pubkey, runtimes.keys()),
                force_running_delete.unwrap_or(false),
            )?;

            let persona_id = records
                .iter()
                .find(|record| record.pubkey == pubkey)
                .and_then(|record| record.persona_id.clone());
            let Some(record) = records.iter().find(|record| record.pubkey == pubkey).cloned()
            else {
                return Err(format!("agent {pubkey} not found"));
            };
            if let Some(record_mut) = records.iter_mut().find(|r| r.pubkey == pubkey) {
                stop_managed_agent_process(&app, record_mut, &mut runtimes)?;
            }
            state.clear_agent_session_caches(&pubkey);
            let initial_len = records.len();
            records.retain(|record| record.pubkey != pubkey);
            if records.len() == initial_len {
                return Err(format!("agent {pubkey} not found"));
            }
            save_managed_agents(&app, &records)?;
            // Key material is unrecoverable once wiped (no software keyring
            // recovery on Apple Silicon) — export a durable 0o600 copy FIRST
            // and fail closed: a delete whose backup export fails never
            // reaches the keyring wipe.
            if let Some(path) =
                crate::managed_agents::export_agent_key_backup(&app, &record)?
            {
                eprintln!(
                    "buzz-desktop: exported key for deleted agent {pubkey} to {}",
                    path.display()
                );
            }
            crate::managed_agents::delete_agent_key(&pubkey);
            // Tombstone after confirmed removal (inside lock; every published agent tombstones).
            tombstone_managed_agent_pending(&app, &state, &pubkey);
            // NIP-IA: archive the deleted agent's identity on the relay so it
            // stops appearing in member pickers and autocomplete. Same
            // best-effort, inside-the-lock contract as the tombstone above.
            archive_managed_agent_pending(&app, &state, &pubkey, persona_id.as_deref());
        }
        try_regenerate_nest(&app);
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Remove an agent's RELAY registration only: kind-5 tombstone for the 30177
/// plus a NIP-IA archive request. Never stops a process, never removes a
/// local record, never touches the keyring — this is the stale-cleanup verb,
/// split from delete after the 9/2 rekey incident (cleanup sent full deletes
/// and wiped five live agents' unrecoverable keys).
///
/// Refuses an agent this desktop owns as a local record: the boot reconciler
/// republishes 30177s from records, so unregistering a record this desktop
/// holds would resurrect the registration on next boot. That case is a
/// delete, not an unregister. Works with NO local record at all — stale
/// twins re-minted on another machine are the primary case.
#[tauri::command]
pub async fn unregister_managed_agent(pubkey: String, app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        {
            // Same lock discipline as delete: the pending helpers must run
            // inside the store-lock-held body and never across an .await.
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let records = load_managed_agents(&app)?;
            if records.iter().any(|record| record.pubkey == pubkey) {
                return Err(format!(
                    "agent {pubkey} is a local record on this desktop — delete it instead; \
                     unregister only removes relay registrations this desktop does not own"
                ));
            }
            let runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;
            if agent_is_running(&pubkey, runtimes.keys()) {
                return Err(format!(
                    "agent {pubkey} has a running process — stop it first"
                ));
            }
            // Registration removal: purge any pending 30177 row and enqueue
            // the tombstone, then the NIP-IA archive. No persona id — there
            // is no local record to source one from.
            tombstone_managed_agent_pending(&app, &state, &pubkey);
            archive_managed_agent_pending(&app, &state, &pubkey, None);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_is_running_matches_pubkey_across_relay_urls() {
        use crate::managed_agents::ManagedAgentRuntimeKey;
        // Two entries for the same pubkey (two relay URLs) must both count: the
        // guard asks "does this agent have a live process", not "this exact pair".
        let key_a = ManagedAgentRuntimeKey::new("aa".repeat(32), "ws://one").unwrap();
        let key_b = ManagedAgentRuntimeKey::new("aa".repeat(32), "ws://two").unwrap();
        let other = ManagedAgentRuntimeKey::new("bb".repeat(32), "ws://one").unwrap();
        let keys = vec![&key_a, &other];
        assert!(agent_is_running(&"aa".repeat(32), keys.iter().copied()));
        assert!(!agent_is_running(
            &"bb".repeat(32),
            std::iter::once(&key_b).filter(|_| false)
        ));
        // Same pubkey, second relay URL alone — still one agent, one life.
        assert!(agent_is_running(&"aa".repeat(32), std::iter::once(&key_b)));
        // Empty runtime map: nothing is running.
        assert!(!agent_is_running(&"aa".repeat(32), std::iter::empty()));
    }

    #[test]
    fn running_delete_guard_refuses_unforced_and_allows_forced() {
        // The 9/2 incident as a unit: a running agent must refuse delete unless
        // the caller explicitly forces it, and the error must say how to recover.
        let refusal = running_delete_guard("aa".repeat(32).as_str(), true, false).unwrap_err();
        assert!(refusal.contains("is running"), "refusal must name the state: {refusal}");
        assert!(
            refusal.contains("force_running_delete"),
            "refusal must name the escape hatch: {refusal}"
        );
        // Not running → allowed without force.
        assert!(running_delete_guard("aa".repeat(32).as_str(), false, false).is_ok());
        // Running + explicit force → allowed (deliberate owner action).
        assert!(running_delete_guard("aa".repeat(32).as_str(), true, true).is_ok());
    }
}
