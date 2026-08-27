//! Owner-managed custom web panel sites.
//!
//! Everything else in the panel system is compile-time config: static URLs
//! baked into `web_panels.rs`. This module amends that with a small JSON
//! store of sites the OWNER adds at runtime, without weakening the
//! invariant that the app webview can never supply a URL:
//!
//! - The URL crosses the IPC boundary ONLY from the trusted bundled add
//!   window ([`WEBPANEL_ADD_WINDOW_LABEL`], created by
//!   `open_web_panel_add_window` over the app's own `add.html` asset — no
//!   query params, no external URLs). `add_custom_panel` enforces this by
//!   checking the CALLING WEBVIEW's label first: a compromised main app
//!   webview can invoke the command but is refused, because its label is
//!   "main". Typed values in the bundled form are the owner-intent proof,
//!   so no native confirm runs on add.
//! - `list_custom_panels` returns `{id, label, title}` only. The URL never
//!   crosses to the app webview — which is also why custom panels render
//!   native-only (the CSP `frame-src` stays a static, compile-time list).
//!
//! Storage is `{version, next_id, entries}` at
//! `app_config_dir()/custom_web_panels.json`, written atomically. Ids are
//! `site-{n}`, monotonic from `next_id`, never reused (removal does not
//! renumber). A missing file is an empty list; an unreadable or corrupt one
//! fails CLOSED — list/add/remove return errors naming the path, customs
//! are disabled for the run, and static panels are unaffected. No guessing,
//! no silent reset.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::web_panels::require_https;

/// Cap on stored sites: each one can be a live WKWebView session when open.
pub const MAX_CUSTOM_PANELS: usize = 16;
const STORE_VERSION: u32 = 1;
const MAX_URL_LEN: usize = 2048;
const MAX_LABEL_CHARS: usize = 64;
/// `site-` plus at most this many digits keeps ids within the 32-char
/// instance-id budget shared with `validate_instance_id`.
const MAX_ID_DIGITS: usize = 26;

/// The ONLY webview whose invocations of `add_custom_panel` are honored:
/// the small trusted window `open_web_panel_add_window` builds over the
/// bundled add form. This is the security gate — the main app webview (and
/// every panel child webview) carries a different label and is refused.
pub const WEBPANEL_ADD_WINDOW_LABEL: &str = "webpanel-add";

/// Event emitted app-wide after a site is added, carrying the
/// `CustomPanelInfo` (never the URL) so the app webview can refresh its
/// registry and open a tab for the new site.
const CUSTOM_PANEL_ADDED_EVENT: &str = "custom-panel-added";

/// A stored site. `url` is the normalized (fragment-stripped) https URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CustomPanelEntry {
    pub id: String,
    pub label: String,
    pub url: String,
}

/// What crosses the IPC boundary: id/label/title, never the URL.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CustomPanelInfo {
    pub id: String,
    pub label: String,
    pub title: String,
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    next_id: u64,
    entries: Vec<CustomPanelEntry>,
}

/// In-memory mirror of the store. `Failed` is sticky for the app run: a
/// corrupt store keeps failing until a human deletes the file and restarts.
enum RegistryState {
    Unloaded,
    Loaded {
        next_id: u64,
        entries: Vec<CustomPanelEntry>,
    },
    Failed(String),
}

fn registry() -> &'static Mutex<RegistryState> {
    static REGISTRY: OnceLock<Mutex<RegistryState>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(RegistryState::Unloaded))
}

/// Test seam: point the store at an explicit path (a tempdir), so the
/// fail-closed rules are unit-testable without a Tauri app. The override
/// lives behind its own mutex so parallel tests can install and clear it.
fn store_path_override() -> &'static Mutex<Option<PathBuf>> {
    static OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| Mutex::new(None))
}

fn store_path(app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    if let Ok(guard) = store_path_override().lock() {
        if let Some(path) = guard.as_ref() {
            return Ok(path.clone());
        }
    }
    let app = app.ok_or_else(|| {
        "the custom web panel store is unavailable: no app handle and no test override".to_string()
    })?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("app config dir unavailable: {error}"))?;
    Ok(dir.join("custom_web_panels.json"))
}

