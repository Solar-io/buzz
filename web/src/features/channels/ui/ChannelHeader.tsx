import { useEffect, useState, type ReactNode } from "react";
import {
  Brain,
  CircleDot,
  Copy,
  FileText,
  Hash,
  Lock,
  LogIn,
  PhoneCall,
} from "lucide-react";
import { toast } from "sonner";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useHuddleRoster } from "@/features/huddle/useHuddleRoster";
import type { AgentCallPhase } from "@/features/huddle/lib/agentCallFlow.ts";
import { cn } from "@/shared/lib/cn";
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
  /** Start the one-click DM voice call using a private TTL transport room. */
  onStartAgentCall?: (
    existingHuddleChannelId?: string | null,
  ) => Promise<{ ok: boolean; message: string }>;
  /** Current one-click call phase, for the button's pending label. */
  agentCallPhase?: AgentCallPhase;
  /** Current one-click call failure, shown in the DM header. */
  agentCallError?: string | null;
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
  /** DM counterparty pubkeys, for the roster's add-member suggestions. */
  contacts?: string[];
  /**
   * Feature-owned controls pinned ahead of Join/Members/Call (the
   * shortcut bar). The header does not import the feature — it renders
   * whatever the shell passes.
   */
  actions?: ReactNode;
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
 * its roster, a Join button for open channels the viewer is not in, a direct
 * DM voice-call button for an eligible agent, and the DM thinking toggle.
 *
 * Everything past `channel`/`title` is optional so the header
 * degrades to its previous behaviour rather than failing when the shell has
 * not been wired for a given signal yet.
 */
export function ChannelHeader({
  channel,
  title,
  onStartAgentCall,
  agentCallPhase = "idle",
  agentCallError = null,
  agentPubkey,
  onOpenThinking,
  members = NO_MEMBERS,
  profiles = NO_PROFILES,
  presence,
  selfPubkey,
  onJoinChannel,
  contacts,
  actions,
}: ChannelHeaderProps) {
  const [startingAgentCall, setStartingAgentCall] = useState(false);
  const [joining, setJoining] = useState(false);
  const { live } = useHuddleRoster(
    channel.type === "dm" && onStartAgentCall ? channel.id : null,
  );

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
  const canStartAgentCall =
    channel.type === "dm" &&
    agentPubkey !== null &&
    onStartAgentCall !== undefined;
  const existingAgentHuddleId = canStartAgentCall
    ? (live.find((room) =>
        room.participants.some(
          (participant) =>
            participant.toLowerCase() === agentPubkey.toLowerCase(),
        ),
      )?.ephemeralId ?? null)
    : null;
  const callInProgress =
    startingAgentCall ||
    (agentCallPhase !== "idle" && agentCallPhase !== "active");

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-secondary px-2 py-1 sm:h-14 sm:flex-nowrap sm:gap-2 sm:px-4 sm:py-0">
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
      <div className="ml-auto flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto">
        {actions}
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
            channelId={channel.id}
            members={members}
            profiles={profiles}
            presence={presence}
            contacts={contacts}
            selfPubkey={selfPubkey}
          />
        )}
        {canStartAgentCall && (
          <button
            type="button"
            data-testid="dm-start-call"
            aria-label={`Call ${title}`}
            title={
              agentCallPhase === "active"
                ? "Open the active call"
                : "Start a voice call"
            }
            disabled={callInProgress}
            className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={() => {
              if (!onStartAgentCall || callInProgress) {
                return;
              }
              setStartingAgentCall(true);
              void onStartAgentCall(existingAgentHuddleId)
                .catch((error: unknown) => {
                  const message =
                    error instanceof Error
                      ? error.message
                      : "The voice call could not be started.";
                  toast.error("Could not start the voice call", {
                    description: message,
                  });
                  return { ok: false, message };
                })
                .finally(() => setStartingAgentCall(false));
            }}
          >
            <PhoneCall aria-hidden className="h-4 w-4" />
            <span className="hidden sm:inline">
              {callInProgress ? "Calling…" : "Call"}
            </span>
          </button>
        )}
        {agentCallError && canStartAgentCall && (
          <span
            className="max-w-56 truncate text-2xs text-red-400"
            role="alert"
          >
            {agentCallError}
          </span>
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
