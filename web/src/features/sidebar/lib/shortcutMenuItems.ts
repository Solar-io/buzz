import type { SidebarMenuItem } from "./sidebarMenuItem.ts";

/**
 * The menu a sidebar shortcut row offers: Edit… and Remove.
 *
 * A plain list, like `channelMenuItems` — both the right-click menu and the
 * `⋯` overflow render the same shape. The labels are the shortcut bar's own
 * ("Edit…" / "Remove"), so the two surfaces of this feature read the same.
 */
export function shortcutMenuItems(actions: {
  onEdit: () => void;
  onRemove: () => void;
}): SidebarMenuItem[] {
  return [
    { label: "Edit…", onSelect: actions.onEdit },
    { label: "Remove", danger: true, onSelect: actions.onRemove },
  ];
}
