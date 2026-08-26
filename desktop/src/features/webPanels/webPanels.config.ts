import { Folder } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WebPanelDef = {
  id: string;
  label: string;
  /** Accessible name for the docked iframe; shown in the panel header. */
  title: string;
  icon: LucideIcon;
  url: string;
};

/**
 * The complete registry of docked web panels. Adding a panel is a config
 * entry here plus its origin in `tauri.conf.json`'s CSP `frame-src` — no
 * other code changes. URLs are compile-time constants by design: nothing
 * accepts a runtime URL, so a panel can only ever point where this file
 * (and the CSP) says it can.
 */
export const WEB_PANELS: readonly WebPanelDef[] = [
  {
    id: "files",
    label: "Files",
    title: "Files",
    icon: Folder,
    url: "https://crichton.tailb3d4b8.ts.net:6201/?panel=files",
  },
];

export function getWebPanel(panelId: string | null): WebPanelDef | null {
  return panelId
    ? (WEB_PANELS.find((panel) => panel.id === panelId) ?? null)
    : null;
}
