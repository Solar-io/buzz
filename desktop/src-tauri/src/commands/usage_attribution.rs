//! IPC for owner-editable NIP-AM subscription/account attribution.
//!
//! Three commands over one store: read the current grouping, confirm an
//! account (every agent filed under it at once — the whole point, with 49
//! agents and a handful of subscriptions), and move or clear a single agent.
//!
//! Both writes go through `usage_attribution::apply_owner_attribution`, which
//! validates and marks the row confirmed. There is deliberately no way to write
//! an owner value that stays looking seeded: editing *is* confirming.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    managed_agents::{
        load_managed_agents, save_managed_agents,
        usage_attribution::{apply_owner_attribution, UsageAttributionConfig},
        ManagedAgentRecord,
    },
};

/// One agent (instance or definition) filed under an account.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionAgentRow {
    /// `None` for a key-less definition record.
    pub pubkey: Option<String>,
    /// `None` for an instance created without a definition.
    pub slug: Option<String>,
    pub name: String,
    /// The runtime profile identifier that was observed. A profile id, not a
    /// capability claim — the UI must not render it as a provider.
    pub runtime: Option<String>,
}

/// One account/subscription, and every agent reporting under it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionAccountRow {
    pub account_id: String,
    pub provider: Option<String>,
    pub account_label: Option<String>,
    /// `true` only when **every** agent in the group is confirmed. One still-
    /// seeded member keeps the whole account provisional: it is the weaker
    /// claim, and the dashboard is grouping their usage together.
    pub confirmed: bool,
    pub agents: Vec<UsageAttributionAgentRow>,
}

/// The full picture, including the agents that have no identity — which is a
/// reportable state, not an empty one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionOverview {
    pub accounts: Vec<UsageAttributionAccountRow>,
    /// Nothing observable was recorded for these agents, so no attribution was
    /// seeded. Not a placeholder account, and never counted as zero.
    pub unattributed: Vec<UsageAttributionAgentRow>,
    /// The owner explicitly recorded that these agents have no subscription
    /// identity. Distinct from `unattributed`: this is an answer.
    pub declined: Vec<UsageAttributionAgentRow>,
}

fn row(record: &ManagedAgentRecord) -> UsageAttributionAgentRow {
    UsageAttributionAgentRow {
        pubkey: (!record.pubkey.is_empty()).then(|| record.pubkey.clone()),
        slug: record.slug.clone(),
        name: record
            .display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| record.name.clone()),
        runtime: record.runtime.clone(),
    }
}

/// Group records into accounts. Pure over the loaded store so the grouping is
/// testable without an `AppHandle`.
pub(crate) fn overview_from_records(records: &[ManagedAgentRecord]) -> UsageAttributionOverview {
    // BTreeMap keeps accounts in a stable order across calls, so the UI does
    // not reshuffle rows between refreshes.
    let mut accounts: std::collections::BTreeMap<String, UsageAttributionAccountRow> =
        Default::default();
    let mut unattributed = Vec::new();
    let mut declined = Vec::new();

    for record in records {
        let Some(attribution) = record.usage_attribution.as_ref() else {
            unattributed.push(row(record));
            continue;
        };
        let Some(account_id) = attribution
            .account_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            declined.push(row(record));
            continue;
        };
        let entry =
            accounts
                .entry(account_id.to_string())
                .or_insert_with(|| UsageAttributionAccountRow {
                    account_id: account_id.to_string(),
                    provider: None,
                    account_label: None,
                    // Identity for the `&&` fold below; the first member decides.
                    confirmed: true,
                    agents: Vec::new(),
                });
        // A confirmed member's labels describe the account; a seeded member's
        // only fill a gap. Never let a seeded label overwrite a confirmed one.
        let prefer = attribution.confirmed || entry.agents.is_empty();
        if prefer {
            if attribution.provider.is_some() || entry.provider.is_none() {
                entry.provider = attribution.provider.clone();
            }
            if attribution.account_label.is_some() || entry.account_label.is_none() {
                entry.account_label = attribution.account_label.clone();
            }
        }
        entry.confirmed = entry.confirmed && attribution.confirmed;
        entry.agents.push(row(record));
    }

    UsageAttributionOverview {
        accounts: accounts.into_values().collect(),
        unattributed,
        declined,
    }
}

/// Read the current account grouping.
#[tauri::command]
pub fn get_usage_attribution_overview(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UsageAttributionOverview, String> {
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(overview_from_records(&load_managed_agents(&app)?))
}

/// Confirm (or rename, or clear) one account across every agent filed under it.
///
/// `account_id` selects the group as it stands today; the supplied values
/// replace it. Passing every field as `None` records "these agents have no
/// subscription identity" — still a confirmation, so seeding will not undo it.
#[tauri::command]
pub fn confirm_usage_account_attribution(
    account_id: String,
    provider: Option<String>,
    new_account_id: Option<String>,
    account_label: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UsageAttributionOverview, String> {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return Err("an account id is required to select the group to edit".to_string());
    }
    // Resolve and validate BEFORE taking the store lock's write path, so a bad
    // value fails without having touched anything.
    let applied = apply_owner_attribution(
        provider,
        new_account_id.or_else(|| Some(target.clone())),
        account_label,
    )?;

    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let now = crate::util::now_iso();
    let matched = confirm_account_in_records(&mut records, &target, &applied, &now);
    if matched == 0 {
        return Err(format!("no agents are filed under account {target}"));
    }
    save_managed_agents(&app, &records)?;
    Ok(overview_from_records(&records))
}

/// Rewrite every record currently filed under `target`; returns how many.
///
/// The command's whole write step, extracted so its tests exercise the shipped
/// loop rather than a re-creation of it.
pub(crate) fn confirm_account_in_records(
    records: &mut [ManagedAgentRecord],
    target: &str,
    applied: &UsageAttributionConfig,
    now: &str,
) -> usize {
    let mut matched = 0;
    for record in records.iter_mut() {
        if record
            .usage_attribution
            .as_ref()
            .and_then(|a| a.account_id.as_deref())
            .map(str::trim)
            != Some(target)
        {
            continue;
        }
        record.usage_attribution = Some(applied.clone());
        record.updated_at = now.to_string();
        matched += 1;
    }
    matched
}

/// Move one agent to a different account, or clear its attribution.
///
/// Clearing is recorded as a confirmed-empty row rather than by removing the
/// field: removing it would let boot-time seeding fill it back in from observed
/// configuration on the next launch, silently reversing the owner.
#[tauri::command]
pub fn set_agent_usage_attribution(
    pubkey: String,
    provider: Option<String>,
    account_id: Option<String>,
    account_label: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UsageAttributionOverview, String> {
    let applied = apply_owner_attribution(provider, account_id, account_label)?;
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let record = records
        .iter_mut()
        .find(|record| record.pubkey == pubkey || record.slug.as_deref() == Some(pubkey.as_str()))
        .ok_or_else(|| format!("agent {pubkey} not found"))?;
    record.usage_attribution = Some(applied);
    record.updated_at = crate::util::now_iso();
    save_managed_agents(&app, &records)?;
    Ok(overview_from_records(&records))
}

#[cfg(test)]
#[path = "usage_attribution_tests.rs"]
mod tests;
