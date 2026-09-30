import { type RefObject, useEffect } from "react";

import {
  type BuzzThemePayload,
  buildThemePayload,
  isFilesReady,
  panelOrigin,
} from "./lib/themePush.ts";

/** Iframes that take the theme push (the Files frames) carry this. */
export const THEME_FRAME_ATTR = "data-buzz-theme-push";

/** Buzz's live theme, read off `<html>` as the browser resolved it. */
export function readBuzzTheme(): BuzzThemePayload {
  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  return buildThemePayload(
    (name) => style.getPropertyValue(name),
    root.classList.contains("dark"),
  );
}

/**
 * Post the payload into one Files frame. `targetOrigin` is the origin of the
 * frame's OWN src — the panel's origin, exactly — never `*`: if the frame has
 * navigated elsewhere (a sign-in hop), the browser drops the message.
 */
export function postThemeToFrame(
  frame: HTMLIFrameElement,
  payload: BuzzThemePayload,
): boolean {
  const origin = panelOrigin(frame.getAttribute("src"));
  const target = frame.contentWindow;
  if (!origin || !target) {
    return false;
  }
  target.postMessage(payload, origin);
  return true;
}

function themeFrames(host: HTMLElement | null): HTMLIFrameElement[] {
  if (!host) {
    return [];
  }
  return Array.from(
    host.querySelectorAll<HTMLIFrameElement>(`iframe[${THEME_FRAME_ATTR}]`),
  );
}

/**
 * Keep every Files frame under `hostRef` on Buzz's live theme (stash §4.2):
 *
 * - answer a frame's `{type:"files:ready"}` at once — only from one of OUR
 *   Files frames, and only when the message comes from that frame's origin;
 * - push on every change to `<html>`'s class / style / palette attributes,
 *   which is where every theme writer lands (theme switch, fixed palette,
 *   accent, follow-system, custom gradient), coalesced to one animation
 *   frame and skipped when the payload did not actually change.
 *
 * Hidden (kept-alive) Files frames are pushed too, so showing one later
 * never flashes an old theme.
 */
export function useFilesThemePush(
  hostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let last = "";
    let scheduled = false;
    const push = () => {
      scheduled = false;
      const payload = readBuzzTheme();
      const json = JSON.stringify(payload);
      if (json === last) {
        return;
      }
      last = json;
      for (const frame of themeFrames(hostRef.current)) {
        postThemeToFrame(frame, payload);
      }
    };
    const schedule = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(push);
      } else {
        window.setTimeout(push, 0);
      }
    };
    const observer = new window.MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "data-palette",
        "data-custom-gradient",
      ],
    });
    const onMessage = (event: MessageEvent) => {
      if (!isFilesReady(event.data)) {
        return;
      }
      const frame = themeFrames(hostRef.current).find(
        (candidate) =>
          candidate.contentWindow !== null &&
          candidate.contentWindow === event.source,
      );
      if (!frame || panelOrigin(frame.getAttribute("src")) !== event.origin) {
        return;
      }
      postThemeToFrame(frame, readBuzzTheme());
    };
    window.addEventListener("message", onMessage);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, [enabled, hostRef]);
}
