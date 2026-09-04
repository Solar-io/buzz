import { Headphones } from "lucide-react";
import { useProfiles } from "@/features/channels/hooks";
import {
  AuthorAvatar,
  authorLabel,
} from "@/features/channels/ui/ChannelTimeline";
import { cn } from "@/shared/lib/cn";
import type { HuddleRoom } from "../lib/huddleParticipants.ts";

/**
 * The channel header's huddle control — the desktop's `HuddleIndicator`.
 *
 * Two states, and the difference is the whole point. With nobody in a
 * huddle it is a plain "start" button. With a live room it shows WHO is in
 * it, drawn from the relay's persisted 48101/48102 roster, so you can see a
 * call is happening and who to expect before committing a microphone to it.
 */
export function HuddleIndicator({
  live,
  onStart,
  onJoin,
  starting,
  disabled,
}: {
  /** Live rooms for this channel, from `useHuddleRoster`. */
  live: HuddleRoom[];
  onStart: () => void;
  /** Open a live huddle's backing channel. */
  onJoin: (ephemeralChannelId: string) => void;
  starting?: boolean;
  /** No permission to start one here (archived, or not a member). */
  disabled?: boolean;
}) {
  const room = live[0] ?? null;
  const participants = room?.participants ?? [];
  const profiles = useProfiles(participants);

  if (!room) {
    return (
      <button
        type="button"
        data-testid="huddle-start"
        aria-label="Start a huddle in this channel"
        title="Start huddle"
        disabled={disabled || starting}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        onClick={onStart}
      >
        <Headphones aria-hidden className="h-4 w-4" />
        <span className="hidden sm:inline">
          {starting ? "Starting…" : "Huddle"}
        </span>
      </button>
    );
  }

  const label =
    participants.length === 1
      ? `${authorLabel(participants[0], profiles)} is in a huddle`
      : `${participants.length} people are in a huddle`;

  return (
    <button
      type="button"
      data-testid="huddle-join"
      data-participants={participants.length}
      aria-label={`Join the huddle — ${label}`}
      title={participants
        .map((pubkey) => authorLabel(pubkey, profiles))
        .join(", ")}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-2xs font-medium",
        "border-emerald-600/50 bg-emerald-600/15 text-emerald-500 hover:bg-emerald-600/25",
      )}
      onClick={() => onJoin(room.ephemeralId)}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <span className="flex items-center">
        {participants.slice(0, 3).map((pubkey, index) => (
          <span key={pubkey} className={index > 0 ? "-ml-1.5" : undefined}>
            <AuthorAvatar
              pubkey={pubkey}
              label={authorLabel(pubkey, profiles)}
              picture={profiles.get(pubkey)?.avatar}
              size="sm"
            />
          </span>
        ))}
      </span>
      <span className="tabular-nums">{participants.length}</span>
      <span className="hidden sm:inline">Join</span>
    </button>
  );
}
