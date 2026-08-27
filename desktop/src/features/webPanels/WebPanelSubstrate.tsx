import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  House,
  LogIn,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";

import type { WebPanelDef } from "./webPanels.config";
import {
  E2E_BUILD_FORCES_IFRAME,
  showsCustomNativeNote,
} from "./webPanels.config";
import {
  openAddSiteWindow,
  removeCustomSite,
  subscribeCustomPanelAdded,
} from "./webPanelRegistry";
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

  // Back/Forward/Home share the reload IPC shape: ids only, never an
  // address. Empty history back/forward is an engine-level no-op; the
  // buttons stay unconditionally enabled because the child webview's
  // history state is not readable from the app without handing foreign
  // pages an IPC channel.
  const navigateActive = (
    command: "web_panel_back" | "web_panel_forward" | "web_panel_home",
  ) => {
    if (!activeTab || !activePanel || !native) return;
    invoke(command, {
      instanceId: activeTab.instanceId,
      panelId: activePanel.id,
    }).catch((error) => {
      console.error("web panel navigation failed", error);
    });
  };

  // The add flow opens the trusted add window; the typed form there is
  // the owner-intent proof (the Rust command checks the caller webview's
  // label — this app webview can never supply a URL). Success arrives as
  // the Rust-broadcast custom-panel-added event, which the subscription
  // below turns into a freshly opened tab.
  const addSite = async () => {
    setPickerOpen(false);
    await openAddSiteWindow();
  };

  React.useEffect(
    () =>
      subscribeCustomPanelAdded((panel) => {
        onOpenInstance(panel.id);
      }),
    // Re-subscribing on an unstable callback is cheap (a Set swap); the
    // registry keeps the single event channel regardless.
    [onOpenInstance],
  );

  const removeSite = async (panelId: string) => {
    setPickerOpen(false);
    const result = await removeCustomSite(panelId);
    if (result !== "removed") return;
    // The webviews of a removed site are this frontend's problem: closing
    // its tabs drives destroy_web_panel through the usual store path.
    for (const tab of tabs.filter((entry) => entry.panel.id === panelId)) {
      onCloseTab(tab.instanceId);
    }
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
              const open = () => {
                setPickerOpen(false);
                onOpenInstance(panel.id);
              };
              if (!panel.custom) {
                return (
                  <button
                    className="buzz-webpanel-picker-item"
                    key={panel.id}
                    onClick={open}
                    role="menuitem"
                    type="button"
                  >
                    <PickerIcon />
                    <span>{panel.label}</span>
                  </button>
                );
              }
              // Owner-added site: opens like any panel, plus a remove
              // affordance that runs the native confirm flow.
              return (
                <div
                  className="buzz-webpanel-picker-row"
                  key={panel.id}
                  role="presentation"
                >
                  <button
                    className="buzz-webpanel-picker-item"
                    onClick={open}
                    role="menuitem"
                    type="button"
                  >
                    <PickerIcon />
                    <span>{panel.label}</span>
                  </button>
                  <button
                    aria-label={`Remove site ${panel.label}`}
                    className="buzz-webpanel-picker-remove"
                    onClick={() => void removeSite(panel.id)}
                    type="button"
                  >
                    <X />
                  </button>
                </div>
              );
            })}
            <button
              className="buzz-webpanel-picker-item"
              onClick={() => {
                setPickerOpen(false);
                void addSite();
              }}
              role="menuitem"
              type="button"
            >
              <Plus />
              <span>Add site…</span>
            </button>
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
          {activePanel && native ? (
            /* Native-mode navigation controls. Always enabled: empty
               history is a no-op, and the child webview's history state is
               not observable from the app (see navigateActive). The iframe
               fallback keeps Reload only — cross-origin contentWindow
               history is untouchable. */
            <>
              <button
                aria-label={`Go back in ${activePanel.label}`}
                className="buzz-webpanel-window-action"
                onClick={() => navigateActive("web_panel_back")}
                type="button"
              >
                <ArrowLeft />
              </button>
              <button
                aria-label={`Go forward in ${activePanel.label}`}
                className="buzz-webpanel-window-action"
                onClick={() => navigateActive("web_panel_forward")}
                type="button"
              >
                <ArrowRight />
              </button>
              <button
                aria-label={`Open ${activePanel.label} home`}
                className="buzz-webpanel-window-action"
                onClick={() => navigateActive("web_panel_home")}
                type="button"
              >
                <House />
              </button>
            </>
          ) : null}
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
             (e.g. this header) to come back. Exception: in iframe-forced
             (e2e) builds a custom site has no webview and no URL for a
             frame, so the content area explains that instead. */
          showsCustomNativeNote(activePanel, E2E_BUILD_FORCES_IFRAME) ? (
            <div className="buzz-webpanel-custom-note" role="note">
              {activePanel.label} opens in the native panel view
            </div>
          ) : (
            <div
              aria-hidden="true"
              className="buzz-webpanel-native-placeholder"
              data-webpanel-placeholder={activeTab?.instanceId}
            />
          )
        ) : (
          /* Iframe fallback: every tab stays mounted; inactive tabs are
             display:none — the same keep-alive semantics as native mode.
             Reached only while a static iframe-fallback tab is active;
             custom sites are native by construction (the registry pins
             render:"native" because their URL never crosses the IPC
             boundary), and as inactive tabs here they are filtered out —
             there is no URL for a frame. No `sandbox` attribute: the panel
             app needs cookies and downloads. The per-instance `key`
             counter is the reload mechanism. */
          tabs
            .filter((tab) => tab.panel.url !== null)
            .map((tab) => (
              <iframe
                className="buzz-webpanel-frame"
                data-inactive={tab.active ? "false" : "true"}
                key={`${tab.instanceId}:${reloadCounters[tab.instanceId] ?? 0}`}
                src={tab.panel.url ?? "about:blank"}
                title={tab.panel.title}
              />
            ))
        )}
      </div>
    </section>
  );
}
