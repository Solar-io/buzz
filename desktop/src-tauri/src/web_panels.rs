//! Native child webviews + login companion windows for the config-driven
//! web panels.
//!
//! All webviews in this app share one cookie jar (a single
//! `WKWebsiteDataStore` on macOS — wry #1198). Third-party iframes cannot
//! reliably hold auth cookies in WKWebView (Storage Access flakiness), so a
//! panel renders NATIVELY by default: a child webview of the main window,
//! overlaid on the dock area, getting first-party cookie treatment in that
//! shared store. Iframe mode stays available as a per-panel config fallback.
//!
//! The dock is tabbed: each tab is a panel *instance* (`{panelId}-{seq}`).
//! Only the active instance's webview is visible; the others are hidden but
//! kept alive for instant, state-preserving tab switches. Live webviews are
//! capped on the frontend (`MAX_PANEL_INSTANCES`), because each one is a
//! full WKWebView session.
//!
//! The frontend sends only ids and geometry: URLs and window titles never
//! cross the IPC boundary, so nothing running in the app webview can point a
//! trusted app window at an arbitrary address. Navigation inside a panel
//! webview is pinned to the panel's own origin plus the OAuth hop hosts;
//! everything else is refused (fail closed).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::{
    LogicalPosition, LogicalSize, Manager, Rect, WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
    Window,
};

/// Destroyed instance ids. `ensure` arriving for a tombstoned instance is
/// refused: commands are dispatched concurrently, so an `ensure` sent just
/// before a dock close can otherwise land after the `destroy` and resurrect
/// a webview nobody is tracking. Instance ids never repeat (monotonic
/// sequence), so tombstones are permanent for the app run.
fn tombstones() -> &'static Mutex<HashSet<String>> {
    static TOMBSTONES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    TOMBSTONES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_tombstoned(instance_id: &str) -> bool {
    tombstones()
        .lock()
        .map(|tombstones| tombstones.contains(instance_id))
        .unwrap_or(false)
}

fn mark_tombstoned(instance_id: &str) {
    if let Ok(mut tombstones) = tombstones().lock() {
        tombstones.insert(instance_id.to_string());
    }
}

/// Serializes webview creation/mutation. `add_child` builds on the main
/// thread while this thread blocks on it; two overlapping `ensure` calls
/// for the same instance could otherwise both see "absent" and race to
/// create the same label.
fn panel_webview_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Compile-time registry of panel TYPES: `(panel_id, login_title, url)`.
/// This is the Rust-side mirror of
/// `desktop/src/features/webPanels/webPanels.config.ts` — the origin-sync
/// tests in both languages fail the build if the two tables drift.
const PANEL_TYPES: &[(&str, &str, &str)] = &[(
    "files",
    "Files login",
    "https://crichton.tailb3d4b8.ts.net:6201/?panel=files",
)];

/// Hosts a panel webview may navigate to beyond its own origin: the
/// Supabase tenant and GitHub, which is the full path of the login hop.
/// Only over default-port https.
const OAUTH_HOP_HOSTS: &[&str] = &[
    "hbhzejujnfljpkbyuwuk.supabase.co",
    "github.com",
    "accounts.github.com",
];

/// Child webview label for a panel instance. Labels are global across the
/// app, so instance ids must be unique — the frontend derives them from a
/// monotonic sequence.
fn webpanel_label(instance_id: &str) -> String {
    format!("webpanel-{instance_id}")
}

/// A panel instance id must be `{panel_id}-{ascii digits}` so a label can
/// never smuggle surprises into the webview registry.
fn validate_instance_id(instance_id: &str, panel_id: &str) -> Result<(), String> {
    let seq = instance_id
        .strip_prefix(panel_id)
        .and_then(|rest| rest.strip_prefix('-'))
        .ok_or_else(|| format!("instance id {instance_id:?} is not {panel_id}-<seq>"))?;
    if seq.is_empty() || seq.len() > 10 || !seq.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("invalid instance id sequence: {instance_id:?}"));
    }
    Ok(())
}

