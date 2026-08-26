//! Login companion windows for the config-driven web panels.
//!
//! All webviews in this app share one cookie jar (a single
//! `WKWebsiteDataStore` on macOS — wry #1198), which is what lets a docked
//! panel iframe reuse a session. GitHub OAuth refuses to run inside iframes,
//! so the panel's header exposes a login button that opens the panel URL in
//! this real window instead; completing OAuth there lands the cookies in the
//! shared jar, and the panel's reload button re-mounts the iframe to pick
//! them up.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Open (or focus) the login companion window for a web panel.
///
/// The frontend passes the panel's compile-time URL from its config; the
/// command re-validates the scheme so only https panel URLs can ever reach
/// the builder. One window per panel id: re-invoking the command focuses the
/// existing hop instead of stacking windows.
#[tauri::command]
pub fn open_web_panel_login(
    app: tauri::AppHandle,
    panel_id: String,
    url: String,
    title: String,
) -> Result<(), String> {
    let url: tauri::Url = url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    if url.scheme() != "https" {
        return Err("web panel login requires an https url".into());
    }
    let label = format!("webpanel-login-{panel_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    // Dropping the returned handle does not close the window — Tauri owns
    // it, and the user closes it when the login hop is done.
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(&title)
        .inner_size(900.0, 700.0)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}
