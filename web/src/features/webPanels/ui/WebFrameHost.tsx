import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useTheme } from "@/shared/theme/ThemeProvider";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { isNativeIOS } from "@/shared/platform/native";
import { openInAppBrowser } from "@/shared/platform/native-navigation";

import type { FilesPathRequest } from "../filesPathStore.ts";
import { type ActiveWebState, webViewKey } from "../lib/activeWebView.ts";
import { DAILY_DIGEST_KEY } from "../lib/dailyDigest.ts";
import { filesPathUrl } from "../lib/openInFiles.ts";
import { type WebPanelDef, withThemeParam } from "../lib/panelRegistry.ts";
import { withThemeFragment } from "../lib/themePush.ts";
import { readBuzzTheme, useFilesThemePush } from "../useFilesThemePush.ts";

/** How long a frame may stay blank before we suggest opening it directly. */
const EMBED_STALL_MS = 8_000;

/** Layered UI whose own Escape must not also back out of the page. */
const LAYER_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';

const isFilesKey = (key: string | null): key is string =>
  key?.startsWith("files:") ?? false;

/**
 * The always-mounted web layer (plan items 3 + 4; redesign Phase 4).
 *
 * The shell mounts this ONCE, over the main column, as a sibling of the
 * conversation rather than a branch of the pane ternary, so neither side
 * ever unmounts: clicking a link shows its frame, clicking a conversation
 * hides the layer, and both are instant because nothing reloads. Which frame
 * shows, which frames stay alive (an LRU of `KEEP_ALIVE`), and full screen
 * all come from ONE state (`lib/activeWebView.ts`) — this component only
 * renders it. A link page hides the right pane, so it covers the whole row;
 * Files is a page in the main column beside the Work strip.
 *
 * Frames render in a stable (sorted) order, never LRU order: React moves a
 * keyed node to reorder it, and moving an iframe in the DOM reloads it.
 * Hidden frames stay mounted with opacity 0 + `inert`, which is what keeps
 * scroll, half-typed forms and the embedded site's session.
 *
 * Files frames take Buzz's live theme by postMessage (`useFilesThemePush`),
 * so their `src` is fixed when they mount — a theme switch repaints them in
 * place instead of reloading them. "Open in Files" (`filesPath`) is the one
 * thing that reloads a Files frame: stash reads `?path=` only at boot.
 *
 * Controls (Sam, 2026-09-26): exactly two, Full screen and Open in new tab.
 * A link page carries them in a bar above it; Files has its own header, so
 * they float bottom-right (where Exit full screen sits) and the page matches
 * the Files artboard. Esc leaves full screen first, then returns to the
 * conversation.
 *
 * A browser cannot force a site to embed; a frame that never fires `load`
 * gets an "open it in a new tab" notice instead of white space. On native
 * iOS Files/Links open in the in-app browser (WebKit drops a framed site's
 * cookie); the cookie-free Daily Digest stays embedded and alive here.
 */