/// Resolve a panel type id to its login title and URL. Unknown ids are an
/// error, never a fallback or pass-through.
fn resolve_panel_type(panel_id: &str) -> Result<(&'static str, tauri::Url), String> {
    let (_, title, url) = PANEL_TYPES
        .iter()
        .find(|(known_id, _, _)| *known_id == panel_id)
        .ok_or_else(|| format!("unknown web panel: {panel_id}"))?;
    let url: tauri::Url = url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    require_https(&url)?;
    Ok((title, url))
}

/// Defense-in-depth on the table's own values: a panel must never be built
/// from anything but an https URL.
fn require_https(url: &tauri::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!(
            "web panel requires an https url, got {}",
            url.scheme()
        ));
    }
    Ok(())
}

/// The navigation policy for a panel webview: allow exactly the panel's own
/// origin (scheme+host+port) and the OAuth hop hosts over default-port
/// https. Unparseable or non-https URLs are refused — fail closed, because
/// a panel webview is a top-level browsing context with the shared cookie
/// jar attached.
fn is_navigation_allowed(url: &tauri::Url, panel_url: &tauri::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    // Exact scheme+host+port match against the panel's own origin (url's
    // port() normalizes an explicit :443 to None, so this compares origins,
    // not spellings).
    if host == panel_url.host_str().unwrap_or_default() && url.port() == panel_url.port() {
        return true;
    }
    // OAuth hops only over default-port https.
    OAUTH_HOP_HOSTS.contains(&host) && url.port().is_none()
}

/// Validate frontend-supplied geometry and turn it into a logical rect.
/// JS `getBoundingClientRect` yields CSS px, which equal Tauri logical px.
/// Rejects non-finite, negative, or vanishing rects instead of clamping:
/// a half-initialized layout should surface, not quietly pin a webview to
/// the window corner.
fn panel_rect(x: f64, y: f64, width: f64, height: f64) -> Result<Rect, String> {
    for (name, value) in [("x", x), ("y", y), ("width", width), ("height", height)] {
        if !value.is_finite() {
            return Err(format!("web panel rect {name} must be finite, got {value}"));
        }
    }
    if x < 0.0 || y < 0.0 {
        return Err(format!(
            "web panel rect origin must be >= 0, got ({x}, {y})"
        ));
    }
    if width < 1.0 || height < 1.0 {
        return Err(format!(
            "web panel rect must be at least 1x1 logical px, got {width}x{height}"
        ));
    }
    Ok(Rect {
        position: tauri::Position::Logical(LogicalPosition::new(x, y)),
        size: tauri::Size::Logical(LogicalSize::new(width, height)),
    })
}

/// Everything `ensure_web_panel` needs after validating a request.
struct EnsureRequest {
    label: String,
    url: tauri::Url,
    rect: Rect,
}

