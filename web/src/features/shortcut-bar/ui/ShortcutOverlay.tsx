import { useShortcutDock } from "../hooks.ts";
import { WebPanelDock } from "@/features/webPanels/ui/WebPanelDock";

/**
 * A shortcut's overlay mode: the clicked row's site fills the main pane as a
 * WebPanelDock — the same middle-pane layout Files uses, tabs row included —
 * not a dialog.
 *
 * The panel registry is the sidebar list's overlay-mode shortcuts and the tab
 * session is a single global one, so reopening the overlay restores the tab
 * set whatever conversation is behind it. `initialPanelId` (the clicked row)
 * is focused if a tab for it survived, opened otherwise.
 */
export function ShortcutOverlay({
  initialPanelId,
  onClose,
}: {
  initialPanelId: string;
  onClose: () => void;
}) {
  const dock = useShortcutDock();
  return (
    <WebPanelDock
      dock={dock}
      initialPanelId={initialPanelId}
      onClose={onClose}
    />
  );
}