/// Serialize tests that share the global registry: one tempdir at a time.
#[cfg(test)]
pub(crate) fn test_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Normalize and validate an owner-supplied site URL: https only, a real
/// host, no userinfo, length-capped, fragment stripped (fragments are
/// client-side state and would defeat exact-dup comparison).
pub(crate) fn validate_custom_url(raw: &str) -> Result<tauri::Url, String> {
    let trimmed = raw.trim();
    if trimmed.len() > MAX_URL_LEN {
        return Err(format!("site url is longer than {MAX_URL_LEN} characters"));
    }
    let mut url: tauri::Url = trimmed.parse().map_err(|error: url::ParseError| {
        format!("site url {trimmed:?} does not parse: {error}")
    })?;
    require_https(&url)?;
    if url.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(format!("site url must name a host: {trimmed:?}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "site url must not carry user credentials: {trimmed:?}"
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

/// Labels are trimmed, 1..=64 chars, no control characters.
pub(crate) fn validate_custom_label(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("site label must not be empty".to_string());
    }
    if trimmed.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "site label is longer than {MAX_LABEL_CHARS} characters: {trimmed:?}"
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!(
            "site label must not contain control characters: {trimmed:?}"
        ));
    }
    Ok(trimmed.to_string())
}

fn valid_entry_id(id: &str) -> bool {
    match id.strip_prefix("site-") {
        Some(digits) => {
            !digits.is_empty()
                && digits.len() <= MAX_ID_DIGITS
                && digits.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

/// Defense-in-depth on the store's own content: every entry must satisfy
/// the same rules the add path enforces, or the whole store is corrupt.
fn validate_entry(entry: &CustomPanelEntry) -> Result<(), String> {
    if !valid_entry_id(&entry.id) {
        return Err(format!("entry id {:?} is not site-<digits>", entry.id));
    }
    validate_custom_label(&entry.label)?;
    let normalized = validate_custom_url(&entry.url)?;
    if normalized.to_string() != entry.url {
        return Err(format!(
            "entry {} url is not normalized: {:?}",
            entry.id, entry.url
        ));
    }
    Ok(())
}

fn load_store(path: &Path) -> Result<(u64, Vec<CustomPanelEntry>), String> {
    if !path.exists() {
        return Ok((1, Vec::new()));
    }
    let raw = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "cannot read the custom web panel store at {}: {error} — fix or delete the file and restart",
            path.display()
        )
    })?;
    let parsed: StoreFile = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "the custom web panel store at {} is corrupt: {error} — delete the file to reset it",
            path.display()
        )
    })?;
    if parsed.version != STORE_VERSION {
        return Err(format!(
            "the custom web panel store at {} has unsupported version {} (expected {STORE_VERSION}) — delete the file to reset it",
            path.display(),
            parsed.version
        ));
    }
    for entry in &parsed.entries {
        validate_entry(entry).map_err(|error| {
            format!(
                "the custom web panel store at {} is corrupt: {error}",
                path.display()
            )
        })?;
    }
    for (index, entry) in parsed.entries.iter().enumerate() {
        if parsed.entries[..index]
            .iter()
            .any(|other| other.url == entry.url)
        {
            return Err(format!(
                "the custom web panel store at {} is corrupt: duplicate url {:?}",
                path.display(),
                entry.url
            ));
        }
    }
    let max_used = parsed
        .entries
        .iter()
        .filter_map(|entry| {
            entry
                .id
                .strip_prefix("site-")
                .and_then(|digits| digits.parse::<u64>().ok())
        })
        .max()
        .unwrap_or(0);
    if parsed.next_id <= max_used {
        return Err(format!(
            "the custom web panel store at {} is corrupt: next_id {} would reuse an id — delete the file to reset it",
            path.display(),
            parsed.next_id
        ));
    }
    Ok((parsed.next_id, parsed.entries))
}

fn persist_store(path: &Path, next_id: u64, entries: &[CustomPanelEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "cannot create the custom web panel store dir {}: {error}",
                    parent.display()
                )
            })?;
        }
    }
    let payload = serde_json::to_string_pretty(&StoreFile {
        version: STORE_VERSION,
        next_id,
        entries: entries.to_vec(),
    })
    .map_err(|error| format!("cannot encode the custom web panel store: {error}"))?;
    let mut file = atomic_write_file::AtomicWriteFile::open(path).map_err(|error| {
        format!(
            "cannot open {} for an atomic write: {error}",
            path.display()
        )
    })?;
    file.write_all(payload.as_bytes())
        .map_err(|error| format!("cannot write the custom web panel store: {error}"))?;
    file.commit()
        .map_err(|error| format!("cannot commit the custom web panel store: {error}"))
}

