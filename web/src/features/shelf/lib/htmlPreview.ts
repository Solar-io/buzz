/**
 * How a shared HTML file is previewed (phase-6.md Risks, "HTML preview").
 *
 * The relay serves HTML as an inert download (`attachment`, `nosniff`,
 * `CSP default-src 'none'`), and that stays. The previewer fetches the bytes
 * with the signed GET and hands them to an iframe as `srcdoc`, sandboxed
 * with `allow-scripts` and NOTHING else:
 *
 * - no `allow-same-origin` — the document runs in an opaque origin, so it
 *   cannot read this app's localStorage, IndexedDB or cookies, nor reach
 *   into `parent.document` (the Buzz key lives in this origin's storage);
 * - no `allow-top-navigation*` — it cannot navigate the app away;
 * - no `allow-popups`, `allow-forms`, `allow-modals` — it cannot open
 *   windows, submit forms or block the app with dialogs.
 *
 * It never points an iframe at the media URL: that would hand the frame a
 * real origin (the relay's) and a URL that carries no preview at all.
 *
 * Pure so `node --test` can pin the attributes.
 */

/** The ONLY sandbox token the preview frame carries. */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

export interface HtmlPreviewFrame {
  sandbox: string;
  srcDoc: string;
  referrerPolicy: "no-referrer";
  /** Permissions policy: no camera, mic, geolocation, payment… */
  allow: string;
}

export function htmlPreviewFrame(html: string): HtmlPreviewFrame {
  return {
    sandbox: HTML_PREVIEW_SANDBOX,
    srcDoc: html,
    referrerPolicy: "no-referrer",
    allow: "",
  };
}
