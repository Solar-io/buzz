import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Brain,
  Folder,
  Hash,
  Headphones,
  Lock,
  MessageSquareText,
  Plus,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import {
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
  sendReaction,
  sendTypingIndicator,
  useChannelMembers,
  useChannelMessages,
  useProfiles,
  type Profile,
} from "@/features/channels/hooks";
import {
  useChannels,
  type ChannelSummary,
} from "@/features/channels/useChannels";
import {
  forgetChannel,
  isMuted,
  loadChannelPrefs,
  toggleMuted,
  toggleStarred,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import {
  deleteChannel,
  leaveChannel,
  renameChannel,
  sendPresence,
  usePresence,
} from "@/features/channels/hooks";
import { canonicalChannelName } from "@/features/channels/lib/channelAdmin.ts";
import { shortKey } from "@/features/dms/lib/dmNaming.ts";

import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";
import { replyCounts } from "@/features/channels/lib/messageBuffer.ts";
import {
  isUnread,
  loadReadState,
  markSeen,
  saveReadState,
  type ReadState,
} from "@/features/channels/lib/readState.ts";
import { activeTyping } from "@/features/channels/lib/typing.ts";
import {
  presenceDotClass,
  type PresenceEntry,
} from "@/features/channels/lib/presence.ts";
import { clearDraft, saveDraft } from "@/features/channels/lib/drafts.ts";
import {
  AuthorAvatar,
  ChannelTimeline,
} from "@/features/channels/ui/ChannelTimeline";
import { Composer } from "@/features/channels/ui/Composer";
import { ForumView } from "@/features/channels/ui/ForumView";
import { SearchPanel } from "@/features/channels/ui/SearchPanel";
import { HuddleBar } from "@/features/huddle/ui/HuddleBar";
import { useHuddleLinks } from "@/features/huddle/useHuddleLinks";
import { startHuddle } from "@/features/huddle/lib/huddleLifecycle";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import {
  useAgentFrames,
  useObserverStore,
} from "@/features/agents/ObserverProvider";
import {
  agentRecentlyActive,
  agentTurnStart,
  agentWorkingState,
} from "@/features/agents/lib/observerEvents";
import { formatElapsed, useTick } from "@/features/agents/ui/WorkingBadge";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import {
  hideDm,
  loadHiddenDms,
  saveHiddenDms,
  unhideDm,
} from "@/features/dms/lib/hiddenDms.ts";
import { FilesPanel } from "@/features/files/ui/FilesPanel";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { AppShell, useDrawerClose } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { cn } from "@/shared/lib/cn";
import { loadTimelineCache } from "@/features/channels/lib/timelineCache.ts";

/**
 * The app lives at /repos — the one browser-servable path the relay's
 * public-bundle fallback guarantees on the stock image (with the git web GUI
 * flag on). Everything else is client-side navigation from here.
 */
export const Route = createFileRoute("/repos")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { c?: string; m?: string } => ({
    c: typeof search.c === "string" ? search.c : undefined,
    // Permalink target: scroll to and flash this message once it loads.
    m: typeof search.m === "string" ? search.m : undefined,
  }),
  component: AppRoute,
});

function AppRoute() {
  const { canSign } = useAuth();
  if (!canSign) {
    return <LoginPage />;
  }
  return <ChannelBrowser />;
}

