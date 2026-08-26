import * as React from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Geometry bridge between a DOM placeholder and a native child webview.
 *
 * WKWebView third-party iframes cannot reliably hold auth cookies (Storage
 * Access flakiness), so in native render mode the panel content is a child
 * webview of the main window — first-party in the shared cookie jar — and
 * the DOM keeps only a placeholder. This hook pins the webview to that
 * placeholder's rect.
 *
 * WHY A rAF LOOP instead of a ResizeObserver set: the rect must follow
 * every layout change that moves or resizes the placeholder — window
 * resize, the dock's own open/close/maximize transitions, the drag handle,
 * and siblings above the dock changing size (the terminal panel opening
 * pushes the dock down without resizing it). Only an observer on every
 * relevant ancestor catches all of those; reading the rect once per frame
 * is one cheap getBoundingClientRect and cannot miss a case. The loop runs
 * only while a native panel is visible, and the invoke fires only when the
 * rounded rect actually changes, so steady state costs one cached layout
 * read per frame and no IPC.
 *
 * Coordinates: getBoundingClientRect returns CSS px, which are Tauri
 * logical px, and the child webview is positioned relative to the same
 * window content origin — no scale-factor math anywhere. Rounded to whole
 * logical px so sub-pixel jitter never crosses the IPC boundary.
 *
 * Keyboard focus: once the user clicks into the child webview, keystrokes
 * land there and the main window's shortcuts do not fire until focus
 * returns (click any app chrome, e.g. the header bar). That is inherent to
 * native child webviews and accepted for panels.
 */

export const MIN_VIEWPORT_EDGE = 1;

export type NativePanelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function readPlaceholderRect(
  element: HTMLElement | null,
): NativePanelRect | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width < MIN_VIEWPORT_EDGE || box.height < MIN_VIEWPORT_EDGE) {
    // Collapsed (dock opening, hidden) — nothing to pin yet.
    return null;
  }
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

export function rectKey(rect: NativePanelRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

function report(error: unknown) {
  console.error("web panel webview sync failed", error);
}

export function useNativePanelWebview(options: {
  enabled: boolean;
  instanceId: string;
  panelId: string;
  viewportRef: React.RefObject<HTMLElement | null>;
}): void {
  const { enabled, instanceId, panelId, viewportRef } = options;
  React.useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let lastKey = "";
    const tick = () => {
      const rect = readPlaceholderRect(viewportRef.current);
      if (rect) {
        const key = rectKey(rect);
        if (key !== lastKey) {
          lastKey = key;
          invoke("ensure_web_panel", {
            instanceId,
            panelId,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }).catch(report);
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      // Hidden, not destroyed: inactive tabs keep their webview (and its
      // session state) alive for instant switching. The dock-close path
      // destroys explicitly.
      invoke("set_web_panel_visible", {
        instanceId,
        panelId,
        visible: false,
      }).catch(report);
    };
  }, [enabled, instanceId, panelId, viewportRef]);
}
