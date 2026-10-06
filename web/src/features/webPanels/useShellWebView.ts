import { useCallback, useEffect, useRef } from "react";

import { useShortcutBar } from "@/features/shortcut-bar/hooks";

import { type ActiveWebView, useActiveWebView } from "./activeWebStore.ts";
import { useFilesPathRequest } from "./filesPathStore.ts";
import { useWebPanelDock } from "./hooks.ts";
import { pickFilesPanel, webLayerMode } from "./lib/activeWebView.ts";
import { DAILY_DIGEST_PANEL } from "./lib/dailyDigest.ts";

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
  /** Files beside the Work strip, a page over the row, or nothing. */
  layerMode: ReturnType<typeof webLayerMode>;
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
  // "Open in Files" (`openInFiles`): each request brings Files up inside
  // Buzz (sidebar stays — never full screen); the frame host loads that
  // Files frame on the requested file.
  // A request made before this shell mounted is not a new one.
  const pathNonce = useFilesPathRequest()?.nonce ?? 0;
  const handledNonce = useRef(pathNonce);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  useEffect(() => {
    if (pathNonce !== handledNonce.current) {
      handledNonce.current = pathNonce;
      openFilesRef.current();
    }
  }, [pathNonce]);
  const openLink = useCallback(
    (linkId: string) => show({ kind: "link", panelId: linkId }),
    [show],
  );
  const { shortcuts } = useShortcutBar();
  const active = web.state.active;
  const activeTitle =
    active === null
      ? null
      : active.kind === "digest"
        ? DAILY_DIGEST_PANEL.label
        : active.kind === "link"
          ? (shortcuts.find((s) => s.id === active.panelId)?.label ?? null)
          : (files.panels.find((p) => p.id === active.panelId)?.label ??
            "Files");
  return {
    web,
    openFiles,
    openLink,
    activeTitle,
    layerMode: webLayerMode(web.state),
  };
}