function ChannelBrowser() {
  const { channels, connected, refresh: refreshChannels } = useChannels();
  const navigate = useNavigate({ from: "/repos" });
  // Phone drawer dismiss — shared by the sidebar rows and the Agents link.
  const closeDrawer = useDrawerClose();
  const selectedId = Route.useSearch({ select: (s) => s.c });
  const permalinkMessageId = Route.useSearch({ select: (s) => s.m });
  const current = channels.find((channel) => channel.id === selectedId) ?? null;

  // DMs ride the same kind:39000 list (relay `t` tag); they get their own
  // sidebar section and participant-based names.
  const { dms, channelsWithoutDms: unfilteredChannels } = useDms(channels);
  // Archived channels (expired huddles etc.) hide from the sidebar — the
  // relay's `archived` tag exists for exactly this. Ephemeral (ttl) channels
  // are huddle backing rooms: grouped apart, newest first, not mixed into
  // the main channel list. Forum-type channels split into their own sidebar
  // section (and their own channel body); streams keep the Channels list.
  const permanentChannels = useMemo(
    () =>
      unfilteredChannels
        .filter((channel) => !channel.archived && channel.ttlSeconds === null)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          }),
        ),
    [unfilteredChannels],
  );
  const visibleChannels = useMemo(
    () => permanentChannels.filter((channel) => channel.type !== "forum"),
    [permanentChannels],
  );
  const forumChannels = useMemo(
    () => permanentChannels.filter((channel) => channel.type === "forum"),
    [permanentChannels],
  );
  const huddleChannels = useMemo(
    () =>
      unfilteredChannels
        .filter((channel) => !channel.archived && channel.ttlSeconds !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [unfilteredChannels],
  );
  const [selfPubkey, setSelfPubkey] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setSelfPubkey);
  }, []);
  const dmParticipantPubkeys = useMemo(
    () =>
      dms.flatMap((dm) =>
        dm.channel.participantPubkeys.filter((pk) => pk !== selfPubkey),
      ),
    [dms, selfPubkey],
  );
  const dmProfiles = useProfiles(dmParticipantPubkeys);
  const dmName = (participantPubkeys: string[]): string =>
    dmDisplayName(participantPubkeys, selfPubkey ?? "", dmProfiles);

  const { session } = useRelaySession();
  const channelId = current?.id ?? "";
  const { messages, reactions, typing, loadOlder, loadingOlder, historyExhausted } =
    useChannelMessages(current?.id ?? null);
  // Read state: opening a channel marks its newest message seen; badges and
  // the timeline unread divider derive from the marker.
  const [readState, setReadState] = useState<ReadState>(() => loadReadState());
  const newestMessageAt = messages[messages.length - 1]?.createdAt ?? 0;
  useEffect(() => {
    if (channelId === "" || newestMessageAt === 0) {
      return;
    }
    setReadState((previous) => {
      const next = markSeen(previous, channelId, newestMessageAt);
      if (next !== previous) {
        saveReadState(next);
      }
      return next;
    });
  }, [channelId, newestMessageAt]);
  const handleReact = useCallback(
    (messageId: string, emoji: string) => {
      void sendReaction(session, { targetEventId: messageId, emoji });
    },
    [session],
  );
  // Edit mode: ✎ prefills the composer with the original text; submit sends a
  // kind-40003 overlay. Cancelled/switching channels clears it.
  const [editing, setEditing] = useState<{
    id: string;
    original: string;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger by design
  useEffect(() => {
    setEditing(null);
  }, [channelId]);
  const handleEdit = useCallback(
    (message: { id: string; content: string }) =>
      setEditing({ id: message.id, original: message.content }),
    [],
  );
  const handleDelete = useCallback(
    (messageId: string) => {
      if (!current) {
        return;
      }
      void deleteChannelMessage(session, {
        channelId: current.id,
        targetEventId: messageId,
      });
    },
    [session, current],
  );
  const handleEditSend = useCallback(
    (content: string) => {
      if (!current || !editing) {
        return Promise.resolve({ ok: false, message: "Nothing to edit." });
      }
      return editChannelMessage(session, {
        channelId: current.id,
        targetEventId: editing.id,
        content,
      }).then((result) => {
        if (result.ok) {
          clearDraft(current.id);
        }
        return result;
      });
    },
    [session, current, editing],
  );
  // Permalink: copies the channel + message URL to the clipboard.
  const handleShare = useCallback(
    (messageId: string) => {
      if (!current) {
        return;
      }
      const url = `${globalThis.location.origin}/repos?c=${current.id}&m=${messageId}`;
      void navigator.clipboard
        ?.writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast.error("Could not copy the link."));
    },
    [current],
  );
  // Permalink target (?m=): once the message is in the buffer the row scrolls
  // itself into view and flashes; then m is dropped from the URL so later
  // arrivals don't fight the auto-tail scroll. Hits older than the fetch
  // window never enter the buffer — a 4s fallback still cleans the URL.
  const permalinkReady =
    permalinkMessageId != null &&
    messages.some((m) => m.id === permalinkMessageId);
  useEffect(() => {
    if (!permalinkReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigate({
        to: "/repos",
        search: { c: selectedId },
        replace: true,
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [permalinkReady, navigate, selectedId]);
  useEffect(() => {
    if (permalinkMessageId == null || permalinkReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigate({
        to: "/repos",
        search: { c: selectedId },
        replace: true,
      });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [permalinkMessageId, permalinkReady, navigate, selectedId]);
  // Typing broadcast: one kind-20002 frame per 3s while the composer has text.
  // Draft persistence rides along — every text change stores the channel's
  // draft (empty text clears it), independent of the typing throttle.
  const lastTypingSent = useRef(0);
  const handleComposerText = useCallback(
    (text: string) => {
      if (channelId !== "") {
        saveDraft(channelId, text);
      }
      if (!text.trim() || channelId === "") {
        return;
      }
      const now = Date.now();
      if (now - lastTypingSent.current < 3000) {
        return;
      }
      lastTypingSent.current = now;
      void sendTypingIndicator(session, channelId, null);
    },
    [session, channelId],
  );
  // Typing row: re-derive every few seconds so entries expire visibly.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 3000);
    return () => window.clearInterval(timer);
  }, []);
  const channelMembers = useChannelMembers(current?.id ?? null);
  // DMs carry no 39002 member events — their roster IS the 39000's p tags.
  // Without this, @-mention autocomplete and p-tag resolution are dead in
  // DMs (empty member list).
  const members = useMemo(
    () =>
      current?.type === "dm" && selfPubkey
        ? current.participantPubkeys
            .filter((pk) => pk !== selfPubkey)
            .map((pk) => ({ pubkey: pk, name: shortKey(pk) }))
        : channelMembers,
    [current, selfPubkey, channelMembers],
  );
  const profiles = useProfiles(
    useMemo(
      () =>
        messages
          .map((m) => m.authorPubkey)
          .concat(members.map((m) => m.pubkey)),
      [messages, members],
    ),
  );
  // Must be derived AFTER profiles: the .map callback runs synchronously and
  // touched `profiles` across the TDZ boundary when anyone was typing —
  // "Cannot access 'I' before initialization" (live incident 2026-08-31,
  // whole page to the root error boundary; TS cannot flag closure forward
  // references, so the declaration order is load-bearing).
  const typingNames = activeTyping(
    typing,
    channelId,
    selfPubkey,
    Date.now(),
  ).map((pk) => profiles.get(pk)?.displayName ?? pk);
  const counts = useMemo(() => replyCounts(messages), [messages]);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  // Forum thread selection: picking a post swaps the posts list for the
  // thread view. Switching channels clears it (same reset pattern as the
  // stream thread/editing state above).
  const [forumPostId, setForumPostId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger by design
  useEffect(() => {
    setForumPostId(null);
  }, [channelId]);
  const threadRoot = threadRootId
    ? (messages.find((m) => m.id === threadRootId) ?? null)
    : null;
  // Right-pane width (thread + agent activity share it), drag-resizable.
  const [threadWidth, setThreadWidth] = useState<number>(() => {
    const stored = Number.parseFloat(
      globalThis.localStorage?.getItem("buzz.thread-width.v1") ?? "",
    );
    return Number.isFinite(stored) && stored >= 288 && stored <= 640
      ? stored
      : 384;
  });
  useEffect(() => {
    globalThis.localStorage?.setItem(
      "buzz.thread-width.v1",
      String(Math.round(threadWidth)),
    );
  }, [threadWidth]);
  // Auto-tail now lives INSIDE the virtualized timeline (tailKey) — the VList
  // owns its scroll node. The key covers both new messages and channel
  // switches (two channels share a last-message id only in the empty case).
  const lastMessageId = messages[messages.length - 1]?.id ?? "";
  const tailKey =
    channelId === "" || lastMessageId === ""
      ? null
      : `${channelId}:${lastMessageId}`;

  const send = (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: { rootId: string; replyToId: string } | null;
    mediaTags: string[][];
    /** Event kind — chat default 9; forum views pass 45001/45003. */
    kind?: number;
  }) => {
    if (!current) {
      return Promise.resolve({ ok: false, message: "No channel selected." });
    }
    // A sent message consumes the channel's draft.
    // DMs always tag the other participants — the desktop client and CLI do
    // this too, so the peer's harness wakes on the message even without an
    // explicit @mention in the text (a web-sent DM once arrived untagged and
    // the agent never reacted to it).
    const dmPeers =
      current.type === "dm"
        ? current.participantPubkeys.filter((pk) => pk !== selfPubkey)
        : [];
    const mentionPubkeys = Array.from(
      new Set([...options.mentionPubkeys, ...dmPeers]),
    );
    return sendChannelMessage(session, {
      channelId: current.id,
      content: options.content,
      mentionPubkeys,
      threadRef: options.threadRef,
      mediaTags: options.mediaTags,
      kind: options.kind,
    }).then((result) => {
      if (result.ok) {
        clearDraft(current.id);
      }
      return result;
    });
  };

  // Huddle registry: kind-48100 links parent channels to their ephemeral
  // voice rooms; only linked rooms are joinable (the audio relay verifies
  // the link), so the Huddles section keys off the registry, not bare ttl.
  const huddleLinks = useHuddleLinks();
  const linkedHuddleChannels = useMemo(
    () => huddleChannels.filter((channel) => huddleLinks.has(channel.id)),
    [huddleChannels, huddleLinks],
  );
  const currentHuddleParent =
    current && huddleLinks.has(current.id)
      ? (huddleLinks.get(current.id)?.parentId ?? null)
      : null;

  // Viewer-side channel prefs (starred / muted), local like the desktop's DB.
  const [channelPrefs, setChannelPrefs] = useState<ChannelPrefs>(() =>
    loadChannelPrefs(),
  );
  const starredChannels = useMemo(
    () =>
      visibleChannels.filter((channel) =>
        channelPrefs.starred.includes(channel.id),
      ),
    [visibleChannels, channelPrefs],
  );
  const unstarredChannels = useMemo(
    () =>
      visibleChannels.filter(
        (channel) => !channelPrefs.starred.includes(channel.id),
      ),
    [visibleChannels, channelPrefs],
  );
  // Context menu per channel: star / mark read / mute / leave.
  const channelMenu = (channel: ChannelSummary): ContextMenuItem[] => [
    {
      label: channelPrefs.starred.includes(channel.id)
        ? "Unstar"
        : "Star channel",
      onSelect: () =>
        setChannelPrefs((prefs) => toggleStarred(prefs, channel.id)),
    },
    {
      label: "Mark read",
      onSelect: () => {
        setReadState((previous) => {
          const next = markSeen(previous, channel.id, channel.updatedAt);
          if (next !== previous) {
            saveReadState(next);
          }
          return next;
        });
      },
    },
    {
      label: channelPrefs.muted.includes(channel.id) ? "Unmute" : "Mute",
      onSelect: () =>
        setChannelPrefs((prefs) => toggleMuted(prefs, channel.id)),
    },
    {
      label: "Rename channel…",
      onSelect: () => {
        const next = window.prompt(`Rename #${channel.name}`, channel.name);
        if (next === null) {
          return;
        }
        const canonical = canonicalChannelName(next);
        if (!canonical || canonical === channel.name) {
          return;
        }
        void renameChannel(session, channel.id, canonical).then((result) => {
          if (result.ok) {
            toast.success(`Renamed to #${canonical}`);
            // The relay re-emits the 39000 after the edit; staggered re-REQs
            // cover a missed live fan-out.
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(result.message || "The relay refused the rename.");
          }
        });
      },
    },
    {
      label: "Delete channel",
      danger: true,
      onSelect: () => {
        if (
          !window.confirm(
            `Delete #${channel.name} for everyone? This cannot be undone.`,
          )
        ) {
          return;
        }
        void deleteChannel(session, channel.id).then((result) => {
          if (result.ok) {
            toast.success(`Deleted #${channel.name}`);
            setChannelPrefs((prefs) => forgetChannel(prefs, channel.id));
            if (selectedId === channel.id) {
              void navigate({ to: "/repos", search: { c: undefined } });
            }
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(
              result.message ||
                "The relay refused the delete (owners only). Try Leave instead.",
            );
          }
        });
      },
    },
    {
      label: "Leave channel",
      danger: true,
      onSelect: () => {
        if (!window.confirm(`Leave #${channel.name}?`)) {
          return;
        }
        void leaveChannel(session, channel.id).then((result) => {
          if (result.ok) {
            setChannelPrefs((prefs) => forgetChannel(prefs, channel.id));
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(result.message || "Could not leave the channel.");
          }
        });
      },
    },
  ];
  // Presence: subscribe for every DM peer; publish self as online once the
  // session is live (the relay expires it server-side, no offline beacon).
  const dmPeerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          dms.flatMap(({ channel }) =>
            channel.participantPubkeys.filter((pk) => pk !== selfPubkey),
          ),
        ),
      ),
    [dms, selfPubkey],
  );
  const presence = usePresence(dmPeerPubkeys);
  const publishedPresence = useRef(false);
  useEffect(() => {
    if (connected && session && !publishedPresence.current) {
      publishedPresence.current = true;
      void sendPresence(session, "online");
    }
  }, [connected, session]);

  // ⌘K / Ctrl+K opens search from anywhere in the app. The sidebar's search
  // field feeds the same panel (initialQuery seeds it); its text clears when
  // the panel closes so the field never shows a stale query.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const openSearch = (seed?: string) => {
    if (seed !== undefined) {
      setSidebarQuery(seed);
    }
    setSearchOpen(true);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSidebarQuery("");
  };
  // Files overlay — the desktop's docked Files panel as an iframe layer.
  const [filesOpen, setFilesOpen] = useState(false);
  // Sidebar + buttons: section-header plus buttons open the create dialogs.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  // Hidden DMs — local-only (the desktop's hide_dm equivalent); re-opening
  // the DM via the new-DM flow un-hides it.
  const [hiddenDmIds, setHiddenDmIds] = useState<string[]>(() =>
    loadHiddenDms(window.localStorage),
  );
  const persistHiddenDms = (ids: string[]) => {
    setHiddenDmIds(ids);
    saveHiddenDms(window.localStorage, ids);
  };

  const visibleDms = useMemo(
    () => dms.filter(({ channel }) => !hiddenDmIds.includes(channel.id)),
    [dms, hiddenDmIds],
  );

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="px-1 font-semibold">Channels</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connected ? "bg-sidebar-primary" : "bg-sidebar-foreground/40",
            )}
            title={connected ? "Connected" : "Connecting…"}
          />
          <Link
            to="/repos/settings"
            className="rounded-md px-2 py-1 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            Settings
          </Link>
        </div>
      </div>
      {/* Desktop-style search field: typing here opens the ⌘K search panel
          seeded with what was typed. */}
      <div className="px-2 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2 py-1.5">
          <Search
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <input
            value={sidebarQuery}
            onChange={(event) => openSearch(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search"
            aria-label="Search messages"
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1 font-sans text-[10px] text-muted-foreground sm:block">
            ⌘K
          </kbd>
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {channels.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {connected
              ? "No channels visible yet."
              : "Connecting to the relay…"}
          </p>
        )}
        {starredChannels.length > 0 && (
          <>
            <SectionHeader label="Starred" />
            <ul className="space-y-0.5">
              {starredChannels.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={channel.name}
                    icon={<ChannelGlyph isPrivate={channel.isPrivate} />}
                    unread={
                      !isMuted(channelPrefs, channel.id) &&
                      isUnread(readState, channel.id, channel.updatedAt)
                    }
                    onSelect={() => {
                      setThreadRootId(null);
                      void navigate({
                        to: "/repos",
                        search: { c: channel.id },
                      });
                    }}
                    menuItems={channelMenu(channel)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <SectionHeader
          label="Channels"
          className={starredChannels.length > 0 ? "mt-4" : undefined}
          onAdd={() => setNewChannelOpen(true)}
          addLabel="New channel"
        />
        <NewChannelDialog
          open={newChannelOpen}
          onOpenChange={setNewChannelOpen}
          onCreated={(channelId) => {
            void navigate({ to: "/repos", search: { c: channelId } });
            // The relay stores the 39000 in a spawned task with no live
            // fan-out — staggered re-REQs pick it up once it lands.
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          }}
        />
        <ul className="space-y-0.5">
          {unstarredChannels.map((channel) => (
            <li key={channel.id}>
              <SidebarNavButton
                selected={channel.id === selectedId}
                label={channel.name}
                icon={<ChannelGlyph isPrivate={channel.isPrivate} />}
                unread={
                  !isMuted(channelPrefs, channel.id) &&
                  isUnread(readState, channel.id, channel.updatedAt)
                }
                onSelect={() => {
                  setThreadRootId(null);
                  void navigate({
                    to: "/repos",
                    search: { c: channel.id },
                  });
                }}
                menuItems={channelMenu(channel)}
              />
            </li>
          ))}
        </ul>
        {forumChannels.length > 0 && (
          <>
            <p className="mt-4 flex h-8 items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Forums
            </p>
            <ul className="space-y-0.5">
              {forumChannels.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={channel.name}
                    icon={<ChannelForum />}
                    unread={
                      !isMuted(channelPrefs, channel.id) &&
                      isUnread(readState, channel.id, channel.updatedAt)
                    }
                    onSelect={() => {
                      setThreadRootId(null);
                      void navigate({
                        to: "/repos",
                        search: { c: channel.id },
                      });
                    }}
                    menuItems={channelMenu(channel)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        {linkedHuddleChannels.length > 0 && (
          <details className="px-0 pt-2">
            <summary className="flex h-8 cursor-pointer select-none items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Huddles ({linkedHuddleChannels.length})
            </summary>
            <ul className="space-y-0.5">
              {linkedHuddleChannels.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={`${channel.name} · ${shortDate(channel.updatedAt)}`}
                    onSelect={() => {
                      setThreadRootId(null);
                      void navigate({
                        to: "/repos",
                        search: { c: channel.id },
                      });
                    }}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
        <SectionHeader
          label="Direct messages"
          variant="dm"
          className="mt-4 mb-[13px]"
          onAdd={() => setNewDmOpen(true)}
          addLabel="New direct message"
        />
        <NewDmDialog
          open={newDmOpen}
          onOpenChange={setNewDmOpen}
          contacts={dmParticipantPubkeys}
          onOpened={(channelId) => {
            // Re-opening a hidden DM restores it to the list.
            if (hiddenDmIds.includes(channelId)) {
              persistHiddenDms(unhideDm(hiddenDmIds, channelId));
            }
            void navigate({ to: "/repos", search: { c: channelId } });
            // The relay stores the DM's 39000 in a spawned task with no
            // live fan-out — without a re-REQ the new channel never lands,
            // the ?c= view stays on the empty state, and the DM is missing
            // from the sidebar (mirrors NewChannelDialog's onCreated).
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          }}
        />
        {dms.length > 0 && visibleDms.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            All DMs hidden — use + to start one.
          </p>
        )}
        {visibleDms.length > 0 && (
          <ul className="space-y-1">
            {visibleDms.map(({ channel, lastMessage }) => (
              <li key={channel.id}>
                <DmNavRow
                  selected={channel.id === selectedId}
                  channelId={channel.id}
                  lastSeenAt={readState[channel.id] ?? null}
                  unread={
                    lastMessage
                      ? isUnread(readState, channel.id, lastMessage.created_at)
                      : false
                  }
                  participants={channel.participantPubkeys}
                  selfPubkey={selfPubkey}
                  profiles={dmProfiles}
                  presence={channel.participantPubkeys
                    .filter((pk) => pk !== selfPubkey)
                    .map((pk) => presence.get(pk))
                    .find((entry) => entry != null)}
                  onSelect={() => {
                    setThreadRootId(null);
                    void navigate({
                      to: "/repos",
                      search: { c: channel.id },
                    });
                  }}
                  menuItems={[
                    {
                      label: "Remove from list",
                      danger: true,
                      onSelect: () => {
                        persistHiddenDms(hideDm(hiddenDmIds, channel.id));
                        if (selectedId === channel.id) {
                          void navigate({
                            to: "/repos",
                            search: { c: undefined },
                          });
                        }
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="border-t border-border p-2">
        <button
          type="button"
          aria-label="Files"
          title="Files"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setFilesOpen(true)}
        >
          <Folder aria-hidden className="h-4 w-4" />
          Files
        </button>
        <Link
          to="/repos/agents"
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={closeDrawer}
        >
          <Bot aria-hidden className="h-4 w-4" />
          Agents
        </Link>
      </div>
    </div>
  );

  // DM with an agent → the right pane is the thinking/activity panel unless a
  // thread is open (thread wins; both ride the same resizable width).
  const dmAgentPubkey =
    current?.type === "dm"
      ? (current.participantPubkeys.find((pk) => pk !== selfPubkey) ??
        current.participantPubkeys[0] ??
        null)
      : null;
  // Per-agent selection from the global observer store (one subscription,
  // indexed by the frame's agent tag — no cross-agent leakage).
  const observerStore = useObserverStore();
  // Agent identity: any pubkey that has emitted observer frames this session.
  // The desktop reads its local agents registry; the web's relay-native
  // equivalent is the observer store (agents active since page load).
  const agentPubkeys = useMemo(
    () => new Set(observerStore?.byAgent.keys() ?? []),
    [observerStore],
  );
  const agentFrames = useAgentFrames(dmAgentPubkey);
  const channelAgentFrames = useMemo(
    () =>
      agentFrames.filter(
        (frame) => frame.channelId === null || frame.channelId === current?.id,
      ),
    [agentFrames, current?.id],
  );
  const [thinkingOpen, setThinkingOpen] = useState(false);
  // Desktop DM right-pane dismissal: closing the thinking panel collapses
  // the pane; the header 🧠 reopens it.
  const [dmPaneHidden, setDmPaneHidden] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // DM right-pane tabs: thinking ↔ thread replies (channels stay thread-only).
  const [rightTab, setRightTab] = useState<"thinking" | "thread">("thinking");
  // "Received and working": sticky turn start; the agent's kind-9 reply
  // landing in the channel ends the turn.
  const working = useMemo(
    () =>
      agentWorkingState(
        channelAgentFrames,
        messages
          .filter((m) => m.authorPubkey === dmAgentPubkey)
          .reduce((max, m) => Math.max(max, m.createdAt), 0),
        Math.floor(Date.now() / 1000),
      ),
    [channelAgentFrames, messages, dmAgentPubkey],
  );
  useTick(working.working);

  return (
    <AppShell
      sidebar={sidebar}
      title={
        current
          ? current.type === "dm"
            ? dmName(current.participantPubkeys)
            : `# ${current.name}`
          : null
      }
    >
      {filesOpen ? (
        <FilesPanel onClose={() => setFilesOpen(false)} />
      ) : current ? (
        <div
          className="flex h-full min-h-0"
          style={{ ["--thread-width" as string]: `${threadWidth}px` }}
        >
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-4">
              <h1 className="truncate text-base font-semibold">
                {current.type === "dm"
                  ? dmName(current.participantPubkeys)
                  : `# ${current.name}`}
              </h1>
              {current.type !== "dm" && current.about && (
                <p className="hidden truncate text-sm text-muted-foreground sm:block">
                  {current.about}
                </p>
              )}
              {current.ttlSeconds === null && (
                <button
                  type="button"
                  aria-label="Start a huddle in this channel"
                  title="Start huddle"
                  className="ml-auto shrink-0 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    void startHuddle(session, { parentChannelId: current.id })
                      .then((result) => {
                        if (result.ok && result.channelId) {
                          toast.success(result.message);
                          void navigate({
                            to: "/repos",
                            search: { c: result.channelId },
                          });
                          // The private room's 39000 has no live fan-out —
                          // staggered re-REQs pull it into the sidebar.
                          window.setTimeout(refreshChannels, 500);
                          window.setTimeout(refreshChannels, 2000);
                        } else {
                          toast.error(result.message);
                        }
                      })
                      .catch(() => toast.error("Could not start the huddle."));
                  }}
                >
                  <Headphones aria-hidden className="h-4 w-4" />
                </button>
              )}
              {dmAgentPubkey && (
                <button
                  type="button"
                  aria-label="Toggle thinking panel"
                  title="Thinking"
                  className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    setRightTab("thinking");
                    setDmPaneHidden(false);
                    setThinkingOpen(true);
                  }}
                >
                  <Brain aria-hidden className="h-4 w-4" />
                </button>
              )}
            </div>
            {current.ttlSeconds !== null && (
              <HuddleBar
                channelId={current.id}
                parentChannelId={currentHuddleParent}
                selfPubkey={selfPubkey}
              />
            )}
            {current.type === "forum" ? (
              <ForumView
                channel={current}
                selfPubkey={selfPubkey}
                profiles={profiles}
                members={members}
                feedReactions={reactions}
                replyCounts={counts}
                selectedPostId={forumPostId}
                onSelectPost={setForumPostId}
                onClosePost={() => setForumPostId(null)}
                onReact={handleReact}
                onDelete={handleDelete}
                send={send}
              />
            ) : (
              <>
                <ChannelTimeline
                  messages={messages}
                  profiles={profiles}
                  replyCounts={counts}
                  onOpenThread={(message) => {
                    setThreadRootId(message.id);
                    setRightTab("thread");
                  }}
                  activeRootId={threadRootId}
                  reactions={reactions}
                  onReact={handleReact}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onShare={handleShare}
                  selfPubkey={selfPubkey}
                  agentPubkeys={agentPubkeys}
                  highlightId={permalinkMessageId ?? null}
                  typingNames={typingNames}
                  tailKey={tailKey}
                  onLoadOlder={loadOlder}
                  loadingOlder={loadingOlder}
                  historyExhausted={historyExhausted}
                  workingAgent={
                    working.working &&
                    working.startedAt !== null &&
                    dmAgentPubkey
                      ? {
                          name:
                            profiles.get(dmAgentPubkey)?.displayName ??
                            dmAgentPubkey,
                          startedAt: working.startedAt,
                        }
                      : null
                  }
                />
                <Composer
                  members={members}
                  onTextChange={handleComposerText}
                  editing={editing}
                  onCancelEdit={() => setEditing(null)}
                  editSend={handleEditSend}
                  profiles={profiles}
                  threadRef={
                    threadRoot
                      ? { rootId: threadRoot.id, replyToId: threadRoot.id }
                      : null
                  }
                  onClearThread={() => setThreadRootId(null)}
                  draftKey={current.id}
                  send={send}
                />
              </>
            )}
          </section>
          {(threadRoot || dmAgentPubkey) && (
            // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
            // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
            <div
              aria-label="Resize side panel"
              // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
              role="separator"
              aria-orientation="vertical"
              className="relative z-10 hidden w-1 shrink-0 cursor-col-resize border-r border-border bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 lg:block lg:-ml-px"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  setThreadWidth((previous) =>
                    Math.min(640, Math.max(288, previous - event.movementX)),
                  );
                }
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
            />
          )}
          {threadRoot && (!dmAgentPubkey || rightTab === "thread") && (
            <ThreadPanel
              root={threadRoot}
              buffer={messages}
              members={members}
              profiles={profiles}
              onClose={() => setThreadRootId(null)}
              send={send}
              onSelectThinkingTab={
                dmAgentPubkey ? () => setRightTab("thinking") : undefined
              }
            />
          )}
          {threadRoot && dmAgentPubkey && rightTab === "thinking" && (
            <ThreadPanel
              root={threadRoot}
              buffer={messages}
              members={members}
              profiles={profiles}
              onClose={() => setThreadRootId(null)}
              send={send}
              mobileOnly
            />
          )}
          {dmAgentPubkey &&
            !dmPaneHidden &&
            (!threadRoot || rightTab === "thinking") && (
              <AgentActivityPanel
                agentPubkey={dmAgentPubkey}
                agentName={
                  profiles.get(dmAgentPubkey)?.displayName ?? dmAgentPubkey
                }
                profile={dmProfiles.get(dmAgentPubkey)}
                frames={channelAgentFrames}
                lockedCount={observerStore?.lockedCount ?? 0}
                connected={connected}
                working={working}
                mobileOpen={thinkingOpen}
                onCloseMobile={() => setThinkingOpen(false)}
                onCloseDesktop={() => setDmPaneHidden(true)}
                onSelectThreadTab={
                  threadRoot ? () => setRightTab("thread") : undefined
                }
              />
            )}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">
            Pick a channel to get started.
          </p>
        </div>
      )}
      <SearchPanel
        open={searchOpen}
        onClose={closeSearch}
        initialQuery={sidebarQuery}
        channels={channels}
        profiles={profiles}
        defaultChannelId={current?.id ?? null}
        onOpenResult={(channelId, messageId) => {
          setFilesOpen(false);
          void navigate({
            to: "/repos",
            search: { c: channelId, m: messageId },
          });
        }}
      />
    </AppShell>
  );
}

/**
 * Sidebar section label with the desktop's header-row plus button — the
 * create dialogs open inline just below the header.
 */
function SectionHeader({
  label,
  onAdd,
  addLabel,
  className,
  variant,
}: {
  label: string;
  /** Shows the + button when provided (Channels, Direct messages). */
  onAdd?: () => void;
  addLabel?: string;
  className?: string;
  /**
   * "dm" renders the dm-list-spec.md §2 treatment: sentence case, ~13px,
   * #8E96B0, ink aligned to the avatar left edge (14px) instead of the
   * uppercase channel-section style.
   */
  variant?: "default" | "dm";
}) {
  return (
    <div
      className={cn(
        "flex h-8 items-center justify-between pl-2 pr-1",
        variant === "dm" && "pl-[14px]",
        className,
      )}
    >
      <p
        className={cn(
          "text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70",
          variant === "dm" &&
            "text-[13px] font-medium normal-case tracking-normal text-[#8E96B0]",
        )}
      >
        {label}
      </p>
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel ?? label}
          title={addLabel ?? label}
          className="rounded p-1 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Sidebar navigation entry, styled to Buzz Dark: hover = white/4 wash, the
 * active row = the desktop's translucent white/18 pill (theme.css
 * --sidebar-row-active-surface), no accent color.
 * Calls useDrawerClose after selecting so the phone drawer dismisses.
 */
function SidebarNavButton({
  selected,
  label,
  icon,
  unread,
  onSelect,
  menuItems,
}: {
  selected: boolean;
  label: string;
  /** Leading glyph — channels pass the desktop's Hash mark. */
  icon?: ReactNode;
  /** Unread dot — newest activity newer than the read marker. */
  unread?: boolean;
  onSelect: () => void;
  /** Right-click / ⋯ context menu items, when provided. */
  menuItems?: ContextMenuItem[];
}) {
  const closeDrawer = useDrawerClose();
  const row = (open: (x: number, y: number) => void) => (
    <button
      type="button"
      className={cn(
        "group/row flex h-9 w-full items-center gap-1.5 truncate rounded-md px-2 text-left text-base transition-colors",
        "hover:bg-white/5 hover:text-foreground",
        selected &&
          "bg-[hsl(var(--sidebar-active))] font-medium text-[hsl(var(--sidebar-active-foreground))]",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
      onContextMenu={
        menuItems
          ? (event) => {
              event.preventDefault();
              open(event.clientX, event.clientY);
            }
          : undefined
      }
    >
      {icon}
      <span className="truncate">{label}</span>
      {unread && (
        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
      )}
      {menuItems && (
        // A real <button> cannot nest inside the row button — the span keeps
        // keyboard access via tabIndex + onKeyDown below.
        // biome-ignore lint/a11y/useSemanticElements: nested interactive elements cannot both be buttons
        <span
          role="button"
          tabIndex={0}
          aria-label={`Options for ${label}`}
          className={cn(
            "hidden shrink-0 rounded p-0.5 text-xs text-sidebar-foreground/60 hover:bg-white/10 group-hover/row:block",
            !unread && "ml-auto",
          )}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            open(rect.left, rect.bottom + 4);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              open(rect.left, rect.bottom + 4);
            }
          }}
        >
          ⋯
        </span>
      )}
    </button>
  );
  if (menuItems) {
    return <ContextMenu items={menuItems}>{row}</ContextMenu>;
  }
  return row(() => {});
}

/** The desktop's channel glyphs: Hash for public, Lock for private. */
function ChannelGlyph({ isPrivate }: { isPrivate?: boolean }) {
  const Glyph = isPrivate ? Lock : Hash;
  return (
    <Glyph
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-sidebar-foreground/60"
    />
  );
}

/** Forum channels get the desktop forum glyph instead of the Hash. */
function ChannelForum() {
  return (
    <MessageSquareText
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-sidebar-foreground/60"
    />
  );
}

/** Compact date for huddle entries: "Aug 29". */
function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * DM sidebar row in the desktop client's shape: avatar, display name, and a
 * one-line preview of the newest sampled message with its stamp.
 */
/**
 * Group-DM avatar placeholder (mock 2026-09-02): dark rounded square with
 * the member count, matching AuthorAvatar's md box so rows stay aligned.
 */
function GroupAvatar({ count, dm }: { count: number; dm?: boolean }) {
  if (dm) {
    // dm-list-spec.md §9: 24px circle, #191926 fill, #C5CFF2 numeral.
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#191926] text-xs font-bold text-[#C5CFF2]">
        {count}
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold text-foreground">
      {count}
    </span>
  );
}

/**
 * DM-list timer pill (dm-list-spec.md §6): 15px fully-rounded pill,
 * ~9% accent background, accent text; the whole element pulses
 * 0.8 → 1.0 → 0.8 with a phase tied to its own countdown (negative
 * animation-delay), and inverts on the selected row.
 */
function DmTimerPill({
  startedAt,
  now,
  selected,
}: {
  startedAt: number;
  now: number;
  selected: boolean;
}) {
  const period = 2.4;
  const elapsed = Math.max(0, now - startedAt);
  return (
    <span
      className={cn("dm-timer-pill", selected && "dm-timer-pill-selected")}
      style={{ animationDelay: `-${(elapsed % period).toFixed(2)}s` }}
    >
      {formatElapsed(startedAt, now)}
    </span>
  );
}

/**
 * Unread count for a DM row, derived from the persistent timeline cache:
 * cached, non-deleted messages from others newer than the read marker.
 * Null when the cache is cold (that DM was never opened here) — the badge
 * then renders its dot form without inventing a number.
 */
function useCachedUnreadCount(
  channelId: string | null,
  lastSeenAt: number | null,
  selfPubkey: string | null,
): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    if (!channelId || !lastSeenAt) {
      setCount(null);
      return;
    }
    void loadTimelineCache(channelId).then((entry) => {
      if (!alive) {
        return;
      }
      setCount(
        entry
          ? entry.messages.filter(
              (m) =>
                m.createdAt > lastSeenAt &&
                m.authorPubkey !== selfPubkey &&
                !m.deleted,
            ).length
          : null,
      );
    });
    return () => {
      alive = false;
    };
  }, [channelId, lastSeenAt, selfPubkey]);
  return count;
}

function DmNavRow({
  selected,
  unread,
  channelId,
  lastSeenAt,
  participants,
  selfPubkey,
  profiles,
  presence,
  onSelect,
  menuItems,
}: {
  selected: boolean;
  unread: boolean;
  channelId: string | null;
  /** Read marker (unix seconds) for the unread count, when known. */
  lastSeenAt: number | null;
  participants: string[];
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  /** Latest presence entry for the row's avatar pubkey, when subscribed. */
  presence?: PresenceEntry;
  onSelect: () => void;
  /** Right-click menu items (remove from list), when provided. */
  menuItems?: ContextMenuItem[];
}) {
  const closeDrawer = useDrawerClose();
  const others = participants.filter(
    (pubkey, index) =>
      pubkey !== selfPubkey && participants.indexOf(pubkey) === index,
  );
  const avatarPubkey = others[0] ?? participants[0] ?? "";
  const avatarLabel = profiles.get(avatarPubkey)?.displayName ?? avatarPubkey;
  const name = dmDisplayName(participants, selfPubkey ?? "", profiles);
  // Per-agent working pulse in the sidebar: the store's freshness view of
  // THIS row's agent (multi-agent aware — several rows can pulse at once).
  const rowFrames = useAgentFrames(avatarPubkey || null);
  const now = Math.floor(Date.now() / 1000);
  const active = agentRecentlyActive(rowFrames, now);
  useTick(active);
  const unreadCount = useCachedUnreadCount(channelId, lastSeenAt, selfPubkey);
  const row = (open: (x: number, y: number) => void) => (
    <button
      type="button"
      className={cn(
        // dm-list-spec.md §3: 32px rows, 8px-radius highlight inset 6px,
        // 24px avatar at 14px (8px inside the highlight), 8px avatar→label
        // gap, 4px badge inset on the right.
        "flex h-8 w-full items-center gap-2 rounded-lg pl-1.5 pr-1 text-left transition-colors",
        "hover:bg-white/5",
        // §5: flat solid #9A3EF6 fill, no ring, black label.
        selected && "bg-[#9A3EF6]",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
      onContextMenu={
        menuItems
          ? (event) => {
              event.preventDefault();
              open(event.clientX, event.clientY);
            }
          : undefined
      }
    >
      <span className="relative ml-2 shrink-0">
        {others.length > 1 ? (
          <GroupAvatar count={others.length} dm />
        ) : (
          <AuthorAvatar
            pubkey={avatarPubkey}
            label={avatarLabel}
            picture={profiles.get(avatarPubkey)?.avatar}
            size="dm"
          />
        )}
        {/* §8: 6px presence dot at the avatar's 45° bottom-right, ringed in
            the page background (cut-out), 1:1 rows only. */}
        {others.length <= 1 && presence && (
          <span
            title={presence.status}
            className={cn(
              "absolute bottom-[0.5px] right-[0.5px] size-1.5 rounded-full border-[1.5px] border-sidebar",
              presenceDotClass(presence.status),
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          // §4: read #A0A8C7 (500), unread #C4CFF2 (600), selected #000000.
          selected
            ? "font-medium text-black"
            : unread
              ? "font-semibold text-[#C4CFF2]"
              : "font-medium text-[#A0A8C7]",
        )}
      >
        {name}
      </span>
      {(active || (unread && !active)) && (
        <span className="flex shrink-0 items-center gap-2">
          {active && (
            <DmTimerPill
              startedAt={
                agentTurnStart(rowFrames) ?? rowFrames[0]?.createdAt ?? now
              }
              now={now}
              selected={selected}
            />
          )}
          {/* §7: 20px badge; §6: the pill's right edge stays fixed whether
              or not a badge is present — the 20px slot always reserves it. */}
          {unread && !active ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#9A3EF6] text-[11px] font-bold leading-none text-black">
              {unreadCount ?? ""}
            </span>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}
        </span>
      )}
    </button>
  );
  if (menuItems) {
    return <ContextMenu items={menuItems}>{row}</ContextMenu>;
  }
  return row(() => {});
}
