import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useTheme } from "@/shared/theme/ThemeProvider";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { isNativeIOS } from "@/shared/platform/native";
import { openInAppBrowser } from "@/shared/platform/native-navigation";

import { type ActiveWebState, webViewKey } from "../lib/activeWebView.ts";
import { type WebPanelDef, withThemeParam } from "../lib/panelRegistry.ts";

/** How long a frame may stay blank before we suggest opening it directly. */
const EMBED_STALL_MS = 8_000;

/**
 * The always-mounted web layer over the main pane (plan items 3 + 4).
 *
 * The shell mounts this ONCE, as a sibling layer of the conversation rather
 * than a branch of the pane ternary, so neither side ever unmounts: clicking a
 * link shows its frame, clicking a conversation hides the layer, and both are
 * instant because nothing reloads. Which frame shows, which frames stay alive
 * (an LRU of `KEEP_ALIVE`), and full screen all come from ONE state
 * (`lib/activeWebView.ts`) — this component only renders it.
 *
 * Frames render in a stable (sorted) order, never LRU order: React moves a
 * keyed node to reorder it, and moving an iframe in the DOM reloads it.
 * Hidden frames stay mounted with opacity 0 + `inert`, which is what keeps
 * scroll, half-typed forms and the embedded site's session.
 *
 * The bar above the page holds exactly two controls (Sam, 2026-09-26): Full
 * screen and Open in new tab. Navigation is the sidebar; Esc leaves full
 * screen first, then returns to the conversation.
 *
 * A browser cannot force a site to embed; a frame that never fires `load`
 * gets an "open it in a new tab" notice instead of white space. On native
 * iOS there are no iframes at all (WebKit drops a framed site's cookie), so
 * the active page opens in the in-app browser.
 */
export function WebFrameHost({
  state,
  resolve,
  onFocusModeChange,
  onHide,
  fallback,
}: {
  state: ActiveWebState;
  /** Panel for a frame key, or null when it no longer exists. */
  resolve: (key: string) => WebPanelDef | null;
  onFocusModeChange: (focused: boolean) => void;
  onHide: () => void;
  /** Shown when the active target has no panel (e.g. Files not set up). */
  fallback?: ReactNode;
}) {
  const { isDark } = useTheme();
  const activeKey = state.active ? webViewKey(state.active) : null;
  const activePanel = activeKey ? resolve(activeKey) : null;
  const visible = activeKey !== null;
  const focused = visible && state.focus;
  const [stalled, setStalled] = useState<Record<string, boolean>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  const inAppBrowser = isNativeIOS();
  const activeUrl = activePanel
    ? withThemeParam(activePanel.url, isDark)
    : null;

  useEffect(() => {
    if (!visible) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Escape backs out one level: full screen first, then the page.
      if (focused) {
        onFocusModeChange(false);
      } else {
        onHide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focused, onFocusModeChange, onHide]);

  useEffect(() => {
    if (inAppBrowser && visible && activeUrl) {
      openInAppBrowser(activeUrl);
    }
  }, [inAppBrowser, visible, activeUrl]);

  // One stall timer per mounted frame that has not loaded yet.
  const mountedKey = state.mounted.join("\n");
  useEffect(() => {
    const keys = mountedKey ? mountedKey.split("\n") : [];
    const timers = keys
      .filter((key) => !loadedRef.current.has(key))
      .map((key) =>
        window.setTimeout(() => {
          if (!loadedRef.current.has(key)) {
            setStalled((current) => ({ ...current, [key]: true }));
          }
        }, EMBED_STALL_MS),
      );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [mountedKey]);

  const frameKeys = [...state.mounted].sort();

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "absolute inset-0 z-20 flex min-h-0 flex-col bg-background",
        !visible && "pointer-events-none invisible",
      )}
      data-active={activeKey ?? ""}
      data-testid="web-frame-host"
      inert={!visible}
    >
      {visible && !focused && activePanel ? (
        <div
          className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-secondary px-2"
          data-testid="web-panel-dock-header"
        >
          <button
            aria-label="Full screen"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="web-panel-dock-focus"
            onClick={() => onFocusModeChange(true)}
            title="Full screen"
            type="button"
          >
            <Maximize2 aria-hidden className="size-4" />
          </button>
          <a
            aria-label={`Open ${activePanel.label} in a new tab`}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="web-panel-open-external"
            href={activePanel.url}
            rel="noreferrer noopener"
            target="_blank"
            title="Open in new tab"
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {inAppBrowser ? (
          activePanel && activeUrl ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
              data-testid="web-panel-in-app"
            >
              <p className="max-w-sm text-sm text-muted-foreground">
                {activePanel.label} opens in an in-app browser on iPhone, so its
                sign-in works.
              </p>
              <Button
                onClick={() => openInAppBrowser(activeUrl)}
                size="sm"
                type="button"
                variant="outline"
              >
                Open {activePanel.label}
              </Button>
            </div>
          ) : null
        ) : (
          frameKeys.map((key) => {
            const panel = resolve(key);
            if (!panel) {
              return null;
            }
            const selected = key === activeKey;
            return (
              <iframe
                className={cn(
                  "absolute inset-0 h-full w-full border-0 bg-background",
                  selected ? "z-10" : "pointer-events-none opacity-0",
                )}
                data-testid={`web-panel-frame-${key}`}
                inert={!selected}
                key={key}
                onLoad={() => {
                  loadedRef.current.add(key);
                  setStalled((current) =>
                    current[key] ? { ...current, [key]: false } : current,
                  );
                }}
                src={withThemeParam(panel.url, isDark)}
                title={panel.label}
              />
            );
          })
        )}

        {visible && !activePanel && fallback ? (
          <div className="absolute inset-0 z-20 bg-background">{fallback}</div>
        ) : null}

        {!inAppBrowser && activeKey && stalled[activeKey] && activePanel ? (
          <div
            className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-2"
            data-testid="web-panel-stalled"
          >
            <p className="min-w-0 text-xs text-muted-foreground">
              {activePanel.label} has not rendered. Some sites refuse to be
              embedded in another page.
            </p>
            <Button asChild size="sm" variant="outline">
              <a
                href={activePanel.url}
                rel="noreferrer noopener"
                target="_blank"
              >
                Open in a new tab
              </a>
            </Button>
          </div>
        ) : null}

        {focused ? (
          // Bottom-right (Sam, 2026-09-24): bottom-left covered the start of
          // document lines. 40px hit target for touch; translucent until
          // hovered/focused so it sits lightly.
          <button
            aria-label="Exit full screen"
            className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-30 flex size-10 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground opacity-60 shadow-md backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100"
            data-testid="web-panel-dock-unfocus"
            onClick={() => onFocusModeChange(false)}
            title="Exit full screen (Esc)"
            type="button"
          >
            <Minimize2 aria-hidden className="size-5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
