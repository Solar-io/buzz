import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import {
  useChannelMembers,
  useChannelMessages,
  useProfiles,
} from "@/features/channels/hooks";
import {
  useChannels,
  type ChannelSummary,
} from "@/features/channels/useChannels";
import {
  loadChannelPrefs,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import { sendPresence, usePresence } from "@/features/channels/hooks";
import { shortKey } from "@/features/dms/lib/dmNaming.ts";

import { replyCounts } from "@/features/channels/lib/messageBuffer.ts";
import { unreactToMessage } from "@/features/channels/lib/unreact.ts";
import {
  loadReadState,
  markSeen,
  saveReadState,
  type ReadState,
} from "@/features/channels/lib/readState.ts";
import { activeTyping } from "@/features/channels/lib/typing.ts";
import { useChannelLists } from "@/features/channels/lib/useChannelLists.ts";
import { useMessageActions } from "@/features/channels/lib/useMessageActions.ts";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import { ChannelHeader } from "@/features/channels/ui/ChannelHeader";
import { Composer } from "@/features/channels/ui/Composer";
import { ForumView } from "@/features/channels/ui/ForumView";
import { SearchPanel } from "@/features/channels/ui/SearchPanel";
import { HuddleBar } from "@/features/huddle/ui/HuddleBar";
import { useHuddleLinks } from "@/features/huddle/useHuddleLinks";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import {
  useAgentFrames,
  useObserverStore,
} from "@/features/agents/ObserverProvider";
import { agentWorkingState } from "@/features/agents/lib/observerEvents";
import { useTick } from "@/features/agents/ui/WorkingBadge";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { openDm, useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import {
  hideDm,
  loadHiddenDms,
  saveHiddenDms,
  unhideDm,
} from "@/features/dms/lib/hiddenDms.ts";
import { channelMenuItems } from "@/features/sidebar/lib/channelMenuItems.ts";
import { ChannelSidebar } from "@/features/sidebar/ui/ChannelSidebar";
import { HomeInboxRoute } from "@/features/home/ui/HomeInboxRoute";
import { WorkflowsPage } from "@/features/workflows/ui/WorkflowsPage";
import { ProjectsScreen } from "@/features/projects/ui/ProjectsScreen";
import { PulseScreen } from "@/features/pulse/ui/PulseScreen";
import { useReminderSync } from "@/features/reminders/hooks";
import { useReminderNotifications } from "@/features/reminders/useReminderNotifications";
import { RemindersPanel } from "@/features/reminders/ui/RemindersPanel";
import { RemindMeLaterProvider } from "@/features/reminders/ui/RemindMeLaterProvider";
import { NotificationRuntime } from "@/features/notifications/ui/NotificationRuntime";
import { ProfileActionsProvider } from "@/features/profile/ProfileActionsContext";
import { FilesPanel } from "@/features/files/ui/FilesPanel";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { AppShell } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

/**
 * The app lives at /repos — the one browser-servable path the relay's
 * public-bundle fallback guarantees on the stock image (with the git web GUI
 * flag on). Everything else is client-side navigation from here.
 */
/**
 * Panes the shell can show instead of a channel.
 *
 * These are `?view=` rather than routes because a route unmounts the sidebar,
 * and the sidebar is what holds the channel subscriptions every pane reads
 * from. It also keeps each pane linkable.
 */
const SHELL_VIEWS = [
  "inbox",
  "workflows",
  "pulse",
  "reminders",
  "projects",
] as const;
type ShellView = (typeof SHELL_VIEWS)[number];

export const Route = createFileRoute("/repos")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { c?: string; m?: string; view?: ShellView } => ({
    c: typeof search.c === "string" ? search.c : undefined,
    // Permalink target: scroll to and flash this message once it loads.
    m: typeof search.m === "string" ? search.m : undefined,
    // The inbox is a view of the same shell, not a separate route: a route
    // would unmount the sidebar, and the shell is what holds the channel
    // subscriptions every pane reads from.
    view: SHELL_VIEWS.includes(search.view as ShellView)
      ? (search.view as ShellView)
      : undefined,
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
  const view = Route.useSearch({ select: (s) => s.view });
  const current = channels.find((channel) => channel.id === selectedId) ?? null;

  // DMs ride the same kind:39000 list (relay `t` tag); they get their own
  // sidebar section and participant-based names.
  const { dms, channelsWithoutDms: unfilteredChannels } = useDms(channels);
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

  const { session, status: relayStatus } = useRelaySession();
  const channelId = current?.id ?? "";
  const {
    messages,
    reactions,
    typing,
    loadOlder,
    loadingOlder,
    historyExhausted,
    forgetOwnReaction,
  } = useChannelMessages(current?.id ?? null);
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
  // React / edit / delete / share / typing / send for the open channel.
  const messageActions = useMessageActions({
    session,
    current,
    channelId,
    selfPubkey,
  });
  const { send } = messageActions;
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

  const huddleLinks = useHuddleLinks();
  const currentHuddleParent =
    current && huddleLinks.has(current.id)
      ? (huddleLinks.get(current.id)?.parentId ?? null)
      : null;

  // Viewer-side channel prefs (starred / muted), local like the desktop's DB.
  const [channelPrefs, setChannelPrefs] = useState<ChannelPrefs>(() =>
    loadChannelPrefs(),
  );
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
  const lists = useChannelLists({
    channels: unfilteredChannels,
    dms,
    channelPrefs,
    hiddenDmIds,
    huddleLinks,
  });

  const selectChannel = (channelId: string) => {
    setThreadRootId(null);
    void navigate({ to: "/repos", search: { c: channelId } });
  };

  /**
   * Actions the ⌘K palette offers alongside channel jumps. Defined here
   * rather than in the panel because every one of them is a shell concern —
   * the panel ranks and renders, the shell decides what the app can do.
   */
  const paletteActions = useMemo(
    () => [
      {
        id: "action:new-channel",
        kind: "action" as const,
        label: "New channel",
        keywords: ["create", "add", "channel"],
        onSelect: () => setNewChannelOpen(true),
      },
      {
        id: "action:new-dm",
        kind: "action" as const,
        label: "New message",
        keywords: ["dm", "direct", "message", "person"],
        onSelect: () => setNewDmOpen(true),
      },
      {
        id: "action:inbox",
        kind: "action" as const,
        label: "Inbox",
        keywords: ["inbox", "mentions", "unread", "home"],
        onSelect: () =>
          void navigate({ to: "/repos", search: { view: "inbox" } }),
      },
      {
        id: "action:projects",
        kind: "action" as const,
        label: "Projects",
        keywords: ["project", "issue", "board", "backlog", "repo"],
        onSelect: () =>
          void navigate({ to: "/repos", search: { view: "projects" } }),
      },
      {
        id: "action:pulse",
        kind: "action" as const,
        label: "Pulse",
        keywords: ["pulse", "notes", "feed", "social"],
        onSelect: () =>
          void navigate({ to: "/repos", search: { view: "pulse" } }),
      },
      {
        id: "action:reminders",
        kind: "action" as const,
        label: "Reminders",
        keywords: ["reminder", "remind", "later", "snooze", "due"],
        onSelect: () =>
          void navigate({ to: "/repos", search: { view: "reminders" } }),
      },
      {
        id: "action:workflows",
        kind: "action" as const,
        label: "Workflows",
        keywords: ["workflow", "automation", "runs", "trigger"],
        onSelect: () =>
          void navigate({ to: "/repos", search: { view: "workflows" } }),
      },
      {
        id: "action:files",
        kind: "action" as const,
        label: "Files",
        keywords: ["files", "browse"],
        onSelect: () => setFilesOpen(true),
      },
      {
        id: "action:settings",
        kind: "action" as const,
        label: "Settings",
        keywords: ["settings", "preferences", "theme", "appearance"],
        onSelect: () => void navigate({ to: "/repos/settings" }),
      },
      {
        id: "action:agents",
        kind: "action" as const,
        label: "Agents",
        keywords: ["agents", "bots"],
        onSelect: () => void navigate({ to: "/repos/agents" }),
      },
    ],
    [navigate],
  );
  const closeChannel = () => {
    void navigate({ to: "/repos", search: { c: undefined } });
  };
  const onChannelCreated = (channelId: string) => {
    void navigate({ to: "/repos", search: { c: channelId } });
    // The relay stores the 39000 in a spawned task with no live
    // fan-out — staggered re-REQs pick it up once it lands.
    window.setTimeout(refreshChannels, 500);
    window.setTimeout(refreshChannels, 2000);
  };
  const onDmOpened = (channelId: string) => {
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
  };
  const onHideDm = (channelId: string) => {
    persistHiddenDms(hideDm(hiddenDmIds, channelId));
    if (selectedId === channelId) {
      closeChannel();
    }
  };
  const onHuddleStarted = (channelId: string) => {
    void navigate({ to: "/repos", search: { c: channelId } });
    // The private room's 39000 has no live fan-out —
    // staggered re-REQs pull it into the sidebar.
    window.setTimeout(refreshChannels, 500);
    window.setTimeout(refreshChannels, 2000);
  };

  const sidebar = (
    <ChannelSidebar
      connected={connected}
      relayStatus={relayStatus}
      inboxSelected={view === "inbox"}
      channelCount={channels.length}
      selectedId={selectedId}
      lists={{
        starred: lists.starred,
        unstarred: lists.unstarred,
        forums: lists.forums,
        huddles: lists.huddles,
        dms,
        visibleDms: lists.visibleDms,
      }}
      readState={{ prefs: channelPrefs, read: readState }}
      search={{
        query: sidebarQuery,
        onQueryChange: openSearch,
        onFocus: () => setSearchOpen(true),
      }}
      dmIdentity={{
        selfPubkey,
        profiles: dmProfiles,
        presence,
        contacts: dmParticipantPubkeys,
      }}
      dialogs={{
        newChannelOpen,
        onNewChannelOpenChange: setNewChannelOpen,
        newDmOpen,
        onNewDmOpenChange: setNewDmOpen,
      }}
      actions={{
        onSelectChannel: selectChannel,
        channelMenuItems: (channel: ChannelSummary) =>
          channelMenuItems(channel, {
            session,
            channelPrefs,
            setChannelPrefs,
            setReadState,
            refreshChannels,
            selectedId,
            onCloseChannel: closeChannel,
          }),
        onChannelCreated,
        onDmOpened,
        onHideDm,
        onOpenFiles: () => setFilesOpen(true),
        onOpenInbox: () =>
          void navigate({ to: "/repos", search: { view: "inbox" } }),
      }}
    />
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

  // Both belong at the shell and nowhere else: the sync keeps one kind:30300
  // subscription for the whole app, and the notification hook is the sole
  // due-detector — mounted per pane it would fire once per mounted copy.
  useReminderSync(selfPubkey);
  useReminderNotifications({
    selfPubkey,
    onOpenPanel: () =>
      void navigate({ to: "/repos", search: { view: "reminders" } }),
  });

  return (
    // Profile cards open DMs; DM creation is the shell's job, and the row that
    // raises the card renders under ChannelTimeline, so the callback reaches it
    // by context rather than through two files the shell does not own.
    <>
      {/* Mounted at the shell so it outlives every route the signed-in app can
        be on; in the sidebar it died wherever the sidebar unmounted. It takes
        the shell's channel list rather than opening a second kind:39000 REQ. */}
      <NotificationRuntime selfPubkey={selfPubkey} channels={channels} />
      <RemindMeLaterProvider selfPubkey={selfPubkey}>
        <ProfileActionsProvider
          onOpenDm={(pubkey) => {
            void openDm(session, [pubkey]).then((result) => {
              if (result.ok && result.channelId) {
                onDmOpened(result.channelId);
              }
            });
          }}
        >
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
            ) : view === "projects" ? (
              <ProjectsScreen />
            ) : view === "pulse" ? (
              <PulseScreen
                onClose={() => void navigate({ to: "/repos", search: {} })}
                selfPubkey={selfPubkey}
              />
            ) : view === "reminders" ? (
              <RemindersPanel
                channels={channels}
                onClose={() => void navigate({ to: "/repos", search: {} })}
                onJump={(destination) => {
                  void navigate({
                    to: "/repos",
                    search: {
                      c: destination.channelId,
                      m: destination.messageId,
                    },
                  });
                }}
                selfPubkey={selfPubkey}
              />
            ) : view === "workflows" ? (
              <WorkflowsPage />
            ) : view === "inbox" ? (
              <HomeInboxRoute
                channels={channels}
                selfPubkey={selfPubkey}
                onOpenChannel={(channelId, messageId) => {
                  void navigate({
                    to: "/repos",
                    search: { c: channelId, m: messageId },
                  });
                }}
              />
            ) : current ? (
              <div
                className="flex h-full min-h-0"
                style={{ ["--thread-width" as string]: `${threadWidth}px` }}
              >
                <section className="flex min-w-0 flex-1 flex-col">
                  <ChannelHeader
                    channel={current}
                    title={
                      current.type === "dm"
                        ? dmName(current.participantPubkeys)
                        : `# ${current.name}`
                    }
                    session={session}
                    onHuddleStarted={onHuddleStarted}
                    agentPubkey={dmAgentPubkey}
                    onOpenThinking={() => {
                      setRightTab("thinking");
                      setDmPaneHidden(false);
                      setThinkingOpen(true);
                    }}
                  />
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
                      onReact={messageActions.onReact}
                      onDelete={messageActions.onDelete}
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
                        onReact={messageActions.onReact}
                        onUnreact={(messageId, emoji) => {
                          if (!selfPubkey) return;
                          // Drop it locally first: the relay's kind-5 acknowledgement
                          // targets the reaction event, which the message-overlay
                          // path cannot apply, so nothing would clear the chip.
                          forgetOwnReaction(messageId, emoji, selfPubkey);
                          void unreactToMessage(session, {
                            targetEventId: messageId,
                            emoji,
                            selfPubkey,
                          });
                        }}
                        onEdit={messageActions.onEdit}
                        onDelete={messageActions.onDelete}
                        onShare={messageActions.onShare}
                        selfPubkey={selfPubkey}
                        pendingIds={messageActions.pendingIds}
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
                        onTextChange={messageActions.onComposerText}
                        editing={messageActions.editing}
                        onCancelEdit={() => messageActions.setEditing(null)}
                        editSend={messageActions.editSend}
                        profiles={profiles}
                        threadRef={
                          threadRoot
                            ? {
                                rootId: threadRoot.id,
                                replyToId: threadRoot.id,
                              }
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
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      ) {
                        setThreadWidth((previous) =>
                          Math.min(
                            640,
                            Math.max(288, previous - event.movementX),
                          ),
                        );
                      }
                    }}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
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
                        profiles.get(dmAgentPubkey)?.displayName ??
                        dmAgentPubkey
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
              onJumpToChannel={(id) => selectChannel(id)}
              actions={paletteActions}
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
        </ProfileActionsProvider>
      </RemindMeLaterProvider>
    </>
  );
}
