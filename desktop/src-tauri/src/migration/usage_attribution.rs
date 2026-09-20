//! Boot-time seeding of NIP-AM usage attribution from observed configuration.
//!
//! Same shape as [`super::materialize`]: a JSON-level patch over
//! `agents/managed-agents.json` so it runs before any typed load and cannot be
//! defeated by a field the current binary does not understand.
//!
//! Idempotent and non-destructive. A record that already carries
//! `usage_attribution` is untouched — which covers both an owner-confirmed row
//! and a row the owner deliberately cleared — so this may run on every launch.
//! A record with no recorded runtime, provider or gateway is left with the
//! field **absent**: never a placeholder, never a shared catch-all bucket.
//!
//! Attribution is seeded per record, and definitions live in the same store as
//! instances (Phase-1A fold), so a definition and the instances minted from it
//! land in the same account by construction rather than by a second rule.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use tauri::Manager as _;

use crate::managed_agents::usage_attribution::{
    gateway_base_url_from_env, seed_absent_attribution, ObservedAgentConfig,
    UsageAttributionConfig,
};

/// Seed every unattributed agent record in the current (and, on dev builds, the
/// canonical) app-data store.
pub fn seed_usage_attribution_records(app: &tauri::AppHandle) {
    let Ok(current_dir) = app.path().app_data_dir() else {
        return;
    };
    let mut dirs = vec![current_dir.clone()];
    if let Some(canonical) = super::canonical_dev_data_dir(&current_dir) {
        if canonical.exists() && canonical != current_dir {
            dirs.push(canonical);
        }
    }
    for dir in dirs {
        let path = dir.join("agents/managed-agents.json");
        if path.exists() {
            seed_usage_attribution_in_file(&path);
        }
    }
}

fn seed_usage_attribution_in_file(path: &std::path::Path) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(mut records) = serde_json::from_str::<Vec<Value>>(&content) else {
        eprintln!(
            "buzz-desktop: seed-usage-attribution: failed to parse {}",
            path.display()
        );
        return;
    };
    let seeded = seed_records(&mut records);
    if seeded == 0 {
        return;
    }
    match serde_json::to_vec_pretty(&records) {
        Ok(bytes) => {
            if let Err(e) = crate::managed_agents::atomic_write_json_restricted(path, &bytes) {
                eprintln!("buzz-desktop: seed-usage-attribution: {e}");
            } else {
                eprintln!(
                    "buzz-desktop: seed-usage-attribution: seeded {seeded} unconfirmed account rows in {}",
                    path.display()
                );
            }
        }
        Err(e) => eprintln!("buzz-desktop: seed-usage-attribution: {e}"),
    }
}

/// Patch `records` in place; returns how many rows were seeded.
///
/// Pure over the parsed store so the grouping this produces is testable
/// without touching disk or an `AppHandle`.
pub(super) fn seed_records(records: &mut [Value]) -> usize {
    let definition_envs = definition_env_vars(records);
    let mut seeded = 0;
    for record in records.iter_mut() {
        let Some(obj) = record.as_object_mut() else {
            continue;
        };
        // Present means decided — by seeding on an earlier boot, by an owner
        // edit, or by an owner clearing it. Never rewrite it.
        if obj.contains_key("usage_attribution") {
            continue;
        }
        let runtime = string_field(obj.get("runtime"));
        let provider = string_field(obj.get("provider"));
        // The gateway an actual spawn would see: definition env under the
        // instance's own overrides, matching `merged_user_env`'s precedence.
        // Without the definition layer a linked instance and its definition
        // would be filed as two different subscriptions.
        let mut layered: BTreeMap<String, String> = string_field(obj.get("persona_id"))
            .and_then(|pid| definition_envs.get(pid))
            .cloned()
            .unwrap_or_default();
        layered.extend(env_vars(obj.get("env_vars")));
        let gateway = gateway_base_url_from_env(&layered).map(str::to_owned);

        // Go through the typed non-destructive helper rather than re-deciding
        // here: `seed_absent_attribution` owns the "only ever fill an absent
        // row" rule, and starting from `None` is what the `contains_key` guard
        // above has already established.
        let mut row: Option<UsageAttributionConfig> = None;
        let seeded_row = seed_absent_attribution(
            &mut row,
            ObservedAgentConfig {
                runtime_id: runtime,
                provider,
                gateway_base_url: gateway.as_deref(),
            },
        );
        let Some(config) = row.filter(|_| seeded_row) else {
            continue;
        };
        let Ok(value) = serde_json::to_value(&config) else {
            continue;
        };
        obj.insert("usage_attribution".to_string(), value);
        seeded += 1;
    }
    seeded
}

/// `slug -> env_vars` for every key-less definition record, so an instance can
/// resolve the env layer it inherits.
fn definition_env_vars(records: &[Value]) -> HashMap<String, BTreeMap<String, String>> {
    records
        .iter()
        .filter_map(|record| {
            let obj = record.as_object()?;
            let keyed = string_field(obj.get("pubkey")).is_some();
            if keyed {
                return None;
            }
            let slug = string_field(obj.get("slug"))?;
            Some((slug.to_string(), env_vars(obj.get("env_vars"))))
        })
        .collect()
}

fn string_field(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn env_vars(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    Some((key.clone(), value.as_str().map(str::to_owned)?))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "usage_attribution_tests.rs"]
mod tests;
