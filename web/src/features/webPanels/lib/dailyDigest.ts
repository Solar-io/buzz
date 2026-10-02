import { type WebViewTarget, webViewKey } from "./activeWebView.ts";
import type { WebPanelDef } from "./panelRegistry.ts";

/** Built-in tailnet edition, independent of the user's Files and Links. */
export const DAILY_DIGEST_PANEL: WebPanelDef = {
  id: "daily-digest",
  label: "Daily Digest",
  url: "https://crichton.tailb3d4b8.ts.net:6450/edition/latest.html",
  custom: false,
};

/** The sidebar and shell share one stable keep-alive target. */
export const DAILY_DIGEST_TARGET: WebViewTarget = {
  kind: "digest",
  panelId: DAILY_DIGEST_PANEL.id,
};

/** Frame key in the shared web layer's LRU. */
export const DAILY_DIGEST_KEY = webViewKey(DAILY_DIGEST_TARGET);
