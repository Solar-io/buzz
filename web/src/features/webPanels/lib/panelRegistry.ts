/**
 * Which sites the panel dock can host.
 *
 * # How this differs from the desktop, and why it has to
 *
 * The desktop renders each panel as a **native child webview** of the main
 * window, so its URLs are compile-time constants mirrored into `tauri.conf`'s
 * CSP and a Rust-side table, and owner-added sites never let their URL cross
 * into the app webview at all. None of that machinery exists in a browser: an
 * iframe is the only embedding primitive, its `src` is necessarily visible to
 * the page, and there is no privileged side to keep a URL on.
 *
 * So the browser build inverts the trust model deliberately: a panel URL is
 * **per-browser user data**, entered by the person using it and stored in
 * their own `localStorage`, and the validation below is what stands in for the
 * CSP allow-list. Only `http:` and `https:` survive it — `javascript:`,
 * `data:`, and `blob:` in an iframe `src` all execute in this origin, and this
 * origin holds the user's Nostr key.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export interface WebPanelDef {
  /** Stable id — `files` for the built-in, `custom:<n>` for added sites. */
  id: string;
  label: string;
  url: string;
  /** True for user-added sites, which can be removed. */
  custom: boolean;
}

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CUSTOM_PANELS_STORAGE_KEY = "buzz:web-panels.v1";
/** Each live tab is a full iframe with its own network and memory cost. */
export const MAX_CUSTOM_PANELS = 12;

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalize a URL a person typed, or return null.
 *
 * A bare host gets `https://` — people type `files.example` — but anything
 * that parses to a non-http(s) scheme is rejected outright rather than
 * coerced, because `javascript:alert(1)` "fixed" into
 * `https://javascript:alert(1)` would be a silent mangling of what the user
 * asked for.
 */
export function normalizePanelUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.hostname.length === 0) {
    return null;
  }
  return url.toString();
}

/** Human label for a URL when the user gave none. */
export function defaultPanelLabel(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * Append the shell's theme, for panels that understand it.
 *
 * An existing `theme` parameter is never overwritten: a user who pinned
 * `?theme=dark` in their own URL meant it.
 */
export function withThemeParam(url: string, isDark: boolean): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("theme")) {
      return url;
    }
    parsed.searchParams.set("theme", isDark ? "dark" : "light");
    return parsed.toString();
  } catch {
    return url;
  }
}

function sanitizeCustom(raw: unknown): WebPanelDef | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    return null;
  }
  if (typeof entry.url !== "string") {
    return null;
  }
  // Re-validate on read: a URL that was stored before a validation change, or
  // hand-edited in devtools, must not be trusted just because it is in
  // storage.
  const url = normalizePanelUrl(entry.url);
  if (url === null) {
    return null;
  }
  const label =
    typeof entry.label === "string" && entry.label.trim().length > 0
      ? entry.label.trim()
      : defaultPanelLabel(url);
  return { id: entry.id, label, url, custom: true };
}

export function readCustomPanels(
  storage: PanelStorage | null | undefined,
): WebPanelDef[] {
  if (!storage) {
    return [];
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(CUSTOM_PANELS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const panels: WebPanelDef[] = [];
    for (const entry of parsed) {
      const panel = sanitizeCustom(entry);
      if (!panel || seen.has(panel.id)) {
        continue;
      }
      seen.add(panel.id);
      panels.push(panel);
      if (panels.length === MAX_CUSTOM_PANELS) {
        break;
      }
    }
    return panels;
  } catch {
    return [];
  }
}

export function writeCustomPanels(
  storage: PanelStorage | null | undefined,
  panels: readonly WebPanelDef[],
): void {
  if (!storage) {
    return;
  }
  try {
    if (panels.length === 0) {
      storage.removeItem(CUSTOM_PANELS_STORAGE_KEY);
      return;
    }
    storage.setItem(
      CUSTOM_PANELS_STORAGE_KEY,
      JSON.stringify(
        panels
          .slice(0, MAX_CUSTOM_PANELS)
          .map(({ id, label, url }) => ({ id, label, url })),
      ),
    );
  } catch {
    // Quota or private mode: the dock still works for this session.
  }
}

/** Allocate an id no existing panel holds. */
export function nextCustomPanelId(existing: readonly WebPanelDef[]): string {
  let highest = 0;
  for (const panel of existing) {
    const match = /^custom:(\d+)$/.exec(panel.id);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `custom:${highest + 1}`;
}

/**
 * Add a site, or explain why not.
 *
 * De-duplicates on the normalized URL rather than the raw text, so
 * `files.example` and `https://files.example/` are one site.
 */
export function addCustomPanel(
  existing: readonly WebPanelDef[],
  input: { url: string; label?: string },
):
  | { ok: true; panels: WebPanelDef[]; added: WebPanelDef }
  | { ok: false; reason: string } {
  const url = normalizePanelUrl(input.url);
  if (url === null) {
    return {
      ok: false,
      reason: "That is not an http:// or https:// address.",
    };
  }
  if (existing.some((panel) => panel.url === url)) {
    return { ok: false, reason: "That site is already in the dock." };
  }
  if (existing.length >= MAX_CUSTOM_PANELS) {
    return {
      ok: false,
      reason: `The dock holds at most ${MAX_CUSTOM_PANELS} sites.`,
    };
  }
  const added: WebPanelDef = {
    id: nextCustomPanelId(existing),
    label: input.label?.trim() || defaultPanelLabel(url),
    url,
    custom: true,
  };
  return { ok: true, panels: [...existing, added], added };
}

export function removeCustomPanel(
  existing: readonly WebPanelDef[],
  id: string,
): WebPanelDef[] {
  return existing.filter((panel) => panel.id !== id);
}

/**
 * The complete registry: the operator's built-in Files panel (when it has a
 * URL at all) followed by the user's own sites.
 */
export function allPanels(
  filesUrl: string,
  customs: readonly WebPanelDef[],
): WebPanelDef[] {
  const normalizedFiles = normalizePanelUrl(filesUrl);
  const builtIn: WebPanelDef[] =
    normalizedFiles === null
      ? []
      : [{ id: "files", label: "Files", url: normalizedFiles, custom: false }];
  return [...builtIn, ...customs];
}

export function findPanel(
  panels: readonly WebPanelDef[],
  id: string | null,
): WebPanelDef | null {
  if (!id) {
    return null;
  }
  return panels.find((panel) => panel.id === id) ?? null;
}
