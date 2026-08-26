import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogIn, Maximize2, Minimize2, Plus, RotateCw, X } from "lucide-react";

import type { WebPanelDef } from "./webPanels.config";
import {
  DOCK_HEIGHT_DEFAULT,
  DOCK_HEIGHT_MAX_RATIO,
  DOCK_HEIGHT_MIN,
} from "./webPanelStore";
import { useNativePanelWebview } from "./useNativePanelWebview";

const NOOP = () => {};

function dockHeightLimit() {
  return window.innerHeight * DOCK_HEIGHT_MAX_RATIO;
}

function clampDockHeight(height: number) {
  return Math.max(DOCK_HEIGHT_MIN, Math.min(dockHeightLimit(), height));
}

/** One tab: an instance id plus its resolved panel type. */
export type WebPanelTab = {
  instanceId: string;
  panel: WebPanelDef;
  height: number | null;
  active: boolean;
};

type WebPanelSubstrateProps = {
  tabs: readonly WebPanelTab[];
  /** Panel types offered by the tab-strip "+" picker. */
  panelTypes: readonly WebPanelDef[];
  mode?: "docked" | "maximized";
  visible?: boolean;
  onHide?: () => void;
  onModeChange?: (mode: "docked" | "maximized") => void;
  /** Opens the login companion window for a panel type. */
  onLogin?: (panelId: string) => void;
  onSelectTab?: (instanceId: string) => void;
  onCloseTab?: (instanceId: string) => void;
  /** Opens a new instance of a panel type (the "+" picker). */
  onOpenInstance?: (panelId: string) => void;
  onHeightCommit?: (instanceId: string, height: number) => void;
};

