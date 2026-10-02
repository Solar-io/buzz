import { Lock, Settings } from "lucide-react";
import type { ScratchActions } from "@/features/commands/lib/commands.ts";
import {
  scratchInfo,
  withoutScratchMarker,
} from "@/features/scratch/lib/scratchChannel.ts";
import { ScratchHeading } from "@/features/scratch/ui/ScratchHeading";
import { usePhoneLayout } from "@/shared/layout/AppShell";
import type { ChannelMember, Profile } from "../hooks.ts";
import type { ChannelSummary } from "../useChannels";
import { authorLabel } from "../lib/authorLabel.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { ChannelMembersButton } from "./ChannelMembersButton.tsx";

/**
 * The first non-empty of topic → purpose → about, or null. A scratch
 * channel's parent marker is machine text and never reads here.
 */
export function channelTopic(channel: {
  topic?: string | null;
  about?: string | null;
  purpose?: string | null;
}): string | null {
  for (const value of [
    channel.topic,
    channel.purpose,
    channel.about ? withoutScratchMarker(channel.about) : channel.about,
  ]) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

/**
 * The conversation's header, at md and up (Main and Message artboards).
 *
 * Sam removed the old header bar on 2026-09-22 because it was a second copy
 * of the sidebar row — a name and nothing else. This one earns its row: it is
 * where the conversation says what it is FOR (the topic, which the sidebar
 * has no room for) and who is in it (the facepile: faces, a count, how many
 * are agents — and the roster behind it). A channel with no topic shows none;
 * there is no placeholder sentence.
 *
 * A DM names its counterpart and what it is ("agent · DM"); it has no
 * facepile, because a DM's members are its title.
 *
 * Below md the phone top bar carries the title and the member line
 * (PhoneChannel artboard), so this renders nothing there — except in a
 * scratch channel, whose banner (pill, Keep, Exit) has nowhere else to go.
 */
export function ChannelHeader({
  channel,
  title,
  members,
  profiles,
  presence,
  selfPubkey,
  contacts,
  agentPubkeys,
  dmAgentPubkey,
  scratch,
  onOpenSettings,
}: {
  channel: ChannelSummary;
  /** The resolved conversation name (a DM's is its participants). */
  title: string;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  presence?: Map<string, PresenceEntry>;
  selfPubkey: string | null;
  contacts?: string[];
  agentPubkeys: ReadonlySet<string>;
  /** The DM's agent counterpart, when it is a 1:1 DM with a known agent. */
  dmAgentPubkey: string | null;
  onOpenSettings?: (tab: "about" | "members") => void;
  /** Scratch-channel wiring; the header draws it only for a scratch channel. */
  scratch?: {
    actions: ScratchActions;
    channels: readonly ChannelSummary[];
    /** Newest event seen here (unix s) — the idle clock restarts on it. */
    lastActivityAt: number | null;
    /** The viewer's role here — only the owner is offered Exit. */
    role: string | null;
  };
}) {
  const phone = usePhoneLayout();
  const dm = channel.type === "dm";
  const topic = dm ? null : channelTopic(channel);
  const others = channel.participantPubkeys.filter(
    (pubkey) => pubkey !== selfPubkey,
  );
  const dmFace = others.length === 1 ? others[0] : null;
  const roster = (variant: "facepile" | "count") => (
    <ChannelMembersButton
      variant={variant}
      channelId={channel.id}
      members={members}
      profiles={profiles}
      presence={presence}
      contacts={contacts}
      selfPubkey={selfPubkey}
      agentPubkeys={agentPubkeys}
      onOpenMembers={
        onOpenSettings ? () => onOpenSettings("members") : undefined
      }
    />
  );
  const info = scratch ? scratchInfo(channel, scratch.channels) : null;
  if (scratch && info) {
    // Keep and Exit claim the facepile's room; its line already says how
    // many agents came along, so the roster shrinks to its count.
    return (
      <ScratchHeading
        channel={channel}
        info={info}
        actions={scratch.actions}
        lastActivityAt={scratch.lastActivityAt}
        role={scratch.role}
        phone={phone}
        memberPubkeys={members.map((member) => member.pubkey)}
        agentPubkeys={agentPubkeys}
        roster={
          <div className="flex items-center gap-1">
            {roster("count")}
            {!phone && onOpenSettings && (
              <button
                type="button"
                aria-label="Channel settings"
                data-testid="channel-settings-trigger"
                className="flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-accent"
                onClick={() => onOpenSettings("about")}
              >
                <Settings aria-hidden className="size-4" />
              </button>
            )}
          </div>
        }
      />
    );
  }
  if (phone) {
    return null;
  }
  return (
    <header
      data-testid="channel-header"
      className="flex min-h-14.5 shrink-0 items-center gap-3 border-b border-border px-5 py-2.5"
    >
      {dm && dmFace && (
        <AuthorAvatar
          pubkey={dmFace}
          label={authorLabel(dmFace, profiles)}
          picture={profiles.get(dmFace)?.avatar}
          size="md-sm"
        />
      )}
      <h1 className="flex min-w-0 shrink-0 items-center gap-1.5 text-lg font-bold tracking-tight">
        {!dm &&
          (channel.isPrivate ? (
            <Lock aria-label="Private channel" className="size-4 text-faint" />
          ) : (
            <span aria-hidden className="font-medium text-faint">
              #
            </span>
          ))}
        <span className="max-w-[18rem] truncate">
          {dm ? title : channel.name}
        </span>
      </h1>
      {dm ? (
        <span className="truncate font-mono text-2xs text-muted-foreground">
          {dmAgentPubkey
            ? "agent · DM"
            : others.length > 1
              ? `${others.length + 1} people · DM`
              : "DM"}
        </span>
      ) : topic ? (
        <p
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={topic}
        >
          <span aria-hidden className="mr-2 text-line-2">
            |
          </span>
          {topic}
        </p>
      ) : null}
      {!dm && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {roster("facepile")}
          {onOpenSettings && (
            <button
              type="button"
              aria-label="Channel settings"
              title="Channel settings"
              data-testid="channel-settings-trigger"
              className="flex size-8 items-center justify-center rounded-lg border border-border bg-card text-ink-2 hover:bg-accent"
              onClick={() => onOpenSettings("about")}
            >
              <Settings aria-hidden className="size-4" />
            </button>
          )}
        </div>
      )}
    </header>
  );
}
