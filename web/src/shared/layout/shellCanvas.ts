import { useEffect } from "react";

/**
 * Canvas-below-the-shell split (Sam, 2026-09-26). On iPad Safari
 * (viewport-fit=cover, floating toolbar) the `h-dvh` shell can end above the
 * bottom of the painted page, exposing a strip of the page canvas. globals.css
 * paints `html` as a two-tone gradient split at this var, so that strip
 * continues the sidebar colour under the sidebar and the main colour under the
 * main pane.
 */
export const SHELL_SIDEBAR_WIDTH_VAR = "--buzz-shell-sidebar-w";

type StyleTarget = Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;

/** The canvas split width: 0 when the desktop sidebar is not shown. */
export function shellSidebarWidth(opts: {
  chromeless: boolean;
  phone: boolean;
  width: string;
}): string {
  return opts.chromeless || opts.phone ? "0px" : opts.width;
}

/** Publish `width` on `style`; the returned cleanup removes it. */
export function publishShellSidebarWidth(
  style: StyleTarget,
  width: string,
): () => void {
  style.setProperty(SHELL_SIDEBAR_WIDTH_VAR, width);
  return () => style.removeProperty(SHELL_SIDEBAR_WIDTH_VAR);
}

/** Publish the split on <html> for as long as the calling shell is mounted. */
export function useShellSidebarWidthVar(width: string): void {
  useEffect(() => {
    const style = globalThis.document?.documentElement?.style;
    if (!style) return;
    return publishShellSidebarWidth(style, width);
  }, [width]);
}
