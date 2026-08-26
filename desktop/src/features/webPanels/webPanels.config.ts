import { Folder } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WebPanelRenderMode = "native" | "iframe";

export type WebPanelDef = {
  id: string;
  label: string;
  /** Accessible name for the docked panel; shown in the panel header. */
  title: string;
  icon: LucideIcon;
  url: string;
  /**
   * How the panel is rendered. "native" overlays a child webview of the
   * main window (first-party cookies in the shared jar — the default);
   * "iframe" keeps the v1 embedded frame as an explicit fallback.
   */
  render: WebPanelRenderMode;
};

/**
 * e2e builds force the iframe fallback: Playwright drives plain chromium,
 * where native child webviews do not exist and the Tauri IPC is mocked.
 * Asserted by webPanels.config.test.mjs in both directions.
 */
export const E2E_BUILD_FORCES_IFRAME =
  // Optional chaining: under the node test runner `import.meta.env` is
  // undefined; vite always defines it.
  import.meta.env?.MODE === "e2e";

export function resolveRenderMode(
  configured: WebPanelRenderMode,
  forceIframe: boolean,
): WebPanelRenderMode {
  return forceIframe ? "iframe" : configured;
}

/**
 * The complete registry of docked web panels. Adding a panel is a config
 * entry here plus its origin in `tauri.conf.json`'s CSP `frame-src` (for
 * iframe fallback) and its (id, url) mirrored in
 * `src-tauri/src/web_panels.rs`'s `PANEL_TYPES` (the origin-sync tests in
 * both languages fail on drift). URLs are compile-time constants by design:
 * nothing accepts a runtime URL, so a panel can only ever point where this
 * file (and the CSP and the Rust table) says it can.
 */
export const WEB_PANELS: readonly WebPanelDef[] = [
  {
    id: "files",
    label: "Files",
    title: "Files",
    icon: Folder,
    url: "https://crichton.tailb3d4b8.ts.net:6201/?panel=files",
    render: resolveRenderMode("native", E2E_BUILD_FORCES_IFRAME),
  },
];

export function getWebPanel(panelId: string | null): WebPanelDef | null {
  return panelId
    ? (WEB_PANELS.find((panel) => panel.id === panelId) ?? null)
    : null;
}
