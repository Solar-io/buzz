import { useCallback, useMemo, useState } from "react";

import { FilesSetup } from "@/features/files/ui/FilesPanel";
import { useShortcutBar } from "@/features/shortcut-bar/hooks";

import type { ActiveWebView } from "../activeWebStore.ts";
import { useFilesPathRequest } from "../filesPathStore.ts";
import { useWebPanelDock } from "../hooks.ts";
import type { WebPanelDef } from "../lib/panelRegistry.ts";
import { WebFrameHost } from "./WebFrameHost.tsx";

/**
 * The shell's web layer: resolves frame keys against the two registries —
 * Files sites (`files:<id>`) and overlay-mode Links (`link:<id>`) — and
 * renders the one {@link WebFrameHost}. Links come from the shared, seeded
 * Links store, so opening a link never opens a second subscription or waits
 * on a second decrypt.
 */
export function WebLayer({ web }: { web: ActiveWebView }) {
  const files = useWebPanelDock();
  const { shortcuts } = useShortcutBar();
  const filesPath = useFilesPathRequest();
  // Saving the first Files URL changes a setting, not React state; this bump
  // re-renders so the registry re-reads it and the new site resolves.
  const [, setConfiguredAt] = useState(0);

  const links = useMemo(() => {
    const map = new Map<string, WebPanelDef>();
    for (const shortcut of shortcuts) {
      if (shortcut.mode === "overlay") {
        map.set(shortcut.id, {
          id: shortcut.id,
          label: shortcut.label,
          url: shortcut.url,
          custom: true,
        });
      }
    }
    return map;
  }, [shortcuts]);

  const resolve = useCallback(
    (key: string): WebPanelDef | null => {
      if (key.startsWith("link:")) {
        return links.get(key.slice("link:".length)) ?? null;
      }
      if (key.startsWith("files:")) {
        const id = key.slice("files:".length);
        return files.panels.find((panel) => panel.id === id) ?? null;
      }
      return null;
    },
    [links, files.panels],
  );

  return (
    <WebFrameHost
      filesPath={filesPath}
      fallback={
        web.state.active?.kind === "files" ? (
          <FilesSetup
            onClose={web.hide}
            onConfigured={() => setConfiguredAt(Date.now())}
          />
        ) : null
      }
      onFocusModeChange={web.setFocus}
      onHide={web.hide}
      resolve={resolve}
      state={web.state}
    />
  );
}
