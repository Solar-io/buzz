import { useEffect, useState } from "react";
import {
  Brain,
  CircleDot,
  Copy,
  FileText,
  Hash,
  Lock,
  LogIn,
} from "lucide-react";
import { toast } from "sonner";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { HuddleIndicator } from "@/features/huddle/ui/HuddleIndicator";
import { useHuddleRoster } from "@/features/huddle/useHuddleRoster";
import { startHuddle } from "@/features/huddle/lib/huddleLifecycle";
import { formatHuddleActionError } from "@/features/huddle/lib/huddleNaming";
import { cn } from "@/shared/lib/cn";
import type { RelaySession } from "@/shared/api/relay-session";
import type { ChannelMember, Profile } from "../hooks.ts";
import { channelDescription } from "../lib/channelDescription.ts";
import { ephemeralDisplay } from "../lib/ephemeralChannel.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { ChannelMembersButton } from "./ChannelMembersButton.tsx";

/** Props for {@link ChannelHeader}. */
export interface ChannelHeaderProps {
  /** The channel currently open in the main pane. */
  channel: ChannelSummary;
  /** Resolved title — DMs use participant names, channels use "# name". */
  title: string;
  /** Live relay session, used to publish the huddle-start event. */
  session: RelaySession;
  /** A huddle room landed: open it and re-REQ the channel list. */
  onHuddleStarted: (channelId: string) => void;
  /** Set when this DM has an agent counterpart — shows the 🧠 toggle. */
  agentPubkey: string | null;
  /** Reveal the thinking panel in the right pane. */
  onOpenThinking: () => void;
  /** Channel roster (kind 39002) — drives the member count and join state. */
  members?: ChannelMember[];
  /** Profiles for the roster and huddle faces. */
  profiles?: Map<string, Profile>;
  /** Presence for the roster's status dots. */
  presence?: Map<string, PresenceEntry>;
  /** The viewer — decides whether the Join affordance applies. */
  selfPubkey?: string | null;
  /** Publish a NIP-29 kind-9021 join for this channel. */
  onJoinChannel?: () => Promise<void> | void;
}

const NO_MEMBERS: ChannelMember[] = [];
const NO_PROFILES: Map<string, Profile> = new Map();

/** The glyph that says what KIND of place this is, before you read its name. */
function ChannelIcon({ channel }: { channel: ChannelSummary }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (channel.type === "dm") {
    return <CircleDot aria-hidden className={className} />;
  }
  if (channel.isPrivate) {
    return <Lock aria-hidden className={className} />;
  }
  if (channel.type === "forum") {
    return <FileText aria-hidden className={className} />;
  }
  return <Hash aria-hidden className={className} />;
}

/**
 * The channel body's top bar.
 *
 * Ported up to the desktop's `ChatHeader` + `ChannelScreenHeader` +
 * `ChannelMembersBar` trio: the type glyph, the name with a copy action, the
 * one-line description (topic → about → purpose, with archived / read-only
 * prefixes), an expiry badge for ephemeral channels, the member count with
 * its roster, a huddle control that shows who is already in the call, a Join
 * button for open channels the viewer is not in, and the DM thinking toggle.
 *
 * Everything past `channel`/`title`/`session` is optional so the header
 * degrades to its previous behaviour rather than failing when the shell has
 * not been wired for a given signal yet.
 */
export function ChannelHeader({
  channel,
  title,
  session,
  onHuddleStarted,
  agentPubkey,
  onOpenThinking,
  members = NO_MEMBERS,
  profiles = NO_PROFILES,
  presence,
  selfPubkey,
  onJoinChannel,
}: ChannelHeaderProps) {
  const [startingHuddle, setStartingHuddle] = useState(false);
  const [joining, setJoining] = useState(false);
  const { live } = useHuddleRoster(channel.id);

  // The expiry badge counts DOWN, so it needs a tick of its own — nothing
  // else in this header changes when a minute passes.
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  const isEphemeral = channel.ttlSeconds !== null;
  useEffect(() => {
    if (!isEphemeral) {
      return;
    }
    const timer = setInterval(() => setNowSeconds(Date.now() / 1000), 15_000);
    return () => clearInterval(timer);
  }, [isEphemeral]);
  const expiry = ephemeralDisplay(channel, nowSeconds);

  const isMember =
    selfPubkey && members.length > 0
      ? members.some((member) => member.pubkey === selfPubkey)
      : undefined;
  const description = channelDescription({
    topic: channel.topic,
    about: channel.about,
    purpose: channel.purpose,
    archived: channel.archived,
    isMember,
    isOpen: !channel.isPrivate,
  });
  const showJoin =
    onJoinChannel !== undefined &&
    isMember === false &&
    !channel.isPrivate &&
    !channel.archived;

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-4">
      <div className="group/title flex min-w-0 items-center gap-1.5">
        <ChannelIcon channel={channel} />
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <button
          type="button"
          data-testid="copy-channel-name"
          aria-label={`Copy channel name: ${title}`}
          title="Copy channel name"
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/title:opacity-100"
          onClick={() => {
            void navigator.clipboard
              .writeText(title.replace(/^#\s*/, ""))
              .then(() => toast.success("Channel name copied"))
              .catch(() => toast.error("Could not copy the channel name."));
          }}
        >
          <Copy aria-hidden className="h-3.5 w-3.5" />
        </button>
        {expiry && (
          <span
            data-testid="channel-expiry-badge"
            title={expiry.title}
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide",
              expiry.urgency === "expired"
                ? "border-red-500/40 text-red-400"
                : expiry.urgency === "soon"
                  ? "border-amber-500/40 text-amber-400"
                  : "border-border text-muted-foreground",
            )}
          >
            {expiry.label}
          </span>
        )}
      </div>
      {channel.type !== "dm" && (
        <p
          data-testid="channel-description"
          title={description}
          className="hidden min-w-0 truncate text-sm text-muted-foreground sm:block"
        >
          {description}
        </p>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {showJoin && (
          <button
            type="button"
            data-testid="join-channel"
            disabled={joining}
            className="flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            onClick={() => {
              setJoining(true);
              void Promise.resolve(onJoinChannel?.()).finally(() =>
                setJoining(false),
              );
            }}
          >
            <LogIn aria-hidden className="h-3.5 w-3.5" />
            {joining ? "Joining…" : "Join"}
          </button>
        )}
        {channel.type !== "dm" && (
          <ChannelMembersButton
            members={members}
            profiles={profiles}
            presence={presence}
          />
        )}
        {/*
          A huddle hangs off a permanent channel; the backing channel is
          itself ephemeral, so offering "start a huddle" inside one would
          nest a huddle in a huddle.
        */}
        {!isEphemeral && (
          <HuddleIndicator
            live={live}
            starting={startingHuddle}
            disabled={channel.archived}
            onJoin={onHuddleStarted}
            onStart={() => {
              setStartingHuddle(true);
              void startHuddle(session, { parentChannelId: channel.id })
                .then((result) => {
                  if (result.ok && result.channelId) {
                    toast.success(result.message);
                    onHuddleStarted(result.channelId);
                  } else {
                    toast.error(result.message);
                  }
                })
                .catch((error) =>
                  toast.error(formatHuddleActionError(error, "start")),
                )
                .finally(() => setStartingHuddle(false));
            }}
          />
        )}
        {agentPubkey && (
          <button
            type="button"
            aria-label="Toggle thinking panel"
            title="Thinking"
            className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onOpenThinking}
          >
            <Brain aria-hidden className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
