//! Login companion windows for the config-driven web panels.
//!
//! All webviews in this app share one cookie jar (a single
//! `WKWebsiteDataStore` on macOS — wry #1198), which is what lets a docked
//! panel iframe reuse a session. GitHub OAuth refuses to run inside iframes,
//! so the panel's header exposes a login button that opens the panel URL in
//! this real window instead; completing OAuth there lands the cookies in the
//! shared jar, and the panel's reload button re-mounts the iframe to pick
//! them up.
//!
//! The frontend sends only a panel id: URLs and window titles never cross
//! the IPC boundary, so nothing running in the app webview can point a
//! trusted app window at an arbitrary address.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Compile-time registry of panels that may open a login companion window:
/// `(panel_id, window_title, url)`. This is the Rust-side mirror of
/// `desktop/src/features/webPanels/webPanels.config.ts` — keep both lists in
/// sync when a panel is added.
const LOGIN_PANELS: &[(&str, &str, &str)] = &[(
    "files",
    "Files login",
    "https://crichton.tailb3d4b8.ts.net:6201/?panel=files",
)];

/// Resolve a panel id to its login window title and URL. Unknown ids are an
/// error, never a fallback or pass-through.
fn resolve_login_panel(panel_id: &str) -> Result<(&'static str, tauri::Url), String> {
    let (_, title, url) = LOGIN_PANELS
        .iter()
        .find(|(known_id, _, _)| *known_id == panel_id)
        .ok_or_else(|| format!("unknown web panel: {panel_id}"))?;
    let url: tauri::Url = url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    require_https(&url)?;
    Ok((title, url))
}

/// Defense-in-depth on the table's own values: a login window must never be
/// built from anything but an https URL.
fn require_https(url: &tauri::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!(
            "web panel login requires an https url, got {}",
            url.scheme()
        ));
    }
    Ok(())
}

/// Open (or focus) the login companion window for a web panel. One window
/// per panel id: re-invoking the command focuses the existing hop instead of
/// stacking windows.
#[tauri::command]
pub fn open_web_panel_login(app: tauri::AppHandle, panel_id: String) -> Result<(), String> {
    let (title, url) = resolve_login_panel(&panel_id)?;
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
        let (title, url) = resolve_login_panel("files").expect("files is registered");
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
                resolve_login_panel(bad).is_err(),
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
}