/// Load the registry on first use; a load failure poisons it for the run.
fn ensure_loaded(app: Option<&tauri::AppHandle>, state: &mut RegistryState) -> Result<(), String> {
    if !matches!(state, RegistryState::Unloaded) {
        return Ok(());
    }
    match load_store(&store_path(app)?) {
        Ok((next_id, entries)) => {
            *state = RegistryState::Loaded { next_id, entries };
            Ok(())
        }
        Err(error) => {
            *state = RegistryState::Failed(error.clone());
            Err(error)
        }
    }
}

/// Read the entries under the registry lock.
fn with_entries<T>(
    app: Option<&tauri::AppHandle>,
    run: impl FnOnce(&[CustomPanelEntry]) -> T,
) -> Result<T, String> {
    let mut guard = registry()
        .lock()
        .map_err(|_| "the custom panel registry lock is poisoned".to_string())?;
    ensure_loaded(app, &mut guard)?;
    match &*guard {
        RegistryState::Loaded { entries, .. } => Ok(run(entries)),
        RegistryState::Failed(error) => Err(error.clone()),
        RegistryState::Unloaded => unreachable!("ensure_loaded resolves the state"),
    }
}

/// Mutate the entries under the registry lock, persisting BEFORE committing
/// the in-memory change, so a failed write leaves memory and disk agreeing
/// on the old content. Validation failures never reach the disk.
fn mutate_entries<T>(
    app: Option<&tauri::AppHandle>,
    run: impl FnOnce(&mut Vec<CustomPanelEntry>, &mut u64) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = registry()
        .lock()
        .map_err(|_| "the custom panel registry lock is poisoned".to_string())?;
    ensure_loaded(app, &mut guard)?;
    if let RegistryState::Failed(error) = &*guard {
        return Err(error.clone());
    }
    let RegistryState::Loaded { next_id, entries } = &mut *guard else {
        unreachable!("ensure_loaded resolves the state");
    };
    let mut candidate_entries = entries.clone();
    let mut candidate_next_id = *next_id;
    let result = run(&mut candidate_entries, &mut candidate_next_id)?;
    persist_store(&store_path(app)?, candidate_next_id, &candidate_entries)?;
    *entries = candidate_entries;
    *next_id = candidate_next_id;
    Ok(result)
}

fn to_info(entry: &CustomPanelEntry) -> CustomPanelInfo {
    CustomPanelInfo {
        id: entry.id.clone(),
        label: entry.label.clone(),
        title: entry.label.clone(),
    }
}

fn panels(app: Option<&tauri::AppHandle>) -> Result<Vec<CustomPanelInfo>, String> {
    with_entries(app, |entries| entries.iter().map(to_info).collect())
}

/// Resolve a custom panel id to its stored entry, for `resolve_panel_type`.
/// Unknown ids are `Ok(None)` (the caller owns the unknown-id error); a
/// failed store is `Err` — fail closed.
pub(crate) fn find_entry(
    app: Option<&tauri::AppHandle>,
    panel_id: &str,
) -> Result<Option<CustomPanelEntry>, String> {
    with_entries(app, |entries| {
        entries.iter().find(|entry| entry.id == panel_id).cloned()
    })
}

/// Validate + persist a new site. Ids are allocated from `next_id` and
/// never reused, so removal cannot shadow an old tab's instance ids.
pub(crate) fn add_entry(
    app: Option<&tauri::AppHandle>,
    label: &str,
    url: &str,
) -> Result<CustomPanelEntry, String> {
    let label = validate_custom_label(label)?;
    let url = validate_custom_url(url)?;
    let url_string = url.to_string();
    mutate_entries(app, |entries, next_id| {
        if entries.len() >= MAX_CUSTOM_PANELS {
            return Err(format!(
                "custom site limit reached ({MAX_CUSTOM_PANELS}) — remove one first"
            ));
        }
        if entries.iter().any(|entry| entry.url == url_string) {
            return Err(format!("{url_string} is already added"));
        }
        let entry = CustomPanelEntry {
            id: format!("site-{next_id}"),
            label,
            url: url_string,
        };
        *next_id += 1;
        entries.push(entry.clone());
        Ok(entry)
    })
}

fn remove_entry(app: Option<&tauri::AppHandle>, id: &str) -> Result<(), String> {
    mutate_entries(app, |entries, _| {
        let before = entries.len();
        entries.retain(|entry| entry.id != id);
        if entries.len() == before {
            return Err(format!("unknown custom site id: {id}"));
        }
        Ok(())
    })
}

// ── Native dialog (owner-driven; the app webview cannot click it away) ──

