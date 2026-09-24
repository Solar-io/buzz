import * as React from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Theme push contract v1 — the Buzz PRODUCER (design
 * FILES_STANDALONE_APP_DESIGN_2026-09-23.md §4.2).
 *
 * Buzz's live theme is whatever its ThemeProvider last wrote onto
 * `<html>`: shadcn-style CSS variables (mostly HSL triples like
 * `"222 47% 11%"`) plus a `dark`/`light` class. We read the RESOLVED values
 * with getComputedStyle, normalise each to a complete CSS colour string, and
 * hand the panel a plain-data payload:
 *
 *   { v: 1, source: "buzz", mode: "dark"|"light", tokens: { background: "hsl(…)", … } }
 *
 * Native panels get it through the `push_web_panel_theme` Tauri command
 * (Rust serializes it to JSON and evals it into the child webview; it also
 * caches it and re-applies on every page load). Iframe panels get it by
 * postMessage with targetOrigin pinned to the frame's own origin.
 *
 * WHY A MutationObserver instead of useTheme(): the theme reaches `<html>`
 * through several writers (theme switch, accent colour, follow-system,
 * community themes, previews). Watching the one place they all land —
 * `<html>`'s class and inline style — catches every one of them, and the
 * payload is only sent when it actually changed.
 *
 * The payload is untrusted on the receiving side (the panel validates every
 * value); this side only promises well-formed data.
 */

export const THEME_PAYLOAD_VERSION = 1;

/** The contract's token set, without the leading `--`. Order is stable. */
export const BUZZ_THEME_TOKENS = [
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

export type BuzzThemeToken = (typeof BUZZ_THEME_TOKENS)[number];

export type BuzzThemePayload = {
  v: typeof THEME_PAYLOAD_VERSION;
  source: "buzz";
  mode: "dark" | "light";
  tokens: Partial<Record<BuzzThemeToken, string>>;
};

const NUM = String.raw`[-+]?(?:\d+(?:\.\d+)?|\.\d+)`;
/** A shadcn HSL triple: `H S% L%`, optional unit on H, optional `/ alpha`. */
const HSL_TRIPLE = new RegExp(
  String.raw`^${NUM}(?:deg)?\s+${NUM}%\s+${NUM}%(?:\s*\/\s*${NUM}%?)?$`,
);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgba?|hsla?)\([^;{}()]*\)$/i;

/**
 * One resolved custom-property value → a complete CSS colour string, or
 * null when it is neither a triple nor a colour the contract carries
 * (the panel then falls back for that token). Pure.
 */
export function normalizeThemeToken(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (HSL_TRIPLE.test(value)) return `hsl(${value})`;
  if (HEX.test(value) || COLOR_FN.test(value)) return value;
  return null;
}

/** Read the payload off an element's computed style. Pure given its inputs. */
export function collectPanelTheme(
  root: Element,
  readStyle: (
    element: Element,
  ) => Pick<CSSStyleDeclaration, "getPropertyValue">,
): BuzzThemePayload {
  const style = readStyle(root);
  const tokens: Partial<Record<BuzzThemeToken, string>> = {};
  for (const token of BUZZ_THEME_TOKENS) {
    const value = normalizeThemeToken(style.getPropertyValue(`--${token}`));
    if (value) tokens[token] = value;
  }
  return {
    v: THEME_PAYLOAD_VERSION,
    source: "buzz",
    mode: root.classList.contains("dark") ? "dark" : "light",
    tokens,
  };
}

export function readBuzzTheme(): BuzzThemePayload {
  return collectPanelTheme(document.documentElement, (element) =>
    window.getComputedStyle(element),
  );
}

/** The origin a frame's src belongs to, or null (about:blank, garbage). */
export function frameOrigin(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const origin = new URL(src).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Post a payload into one iframe panel, pinned to that frame's origin. */
export function postThemeToFrame(
  frame: HTMLIFrameElement,
  payload: BuzzThemePayload,
): boolean {
  const origin = frameOrigin(frame.getAttribute("src"));
  if (!origin || !frame.contentWindow) return false;
  frame.contentWindow.postMessage({ type: "buzz:theme", ...payload }, origin);
  return true;
}

/** Iframe panels that take the theme push carry this attribute. */
export const THEME_FRAME_ATTR = "data-buzz-theme-push";

function themeFrames(container: HTMLElement | null): HTMLIFrameElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLIFrameElement>(
      `iframe[${THEME_FRAME_ATTR}="true"]`,
    ),
  );
}

function report(error: unknown) {
  console.error("web panel theme push failed", error);
}

/**
 * Keep the active panel's theme in step with Buzz's. Pushes on mount, on
 * every change to `<html>`'s class/style (debounced to one animation
 * frame, deduplicated by payload), to the native webview via IPC and to
 * every opted-in iframe in `containerRef`. Answers a frame's
 * `{type:"files:ready"}` immediately, but only from one of our own frames
 * at that frame's origin.
 */
export function usePanelThemePush(options: {
  enabled: boolean;
  native: boolean;
  instanceId: string;
  panelId: string;
  containerRef: React.RefObject<HTMLElement | null>;
}): void {
  const { enabled, native, instanceId, panelId, containerRef } = options;
  React.useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let lastJson = "";

    const push = (force: boolean) => {
      const payload = readBuzzTheme();
      const json = JSON.stringify(payload);
      if (!force && json === lastJson) return;
      lastJson = json;
      if (native) {
        invoke("push_web_panel_theme", { instanceId, panelId, payload }).catch(
          report,
        );
      }
      for (const iframe of themeFrames(containerRef.current)) {
        postThemeToFrame(iframe, payload);
      }
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => push(false));
    };

    const observer = new window.MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== "object" || data.type !== "files:ready")
        return;
      const iframe = themeFrames(containerRef.current).find(
        (candidate) => candidate.contentWindow === event.source,
      );
      if (!iframe || frameOrigin(iframe.getAttribute("src")) !== event.origin)
        return;
      postThemeToFrame(iframe, readBuzzTheme());
    };
    window.addEventListener("message", onMessage);

    push(true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, [enabled, native, instanceId, panelId, containerRef]);
}
