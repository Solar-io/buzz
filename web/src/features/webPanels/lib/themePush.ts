/**
 * Theme push contract v1 — Buzz WEB as the producer (stash design
 * FILES_STANDALONE_APP_DESIGN_2026-09-23 §4.2, plus the three optional
 * sidebar tokens of STASH_THEME_PARITY_DESIGN_2026-09-24 §3). The desktop
 * twin is `desktop/src/features/webPanels/panelTheme.ts`.
 *
 * Buzz's live theme is whatever ThemeProvider last wrote onto `<html>`: a
 * fixed palette (`data-palette`, palettes.css), or the adaptive engine's
 * inline vars, plus an accent layer and a `dark`/`light` class. We read the
 * RESOLVED values (getComputedStyle already substitutes `var()`), turn each
 * shadcn HSL triple into a complete colour, and hand the Files frame plain
 * data:
 *
 *   { type: "buzz:theme", v: 1, source: "buzz", mode, tokens: { background: "hsl(…)", … } }
 *
 * The consumer (stash `shell/theme.js`) treats the payload as untrusted and
 * validates every value; this side still only emits values that pass the
 * SAME strict grammar (`isSafeColor` there), so a `#buzz-theme=` fragment —
 * which stash refuses all-or-nothing — can never be refused for one token.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const THEME_PAYLOAD_VERSION = 1;

/** The contract's sixteen tokens, without the leading `--`. Order is stable. */
export const CONTRACT_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
] as const;

export type ContractToken = (typeof CONTRACT_TOKENS)[number];
export type PayloadToken =
  | ContractToken
  | "sidebar"
  | "sidebar-active"
  | "sidebar-active-foreground";

export interface BuzzThemePayload {
  type: "buzz:theme";
  v: typeof THEME_PAYLOAD_VERSION;
  source: "buzz";
  mode: "dark" | "light";
  tokens: Partial<Record<PayloadToken, string>>;
}

/** stash's per-value cap (`MAX_COLOR_LENGTH`). */
export const MAX_COLOR_LENGTH = 64;

const NUM = String.raw`[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?`;
const ARG = `${NUM}(?:%|deg|turn|rad|grad)?`;
/** A shadcn triple: `H S% L%`, optional unit on H, optional `/ alpha`. */
const TRIPLE = new RegExp(
  String.raw`^${NUM}(?:deg)?\s+${NUM}%\s+${NUM}%(?:\s*\/\s*${NUM}%?)?$`,
  "i",
);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** stash's FUNC_RE: legacy comma syntax, or space syntax with `/ alpha`. */
const COLOR_FN = new RegExp(
  String.raw`^(?:rgba?|hsla?)\(\s*(?:` +
    String.raw`${ARG}\s*,\s*${ARG}\s*,\s*${ARG}(?:\s*,\s*${ARG})?` +
    "|" +
    String.raw`${ARG}\s+${ARG}\s+${ARG}(?:\s*\/\s*${ARG})?` +
    String.raw`)\s*\)$`,
  "i",
);
const FORBIDDEN = /url\(|var\(|expression|[;{}<>\\"'`]/i;

/** The strict grammar stash accepts (its `isSafeColor`), mirrored. Pure. */
export function isSafeColor(value: string): boolean {
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) {
    return false;
  }
  if (FORBIDDEN.test(value)) {
    return false;
  }
  return HEX.test(value) || COLOR_FN.test(value);
}

/**
 * One resolved custom-property value → a complete CSS colour string, or null
 * when it is neither a triple nor a colour the contract carries (stash then
 * falls back for that token). Pure.
 */
export function normalizeThemeToken(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) {
    return null;
  }
  const colour = TRIPLE.test(value) ? `hsl(${value})` : value;
  return isSafeColor(colour) ? colour : null;
}

/** Reads one custom property (`--name`) off the resolved root style. */
export type ReadVar = (name: string) => string | null | undefined;

/**
 * Where the three optional tokens come from on the Buzz side:
 *
 * - `sidebar` (stash's tree/inspector rail) ← `--rail`, the redesign's rail
 *   surface the Files artboard paints the tree with; `--sidebar-background`
 *   for a theme that predates it.
 * - `sidebar-active` / `-foreground` (stash's SOLID selected-row fill + ink)
 *   ← the `--sel` / `--sel-foreground` pair where a palette defines one (the
 *   Files artboard's soft selection), else Buzz's own selected-row pair
 *   `--sidebar-active` / `--sidebar-active-foreground`. The two halves come
 *   from ONE pair, so a fill is never paired with another fill's ink.
 */
function sidebarTokens(read: ReadVar): Partial<Record<PayloadToken, string>> {
  const out: Partial<Record<PayloadToken, string>> = {};
  const rail =
    normalizeThemeToken(read("--rail")) ??
    normalizeThemeToken(read("--sidebar-background"));
  if (rail) {
    out.sidebar = rail;
  }
  const sel = normalizeThemeToken(read("--sel"));
  const [fill, ink] = sel
    ? [
        sel,
        normalizeThemeToken(read("--sel-foreground")) ??
          normalizeThemeToken(read("--foreground")),
      ]
    : [
        normalizeThemeToken(read("--sidebar-active")),
        normalizeThemeToken(read("--sidebar-active-foreground")),
      ];
  if (fill && ink) {
    out["sidebar-active"] = fill;
    out["sidebar-active-foreground"] = ink;
  }
  return out;
}

/** Build the payload from a var reader and the root's polarity. Pure. */
export function buildThemePayload(
  read: ReadVar,
  isDark: boolean,
): BuzzThemePayload {
  const tokens: Partial<Record<PayloadToken, string>> = {};
  for (const token of CONTRACT_TOKENS) {
    const value = normalizeThemeToken(read(`--${token}`));
    if (value) {
      tokens[token] = value;
    }
  }
  return {
    type: "buzz:theme",
    v: THEME_PAYLOAD_VERSION,
    source: "buzz",
    mode: isDark ? "dark" : "light",
    tokens: { ...tokens, ...sidebarTokens(read) },
  };
}

/**
 * The origin a panel URL belongs to — the ONLY targetOrigin a push may use,
 * so the payload is dropped by the browser if the frame has navigated
 * anywhere else (a sign-in hop, a link). Null for anything without one.
 */
export function panelOrigin(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** `{type: "files:ready"}` — stash's boot announcement. */
export function isFilesReady(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "files:ready"
  );
}

/** base64url (RFC 4648 §5, unpadded) of ASCII JSON. */
function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `url#buzz-theme=<base64url(JSON)>` — the first-paint transport (stash
 * parity design §4): stash applies it during boot, before the `files:ready`
 * round trip, and strips it from its address bar. The payload sent is the
 * contract body only (no `type`). Any existing fragment is replaced. Pure.
 */
export function withThemeFragment(
  url: string,
  payload: BuzzThemePayload,
): string {
  const { type: _type, ...body } = payload;
  try {
    const parsed = new URL(url);
    parsed.hash = `buzz-theme=${base64Url(JSON.stringify(body))}`;
    return parsed.toString();
  } catch {
    return url;
  }
}
