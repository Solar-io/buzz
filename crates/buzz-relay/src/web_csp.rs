//! Content-Security-Policy for the public web client's HTML document.
//!
//! The web client renders agent-authored content and (from phase 7) hosts an
//! in-browser Terminal, so an XSS there reaches a shell. This policy is the
//! second wall: even if markup slips past the renderer, an injected inline
//! script does not run and cannot ship data to an origin the app never talks
//! to.
//!
//! The allowlist was inventoried from the web client's code (2026-09-30):
//!
//! * `script-src 'self' blob: 'wasm-unsafe-eval'` — the bundle and the
//!   vendored xterm scripts are same-origin. `blob:` is the AudioWorklet
//!   module the huddle and dictation build with `URL.createObjectURL`
//!   (worklets are governed by `script-src`); only already-running script can
//!   mint a blob URL, so it opens no injection path. `'wasm-unsafe-eval'` is
//!   shiki's Oniguruma regex engine (code-block highlighting); it permits
//!   WebAssembly compilation only, never JS `eval`.
//! * `connect-src` — the relay socket (`'self'` plus explicit `ws(s)://` of
//!   the page host, because `'self'` matching `wss:` is CSP3-only), the
//!   relay host's service ports ([`DEFAULT_SAME_HOST_PORTS`]), and the few
//!   fixed foreign origins ([`DEFAULT_CONNECT_ORIGINS`]).
//! * `frame-src 'self' blob: https:` — Web panels are user-added URLs kept in
//!   each browser's localStorage, so the relay cannot enumerate them. `https:`
//!   is the narrowest rule that keeps them working; it still excludes
//!   `data:`, `javascript:`, `http:` (already mixed content) and `blob:` from
//!   other origins. Every panel frame stays sandbox/same-origin isolated by
//!   the browser's normal origin rules.
//! * `img-src` / `media-src` include `https:` — link-preview images, profile
//!   pictures and GIF tiles come from arbitrary hosts. Images and media are
//!   passive content; the exfiltration channel that matters is
//!   `connect-src`, which stays an explicit allowlist.
//! * `style-src 'unsafe-inline'` — runtime `<style>` injection (toasts,
//!   theme variables). Styles cannot execute script.

use axum::http::{HeaderMap, HeaderValue};

/// Ports on the relay's own host that the web client reaches over
/// https/wss (infra/port-registry.json, block "buzz"/"stash"/"hatch"):
/// push gateway 6359, STT bridge 6361, TTS bridge 6366, summary bridge 6368,
/// changelog/tracker sidecar 6451, Files panel 6831, hatch (Terminal) 6881.
pub const DEFAULT_SAME_HOST_PORTS: &[u16] = &[6359, 6361, 6366, 6368, 6451, 6831, 6881];

/// Fixed foreign origins the web client fetches: usage-hub (pace + runway,
/// `web/src/features/usage/lib/usageHub.ts`) and the GitHub releases API
/// (`web/src/shared/lib/buzz-download.ts`).
pub const DEFAULT_CONNECT_ORIGINS: &[&str] = &[
    "https://pilot.tailb3d4b8.ts.net:6770",
    "https://api.github.com",
];

/// Deployment knobs for the web client's CSP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebCspConfig {
    /// Ports on the page's own host whose `https://` and `wss://` origins are
    /// added to `connect-src` (`BUZZ_WEB_CSP_SAME_HOST_PORTS`).
    pub same_host_ports: Vec<u16>,
    /// Extra absolute origins for `connect-src`
    /// (`BUZZ_WEB_CSP_CONNECT_ORIGINS`).
    pub connect_origins: Vec<String>,
}

impl Default for WebCspConfig {
    fn default() -> Self {
        Self {
            same_host_ports: DEFAULT_SAME_HOST_PORTS.to_vec(),
            connect_origins: DEFAULT_CONNECT_ORIGINS
                .iter()
                .map(|origin| (*origin).to_string())
                .collect(),
        }
    }
}

