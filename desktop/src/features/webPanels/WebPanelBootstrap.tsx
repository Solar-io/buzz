import * as React from "react";
import { invoke } from "@tauri-apps/api/core";

import { getWebPanel, WEB_PANELS } from "./webPanels.config";
import {
  closeWebPanelInstance,
  setActiveWebPanelInstance,
  setWebPanelInstanceHeight,
  setWebPanelMode,
  useWebPanel,
  type WebPanelInstance,
} from "./webPanelStore";
import { WebPanelSubstrate, type WebPanelTab } from "./WebPanelSubstrate";
import { openWebPanelInstanceWithFeedback } from "./webPanelActions";

function report(error: unknown) {
  console.error("web panel command failed", error);
}

/**
 * Open the login companion window for a panel type. All the app's webviews
 * share one cookie jar, so an OAuth login completed in that window is
 * visible to the docked panel after its Reload button refreshes it. Only
 * the panel id crosses the IPC boundary — the backend owns the URL and
 * window title.
 */
function openLoginWindow(panelId: string) {
  invoke("open_web_panel_login", { panelId }).catch(report);
}

/**
 * Single mount for the docked web panel dock, mirroring TerminalBootstrap:
 * one instance lives under the channel surface for the whole app, and the
 * dock open/close animation is staged the same way (mount collapsed, paint,
 * then expand) so the transition has something to animate from.
 *
 * The dock stacks with the terminal panel exactly as v1 did — they are
 * independent docks; a native child webview tracks its placeholder rect,
 * which never overlaps the terminal dock above it.
 */
export function WebPanelBootstrap() {
  const panel = useWebPanel();
  const dockOpen = panel.mode !== "closed" && panel.instances.length > 0;
  const [renderedMode, setRenderedMode] = React.useState<
    "docked" | "maximized"
  >(panel.mode === "maximized" ? "maximized" : "docked");
  const [panelVisible, setPanelVisible] = React.useState(dockOpen);
  const [panelMounted, setPanelMounted] = React.useState(dockOpen);
  const previousModeRef = React.useRef(panel.mode);

  // Tabs from the store; unknown panel ids (config renamed) are dropped.
  const tabs: readonly WebPanelTab[] = React.useMemo(() => {
    const resolved = panel.instances.flatMap((instance) => {
      const panelDef = getWebPanel(instance.panelId);
      return panelDef
        ? [
            {
              instanceId: instance.instanceId,
              panel: panelDef,
              height: instance.height,
              active: instance.instanceId === panel.activeInstanceId,
            },
          ]
        : [];
    });
    if (resolved.length > 0 && !resolved.some((tab) => tab.active)) {
      resolved[0] = { ...resolved[0], active: true };
    }
    return resolved;
  }, [panel.instances, panel.activeInstanceId]);

  // Keep the closing transition populated: the store clears instances the
  // moment the dock closes, but the collapsing substrate should still show
  // the tabs it had.
  const lastTabsRef = React.useRef<readonly WebPanelTab[]>(tabs);
  if (tabs.length > 0) lastTabsRef.current = tabs;
  const displayTabs =
    tabs.length > 0 ? tabs : panelMounted ? lastTabsRef.current : [];

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

  // Native webview lifecycle: destroy the webviews of instances that left
  // the store (tab close or dock close). Hidden-but-kept tabs never leave
  // the store, so only true removals destroy — that is what bounds live
  // WKWebView sessions by the store's cap.
  const instancesRef = React.useRef<readonly WebPanelInstance[]>([]);
  React.useEffect(() => {
    const previous = instancesRef.current;
    instancesRef.current = panel.instances;
    const currentIds = new Set(
      panel.instances.map((instance) => instance.instanceId),
    );
    for (const removed of previous) {
      if (currentIds.has(removed.instanceId)) continue;
      if (getWebPanel(removed.panelId)?.render !== "native") continue;
      invoke("destroy_web_panel", {
        instanceId: removed.instanceId,
        panelId: removed.panelId,
      }).catch(report);
    }
  }, [panel.instances]);

  if (!panelMounted || displayTabs.length === 0) return null;

  return (
    <WebPanelSubstrate
      mode={renderedMode}
      onCloseTab={closeWebPanelInstance}
      onHeightCommit={setWebPanelInstanceHeight}
      onHide={() => setWebPanelMode("closed")}
      onLogin={openLoginWindow}
      onModeChange={setWebPanelMode}
      onOpenInstance={openWebPanelInstanceWithFeedback}
      onSelectTab={setActiveWebPanelInstance}
      panelTypes={WEB_PANELS}
      tabs={displayTabs}
      visible={panelVisible}
    />
  );
}
