import { Bell, Bot, Copy, Folder, Settings, Smile } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { npubEncode } from "nostr-tools/nip19";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Profile } from "@/features/channels/hooks";
import { NotificationSettingsDialog } from "@/features/notifications/ui/NotificationSettingsDialog";
import {
  publishUserStatus,
  useUserStatuses,
} from "@/features/user-status/hooks";
import { statusLabel } from "@/features/user-status/lib/statusEvent.ts";
import { SetStatusDialog } from "@/features/user-status/ui/SetStatusDialog";
import { StatusEmoji } from "@/features/user-status/ui/StatusEmoji";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useDrawerClose } from "@/shared/layout/AppShell";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

/** Props for {@link SidebarProfileCard}. */
export interface SidebarProfileCardProps {
  /** The signed-in key, or null before it resolves. */
  selfPubkey: string | null;
  /** Profile metadata by pubkey — the viewer's own row is read from here. */
  profiles: Map<string, Profile>;
  /** Whether the relay session is live; drives the presence dot. */
  connected: boolean;
  /** Raise the Files overlay. */
  onOpenFiles: () => void;
}

/**
 * The sidebar's identity footer.
 *
 * The web client previously ended its sidebar with two text links and showed
 * the signed-in identity nowhere at all — you could not tell which key you
 * were using without opening Settings. This is the desktop's profile card:
 * avatar, name, and a presence dot, opening a menu with the actions that
 * belong to "you" rather than to a channel.
 *
 * The dot reports relay connection, not human availability. Buzz has a real
 * presence model for other people, but a client cannot meaningfully report
 * its own user's status from a socket — so this deliberately says "connected"
 * rather than implying "online". The human-authored half of that — the
 * desktop's NIP-38 emoji + text — is the status line below the name, set from
 * this menu.
 *
 * It is also where the notification runtime is mounted. That is a pragmatic
 * home rather than a principled one: this card is the one piece of the
 * signed-in shell that is always on screen, so mounting here makes
 * notifications live without touching the app shell. See
 * {@link NotificationRuntime} for where it belongs instead.
 */
export function SidebarProfileCard({
  selfPubkey,
  profiles,
  connected,
  onOpenFiles,
}: SidebarProfileCardProps) {
  const closeDrawer = useDrawerClose();
  const { session } = useRelaySession();
  const [open, setOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const profile = selfPubkey ? profiles.get(selfPubkey) : undefined;

  const statusAuthors = useMemo(() => [selfPubkey], [selfPubkey]);
  const statuses = useUserStatuses(statusAuthors);
  const selfStatus = selfPubkey ? (statuses.get(selfPubkey) ?? null) : null;

  const npub = useMemo(() => {
    if (!selfPubkey) return null;
    try {
      return npubEncode(selfPubkey);
    } catch {
      // A malformed key should degrade to the truncated hex, not blank the row.
      return null;
    }
  }, [selfPubkey]);

  const label =
    profile?.displayName?.trim() ||
    profile?.name?.trim() ||
    (selfPubkey ? truncatePubkey(selfPubkey) : "Signing in…");

  const initials = label.slice(0, 2).toUpperCase();

  const copyNpub = () => {
    if (!npub) return;
    void navigator.clipboard
      ?.writeText(npub)
      .then(() => toast.success("Copied your npub"))
      .catch(() => toast.error("Could not copy — clipboard unavailable."));
  };

  const saveStatus = (text: string, emoji: string) => {
    setSavingStatus(true);
    void publishUserStatus(session, { text, emoji, selfPubkey })
      .then((result) => {
        if (result.ok) {
          toast.success(text || emoji ? "Status updated" : "Status cleared");
        } else {
          toast.error(result.message || "Could not publish your status.");
        }
      })
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : "Could not sign the status.",
        );
      })
      .finally(() => setSavingStatus(false));
  };

  return (
    <div className="border-t border-sidebar-border p-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`You: ${label}. Open your menu.`}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
              "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
          >
            <span className="relative shrink-0">
              <Avatar className="size-7">
                {profile?.avatar && <AvatarImage src={profile.avatar} alt="" />}
                <AvatarFallback className="text-2xs">{initials}</AvatarFallback>
              </Avatar>
              <span
                aria-hidden
                title={connected ? "Connected" : "Connecting…"}
                className={cn(
                  // Ringed in the sidebar's own ground so the dot reads as a
                  // cutout rather than a sticker, matching the desktop.
                  "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-sidebar",
                  connected ? "bg-emerald-500" : "bg-sidebar-foreground/40",
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-sidebar-foreground">
                {label}
              </span>
              {/* A status the viewer wrote outranks the socket state: it is
                  the only line here that carries human intent. The connection
                  string stays available on the dot's tooltip. */}
              {selfStatus ? (
                <span
                  className="block truncate text-2xs text-sidebar-foreground/60"
                  data-testid="sidebar-self-status"
                >
                  {statusLabel(selfStatus)}
                </span>
              ) : (
                <span className="block truncate text-2xs text-sidebar-foreground/60">
                  {connected ? "Connected" : "Connecting…"}
                </span>
              )}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-56 p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            data-testid="open-set-status"
            onClick={() => {
              setOpen(false);
              setStatusOpen(true);
            }}
          >
            {selfStatus?.emoji ? (
              <StatusEmoji
                className="size-4 text-sm"
                value={selfStatus.emoji}
              />
            ) : (
              <Smile aria-hidden className="size-4" />
            )}
            {selfStatus ? "Change your status" : "Set a status"}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            data-testid="open-notification-settings"
            onClick={() => {
              setOpen(false);
              setNotificationsOpen(true);
            }}
          >
            <Bell aria-hidden className="size-4" />
            Notifications
          </button>
          <Link
            to="/repos/settings"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false);
              closeDrawer();
            }}
          >
            <Settings aria-hidden className="size-4" />
            Settings
          </Link>
          <Link
            to="/repos/agents"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false);
              closeDrawer();
            }}
          >
            <Bot aria-hidden className="size-4" />
            Agents
          </Link>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onOpenFiles();
            }}
          >
            <Folder aria-hidden className="size-4" />
            Files
          </button>
          {npub && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false);
                copyNpub();
              }}
            >
              <Copy aria-hidden className="size-4" />
              Copy your npub
            </button>
          )}
        </PopoverContent>
      </Popover>
      <SetStatusDialog
        hasExistingStatus={selfStatus !== null}
        initialEmoji={selfStatus?.emoji ?? ""}
        initialText={selfStatus?.text ?? ""}
        onClear={() => saveStatus("", "")}
        onOpenChange={setStatusOpen}
        onSave={saveStatus}
        open={statusOpen}
        saving={savingStatus}
      />
      <NotificationSettingsDialog
        onOpenChange={setNotificationsOpen}
        open={notificationsOpen}
      />
    </div>
  );
}