impl WebCspConfig {
    /// Parse from the two optional env values (whitespace- or
    /// comma-separated). An unset variable keeps its default; a set-but-empty
    /// one means "none".
    pub fn from_values(ports: Option<&str>, origins: Option<&str>) -> Result<Self, String> {
        let mut config = Self::default();
        if let Some(raw) = ports {
            config.same_host_ports = split_list(raw)
                .map(|item| {
                    item.parse::<u16>()
                        .ok()
                        .filter(|port| *port != 0)
                        .ok_or_else(|| {
                            format!("BUZZ_WEB_CSP_SAME_HOST_PORTS: invalid port {item:?}")
                        })
                })
                .collect::<Result<_, _>>()?;
        }
        if let Some(raw) = origins {
            config.connect_origins = split_list(raw)
                .map(|item| {
                    if is_valid_origin(item) {
                        Ok(item.to_string())
                    } else {
                        Err(format!(
                            "BUZZ_WEB_CSP_CONNECT_ORIGINS: {item:?} is not an https/wss origin"
                        ))
                    }
                })
                .collect::<Result<_, _>>()?;
        }
        Ok(config)
    }

    /// Read `BUZZ_WEB_CSP_SAME_HOST_PORTS` / `BUZZ_WEB_CSP_CONNECT_ORIGINS`.
    pub fn from_env() -> Result<Self, String> {
        let ports = std::env::var("BUZZ_WEB_CSP_SAME_HOST_PORTS").ok();
        let origins = std::env::var("BUZZ_WEB_CSP_CONNECT_ORIGINS").ok();
        Self::from_values(ports.as_deref(), origins.as_deref())
    }

    /// The policy for a web-client document requested with `host` (the raw
    /// `Host` header). A host that is not a plain `name[:port]` contributes
    /// nothing — the policy then falls back to `'self'` for the relay — so a
    /// forged header cannot splice directives into the policy.
    pub fn policy_for_host(&self, host: Option<&str>) -> String {
        let mut connect = vec!["'self'".to_string()];
        if let Some(host) = host.filter(|value| is_valid_host(value)) {
            connect.push(format!("wss://{host}"));
            connect.push(format!("ws://{host}"));
            let name = host_name(host);
            for port in &self.same_host_ports {
                connect.push(format!("https://{name}:{port}"));
                connect.push(format!("wss://{name}:{port}"));
            }
        }
        connect.extend(self.connect_origins.iter().cloned());

        [
            "default-src 'self'".to_string(),
            "script-src 'self' blob: 'wasm-unsafe-eval'".to_string(),
            "worker-src 'self' blob:".to_string(),
            "style-src 'self' 'unsafe-inline'".to_string(),
            "img-src 'self' data: blob: https:".to_string(),
            "media-src 'self' data: blob: https:".to_string(),
            "font-src 'self' data:".to_string(),
            format!("connect-src {}", connect.join(" ")),
            "frame-src 'self' blob: https:".to_string(),
            "manifest-src 'self'".to_string(),
            "object-src 'none'".to_string(),
            "base-uri 'none'".to_string(),
            "form-action 'self'".to_string(),
            "frame-ancestors 'self'".to_string(),
        ]
        .join("; ")
    }

    /// Stamp the policy onto a web-client HTML response.
    pub fn apply(&self, request_headers: &HeaderMap, response: &mut axum::response::Response) {
        let host = request_headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok());
        // The policy is built only from validated tokens, so this cannot fail;
        // if it ever did, fall back to the host-free policy rather than ship
        // the document without one.
        let value = HeaderValue::from_str(&self.policy_for_host(host))
            .or_else(|_| HeaderValue::from_str(&self.policy_for_host(None)));
        if let Ok(value) = value {
            response
                .headers_mut()
                .insert(axum::http::header::CONTENT_SECURITY_POLICY, value);
        }
    }
}

