/**
 * A row action offered by a sidebar entry's context / overflow menu.
 *
 * This is deliberately a plain data shape rather than a component. Both the
 * right-click menu and the `⋯` overflow menu render the same list through
 * different Radix primitives (ContextMenu has no imperative open-at-a-point
 * API, so the overflow affordance is a DropdownMenu), and a data list is the
 * only thing both can consume.
 *
 * It also resolves a name collision: `@/shared/ui/context-menu` exports
 * `ContextMenuItem` as a *component*, while the sidebar's menus were built
 * around an interface of the same name.
 */
export interface SidebarMenuItem {
  /** Menu label, also the React key — so labels must be unique per menu. */
  label: string;
  onSelect: () => void;
  /** Renders the destructive style (leave, delete). */
  danger?: boolean;
}
