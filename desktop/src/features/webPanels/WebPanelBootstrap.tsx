import * as React from "react";
import { invoke } from "@tauri-apps/api/core";

import { getWebPanel, type WebPanelDef } from "./webPanels.config";
import { setWebPanelMode, useWebPanel } from "./webPanelStore";
import { WebPanelSubstrate } from "./WebPanelSubstrate";

function report(error: unknown) {
  console.error("web panel login failed", error);
}

/**
 * Open the login companion window for a panel. All the app's webviews share
 * one cookie jar, so an OAuth login completed in that window is visible to
 * the docked iframe after its Reload button remounts it. Only the panel id
 * crosses the IPC boundary — the backend owns the URL and window title.
 */
function openLoginWindow(panel: WebPanelDef) {
  invoke("open_web_panel_login", { panelId: panel.id }).catch(report);
}

/**
 * Single mount for the docked web panels, mirroring TerminalBootstrap: one
 * instance lives under the channel surface for the whole app, and the panel
 * open/close animation is staged the same way (mount collapsed, paint, then
 * expand) so the dock transition has something to animate from.
 */
export function WebPanelBootstrap() {
  const panel = useWebPanel();
  const openPanel = getWebPanel(panel.openPanelId);
  const [renderedMode, setRenderedMode] = React.useState<
    "docked" | "maximized"
  >(panel.mode === "maximized" ? "maximized" : "docked");
  const [panelVisible, setPanelVisible] = React.useState(
    panel.mode !== "closed",
  );
  const [panelMounted, setPanelMounted] = React.useState(
    panel.mode !== "closed",
  );
  const previousModeRef = React.useRef(panel.mode);

  React.useEffect(() => {
    const previousMode = previousModeRef.current;
    if (previousMode === panel.mode) return;
    previousModeRef.current = panel.mode;

    let firstFrame = 0;
    let secondFrame = 0;
    let timeout = 0;
    if (panel.mode !== "closed") {
      setRenderedMode(panel.mode === "maximized" ? "maximized" : "docked");
      setPanelMounted(true);
      if (previousMode === "closed") {
        // Give the collapsed substrate a painted frame before expanding it.
        // A single rAF can still be batched into the mount commit by React.
        setPanelVisible(false);
        firstFrame = window.requestAnimationFrame(() => {
          secondFrame = window.requestAnimationFrame(() =>
            setPanelVisible(true),
          );
        });
      } else {
        setPanelVisible(true);
      }
    } else {
      setPanelVisible(false);
      timeout = window.setTimeout(() => setPanelMounted(false), 180);
    }
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(timeout);
    };
  }, [panel.mode]);

  if (!panelMounted || !openPanel) return null;

  return (
    <WebPanelSubstrate
      mode={renderedMode}
      panel={openPanel}
      visible={panelVisible}
      onHide={() => setWebPanelMode("closed")}
      onLogin={() => openLoginWindow(openPanel)}
      onModeChange={setWebPanelMode}
    />
  );
}
