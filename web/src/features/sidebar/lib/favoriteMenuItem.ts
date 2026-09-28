import type { SidebarMenuItem } from "./sidebarMenuItem.ts";

export const ADD_TO_FAVORITES = "Add to Favorites";
export const REMOVE_FROM_FAVORITES = "Remove from Favorites";

/**
 * The Favorites toggle every sidebar row kind offers (channel, forum, DM,
 * link) — one wording, one place.
 */
export function favoriteMenuItem(
  favorited: boolean,
  onToggle: () => void,
): SidebarMenuItem {
  return {
    label: favorited ? REMOVE_FROM_FAVORITES : ADD_TO_FAVORITES,
    onSelect: onToggle,
  };
}
