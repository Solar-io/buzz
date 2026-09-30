import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import {
  useChannelActivity,
  useChannelMessages,
  useProfiles,
} from "@/features/channels/hooks";
import {
  useChannels,
  type ChannelSummary,
} from "@/features/channels/useChannels";
import {
  loadChannelPrefs,
  setFavorite,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import { sendPresence, usePresence } from "@/features/channels/hooks";

import { replyCounts } from "@/features/channels/lib/messageBuffer.ts";
import { timelineReplyCounts } from "@/features/channels/lib/threadSummaryEvent.ts";
import { unreactToMessage } from "@/features/channels/lib/unreact.ts";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import {
  loadReadState,
  markSeen,
  saveReadState,
  type ReadState,
} from "@/features/channels/lib/readState.ts";
import { notifyReadStateLocalChange } from "@/features/channels/lib/readStateSync.ts";
import { useReadStateSync } from "@/features/channels/lib/useReadStateSync.ts";
import { activeTyping } from "@/features/channels/lib/typing.ts";
import { usePermalinkCleanup } from "@/features/channels/lib/usePermalinkCleanup.ts";
import { permalinkJumpTarget } from "@/features/channels/lib/permalinkJump.ts";
import { conversationIdentity } from "@/features/channels/lib/conversationIdentity.ts";
import { useScratch } from "@/features/scratch/useScratch.ts";
import { useChannelLists } from "@/features/channels/lib/useChannelLists.ts";
import { useLandingConversation } from "@/features/channels/lib/useLandingConversation.ts";
import { landingBeforeLoad } from "@/features/channels/lib/lastConversationScope.ts";
import { LandingSkeleton } from "@/features/channels/ui/LandingSkeleton";
import { useMessageActions } from "@/features/channels/lib/useMessageActions.ts";
import { paletteActions } from "@/features/channels/lib/paletteActions.ts";
import { isNativeIOS } from "@/shared/platform/native";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import type { ComposerHandle } from "@/features/channels/ui/Composer";
import { ChannelHeader } from "@/features/channels/ui/ChannelHeader";
import { CommandComposer } from "@/features/commands/ui/CommandComposer";
import { paletteCommands } from "@/features/commands/lib/commands.ts";
import { DmComposerActions } from "@/features/channels/ui/DmComposerActions";
import { useComposerDictation } from "@/features/channels/useComposerDictation";
import { useTimelinePrefetch } from "@/features/channels/useTimelinePrefetch";
import { ForumView } from "@/features/channels/ui/ForumView";
import { SearchPanel } from "@/features/channels/ui/SearchPanel";
import { HuddleDock } from "@/features/huddle/ui/HuddleDock";
import { useHuddleSession } from "@/features/huddle/HuddleSessionProvider";
import { useRouteMentionMembers } from "@/features/huddle/useHuddleMentionMembers";
import { eligibleDmAgentPubkey } from "@/features/huddle/lib/dmAgentCall.ts";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { soleAgent } from "@/features/channels/lib/soleAgent.ts";
import { useInlineThreads } from "@/features/channels/useInlineThreads.ts";
import { useReplyIntent } from "@/features/channels/useReplyIntent.ts";
import { useJumpShortcut } from "@/features/search/useJumpShortcut.ts";
import {
  memberSubtitle,
  memberSummary,
} from "@/features/channels/lib/memberSummary.ts";
import { saveWorkScope } from "@/features/work/lib/workPrefs.ts";
import { RunningStrip } from "@/features/work/ui/RunningStrip";
import { useRecordConversationVisits } from "@/features/sidebar/lib/useSidebarOrder.ts";
import { ShellViewPane } from "../ShellViewPane";
import { ShellProviders } from "../ShellProviders";
import { useShellRightPane } from "@/features/shell/useShellRightPane.ts";
import { RightPaneHost } from "@/features/shell/ui/RightPaneHost";
import { PhoneNav, PhoneWorkPill } from "@/features/shell/ui/PhoneNav";
import { unreadConversationCount } from "@/features/sidebar/lib/rowUnread.ts";
import { lastPhoneTab, phoneTabBarVisible } from "@/shared/layout/phoneTabs.ts";
import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useDmAgentActivity } from "@/features/agents/useDmAgentActivity.ts";
import { AgentPortraitOverlay } from "@/features/agents/ui/AgentPortraitOverlay";
import { useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { useHiddenDms } from "@/features/dms/useHiddenDms.ts";
import { channelMenuItems } from "@/features/sidebar/lib/channelMenuItems.ts";
import { SidebarWithBadges } from "@/features/sidebar/ui/SidebarWithBadges";
import { useReminderSync } from "@/features/reminders/hooks";
import { useReminderNotifications } from "@/features/reminders/useReminderNotifications";
import { useShellWebView } from "@/features/webPanels/useShellWebView";
import { WebLayer } from "@/features/webPanels/ui/WebLayer";
import { AppShell } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { validateReposSearch } from "../reposSearch.ts";

/**
 * The app lives at /repos — the one browser-servable path the relay's
 * public-bundle fallback guarantees on the stock image (with the git web GUI
 * flag on). Everything else is client-side navigation from here.
 */
export const Route = createFileRoute("/repos")({
  validateSearch: validateReposSearch,
  // Plan item 5: a bare /repos lands in the last conversation BEFORE the
  // first paint, so "Pick a channel" never flashes. Only fires with no c,
  // view or m — the redirect carries c, which is the loop guard.
  beforeLoad: landingBeforeLoad,
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
  const {
    channels,
    connected,
    refresh: refreshChannels,
    forgetChannel: forgetChannelFromList,
    loaded: channelsLoaded,
  } = useChannels();
  const navigate = useNavigate({ from: "/repos" });
  const selectedId = Route.useSearch({ select: (s) => s.c });
  const permalinkMessageId = Route.useSearch({ select: (s) => s.m });
  const view = Route.useSearch({ select: (s) => s.view });
  const current = channels.find((channel) => channel.id === selectedId) ?? null;

  const selfPubkey = useOwnPubkey();
  // DMs ride the same kind:39000 list (relay `t` tag); they get their own
  // sidebar section and participant-based names.
  const {
    dms,
    channelsWithoutDms: unfilteredChannels,
    dmSamplingSettled,
  } = useDms(channels, selfPubkey);
  // Newest-message feed over every non-DM channel the sidebar can show:
  // the shell owns it ONCE so the unread dots and the message toasts read
  // the same subscription (archived channels hide from the sidebar, so they
  // stay out of the REQ — same filter NotificationRuntime applies).
  const channelActivityIds = useMemo(
    () =>
      unfilteredChannels
        .filter((channel) => !channel.archived)
        .map((channel) => channel.id),
    [unfilteredChannels],
  );
  const dmChannelIds = useMemo(
    () => dms.map(({ channel }) => channel.id),
    [dms],
  );
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
  const huddleSession = useHuddleSession();
  const channelId = current?.id ?? "";
  const {
    messages,
    reactions,
    typing,
    threadSummaries,
    loadOlder,
    loadingOlder,
    historyExhausted,
    forgetOwnReaction,
  } = useChannelMessages(current?.id ?? null);
  // Read state: opening a channel marks its newest message seen; badges and
  // the timeline unread divider derive from the marker.
  const [readState, setReadState] = useState<ReadState>(() => loadReadState());
  // Counting activity feed: newest samples PLUS live unread counts. Lives
  // after readState/selfPubkey because it consumes both — a marker move
  // re-opens the counting windows at the new `since`, and a locked key
  // (selfPubkey null) transiently over-counts until identity lands.
  const channelActivity = useChannelActivity(channelActivityIds, {
    readMarkers: readState,
    selfPubkey,
  });
  // Idle-prefetch the most recent conversations into the timeline store so
  // switching to one paints from memory (background-sync plan §4.3).
  useTimelinePrefetch({
    channelActivity: channelActivity.activity,
    dms,
    openId: current?.id ?? null,
  });
  const newestMessageAt = messages[messages.length - 1]?.createdAt ?? 0;
  useEffect(() => {
    if (channelId === "" || newestMessageAt === 0) {
      return;
    }
    setReadState((previous) => {
      const next = markSeen(previous, channelId, newestMessageAt);
      if (next !== previous) {
        saveReadState(next);
        notifyReadStateLocalChange();
      }
      return next;
    });
  }, [channelId, newestMessageAt]);
  // Cross-browser sync (NIP-RS): boot-merge the relay's markers in, and let
  // the debounced publisher carry every local persist above to other
  // browsers. Strictly additive — see readStateSync.ts.
  useReadStateSync({
    session,
    selfPubkey,
    onSynced: () => setReadState(loadReadState()),
  });
  // React / edit / delete / share / typing / send for the open channel.
  const messageActions = useMessageActions({
    session,
    current,
    channelId,
    selfPubkey,
  });
  const { send } = messageActions;
  // Permalink target (?m=): the timeline scrolls it into view and flashes it;
  // m is dropped only once it LANDED (see usePermalinkCleanup).
  const permalinkReady =
    permalinkMessageId != null &&
    messages.some((m) => m.id === permalinkMessageId);
  // A reply's permalink lands on its root row and opens its thread (D-043).
  const permalinkJump = useMemo(
    () => permalinkJumpTarget(messages, permalinkMessageId),
    [permalinkMessageId, messages],
  );
  // Drop ?m= once the jump reports it landed (or 4s without progress).
  const onPermalinkSettled = usePermalinkCleanup({
    permalinkMessageId,
    permalinkReady,
    selectedId,
    navigate,
  });
  // Typing row: re-derive every few seconds so entries expire visibly.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 3000);
    return () => window.clearInterval(timer);
  }, []);
  const { members, strictMentions } = useRouteMentionMembers(
    current,
    selfPubkey,
    huddleSession.call,
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
  const counts = useMemo(
    () => timelineReplyCounts(replyCounts(messages), threadSummaries),
    [messages, threadSummaries],
  );
  // Threads open in place, under their message (web redesign Phase 2): the
  // route holds which rows are open because a reply permalink, the ↩ action
  // and a card's "Answer in chat" all open one from outside the row.
  const inlineThreads = useInlineThreads(selectedId);
  const revealThread = inlineThreads.reveal;
  /**
   * D-043: a permalink to a REPLY opens its row's thread (the effect) and
   * names the reply, so the thread shows every reply and the target row
   * scrolls into view and flashes (`revealId` below).
   */
  useEffect(() => {
    if (permalinkJump?.isReply) {
      revealThread(permalinkJump.topLevelId);
    }
  }, [permalinkJump, revealThread]);
  const revealReplyId =
    permalinkMessageId != null && permalinkJump?.isReply
      ? permalinkMessageId
      : null;
  // Forum thread selection: picking a post swaps the posts list for the
  // thread view. Switching channels clears it (same reset pattern as the
  // stream thread/editing state above).
  const [forumPostId, setForumPostId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger by design
  useEffect(() => {
    setForumPostId(null);
  }, [channelId]);
  // Auto-tail now lives INSIDE the virtualized timeline (tailKey) — the VList
  // owns its scroll node. The key covers both new messages and channel
  // switches (two channels share a last-message id only in the empty case).
  const lastMessageId = messages[messages.length - 1]?.id ?? "";
  const tailKey =
    channelId === "" || lastMessageId === ""
      ? null
      : `${channelId}:${lastMessageId}`;

  // Viewer-side prefs (favorites / muted), local like the desktop's DB.
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
  // The web layer (Links + Files): ONE "what's showing" state, an
  // always-mounted frame host, and a keep-alive LRU (plan items 3 + 4). A
  // link/Files click shows a page from any state; any conversation
  // navigation hides the layer without unloading its frames.
  const { web, openFiles, openLink, activeTitle, layerMode } = useShellWebView(
    `${selectedId ?? ""}|${view ?? ""}`,
  );
  // Sidebar + buttons: section-header plus buttons open the create dialogs.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  // Hidden DMs — relay-synced (NIP-DV: 41012 hide, 30622 snapshot);
  // re-opening the DM via the new-DM flow (41010) un-hides it.
  const hiddenDms = useHiddenDms(session, selfPubkey);
  const hiddenDmIds = hiddenDms.hiddenDmIds;
  // Scratch channels (Phase 3): /new, /exit (with its Undo window), /keep.
  const scratch = useScratch({
    session,
    channels,
    selfPubkey,
    openRoster: {
      channelId: current?.id ?? null,
      pubkeys: members.map((m) => m.pubkey),
    },
    openChannel: (id) => void navigate({ to: "/repos", search: { c: id } }),
    refreshChannels,
    evict: {
      setChannelPrefs,
      setReadState,
      onChannelDeleted: forgetChannelFromList,
    },
  });
  const lists = useChannelLists({
    channels: unfilteredChannels,
    dms,
    channelPrefs,
    hiddenDmIds,
    exitingScratchIds: scratch.exitingIds,
  });

  // Landing (plan item 5 + D-025): the last-opened conversation restored
  // by beforeLoad is validated here, D-025 picks the most recently active DM
  // when nothing was restored, and every selection is remembered.
  const channelIds = useMemo(() => channels.map((c) => c.id), [channels]);
  const { showSkeleton: landingSkeleton } = useLandingConversation({
    selectedId,
    view,
    connected,
    channelIds,
    samplingSettled: dmSamplingSettled,
    channelsLoaded,
    visibleDms: lists.visibleDms,
    fallbackChannelIds: lists.landingChannelIds,
    hiddenDmIds,
    selfPubkey,
    webViewOpen: web.state.active !== null,
    openConversation: (id) =>
      void navigate({ to: "/repos", search: { c: id }, replace: true }),
    clearConversation: () =>
      void navigate({ to: "/repos", search: {}, replace: true }),
  });

  useRecordConversationVisits(selectedId); // Favorites/Channels "most used"
  const selectChannel = (channelId: string) => {
    web.hide();
    void navigate({ to: "/repos", search: { c: channelId } });
  };

  /**
   * Actions the ⌘K palette offers alongside channel jumps. Every one of them
   * is a shell concern — the panel ranks and renders, the shell decides what
   * the app can do. The list itself lives in features/channels/lib so this
   * route file stays under the repo's file-size ceiling.
   */
  const palette = useMemo(
    () =>
      paletteActions({
        openView: (view) => void navigate({ to: "/repos", search: { view } }),
        openSettings: () => void navigate({ to: "/repos/settings" }),
        openAgents: () => void navigate({ to: "/repos/agents" }),
        onNewChannel: () => setNewChannelOpen(true),
        onNewDm: () => setNewDmOpen(true),
        onOpenFiles: openFiles,
      }).filter((action) => !isNativeIOS() || action.id !== "action:agents"),
    [navigate, openFiles],
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
    hiddenDms.markOpened(channelId);
    web.hide();
    void navigate({ to: "/repos", search: { c: channelId } });
    // The relay stores the DM's 39000 in a spawned task with no
    // live fan-out — without a re-REQ the new channel never lands,
    // the ?c= view stays on the empty state, and the DM is missing
    // from the sidebar (mirrors NewChannelDialog's onCreated).
    window.setTimeout(refreshChannels, 500);
    window.setTimeout(refreshChannels, 2000);
  };
  const onHideDm = (channelId: string) => {
    hiddenDms.hide(channelId);
    if (selectedId === channelId) {
      closeChannel();
    }
  };
  const sidebar = (
    <SidebarWithBadges
      connected={connected}
      relayStatus={relayStatus}
      inboxSelected={view === "inbox"}
      workSelected={view === "work"}
      itemsSelected={view === "items"}
      channelCount={channels.length}
      selectedId={selectedId}
      lists={{ ...lists, dms }}
      readState={{
        prefs: channelPrefs,
        read: readState,
        activity: channelActivity.activity,
        unreadCounts: channelActivity.unreadCounts,
      }}
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
            onChannelDeleted: forgetChannelFromList,
            selectedId,
            onCloseChannel: closeChannel,
          }),
        onChannelCreated,
        onDmOpened,
        onHideDm,
        onSetFavorite: (ref, on) =>
          setChannelPrefs((prefs) => setFavorite(prefs, ref, on)),
        onOpenFiles: openFiles,
        onOpenInbox: () =>
          void navigate({ to: "/repos", search: { view: "inbox" } }),
        onOpenWork: () =>
          void navigate({ to: "/repos", search: { view: "work" } }),
        onOpenItems: () => openView("items"),
        onOpenShortcutOverlay: openLink,
      }}
    />
  );

  // Per-agent selection from the global observer store (one subscription,
  // indexed by the frame's agent tag — no cross-agent leakage).
  const observerStore = useObserverStore();
  // Agent identity: any pubkey that has emitted observer frames this session.
  // The desktop reads its local agents registry; the web's relay-native
  // equivalent is the observer store (agents active since page load).
  // Who gets the "agent" badge on a message row. The registry is the
  // authoritative answer and does not decay; the observer store adds anything
  // currently emitting frames that the registry has not caught up with. Before
  // the live REQ was bounded, the store alone happened to cover ~10 hours of
  // activity — narrowing it to five minutes would otherwise have quietly
  // un-badged any agent that had been quiet for longer.
  const agentRegistry = useAgentRegistry();
  const knownAgentPubkeys = useMemo(() => {
    const set = new Set(observerStore?.byAgent.keys() ?? []);
    for (const entry of agentRegistry) {
      set.add(entry.pubkey.toLowerCase());
    }
    return set;
  }, [observerStore, agentRegistry]);
  // A direct call is only offered for a true 1:1 DM whose one counterparty is
  // known to be an agent. Group DMs and human DMs keep their normal header.
  const dmAgentPubkey = useMemo(() => {
    return current
      ? eligibleDmAgentPubkey({
          channelType: current.type,
          participantPubkeys: current.participantPubkeys,
          selfPubkey,
          knownAgentPubkeys,
        })
      : null;
  }, [current, selfPubkey, knownAgentPubkeys]);
  // The main composer notifies the room's one agent without a typed @ (Sam
  // 2026-09-29), the channel/DM twin of the thread pane's partner rule. A
  // mention is the only wake path, so without it a post reaches nobody.
  const composerAutoNotify = useMemo(() => {
    const pubkey = soleAgent(
      members.map((member) => member.pubkey),
      selfPubkey,
      knownAgentPubkeys,
    );
    return pubkey ? { pubkey, label: authorLabel(pubkey, profiles) } : null;
  }, [members, selfPubkey, knownAgentPubkeys, profiles]);
  const agentPubkeys = useMemo(() => {
    const set = new Set(observerStore?.byAgent.keys() ?? []);
    for (const entry of agentRegistry) {
      set.add(entry.pubkey);
    }
    return set;
  }, [observerStore, agentRegistry]);
  // The agent DM's observer frames + "received and working" turn state.
  const { frames: channelAgentFrames, working } = useDmAgentActivity(
    dmAgentPubkey,
    current?.id,
    messages,
  );
  // The right pane (Work / agent thinking) — widths and the DM pane state
  // live in useShellRightPane; what shows is rightPaneLayout().
  const rightPane = useShellRightPane({
    surface: view !== undefined ? "view" : current ? "conversation" : "none",
    channelId,
    selectedId,
    dmAgentPubkey,
    selfPubkey,
    webLayer: layerMode,
    workIsPage: view === "work",
  });
  // `/status`: Work scoped to a channel — the rail at lg, the page below it.
  const [workChannelId, setWorkChannelId] = useState<string | null>(null);
  const showWork = rightPane.showWork;
  const openWorkForChannel = useCallback(
    (id: string) => {
      saveWorkScope("channel");
      if (globalThis.matchMedia?.("(min-width: 64rem)").matches ?? true) {
        showWork();
        return;
      }
      setWorkChannelId(id);
      void navigate({ to: "/repos", search: { view: "work" } });
    },
    [showWork, navigate],
  );
  // Phone (below md): tab pages get the bottom tab bar; a conversation or
  // the web layer takes the screen and gets a back chevron instead.
  const phoneTabs = phoneTabBarVisible({
    conversationOpen: current !== null,
    view,
    webLayerActive: web.state.active !== null,
  });
  const openView = (next: NonNullable<typeof view>) =>
    void navigate({ to: "/repos", search: { view: next } });
  // Its title ("flight-path / scratch-1" for a scratch), and the channel as
  // slash commands — and ⌘K's list of them — see it.
  const { title: conversationTitle, commandChannel } = conversationIdentity(
    current,
    channels,
    dmName,
  );
  const openMessage = (c: string, m?: string) => {
    web.hide();
    void navigate({ to: "/repos", search: { c, m } });
  };
  useJumpShortcut(() => setSearchOpen(true));
  // Composer dictation: the mic button on the actions row streams through
  // the STT bridge and appends finalized utterances to the composer's draft
  // via its imperative handle — the route owns the wiring between the two.
  const composerRef = useRef<ComposerHandle | null>(null);
  const dictation = useComposerDictation({
    onFinalTranscript: (text) => composerRef.current?.appendDictation(text),
  });
  useReplyIntent({
    reply: Route.useSearch({ select: (s) => s.reply }),
    messageId: permalinkMessageId,
    topLevelId: permalinkJump?.topLevelId ?? null,
    isDm: current?.type === "dm",
    replyInThread: inlineThreads.reply,
    focusComposer: () => composerRef.current?.focus(),
  });
  // Both belong at the shell and nowhere else: the sync keeps one kind:30300
  // subscription for the whole app, and the notification hook is the sole
  // due-detector — mounted per pane it would fire once per mounted copy.
  useReminderSync(selfPubkey);
  useReminderNotifications({
    selfPubkey,
    onOpenPanel: () => openView("reminders"),
    onOpenMessage: openMessage,
  });

  return (
    <ShellProviders
      channels={channels}
      selfPubkey={selfPubkey}
      stage={{
        messages,
        members,
        profiles,
        send,
        channelId: current?.id ?? null,
      }}
      toasts={{
        selectedId: selectedId ?? null,
        channelLiveEvents: channelActivity.onLiveEvent,
        dmChannelIds,
        channelPrefs,
        profiles: dmProfiles,
        onOpenChannel: selectChannel,
      }}
      work={{ agentPubkeys: knownAgentPubkeys, readState }}
      onDmOpened={onDmOpened}
    >
      <AppShell
        phoneTabBar={
          phoneTabs ? (
            <PhoneNav
              view={view}
              unread={unreadConversationCount(
                [...lists.streams, ...lists.forums],
                lists.visibleDms,
                {
                  prefs: channelPrefs,
                  read: readState,
                  activity: channelActivity.activity,
                  selfPubkey,
                },
              )}
              onOpenView={openView}
              onOpenFiles={openFiles}
              onOpenSettings={() => void navigate({ to: "/repos/settings" })}
              onOpenAgents={() => void navigate({ to: "/repos/agents" })}
            />
          ) : undefined
        }
        onPhoneBack={
          phoneTabs
            ? undefined
            : () =>
                web.state.active !== null
                  ? web.hide()
                  : openView(lastPhoneTab())
        }
        phoneBarTrailing={<PhoneWorkPill onOpen={() => openView("work")} />}
        chromeless={web.state.active !== null && web.state.focus}
        sidebar={sidebar}
        title={activeTitle !== null ? activeTitle : conversationTitle}
        subtitle={
          activeTitle === null && current && current.type !== "dm"
            ? memberSubtitle(
                memberSummary(
                  members.map((member) => member.pubkey),
                  knownAgentPubkeys,
                ),
              )
            : null
        }
        rowRef={rightPane.row.ref}
        rowStyle={rightPane.row.style}
        rowClassName={
          view === undefined && current ? "buzz-conversation-row" : undefined
        }
        mainOverlay={<WebLayer web={web} />}
        rightPane={
          <RightPaneHost
            {...rightPane.hostProps}
            work={{
              channelId: view === undefined && current ? current.id : null,
              onOpenMessage: openMessage,
              onOpenChannel: selectChannel,
              onOpenView: openView,
              ...rightPane.workFold,
            }}
            activity={
              dmAgentPubkey
                ? {
                    agentPubkey: dmAgentPubkey,
                    agentName:
                      profiles.get(dmAgentPubkey)?.displayName ?? dmAgentPubkey,
                    profile: dmProfiles.get(dmAgentPubkey),
                    frames: channelAgentFrames,
                    lockedCount: observerStore?.lockedCount ?? 0,
                    connected,
                    working,
                  }
                : null
            }
          />
        }
      >
        <div className="relative h-full min-h-0">
          {view !== undefined ? (
            <ShellViewPane
              view={view}
              channels={channels}
              selfPubkey={selfPubkey}
              onClose={() => void navigate({ to: "/repos", search: {} })}
              onOpenMessage={openMessage}
              onOpenView={openView}
              onJump={() => setSearchOpen(true)}
              workChannelId={workChannelId}
              onClearWorkChannel={() => setWorkChannelId(null)}
              scratch={scratch.actions}
              channelsPage={
                <>
                  <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground md:hidden">
                    {sidebar}
                  </div>
                  <p className="hidden h-full items-center justify-center text-sm text-muted-foreground md:flex">
                    Pick a channel to get started.
                  </p>
                </>
              }
            />
          ) : current ? (
            // The flex row the section always sat in (its pane siblings now
            // live in the AppShell row, beside `main`).
            <div className="flex h-full min-h-0">
              <section
                className="buzz-conversation-pane relative flex min-w-0 flex-1 flex-col"
                data-custom-content-pane="chat"
              >
                {dmAgentPubkey && (
                  // Stationary portrait over the chat column (Sam's
                  // placement verdict, 2026-09-14): anchored top-right, it
                  // never scrolls with the transcript, and its fluid width
                  // reflows as the thinking pane is dragged. The matching
                  // gutter on the timeline below keeps the text clear of
                  // it. Same agent-chosen kind-0 avatar as the panel chip;
                  // a swap repaints it in place.
                  <AgentPortraitOverlay
                    pubkey={dmAgentPubkey}
                    name={
                      profiles.get(dmAgentPubkey)?.displayName ?? dmAgentPubkey
                    }
                    picture={dmProfiles.get(dmAgentPubkey)?.avatar}
                  />
                )}
                {/* The header is back (web redesign Phase 2), carrying what
                      the sidebar row cannot: the topic and the facepile.
                      Call / Thinking / dictation stay on the composer row. */}
                <ChannelHeader
                  channel={current}
                  title={conversationTitle ?? ""}
                  members={members}
                  profiles={profiles}
                  presence={presence}
                  selfPubkey={selfPubkey}
                  contacts={dmParticipantPubkeys}
                  agentPubkeys={knownAgentPubkeys}
                  dmAgentPubkey={dmAgentPubkey}
                  scratch={{
                    actions: scratch.actions,
                    channels,
                    lastActivityAt: newestMessageAt || null,
                  }}
                />
                <RunningStrip
                  channelId={current.id}
                  profiles={profiles}
                  variant="bar"
                />
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
                    {/* Gutter for the portrait overlay: the same fluid
                          width the overlay uses, so transcript text shifts
                          left of it and stays clear at every thinking-pane
                          width (the pair is the resize requirement). The
                          extra half-row keeps a visible seam between
                          full-width content and the frame. */}
                    <div className="flex min-h-0 flex-1 flex-col lg:pr-[calc(min(12rem,24%)+1.25rem)]">
                      <ChannelTimeline
                        messages={messages}
                        profiles={profiles}
                        replyCounts={counts}
                        threads={{
                          expandedIds: inlineThreads.expandedIds,
                          focusId: inlineThreads.focusId,
                          revealId: revealReplyId,
                          onToggle: inlineThreads.toggle,
                          onReply: inlineThreads.reply,
                          isDm: current.type === "dm",
                          reply: { members, strictMentions, send },
                        }}
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
                        highlightId={permalinkJump?.topLevelId ?? null}
                        scrollToMessageId={permalinkJump?.topLevelId ?? null}
                        onScrollToMessageSettled={onPermalinkSettled}
                        typingNames={typingNames}
                        tailKey={tailKey}
                        onLoadOlder={loadOlder}
                        loadingOlder={loadingOlder}
                        historyExhausted={historyExhausted}
                      />
                    </div>
                    {/* No threadRef here — deliberately. This composer always
                          posts top-level (Sam 2026-09-20); only a thread's
                          own reply box targets the thread. Slash commands run
                          here and are never sent as text. */}
                    <CommandComposer
                      ref={composerRef}
                      host={{
                        channel: commandChannel,
                        messages,
                        openWorkForChannel,
                        scratch: scratch.actions,
                      }}
                      placeholder={`Message ${conversationTitle?.replace(/^# /, "#") ?? ""}`}
                      footer={
                        <RunningStrip
                          channelId={current.id}
                          profiles={profiles}
                          variant="line"
                        />
                      }
                      members={members}
                      onTextChange={messageActions.onComposerText}
                      editing={messageActions.editing}
                      onCancelEdit={() => messageActions.setEditing(null)}
                      editSend={messageActions.editSend}
                      profiles={profiles}
                      strictMentions={strictMentions}
                      autoNotify={composerAutoNotify}
                      draftKey={current.id}
                      send={send}
                      actionsBar={
                        <DmComposerActions
                          channel={current}
                          title={conversationTitle ?? ""}
                          dmAgentPubkey={dmAgentPubkey}
                          huddleSession={huddleSession}
                          session={session}
                          members={members}
                          profiles={profiles}
                          presence={presence}
                          selfPubkey={selfPubkey}
                          contacts={dmParticipantPubkeys}
                          panes={rightPane.panes}
                          dictation={dictation}
                        />
                      }
                    />
                  </>
                )}
                <HuddleDock currentChannelId={current.id} />
              </section>
            </div>
          ) : landingSkeleton ? (
            <LandingSkeleton />
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <p className="text-sm text-muted-foreground">
                Pick a channel to get started.
              </p>
            </div>
          )}
        </div>
        <SearchPanel
          open={searchOpen}
          onClose={closeSearch}
          initialQuery={sidebarQuery}
          onJumpToChannel={(id) => selectChannel(id)}
          actions={palette}
          commands={
            current && current.type !== "forum" && view === undefined
              ? paletteCommands({
                  channel: commandChannel,
                  selfPubkey,
                  scratch: scratch.actions,
                }).map((command) => ({
                  id: command.id,
                  hint: command.describe,
                  // Into the composer, caret after the name: ↵ there runs it.
                  onSelect: () =>
                    composerRef.current?.prefill(`/${command.id} `),
                }))
              : undefined
          }
          dmLabel={(channel) => dmName(channel.participantPubkeys)}
          selfPubkey={selfPubkey}
          channels={channels}
          profiles={profiles}
          defaultChannelId={current?.id ?? null}
          onOpenResult={(channelId, messageId) => {
            web.hide();
            void navigate({
              to: "/repos",
              search: { c: channelId, m: messageId },
            });
          }}
        />
      </AppShell>
    </ShellProviders>
  );
}
