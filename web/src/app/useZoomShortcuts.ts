import * as React from "react";

/**
 * Cmd/Ctrl +/- scales the real root font-size, so every rem in the app — text,
 * spacing, widths, radii — zooms together. The Font size preference is a
 * separate, text-only dial layered on top (see the `--buzz-type-scale` block
 * in `shared/styles/globals.css`).
 *
 * Ported from the desktop client's `useWebviewZoomShortcuts`, minus every
 * Tauri call: there is no webview to pin here, so the rem root is the only
 * dial this hook drives. The browser keeps its own page zoom — see the note
 * on `handleKeyDown` below.
 */
const BASE_FONT_SIZE_PX = 16;
const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.75;
const MAX_ZOOM_FACTOR = 1.5;
const ZOOM_STEP = 0.1;
const TEXT_SCALE_STORAGE_KEY = "buzz:text-scale";

type ZoomAction = "increase" | "decrease" | "reset";

type ModifierKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** Returns true on macOS/iOS-style Apple platforms. */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

/**
 * The platform's normal application-shortcut modifier:
 * - macOS: Command (Meta)
 * - Windows/Linux: Control
 *
 * On macOS this intentionally rejects Control so native Emacs-style text
 * editing shortcuts (Ctrl-A/E/B/F/K/etc.) are left available to text fields.
 */
function hasPrimaryShortcutModifier(event: ModifierKeyboardEvent): boolean {
  if (isMacPlatform()) {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
}

function roundZoomFactor(zoomFactor: number) {
  return Math.round(zoomFactor * 10) / 10;
}

function getZoomAction(event: KeyboardEvent): ZoomAction | null {
  if (!hasPrimaryShortcutModifier(event) || event.altKey) {
    return null;
  }

  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "increase";
  }

  if (
    !event.shiftKey &&
    (event.key === "-" ||
      event.code === "Minus" ||
      event.code === "NumpadSubtract")
  ) {
    return "decrease";
  }

  if (
    !event.shiftKey &&
    (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0")
  ) {
    return "reset";
  }

  return null;
}

function getNextZoomFactor(action: ZoomAction, zoomFactor: number) {
  if (action === "reset") {
    return DEFAULT_ZOOM_FACTOR;
  }

  if (action === "increase") {
    return Math.min(roundZoomFactor(zoomFactor + ZOOM_STEP), MAX_ZOOM_FACTOR);
  }

  return Math.max(roundZoomFactor(zoomFactor - ZOOM_STEP), MIN_ZOOM_FACTOR);
}

/**
 * Storage can throw outright in a browser — a blocked-cookies context or a
 * Safari private window makes `localStorage` a getter that raises. The desktop
 * webview never hits that, but this hook runs in a layout effect, so an
 * uncaught throw here would take the whole app down on mount.
 */
function readStoredZoomFactor() {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
  } catch {
    return DEFAULT_ZOOM_FACTOR;
  }

  if (!raw) {
    return DEFAULT_ZOOM_FACTOR;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ZOOM_FACTOR;
  }

  return Math.min(Math.max(parsed, MIN_ZOOM_FACTOR), MAX_ZOOM_FACTOR);
}

function applyRootZoom(zoomFactor: number) {
  document.documentElement.style.fontSize =
    zoomFactor === DEFAULT_ZOOM_FACTOR
      ? ""
      : `${BASE_FONT_SIZE_PX * zoomFactor}px`;
}

function applyTextScale(zoomFactor: number) {
  applyRootZoom(zoomFactor);
  try {
    if (zoomFactor === DEFAULT_ZOOM_FACTOR) {
      window.localStorage.removeItem(TEXT_SCALE_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(zoomFactor));
  } catch {
    // Scale still applies for this session; it just won't be remembered.
  }
}

export function useZoomShortcuts() {
  const zoomFactorRef = React.useRef(DEFAULT_ZOOM_FACTOR);

  React.useLayoutEffect(() => {
    const storedZoomFactor = readStoredZoomFactor();

    zoomFactorRef.current = storedZoomFactor;
    applyTextScale(storedZoomFactor);

    function handleKeyDown(event: KeyboardEvent) {
      const action = getZoomAction(event);
      if (!action) {
        return;
      }

      // Scoped to the exact combinations handled above — never a blanket
      // suppression. Browsers treat Cmd/Ctrl +/- as a reserved chrome
      // accelerator, so whether this actually stops the page-zoom half is the
      // browser's call, not ours; the app-level rem dial below runs either way.
      event.preventDefault();

      const previousZoomFactor = zoomFactorRef.current;
      const nextZoomFactor = getNextZoomFactor(action, previousZoomFactor);

      if (nextZoomFactor === previousZoomFactor) {
        return;
      }

      zoomFactorRef.current = nextZoomFactor;
      applyTextScale(nextZoomFactor);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== TEXT_SCALE_STORAGE_KEY && event.key !== null) {
        return;
      }

      const storedZoomFactor = readStoredZoomFactor();
      zoomFactorRef.current = storedZoomFactor;
      applyRootZoom(storedZoomFactor);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);
}