async fn confirm_dialog(
    app: &tauri::AppHandle,
    title: &str,
    message: String,
    ok_button: &str,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok_button.to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver
        .await
        .map_err(|_| "the confirmation dialog closed unexpectedly".to_string())
}

// ── Commands ────────────────────────────────────────────────────────────

/// The custom site list. `{id, label, title}` only — never the URL.
#[tauri::command]
pub fn list_custom_panels(app: tauri::AppHandle) -> Result<Vec<CustomPanelInfo>, String> {
    panels(Some(&app))
}

/// THE SECURITY GATE: `add_custom_panel` honors a caller only when the
/// invoking webview IS the trusted bundled add window. The main app webview
/// (label "main"), every panel child webview, and every login companion
/// carries a different label and is refused before any validation or store
/// access runs — a compromised app webview can invoke the command but can
/// never supply a URL that sticks.
pub(crate) fn validate_add_caller(caller_label: &str) -> Result<(), String> {
    if caller_label != WEBPANEL_ADD_WINDOW_LABEL {
        return Err(format!(
            "add_custom_panel is only callable from the bundled add window ({WEBPANEL_ADD_WINDOW_LABEL}), not webview {caller_label:?}"
        ));
    }
    Ok(())
}

/// Pure validation for an add request: the caller gate FIRST, then the
/// label/url rules. Split out so the fail-closed rules (including the
/// caller gate) are unit-testable without a Tauri app.
fn validate_add_request(caller_label: &str, label: &str, url: &str) -> Result<(), String> {
    validate_add_caller(caller_label)?;
    validate_custom_label(label)?;
    validate_custom_url(url)?;
    Ok(())
}

/// Add a site typed into the trusted add window. The caller webview label
/// is the gate (see [`validate_add_caller`]); the typed values are the
/// owner-intent proof, so there is no native confirm on add. On success an
/// app-wide `custom-panel-added` event carries the new panel's info (never
/// its URL) so the app webview refreshes its registry.
#[tauri::command]
pub fn add_custom_panel(
    webview: tauri::Webview,
    label: String,
    url: String,
) -> Result<CustomPanelInfo, String> {
    validate_add_request(webview.label(), &label, &url)?;
    let entry = add_entry(Some(&webview.app_handle()), &label, &url)?;
    let info = to_info(&entry);
    // The add already persisted; a failed event delivery must not read as a
    // failed add to the form (which would close without the tab opening).
    if let Err(error) = webview.app_handle().emit(CUSTOM_PANEL_ADDED_EVENT, &info) {
        eprintln!("cannot broadcast {CUSTOM_PANEL_ADDED_EVENT}: {error}");
    }
    Ok(info)
}

/// Remove a site after a native confirmation. Cancelling is a no-op `Ok`.
/// Live webviews of the site are the frontend's problem: it closes those
/// tabs, which drives `destroy_web_panel` as usual.
#[tauri::command]
pub async fn remove_custom_panel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // The confirm dialog needs the label; a missing entry is a hard error
    // rather than a silent no-op.
    let Some(entry) = find_entry(Some(&app), &id)? else {
        return Err(format!("unknown custom site id: {id}"));
    };
    let confirmed = confirm_dialog(
        &app,
        "Remove site",
        format!("Remove site {}?", entry.label),
        "Remove site",
    )
    .await?;
    if !confirmed {
        return Ok(());
    }
    remove_entry(Some(&app), &id)
}

// ── Test support ────────────────────────────────────────────────────────

/// Install a tempdir-backed store. The CALLER must hold `test_store_lock()`
/// for the whole body that uses it, so parallel tests never share registry
/// state.
#[cfg(test)]
pub(crate) fn install_test_store(path: &Path) {
    *store_path_override()
        .lock()
        .expect("store path override lock") = Some(path.to_path_buf());
    reset_registry_for_tests();
}

/// Clear the override and reset the registry. Caller holds the test lock.
#[cfg(test)]
pub(crate) fn clear_test_store() {
    *store_path_override()
        .lock()
        .expect("store path override lock") = None;
    reset_registry_for_tests();
}