/// Pure-ish validation for an ensure request: known panel type, well-formed
/// instance id, sane geometry, not previously destroyed. Split out so the
/// fail-closed rules are unit-testable without a Tauri app.
fn validate_ensure_request(
    instance_id: &str,
    panel_id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<EnsureRequest, String> {
    let (_, url) = resolve_panel_type(panel_id)?;
    validate_instance_id(instance_id, panel_id)?;
    let rect = panel_rect(x, y, width, height)?;
    if is_tombstoned(instance_id) {
        return Err(format!("web panel instance {instance_id} was destroyed"));
    }
    Ok(EnsureRequest {
        label: webpanel_label(instance_id),
        url,
        rect,
    })
}

/// Idempotently place a panel instance's child webview at a logical rect in
/// the invoking webview's window, showing it. Creates the webview on first
/// call for an instance; later calls reposition it (dock resize, maximize,
/// window resize). Inactive sibling instances are NOT touched — the
/// frontend hides them via `set_web_panel_visible`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ensure_web_panel(
    webview: tauri::Webview,
    instance_id: String,
    panel_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let request = validate_ensure_request(&instance_id, &panel_id, x, y, width, height)?;
    let EnsureRequest { label, url, rect } = request;
    let tauri::Position::Logical(position) = rect.position else {
        unreachable!("panel_rect only builds logical positions");
    };
    let tauri::Size::Logical(size) = rect.size else {
        unreachable!("panel_rect only builds logical sizes");
    };

    let _guard = panel_webview_lock()
        .lock()
        .map_err(|_| "web panel lock poisoned")?;
    let window: Window = webview.window().clone();
    if let Some(child) = webview.get_webview(&label) {
        child.set_bounds(rect).map_err(|error| error.to_string())?;
        child.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let panel_url = url.clone();
    let builder =
        WebviewBuilder::new(label.clone(), WebviewUrl::External(url)).on_navigation(move |url| {
            let allowed = is_navigation_allowed(url, &panel_url);
            // Ops log: one line per navigation attempt, including blocked
            // ones — the only observable trace of the panel's nav policy.
            println!(
                "webpanel {label}: navigation {} -> {url}",
                if allowed { "ALLOW" } else { "BLOCK" }
            );
            allowed
        });

    window
        .add_child(builder, position, size)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Show or hide a panel instance's webview. Hiding keeps the webview (and
/// its session state) alive — that is the point of tabs. Hiding an absent
/// webview is fine; showing one that was never created is an error.
#[tauri::command]
pub fn set_web_panel_visible(
    webview: tauri::Webview,
    instance_id: String,
    panel_id: String,
    visible: bool,
) -> Result<(), String> {
    validate_instance_id(&instance_id, &panel_id)?;
    let label = webpanel_label(&instance_id);
    if is_tombstoned(&instance_id) {
        // Racing a destroy from the same close path — nothing left to show
        // or hide, and no error to surface.
        return Ok(());
    }
    let Some(child) = webview.get_webview(&label) else {
        if visible {
            return Err(format!("webview {label} does not exist; ensure it first"));
        }
        return Ok(());
    };
    if visible { child.show() } else { child.hide() }.map_err(|error| error.to_string())
}

/// Destroy a panel instance's webview and release its WKWebView session.
/// Used when a tab is closed or the whole dock closes — hidden-but-kept
/// tabs are the only webviews that persist.
#[tauri::command]
pub fn destroy_web_panel(
    webview: tauri::Webview,
    instance_id: String,
    panel_id: String,
) -> Result<(), String> {
    validate_instance_id(&instance_id, &panel_id)?;
    let label = webpanel_label(&instance_id);
    mark_tombstoned(&instance_id);
    let _guard = panel_webview_lock()
        .lock()
        .map_err(|_| "web panel lock poisoned")?;
    match webview.get_webview(&label) {
        Some(child) => child.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Reload a panel instance's webview in place (`location.reload()` keeps
/// the origin, so the navigation policy allows it).
#[tauri::command]
pub fn reload_web_panel(
    webview: tauri::Webview,
    instance_id: String,
    panel_id: String,
) -> Result<(), String> {
    validate_instance_id(&instance_id, &panel_id)?;
    let label = webpanel_label(&instance_id);
    if is_tombstoned(&instance_id) {
        return Ok(());
    }
    let child = webview
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} does not exist; ensure it first"))?;
    child
        .eval("location.reload()")
        .map_err(|error| error.to_string())
}

/// Open (or focus) the login companion window for a panel type. One window
/// per panel id: re-invoking the command focuses the existing hop instead of
/// stacking windows. OAuth refuses to run in anything but a real window, so
/// the header's login button routes through here; the resulting cookies land
/// in the shared jar for both the native panel webview and iframe fallback.
#[tauri::command]
pub fn open_web_panel_login(app: tauri::AppHandle, panel_id: String) -> Result<(), String> {
    let (title, url) = resolve_panel_type(&panel_id)?;
    let label = format!("webpanel-login-{panel_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    // Dropping the returned handle does not close the window — Tauri owns
    // it, and the user closes it when the login hop is done.
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(900.0, 700.0)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_files_panel_login_window() {
        let (title, url) = resolve_panel_type("files").expect("files is registered");
        assert_eq!(title, "Files login");
        assert_eq!(
            url.as_str(),
            "https://crichton.tailb3d4b8.ts.net:6201/?panel=files"
        );
    }

    #[test]
    fn unknown_panel_ids_are_rejected_without_fallback() {
        // A URL-shaped id must not pass through as a URL either.
        for bad in ["notes", "", "https://evil.example"] {
            assert!(
                resolve_panel_type(bad).is_err(),
                "panel id {bad:?} must not resolve"
            );
        }
    }

    #[test]
    fn non_https_urls_are_refused() {
        let http: tauri::Url = "http://crichton.tailb3d4b8.ts.net:6201/"
            .parse()
            .expect("fixture url parses");
        assert!(require_https(&http).is_err());
        let https: tauri::Url = "https://crichton.tailb3d4b8.ts.net:6201/"
            .parse()
            .expect("fixture url parses");
        assert!(require_https(&https).is_ok());
    }

    #[test]
    fn instance_ids_must_be_panel_id_plus_digit_sequence() {
        assert!(validate_instance_id("files-0", "files").is_ok());
        assert!(validate_instance_id("files-42", "files").is_ok());
        for bad in [
            "files",
            "files-",
            "files-x",
            "files-1-2",
            "notes-1",
            "",
            "files-99999999999999999999",
        ] {
            assert!(
                validate_instance_id(bad, "files").is_err(),
                "instance id {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn webview_labels_are_namespaced_per_instance() {
        assert_eq!(webpanel_label("files-0"), "webpanel-files-0");
    }

    fn panel_url() -> tauri::Url {
        "https://crichton.tailb3d4b8.ts.net:6201/?panel=files"
            .parse()
            .expect("fixture url parses")
    }

    #[test]
    fn navigation_allows_the_panel_origin_exactly() {
        let panel = panel_url();
        for allowed in [
            "https://crichton.tailb3d4b8.ts.net:6201/?panel=files",
            "https://crichton.tailb3d4b8.ts.net:6201/auth/callback?code=x",
            "https://crichton.tailb3d4b8.ts.net:6201",
        ] {
            let url: tauri::Url = allowed.parse().expect("fixture url parses");
            assert!(
                is_navigation_allowed(&url, &panel),
                "{allowed} must be allowed"
            );
        }
    }

    #[test]
    fn navigation_allows_the_oauth_hop_hosts_over_default_https() {
        let panel = panel_url();
        for allowed in [
            "https://hbhzejujnfljpkbyuwuk.supabase.co/auth/v1/authorize?provider=github",
            "https://github.com/login/oauth/authorize",
            "https://accounts.github.com/session",
        ] {
            let url: tauri::Url = allowed.parse().expect("fixture url parses");
            assert!(
                is_navigation_allowed(&url, &panel),
                "{allowed} must be allowed"
            );
        }
    }

    #[test]
    fn navigation_blocks_foreign_origins_and_failures() {
        let panel = panel_url();
        for blocked in [
            // Foreign hosts.
            "https://evil.example/",
            "https://github.com.evil.example/",
            "https://crichton.tailb3d4b8.ts.net:6202/",
            "https://other.supabase.co/",
            // Non-https schemes.
            "http://crichton.tailb3d4b8.ts.net:6201/",
            "http://github.com/",
            "about:blank",
            "data:text/html,hello",
            "blob:https://crichton.tailb3d4b8.ts.net:6201/x",
            "file:///etc/passwd",
            // OAuth hosts on non-default ports.
            "https://github.com:8443/",
        ] {
            let Ok(url) = blocked.parse::<tauri::Url>() else {
                // A URL so broken it cannot even parse must be denied at the
                // call site (on_navigation hands us a parsed Url; parse
                // failures never reach the panel webview).
                continue;
            };
            assert!(
                !is_navigation_allowed(&url, &panel),
                "{blocked} must be blocked"
            );
        }
        // A URL with no host is structurally denied too.
        let no_host: tauri::Url = "data:text/plain,1".parse().expect("fixture parses");
        assert!(!is_navigation_allowed(&no_host, &panel));
    }

    #[test]
    fn rect_geometry_accepts_finite_positive_rects() {
        let rect = panel_rect(12.0, 340.5, 800.0, 320.0).expect("valid rect");
        let tauri::Position::Logical(position) = rect.position else {
            panic!("rect must be logical");
        };
        let tauri::Size::Logical(size) = rect.size else {
            panic!("rect must be logical");
        };
        assert_eq!(position.x, 12.0);
        assert_eq!(position.y, 340.5);
        assert_eq!(size.width, 800.0);
        assert_eq!(size.height, 320.0);
    }

    #[test]
    fn rect_geometry_rejects_broken_input() {
        for (x, y, w, h) in [
            (f64::NAN, 0.0, 100.0, 100.0),
            (0.0, f64::INFINITY, 100.0, 100.0),
            (-1.0, 0.0, 100.0, 100.0),
            (0.0, -0.5, 100.0, 100.0),
            (0.0, 0.0, 0.0, 100.0),
            (0.0, 0.0, 100.0, 0.5),
        ] {
            assert!(
                panel_rect(x, y, w, h).is_err(),
                "rect ({x},{y},{w},{h}) must be rejected"
            );
        }
    }

    #[test]
    fn rust_panel_table_matches_the_typescript_config_source() {
        // The TS config is the editing surface; this fails the Rust suite
        // the moment someone adds a panel there without mirroring it here.
        let ts_source = include_str!("../../src/features/webPanels/webPanels.config.ts");
        for (id, _title, url) in PANEL_TYPES {
            let id_line = format!("id: \"{id}\",");
            let url_line = format!("url: \"{url}\",");
            assert!(
                ts_source.contains(&id_line),
                "panel id {id} missing from webPanels.config.ts"
            );
            assert!(
                ts_source.contains(&url_line),
                "panel url {url} missing from webPanels.config.ts"
            );
        }
    }

    #[test]
    fn oauth_hop_hosts_carry_no_port_tricks() {
        assert!(!OAUTH_HOP_HOSTS.iter().any(|h| h.contains(':')));
    }

    #[test]
    fn ensure_refuses_tombstoned_instances() {
        // Destroy is what tombstones; simulate a destroy racing an in-flight
        // ensure for the same instance.
        let unique = format!("files-{}", line!());
        let request = validate_ensure_request(&unique, "files", 0.0, 0.0, 100.0, 100.0);
        assert!(request.is_ok(), "fresh instance must validate");
        mark_tombstoned(&unique);
        let raced = validate_ensure_request(&unique, "files", 0.0, 0.0, 100.0, 100.0);
        assert!(
            raced.is_err(),
            "ensure after destroy must not resurrect the webview"
        );
    }

    #[test]
    fn ensure_validation_covers_all_fail_closed_rules() {
        // Unknown panel type.
        assert!(validate_ensure_request("notes-1", "notes", 0.0, 0.0, 10.0, 10.0).is_err());
        // Malformed instance id.
        assert!(validate_ensure_request("files-x", "files", 0.0, 0.0, 10.0, 10.0).is_err());
        // Broken geometry.
        assert!(validate_ensure_request("files-1", "files", f64::NAN, 0.0, 10.0, 10.0).is_err());
        // Happy path carries label + url + logical rect.
        let request = validate_ensure_request("files-9", "files", 4.0, 300.0, 800.0, 320.0)
            .expect("valid request");
        assert_eq!(request.label, "webpanel-files-9");
        assert_eq!(
            request.url.as_str(),
            "https://crichton.tailb3d4b8.ts.net:6201/?panel=files"
        );
    }
}
