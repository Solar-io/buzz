import { registerPlugin } from "@capacitor/core";
import { toast } from "sonner";
import { isNativeIOS } from "./native.ts";
import { publicAppOrigin } from "../lib/relay-url.ts";

const BuzzLinks = registerPlugin<{ openExternal(options: { url: string }): Promise<void> }>("BuzzLinks");
const EXTERNAL = new Set(["https:", "http:", "mailto:", "tel:"]);

/** One boundary for raw anchors and window.open. File-viewer handlers run
 * first and preventDefault; in-app route anchors remain in the shared router. */
export function installNativeNavigation(): void {
  if (!isNativeIOS()) return;
  const open = (url: URL) => { void BuzzLinks.openExternal({ url: url.href }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open link.")); };
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.getAttribute("href") ?? "", window.location.href);
    if (!EXTERNAL.has(url.protocol)) return;
    event.preventDefault(); open(url);
  });
  const browserOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url) {
      const resolved = new URL(String(url), publicAppOrigin());
      if (EXTERNAL.has(resolved.protocol)) { open(resolved); return null; }
    }
    return browserOpen(url, target, features);
  }) as typeof window.open;
}
