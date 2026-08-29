import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import {
  sendChannelMessage,
  useChannelMembers,
  useChannelMessages,
  useProfiles,
} from "@/features/channels/hooks";
import { useChannels } from "@/features/channels/useChannels";
import { replyCounts } from "@/features/channels/lib/messageBuffer.ts";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import { Composer } from "@/features/channels/ui/Composer";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import { useDms } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { AppShell } from "@/shared/layout/AppShell";
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
  const { dms, channelsWithoutDms } = useDms(channels);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Re-scroll on the newest message id; also re-run when switching channels.
  const lastMessageId = messages[messages.length - 1]?.id ?? current?.id ?? "";
  useEffect(() => {
    // lastMessageId is the trigger: "" = no channel yet, nothing to scroll.
    if (lastMessageId === "") {
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lastMessageId]);

  const send = (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: { rootId: string; replyToId: string } | null;
  }) => {
    if (!current) {
      return Promise.resolve({ ok: false, message: "No channel selected." });
    }
    return sendChannelMessage(session, {
      channelId: current.id,
      content: options.content,
      mentionPubkeys: options.mentionPubkeys,
      threadRef: options.threadRef,
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
              connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
            title={connected ? "Connected" : "Connecting…"}
          />
          <Link
            to="/repos/settings"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
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
          {channelsWithoutDms.map((channel) => (
            <li key={channel.id}>
              <button
                type="button"
                className={cn(
                  "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  channel.id === selectedId && "bg-accent font-medium",
                )}
                onClick={() => {
                  setThreadRootId(null);
                  void navigate({
                    to: "/repos",
                    search: { c: channel.id },
                  });
                }}
              >
                {channel.name}
              </button>
            </li>
          ))}
        </ul>
        {dms.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Direct messages
            </p>
            <ul className="space-y-0.5">
              {dms.map(({ channel }) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      channel.id === selectedId && "bg-accent font-medium",
                    )}
                    onClick={() => {
                      setThreadRootId(null);
                      void navigate({
                        to: "/repos",
                        search: { c: channel.id },
                      });
                    }}
                  >
                    {dmName(channel.participantPubkeys)}
                  </button>
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

  return (
    <AppShell sidebar={sidebar}>
      {current ? (
        <div className="flex h-full min-h-0">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-border px-4 py-3">
              <h1 className="truncate text-lg font-semibold">
                {current.type === "dm"
                  ? dmName(current.participantPubkeys)
                  : current.name}
              </h1>
              {current.type !== "dm" && current.about && (
                <p className="truncate text-sm text-muted-foreground">
                  {current.about}
                </p>
              )}
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <ChannelTimeline
                messages={messages}
                profiles={profiles}
                replyCounts={counts}
                onOpenThread={(message) => setThreadRootId(message.id)}
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
          {threadRoot && (
            <ThreadPanel
              root={threadRoot}
              buffer={messages}
              members={members}
              profiles={profiles}
              onClose={() => setThreadRootId(null)}
              send={send}
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
