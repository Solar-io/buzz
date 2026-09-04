/**
 * The keyboard shortcuts this client actually implements.
 *
 * Every entry below was read off a real handler, not copied from the desktop's
 * list — the desktop has a far longer table (window management, agent
 * controls, the terminal) and publishing that here would be a page of
 * shortcuts that do nothing. Sources:
 *
 * - `app/useZoomShortcuts.ts` — zoom in / out / reset
 * - `app/routes/repos.tsx:571` — the ⌘K quick switcher
 * - `features/channels/ui/Composer.tsx:582-652` — send, newline, bold, italic,
 *   the mention/emoji autocomplete keys, and the two Escape behaviours
 *
 * Import-free so `node --test` can load it.
 */

export interface KeyboardShortcut {
  id: string;
  label: string;
  description: string;
  /** Keys for an Apple platform. */
  mac: string;
  /** Keys elsewhere. */
  other: string;
}

export interface ShortcutCategory {
  name: string;
  shortcuts: KeyboardShortcut[];
}

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    name: "Navigation",
    shortcuts: [
      {
        id: "quick-switcher",
        label: "Quick switcher",
        description: "Jump to a channel, DM, or action",
        mac: "⌘ K",
        other: "Ctrl K",
      },
    ],
  },
  {
    name: "Composing",
    shortcuts: [
      {
        id: "send",
        label: "Send",
        description: "Send the message",
        mac: "Enter",
        other: "Enter",
      },
      {
        id: "newline",
        label: "New line",
        description: "Break the line without sending",
        mac: "Shift Enter",
        other: "Shift Enter",
      },
      {
        id: "bold",
        label: "Bold",
        description: "Wrap the selection in bold",
        mac: "⌘ B",
        other: "Ctrl B",
      },
      {
        id: "italic",
        label: "Italic",
        description: "Wrap the selection in italics",
        mac: "⌘ I",
        other: "Ctrl I",
      },
      {
        id: "autocomplete-move",
        label: "Move through suggestions",
        description: "Mention and emoji autocomplete",
        mac: "↑ ↓",
        other: "↑ ↓",
      },
      {
        id: "autocomplete-accept",
        label: "Accept a suggestion",
        description: "Mention and emoji autocomplete",
        mac: "Tab",
        other: "Tab",
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Close autocomplete, stop editing, or close the thread",
        mac: "Esc",
        other: "Esc",
      },
    ],
  },
  {
    name: "View",
    shortcuts: [
      {
        id: "zoom-in",
        label: "Zoom in",
        description: "Scale the whole interface up",
        mac: "⌘ +",
        other: "Ctrl +",
      },
      {
        id: "zoom-out",
        label: "Zoom out",
        description: "Scale the whole interface down",
        mac: "⌘ -",
        other: "Ctrl -",
      },
      {
        id: "zoom-reset",
        label: "Reset zoom",
        description: "Back to the default scale",
        mac: "⌘ 0",
        other: "Ctrl 0",
      },
    ],
  },
];

/** True on macOS/iOS-style platforms, matching `useZoomShortcuts`. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The keys to display for `shortcut` on `platform`. */
export function keysFor(
  shortcut: KeyboardShortcut,
  platform: string,
): string[] {
  const keys = isApplePlatform(platform) ? shortcut.mac : shortcut.other;
  return keys.split(" ").filter((part) => part.length > 0);
}