fn split_list(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

/// `name[:port]` with DNS-label characters only. IPv6 literals are refused
/// (the relay is addressed by name), which simply drops the host-derived
/// sources.
fn is_valid_host(host: &str) -> bool {
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    let name_ok = !name.is_empty()
        && name.len() <= 253
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    let port_ok = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|p| p != 0));
    name_ok && port_ok
}

fn host_name(host: &str) -> &str {
    host.rsplit_once(':').map_or(host, |(name, _)| name)
}

fn is_valid_origin(origin: &str) -> bool {
    ["https://", "wss://"]
        .iter()
        .any(|scheme| origin.strip_prefix(scheme).is_some_and(is_valid_host))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "crichton.tailb3d4b8.ts.net:6351";

    fn directive<'a>(policy: &'a str, name: &str) -> &'a str {
        policy
            .split("; ")
            .find(|part| part.split(' ').next() == Some(name))
            .unwrap_or_else(|| panic!("{name} missing from {policy}"))
    }

    #[test]
    fn script_src_has_no_inline_or_eval() {
        let policy = WebCspConfig::default().policy_for_host(Some(HOST));
        assert_eq!(
            directive(&policy, "script-src"),
            "script-src 'self' blob: 'wasm-unsafe-eval'"
        );
        assert!(!policy.contains("'unsafe-eval'"));
        assert_eq!(
            policy.matches("'unsafe-inline'").count(),
            1,
            "unsafe-inline only in style-src: {policy}"
        );
        assert_eq!(
            directive(&policy, "frame-ancestors"),
            "frame-ancestors 'self'"
        );
        assert_eq!(directive(&policy, "object-src"), "object-src 'none'");
    }

    #[test]
    fn connect_src_lists_relay_services_and_fixed_origins() {
        let connect = directive(
            &WebCspConfig::default().policy_for_host(Some(HOST)),
            "connect-src",
        )
        .to_string();
        for source in [
            "'self'",
            "wss://crichton.tailb3d4b8.ts.net:6351",
            "wss://crichton.tailb3d4b8.ts.net:6361",
            "https://crichton.tailb3d4b8.ts.net:6366",
            "https://crichton.tailb3d4b8.ts.net:6368",
            "https://crichton.tailb3d4b8.ts.net:6881",
            "wss://crichton.tailb3d4b8.ts.net:6881",
            "https://pilot.tailb3d4b8.ts.net:6770",
            "https://api.github.com",
        ] {
            assert!(
                connect.split(' ').any(|token| token == source),
                "{source} missing from {connect}"
            );
        }
        assert!(!connect.split(' ').any(|t| t == "https:" || t == "*"));
    }

    #[test]
    fn forged_host_cannot_inject_directives() {
        let config = WebCspConfig::default();
        let forged = config.policy_for_host(Some("evil.com; script-src *"));
        assert_eq!(forged, config.policy_for_host(None));
        assert!(!forged.contains("evil.com"));
        assert!(!config.policy_for_host(Some("a b")).contains("a b"));
        assert!(!config.policy_for_host(Some("host:99999")).contains("host:"));
    }

    #[test]
    fn env_values_override_and_validate() {
        let config = WebCspConfig::from_values(Some("7000, 7001"), Some("https://x.example:1"))
            .expect("valid");
        assert_eq!(config.same_host_ports, vec![7000, 7001]);
        assert_eq!(config.connect_origins, vec!["https://x.example:1"]);
        let empty = WebCspConfig::from_values(Some(""), Some("")).expect("valid");
        assert!(empty.same_host_ports.is_empty() && empty.connect_origins.is_empty());
        assert!(WebCspConfig::from_values(Some("nope"), None).is_err());
        assert!(WebCspConfig::from_values(None, Some("https://x/;")).is_err());
        assert!(WebCspConfig::from_values(None, Some("javascript:alert(1)")).is_err());
        assert_eq!(
            WebCspConfig::from_values(None, None).expect("defaults"),
            WebCspConfig::default()
        );
    }
}