#[cfg(test)]
pub(crate) fn reset_registry_for_tests() {
    *registry().lock().expect("registry lock") = RegistryState::Unloaded;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `run` against a fresh tempdir store; isolated by the shared lock.
    fn with_store(run: impl FnOnce(&Path)) {
        let _guard = test_store_lock().lock().expect("test store lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let store_path = dir.path().join("custom_web_panels.json");
        install_test_store(&store_path);
        run(dir.path());
        clear_test_store();
    }

    fn add(app: Option<&tauri::AppHandle>, label: &str, url: &str) -> CustomPanelEntry {
        add_entry(app, label, url).expect("add succeeds")
    }

    #[test]
    fn missing_store_is_an_empty_list() {
        with_store(|_| {
            assert!(panels(None).expect("list succeeds").is_empty());
        });
    }

    #[test]
    fn add_list_round_trip_and_persistence_shape() {
        with_store(|dir| {
            add(None, "Wiki", "https://wiki.example/docs#section");
            let infos = panels(None).expect("list succeeds");
            assert_eq!(infos.len(), 1);
            assert_eq!(infos[0].id, "site-1");
            assert_eq!(infos[0].label, "Wiki");
            assert_eq!(infos[0].title, "Wiki");
            // The on-disk shape: version 1, advanced next_id, normalized url.
            let raw = std::fs::read_to_string(dir.join("custom_web_panels.json"))
                .expect("store file exists");
            let parsed: StoreFile = serde_json::from_str(&raw).expect("store parses");
            assert_eq!(parsed.version, 1);
            assert_eq!(parsed.next_id, 2);
            assert_eq!(parsed.entries.len(), 1);
            // Fragment stripped before storing.
            assert_eq!(parsed.entries[0].url, "https://wiki.example/docs");
        });
    }

    #[test]
    fn panel_info_never_serializes_the_url() {
        // The IPC contract: no url field may ever cross to the app webview.
        let info = to_info(&CustomPanelEntry {
            id: "site-1".to_string(),
            label: "Wiki".to_string(),
            url: "https://secret.example/".to_string(),
        });
        let value = serde_json::to_value(&info).expect("info serializes");
        let keys: Vec<&str> = value
            .as_object()
            .expect("info is an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["id", "label", "title"]);
    }

    #[test]
    fn ids_are_monotonic_and_never_reused_across_remove() {
        with_store(|_| {
            let first = add(None, "One", "https://one.example/");
            remove_entry(None, &first.id).expect("remove succeeds");
            let second = add(None, "Two", "https://two.example/");
            assert_eq!(first.id, "site-1");
            assert_eq!(second.id, "site-2", "removal must not renumber ids");
            assert_eq!(panels(None).expect("list succeeds").len(), 1);
        });
    }

    #[test]
    fn remove_of_unknown_id_fails() {
        with_store(|_| {
            assert!(remove_entry(None, "site-9").is_err());
        });
    }

    #[test]
    fn url_validation_matrix_fails_closed() {
        assert!(validate_custom_url("http://plain.example/").is_err());
        assert!(validate_custom_url("https://user:pass@example.com/").is_err());
        assert!(validate_custom_url("https://user@example.com/").is_err());
        assert!(
            validate_custom_url(&format!("https://example.com/{}", "a".repeat(2048))).is_err(),
            "urls longer than 2048 characters must be refused"
        );
        // https with a port is fine (tailnet doors use non-default ports).
        assert!(validate_custom_url("https://host.tailb3d4b8.ts.net:6201/x").is_ok());
        // Fragments are stripped.
        let normalized = validate_custom_url("https://example.com/page#frag").expect("parses");
        assert_eq!(normalized.to_string(), "https://example.com/page");
    }

    #[test]
    fn label_validation_matrix_fails_closed() {
        assert!(validate_custom_label("").is_err());
        assert!(validate_custom_label("   ").is_err());
        assert!(validate_custom_label(&"x".repeat(65)).is_err());
        assert!(validate_custom_label("bad\u{7}label").is_err());
        assert_eq!(validate_custom_label("  Wiki  ").expect("ok"), "Wiki");
        assert_eq!(
            validate_custom_label(&"x".repeat(64))
                .expect("ok")
                .chars()
                .count(),
            64
        );
    }

    #[test]
    fn duplicate_urls_are_refused_including_fragment_variants() {
        with_store(|_| {
            add(None, "Wiki", "https://wiki.example/docs");
            let exact = add_entry(None, "Other", "https://wiki.example/docs");
            assert!(exact.is_err(), "exact duplicate must be refused");
            let fragment = add_entry(None, "Other", "https://wiki.example/docs#x");
            assert!(
                fragment.is_err(),
                "fragment-only difference must normalize to a duplicate"
            );
        });
    }

    #[test]
    fn store_cap_is_enforced_at_sixteen() {
        with_store(|_| {
            for index in 1..=MAX_CUSTOM_PANELS {
                add(
                    None,
                    &format!("Site {index}"),
                    &format!("https://s{index}.example/"),
                );
            }
            let over = add_entry(None, "Too Many", "https://over.example/");
            assert!(over.is_err(), "the 17th site must be refused");
            assert_eq!(
                panels(None).expect("list succeeds").len(),
                MAX_CUSTOM_PANELS
            );
        });
    }

    #[test]
    fn corrupt_store_fails_closed_for_the_run() {
        with_store(|dir| {
            let path = dir.join("custom_web_panels.json");
            std::fs::write(&path, "{not json").expect("write garbage");
            let error = panels(None).expect_err("corrupt store must fail the list");
            assert!(
                error.contains(path.display().to_string().as_str()),
                "the error must name the path so a human can delete it: {error}"
            );
            assert!(add_entry(None, "Wiki", "https://wiki.example/").is_err());
            assert!(remove_entry(None, "site-1").is_err());
            // Sticky: even after the file is fixed, the run stays failed
            // (restart is the recovery path).
            std::fs::write(&path, "{}").expect("write empty object");
            assert!(panels(None).is_err());
        });
    }

    #[test]
    fn corrupt_store_entries_fail_closed() {
        for raw in [
            // Wrong version.
            r#"{"version":2,"next_id":1,"entries":[]}"#,
            // Hand-edited http url.
            r#"{"version":1,"next_id":2,"entries":[{"id":"site-1","label":"A","url":"http://a.example/"}]}"#,
            // Bad id shape.
            r#"{"version":1,"next_id":2,"entries":[{"id":"files","label":"A","url":"https://a.example/"}]}"#,
            // Duplicate urls.
            r#"{"version":1,"next_id":3,"entries":[{"id":"site-1","label":"A","url":"https://a.example/"},{"id":"site-2","label":"B","url":"https://a.example/"}]}"#,
            // next_id would reuse site-1.
            r#"{"version":1,"next_id":1,"entries":[{"id":"site-1","label":"A","url":"https://a.example/"}]}"#,
            // Unnormalized (fragment) url on disk.
            r#"{"version":1,"next_id":2,"entries":[{"id":"site-1","label":"A","url":"https://a.example/#f"}]}"#,
        ] {
            with_store(|dir| {
                std::fs::write(dir.join("custom_web_panels.json"), raw).expect("write fixture");
                assert!(
                    panels(None).is_err(),
                    "store fixture must fail closed: {raw}"
                );
            });
        }
    }

    #[test]
    fn find_entry_resolves_known_and_unknown_ids() {
        with_store(|_| {
            add(None, "Wiki", "https://wiki.example/");
            let found = find_entry(None, "site-1").expect("lookup succeeds");
            assert_eq!(found.expect("site-1 present").url, "https://wiki.example/");
            assert!(find_entry(None, "site-9")
                .expect("lookup succeeds")
                .is_none());
        });
    }

    #[test]
    fn add_from_a_non_add_window_caller_is_refused() {
        // THE caller gate: only the bundled add window may supply a URL.
        // "main" is exactly what a compromised app webview would call from;
        // panel children and login companions use other labels.
        for caller in [
            "main",
            "webpanel-files-1",
            "webpanel-login-files",
            "webpanel-add-typo",
            "",
        ] {
            assert!(
                validate_add_caller(caller).is_err(),
                "caller {caller:?} must be refused"
            );
        }
        assert!(validate_add_caller(WEBPANEL_ADD_WINDOW_LABEL).is_ok());
        // Even an otherwise-valid payload from a wrong caller is refused —
        // and never reaches the store.
        with_store(|_| {
            assert!(
                validate_add_request("main", "Wiki", "https://wiki.example/").is_err(),
                "a valid payload must still be refused from the main webview"
            );
            assert!(
                panels(None).expect("list succeeds").is_empty(),
                "a refused add must not persist anything"
            );
            // The trusted caller with the same payload validates.
            assert!(
                validate_add_request(WEBPANEL_ADD_WINDOW_LABEL, "Wiki", "https://wiki.example/")
                    .is_ok()
            );
        });
    }

    #[test]
    fn add_request_validation_runs_the_gate_before_the_payload_rules() {
        // A garbage payload from a wrong caller must surface the CALLER
        // error, not a label/url error — the gate is first, so nothing
        // about the payload is even considered for a foreign webview.
        let error = validate_add_request("main", "", "not a url").expect_err("refused");
        assert!(
            error.contains("add window"),
            "the caller-gate error must fire first, got: {error}"
        );
    }
}
