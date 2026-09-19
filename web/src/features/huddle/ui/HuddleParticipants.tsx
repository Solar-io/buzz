import { Bot } from "lucide-react";

import {
  AuthorAvatar,
  authorLabel,
} from "@/features/channels/ui/ChannelTimeline";
import type { Profile } from "@/features/channels/hooks";
import { cn } from "@/shared/lib/cn";

import { isSpeaking } from "../lib/micMeter.ts";
import type { HuddleCall } from "../useHuddleCall.ts";

/**
 * Who is in the room, and who is talking.
 *
 * THREE sources, not one, because "in the huddle" and "sending audio" are
 * different facts: the viewer, the audio peers from the room's roster, and
 * the ROSTER AGENTS — bots added to the huddle channel, which never appear
 * as audio peers in a browser (a browser cannot broadcast as an agent; see
 * `lib/huddleAgentSpeech.ts`). An avatar stack built from peers alone shows
 * an empty room to someone talking to an agent, which is precisely the
 * case this UI exists for.
 *
 * Speaking state comes from a different signal per kind: peer telemetry for
 * peers, the synthesizer for agents, the local meter for the viewer.
 */

export interface HuddleParticipant {
  pubkey: string;
  label: string;
  picture?: string;
  speaking: boolean;
  isSelf: boolean;
  isAgent: boolean;
}

export function huddleParticipants(
  call: HuddleCall,
  profiles: Map<string, Profile>,
): HuddleParticipant[] {
  const seen = new Set<string>();
  const list: HuddleParticipant[] = [];
  const push = (participant: HuddleParticipant) => {
    const key = participant.pubkey.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(participant);
  };

  if (call.selfPubkey) {
    push({
      pubkey: call.selfPubkey,
      label: authorLabel(call.selfPubkey, profiles),
      picture: profiles.get(call.selfPubkey)?.avatar,
      speaking: !call.huddle.muted && isSpeaking(call.huddle.micLevel),
      isSelf: true,
      isAgent: false,
    });
  }
  for (const peer of call.huddle.peers) {
    push({
      pubkey: peer.pubkey,
      label: authorLabel(peer.pubkey, profiles),
      picture: profiles.get(peer.pubkey)?.avatar,
      speaking: isSpeaking(call.huddle.speaking.get(peer.pubkey) ?? -127),
      isSelf: false,
      isAgent: call.agentPubkeys.includes(peer.pubkey.toLowerCase()),
    });
  }
  for (const agent of call.agentPubkeys) {
    push({
      pubkey: agent,
      label: authorLabel(agent, profiles),
      picture: profiles.get(agent)?.avatar,
      // One synthesizer, one flag: every roster agent shows as speaking
      // while a reply is being read. The hook does not attribute speech
      // per agent, and inventing an attribution would be a guess.
      speaking: call.speech.speaking,
      isSelf: false,
      isAgent: true,
    });
  }
  return list;
}

/** The dock's compact stack: avatars with a ring on whoever is talking. */
export function HuddleParticipantStack({
  participants,
}: {
  participants: readonly HuddleParticipant[];
}) {
  return (
    <div className="flex items-center -space-x-1.5">
      {participants.map((participant) => (
        <span
          className={cn(
            "relative inline-flex rounded-full ring-2",
            participant.speaking ? "ring-emerald-400" : "ring-transparent",
          )}
          data-speaking={participant.speaking ? "true" : "false"}
          data-testid="huddle-participant"
          key={participant.pubkey}
          title={`${participant.label}${participant.isSelf ? " (you)" : ""}`}
        >
          <AuthorAvatar
            label={participant.label}
            picture={participant.picture}
            pubkey={participant.pubkey}
            size="sm"
          />
          {participant.isAgent && (
            <Bot
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-background text-muted-foreground"
            />
          )}
        </span>
      ))}
    </div>
  );
}

/** The floating panel's grid: one card per participant, with a ⋮ slot. */
export function HuddleParticipantCards({
  participants,
  renderMenu,
}: {
  participants: readonly HuddleParticipant[];
  /** Per-agent overflow menu; omitted entirely when it returns null. */
  renderMenu?: (participant: HuddleParticipant) => React.ReactNode;
}) {
  return (
    <ul className="grid grid-cols-2 gap-2">
      {participants.map((participant) => {
        const menu = renderMenu?.(participant) ?? null;
        return (
          <li
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2 py-2",
              participant.speaking
                ? "border-emerald-500/60 bg-emerald-500/10"
                : "border-border bg-card/40",
            )}
            data-speaking={participant.speaking ? "true" : "false"}
            data-testid="huddle-participant"
            key={participant.pubkey}
          >
            <AuthorAvatar
              label={participant.label}
              picture={participant.picture}
              pubkey={participant.pubkey}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate text-xs">
              {participant.label}
              {participant.isSelf && (
                <span className="ml-1 text-2xs text-muted-foreground">you</span>
              )}
            </span>
            {menu}
          </li>
        );
      })}
    </ul>
  );
}
