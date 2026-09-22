import { Globe } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  ShortcutDef,
  ShortcutMode,
} from "@/features/shortcut-bar/lib/shortcutBlob.ts";
import {
  addSidebarShortcut,
  removeSidebarShortcut,
  updateSidebarShortcut,
} from "@/features/shortcut-bar/lib/shortcutBlob.ts";
import { useShortcutBar } from "@/features/shortcut-bar/hooks.ts";
import { ShortcutDialog } from "@/features/shortcut-bar/ui/ShortcutDialog.tsx";
import { shortcutMenuItems } from "@/features/sidebar/lib/shortcutMenuItems.ts";
import { SectionHeader } from "@/features/sidebar/ui/SectionHeader";
import { SidebarNavButton } from "@/features/sidebar/ui/SidebarNavButton";

/**
 * The sidebar Links section: one row per channel-independent link, in a
 * section of its own below Forums and visually identical to a channel row.
 *
 * These were pills in a channel's header bar, stored per channel. They are
 * now one list belonging to no channel, so this section renders wherever the
 * sidebar does — ALWAYS, empty list included, so the + stays discoverable.
 *
 * Storage follows the signer (`useShortcutBar`): the unlocked local key
 * keeps the encrypted relay blob (cross-device sync), everything else
 * (extension, web-auth, ephemeral) gets the same list in localStorage on
 * this device. The two stores are separate; see `lib/localLinkStore.ts`.
 * A blob this device cannot read still shows, but refuses BLOB writes with
 * a toast rather than silently failing — the local list is unaffected.
 *
 * Self-wiring, like the bar was: the sidebar renders it and hands it nothing.
 */
export function SidebarShortcutsSection({
  onOpenOverlay,
}: {
  /** Raise the in-app dock on a given overlay-mode shortcut id. */
  onOpenOverlay: (shortcutId: string) => void;
}) {
  const { shortcuts, blocked, blockedMessage, mutateShortcuts } =
    useShortcutBar();
  const [dialogOpen, setDialogOpen] = useState(false);
  /** null = adding a new shortcut; a def = editing that one. */
  const [editing, setEditing] = useState<ShortcutDef | null>(null);

  const menuItems = useMemo(
    () =>
      new Map(
        shortcuts.map((shortcut) => [
          shortcut.id,
          shortcutMenuItems({
            onEdit: () => {
              if (blocked) {
                toast.error(
                  blockedMessage ?? "Shortcut data unreadable on this device.",
                );
                return;
              }
              setEditing(shortcut);
              setDialogOpen(true);
            },
            onRemove: () => {
              void mutateShortcuts((blob) =>
                removeSidebarShortcut(blob, shortcut.id),
              ).then((result) => {
                if (!result.ok) {
                  toast.error(
                    result.message ?? "Could not remove the shortcut.",
                  );
                }
              });
            },
          }),
        ]),
      ),
    [shortcuts, blocked, blockedMessage, mutateShortcuts],
  );

  const confirm = async (input: {
    url: string;
    label: string;
    mode: ShortcutMode;
  }) => {
    const result = await mutateShortcuts((blob) =>
      editing
        ? updateSidebarShortcut(blob, editing.id, input)
        : addSidebarShortcut(blob, input),
    );
    if (result.ok) {
      return { ok: true as const };
    }
    return { ok: false as const, reason: result.message ?? "Could not save." };
  };

  return (
    <>
      <SectionHeader
        label="Links"
        className="mt-4 mb-[4px]"
        onAdd={() => {
          if (blocked) {
            toast.error(
              blockedMessage ?? "Shortcut data unreadable on this device.",
            );
            return;
          }
          setEditing(null);
          setDialogOpen(true);
        }}
        addLabel="Add a link"
      />
      <ul className="space-y-0.5">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.id}>
            <SidebarNavButton
              selected={false}
              label={shortcut.label}
              icon={
                <Globe
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-sidebar-foreground/70"
                />
              }
              onSelect={() => {
                if (shortcut.mode === "overlay") {
                  onOpenOverlay(shortcut.id);
                  return;
                }
                // A new tab, never this window: the shortcut is a destination,
                // and navigating away would drop the conversation behind it.
                window.open(shortcut.url, "_blank", "noopener,noreferrer");
              }}
              menuItems={menuItems.get(shortcut.id)}
            />
          </li>
        ))}
      </ul>
      <ShortcutDialog
        editing={editing}
        onConfirm={confirm}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}
