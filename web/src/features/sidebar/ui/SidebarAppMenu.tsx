import {
  Activity,
  Bell,
  Bot,
  ChevronDown,
  Clock,
  Copy,
  FolderKanban,
  Folder,
  Settings,
  Smile,
  Workflow,
} from "lucide-react";
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
import { useDueReminderCount } from "@/features/reminders/hooks";
import { useDrawerClose } from "@/shared/layout/AppShell";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

/** Props for {@link SidebarAppMenu}. */
export interface SidebarAppMenuProps {
  /** The signed-in key, or null before it resolves. */
  selfPubkey: string | null;
  /** Profile metadata by pubkey — the viewer's own row is read from here. */
  profiles: Map<string, Profile>;
  /** Whether the relay session is live; drives the presence dot. */
  connected: boolean;
  /** Raise the Files page. */
  onOpenFiles: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

function MenuDivider() {
  return <div aria-hidden className="mx-1 my-1 h-px bg-border" />;
}

/**
 * The "B" at the top of the sidebar, and the menu behind it: Settings, your
 * status and notifications, the secondary views, and who you are signed in
 * as.
 *
 * This menu used to hang off a profile row at the foot of the sidebar
 * (avatar, name, gear). Sam removed that row on 2026-09-30 and put Settings
 * on the B, so everything the row did lives here now — nothing became
 * unreachable. The identity the row displayed opens the menu instead, as
 * its header: it still answers "which key am I using" without opening
 * Settings.
 *
 * The dot there reports relay connection, not human availability: a client
 * cannot meaningfully report its own user's presence from a socket, so it
 * says "Connected" rather than implying "online". The human-authored half —
 * the NIP-38 emoji + text — replaces that line once the viewer sets one.
 */
export function SidebarAppMenu({
  selfPubkey,
  profiles,
  connected,
  onOpenFiles,
}: SidebarAppMenuProps) {
  const closeDrawer = useDrawerClose();
  const { session } = useRelaySession();
  const [open, setOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const profile = selfPubkey ? profiles.get(selfPubkey) : undefined;
  const dueReminders = useDueReminderCount(selfPubkey);

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

  // A route link closes the menu and, on a phone, the drawer it sits in.
  const leave = () => {
    setOpen(false);
    closeDrawer();
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="sidebar-app-menu"
            aria-label="Buzz menu: settings, status and your account"
            className={cn(
              "group/brand -m-1 flex min-w-0 items-center gap-2.5 rounded-[11px] p-1 pr-2 text-left transition-colors",
              "hover:bg-sidebar-foreground/5 data-[state=open]:bg-sidebar-foreground/5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
          >
            <span
              aria-hidden
              className="buzz-mark grid size-8 shrink-0 place-items-center rounded-[9px] text-base font-bold ring-1 ring-line-2"
            >
              B
            </span>
            <span className="text-sm leading-tight font-bold">Buzz</span>
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 text-sidebar-foreground/50 transition-transform duration-150 group-data-[state=open]/brand:rotate-180"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={8}
          className="w-64 p-1"
        >
          {/* Who you are signed in as — the identity the removed profile
              row used to show at the foot of the sidebar. */}
          <div
            className="flex items-center gap-2.5 px-2 pt-1.5 pb-2"
            data-testid="sidebar-app-menu-identity"
          >
            <span className="relative shrink-0">
              <Avatar className="size-8 rounded-[8px]">
                {profile?.avatar && <AvatarImage src={profile.avatar} alt="" />}
                <AvatarFallback className="text-2xs">{initials}</AvatarFallback>
              </Avatar>
              <span
                aria-hidden
                title={connected ? "Connected" : "Connecting…"}
                className={cn(
                  // Ringed in the menu's own ground so the dot reads as a
                  // cutout rather than a sticker, matching the desktop.
                  "absolute -right-0.5 -bottom-0.5 size-2.75 rounded-full ring-2 ring-popover",
                  connected ? "bg-leaf" : "bg-muted-foreground",
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm leading-tight font-semibold">
                {label}
              </span>
              {/* A status the viewer wrote outranks the socket state: it is
                  the only line here that carries human intent. */}
              {selfStatus ? (
                <span
                  className="block truncate text-xs leading-tight text-muted-foreground"
                  data-testid="sidebar-self-status"
                >
                  {statusLabel(selfStatus)}
                </span>
              ) : (
                <span className="block truncate text-xs leading-tight text-muted-foreground">
                  {connected ? "Connected" : "Connecting…"}
                </span>
              )}
            </span>
          </div>
          <MenuDivider />
          <Link to="/repos/settings" className={ITEM} onClick={leave}>
            <Settings aria-hidden className="size-4" />
            Settings
          </Link>
          <button
            type="button"
            className={ITEM}
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
            className={ITEM}
            data-testid="open-notification-settings"
            onClick={() => {
              setOpen(false);
              setNotificationsOpen(true);
            }}
          >
            <Bell aria-hidden className="size-4" />
            Notifications
          </button>
          <MenuDivider />
          <Link
            to="/repos"
            search={{ view: "projects" as const }}
            className={ITEM}
            onClick={leave}
          >
            <FolderKanban aria-hidden className="size-4" />
            Projects
          </Link>
          <Link
            to="/repos"
            search={{ view: "pulse" as const }}
            className={ITEM}
            onClick={leave}
          >
            <Activity aria-hidden className="size-4" />
            Pulse
          </Link>
          <Link
            to="/repos"
            search={{ view: "reminders" as const }}
            className={ITEM}
            onClick={leave}
          >
            <Clock aria-hidden className="size-4" />
            Reminders
            {dueReminders > 0 && (
              <span
                className="ml-auto rounded-full bg-primary px-1.5 text-2xs font-medium tabular-nums text-primary-foreground"
                data-testid="sidebar-due-reminders"
              >
                {dueReminders}
              </span>
            )}
          </Link>
          <Link
            to="/repos"
            search={{ view: "workflows" as const }}
            className={ITEM}
            onClick={leave}
          >
            <Workflow aria-hidden className="size-4" />
            Workflows
          </Link>
          <Link
            to="/repos/settings"
            search={{ group: "agents" }}
            className={ITEM}
            onClick={leave}
          >
            <Bot aria-hidden className="size-4" />
            Agents
          </Link>
          <button
            type="button"
            className={ITEM}
            onClick={() => {
              setOpen(false);
              onOpenFiles();
            }}
          >
            <Folder aria-hidden className="size-4" />
            Files
          </button>
          {npub && (
            <>
              <MenuDivider />
              <button
                type="button"
                className={ITEM}
                onClick={() => {
                  setOpen(false);
                  copyNpub();
                }}
              >
                <Copy aria-hidden className="size-4" />
                Copy your npub
              </button>
            </>
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
    </>
  );
}
