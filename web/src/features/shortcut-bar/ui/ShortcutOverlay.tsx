import { useShortcutDock } from "../hooks.ts";
import { WebPanelDock } from "@/features/webPanels/ui/WebPanelDock";

/**
 * A shortcut's overlay mode: the clicked site fills the main pane as a
 * WebPanelDock — the same middle-pane layout Files uses, tabs row included —
 * not a dialog.
 *
 * The panel registry is this channel's overlay-mode shortcuts and the tab
 * session persists per channel, so reopening a channel's overlay restores
 * its tab set. `initialPanelId` (the clicked pill) is focused if a tab for
 * it survived, opened otherwise.
 */
export function ShortcutOverlay({
  channelId,
  initialPanelId,
  onClose,
}: {
  channelId: string;
  initialPanelId: string;
  onClose: () => void;
}) {
  const dock = useShortcutDock(channelId);
  return (
    <WebPanelDock
      dock={dock}
      initialPanelId={initialPanelId}
      onClose={onClose}
    />
  );
}
