/**
 * Same-origin rewrite for already-posted docs links.
 *
 * The relay serves the changelog/tracker sidecar (:6451) and the Daily
 * Edition (:6450) under a strict-allowlist reverse proxy that MIRRORS the
 * upstream paths (`:6351/changelog.md` proxies `:6451/changelog.md`), so an
 * upstream link stays working after a pure `scheme://host:port` swap to the
 * relay origin. Anything pointing at the relay origin itself must render in
 * the in-app viewer rather than open a cross-origin tab — a cross-origin
 * tab is exactly what makes the installed app grow browser chrome.
 *
 * The check is keyed on `relayBase` (the configured relay), never on
 * `location`: the SPA may run on a different origin than the relay it talks
 * to, and the rewrite must follow the relay either way.
 */

/** Upstream ports the relay's docs proxy fronts. */
const DOCS_PROXY_PORTS = new Set(["6451", "6450"]);

/**
 * The exact served set — the mirror of the relay's allowlist (see the
 * relay's `docs_proxy_target`). `/changelog` is kept as-is: the relay
 * canonicalizes the extensionless form upstream.
 */
const DOCS_PROXY_PATHS = new Set([
  "/changelog",
  "/changelog.md",
  "/CHANGELOG.md",
  "/tracker",
  "/tracker.html",
  "/tracker.json",
  "/tracker/",
]);

/**
 * The `/edition/{rest}` shape the relay serves — the TS mirror of the
 * relay's `docs_edition_rest_is_safe`: non-empty remainder, no `..`, no
 * empty segments. Keep the two in sync.
 */
function editionPathIsServed(pathname: string): boolean {
  if (!pathname.startsWith("/edition/")) {
    return false;
  }
  const rest = pathname.slice("/edition/".length);
  return (
    rest.length > 0 && !rest.includes("..") && rest.split("/").every(Boolean)
  );
}

/**
 * Rewrite an already-posted docs link to its same-origin relay path, or
 * return null when it is not a docs link the relay serves (different host,
 * different port, or a path outside the served set).
 */
export function resolveDocHref(href: string, relayBase: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href, relayBase);
    base = new URL(relayBase);
  } catch {
    return null;
  }
  if (url.hostname !== base.hostname) {
    return null;
  }
  if (!DOCS_PROXY_PORTS.has(url.port)) {
    return null;
  }
  if (
    !DOCS_PROXY_PATHS.has(url.pathname) &&
    !editionPathIsServed(url.pathname)
  ) {
    return null;
  }
  return url.pathname;
}

/**
 * The URL the viewer should actually load: the rewritten doc path made
 * ABSOLUTE against the relay base. The docs proxy lives on the relay, while
 * the SPA can run on any origin (relay-served web, the Tauri desktop shell,
 * a mobile front door) — a bare path resolves against `location.origin`, so
 * it only worked by accident on the relay-served SPA and rendered nothing
 * everywhere else.
 */
export function absoluteDocHref(href: string, relayBase: string): string | null {
  const path = resolveDocHref(href, relayBase);
  if (path === null) {
    return null;
  }
  try {
    return new URL(path, relayBase).href;
  } catch {
    return null;
  }
}
