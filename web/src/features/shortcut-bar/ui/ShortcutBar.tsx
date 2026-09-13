import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";

import {
  type ShortcutDef,
  type ShortcutMode,
  addShortcut as addShortcutToBlob,
  removeShortcut as removeFromBlob,
  updateShortcut as updateShortcutInBlob,
} from "../lib/shortcutBlob.ts";
import { useShortcutBar } from "../hooks.ts";
import { ShortcutDialog } from "./ShortcutDialog.tsx";

/**
 * The per-channel shortcut bar: labeled pills in the channel header, the
 * `+` that opens the add dialog, and a right-click menu on each pill.
 *
 * Hidden entirely when the signer is not the unlocked local key (NIP-44-to-
 * self has no extension path, and the content is opaque ciphertext anyway)
 * or on ephemeral channels — a huddle's backing channel outlives nothing,
 * so pinning anything to it would be a trap.
 *
 * Everything is self-wiring: the shell hands it a channel id and an overlay
 * callback and renders nothing else of it.
 */
export function ShortcutBar({
  channelId,
  ephemeral,
  onOpenOverlay,
}: {
  channelId: string;
  /** Ephemeral (ttl) channel — the bar renders nothing at all. */
  ephemeral: boolean;
  /** Open the in-app dock overlay on a given shortcut id. */
  onOpenOverlay: (shortcutId: string) => void;
}) {
  const { shortcuts, canUse, blocked, blockedMessage, mutateShortcuts } =
    useShortcutBar(channelId);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** null = adding a new shortcut; a def = editing that one. */
  const [editing, setEditing] = useState<ShortcutDef | null>(null);

  if (!canUse || ephemeral) {
    return null;
  }

  const refuseWhenBlocked = (): boolean => {
    if (blocked) {
      toast.error(blockedMessage ?? "Shortcut data unreadable on this device.");
      return true;
    }
    return false;
  };

  const confirm = async (input: {
    url: string;
    label: string;
    mode: ShortcutMode;
  }) => {
    const result = await mutateShortcuts((blob) =>
      editing
        ? updateShortcutInBlob(blob, channelId, editing.id, input)
        : addShortcutToBlob(blob, channelId, input),
    );
    if (result.ok) {
      return { ok: true as const };
    }
    return { ok: false as const, reason: result.message ?? "Could not save." };
  };

  const remove = async (shortcut: ShortcutDef) => {
    const result = await mutateShortcuts((blob) =>
      removeFromBlob(blob, channelId, shortcut.id),
    );
    if (!result.ok) {
      toast.error(result.message ?? "Could not remove the shortcut.");
    }
  };

  return (
    <>
      {shortcuts.map((shortcut) => (
        <ContextMenu key={shortcut.id}>
          <ContextMenuTrigger asChild>
            {shortcut.mode === "window" ? (
              <a
                className={pillClassName}
                data-testid={`shortcut-${shortcut.id}`}
                href={shortcut.url}
                rel="noreferrer noopener"
                target="_blank"
                title={`${shortcut.url} — opens in a new tab`}
              >
                {shortcut.label}
              </a>
            ) : (
              <button
                className={pillClassName}
                data-testid={`shortcut-${shortcut.id}`}
                onClick={() => onOpenOverlay(shortcut.id)}
                title={`${shortcut.url} — opens in the dock`}
                type="button"
              >
                {shortcut.label}
              </button>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              data-testid={`shortcut-edit-${shortcut.id}`}
              onSelect={() => {
                if (refuseWhenBlocked()) {
                  return;
                }
                setEditing(shortcut);
                setDialogOpen(true);
              }}
            >
              <Pencil aria-hidden className="size-4" />
              Edit…
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              data-testid={`shortcut-remove-${shortcut.id}`}
              onSelect={() => {
                void remove(shortcut);
              }}
            >
              <Trash2 aria-hidden className="size-4" />
              Remove
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <button
        aria-label="Add a shortcut"
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        data-testid="shortcut-bar-add"
        onClick={() => {
          if (refuseWhenBlocked()) {
            return;
          }
          setEditing(null);
          setDialogOpen(true);
        }}
        title="Add a shortcut"
        type="button"
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
      <ShortcutDialog
        editing={editing}
        onConfirm={confirm}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

const pillClassName =
  "max-w-24 shrink-0 truncate rounded-full border border-border px-2.5 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground";