export function WebFrameHost({
  state,
  resolve,
  onFocusModeChange,
  onHide,
  fallback,
  filesPath = null,
}: {
  state: ActiveWebState;
  /** Panel for a frame key, or null when it no longer exists. */
  resolve: (key: string) => WebPanelDef | null;
  onFocusModeChange: (focused: boolean) => void;
  onHide: () => void;
  /** Shown when the active target has no panel (e.g. Files not set up). */
  fallback?: ReactNode;
  /** The latest "Open in Files" request (`filesPathStore`). */
  filesPath?: FilesPathRequest | null;
}) {
  const { isDark } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const activeKey = state.active ? webViewKey(state.active) : null;
  const activePanel = activeKey ? resolve(activeKey) : null;
  const visible = activeKey !== null;
  const focused = visible && state.focus;
  const filesPage = isFilesKey(activeKey);
  const [stalled, setStalled] = useState<Record<string, boolean>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  // Digest has no sign-in cookies to preserve and stays in the main pane
  // on iPhone too. Files/Links retain their native browser login path.
  const nativeIOS = isNativeIOS();
  const inAppBrowser = nativeIOS && state.active?.kind !== "digest";
  useFilesThemePush(hostRef, !inAppBrowser);

  // "Open in Files": a NEW request (not one made before this mounted) is
  // pinned to the Files frame on screen when it arrives.
  const [paths, setPaths] = useState<Record<string, FilesPathRequest>>({});
  const handledNonce = useRef(filesPath?.nonce ?? 0);
  useEffect(() => {
    if (
      filesPath &&
      filesPath.nonce !== handledNonce.current &&
      isFilesKey(activeKey)
    ) {
      handledNonce.current = filesPath.nonce;
      setPaths((current) => ({ ...current, [activeKey]: filesPath }));
    }
  }, [filesPath, activeKey]);

  /** Files frames: the URL they load, before any theme is added. */
  const filesBaseUrl = (key: string, panel: WebPanelDef) => {
    const path = paths[key];
    return (path && filesPathUrl(panel.url, path.path)) ?? panel.url;
  };
  // A Files frame's src is computed once per mounted instance (the React key
  // changes only with a new Open in Files request or a new panel URL).
  const srcCache = useRef(new Map<string, string>());
  const frameKeys = state.mounted
    .filter((key) => !nativeIOS || key === DAILY_DIGEST_KEY)
    .sort();
  const reactKeyFor = (key: string) =>
    paths[key] ? `${key}#${paths[key].nonce}` : key;
  const frameSrc = (key: string, panel: WebPanelDef): string => {
    if (key === DAILY_DIGEST_KEY) {
      return panel.url;
    }
    if (!isFilesKey(key)) {
      return withThemeParam(panel.url, isDark);
    }
    const cacheKey = `${reactKeyFor(key)}\n${panel.url}`;
    let src = srcCache.current.get(cacheKey);
    if (src === undefined) {
      src = withThemeFragment(
        withThemeParam(filesBaseUrl(key, panel), isDark),
        readBuzzTheme(),
      );
      srcCache.current.set(cacheKey, src);
    }
    return src;
  };

  // The in-app browser (iOS) cannot take a push, so the Files URL carries
  // the theme fragment. It reopens only when the page, its folder or the
  // polarity changes — never for an accent tweak (stash parity §2.8).
  const activeBase =
    activePanel && activeKey
      ? filesPage
        ? withThemeParam(filesBaseUrl(activeKey, activePanel), isDark)
        : withThemeParam(activePanel.url, isDark)
      : null;
  const inAppUrl = () =>
    activeBase && filesPage
      ? withThemeFragment(activeBase, readBuzzTheme())
      : activeBase;

  useEffect(() => {
    if (!visible) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // An open popover, menu or dialog owns this Escape (the Vitals panel
      // over Files, say): it closes, and the page stays.
      const target = event.target as Partial<Element> | null;
      if (
        typeof target?.closest === "function" &&
        target.closest(LAYER_SELECTOR)
      ) {
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

  const inAppUrlRef = useRef(inAppUrl);
  inAppUrlRef.current = inAppUrl;
  useEffect(() => {
    const url = activeBase ? inAppUrlRef.current() : null;
    if (inAppBrowser && visible && url) {
      openInAppBrowser(url);
    }
  }, [inAppBrowser, visible, activeBase]);

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

  const activeStalled =
    !inAppBrowser && activeKey !== null && stalled[activeKey] === true;
  const controls =
    visible && !focused && activePanel ? (
      <>
        <button
          aria-label="Full screen"
          className={cn(
            "grid place-items-center text-muted-foreground hover:bg-accent hover:text-foreground",
            filesPage ? "size-9 rounded-full" : "rounded-md p-1.5",
          )}
          data-testid="web-panel-dock-focus"
          onClick={() => onFocusModeChange(true)}
          title="Full screen"
          type="button"
        >
          <Maximize2 aria-hidden className="size-4" />
        </button>
        <a
          aria-label={`Open ${activePanel.label} in a new tab`}
          className={cn(
            "grid place-items-center text-muted-foreground hover:bg-accent hover:text-foreground",
            filesPage ? "size-9 rounded-full" : "rounded-md p-1.5",
          )}
          data-testid="web-panel-open-external"
          href={activePanel.url}
          rel="noreferrer noopener"
          target="_blank"
          title="Open in new tab"
        >
          <ExternalLink aria-hidden className="size-4" />
        </a>
      </>
    ) : null;

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
      ref={hostRef}
    >
      {controls && !filesPage ? (
        <div
          className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-secondary px-2"
          data-testid="web-panel-dock-header"
        >
          {controls}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {inAppBrowser ? (
          activePanel && activeBase ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
              data-testid="web-panel-in-app"
            >
              <p className="max-w-sm text-sm text-muted-foreground">
                {activePanel.label} opens in an in-app browser on iPhone, so its
                sign-in works.
              </p>
              <Button
                onClick={() => {
                  const url = inAppUrl();
                  if (url) {
                    openInAppBrowser(url);
                  }
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Open {activePanel.label}
              </Button>
            </div>
          ) : null
        ) : null}
        {frameKeys.map((key) => {
          const panel = resolve(key);
          if (!panel) {
            return null;
          }
          const selected = key === activeKey;
          const themed = isFilesKey(key);
          return (
            <iframe
              className={cn(
                "absolute inset-0 h-full w-full border-0 bg-background",
                selected ? "z-10" : "pointer-events-none opacity-0",
              )}
              data-testid={`web-panel-frame-${key}`}
              // THEME_FRAME_ATTR: the theme push's frame selector.
              data-buzz-theme-push={themed ? "true" : undefined}
              inert={!selected}
              key={reactKeyFor(key)}
              onLoad={() => {
                loadedRef.current.add(key);
                setStalled((current) =>
                  current[key] ? { ...current, [key]: false } : current,
                );
              }}
              src={frameSrc(key, panel)}
              title={panel.label}
            />
          );
        })}

        {visible && !activePanel && fallback ? (
          <div className="absolute inset-0 z-20 bg-background">{fallback}</div>
        ) : null}

        {controls && filesPage && !inAppBrowser && !activeStalled ? (
          // Bottom-right, where Exit full screen sits: one place for the
          // page's two controls. Translucent until hovered or focused.
          <div
            className="absolute right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex items-center gap-0.5 rounded-full border border-border bg-background/80 p-0.5 opacity-70 shadow-md backdrop-blur transition-opacity focus-within:opacity-100 hover:opacity-100"
            data-testid="web-panel-files-controls"
          >
            {controls}
          </div>
        ) : null}

        {activeStalled && activePanel ? (
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
