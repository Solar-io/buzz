import { useEffect, useState } from "react";
import { Brain, Copy, LogIn, PhoneCall } from "lucide-react";
import { toast } from "sonner";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useHuddleRoster } from "@/features/huddle/useHuddleRoster";
import type { AgentCallPhase } from "@/features/huddle/lib/agentCallFlow.ts";
import { cn } from "@/shared/lib/cn";
import type { ChannelMember, Profile } from "../hooks.ts";
import { ephemeralDisplay } from "../lib/ephemeralChannel.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { ChannelMembersButton } from "./ChannelMembersButton.tsx";

/** Props for {@link ChannelActionsBar}. */
export interface ChannelActionsBarProps {
  /** The channel currently open in the main pane. */
  channel: ChannelSummary;
  /**
   * Resolved channel name, used by the copy action and the call button's
   * label. The visible TITLE is gone with the header bar (Sam, 2026-09-22);
   * this is now only read aloud and copied.
   */
  title: string;
  /** Start the one-click DM voice call using a private TTL transport room. */
  onStartAgentCall?: (
    existingHuddleChannelId?: string | null,
  ) => Promise<{ ok: boolean; message: string }>;
  /** Current one-click call phase, for the button's pending label. */
  agentCallPhase?: AgentCallPhase;
  /** Current one-click call failure, shown beside the call button. */
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
}

const NO_MEMBERS: ChannelMember[] = [];
const NO_PROFILES: Map<string, Profile> = new Map();

/**
 * The channel's control strip, on the composer's bottom bar.
 *
 * This replaces the old `ChannelHeader` top bar, which Sam removed on
 * 2026-09-22. Everything the header carried that is still a live affordance
 * moved here rather than being deleted with it: the roster, the Join button
 * for open channels the viewer has not joined, the one-click DM voice call,
 * and the DM thinking toggle. The two things the header uniquely showed and
 * this does not are the channel NAME (already in the sidebar row and the
 * window title) and the one-line description/topic.
 *
 * Call and Thinking sit at the RIGHT end, per the annotation — they are
 * occasional actions, while the formatting icons immediately to their left
 * are the row the eye already visits every time it types.
 */
export function ChannelActionsBar({
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
}: ChannelActionsBarProps) {
  const [startingAgentCall, setStartingAgentCall] = useState(false);
  const [joining, setJoining] = useState(false);
  const { live } = useHuddleRoster(
    channel.type === "dm" && onStartAgentCall ? channel.id : null,
  );

  // The expiry badge counts DOWN, so it needs a tick of its own — nothing
  // else in this strip changes when a minute passes.
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
    <div
      className="ml-auto flex shrink-0 items-center gap-1.5"
      data-testid="channel-actions-bar"
    >
      {/* Ephemeral channels expire under the reader — the countdown has to be
          legible wherever the other channel controls are. */}
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
      <button
        type="button"
        data-testid="copy-channel-name"
        aria-label={`Copy channel name: ${title}`}
        title="Copy channel name"
        className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => {
          void navigator.clipboard
            .writeText(title.replace(/^#\s*/, ""))
            .then(() => toast.success("Channel name copied"))
            .catch(() => toast.error("Could not copy the channel name."));
        }}
      >
        <Copy aria-hidden className="h-4 w-4" />
      </button>
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
        <span className="max-w-56 truncate text-2xs text-red-400" role="alert">
          {agentCallError}
        </span>
      )}
      {agentPubkey && (
        <button
          type="button"
          data-testid="toggle-thinking-panel"
          aria-label="Toggle thinking panel"
          title="Thinking"
          className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenThinking}
        >
          <Brain aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
