import * as React from "react";
import { LogIn, Maximize2, Minimize2, RotateCw, X } from "lucide-react";

import type { WebPanelDef } from "./webPanels.config";

const DOCK_HEIGHT_STORAGE_KEY = "buzz-webpanel-dock-height";
const DOCK_HEIGHT_MIN = 180;
const DOCK_HEIGHT_DEFAULT = 320;
const DOCK_HEIGHT_MAX_RATIO = 0.7;
const NOOP = () => {};

function dockHeightLimit() {
  return window.innerHeight * DOCK_HEIGHT_MAX_RATIO;
}

function clampDockHeight(height: number) {
  return Math.max(DOCK_HEIGHT_MIN, Math.min(dockHeightLimit(), height));
}

type WebPanelSubstrateProps = {
  panel: WebPanelDef;
  mode?: "docked" | "maximized";
  visible?: boolean;
  onHide?: () => void;
  onModeChange?: (mode: "docked" | "maximized") => void;
  /** Opens the login companion window for this panel's URL. */
  onLogin?: () => void;
};

export function WebPanelSubstrate({
  panel,
  mode = "docked",
  visible = true,
  onHide = NOOP,
  onModeChange = NOOP,
  onLogin = NOOP,
}: WebPanelSubstrateProps) {
  const substrateRef = React.useRef<HTMLElement>(null);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [dockHeight, setDockHeight] = React.useState(() => {
    const stored = Number.parseInt(
      window.localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY) ?? "",
      10,
    );
    return Number.isFinite(stored) ? stored : DOCK_HEIGHT_DEFAULT;
  });

  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const persistDockHeight = (height: number) => {
    window.localStorage.setItem(
      DOCK_HEIGHT_STORAGE_KEY,
      String(Math.round(height)),
    );
  };

  const resizeByKeyboard = (delta: number) => {
    const next = clampDockHeight(dockHeight + delta);
    setDockHeight(next);
    persistDockHeight(next);
  };

  const startPointerResize = (event: React.PointerEvent<HTMLHRElement>) => {
    event.preventDefault();
    dragCleanupRef.current?.();
    const handle = event.currentTarget;
    const substrate = substrateRef.current;
    if (!substrate) return;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    substrate.dataset.webpanelResizing = "true";
    const startY = event.clientY;
    const startHeight = dockHeight;
    let nextHeight = startHeight;
    let frame = 0;
    const applyHeight = () => {
      frame = 0;
      substrate.style.height = `${nextHeight}px`;
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
      setDockHeight(nextHeight);
      persistDockHeight(nextHeight);
    };
    dragCleanupRef.current = cleanup;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  const PanelIcon = panel.icon;

  return (
    <section
      aria-label={panel.label}
      className="buzz-webpanel-substrate"
      data-webpanel-mode={mode}
      data-webpanel-visible={visible ? "true" : "false"}
      ref={substrateRef}
      style={mode === "docked" ? { height: dockHeight } : undefined}
    >
      {mode === "docked" ? (
        <hr
          aria-label={`Resize ${panel.label} panel`}
          aria-orientation="horizontal"
          aria-valuemax={Math.round(dockHeightLimit())}
          aria-valuemin={DOCK_HEIGHT_MIN}
          aria-valuenow={Math.round(dockHeight)}
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
        <div className="buzz-webpanel-title">
          <PanelIcon />
          <span>{panel.label}</span>
        </div>
        {/* Manual affordances only in v1: no auth-state detection, no
            postMessage protocol, no polling. The login hop shares the app's
            cookie jar; Reload remounts the iframe to pick the cookies up. */}
        <div className="buzz-webpanel-readout">
          <button
            aria-label={`Log in to ${panel.label}`}
            className="buzz-webpanel-window-action"
            onClick={onLogin}
            title={`${panel.label} login`}
            type="button"
          >
            <LogIn />
          </button>
          <button
            aria-label={`Reload ${panel.label}`}
            className="buzz-webpanel-window-action"
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            <RotateCw />
          </button>
          <button
            aria-label={
              mode === "maximized"
                ? `Restore ${panel.label} panel`
                : `Maximize ${panel.label} panel`
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
            aria-label={`Hide ${panel.label} panel`}
            className="buzz-webpanel-window-action"
            onClick={onHide}
            type="button"
          >
            <X />
          </button>
        </div>
      </div>
      <div className="buzz-webpanel-viewport">
        {/* No `sandbox` attribute: the panel app needs cookies and downloads.
            `key` is the reload mechanism — remounting re-requests the URL with
            the current cookie jar without touching app state. */}
        <iframe
          className="buzz-webpanel-frame"
          key={reloadKey}
          src={panel.url}
          title={panel.title}
        />
      </div>
    </section>
  );
}
