import { useEffect, useMemo, useRef, useState } from "react";
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
import { clampThreadWidth } from "@/features/channels/lib/threadPanelWidth.ts";
import { useThreadPaneWidth } from "@/features/channels/lib/useThreadPaneWidth.ts";
import {
  PANE_RESIZE_HANDLE_CLASSES,
  usePointerDrag,
} from "@/shared/layout/usePointerDrag.ts";
import { usePermalinkCleanup } from "@/features/channels/lib/usePermalinkCleanup.ts";
import { useChannelLists } from "@/features/channels/lib/useChannelLists.ts";
import { useLandingConversation } from "@/features/channels/lib/useLandingConversation.ts";
import { landingBeforeLoad } from "@/features/channels/lib/lastConversationScope.ts";
import { LandingSkeleton } from "@/features/channels/ui/LandingSkeleton";
import { useMessageActions } from "@/features/channels/lib/useMessageActions.ts";
import { paletteActions } from "@/features/channels/lib/paletteActions.ts";
import { isNativeIOS } from "@/shared/platform/native";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import { Composer, type ComposerHandle } from "@/features/channels/ui/Composer";
import { DmComposerActions } from "@/features/channels/ui/DmComposerActions";
import { useComposerDictation } from "@/features/channels/useComposerDictation";
import { useTimelinePrefetch } from "@/features/channels/useTimelinePrefetch";
import { useDmRightPane } from "@/features/channels/useDmRightPane";
import { ForumView } from "@/features/channels/ui/ForumView";
import { MessageToasts } from "@/features/channels/ui/MessageToasts";
import { SearchPanel } from "@/features/channels/ui/SearchPanel";
import { HuddleDock } from "@/features/huddle/ui/HuddleDock";
import { useHuddleSession } from "@/features/huddle/HuddleSessionProvider";
import { useRouteMentionMembers } from "@/features/huddle/useHuddleMentionMembers";
import { eligibleDmAgentPubkey } from "@/features/huddle/lib/dmAgentCall.ts";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import {
  useAgentFrames,
  useAgentObserverHistory,
  useObserverStore,
} from "@/features/agents/ObserverProvider";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { agentWorkingState } from "@/features/agents/lib/observerEvents";
import { useTick } from "@/features/agents/ui/WorkingBadge";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { AgentPortraitOverlay } from "@/features/agents/ui/AgentPortraitOverlay";
import { openDm, useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { useHiddenDms } from "@/features/dms/useHiddenDms.ts";
import { channelMenuItems } from "@/features/sidebar/lib/channelMenuItems.ts";
import { SidebarWithBadges } from "@/features/sidebar/ui/SidebarWithBadges";
import { AsksProvider } from "@/features/home/AsksProvider";
import { HomeInboxRoute } from "@/features/home/ui/HomeInboxRoute";
import { WorkflowsPage } from "@/features/workflows/ui/WorkflowsPage";
import { OnboardingPane } from "@/features/onboarding";
import { ProjectsScreen } from "@/features/projects/ui/ProjectsScreen";
import { PulseScreen } from "@/features/pulse/ui/PulseScreen";
import { useReminderSync } from "@/features/reminders/hooks";
import { useReminderNotifications } from "@/features/reminders/useReminderNotifications";
import { RemindersPanel } from "@/features/reminders/ui/RemindersPanel";
import { RemindMeLaterProvider } from "@/features/reminders/ui/RemindMeLaterProvider";
import { NotificationRuntime } from "@/features/notifications/ui/NotificationRuntime";
import { ProfileActionsProvider } from "@/features/profile/ProfileActionsContext";
import { useShellWebView } from "@/features/webPanels/useShellWebView";
import { WebLayer } from "@/features/webPanels/ui/WebLayer";
import { AppShell } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { StageRoute } from "@/features/stage/ui/StageRoute";
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

  // DMs ride the same kind:39000 list (relay `t` tag); they get their own
  // sidebar section and participant-based names.
  const {
    dms,
    channelsWithoutDms: unfilteredChannels,
    dmSamplingSettled,
  } = useDms(channels);
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
  const selfPubkey = useOwnPubkey();
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
  /**
   * Reply targets have no row in the channel timeline (replies collapse
   * under their roots), so a permalink to one lands on its ROOT row and
   * opens the thread panel — where replies render as full rows (D-043). A
   * reply whose root fell outside the buffer needs neither: the timeline
   * renders it as an orphan top-level row, so it jumps directly.
   */
  const permalinkJump = useMemo(() => {
    if (!permalinkMessageId) {
      return null;
    }
    const byId = new Map(messages.map((m) => [m.id, m]));
    let current = byId.get(permalinkMessageId);
    if (!current) {
      return null;
    }
    let topLevelId = current.id;
    for (let hops = 0; hops < 100; hops += 1) {
      const parentId = current.rootId ?? current.replyToId;
      if (!parentId) {
        break;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        break;
      }
      topLevelId = parent.id;
      current = parent;
    }
    return {
      isReply: topLevelId !== permalinkMessageId,
      topLevelId,
    };
  }, [permalinkMessageId, messages]);
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
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  /**
   * D-043: a permalink to a REPLY opens the thread on its root (the effect)
   * and, once that thread is the one open, names the reply so the panel's
   * list jumps to it (the derived id below).
   */
  useEffect(() => {
    if (permalinkJump?.isReply) {
      setThreadRootId(permalinkJump.topLevelId);
    }
  }, [permalinkJump]);
  const threadPermalinkId =
    permalinkMessageId != null &&
    permalinkJump?.isReply &&
    permalinkJump.topLevelId === threadRootId
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
  const threadRoot = threadRootId
    ? (messages.find((m) => m.id === threadRootId) ?? null)
    : null;
  // Right-pane width (thread + agent activity share it), drag-resizable.
  // Ceiling is relative to the layout ROW (window minus the app sidebar) so
  // the pane can take nearly the whole row instead of the old 640px cap,
  // without starving the timeline while the sidebar is open; a width
  // persisted on a big window re-clamps on a smaller one.
  // Pane width state machine (persist, clamps on mount / channel change /
  // window resize) — extracted from this file for the size ratchet. The
  // ResizeObserver inside it closes a PRE-EXISTING breach: the app sidebar's
  // width is AppShell local state, so a sidebar drag resizes the layout row
  // without any window resize, and a pane width persisted on a wide row
  // quietly starved the channel column (reproduced 2026-09-14: chat at 77px
  // after min-sidebar → max-pane → max-sidebar). The row element arrives via
  // ref callback so the observer attaches whenever the row mounts, whatever
  // the navigation path. Rail reservation inactive here — no portrait rail
  // on this surface.
  const { setRowEl, shellRowWidth, threadWidth, setThreadWidth } =
    useThreadPaneWidth(channelId, false);
  // Dragging the side panel's left edge rightward shrinks it (touch-safe).
  const sidePanelDrag = usePointerDrag({
    onDrag: (deltaX) =>
      setThreadWidth((previous) =>
        clampThreadWidth(previous - deltaX, shellRowWidth()),
      ),
  });
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
  const { web, openFiles, openLink, activeTitle } = useShellWebView(
    `${selectedId ?? ""}|${view ?? ""}`,
  );
  // Sidebar + buttons: section-header plus buttons open the create dialogs.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  // Hidden DMs — relay-synced (NIP-DV: 41012 hide, 30622 snapshot);
  // re-opening the DM via the new-DM flow (41010) un-hides it.
  const hiddenDms = useHiddenDms(session, selfPubkey);
  const hiddenDmIds = hiddenDms.hiddenDmIds;
  const lists = useChannelLists({
    channels: unfilteredChannels,
    dms,
    channelPrefs,
    hiddenDmIds,
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

  const selectChannel = (channelId: string) => {
    setThreadRootId(null);
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
      remindersSelected={view === "reminders"}
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
        onOpenReminders: () =>
          void navigate({ to: "/repos", search: { view: "reminders" } }),
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
  const agentPubkeys = useMemo(() => {
    const set = new Set(observerStore?.byAgent.keys() ?? []);
    for (const entry of agentRegistry) {
      set.add(entry.pubkey);
    }
    return set;
  }, [observerStore, agentRegistry]);
  const agentFrames = useAgentFrames(dmAgentPubkey);
  // The live REQ only carries the last few minutes (see ObserverProvider), so
  // an agent's earlier turns come from its own retained history. Scoped to the
  // open DM's agent: the sidebar rows deliberately do NOT fetch, or every row
  // would pull a page of its own.
  useAgentObserverHistory(dmAgentPubkey);
  const channelAgentFrames = useMemo(
    () =>
      agentFrames.filter(
        (frame) => frame.channelId === null || frame.channelId === current?.id,
      ),
    [agentFrames, current?.id],
  );
  // The DM right-pane state (thinking sheet / desktop collapse / tab) plus
  // the two-way 🧠 and Replies toggles Sam asked for on 2026-09-22. The
  // show/hide policy lives in features/channels/lib/dmPaneToggles.ts; the
  // route keeps threadRootId itself (the permalink effect below reads it).
  const {
    thinkingOpen,
    setThinkingOpen,
    dmPaneHidden,
    setDmPaneHidden,
    rightTab,
    setRightTab,
    panes,
  } = useDmRightPane({
    agentDm: dmAgentPubkey !== null,
    channelId: selectedId,
    threadRootId,
    setThreadRootId,
    ownerPubkey: selfPubkey,
  });
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
  // Composer dictation: the mic button on the actions row streams through
  // the STT bridge and appends finalized utterances to the composer's draft
  // via its imperative handle — the route owns the wiring between the two.
  const composerRef = useRef<ComposerHandle | null>(null);
  const dictation = useComposerDictation({
    onFinalTranscript: (text) => composerRef.current?.appendDictation(text),
  });
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
    // AsksProvider owns the always-on asks badge + answer detection; once at
    // the shell, same discipline as NotificationRuntime.
    <AsksProvider channels={channels} selfPubkey={selfPubkey}>
      {/* Mounted at the shell so it outlives every route the signed-in app can
        be on; in the sidebar it died wherever the sidebar unmounted. It takes
        the shell's channel list rather than opening a second kind:39000 REQ. */}
      <NotificationRuntime selfPubkey={selfPubkey} channels={channels} />
      <StageRoute
        {...{ messages, members, profiles, send, selfPubkey }}
        channelId={current?.id ?? null}
      />
      {/* Same mount discipline as NotificationRuntime: once at the shell, so
        toasts survive every view. The channel side consumes the shell's
        shared activity feed; the DM side opens the feed's DM-scoped twin. */}
      <MessageToasts
        selfPubkey={selfPubkey}
        selectedId={selectedId ?? null}
        channels={channels}
        channelLiveEvents={channelActivity.onLiveEvent}
        dmChannelIds={dmChannelIds}
        channelPrefs={channelPrefs}
        profiles={dmProfiles}
        onOpenChannel={selectChannel}
      />
      <RemindMeLaterProvider selfPubkey={selfPubkey}>
        <ProfileActionsProvider
          // The profile dialog's "Recent" list knows event and channel ids but
          // not names, and cannot route — the shell owns both. Without these it
          // still renders, just unnamed and unclickable.
          channelName={(channelId) =>
            channels.find((channel) => channel.id === channelId)?.name ?? ""
          }
          onOpenMessage={(channelId, messageId) => {
            void navigate({
              to: "/repos",
              search: { c: channelId, m: messageId },
            });
          }}
          onOpenDm={(pubkey) => {
            void openDm(session, [pubkey]).then((result) => {
              if (result.ok && result.channelId) {
                onDmOpened(result.channelId);
              }
            });
          }}
        >
          <AppShell
            chromeless={web.state.active !== null && web.state.focus}
            sidebar={sidebar}
            title={
              activeTitle !== null
                ? activeTitle
                : current
                  ? current.type === "dm"
                    ? dmName(current.participantPubkeys)
                    : `# ${current.name}`
                  : null
            }
          >
            <div className="relative h-full min-h-0">
              {view === "onboarding" ? (
                <OnboardingPane />
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
                  ref={setRowEl}
                  className="buzz-conversation-row flex h-full min-h-0"
                  style={{ ["--thread-width" as string]: `${threadWidth}px` }}
                >
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
                          profiles.get(dmAgentPubkey)?.displayName ??
                          dmAgentPubkey
                        }
                        picture={dmProfiles.get(dmAgentPubkey)?.avatar}
                      />
                    )}
                    {/* The channel header bar is gone (Sam, 2026-09-22). Its
                      parts went where they still belong: Join / Members /
                      the copy-name action to the composer's bottom bar, and
                      Call / Thinking to that bar's right end. The channel
                      name, type glyph and description are already in the
                      sidebar row and the window title, so the bar was a
                      second copy of the row you just clicked. */}
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
                            highlightId={permalinkJump?.topLevelId ?? null}
                            scrollToMessageId={
                              permalinkJump?.topLevelId ?? null
                            }
                            onScrollToMessageSettled={onPermalinkSettled}
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
                                      profiles.get(dmAgentPubkey)
                                        ?.displayName ?? dmAgentPubkey,
                                    startedAt: working.startedAt,
                                  }
                                : null
                            }
                          />
                        </div>
                        {/* No threadRef here — deliberately. With a thread open
                          in the right pane this composer used to be re-aimed
                          at it, so typing in the MAIN composer silently filed
                          the message into the thread. It always posts
                          top-level now (Sam 2026-09-20); only the thread
                          pane's own composer targets the thread, and Esc here
                          is free to do nothing instead of closing it. */}
                        <Composer
                          ref={composerRef}
                          members={members}
                          onTextChange={messageActions.onComposerText}
                          editing={messageActions.editing}
                          onCancelEdit={() => messageActions.setEditing(null)}
                          editSend={messageActions.editSend}
                          profiles={profiles}
                          strictMentions={strictMentions}
                          draftKey={current.id}
                          send={send}
                          actionsBar={
                            <DmComposerActions
                              channel={current}
                              title={
                                current.type === "dm"
                                  ? dmName(current.participantPubkeys)
                                  : `# ${current.name}`
                              }
                              dmAgentPubkey={dmAgentPubkey}
                              huddleSession={huddleSession}
                              session={session}
                              members={members}
                              profiles={profiles}
                              presence={presence}
                              selfPubkey={selfPubkey}
                              contacts={dmParticipantPubkeys}
                              panes={panes}
                              dictation={dictation}
                            />
                          }
                        />
                      </>
                    )}
                    <HuddleDock currentChannelId={current.id} />
                  </section>
                  {(threadRoot || dmAgentPubkey) && (
                    // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
                    // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
                    <div
                      aria-label="Resize side panel"
                      // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
                      role="separator"
                      aria-orientation="vertical"
                      // No border of its own: the pane's border-l is the one divider (a
                      // second 1px border read as "two scrollbars and a sliver").
                      className={`buzz-side-panel-resize-handle relative z-10 hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 lg:block lg:-ml-px ${PANE_RESIZE_HANDLE_CLASSES}`}
                      {...sidePanelDrag}
                    />
                  )}
                  {threadRoot && (!dmAgentPubkey || rightTab === "thread") && (
                    <ThreadPanel
                      root={threadRoot}
                      buffer={messages}
                      members={members}
                      profiles={profiles}
                      agentPubkeys={agentPubkeys}
                      strictMentions={strictMentions}
                      selfPubkey={selfPubkey}
                      permalinkMessageId={threadPermalinkId}
                      onPermalinkSettled={onPermalinkSettled}
                      onClose={() => setThreadRootId(null)}
                      send={send}
                    />
                  )}
                  {threadRoot && dmAgentPubkey && rightTab === "thinking" && (
                    <ThreadPanel
                      root={threadRoot}
                      buffer={messages}
                      members={members}
                      profiles={profiles}
                      agentPubkeys={agentPubkeys}
                      strictMentions={strictMentions}
                      selfPubkey={selfPubkey}
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
              ) : landingSkeleton ? (
                <LandingSkeleton />
              ) : (
                <div className="flex h-full items-center justify-center p-8">
                  <p className="text-sm text-muted-foreground">
                    Pick a channel to get started.
                  </p>
                </div>
              )}
              <WebLayer web={web} />
            </div>
            <SearchPanel
              open={searchOpen}
              onClose={closeSearch}
              initialQuery={sidebarQuery}
              onJumpToChannel={(id) => selectChannel(id)}
              actions={palette}
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
        </ProfileActionsProvider>
      </RemindMeLaterProvider>
    </AsksProvider>
  );
}