export function WebPanelSubstrate({
  tabs,
  panelTypes,
  mode = "docked",
  visible = true,
  onHide = NOOP,
  onModeChange = NOOP,
  onLogin = NOOP,
  onSelectTab = NOOP,
  onCloseTab = NOOP,
  onOpenInstance = NOOP,
  onHeightCommit = NOOP,
}: WebPanelSubstrateProps) {
  const activeTab = tabs.find((tab) => tab.active) ?? null;
  const activePanel = activeTab?.panel ?? null;
  const native = activePanel?.render === "native";

  const substrateRef = React.useRef<HTMLElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Per-instance reload counters (iframe mode remounts on change; native
  // mode reloads in place via IPC).
  const [reloadCounters, setReloadCounters] = React.useState<
    Record<string, number>
  >({});
  // Dock height: the active tab's persisted height, with a live local
  // preview while dragging (committed on release).
  const [dragPreviewHeight, setDragPreviewHeight] = React.useState<
    number | null
  >(null);
  const displayHeight =
    dragPreviewHeight ?? activeTab?.height ?? DOCK_HEIGHT_DEFAULT;

  useNativePanelWebview({
    enabled: visible && native && activeTab !== null,
    instanceId: activeTab?.instanceId ?? "",
    panelId: activePanel?.id ?? "",
    viewportRef,
  });

  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const commitHeight = (height: number) => {
    if (!activeTab) return;
    onHeightCommit(activeTab.instanceId, clampDockHeight(height));
  };

  const resizeByKeyboard = (delta: number) => {
    commitHeight(displayHeight + delta);
  };

  const reloadActive = () => {
    if (!activeTab || !activePanel) return;
    if (native) {
      invoke("reload_web_panel", {
        instanceId: activeTab.instanceId,
        panelId: activePanel.id,
      }).catch((error) => {
        console.error("web panel reload failed", error);
      });
      return;
    }
    setReloadCounters((current) => ({
      ...current,
      [activeTab.instanceId]: (current[activeTab.instanceId] ?? 0) + 1,
    }));
  };

  const startPointerResize = (event: React.PointerEvent<HTMLHRElement>) => {
    event.preventDefault();
    dragCleanupRef.current?.();
    const handle = event.currentTarget;
    const substrate = substrateRef.current;
    if (!substrate || !activeTab) return;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    substrate.dataset.webpanelResizing = "true";
    const startY = event.clientY;
    const startHeight = displayHeight;
    let nextHeight = startHeight;
    let frame = 0;
    const applyHeight = () => {
      frame = 0;
      substrate.style.height = `${nextHeight}px`;
      setDragPreviewHeight(nextHeight);
    };
    const cleanup = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      nextHeight = clampDockHeight(startHeight + startY - moveEvent.clientY);
      if (!frame) frame = window.requestAnimationFrame(applyHeight);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      if (frame) {
        window.cancelAnimationFrame(frame);
        applyHeight();
      }
      cleanup();
      delete substrate.dataset.webpanelResizing;
      commitHeight(nextHeight);
      setDragPreviewHeight(null);
    };
    dragCleanupRef.current = cleanup;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  // ── Tab strip (shared by both render modes) ────────────────────────────

  const tabStrip = (
    <div className="buzz-webpanel-tabs" role="tablist">
      {tabs.map((tab) => {
        const TabIcon = tab.panel.icon;
        return (
          <div
            className="buzz-webpanel-tab-shell"
            key={tab.instanceId}
            role="presentation"
          >
            <button
              aria-selected={tab.active ? "true" : "false"}
              className="buzz-webpanel-tab"
              data-active={tab.active ? "true" : "false"}
              onClick={() => onSelectTab(tab.instanceId)}
              role="tab"
              type="button"
            >
              <TabIcon />
              <span>{tab.panel.label}</span>
            </button>
            <button
              aria-label={`Close ${tab.panel.label} tab`}
              className="buzz-webpanel-tab-close"
              onClick={() => onCloseTab(tab.instanceId)}
              type="button"
            >
              <X />
            </button>
          </div>
        );
      })}
      <div className="buzz-webpanel-add-tab">
        <button
          aria-expanded={pickerOpen ? "true" : "false"}
          aria-haspopup="menu"
          aria-label="Open a new panel tab"
          className="buzz-webpanel-window-action"
          onClick={() => setPickerOpen((open) => !open)}
          type="button"
        >
          <Plus />
        </button>
        {pickerOpen ? (
          <div
            aria-label="Panel types"
            className="buzz-webpanel-picker"
            role="menu"
          >
            {panelTypes.map((panel) => {
              const PickerIcon = panel.icon;
              return (
                <button
                  className="buzz-webpanel-picker-item"
                  key={panel.id}
                  onClick={() => {
                    setPickerOpen(false);
                    onOpenInstance(panel.id);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <PickerIcon />
                  <span>{panel.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <section
      aria-label={activePanel?.label ?? "Web panels"}
      className="buzz-webpanel-substrate"
      data-webpanel-mode={mode}
      data-webpanel-render={activePanel?.render ?? "native"}
      data-webpanel-visible={visible ? "true" : "false"}
      ref={substrateRef}
      style={mode === "docked" ? { height: displayHeight } : undefined}
    >
      {mode === "docked" ? (
        <hr
          aria-label={
            activePanel ? `Resize ${activePanel.label} panel` : "Resize panel"
          }
          aria-orientation="horizontal"
          aria-valuemax={Math.round(dockHeightLimit())}
          aria-valuemin={DOCK_HEIGHT_MIN}
          aria-valuenow={Math.round(displayHeight)}
          className="buzz-webpanel-resize-handle"
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            resizeByKeyboard(event.key === "ArrowUp" ? 16 : -16);
          }}
          onPointerDown={startPointerResize}
          tabIndex={0}
        />
      ) : null}
      <div className="buzz-webpanel-contract-bar">
        {/* The header strip owns the dock's controls and is never covered
            by the native child webview — the webview's rect tracks the
            viewport placeholder below this bar only. */}
        {tabStrip}
        <div className="buzz-webpanel-readout">
          <button
            aria-label={
              activePanel ? `Log in to ${activePanel.label}` : "Log in"
            }
            className="buzz-webpanel-window-action"
            disabled={!activePanel}
            onClick={() => activePanel && onLogin(activePanel.id)}
            title={activePanel ? `${activePanel.label} login` : undefined}
            type="button"
          >
            <LogIn />
          </button>
          <button
            aria-label={activePanel ? `Reload ${activePanel.label}` : "Reload"}
            className="buzz-webpanel-window-action"
            disabled={!activePanel}
            onClick={reloadActive}
            type="button"
          >
            <RotateCw />
          </button>
          <button
            aria-label={
              mode === "maximized" ? "Restore panel" : "Maximize panel"
            }
            className="buzz-webpanel-window-action"
            onClick={() =>
              onModeChange(mode === "maximized" ? "docked" : "maximized")
            }
            type="button"
          >
            {mode === "maximized" ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            aria-label="Hide web panels"
            className="buzz-webpanel-window-action"
            onClick={onHide}
            type="button"
          >
            <X />
          </button>
        </div>
      </div>
      <div className="buzz-webpanel-viewport" ref={viewportRef}>
        {native ? (
          /* Native mode: ONLY the active instance has a webview, pinned to
             this placeholder's rect; inactive tabs are hidden-but-alive
             webviews managed through the store lifecycle. Clicking into the
             child webview moves keyboard focus there, and main-window
             shortcuts do not fire while it holds focus — click app chrome
             (e.g. this header) to come back. */
          <div
            aria-hidden="true"
            className="buzz-webpanel-native-placeholder"
            data-webpanel-placeholder={activeTab?.instanceId}
          />
        ) : (
          /* Iframe fallback: every tab stays mounted; inactive tabs are
             display:none — the same keep-alive semantics as native mode.
             No `sandbox` attribute: the panel app needs cookies and
             downloads. The per-instance `key` counter is the reload
             mechanism. */
          tabs.map((tab) => (
            <iframe
              className="buzz-webpanel-frame"
              data-inactive={tab.active ? "false" : "true"}
              key={`${tab.instanceId}:${reloadCounters[tab.instanceId] ?? 0}`}
              src={tab.panel.url}
              title={tab.panel.title}
            />
          ))
        )}
      </div>
    </section>
  );
}
