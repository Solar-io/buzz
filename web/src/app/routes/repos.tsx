import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import {
  sendChannelMessage,
  useChannelMembers,
  useChannelMessages,
  useProfiles,
  type Profile,
} from "@/features/channels/hooks";
import { useChannels } from "@/features/channels/useChannels";
import { replyCounts } from "@/features/channels/lib/messageBuffer.ts";
import {
  AuthorAvatar,
  ChannelTimeline,
} from "@/features/channels/ui/ChannelTimeline";
import { Composer } from "@/features/channels/ui/Composer";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import { useObserverEvents } from "@/features/agents/hooks";
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
  validateSearch: (search: Record<string, unknown>): { c?: string } => ({
    c: typeof search.c === "string" ? search.c : undefined,
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
  const { channels, connected } = useChannels();
  const navigate = useNavigate({ from: "/repos" });
  const selectedId = Route.useSearch({ select: (s) => s.c });
  const current = channels.find((channel) => channel.id === selectedId) ?? null;

  // DMs ride the same kind:39000 list (relay `t` tag); they get their own
  // sidebar section and participant-based names.
  const { dms, channelsWithoutDms: unfilteredChannels } = useDms(channels);
  // Archived channels (expired huddles etc.) hide from the sidebar — the
  // relay's `archived` tag exists for exactly this. Ephemeral (ttl) channels
  // are huddle backing rooms: grouped apart, newest first, not mixed into
  // the main channel list.
  const visibleChannels = useMemo(
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
  const messages = useChannelMessages(current?.id ?? null);
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
  const counts = useMemo(() => replyCounts(messages), [messages]);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Re-scroll on the newest message id; also re-run when switching channels
  // (two channels can share a last-message id only in the empty case).
  // Double-rAF: the first frame commits layout for freshly rendered rows,
  // the second measures the final scrollHeight — scrolling synchronously in
  // the effect left iOS at the TOP of long back-logs. A delayed second pass
  // catches late-sizing media (images/video placeholders).
  const lastMessageId = messages[messages.length - 1]?.id ?? "";
  const channelId = current?.id ?? "";
  useEffect(() => {
    if (channelId === "" || lastMessageId === "") {
      return;
    }
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const scrollToEnd = () => {
      scroller.scrollTo({ top: scroller.scrollHeight });
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(scrollToEnd));
    const settle = window.setTimeout(scrollToEnd, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [channelId, lastMessageId]);

  const send = (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: { rootId: string; replyToId: string } | null;
    mediaTags: string[][];
  }) => {
    if (!current) {
      return Promise.resolve({ ok: false, message: "No channel selected." });
    }
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
    });
  };

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
        <ul className="space-y-0.5">
          {visibleChannels.map((channel) => (
            <li key={channel.id}>
              <SidebarNavButton
                selected={channel.id === selectedId}
                label={channel.name}
                icon={<ChannelHash />}
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
        {huddleChannels.length > 0 && (
          <details className="px-0 pt-2">
            <summary className="flex h-8 cursor-pointer select-none items-center px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
              Huddles ({huddleChannels.length})
            </summary>
            <ul className="space-y-0.5">
              {huddleChannels.map((channel) => (
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
                    participants={channel.participantPubkeys}
                    selfPubkey={selfPubkey}
                    profiles={dmProfiles}
                    lastMessage={lastMessage}
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
          onCreated={(channelId) =>
            void navigate({ to: "/repos", search: { c: channelId } })
          }
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
  const observerFeed = useObserverEvents(
    threadRoot === null ? dmAgentPubkey : null,
  );
  const [thinkingOpen, setThinkingOpen] = useState(false);
  // DM right-pane tabs: thinking ↔ thread replies (channels stay thread-only).
  const [rightTab, setRightTab] = useState<"thinking" | "thread">("thinking");

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
              {dmAgentPubkey && (
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent lg:hidden"
                  onClick={() => {
                    setRightTab("thinking");
                    setThinkingOpen(true);
                  }}
                >
                  🧠 Thinking
                </button>
              )}
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <ChannelTimeline
                messages={messages}
                profiles={profiles}
                replyCounts={counts}
                onOpenThread={(message) => {
                  setThreadRootId(message.id);
                  setRightTab("thread");
                }}
                activeRootId={threadRootId}
              />
            </div>
            <Composer
              members={members}
              profiles={profiles}
              threadRef={
                threadRoot
                  ? { rootId: threadRoot.id, replyToId: threadRoot.id }
                  : null
              }
              onClearThread={() => setThreadRootId(null)}
              send={send}
            />
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
          {dmAgentPubkey && (!threadRoot || rightTab === "thinking") && (
            <AgentActivityPanel
              agentPubkey={dmAgentPubkey}
              agentName={
                profiles.get(dmAgentPubkey)?.displayName ?? dmAgentPubkey
              }
              profile={dmProfiles.get(dmAgentPubkey)}
              frames={observerFeed.frames}
              lockedCount={observerFeed.lockedCount}
              connected={connected}
              mobileOpen={thinkingOpen}
              onCloseMobile={() => setThinkingOpen(false)}
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
  onSelect,
}: {
  selected: boolean;
  label: string;
  /** Leading glyph — channels pass the desktop's Hash mark. */
  icon?: ReactNode;
  onSelect: () => void;
}) {
  const closeDrawer = useDrawerClose();
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-1.5 truncate rounded-md px-2 text-left text-base transition-colors",
        "hover:bg-white/5 hover:text-foreground",
        selected && "bg-white/[0.18] font-medium text-foreground",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The desktop's channel glyph: a muted Hash in front of channel names. */
function ChannelHash() {
  return (
    <Hash
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
  participants,
  selfPubkey,
  profiles,
  lastMessage,
  onSelect,
}: {
  selected: boolean;
  participants: string[];
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  lastMessage: DmLastMessage | null;
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
      <AuthorAvatar
        pubkey={avatarPubkey}
        label={avatarLabel}
        picture={profiles.get(avatarPubkey)?.avatar}
        size="md"
      />
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
      {lastMessage && (
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {shortStamp(lastMessage.created_at)}
        </span>
      )}
    </button>
  );
}
