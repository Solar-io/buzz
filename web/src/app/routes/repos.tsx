import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Hash, Lock, MessageSquareText } from "lucide-react";
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
  leaveChannel,
  sendPresence,
  usePresence,
} from "@/features/channels/hooks";
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
import { useTick, WorkingBadge } from "@/features/agents/ui/WorkingBadge";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import type { DmLastMessage } from "@/features/dms/lib/dmActivity.ts";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { AppShell, useDrawerClose } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { cn } from "@/shared/lib/cn";

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
  const { messages, reactions, typing } = useChannelMessages(
    current?.id ?? null,
  );
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
  const members = useChannelMembers(current?.id ?? null);
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
            <p className="flex h-8 items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Starred
            </p>
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
            <p className="mt-4 flex h-8 items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Channels
            </p>
          </>
        )}
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
        {dms.length > 0 && (
          <>
            <p className="mt-4 flex h-8 items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Direct messages
            </p>
            <ul className="space-y-0.5">
              {dms.map(({ channel, lastMessage }) => (
                <li key={channel.id}>
                  <DmNavRow
                    selected={channel.id === selectedId}
                    unread={
                      lastMessage
                        ? isUnread(
                            readState,
                            channel.id,
                            lastMessage.created_at,
                          )
                        : false
                    }
                    participants={channel.participantPubkeys}
                    selfPubkey={selfPubkey}
                    profiles={dmProfiles}
                    lastMessage={lastMessage}
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
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="space-y-0.5 border-t border-border p-2">
        <NewDmDialog
          onOpened={(channelId) =>
            void navigate({ to: "/repos", search: { c: channelId } })
          }
        />
        <NewChannelDialog
          onCreated={(channelId) => {
            void navigate({ to: "/repos", search: { c: channelId } });
            // The relay stores the 39000 in a spawned task with no live
            // fan-out — staggered re-REQs pick it up once it lands.
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          }}
        />
        <Link
          to="/repos/browse"
          className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        >
          Browse repositories
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
  // ⌘K / Ctrl+K opens search from anywhere in the app.
  const [searchOpen, setSearchOpen] = useState(false);
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
      {current ? (
        <div
          className="flex h-full min-h-0"
          style={{ ["--thread-width" as string]: `${threadWidth}px` }}
        >
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[#272736] px-4">
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
                  🎙
                </button>
              )}
              <button
                type="button"
                aria-label="Search messages"
                title="Search (⌘K)"
                className={cn(
                  "shrink-0 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent",
                  current.ttlSeconds === null && "ml-auto",
                )}
                onClick={() => setSearchOpen(true)}
              >
                🔍
              </button>
              {dmAgentPubkey && (
                <button
                  type="button"
                  aria-label="Toggle thinking panel"
                  className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    setRightTab("thinking");
                    setDmPaneHidden(false);
                    setThinkingOpen(true);
                  }}
                >
                  🧠
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
            <div
              aria-label="Resize side panel"
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
        onClose={() => setSearchOpen(false)}
        channels={channels}
        profiles={profiles}
        defaultChannelId={current?.id ?? null}
        onOpenResult={(channelId, messageId) => {
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
        selected && "bg-white/[0.18] font-medium text-foreground",
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

/** Sidebar timestamp for DM rows: time today, else short date. */
function shortStamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * DM sidebar row in the desktop client's shape: avatar, display name, and a
 * one-line preview of the newest sampled message with its stamp.
 */
function DmNavRow({
  selected,
  unread,
  participants,
  selfPubkey,
  profiles,
  lastMessage,
  presence,
  onSelect,
}: {
  selected: boolean;
  unread: boolean;
  participants: string[];
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  lastMessage: DmLastMessage | null;
  /** Latest presence entry for the row's avatar pubkey, when subscribed. */
  presence?: PresenceEntry;
  onSelect: () => void;
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
  const active = agentRecentlyActive(rowFrames, Math.floor(Date.now() / 1000));
  useTick(active);
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        "hover:bg-white/5",
        selected && "bg-white/[0.18]",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
    >
      <span className="relative shrink-0">
        <AuthorAvatar
          pubkey={avatarPubkey}
          label={avatarLabel}
          picture={profiles.get(avatarPubkey)?.avatar}
          size="md"
        />
        {active ? (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
          </span>
        ) : (
          presence && (
            <span
              title={presence.status}
              className={cn(
                "absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border border-sidebar",
                presenceDotClass(presence.status),
              )}
            />
          )
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-base",
            selected ? "font-medium text-foreground" : "text-foreground",
          )}
        >
          {name}
        </span>
        {lastMessage && (
          <span className="block truncate text-xs text-muted-foreground">
            {lastMessage.excerpt || "…"}
          </span>
        )}
      </span>
      {active && (
        <WorkingBadge
          startedAt={agentTurnStart(rowFrames) ?? rowFrames[0]?.createdAt ?? 0}
          compact
        />
      )}
      {unread && !active && (
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
      )}
      {lastMessage && !active && (
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {shortStamp(lastMessage.created_at)}
        </span>
      )}
    </button>
  );
}
