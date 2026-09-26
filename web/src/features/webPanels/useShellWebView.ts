import { useCallback, useEffect, useRef } from "react";

import { useShortcutBar } from "@/features/shortcut-bar/hooks";

import { type ActiveWebView, useActiveWebView } from "./activeWebStore.ts";
import { useWebPanelDock } from "./hooks.ts";
import { pickFilesPanel } from "./lib/activeWebView.ts";

/**
 * The shell's entry points into the web layer, kept out of `repos.tsx` so the
 * route stays under the file-size ceiling. Every open works from any state —
 * another link, Files, or a conversation — and never refuses.
 *
 * `navKey` identifies the conversation/view the URL shows. When it CHANGES —
 * a channel or DM click, a search result, a palette jump, a toast, a
 * permalink, from whatever entry point — the layer hides (frames stay alive)
 * so the conversation shows. The first value is not a change: Settings'
 * "Open" on a Files site sets the layer and then routes here.
 */
export function useShellWebView(navKey: string): {
  web: ActiveWebView;
  openFiles: () => void;
  openLink: (linkId: string) => void;
  /** Label of the page showing (the phone top bar's title), else null. */
  activeTitle: string | null;
} {
  const web = useActiveWebView();
  const files = useWebPanelDock();
  const { show, hide } = web;
  const lastNavKey = useRef(navKey);
  useEffect(() => {
    if (lastNavKey.current !== navKey) {
      lastNavKey.current = navKey;
      hide();
    }
  }, [navKey, hide]);
  const mounted = web.state.mounted;
  const filesIds = files.panels.map((panel) => panel.id).join("\n");
  const openFiles = useCallback(() => {
    show({
      kind: "files",
      panelId: pickFilesPanel(filesIds ? filesIds.split("\n") : [], mounted),
    });
  }, [show, filesIds, mounted]);
  const openLink = useCallback(
    (linkId: string) => show({ kind: "link", panelId: linkId }),
    [show],
  );
  const { shortcuts } = useShortcutBar();
  const active = web.state.active;
  const activeTitle =
    active === null
      ? null
      : active.kind === "link"
        ? (shortcuts.find((s) => s.id === active.panelId)?.label ?? null)
        : (files.panels.find((p) => p.id === active.panelId)?.label ?? "Files");
  return { web, openFiles, openLink, activeTitle };
}
